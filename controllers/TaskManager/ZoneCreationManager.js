import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';
import Zones from '../../models/ZoneModel.js';
import os from 'os';
import { getZoneConfig, syncZoneToDatabase } from '../../lib/ZoneConfigUtils.js';

/**
 * Zone Creation Manager for Zone Lifecycle Operations
 * Handles creating new zones with zonecfg and zoneadm
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
 * Check if a zvol is already in use by another zone
 * @param {string} zvolPath - ZFS volume path to check
 * @param {string} [excludeZone] - Zone name to exclude from check
 * @returns {Promise<{inUse: boolean, usedBy: string|null}>}
 */
export const checkZvolInUse = async (zvolPath, excludeZone = null) => {
  const result = await executeCommand('pfexec zadm show');
  if (!result.success) {
    log.task.warn('Could not check zvol usage - zadm show failed', { error: result.error });
    return { inUse: false, usedBy: null };
  }

  let allZones;
  try {
    allZones = await new Promise((resolve, reject) => {
      yj.parseAsync(result.output, (err, parsed) => {
        if (err) {
          reject(err);
        } else {
          resolve(parsed);
        }
      });
    });
  } catch {
    log.task.warn('Could not parse zone configs for zvol check');
    return { inUse: false, usedBy: null };
  }

  for (const [zoneName, zoneConfig] of Object.entries(allZones)) {
    if (excludeZone && zoneName === excludeZone) {
      continue;
    }

    // Check bootdisk (object form from zadm show)
    if (zoneConfig.bootdisk?.path === zvolPath) {
      return { inUse: true, usedBy: zoneName };
    }

    // Check attrs for bootdisk and numbered disks
    if (Array.isArray(zoneConfig.attr)) {
      for (const attr of zoneConfig.attr) {
        if ((attr.name === 'bootdisk' || /^disk\d*$/u.test(attr.name)) && attr.value === zvolPath) {
          return { inUse: true, usedBy: zoneName };
        }
      }
    }
  }

  return { inUse: false, usedBy: null };
};

/**
 * Build a zonecfg attribute command string
 * Values are quoted to handle spaces and special characters
 * @param {string} name - Attribute name
 * @param {string} value - Attribute value
 * @returns {string} zonecfg add attr command
 */
const buildAttrCommand = (name, value) =>
  `add attr; set name=${name}; set value=\\"${value}\\"; set type=string; end;`;

/**
 * Prepare ZFS boot volume
 * @param {Object} metadata - Zone creation metadata
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @returns {Promise<string|null>} Boot disk path or null
 */
const prepareBootVolume = async (metadata, zoneName, zfsCreated) => {
  const { boot_volume } = metadata;
  if (!boot_volume) {
    return null;
  }

  if (boot_volume.create_new) {
    const pool = boot_volume.pool || 'rpool';
    const dataset = boot_volume.dataset || 'zones';
    const volumeName = boot_volume.volume_name || 'root';
    const size = boot_volume.size || '30G';
    const rootDataset = `${pool}/${dataset}/${zoneName}`;
    const bootdiskPath = `${rootDataset}/${volumeName}`;

    const parentResult = await executeCommand(`pfexec zfs create -p ${rootDataset}`);
    if (!parentResult.success) {
      throw new Error(`Failed to create parent dataset: ${parentResult.error}`);
    }
    zfsCreated.push(rootDataset);

    const sparseFlag = boot_volume.sparse !== false ? '-s' : '';
    const zvolResult = await executeCommand(
      `pfexec zfs create ${sparseFlag} -V ${size} ${bootdiskPath}`
    );
    if (!zvolResult.success) {
      throw new Error(`Failed to create boot volume: ${zvolResult.error}`);
    }

    log.task.info('Created boot volume', { path: bootdiskPath, size });
    return bootdiskPath;
  }

  if (boot_volume.existing_dataset) {
    const { existing_dataset } = boot_volume;

    const existResult = await executeCommand(`pfexec zfs list ${existing_dataset}`);
    if (!existResult.success) {
      throw new Error(`Dataset not found: ${existing_dataset}`);
    }

    const usageCheck = await checkZvolInUse(existing_dataset);
    if (usageCheck.inUse && !metadata.force) {
      throw new Error(`Dataset ${existing_dataset} is already in use by zone ${usageCheck.usedBy}`);
    }

    log.task.info('Attaching existing dataset', { path: existing_dataset });
    return existing_dataset;
  }

  return null;
};

