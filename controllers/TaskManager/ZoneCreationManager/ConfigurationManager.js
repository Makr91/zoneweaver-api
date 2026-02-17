import { executeCommand } from '../../../lib/CommandManager.js';
import {
  buildDatasetPath,
  buildAttrCommand,
  buildZoneAttributeMap,
} from './utils/ConfigBuilders.js';
import { generateVnicName } from './utils/NicHelpers.js';
import { checkZvolInUse } from './utils/ZvolHelper.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Zone configuration management - zonecfg operations
 */

/**
 * Apply core zone configuration via zonecfg
 * Supports both old structure and new Hosts.yml structure (settings/zones sections)
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone creation metadata
 */
export const applyZoneConfig = async (zoneName, metadata, onData = null) => {
  const pool = metadata.disks?.boot?.pool || 'rpool';
  const dataset = metadata.disks?.boot?.dataset || 'zones';
  const datasetPath = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const zonepath = metadata.zonepath || `/${datasetPath}/path`;
  const autoboot =
    metadata.autoboot === true || metadata.zones?.autostart === true ? 'true' : 'false';
  const brand = metadata.zones?.brand || metadata.brand;

  const createResult = await executeCommand(
    `pfexec zonecfg -z ${zoneName} "create; set zonepath=${zonepath}; set brand=${brand}; set autoboot=${autoboot}; set ip-type=exclusive"`,
    undefined,
    onData
  );
  if (!createResult.success) {
    throw new Error(`Zone configuration failed: ${createResult.error}`);
  }

  const attrMap = buildZoneAttributeMap(metadata);
  const attrs = Object.entries(attrMap)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => buildAttrCommand(name, value))
    .join(' ');

  if (attrs) {
    const attrResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${attrs}"`,
      undefined,
      onData
    );
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
export const configureBootdisk = async (zoneName, bootdiskPath, onData = null) => {
  const bootdiskCmd = `pfexec zonecfg -z ${zoneName} "${buildAttrCommand('bootdisk', bootdiskPath)} add device; set match=/dev/zvol/rdsk/${bootdiskPath}; end;"`;
  const bootdiskResult = await executeCommand(bootdiskCmd, undefined, onData);
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
 * @param {Object} metadata - Zone creation metadata (for server_id)
 */
export const configureAdditionalDisks = async (
  zoneName,
  disks,
  zfsCreated,
  force,
  metadata,
  onData = null
) => {
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
      const datasetPath = buildDatasetPath(`${pool}/${dset}`, zoneName, metadata.server_id);
      diskPath = `${datasetPath}/${volName}`;

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
      `pfexec zonecfg -z ${zoneName} "${zonecfgCmds.join(' ')}"`,
      undefined,
      onData
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
export const configureCdroms = async (zoneName, cdroms, onData = null) => {
  const cmds = cdroms.map((cdrom, i) => {
    // Single CD: 'cdrom', multiple: 'cdrom0', 'cdrom1', etc.
    const attrName = cdroms.length === 1 ? 'cdrom' : `cdrom${i}`;
    return `${buildAttrCommand(attrName, cdrom.path)} add fs; set dir=${cdrom.path}; set special=${cdrom.path}; set type=lofs; add options ro; add options nodevices; end;`;
  });

  if (cmds.length > 0) {
    const cdromResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
    if (!cdromResult.success) {
      throw new Error(`CDROM configuration failed: ${cdromResult.error}`);
    }
  }
};

/**
 * Configure NICs in zone
 * @param {string} zoneName - Zone name
 * @param {Array} nics - Array of NIC configurations
 * @param {Object} metadata - Zone creation metadata (for VNIC name generation)
 */
export const configureNics = async (zoneName, nics, metadata, onData = null) => {
  const cmds = nics.map((nic, index) => {
    const physical = nic.physical || generateVnicName(nic, index, metadata);
    let cmd = `add net; set physical=${physical};`;
    if (nic.global_nic) {
      cmd += ` set global-nic=${nic.global_nic};`;
    }
    if (nic.vlan_id) {
      cmd += ` set vlan-id=${nic.vlan_id};`;
    }
    if (nic.mac_addr) {
      cmd += ` set mac-addr=${nic.mac_addr};`;
    }
    if (nic.allowed_address) {
      cmd += ` set allowed-address=${nic.allowed_address};`;
    }
    cmd += ` end;`;
    return cmd;
  });

  if (cmds.length > 0) {
    const nicResult = await executeCommand(
      `pfexec zonecfg -z ${zoneName} "${cmds.join(' ')}"`,
      undefined,
      onData
    );
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
export const configureCloudInit = async (zoneName, cloudInit, onData = null) => {
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
    const cloudResult = await executeCommand(cloudCmd, undefined, onData);
    if (!cloudResult.success) {
      throw new Error(`Cloud-init configuration failed: ${cloudResult.error}`);
    }
  }
};

/**
 * Apply all zone configuration: core config, bootdisk, disks, cdroms, nics, cloud-init
 * @param {string} zoneName - Zone name
 * @param {Object} metadata - Zone creation metadata
 * @param {string|null} bootdiskPath - Boot disk path
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @param {Object} task - Task object for progress updates
 */
export const applyAllZoneConfig = async (
  zoneName,
  metadata,
  bootdiskPath,
  zfsCreated,
  task,
  onData = null
) => {
  await updateTaskProgress(task, 40, { status: 'configuring_zone' });
  await applyZoneConfig(zoneName, metadata, onData);

  if (bootdiskPath) {
    await updateTaskProgress(task, 50, { status: 'configuring_bootdisk' });
    await configureBootdisk(zoneName, bootdiskPath, onData);
  }

  if (metadata.disks?.additional?.length > 0) {
    await updateTaskProgress(task, 60, { status: 'configuring_disks' });
    await configureAdditionalDisks(
      zoneName,
      metadata.disks.additional,
      zfsCreated,
      metadata.force,
      metadata,
      onData
    );
  }

  if (metadata.cdroms?.length > 0) {
    await updateTaskProgress(task, 70, { status: 'configuring_cdroms' });
    await configureCdroms(zoneName, metadata.cdroms, onData);
  }

  if (metadata.nics?.length > 0) {
    await updateTaskProgress(task, 75, { status: 'configuring_network' });
    await configureNics(zoneName, metadata.nics, metadata, onData);
  }

  if (metadata.cloud_init) {
    await updateTaskProgress(task, 80, { status: 'configuring_cloud_init' });
    await configureCloudInit(zoneName, metadata.cloud_init, onData);
  }
};
