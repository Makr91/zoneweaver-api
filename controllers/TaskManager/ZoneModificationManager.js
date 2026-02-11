import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { checkZvolInUse } from './ZoneCreationManager.js';
import { getZoneConfig, syncZoneToDatabase } from '../../lib/ZoneConfigUtils.js';

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
  const cmds = nics.map(nic => {
    if (nic.global_nic) {
      return `add net; set physical=${nic.physical}; set global-nic=${nic.global_nic}; end;`;
    }
    return `add net; set physical=${nic.physical}; end;`;
  });

  if (cmds.length > 0) {
    const nicResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`);
    if (!nicResult.success) {
      throw new Error(`Failed to add NICs: ${nicResult.error}`);
    }
    log.task.info('Added NICs to zone', { zone_name: zoneName, count: nics.length });
  }
};

/**
 * Remove NICs from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Array} nicNames - Array of NIC physical names to remove
 */
const removeNics = async (zoneName, nicNames) => {
  const cmds = nicNames.map(nicName => `remove net physical=${nicName}`);

  if (cmds.length > 0) {
    const removeResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`);
    if (!removeResult.success) {
      throw new Error(`Failed to remove NICs: ${removeResult.error}`);
    }
    log.task.info('Removed NICs from zone', { zone_name: zoneName, count: nicNames.length });
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
  const zfsPromises = [];
  const zonecfgCmds = [];

  for (const disk of disks) {
    let diskPath = null;

    if (disk.create_new) {
      const pool = disk.pool || 'rpool';
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${nextNum}`;
      const size = disk.size || '50G';
      diskPath = `${pool}/${dset}/${zoneName}/${volName}`;

      const sparseFlag = disk.sparse !== false ? '-s' : '';
      zfsPromises.push(
        executeCommand(`pfexec zfs create ${sparseFlag} -V ${size} ${diskPath}`).then(res => {
          if (!res.success) {
            throw new Error(`Failed to create disk volume: ${res.error}`);
          }
          return diskPath;
        })
      );
    } else if (disk.existing_dataset) {
      diskPath = disk.existing_dataset;

      zfsPromises.push(
        checkZvolInUse(diskPath, zoneName).then(usageCheck => {
          if (usageCheck.inUse && !force) {
            throw new Error(`Disk ${diskPath} is already in use by zone ${usageCheck.usedBy}`);
          }
          return diskPath;
        })
      );
    }

    if (diskPath) {
      zonecfgCmds.push(
        `add attr; set name=disk${nextNum}; set value=\\"${diskPath}\\"; set type=string; end; add device; set match=/dev/zvol/rdsk/${diskPath}; end;`
      );
      nextNum++;
    }
  }

  // Wait for ZFS operations
  await Promise.all(zfsPromises);

  // Apply zonecfg
  if (zonecfgCmds.length > 0) {
    const diskResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${zonecfgCmds.join(' ')}"`
    );
    if (!diskResult.success) {
      throw new Error(`Failed to add disks to zone: ${diskResult.error}`);
    }
    log.task.info('Added disks to zone', {
      zone_name: zoneName,
      count: disks.length,
    });
  }
};

/**
 * Remove disks from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} diskNames - Array of disk attribute names to remove (e.g., 'disk0')
 */
const removeDisks = async (zoneName, zoneConfig, diskNames) => {
  const cmds = [];

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
    cmds.push(`remove attr name=${diskName}`);

    // Remove the device block if we found the path
    if (diskPath) {
      cmds.push(`remove device match=/dev/zvol/rdsk/${diskPath}`);
    }
  }

  if (cmds.length > 0) {
    const removeResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`);
    if (!removeResult.success) {
      throw new Error(`Failed to remove disks: ${removeResult.error}`);
    }
    log.task.info('Removed disks from zone', { zone_name: zoneName, count: diskNames.length });
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
  const cmds = [];

  for (const cdrom of cdroms) {
    const attrName = `cdrom${nextNum}`;
    cmds.push(
      `add attr; set name=${attrName}; set value=\\"${cdrom.path}\\"; set type=string; end; add fs; set dir=${cdrom.path}; set special=${cdrom.path}; set type=lofs; add options ro; add options nodevices; end;`
    );
    nextNum++;
  }

  if (cmds.length > 0) {
    const cdromResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`);
    if (!cdromResult.success) {
      throw new Error(`Failed to add CDROMs to zone: ${cdromResult.error}`);
    }
    log.task.info('Added CDROMs to zone', { zone_name: zoneName, count: cdroms.length });
  }
};

/**
 * Remove CD-ROMs from zone configuration
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Array} cdromNames - Array of cdrom attribute names to remove (e.g., 'cdrom0')
 */
