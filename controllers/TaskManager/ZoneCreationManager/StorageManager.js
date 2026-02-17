import { executeCommand } from '../../../lib/CommandManager.js';
import { log } from '../../../lib/Logger.js';
import { checkZvolInUse } from './utils/ZvolHelper.js';
import { buildDatasetPath } from './utils/ConfigBuilders.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Zone storage preparation - boot volumes and template import
 */

/**
 * Prepare ZFS boot volume
 * @param {Object} metadata - Zone creation metadata
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @returns {Promise<string|null>} Boot disk path or null
 */
export const prepareBootVolume = async (metadata, zoneName, zfsCreated, onData = null) => {
  const bootDisk = metadata.disks?.boot;
  if (!bootDisk) {
    return null; // Diskless zone
  }

  // Scenario 1: Attaching existing dataset
  // If only dataset field exists (no pool/volume_name), it's a full path to existing dataset
  if (bootDisk.dataset && !bootDisk.pool && !bootDisk.volume_name) {
    const existingDataset = bootDisk.dataset;

    const existResult = await executeCommand(`pfexec zfs list ${existingDataset}`);
    if (!existResult.success) {
      throw new Error(`Dataset not found: ${existingDataset}`);
    }

    const usageCheck = await checkZvolInUse(existingDataset);
    if (usageCheck.inUse && !metadata.force) {
      throw new Error(`Dataset ${existingDataset} is already in use by zone ${usageCheck.usedBy}`);
    }

    log.task.info('Attaching existing dataset', { path: existingDataset });
    return existingDataset;
  }

  // Scenario 2: Template source - let importTemplate() handle everything
  if (bootDisk.source?.type === 'template') {
    return null; // importTemplate() will create and return the path
  }

  // Scenario 3: Creating new blank volume (scratch)
  const pool = bootDisk.pool || 'rpool';
  const dataset = bootDisk.dataset || 'zones';
  const volumeName = bootDisk.volume_name || 'boot';
  const size = bootDisk.size || '48G';
  const rootDataset = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const bootdiskPath = `${rootDataset}/${volumeName}`;

  const parentResult = await executeCommand(
    `pfexec zfs create -p ${rootDataset}`,
    undefined,
    onData
  );
  if (!parentResult.success) {
    throw new Error(`Failed to create parent dataset: ${parentResult.error}`);
  }
  zfsCreated.push(rootDataset);

  const sparseFlag = bootDisk.sparse !== false ? '-s' : '';
  const zvolResult = await executeCommand(
    `pfexec zfs create ${sparseFlag} -V ${size} ${bootdiskPath}`,
    undefined,
    onData
  );
  if (!zvolResult.success) {
    throw new Error(`Failed to create boot volume: ${zvolResult.error}`);
  }

  log.task.info('Created boot volume', { path: bootdiskPath, size });
  return bootdiskPath;
};

/**
 * Import template via ZFS clone or send/recv
 * @param {Object} metadata - Zone creation metadata
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @returns {Promise<string|null>} Target dataset path or null
 */
export const importTemplate = async (metadata, zoneName, zfsCreated, onData = null) => {
  const bootDisk = metadata.disks?.boot;
  if (!bootDisk?.source || bootDisk.source.type !== 'template') {
    return null;
  }

  const { template_dataset, clone_strategy = 'clone', snapshot_name } = bootDisk.source;
  const snapshot = snapshot_name || 'ready';
  const pool = bootDisk.pool || 'rpool';
  const dataset = bootDisk.dataset || 'zones';
  const volumeName = bootDisk.volume_name || 'boot';
  const requestedSize = bootDisk.size || '48G';
  const parentDataset = buildDatasetPath(`${pool}/${dataset}`, zoneName, metadata.server_id);
  const targetDataset = `${parentDataset}/${volumeName}`;

  // Create parent dataset for the zone
  const parentResult = await executeCommand(
    `pfexec zfs create -p ${parentDataset}`,
    undefined,
    onData
  );
  if (!parentResult.success) {
    throw new Error(`Failed to create parent dataset: ${parentResult.error}`);
  }
  zfsCreated.push(parentDataset);

  if (clone_strategy === 'copy') {
    const sendRecvResult = await executeCommand(
      `pfexec zfs send ${template_dataset}@${snapshot} | pfexec zfs recv -F ${targetDataset}`,
      3600 * 1000,
      onData
    );
    if (!sendRecvResult.success) {
      throw new Error(`Template import failed: ${sendRecvResult.error}`);
    }
  } else {
    const cloneResult = await executeCommand(
      `pfexec zfs clone ${template_dataset}@${snapshot} ${targetDataset}`,
      undefined,
      onData
    );
    if (!cloneResult.success) {
      throw new Error(`Template clone failed: ${cloneResult.error}`);
    }
  }

  zfsCreated.push(targetDataset);

  // Grow volume if requested size is larger than template size
  if (requestedSize) {
    const resizeResult = await executeCommand(
      `pfexec zfs set volsize=${requestedSize} ${targetDataset}`,
      undefined,
      onData
    );
    if (!resizeResult.success) {
      log.task.warn('Failed to resize boot volume', {
        target: targetDataset,
        requested_size: requestedSize,
        error: resizeResult.error,
      });
    } else {
      log.task.info('Boot volume resized', { target: targetDataset, size: requestedSize });
    }
  }

  log.task.info('Template imported', { template: template_dataset, target: targetDataset });
  return targetDataset;
};

/**
 * Prepare storage: boot volume and optional template import
 * @param {Object} metadata - Zone creation metadata
 * @param {string} zoneName - Zone name
 * @param {Array} zfsCreated - Array to track created datasets for rollback
 * @param {Object} task - Task object for progress updates
 * @returns {Promise<string|null>} Boot disk path or null
 */
export const prepareStorage = async (metadata, zoneName, zfsCreated, task, onData = null) => {
  await updateTaskProgress(task, 10, { status: 'preparing_storage' });
  let bootdiskPath = await prepareBootVolume(metadata, zoneName, zfsCreated, onData);

  if (metadata.disks?.boot?.source?.type === 'template') {
    await updateTaskProgress(task, 30, { status: 'importing_template' });
    const templatePath = await importTemplate(metadata, zoneName, zfsCreated, onData);
    if (templatePath) {
      bootdiskPath = templatePath;
    }
  }

  return bootdiskPath;
};
