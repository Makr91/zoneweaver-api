import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';
import { checkZvolInUse } from './ZoneCreationManager.js';

/**
 * Zone Modification Manager for Zone Configuration Changes
 * Handles modifying existing zone configurations via zonecfg
 * Changes are queued and take effect on next zone boot
 */

/**
 * Update task progress
 * @param {Object} task - Task record
 * @param {number} percent - Progress percentage
 * @param {Object} info - Progress info object
 */
const updateTaskProgress = async (task, percent, info) => {
  if (!task) {
    return;
  }
  try {
    await task.update({
      progress_percent: percent,
      progress_info: info,
    });
  } catch (error) {
    log.task.debug('Progress update failed', { error: error.message });
  }
};

/**
 * Get current zone configuration via zadm show
 * @param {string} zoneName - Zone name
 * @returns {Promise<Object>} Zone configuration
 */
const getZoneConfig = async zoneName => {
  const result = await executeCommand(`pfexec zadm show ${zoneName}`);
  if (!result.success) {
    throw new Error(`Failed to get zone configuration: ${result.error}`);
  }

  return new Promise((resolve, reject) => {
    yj.parseAsync(result.output, (err, parsed) => {
      if (err) {
        reject(new Error(`Failed to parse zone configuration: ${err.message}`));
      } else {
        resolve(parsed);
      }
    });
  });
};

/**
 * Check if a named attribute exists in zone configuration
 * @param {Object} zoneConfig - Zone configuration from zadm show
 * @param {string} attrName - Attribute name to check
 * @returns {boolean} True if attribute exists
 */
const hasAttribute = (zoneConfig, attrName) => {
  // Check top-level properties (zadm normalizes some attrs)
  if (zoneConfig[attrName] !== undefined) {
    return true;
  }

  // Check attr array
  if (Array.isArray(zoneConfig.attr)) {
    return zoneConfig.attr.some(a => a.name === attrName);
  }

  return false;
};

/**
 * Build zonecfg command to add or update an attribute
 * @param {Object} zoneConfig - Current zone configuration
 * @param {string} attrName - Attribute name
 * @param {string} value - Attribute value
 * @returns {string} zonecfg command string
 */
const buildSetAttrCommand = (zoneConfig, attrName, value) => {
  if (hasAttribute(zoneConfig, attrName)) {
    return `select attr name=${attrName}; set value=\\"${value}\\"; end;`;
  }
  return `add attr; set name=${attrName}; set value=\\"${value}\\"; set type=string; end;`;
};

/**
 * Find the next available disk number in zone config
 * @param {Object} zoneConfig - Zone configuration
 * @returns {number} Next available disk number
 */