const removeCdroms = async (zoneName, zoneConfig, cdromNames) => {
  const cmds = [];

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
    cmds.push(`remove attr name=${cdromName}`);

    // Remove the fs block if we found the path
    if (cdromPath) {
      cmds.push(`remove fs dir=${cdromPath}`);
    }
  }

  if (cmds.length > 0) {
    const removeResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join('; ')}"`);
    if (!removeResult.success) {
      throw new Error(`Failed to remove CDROMs: ${removeResult.error}`);
    }
    log.task.info('Removed CDROMs from zone', { zone_name: zoneName, count: cdromNames.length });
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
 * Parse modification metadata
 * @param {Object} task - Task object
 * @returns {Promise<{metadata: Object, zoneName: string, zoneConfig: Object}>}
 */
const parseModificationMetadata = async task => {
  await updateTaskProgress(task, 5, { status: 'parsing_metadata' });

  const metadata = await new Promise((resolve, reject) => {
    yj.parseAsync(task.metadata, (err, parsed) => (err ? reject(err) : resolve(parsed)));
  });

  const zoneName = task.zone_name;

  await updateTaskProgress(task, 10, { status: 'reading_configuration' });
  const zoneConfig = await getZoneConfig(zoneName);

  return { metadata, zoneName, zoneConfig };
};

/**
 * Apply attribute changes if needed
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Current zone configuration
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array to update
 * @returns {Promise<void>}
 */
const applyAttributeChangesIfNeeded = async (zoneName, zoneConfig, metadata, task, changes) => {
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
    await applyAttributeChanges(zoneName, zoneConfig, metadata);
    changes.push('attributes');
  }
};

/**
 * Finalize modification and update database
 * @param {string} zoneName - Zone name
 * @param {Object} task - Task object
 * @param {Array} changes - Array of changes made
 * @returns {Promise<void>}
 */
const finalizeModification = async (zoneName, task, changes) => {
  await updateTaskProgress(task, 95, { status: 'updating_database_configuration' });
  await syncZoneToDatabase(zoneName);

  await updateTaskProgress(task, 100, { status: 'completed', changes });

  log.task.info('Zone modification completed', {
    zone_name: zoneName,
    changes,
  });
};

/**
 * Handle network modifications
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array
 */
const handleNetworkModifications = async (zoneName, metadata, task, changes) => {
  if (metadata.add_nics?.length > 0) {
    await updateTaskProgress(task, 50, { status: 'adding_nics' });
    await addNics(zoneName, metadata.add_nics);
    changes.push('add_nics');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_nics?.length > 0) {
    await updateTaskProgress(task, 55, { status: 'removing_nics' });
    await removeNics(zoneName, metadata.remove_nics);
    changes.push('remove_nics');
    await syncZoneToDatabase(zoneName);
  }
};

/**
 * Handle storage modifications
 * @param {string} zoneName - Zone name
 * @param {Object} zoneConfig - Zone configuration
 * @param {Object} metadata - Modification metadata
 * @param {Object} task - Task object
 * @param {Array} changes - Changes array
 */
const handleStorageModifications = async (zoneName, zoneConfig, metadata, task, changes) => {
  if (metadata.add_disks?.length > 0) {
    await updateTaskProgress(task, 60, { status: 'adding_disks' });
    await addDisks(zoneName, zoneConfig, metadata.add_disks, metadata.force);
    changes.push('add_disks');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_disks?.length > 0) {
    await updateTaskProgress(task, 70, { status: 'removing_disks' });
    await removeDisks(zoneName, zoneConfig, metadata.remove_disks);
    changes.push('remove_disks');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.add_cdroms?.length > 0) {
    await updateTaskProgress(task, 75, { status: 'adding_cdroms' });
    await addCdroms(zoneName, zoneConfig, metadata.add_cdroms);
    changes.push('add_cdroms');
    await syncZoneToDatabase(zoneName);
  }

  if (metadata.remove_cdroms?.length > 0) {
    await updateTaskProgress(task, 80, { status: 'removing_cdroms' });
    await removeCdroms(zoneName, zoneConfig, metadata.remove_cdroms);
    changes.push('remove_cdroms');
    await syncZoneToDatabase(zoneName);
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
    const { metadata, zoneName, zoneConfig } = await parseModificationMetadata(task);

    const changes = [];

    const initialChanges = changes.length;
    await applyAttributeChangesIfNeeded(zoneName, zoneConfig, metadata, task, changes);
    if (changes.length > initialChanges) {
      await syncZoneToDatabase(zoneName);
    }

    if (metadata.autoboot !== undefined) {
      await updateTaskProgress(task, 40, { status: 'modifying_autoboot' });
      await applyAutobootChange(zoneName, metadata.autoboot);
      changes.push('autoboot');
      await syncZoneToDatabase(zoneName);
    }

    await handleNetworkModifications(zoneName, metadata, task, changes);
    await handleStorageModifications(zoneName, zoneConfig, metadata, task, changes);

    if (metadata.cloud_init) {
      await updateTaskProgress(task, 85, { status: 'modifying_cloud_init' });
      await applyCloudInitChanges(zoneName, zoneConfig, metadata.cloud_init);
      changes.push('cloud_init');
      await syncZoneToDatabase(zoneName);
    }

    await finalizeModification(zoneName, task, changes);

    return {
      success: true,
      message: `Zone ${zoneName} modified successfully (${changes.join(', ')}). Changes will take effect on next zone boot.`,
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
