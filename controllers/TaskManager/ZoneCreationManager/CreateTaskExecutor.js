import { log } from '../../../lib/Logger.js';
import { parseMetadata } from './utils/MetadataParser.js';
import {
  validateZoneCreationRequest,
  rollbackCreation,
  finalizeAndInstallZone,
} from './ZoneLifecycle.js';
import { prepareStorage } from './StorageManager.js';
import { applyAllZoneConfig } from './ConfigurationManager.js';
import { updateTaskProgress } from '../../../lib/TaskProgressHelper.js';

/**
 * @fileoverview Deprecated single-task zone creation executor (kept for compatibility)
 */

/**
 * Execute zone creation task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneCreateTask = async task => {
  log.task.debug('Zone creation task starting', { task_id: task.id, zone_name: task.zone_name });

  const zfsCreated = [];
  let zonecfgApplied = false;

  // Zone name is already final (with or without prefix) from the controller
  const zoneName = task.zone_name;

  try {
    await updateTaskProgress(task, 5, { status: 'validating' });
    const metadata = await parseMetadata(task.metadata);

    // Ensure server_id is set in metadata if provided in settings (Hosts.yml format)
    if (metadata.settings?.server_id) {
      metadata.server_id = String(metadata.settings.server_id).padStart(4, '0');
    }

    const validation = await validateZoneCreationRequest(metadata, zoneName);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const { onData } = task;
    const bootdiskPath = await prepareStorage(metadata, zoneName, zfsCreated, task, onData);

    await applyAllZoneConfig(zoneName, metadata, bootdiskPath, zfsCreated, task, onData);
    zonecfgApplied = true;

    await finalizeAndInstallZone(zoneName, metadata, task, onData);
    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Zone creation completed', {
      zone_name: zoneName,
      brand: metadata.zones?.brand || metadata.brand,
      server_id: metadata.server_id,
    });

    return { success: true, message: `Zone ${zoneName} created successfully` };
  } catch (error) {
    log.task.error('Zone creation task exception', {
      error: error.message,
      stack: error.stack,
      zone_name: zoneName,
    });

    await rollbackCreation(zoneName, zonecfgApplied, zfsCreated);

    return { success: false, error: `Zone creation failed: ${error.message}` };
  }
};
