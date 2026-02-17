/**
 * @fileoverview Task chain builder for provisioning orchestration
 */

import { log } from '../../../lib/Logger.js';
import {
  createTask,
  createSequentialFolderTasks,
  createSequentialPlaybookTasks,
  shouldSkipZoneSetup,
} from './TaskCreationHelper.js';

/**
 * Build provisioning task chain with granular folder/playbook tasks
 * Creates parent tasks for sync and provision steps with individual child tasks
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} Task chain
 */
export const buildProvisioningTaskChain = async params => {
  const {
    zoneName,
    zone,
    skipBoot,
    skipRecipe,
    recipeId,
    provisioning,
    zoneIP,
    credentials,
    artifactId,
    parentTaskId,
    createdBy,
  } = params;

  const taskChain = [];
  let previousTaskId = null;
  let provisioningDatasetPath = null;

  // Step 0: Extract artifact (if provided)
  if (artifactId) {
    let zoneConfig = zone.configuration || {};
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (e) {
        log.api.warn('Failed to parse zone configuration', { error: e.message });
        zoneConfig = {};
      }
    }
    const zoneDataset = zoneConfig.zonepath
      ? zoneConfig.zonepath.replace('/path', '')
      : `/rpool/zones/${zoneName}`;

    const cleanZoneDataset = zoneDataset.startsWith('/') ? zoneDataset.substring(1) : zoneDataset;
    const provisioningDataset = `${cleanZoneDataset}/provisioning`;
    provisioningDatasetPath = `/${provisioningDataset}`;

    const extractTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provisioning_extract',
      metadata: {
        artifact_id: artifactId,
        dataset_path: provisioningDatasetPath,
      },
      depends_on: null,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({ step: 'extract', task_id: extractTask.id });
    previousTaskId = extractTask.id;
  }

  // Step 1: Boot zone
  if (!skipBoot && zone.status !== 'running') {
    const bootTask = await createTask({
      zone_name: zoneName,
      operation: 'start',
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({ step: 'boot', task_id: bootTask.id });
    previousTaskId = bootTask.id;
  }

  // Step 2: Run zlogin recipe (skip if SSH is already accessible)
  let shouldRunSetup = recipeId && !skipRecipe;
  if (shouldRunSetup) {
    const skipDueToSSH = await shouldSkipZoneSetup(zone, zoneIP, {
      credentials,
      ssh_port: provisioning.ssh_port,
    });
    if (skipDueToSSH) {
      shouldRunSetup = false;
    }
  }

  if (shouldRunSetup) {
    const recipeVariables = {
      ...(provisioning.variables || {}),
      username: credentials.username,
      password: credentials.password,
    };

    const setupTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_setup',
      metadata: {
        recipe_id: recipeId,
        variables: recipeVariables,
      },
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({ step: 'setup', task_id: setupTask.id });
    previousTaskId = setupTask.id;
  }

  // Step 3: Wait for SSH
  const sshTask = await createTask({
    zone_name: zoneName,
    operation: 'zone_wait_ssh',
    metadata: {
      ip: zoneIP,
      port: provisioning.ssh_port || 22,
      credentials,
    },
    depends_on: previousTaskId,
    parent_task_id: parentTaskId,
    created_by: createdBy,
  });
  taskChain.push({ step: 'wait_ssh', task_id: sshTask.id });
  previousTaskId = sshTask.id;

  // Step 4: Sync files with GRANULAR TASKS (one task per folder)
  const folders = provisioning.folders || provisioning.sync_folders || [];

  if (folders.length > 0) {
    // Create parent task for folder sync
    const syncParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_sync_parent',
      metadata: { total_folders: folders.length },
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({
      step: 'sync_parent',
      task_id: syncParentTask.id,
      folder_count: folders.length,
    });

    // Create individual sync tasks sequentially (each depends on previous)
    await createSequentialFolderTasks(
      folders,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      syncParentTask.id,
      createdBy
    );
    previousTaskId = syncParentTask.id;
  }

  // Step 5: Execute provisioners with GRANULAR TASKS (one task per playbook)
  const playbooks =
    provisioning.provisioning?.ansible?.playbooks?.local || provisioning.provisioners || [];

  if (playbooks.length > 0) {
    // Create parent task for provisioning
    const provisionParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provision_parent',
      metadata: { total_playbooks: playbooks.length },
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({
      step: 'provision_parent',
      task_id: provisionParentTask.id,
      playbook_count: playbooks.length,
    });

    // Create individual provision tasks sequentially (each depends on previous)
    await createSequentialPlaybookTasks(
      playbooks,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      provisionParentTask.id,
      createdBy
    );
  }

  return taskChain;
};