/**
 * Import template via ZFS clone or send/recv
 * @param {Object} metadata - Zone creation metadata
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @returns {Promise<string|null>} Target dataset path or null
 */
const importTemplate = async (metadata, zoneName, zfsCreated) => {
  if (metadata.source?.type !== 'template') {
    return null;
  }

  const { template_dataset, clone_strategy } = metadata.source;
  const pool = metadata.boot_volume?.pool || 'rpool';
  const dataset = metadata.boot_volume?.dataset || 'zones';
  const volumeName = metadata.boot_volume?.volume_name || 'root';
  const targetDataset = `${pool}/${dataset}/${zoneName}/${volumeName}`;

  if (clone_strategy === 'copy') {
    const sendRecvResult = await executeCommand(
      `pfexec zfs send ${template_dataset}@ready | pfexec zfs recv -F ${targetDataset}`,
      3600 * 1000
    );
    if (!sendRecvResult.success) {
      throw new Error(`Template import failed: ${sendRecvResult.error}`);
    }
  } else {
    const cloneResult = await executeCommand(
      `pfexec zfs clone ${template_dataset}@ready ${targetDataset}`
    );
    if (!cloneResult.success) {
      throw new Error(`Template clone failed: ${cloneResult.error}`);
    }
  }

  zfsCreated.push(targetDataset);
  log.task.info('Template imported', { template: template_dataset, target: targetDataset });
  return targetDataset;
};

/**
 * Apply core zone configuration via zonecfg
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone creation metadata
 */
const applyZoneConfig = async (zoneName, metadata) => {
  const zonepath = metadata.zonepath || `/zones/${zoneName}`;
  const autoboot = metadata.autoboot === true ? 'true' : 'false';

  const createResult = await executeCommand(
    `pfexec zonecfg -z ${zoneName} "create; set zonepath=${zonepath}; set brand=${metadata.brand}; set autoboot=${autoboot}; set ip-type=exclusive"`
  );
  if (!createResult.success) {
    throw new Error(`Zone configuration failed: ${createResult.error}`);
  }

  // Optional bhyve attributes
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

  const attrs = Object.entries(attrMap)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => buildAttrCommand(name, value))
    .join(' ');

  if (attrs) {
    const attrResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${attrs}"`);
    if (!attrResult.success) {
      throw new Error(`Attribute configuration failed: ${attrResult.error}`);
    }
  }
};

/**
 * Configure bootdisk in zone
 * @param {string} zoneName - Zone name
 * @param {string} bootdiskPath - Path to bootdisk dataset
 */
const configureBootdisk = async (zoneName, bootdiskPath) => {
  const bootdiskCmd = `pfexec zonecfg -z ${zoneName} "${buildAttrCommand('bootdisk', bootdiskPath)} add device; set match=/dev/zvol/rdsk/${bootdiskPath}; end;"`;
  const bootdiskResult = await executeCommand(bootdiskCmd);
  if (!bootdiskResult.success) {
    throw new Error(`Bootdisk configuration failed: ${bootdiskResult.error}`);
  }
};

/**
 * Configure additional disks in zone
 * @param {string} zoneName - Zone name
 * @param {Array} disks - Array of disk configurations
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @param {boolean} force - Whether to force attach in-use datasets
 */
const configureAdditionalDisks = async (zoneName, disks, zfsCreated, force) => {
  const zfsPromises = [];
  const zonecfgCmds = [];

  for (let i = 0; i < disks.length; i++) {
    const disk = disks[i];
    let diskPath = null;

    if (disk.create_new) {
      const pool = disk.pool || 'rpool';
      const dset = disk.dataset || 'zones';
      const volName = disk.volume_name || `disk${i}`;
      const size = disk.size || '50G';
      diskPath = `${pool}/${dset}/${zoneName}/${volName}`;

      const sparseFlag = disk.sparse !== false ? '-s' : '';
      zfsPromises.push(
        executeCommand(`pfexec zfs create ${sparseFlag} -V ${size} ${diskPath}`).then(res => {
          if (!res.success) {
            throw new Error(`Failed to create disk ${i}: ${res.error}`);
          }
          zfsCreated.push(diskPath);
          return diskPath;
        })
      );
    } else if (disk.existing_dataset) {
      diskPath = disk.existing_dataset;

      zfsPromises.push(
        checkZvolInUse(diskPath).then(usageCheck => {
          if (usageCheck.inUse && !force) {
            throw new Error(`Disk ${diskPath} is already in use by zone ${usageCheck.usedBy}`);
          }
          return diskPath;
        })
      );
    }

    if (diskPath) {
      zonecfgCmds.push(
        `${buildAttrCommand(`disk${i}`, diskPath)} add device; set match=/dev/zvol/rdsk/${diskPath}; end;`
      );
    }
  }

  // Wait for ZFS operations
  await Promise.all(zfsPromises);

  // Apply zonecfg in batch
  if (zonecfgCmds.length > 0) {
    const diskResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${zonecfgCmds.join(' ')}"`
    );
    if (!diskResult.success) {
      throw new Error(`Disk configuration failed: ${diskResult.error}`);
    }
  }
};

