/**
 * @fileoverview Task creation helpers for provisioning orchestration
 */

import Tasks from '../../../models/TaskModel.js';
import { waitForSSH } from '../../../lib/SSHManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * Create a task in the chain
 * @param {Object} params - Task parameters
 * @returns {Promise<Object>} Created task
 */
export const createTask = params =>
  Tasks.create({
    zone_name: params.zone_name,
    operation: params.operation,
    status: 'pending',
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    depends_on: params.depends_on,
    parent_task_id: params.parent_task_id,
    created_by: params.created_by,
  });

/**
 * Create sequential folder sync tasks
 * @param {Array} folders - Folders to sync
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} syncParentTaskId - Parent task ID
 * @param {string} createdBy - Task creator
 * @returns {Promise<void>}
 */
export const createSequentialFolderTasks = (
  folders,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  syncParentTaskId,
  createdBy
) =>
  folders.reduce(
    (promise, folder) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_sync',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            folder,
          },
          depends_on: prevTaskId,
          parent_task_id: syncParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(syncParentTaskId)
  );

/**
 * Create sequential playbook provision tasks
 * @param {Array} playbooks - Playbooks to execute
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} provisionParentTaskId - Parent task ID
 * @param {string} createdBy - Task creator
 * @returns {Promise<void>}
 */
export const createSequentialPlaybookTasks = (
  playbooks,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  provisionParentTaskId,
  createdBy
) =>
  playbooks.reduce(
    (promise, playbook) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_provision',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            playbook,
          },
          depends_on: prevTaskId,
          parent_task_id: provisionParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(provisionParentTaskId)
  );

/**
 * Check if SSH is accessible and zone_setup can be skipped
 * @param {Object} zone - Zone database record
 * @param {string} zoneIP - Zone IP address
 * @param {Object} provisioning - Provisioning config
 * @returns {Promise<boolean>} True if should skip zone_setup
 */
export const shouldSkipZoneSetup = async (zone, zoneIP, provisioning) => {
  if (zone.status !== 'running') {
    return false;
  }

  try {
    const zoneConfig =
      typeof zone.configuration === 'string' ? JSON.parse(zone.configuration) : zone.configuration;
    const provisioningBasePath = zoneConfig.zonepath
      ? `${zoneConfig.zonepath.replace('/path', '')}/provisioning`
      : null;

    const sshCheck = await waitForSSH(
      zoneIP,
      provisioning.credentials?.username || 'root',
      provisioning.credentials,
      provisioning.ssh_port || 22,
      5000,
      2000,
      provisioningBasePath
    );

    if (sshCheck.success) {
      log.api.info('SSH already accessible, skipping zone_setup', {
        zone_name: zone.name,
        ip: zoneIP,
      });
      return true;
    }
  } catch (error) {
    log.api.debug('SSH check failed, will run zone_setup', {
      zone_name: zone.name,
      error: error.message,
    });
  }

  return false;
};