const getNextDiskNumber = zoneConfig => {
  let maxNum = -1;

  if (Array.isArray(zoneConfig.attr)) {
    for (const attr of zoneConfig.attr) {
      const match = /^disk(?<num>\d+)$/u.exec(attr.name);
      if (match) {
        const num = parseInt(match.groups.num, 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  return maxNum + 1;
};

/**
 * Find the next available cdrom number in zone config
 * @param {Object} zoneConfig - Zone configuration
 * @returns {number} Next available cdrom number
 */
const getNextCdromNumber = zoneConfig => {
  let maxNum = -1;
  let hasBareAttr = false;

  if (Array.isArray(zoneConfig.attr)) {
    for (const attr of zoneConfig.attr) {
      if (attr.name === 'cdrom') {
        hasBareAttr = true;
      }
      const match = /^cdrom(?<num>\d+)$/u.exec(attr.name);
      if (match) {
        const num = parseInt(match.groups.num, 10);
        if (num > maxNum) {
          maxNum = num;
        }
      }
    }
  }

  // If bare 'cdrom' exists, start numbering from 0
  if (hasBareAttr && maxNum === -1) {
    return 0;
  }

  return maxNum + 1;
};

/**
 * Apply simple attribute modifications (ram, vcpus, etc.)
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} metadata - Modification metadata
 */
const applyAttributeChanges = async (zoneName, zoneConfig, metadata) => {
  const attrMap = {
    ram: metadata.ram,
    vcpus: metadata.vcpus,
    bootrom: metadata.bootrom,
    hostbridge: metadata.hostbridge,
    diskif: metadata.diskif,
    netif: metadata.netif,
    type: metadata.os_type,
    vnc: metadata.vnc,
    acpi: metadata.acpi,
    xhci: metadata.xhci,
  };

  const commands = Object.entries(attrMap)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => buildSetAttrCommand(zoneConfig, name, value));

  if (commands.length === 0) {
    return;
  }

  const attrCmd = `pfexec zonecfg -z ${zoneName} "${commands.join(' ')}"`;
  const attrResult = await executeCommand(attrCmd);
  if (!attrResult.success) {
    throw new Error(`Attribute modification failed: ${attrResult.error}`);
  }

  log.task.info('Applied attribute changes', {
    zone_name: zoneName,
    attributes: Object.keys(attrMap).filter(k => attrMap[k] !== undefined && attrMap[k] !== null),
  });
};

/**
 * Apply autoboot change
 * @param {string} zoneName - Zone name
 * @param {boolean} autoboot - Autoboot setting
 */
const applyAutobootChange = async (zoneName, autoboot) => {
  const value = autoboot ? 'true' : 'false';
  const autobootResult = await executeCommand(
    `pfexec zonecfg -z ${zoneName} "set autoboot=${value}"`
  );
  if (!autobootResult.success) {
    throw new Error(`Autoboot modification failed: ${autobootResult.error}`);
  }

  log.task.info('Applied autoboot change', { zone_name: zoneName, autoboot: value });
};

/**
 * Add NICs to zone configuration
 * @param {string} zoneName - Zone name
 * @param {Array} nics - Array of NIC configurations
 */
const addNics = async (zoneName, nics) => {
  for (const nic of nics) {
    let nicCmd;
    if (nic.global_nic) {
      nicCmd = `pfexec zonecfg -z ${zoneName} "add net; set physical=${nic.physical}; set global-nic=${nic.global_nic}; end;"`;
    } else {
      nicCmd = `pfexec zonecfg -z ${zoneName} "add net; set physical=${nic.physical}; end;"`;
    }

    // eslint-disable-next-line no-await-in-loop
    const nicResult = await executeCommand(nicCmd);
    if (!nicResult.success) {
      throw new Error(`Failed to add NIC ${nic.physical}: ${nicResult.error}`);
    }

    log.task.info('Added NIC to zone', { zone_name: zoneName, physical: nic.physical });
  }
};

/**
 * Remove NICs from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Array} nicNames - Array of NIC physical names to remove
 */
const removeNics = async (zoneName, nicNames) => {
  for (const nicName of nicNames) {
    // eslint-disable-next-line no-await-in-loop
    const removeResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "remove net physical=${nicName}"`
    );
    if (!removeResult.success) {
      throw new Error(`Failed to remove NIC ${nicName}: ${removeResult.error}`);
    }

    log.task.info('Removed NIC from zone', { zone_name: zoneName, physical: nicName });
  }
};

/**
 * Add disks to zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} disks - Array of disk configurations
 * @param {boolean} force - Whether to force attach in-use datasets
 */
const addDisks = async (zoneName, zoneConfig, disks, force) => {
  let nextNum = getNextDiskNumber(zoneConfig);

  for (const disk of disks) {
    let diskPath = null;

    if (disk.create_new) {
      const pool = disk.pool || 'rpool';
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${nextNum}`;
      const size = disk.size || '50G';
      diskPath = `${pool}/${dset}/${zoneName}/${volName}`;

      const sparseFlag = disk.sparse !== false ? '-s' : '';
      // eslint-disable-next-line no-await-in-loop
      const createResult = await executeCommand(
        `pfexec zfs create ${sparseFlag} -V ${size} ${diskPath}`
      );
      if (!createResult.success) {
        throw new Error(`Failed to create disk volume: ${createResult.error}`);
      }
    } else if (disk.existing_dataset) {
      diskPath = disk.existing_dataset;

      // eslint-disable-next-line no-await-in-loop
      const usageCheck = await checkZvolInUse(diskPath, zoneName);
      if (usageCheck.inUse && !force) {
        throw new Error(`Disk ${diskPath} is already in use by zone ${usageCheck.usedBy}`);
      }
    }

    if (diskPath) {
      const attrCmd = `add attr; set name=disk${nextNum}; set value=\\"${diskPath}\\"; set type=string; end; add device; set match=/dev/zvol/rdsk/${diskPath}; end;`;
      // eslint-disable-next-line no-await-in-loop
      const diskResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${attrCmd}"`);
      if (!diskResult.success) {
        throw new Error(`Failed to add disk${nextNum} to zone: ${diskResult.error}`);
      }

      log.task.info('Added disk to zone', {
        zone_name: zoneName,
        disk_name: `disk${nextNum}`,
        path: diskPath,
      });
      nextNum++;
    }
  }
};

/**
 * Remove disks from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} diskNames - Array of disk attribute names to remove (e.g., 'disk0')
 */
const removeDisks = async (zoneName, zoneConfig, diskNames) => {
  for (const diskName of diskNames) {
    // Find the disk path from current config to remove the device block
    let diskPath = null;
    if (Array.isArray(zoneConfig.attr)) {
      const attr = zoneConfig.attr.find(a => a.name === diskName);
      if (attr) {
        diskPath = attr.value;
      }
    }

    // Remove the attribute
    // eslint-disable-next-line no-await-in-loop
    const removeAttrResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "remove attr name=${diskName}"`
    );
    if (!removeAttrResult.success) {
      throw new Error(`Failed to remove disk attribute ${diskName}: ${removeAttrResult.error}`);
    }

    // Remove the device block if we found the path
    if (diskPath) {
      // eslint-disable-next-line no-await-in-loop
      const removeDevResult = await executeCommand(
        `pfexec zonecfg -z ${zoneName} "remove device match=/dev/zvol/rdsk/${diskPath}"`
      );
      if (!removeDevResult.success) {
        log.task.warn('Failed to remove device block for disk', {
          zone_name: zoneName,
          disk_name: diskName,
          error: removeDevResult.error,
        });
      }
    }

    log.task.info('Removed disk from zone', { zone_name: zoneName, disk_name: diskName });
  }
};

/**
 * Add CD-ROMs to zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} cdroms - Array of CDROM configurations
 */
const addCdroms = async (zoneName, zoneConfig, cdroms) => {
  let nextNum = getNextCdromNumber(zoneConfig);

  for (const cdrom of cdroms) {
    const attrName = `cdrom${nextNum}`;
    const cdromCmd = `add attr; set name=${attrName}; set value=\\"${cdrom.path}\\"; set type=string; end; add fs; set dir=${cdrom.path}; set special=${cdrom.path}; set type=lofs; add options ro; add options nodevices; end;`;

    // eslint-disable-next-line no-await-in-loop
    const cdromResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cdromCmd}"`);
    if (!cdromResult.success) {
      throw new Error(`Failed to add ${attrName} to zone: ${cdromResult.error}`);
    }

    log.task.info('Added CDROM to zone', {
      zone_name: zoneName,
      cdrom_name: attrName,
      path: cdrom.path,
    });
    nextNum++;
  }
};

/**
 * Remove CD-ROMs from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} cdromNames - Array of cdrom attribute names to remove (e.g., 'cdrom0')
 */
const removeCdroms = async (zoneName, zoneConfig, cdromNames) => {
  for (const cdromName of cdromNames) {
    // Find the cdrom path from current config to remove the fs block
    let cdromPath = null;
    if (Array.isArray(zoneConfig.attr)) {
      const attr = zoneConfig.attr.find(a => a.name === cdromName);
      if (attr) {
        cdromPath = attr.value;
      }
    }

    // Remove the attribute
    // eslint-disable-next-line no-await-in-loop
    const removeAttrResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "remove attr name=${cdromName}"`
    );
    if (!removeAttrResult.success) {
      throw new Error(`Failed to remove cdrom attribute ${cdromName}: ${removeAttrResult.error}`);
    }

    // Remove the fs block if we found the path
    if (cdromPath) {
      // eslint-disable-next-line no-await-in-loop
      const removeFsResult = await executeCommand(
        `pfexec zonecfg -z ${zoneName} "remove fs dir=${cdromPath}"`
      );
      if (!removeFsResult.success) {
        log.task.warn('Failed to remove fs block for cdrom', {
          zone_name: zoneName,
          cdrom_name: cdromName,
          error: removeFsResult.error,
        });
      }
    }

    log.task.info('Removed CDROM from zone', { zone_name: zoneName, cdrom_name: cdromName });
  }
};

/**
 * Apply cloud-init attribute changes
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} cloudInit - Cloud-init configuration
 */
const applyCloudInitChanges = async (zoneName, zoneConfig, cloudInit) => {
  const commands = [];

  if (cloudInit.enabled !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'cloud-init', cloudInit.enabled));
  }
  if (cloudInit.dns_domain !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'dns-domain', cloudInit.dns_domain));
  }
  if (cloudInit.password !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'password', cloudInit.password));
  }
  if (cloudInit.resolvers !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'resolvers', cloudInit.resolvers));
  }
  if (cloudInit.sshkey !== undefined) {
    commands.push(buildSetAttrCommand(zoneConfig, 'sshkey', cloudInit.sshkey));
  }

  if (commands.length > 0) {
    const cloudCmd = `pfexec zonecfg -z ${zoneName} "${commands.join(' ')}"`;
    const cloudResult = await executeCommand(cloudCmd);
    if (!cloudResult.success) {
      throw new Error(`Cloud-init modification failed: ${cloudResult.error}`);
    }

    log.task.info('Applied cloud-init changes', { zone_name: zoneName });
  }
};

/**
 * Execute zone modification task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneModifyTask = async task => {
  log.task.debug('Zone modification task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  try {
    // === Parse metadata (5%) ===
    await updateTaskProgress(task, 5, { status: 'parsing_metadata' });

    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, parsed) => (err ? reject(err) : resolve(parsed)));
    });

    const { zone_name } = task;

    // === Get current config (10%) ===
    await updateTaskProgress(task, 10, { status: 'reading_configuration' });
    const zoneConfig = await getZoneConfig(zone_name);

    const changes = [];

    // === Attribute changes (20-40%) ===
    const hasAttrChanges = [
      'ram',
      'vcpus',
      'bootrom',
      'hostbridge',
      'diskif',
      'netif',
      'os_type',
      'vnc',
      'acpi',
      'xhci',
    ].some(key => metadata[key] !== undefined);

    if (hasAttrChanges) {
      await updateTaskProgress(task, 20, { status: 'modifying_attributes' });
      await applyAttributeChanges(zone_name, zoneConfig, metadata);
      changes.push('attributes');
    }

    // === Autoboot (40%) ===
    if (metadata.autoboot !== undefined) {
      await updateTaskProgress(task, 40, { status: 'modifying_autoboot' });
      await applyAutobootChange(zone_name, metadata.autoboot);
      changes.push('autoboot');
    }

    // === NICs (50%) ===
    if (metadata.add_nics?.length > 0) {
      await updateTaskProgress(task, 50, { status: 'adding_nics' });
      await addNics(zone_name, metadata.add_nics);
      changes.push('add_nics');
    }

    if (metadata.remove_nics?.length > 0) {
      await updateTaskProgress(task, 55, { status: 'removing_nics' });
      await removeNics(zone_name, metadata.remove_nics);
      changes.push('remove_nics');
    }

    // === Disks (60%) ===
    if (metadata.add_disks?.length > 0) {
      await updateTaskProgress(task, 60, { status: 'adding_disks' });
      await addDisks(zone_name, zoneConfig, metadata.add_disks, metadata.force);
      changes.push('add_disks');
    }

    if (metadata.remove_disks?.length > 0) {
      await updateTaskProgress(task, 70, { status: 'removing_disks' });
      await removeDisks(zone_name, zoneConfig, metadata.remove_disks);
      changes.push('remove_disks');
    }

    // === CDROMs (75%) ===
    if (metadata.add_cdroms?.length > 0) {
      await updateTaskProgress(task, 75, { status: 'adding_cdroms' });
      await addCdroms(zone_name, zoneConfig, metadata.add_cdroms);
      changes.push('add_cdroms');
    }

    if (metadata.remove_cdroms?.length > 0) {
      await updateTaskProgress(task, 80, { status: 'removing_cdroms' });
      await removeCdroms(zone_name, zoneConfig, metadata.remove_cdroms);
      changes.push('remove_cdroms');
    }

    // === Cloud-init (85%) ===
    if (metadata.cloud_init) {
      await updateTaskProgress(task, 85, { status: 'modifying_cloud_init' });
      await applyCloudInitChanges(zone_name, zoneConfig, metadata.cloud_init);
      changes.push('cloud_init');
    }

    // === Complete (100%) ===
    await updateTaskProgress(task, 100, { status: 'completed', changes });

    log.task.info('Zone modification completed', {
      zone_name,
      changes,
    });

    return {
      success: true,
      message: `Zone ${zone_name} modified successfully (${changes.join(', ')}). Changes will take effect on next zone boot.`,
    };
  } catch (error) {
    log.task.error('Zone modification task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: task.zone_name,
    });

    return {
      success: false,
      error: `Zone modification failed: ${error.message}`,
    };
  }
};