/**
 * Configure CD-ROMs in zone
 * @param {string} zoneName - Zone name
 * @param {Array} cdroms - Array of CDROM configurations
 */
const configureCdroms = async (zoneName, cdroms) => {
  const cmds = cdroms.map((cdrom, i) => {
    // Single CD: 'cdrom', multiple: 'cdrom0', 'cdrom1', etc.
    const attrName = cdroms.length === 1 ? 'cdrom' : `cdrom${i}`;
    return `${buildAttrCommand(attrName, cdrom.path)} add fs; set dir=${cdrom.path}; set special=${cdrom.path}; set type=lofs; add options ro; add options nodevices; end;`;
  });

  if (cmds.length > 0) {
    const cdromResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`);
    if (!cdromResult.success) {
      throw new Error(`CDROM configuration failed: ${cdromResult.error}`);
    }
  }
};

/**
 * Configure NICs in zone
 * @param {string} zoneName - Zone name
 * @param {Array} nics - Array of NIC configurations
 */
const configureNics = async (zoneName, nics) => {
  const cmds = nics.map(nic => {
    if (nic.global_nic) {
      return `add net; set physical=${nic.physical}; set global-nic=${nic.global_nic}; end;`;
    }
    return `add net; set physical=${nic.physical}; end;`;
  });

  if (cmds.length > 0) {
    const nicResult = await executeCommand(`pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`);
    if (!nicResult.success) {
      throw new Error(`NIC configuration failed: ${nicResult.error}`);
    }
  }
};

/**
 * Configure cloud-init attributes in zone
 * @param {string} zoneName - Zone name
 * @param {Object} cloudInit - Cloud-init configuration
 */
const configureCloudInit = async (zoneName, cloudInit) => {
  const attrs = [];

  if (cloudInit.enabled) {
    attrs.push(buildAttrCommand('cloud-init', cloudInit.enabled));
  }
  if (cloudInit.dns_domain) {
    attrs.push(buildAttrCommand('dns-domain', cloudInit.dns_domain));
  }
  if (cloudInit.password) {
    attrs.push(buildAttrCommand('password', cloudInit.password));
  }
  if (cloudInit.resolvers) {
    attrs.push(buildAttrCommand('resolvers', cloudInit.resolvers));
  }
  if (cloudInit.sshkey) {
    attrs.push(buildAttrCommand('sshkey', cloudInit.sshkey));
  }

  if (attrs.length > 0) {
    const cloudCmd = `pfexec zonecfg -z ${zoneName} "${attrs.join(' ')}"`;
    const cloudResult = await executeCommand(cloudCmd);
    if (!cloudResult.success) {
      throw new Error(`Cloud-init configuration failed: ${cloudResult.error}`);
    }
  }
};

/**
 * Parse task metadata JSON asynchronously
 * @param {string} metadataJson - Raw metadata JSON string
 * @returns {Promise<Object>} Parsed metadata
 */
const parseMetadata = metadataJson =>
  new Promise((resolve, reject) => {
    yj.parseAsync(metadataJson, (err, parsed) => (err ? reject(err) : resolve(parsed)));
  });

/**
 * Rollback zone creation on failure
 * @param {string} zoneName - Zone name
 * @param {boolean} zonecfgApplied - Whether zonecfg was applied
 * @param {Array} zfsCreated - Array of created ZFS datasets to destroy
 */
const rollbackCreation = async (zoneName, zonecfgApplied, zfsCreated) => {
  if (!zoneName) {
    return;
  }

  try {
    if (zonecfgApplied) {
      await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);
      log.task.info('Rolled back zone configuration', { zone_name: zoneName });
    }

    const destroyPromises = [...zfsCreated]
      .reverse()
      .map(dataset =>
        executeCommand(`pfexec zfs destroy -r ${dataset}`).then(() =>
          log.task.info('Rolled back ZFS dataset', { dataset })
        )
      );
    await Promise.all(destroyPromises);
  } catch (rollbackError) {
    log.task.error('Rollback failed', { error: rollbackError.message });
  }
};

/**
 * Validate zone creation request
 * @param {Object} metadata - Parsed metadata
 * @param {string} zoneName - Zone name
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
const validateZoneCreationRequest = async (metadata, zoneName) => {
  if (!zoneName || !metadata.brand) {
    return {
      valid: false,
      error: 'Missing required parameters: name and brand are required',
    };
  }

  const existCheck = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
  if (existCheck.success) {
    return { valid: false, error: `Zone ${zoneName} already exists on the system` };
  }

  return { valid: true };
};

/**
 * Install zone and create database record
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone metadata
 * @param {Object} task - Task object
 * @returns {Promise<void>}
 */
const installAndRegisterZone = async (zoneName, metadata, task) => {
  await updateTaskProgress(task, 90, { status: 'installing_zone' });
  const installResult = await executeCommand(`pfexec zoneadm -z ${zoneName} install`, 3600 * 1000);
  if (!installResult.success) {
    throw new Error(`Zone installation failed: ${installResult.error}`);
  }

  await updateTaskProgress(task, 97, { status: 'creating_database_record' });
  await syncZoneToDatabase(zoneName, 'installed');
};

/**
 * Execute zone creation task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneCreateTask = async task => {
  log.task.debug('Zone creation task starting', {
    task_id: task.id,
    zone_name: task.zone_name,
  });

  const zfsCreated = [];
  let zonecfgApplied = false;
  let zoneName = null;

  try {
    await updateTaskProgress(task, 5, { status: 'validating' });

    const metadata = await parseMetadata(task.metadata);
    zoneName = metadata.name;

    const validation = await validateZoneCreationRequest(metadata, zoneName);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    await updateTaskProgress(task, 10, { status: 'preparing_storage' });
    let bootdiskPath = await prepareBootVolume(metadata, zoneName, zfsCreated);

    if (metadata.source?.type === 'template') {
      await updateTaskProgress(task, 30, { status: 'importing_template' });
      const templatePath = await importTemplate(metadata, zoneName, zfsCreated);
      if (templatePath) {
        bootdiskPath = templatePath;
      }
    }

    await updateTaskProgress(task, 40, { status: 'configuring_zone' });
    await applyZoneConfig(zoneName, metadata);
    zonecfgApplied = true;

    // Checkpoint 1: Sync immediately so we have a DB record even if install fails later
    await syncZoneToDatabase(zoneName, 'configured');

    if (bootdiskPath) {
      await updateTaskProgress(task, 50, { status: 'configuring_bootdisk' });
      await configureBootdisk(zoneName, bootdiskPath);
    }

    if (metadata.additional_disks?.length > 0) {
      await updateTaskProgress(task, 60, { status: 'configuring_disks' });
      await configureAdditionalDisks(
        zoneName,
        metadata.additional_disks,
        zfsCreated,
        metadata.force
      );
    }

    if (metadata.cdroms?.length > 0) {
      await updateTaskProgress(task, 70, { status: 'configuring_cdroms' });
      await configureCdroms(zoneName, metadata.cdroms);
    }

    if (metadata.nics?.length > 0) {
      await updateTaskProgress(task, 75, { status: 'configuring_network' });
      await configureNics(zoneName, metadata.nics);
    }

    if (metadata.cloud_init) {
      await updateTaskProgress(task, 80, { status: 'configuring_cloud_init' });
      await configureCloudInit(zoneName, metadata.cloud_init);
    }

    await installAndRegisterZone(zoneName, metadata, task);

    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Zone creation completed', { zone_name: zoneName, brand: metadata.brand });

    return {
      success: true,
      message: `Zone ${zoneName} created successfully`,
    };
  } catch (error) {
    log.task.error('Zone creation task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: zoneName,
    });

    await rollbackCreation(zoneName, zonecfgApplied, zfsCreated);

    return {
      success: false,
      error: `Zone creation failed: ${error.message}`,
    };
  }
};
