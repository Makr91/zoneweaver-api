import { spawn } from 'child_process';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import Zones from '../models/ZoneModel.js';
import VncSessions from '../models/VncSessionModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import NetworkUsage from '../models/NetworkUsageModel.js';
import IPAddresses from '../models/IPAddressModel.js';
import ArtifactStorageLocation from '../models/ArtifactStorageLocationModel.js';
import Artifact from '../models/ArtifactModel.js';
import yj from 'yieldable-json';
import { Op } from 'sequelize';
import os from 'os';
import config from '../config/ConfigLoader.js';
import { setRebootRequired } from '../lib/RebootManager.js';
import { enableService, disableService, restartService, refreshService } from '../lib/ServiceManager.js';
import { log, createTimer } from '../lib/Logger.js';
import { listDirectory, getMimeType, moveItem, copyItem, createArchive, extractArchive } from '../lib/FileSystemManager.js';

/**
 * @fileoverview Task Queue controller for Zoneweaver API
 * @description Manages task execution, prioritization, and conflict resolution for zone operations
 * 
 * ⚠️  **CRITICAL IMPORT RULE** ⚠️
 * =================================
 * ALL IMPORTS MUST BE AT THE TOP OF THIS FILE!
 * NO await import() OR require() STATEMENTS ANYWHERE IN FUNCTIONS!
 * ALL LIBRARIES AND MODULES MUST BE IMPORTED STATICALLY ABOVE!
 * =================================
 */

/**
 * Operation categories for conflict detection
 * Operations in the same category cannot run simultaneously
 * NEVER EVER STORE THINGS IN /TMP, we always prefer to store things in the final directory WITHOUT using a intermediary temp folder and then moving, that is bad and slow
 */
const OPERATION_CATEGORIES = {
  // Package management operations (conflict with each other)
  pkg_install: 'package_management',
  pkg_uninstall: 'package_management',
  pkg_update: 'package_management',
  pkg_refresh: 'package_management',
  beadm_create: 'package_management',
  beadm_delete: 'package_management',
  beadm_activate: 'package_management',
  beadm_mount: 'package_management',
  beadm_unmount: 'package_management',
  repository_add: 'package_management',
  repository_remove: 'package_management',
  repository_modify: 'package_management',
  repository_enable: 'package_management',
  repository_disable: 'package_management',

  // Network datalink operations (may conflict with each other)
  create_vnic: 'network_datalink',
  delete_vnic: 'network_datalink',
  set_vnic_properties: 'network_datalink',
  create_aggregate: 'network_datalink',
  delete_aggregate: 'network_datalink',
  modify_aggregate_links: 'network_datalink',
  create_etherstub: 'network_datalink',
  delete_etherstub: 'network_datalink',
  create_vlan: 'network_datalink',
  delete_vlan: 'network_datalink',
  create_bridge: 'network_datalink',
  delete_bridge: 'network_datalink',
  modify_bridge_links: 'network_datalink',

  // Network IP operations (may conflict with each other)
  create_ip_address: 'network_ip',
  delete_ip_address: 'network_ip',
  enable_ip_address: 'network_ip',
  disable_ip_address: 'network_ip',

  // System operations (serialized)
  set_hostname: 'system_config',
  update_time_sync_config: 'system_config',
  force_time_sync: 'system_config',
  set_timezone: 'system_config',

  // User management operations (serialized)
  user_create: 'user_management',
  user_modify: 'user_management',
  user_delete: 'user_management',
  user_set_password: 'user_management',
  user_lock: 'user_management',
  user_unlock: 'user_management',
  group_create: 'user_management',
  group_modify: 'user_management',
  group_delete: 'user_management',
  role_create: 'user_management',
  role_modify: 'user_management',
  role_delete: 'user_management',

  // Zone operations (safe to run concurrently - no category)
  // start, stop, restart, delete, discover - no category = no conflicts

  // Service operations (safe to run concurrently - no category)
  // service_enable, service_disable, service_restart, service_refresh - no category = no conflicts

  // Artifact operations (safe to run concurrently - no category)
  // artifact_download_url, artifact_scan_all, artifact_scan_location, artifact_delete_file, 
  // artifact_delete_folder, artifact_upload_process - no category = no conflicts
};

/**
 * Task execution queue - in-memory tracking of running tasks
 */
const runningTasks = new Map();
let taskProcessor = null;

/**
 * Discovery interval ID for periodic zone discovery
 */
let discoveryProcessor = null;

/**
 * Track running operation categories to prevent conflicts
 */
const runningCategories = new Set();

/**
 * Maximum number of concurrent tasks
 */
const MAX_CONCURRENT_TASKS = config.getZones().max_concurrent_tasks || 5;

/**
 * Task timeout in milliseconds (5 minutes)
 */
const TASK_TIMEOUT = 5 * 60 * 1000;

/**
 * Execute a zone command asynchronously
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = TASK_TIMEOUT) => {
  const timer = createTimer(`executeCommand: ${command.substring(0, 50)}`);

  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        child.kill('SIGTERM');
        log.task.error('Command execution timeout', {
          command: command.substring(0, 100),
          timeout_ms: timeout,
          stdout_preview: stdout.substring(0, 200),
        });
        timer.end();
        resolve({
          success: false,
          error: `Command timed out after ${timeout}ms`,
          output: stdout,
        });
      }
    }, timeout);

    // Collect output
    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    // Handle completion
    child.on('close', code => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        const duration = timer.end();

        if (code === 0) {
          // Log performance info if command took >1000ms
          if (duration > 1000) {
            log.performance.info('Slow command execution', {
              command: command.substring(0, 100),
              duration_ms: duration,
              stdout_size: stdout.length,
            });
          }
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          log.task.error('Command execution failed', {
            command: command.substring(0, 100),
            exit_code: code,
            stderr: stderr.trim().substring(0, 200),
            duration_ms: duration,
          });
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
          });
        }
      }
    });

    // Handle errors
    child.on('error', error => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        const duration = timer.end();
        log.task.error('Command execution error', {
          command: command.substring(0, 100),
          error: error.message,
          duration_ms: duration,
        });
        resolve({
          success: false,
          error: error.message,
          output: stdout,
        });
      }
    });
  });
};

/**
 * Execute a specific task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeTask = async task => {
  const { operation, zone_name } = task;

  try {
    switch (operation) {
      case 'start':
        return await executeStartTask(zone_name);
      case 'stop':
        return await executeStopTask(zone_name);
      case 'restart':
        return await executeRestartTask(zone_name);
      case 'delete':
        return await executeDeleteTask(zone_name);
      case 'discover':
        return await executeDiscoverTask();
      case 'service_enable':
        return await enableService(zone_name);
      case 'service_disable':
        return await disableService(zone_name);
      case 'service_restart':
        return await restartService(zone_name);
      case 'service_refresh':
        return await refreshService(zone_name);
      case 'set_hostname':
        return await executeSetHostnameTask(task.metadata);
      case 'update_time_sync_config':
        return await executeUpdateTimeSyncConfigTask(task.metadata);
      case 'force_time_sync':
        return await executeForceTimeSyncTask(task.metadata);
      case 'set_timezone':
        return await executeSetTimezoneTask(task.metadata);
      case 'switch_time_sync_system':
        return await executeSwitchTimeSyncSystemTask(task.metadata);
      case 'create_ip_address':
        return await executeCreateIPAddressTask(task.metadata);
      case 'delete_ip_address':
        return await executeDeleteIPAddressTask(task.metadata);
      case 'enable_ip_address':
        return await executeEnableIPAddressTask(task.metadata);
      case 'disable_ip_address':
        return await executeDisableIPAddressTask(task.metadata);
      case 'create_vnic':
        return await executeCreateVNICTask(task.metadata);
      case 'delete_vnic':
        return await executeDeleteVNICTask(task.metadata);
      case 'set_vnic_properties':
        return await executeSetVNICPropertiesTask(task.metadata);
      case 'create_aggregate':
        return await executeCreateAggregateTask(task.metadata);
      case 'delete_aggregate':
        return await executeDeleteAggregateTask(task.metadata);
      case 'modify_aggregate_links':
        return await executeModifyAggregateLinksTask(task.metadata);
      case 'create_etherstub':
        return await executeCreateEtherstubTask(task.metadata);
      case 'delete_etherstub':
        return await executeDeleteEtherstubTask(task.metadata);
      case 'create_vlan':
        return await executeCreateVlanTask(task.metadata);
      case 'delete_vlan':
        return await executeDeleteVlanTask(task.metadata);
      case 'create_bridge':
        return await executeCreateBridgeTask(task.metadata);
      case 'delete_bridge':
        return await executeDeleteBridgeTask(task.metadata);
      case 'modify_bridge_links':
        return await executeModifyBridgeLinksTask(task.metadata);
      case 'pkg_install':
        return await executePkgInstallTask(task.metadata);
      case 'pkg_uninstall':
        return await executePkgUninstallTask(task.metadata);
      case 'pkg_update':
        return await executePkgUpdateTask(task.metadata);
      case 'pkg_refresh':
        return await executePkgRefreshTask(task.metadata);
      case 'beadm_create':
        return await executeBeadmCreateTask(task.metadata);
      case 'beadm_delete':
        return await executeBeadmDeleteTask(task.metadata);
      case 'beadm_activate':
        return await executeBeadmActivateTask(task.metadata);
      case 'beadm_mount':
        return await executeBeadmMountTask(task.metadata);
      case 'beadm_unmount':
        return await executeBeadmUnmountTask(task.metadata);
      case 'repository_add':
        return await executeRepositoryAddTask(task.metadata);
      case 'repository_remove':
        return await executeRepositoryRemoveTask(task.metadata);
      case 'repository_modify':
        return await executeRepositoryModifyTask(task.metadata);
      case 'repository_enable':
        return await executeRepositoryEnableTask(task.metadata);
      case 'repository_disable':
        return await executeRepositoryDisableTask(task.metadata);
      case 'process_trace':
        return await executeProcessTraceTask(task.metadata);
      case 'file_move':
        return await executeFileMoveTask(task.metadata);
      case 'file_copy':
        return await executeFileCopyTask(task.metadata);
      case 'file_archive_create':
        return await executeFileArchiveCreateTask(task.metadata);
      case 'file_archive_extract':
        return await executeFileArchiveExtractTask(task.metadata);
      case 'user_create':
        return await executeUserCreateTask(task.metadata);
      case 'user_modify':
        return await executeUserModifyTask(task.metadata);
      case 'user_delete':
        return await executeUserDeleteTask(task.metadata);
      case 'user_set_password':
        return await executeUserSetPasswordTask(task.metadata);
      case 'user_lock':
        return await executeUserLockTask(task.metadata);
      case 'user_unlock':
        return await executeUserUnlockTask(task.metadata);
      case 'group_create':
        return await executeGroupCreateTask(task.metadata);
      case 'group_modify':
        return await executeGroupModifyTask(task.metadata);
      case 'group_delete':
        return await executeGroupDeleteTask(task.metadata);
      case 'role_create':
        return await executeRoleCreateTask(task.metadata);
      case 'role_modify':
        return await executeRoleModifyTask(task.metadata);
      case 'role_delete':
        return await executeRoleDeleteTask(task.metadata);
      case 'artifact_download_url':
        return await executeArtifactDownloadTask(task.metadata);
      case 'artifact_scan_all':
        return await executeArtifactScanAllTask(task.metadata);
      case 'artifact_scan_location':
        return await executeArtifactScanLocationTask(task.metadata);
      case 'artifact_delete_file':
        return await executeArtifactDeleteFileTask(task.metadata);
      case 'artifact_delete_folder':
        return await executeArtifactDeleteFolderTask(task.metadata);
      case 'artifact_upload_process':
        return await executeArtifactUploadProcessTask(task.metadata);
      default:
        return { success: false, error: `Unknown operation: ${operation}` };
    }
  } catch (error) {
    log.task.error('Task execution failed', {
      operation,
      zone_name,
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
};

/**
 * Execute zone start task
 * @param {string} zoneName - Name of zone to start
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeStartTask = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);

  if (result.success) {
    // Update zone status in database
    await Zones.update(
      {
        status: 'running',
        last_seen: new Date(),
        is_orphaned: false,
      },
      { where: { name: zoneName } }
    );

    return {
      success: true,
      message: `Zone ${zoneName} started successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to start zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone stop task
 * @param {string} zoneName - Name of zone to stop
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeStopTask = async zoneName => {
  // First try graceful shutdown
  let result = await executeCommand(`pfexec zoneadm -z ${zoneName} shutdown`);

  // If graceful shutdown fails, try halt
  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);
  }

  if (result.success) {
    // Update zone status in database
    await Zones.update(
      {
        status: 'installed',
        last_seen: new Date(),
      },
      { where: { name: zoneName } }
    );

    // Terminate any active VNC sessions for this zone
    await terminateVncSession(zoneName);

    return {
      success: true,
      message: `Zone ${zoneName} stopped successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to stop zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone restart task
 * @param {string} zoneName - Name of zone to restart
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRestartTask = async zoneName => {
  // Stop first
  const stopResult = await executeStopTask(zoneName);
  if (!stopResult.success) {
    return stopResult;
  }

  // Wait a moment for clean shutdown
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Then start
  return await executeStartTask(zoneName);
};

/**
 * Execute zone delete task
 * @param {string} zoneName - Name of zone to delete
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteTask = async zoneName => {
  try {
    // Terminate VNC session if active
    await terminateVncSession(zoneName);

    // Stop zone if running
    await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);

    // Uninstall zone
    const uninstallResult = await executeCommand(`pfexec zoneadm -z ${zoneName} uninstall -F`);

    if (!uninstallResult.success) {
      return {
        success: false,
        error: `Failed to uninstall zone ${zoneName}: ${uninstallResult.error}`,
      };
    }

    // Delete zone configuration
    const deleteResult = await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);

    if (!deleteResult.success) {
      return {
        success: false,
        error: `Failed to delete zone configuration ${zoneName}: ${deleteResult.error}`,
      };
    }

    // Remove zone from database
    await Zones.destroy({ where: { name: zoneName } });

    // Clean up associated data
    await NetworkInterfaces.destroy({ where: { zone: zoneName } });
    await NetworkUsage.destroy({ where: { link: { [Op.like]: `${zoneName}%` } } });
    await IPAddresses.destroy({ where: { interface: { [Op.like]: `${zoneName}%` } } });

    // Clean up any remaining tasks for this zone
    await Tasks.update(
      { status: 'cancelled' },
      {
        where: {
          zone_name: zoneName,
          status: 'pending',
        },
      }
    );

    return {
      success: true,
      message: `Zone ${zoneName} deleted successfully`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to delete zone ${zoneName}: ${error.message}`,
    };
  }
};

/**
 * Execute zone discovery task
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDiscoverTask = async () => {
  try {
    // Get all zones from system using zadm
    const result = await executeCommand('pfexec zadm show');
    if (!result.success) {
      return { success: false, error: `Failed to get system zones: ${result.error}` };
    }

    const systemZones = await new Promise((resolve, reject) => {
      yj.parseAsync(result.output, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const systemZoneNames = Object.keys(systemZones);

    // Get all zones from database
    const dbZones = await Zones.findAll();
    const dbZoneNames = dbZones.map(z => z.name);

    let discovered = 0;
    let orphaned = 0;

    // Add new zones found on system but not in database
    for (const zoneName of systemZoneNames) {
      if (!dbZoneNames.includes(zoneName)) {
        const zoneConfig = systemZones[zoneName];

        // Get current status
        const statusResult = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
        let status = 'configured';
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || 'configured';
        }

        await Zones.create({
          name: zoneName,
          zone_id: zoneConfig.zonename || zoneName,
          host: os.hostname(),
          status,
          brand: zoneConfig.brand || 'unknown',
          auto_discovered: true,
          last_seen: new Date(),
        });

        discovered++;
      }
    }

    // Mark zones as orphaned if they exist in database but not on system
    for (const dbZone of dbZones) {
      if (!systemZoneNames.includes(dbZone.name)) {
        await dbZone.update({ is_orphaned: true });
        orphaned++;
      } else {
        // Update existing zones
        const zoneConfig = systemZones[dbZone.name];
        const statusResult = await executeCommand(`pfexec zoneadm -z ${dbZone.name} list -p`);
        let { status } = dbZone;
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || dbZone.status;
        }

        await dbZone.update({
          status,
          brand: zoneConfig.brand || dbZone.brand,
          last_seen: new Date(),
          is_orphaned: false,
        });
      }
    }

    return {
      success: true,
      message: `Discovery completed: ${discovered} new zones discovered, ${orphaned} zones orphaned`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Zone discovery failed: ${error.message}`,
    };
  }
};

/**
 * Terminate VNC session for a zone
 * @param {string} zoneName - Name of zone
 */
const terminateVncSession = async zoneName => {
  try {
    const session = await VncSessions.findOne({
      where: { zone_name: zoneName, status: 'active' },
    });

    if (session && session.process_id) {
      try {
        process.kill(session.process_id, 'SIGTERM');
      } catch (error) {
        log.task.warn('Failed to kill VNC process', {
          zone_name: zoneName,
          process_id: session.process_id,
          error: error.message,
        });
      }

      await session.update({ status: 'stopped' });
    }
  } catch (error) {
    log.task.warn('Failed to terminate VNC session', {
      zone_name: zoneName,
      error: error.message,
    });
  }
};

/**
 * Process next task from queue
 */
const processNextTask = async () => {
  try {
    // Don't start new tasks if we're at max capacity
    if (runningTasks.size >= MAX_CONCURRENT_TASKS) {
      return;
    }

    // Find highest priority pending task that's not blocked by dependencies
    const task = await Tasks.findOne({
      where: {
        status: 'pending',
        [Op.or]: [
          { depends_on: null },
          {
            depends_on: {
              [Op.in]: await Tasks.findAll({
                where: { status: 'completed' },
                attributes: ['id'],
              }).then(tasks => tasks.map(t => t.id)),
            },
          },
        ],
      },
      order: [
        ['priority', 'DESC'],
        ['created_at', 'ASC'],
      ],
    });

    if (!task) {
      return; // No tasks available
    }

    // Check for operation category conflicts
    const operationCategory = OPERATION_CATEGORIES[task.operation];
    if (operationCategory && runningCategories.has(operationCategory)) {
      log.task.warn('Task waiting for category lock', {
        task_id: task.id,
        operation: task.operation,
        category: operationCategory,
        zone_name: task.zone_name,
      });
      return; // Cannot start this task due to category conflict
    }

    // Mark task as running
    await task.update({
      status: 'running',
      started_at: new Date(),
    });

    runningTasks.set(task.id, task);

    // Add operation category to running set if it has one
    if (operationCategory) {
      runningCategories.add(operationCategory);
      log.task.debug('Acquired category lock', {
        task_id: task.id,
        category: operationCategory,
      });
    }

    log.task.info('Task started', {
      task_id: task.id,
      operation: task.operation,
      zone_name: task.zone_name,
      category: operationCategory || 'none',
    });

    // Execute task with performance timing
    const taskTimer = createTimer(`Task execution: ${task.operation}`);
    const result = await executeTask(task);
    const executionTime = taskTimer.end();

    // Update task status with progress
    const updateData = {
      status: result.success ? 'completed' : 'failed',
      completed_at: new Date(),
      error_message: result.error || null,
    };

    // Set progress to 100% for successful tasks (unless already set by task execution)
    if (result.success && task.progress_percent < 100) {
      updateData.progress_percent = 100;
      updateData.progress_info = {
        status: 'completed',
        completed_at: new Date().toISOString(),
      };
    }

    await task.update(updateData);

    runningTasks.delete(task.id);

    // Release operation category lock if it had one
    if (operationCategory) {
      runningCategories.delete(operationCategory);
      log.task.debug('Released category lock', {
        task_id: task.id,
        category: operationCategory,
      });
    }

    if (result.success) {
      // Only log slow tasks to reduce noise
      if (executionTime > 5000) {
        log.performance.warn('Slow task execution', {
          task_id: task.id,
          operation: task.operation,
          zone_name: task.zone_name,
          duration_ms: executionTime,
          message: result.message,
        });
      }
    } else {
      log.task.error('Task execution failed', {
        task_id: task.id,
        operation: task.operation,
        zone_name: task.zone_name,
        duration_ms: executionTime,
        error: result.error,
      });
    }
  } catch (error) {
    log.task.error('Task processing error', {
      error: error.message,
      stack: error.stack,
      running_task_count: runningTasks.size,
      running_categories: Array.from(runningCategories),
    });

    // Make sure to clean up category lock on error
    const task = await Tasks.findOne({
      where: { status: 'running' },
      order: [['started_at', 'DESC']],
    });

    if (task) {
      const operationCategory = OPERATION_CATEGORIES[task.operation];
      if (operationCategory && runningCategories.has(operationCategory)) {
        runningCategories.delete(operationCategory);
        log.task.warn('Emergency category lock cleanup', {
          task_id: task.id,
          category: operationCategory,
          reason: 'Task processing error',
        });
      }
    }
  }
};

/**
 * Start the task processor
 */
export const startTaskProcessor = () => {
  if (taskProcessor) {
    return; // Already running
  }

  log.task.info('Starting task processor');

  // Process tasks every 2 seconds
  taskProcessor = setInterval(async () => {
    await processNextTask();
  }, 2000);

  // Get zones configuration for discovery settings
  const zonesConfig = config.getZones();

  // Start periodic discovery if enabled
  if (zonesConfig.auto_discovery && zonesConfig.discovery_interval) {
    log.task.info('Starting periodic zone discovery', {
      interval_seconds: zonesConfig.discovery_interval,
    });

    // Start periodic discovery interval
    discoveryProcessor = setInterval(async () => {
      await Tasks.create({
        zone_name: 'system',
        operation: 'discover',
        priority: TaskPriority.BACKGROUND,
        created_by: 'system_periodic',
        status: 'pending',
      });
    }, zonesConfig.discovery_interval * 1000);
  }

  // Initial discovery task
  setTimeout(async () => {
    await Tasks.create({
      zone_name: 'system',
      operation: 'discover',
      priority: TaskPriority.BACKGROUND,
      created_by: 'system_startup',
      status: 'pending',
    });
  }, 5000);
};

/**
 * Stop the task processor
 */
export const stopTaskProcessor = () => {
  if (taskProcessor) {
    clearInterval(taskProcessor);
    taskProcessor = null;
    log.task.info('Task processor stopped');
  }

  if (discoveryProcessor) {
    clearInterval(discoveryProcessor);
    discoveryProcessor = null;
    log.task.info('Periodic discovery stopped');
  }
};

/**
 * @swagger
 * /tasks:
 *   get:
 *     summary: List tasks
 *     description: Retrieves a list of tasks with optional filtering
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, running, completed, failed, cancelled]
 *         description: Filter by task status
 *       - in: query
 *         name: zone_name
 *         schema:
 *           type: string
 *         description: Filter by zone name
 *       - in: query
 *         name: operation
 *         schema:
 *           type: string
 *           enum: [start, stop, restart, delete, discover]
 *         description: Filter by operation type
 *       - in: query
 *         name: operation_ne
 *         schema:
 *           type: string
 *         description: Exclude tasks with a specific operation type.
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return tasks created since this timestamp.
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of tasks to return
 *     responses:
 *       200:
 *         description: Tasks retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *                 total:
 *                   type: integer
 *                 running_count:
 *                   type: integer
 */
export const listTasks = async (req, res) => {
  try {
    const zonesConfig = config.getZones();
    const defaultLimit = zonesConfig.default_pagination_limit || 50;
    const { limit = defaultLimit, status, zone_name, operation, operation_ne, since } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }
    if (zone_name) {
      whereClause.zone_name = zone_name;
    }
    if (operation) {
      whereClause.operation = operation;
    }
    if (operation_ne) {
      whereClause.operation = { [Op.ne]: operation_ne };
    }
    if (since) {
      whereClause.created_at = { [Op.gte]: new Date(since) };
    }

    const tasks = await Tasks.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
    });

    const total = await Tasks.count({ where: whereClause });

    res.json({
      tasks,
      total,
      running_count: runningTasks.size,
    });
  } catch (error) {
    log.database.error('Database error listing tasks', {
      error: error.message,
      stack: error.stack,
      query_params: req.query,
    });
    res.status(500).json({ error: 'Failed to retrieve tasks' });
  }
};

/**
 * @swagger
 * /tasks/{taskId}:
 *   get:
 *     summary: Get task details
 *     description: Retrieves detailed information about a specific task
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: Task ID
 *     responses:
 *       200:
 *         description: Task details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Task'
 *       404:
 *         description: Task not found
 */
export const getTaskDetails = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Tasks.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    res.json(task);
  } catch (error) {
    log.database.error('Database error getting task details', {
      error: error.message,
      stack: error.stack,
      task_id: req.params.taskId,
    });
    res.status(500).json({ error: 'Failed to retrieve task details' });
  }
};

/**
 * @swagger
 * /tasks/{taskId}:
 *   delete:
 *     summary: Cancel task
 *     description: Cancels a pending task (cannot cancel running tasks)
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *         description: Task ID to cancel
 *     responses:
 *       200:
 *         description: Task cancelled successfully
 *       400:
 *         description: Task cannot be cancelled
 *       404:
 *         description: Task not found
 */
export const cancelTask = async (req, res) => {
  try {
    const { taskId } = req.params;

    const task = await Tasks.findByPk(taskId);
    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    if (task.status !== 'pending') {
      return res.status(400).json({
        error: 'Can only cancel pending tasks',
        current_status: task.status,
      });
    }

    await task.update({ status: 'cancelled' });

    res.json({
      success: true,
      task_id: taskId,
      message: 'Task cancelled successfully',
    });
  } catch (error) {
    log.database.error('Database error cancelling task', {
      error: error.message,
      stack: error.stack,
      task_id: req.params.taskId,
    });
    res.status(500).json({ error: 'Failed to cancel task' });
  }
};

/**
 * @swagger
 * /tasks/stats:
 *   get:
 *     summary: Get task queue statistics
 *     description: Retrieves statistics about the task queue
 *     tags: [Task Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Task statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pending_tasks:
 *                   type: integer
 *                 running_tasks:
 *                   type: integer
 *                 completed_tasks:
 *                   type: integer
 *                 failed_tasks:
 *                   type: integer
 *                 max_concurrent_tasks:
 *                   type: integer
 *                 task_processor_running:
 *                   type: boolean
 */
export const getTaskStats = async (req, res) => {
  try {
    const stats = await Tasks.findAll({
      attributes: ['status', [Tasks.sequelize.fn('COUNT', '*'), 'count']],
      group: ['status'],
    });

    const statMap = stats.reduce((acc, stat) => {
      acc[stat.status] = parseInt(stat.dataValues.count);
      return acc;
    }, {});

    res.json({
      pending_tasks: statMap.pending || 0,
      running_tasks: runningTasks.size,
      completed_tasks: statMap.completed || 0,
      failed_tasks: statMap.failed || 0,
      cancelled_tasks: statMap.cancelled || 0,
      max_concurrent_tasks: config.getZones().max_concurrent_tasks || 5,
      task_processor_running: taskProcessor !== null,
    });
  } catch (error) {
    log.database.error('Database error getting task stats', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to retrieve task statistics' });
  }
};

/**
 * Execute hostname change task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSetHostnameTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { hostname, apply_immediately } = metadata;

    // Write to /etc/nodename
    const writeResult = await executeCommand(`echo "${hostname}" | pfexec tee /etc/nodename`);
    if (!writeResult.success) {
      return {
        success: false,
        error: `Failed to write to /etc/nodename: ${writeResult.error}`,
      };
    }

    // Apply immediately if requested
    if (apply_immediately) {
      const hostnameResult = await executeCommand(`pfexec hostname ${hostname}`);
      if (!hostnameResult.success) {
        return {
          success: false,
          error: `Failed to set hostname immediately: ${hostnameResult.error}`,
        };
      }
    }

    return {
      success: true,
      message: `Hostname set to ${hostname}${apply_immediately ? ' (applied immediately)' : ' (reboot required)'}`,
      requires_reboot: true,
      reboot_reason: apply_immediately
        ? 'Hostname applied immediately but reboot required for full persistence'
        : 'Hostname written to /etc/nodename - reboot required to take effect',
    };
  } catch (error) {
    return { success: false, error: `Hostname task failed: ${error.message}` };
  }
};

/**
 * Execute IP address creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateIPAddressTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { interface: iface, type, addrobj, address, primary, wait, temporary, down } = metadata;

    let command = `pfexec ipadm create-addr`;

    // Add temporary flag
    if (temporary) {
      command += ` -t`;
    }

    // Build type-specific command
    switch (type) {
      case 'static':
        command += ` -T static`;
        if (down) {
          command += ` -d`;
        }
        command += ` -a ${address} ${addrobj}`;
        break;
      case 'dhcp':
        command += ` -T dhcp`;
        if (primary) {
          command += ` -1`;
        }
        if (wait) {
          command += ` -w ${wait}`;
        }
        command += ` ${addrobj}`;
        break;
      case 'addrconf':
        command += ` -T addrconf ${addrobj}`;
        break;
      default:
        return { success: false, error: `Unknown address type: ${type}` };
    }

    const result = await executeCommand(command);

    if (result.success) {
      // Clean up associated data
      await NetworkInterfaces.destroy({ where: { link: vlan } });
      await NetworkUsage.destroy({ where: { link: vlan } });

      return {
        success: true,
        message: `VLAN ${vlan} deleted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to delete VLAN ${vlan}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `IP address creation task failed: ${error.message}` };
  }
};

/**
 * Execute IP address deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteIPAddressTask = async metadataJson => {
  log.task.debug('IP address deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { addrobj, release } = metadata;

    log.task.debug('IP address deletion task parameters', {
      addrobj,
      release,
    });

    let command = `pfexec ipadm delete-addr`;
    if (release) {
      command += ` -r`;
    }
    command += ` ${addrobj}`;

    log.task.debug('Executing IP address deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('IP address deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this IP address
      const hostname = os.hostname();
      const [interfaceName] = addrobj.split('/'); // Extract interface from addrobj (e.g., vnic0/v4static -> vnic0)

      const cleanupResults = {
        ip_addresses: 0,
        network_interfaces: 0,
        ip_interface_deleted: false,
      };

      // Check if there are any remaining IP addresses on this interface
      log.task.debug('Checking for remaining IP addresses', { interface: interfaceName });
      const remainingAddrsResult = await executeCommand(
        `pfexec ipadm show-addr ${interfaceName} -p`
      );

      if (!remainingAddrsResult.success || !remainingAddrsResult.output.trim()) {
        // No remaining IP addresses, delete the IP interface
        log.task.debug('No remaining IP addresses, deleting IP interface', {
          interface: interfaceName,
        });
        const deleteInterfaceResult = await executeCommand(
          `pfexec ipadm delete-if ${interfaceName}`
        );

        if (deleteInterfaceResult.success) {
          cleanupResults.ip_interface_deleted = true;
          log.task.info('IP interface deleted', { interface: interfaceName });
        } else {
          log.task.warn('Failed to delete IP interface', {
            interface: interfaceName,
            error: deleteInterfaceResult.error,
          });
        }
      } else {
        log.task.debug('Interface still has IP addresses, keeping IP interface', {
          interface: interfaceName,
        });
      }

      try {
        // Clean up IPAddresses table (IP address monitoring data)
        const ipAddressesDeleted = await IPAddresses.destroy({
          where: {
            host: hostname,
            addrobj,
          },
        });
        cleanupResults.ip_addresses = ipAddressesDeleted;
        log.task.debug('Cleaned up IP address entries', {
          deleted_count: ipAddressesDeleted,
          addrobj,
        });

        // Note: NetworkInterfaces table tracks interfaces (like VNICs), not IP addresses
        // When deleting an IP address, we don't delete the interface entry itself
        // since the interface may still exist with other IP addresses
        cleanupResults.network_interfaces = 0;

        const totalCleaned = cleanupResults.ip_addresses;
        log.task.debug('Database cleanup completed', {
          total_cleaned: totalCleaned,
          addrobj,
        });

        return {
          success: true,
          message: `IP address ${addrobj} deleted successfully${cleanupResults.ip_interface_deleted ? ` (IP interface ${interfaceName} also deleted)` : ''} (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('IP address deleted but database cleanup failed', {
          addrobj,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `IP address ${addrobj} deleted successfully${cleanupResults.ip_interface_deleted ? ` (IP interface ${interfaceName} also deleted)` : ''} (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('IP address deletion command failed', {
        addrobj,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete IP address ${addrobj}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('IP address deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `IP address deletion task failed: ${error.message}` };
  }
};

/**
 * Execute IP address enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeEnableIPAddressTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { addrobj } = metadata;

    const result = await executeCommand(`pfexec ipadm enable-addr ${addrobj}`);

    if (result.success) {
      return {
        success: true,
        message: `IP address ${addrobj} enabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to enable IP address ${addrobj}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `IP address enable task failed: ${error.message}` };
  }
};

/**
 * Execute IP address disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDisableIPAddressTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { addrobj } = metadata;

    const result = await executeCommand(`pfexec ipadm disable-addr ${addrobj}`);

    if (result.success) {
      return {
        success: true,
        message: `IP address ${addrobj} disabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to disable IP address ${addrobj}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `IP address disable task failed: ${error.message}` };
  }
};

/**
 * Execute VNIC creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateVNICTask = async metadataJson => {
  log.task.debug('VNIC creation task starting', {
    metadata_type: typeof metadataJson,
    metadata_length: metadataJson ? metadataJson.length : 0,
  });

  try {
    if (!metadataJson) {
      log.task.error('VNIC creation task metadata is undefined or null');
      return { success: false, error: 'Task metadata is missing - cannot build dladm command' };
    }

    let metadata;
    try {
      metadata = await new Promise((resolve, reject) => {
        yj.parseAsync(metadataJson, (err, result) => {
          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        });
      });
      log.task.debug('Successfully parsed metadata', { metadata });
    } catch (parseError) {
      log.task.error('Failed to parse metadata JSON', {
        error: parseError.message,
      });
      return { success: false, error: `Invalid JSON metadata: ${parseError.message}` };
    }

    const { name, link, mac_address, mac_prefix, slot, vlan_id, temporary, properties } = metadata;

    // Log command building parameters
    log.task.debug('Building dladm create-vnic command', {
      name,
      link,
      mac_address,
      mac_prefix,
      slot,
      vlan_id,
      temporary,
      properties,
    });

    let command = `pfexec dladm create-vnic`;

    // Add temporary flag
    if (temporary) {
      command += ` -t`;
      log.task.debug('Added temporary flag to command');
    }

    // Add link
    if (link) {
      command += ` -l ${link}`;
      log.task.debug('Added link to command', { link });
    } else {
      log.task.warn('Missing required link parameter');
    }

    // Add MAC address configuration
    if (mac_address === 'factory') {
      command += ` -m factory -n ${slot}`;
      log.task.debug('Added factory MAC to command', { slot });
    } else if (mac_address === 'random') {
      command += ` -m random`;
      log.task.debug('Added random MAC to command');
      if (mac_prefix) {
        command += ` -r ${mac_prefix}`;
        log.task.debug('Added MAC prefix to command', { mac_prefix });
      }
    } else if (mac_address === 'auto') {
      command += ` -m auto`;
      log.task.debug('Added auto MAC to command');
    } else if (mac_address && mac_address !== 'auto') {
      // Specific MAC address provided
      command += ` -m ${mac_address}`;
      log.task.debug('Added specific MAC to command', { mac_address });
    } else {
      log.task.debug('Using default MAC assignment');
    }

    // Add VLAN ID if specified
    if (vlan_id) {
      command += ` -v ${vlan_id}`;
      log.task.debug('Added VLAN ID to command', { vlan_id });
    }

    // Add properties if specified
    if (properties && Object.keys(properties).length > 0) {
      const propList = Object.entries(properties)
        .map(([key, value]) => `${key}=${value}`)
        .join(',');
      command += ` -p ${propList}`;
      log.task.debug('Added properties to command', { properties: propList });
    }

    // Add VNIC name
    if (name) {
      command += ` ${name}`;
      log.task.debug('Added VNIC name to command', { name });
    } else {
      log.task.warn('Missing required VNIC name parameter');
    }

    log.task.debug('Final VNIC creation command', { command });

    // Validate required parameters before executing
    if (!name || !link) {
      log.task.error('Missing required parameters - cannot execute command', {
        name_missing: !name,
        link_missing: !link,
      });
      return {
        success: false,
        error: `Missing required parameters: ${!name ? 'name ' : ''}${!link ? 'link' : ''}`,
      };
    }

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('VNIC creation completed', { name, link });
      return {
        success: true,
        message: `VNIC ${name} created successfully over ${link}`,
      };
    }
    log.task.error('VNIC creation failed', {
      name,
      error: result.error,
    });
    return {
      success: false,
      error: `Failed to create VNIC ${name}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('VNIC creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `VNIC creation task failed: ${error.message}` };
  }
};

/**
 * Execute VNIC deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteVNICTask = async metadataJson => {
  log.task.debug('VNIC deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { vnic, temporary } = metadata;

    log.task.debug('VNIC deletion task parameters', {
      vnic,
      temporary,
    });

    let command = `pfexec dladm delete-vnic`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${vnic}`;

    log.task.debug('Executing VNIC deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('VNIC deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this VNIC
      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_stats: 0,
        network_usage: 0,
      };

      try {
        // Clean up NetworkInterfaces table (monitoring data)
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: vnic,
            class: 'vnic',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          vnic,
        });

        // Clean up NetworkUsage table (usage accounting)
        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: vnic,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          vnic,
        });

        const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_usage;
        log.task.info('Database cleanup completed for VNIC', {
          total_cleaned: totalCleaned,
          vnic,
        });

        return {
          success: true,
          message: `VNIC ${vnic} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('VNIC deleted but database cleanup failed', {
          vnic,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `VNIC ${vnic} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('VNIC deletion command failed', {
        vnic,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete VNIC ${vnic}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('VNIC deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `VNIC deletion task failed: ${error.message}` };
  }
};

/**
 * Execute VNIC properties setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSetVNICPropertiesTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { vnic, properties, temporary } = metadata;

    let command = `pfexec dladm set-linkprop`;
    if (temporary) {
      command += ` -t`;
    }

    // Build properties list
    const propList = Object.entries(properties)
      .map(([key, value]) => `${key}=${value}`)
      .join(',');

    command += ` -p ${propList} ${vnic}`;

    const result = await executeCommand(command);

    if (result.success) {
      // Clean up all monitoring database entries for this VLAN
      const hostname = os.hostname();
      await NetworkInterfaces.destroy({ where: { host: hostname, link: vlan, class: 'vlan' } });
      await NetworkUsage.destroy({ where: { host: hostname, link: vlan } });

      return {
        success: true,
        message: `VLAN ${vlan} deleted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to set VNIC ${vnic} properties: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `VNIC properties task failed: ${error.message}` };
  }
};

/**
 * Execute aggregate creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateAggregateTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, links, policy, lacp_mode, lacp_timer, unicast_address, temporary } = metadata;

    let command = `pfexec dladm create-aggr`;

    // Add temporary flag
    if (temporary) {
      command += ` -t`;
    }

    // Add policy
    if (policy && policy !== 'L4') {
      command += ` -P ${policy}`;
    }

    // Add LACP configuration
    if (lacp_mode && lacp_mode !== 'off') {
      command += ` -L ${lacp_mode}`;
    }
    if (lacp_timer && lacp_timer !== 'short') {
      command += ` -T ${lacp_timer}`;
    }

    // Add unicast address if specified
    if (unicast_address) {
      command += ` -u ${unicast_address}`;
    }

    // Add links
    for (const link of links) {
      command += ` -l ${link}`;
    }

    // Add aggregate name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Aggregate ${name} created successfully with links: ${links.join(', ')}`,
      };
    }
    return {
      success: false,
      error: `Failed to create aggregate ${name}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Aggregate creation task failed: ${error.message}` };
  }
};

/**
 * Execute aggregate deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteAggregateTask = async metadataJson => {
  log.task.debug('Aggregate deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { aggregate, temporary } = metadata;

    log.task.debug('Aggregate deletion task parameters', {
      aggregate,
      temporary,
    });

    let command = `pfexec dladm delete-aggr`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${aggregate}`;

    log.task.debug('Executing aggregate deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('Aggregate deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this aggregate
      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_usage: 0,
      };

      try {
        // Clean up NetworkInterfaces table (monitoring data)
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: aggregate,
            class: 'aggr',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          aggregate,
        });

        // Clean up NetworkUsage table (usage accounting)
        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: aggregate,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          aggregate,
        });

        const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_usage;
        log.task.info('Database cleanup completed for aggregate', {
          total_cleaned: totalCleaned,
          aggregate,
        });

        return {
          success: true,
          message: `Aggregate ${aggregate} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('Aggregate deleted but database cleanup failed', {
          aggregate,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `Aggregate ${aggregate} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('Aggregate deletion command failed', {
        aggregate,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete aggregate ${aggregate}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Aggregate deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Aggregate deletion task failed: ${error.message}` };
  }
};

/**
 * Execute aggregate links modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeModifyAggregateLinksTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { aggregate, operation, links, temporary } = metadata;

    let command = `pfexec dladm ${operation}-aggr`;
    if (temporary) {
      command += ` -t`;
    }

    // Add links
    for (const link of links) {
      command += ` -l ${link}`;
    }

    // Add aggregate name
    command += ` ${aggregate}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${operation}ed links ${links.join(', ')} ${operation === 'add' ? 'to' : 'from'} aggregate ${aggregate}`,
      };
    }
    return {
      success: false,
      error: `Failed to ${operation} links on aggregate ${aggregate}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Aggregate links modification task failed: ${error.message}` };
  }
};

/**
 * Execute etherstub creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateEtherstubTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, temporary } = metadata;

    let command = `pfexec dladm create-etherstub`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Etherstub ${name} created successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to create etherstub ${name}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Etherstub creation task failed: ${error.message}` };
  }
};

/**
 * Execute etherstub deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteEtherstubTask = async metadataJson => {
  log.task.debug('Etherstub deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { etherstub, temporary, force } = metadata;

    log.task.debug('Etherstub deletion task parameters', {
      etherstub,
      temporary,
      force,
    });

    // If force deletion, first remove any VNICs on the etherstub
    if (force) {
      log.task.debug('Force deletion enabled, checking for VNICs on etherstub');
      const vnicResult = await executeCommand(`pfexec dladm show-vnic -l ${etherstub} -p -o link`);
      if (vnicResult.success && vnicResult.output.trim()) {
        const vnics = vnicResult.output.trim().split('\n');
        log.task.debug('Found VNICs to remove', {
          count: vnics.length,
          vnics: vnics.join(', '),
        });
        for (const vnic of vnics) {
          log.task.debug('Removing VNIC from etherstub', { vnic });
          await executeCommand(`pfexec dladm delete-vnic ${temporary ? '-t' : ''} ${vnic}`);
        }
      } else {
        log.task.debug('No VNICs found on etherstub');
      }
    }

    let command = `pfexec dladm delete-etherstub`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${etherstub}`;

    log.task.debug('Executing etherstub deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.debug('Etherstub deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this etherstub
      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_stats: 0,
        network_usage: 0,
      };

      try {
        // Clean up NetworkInterfaces table (monitoring data)
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: etherstub,
            class: 'etherstub',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          etherstub,
        });

        // Clean up NetworkUsage table (usage accounting)
        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: etherstub,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          etherstub,
        });

        const totalCleaned =
          cleanupResults.network_interfaces +
          cleanupResults.network_stats +
          cleanupResults.network_usage;
        log.task.info('Database cleanup completed for etherstub', {
          total_cleaned: totalCleaned,
          etherstub,
        });

        return {
          success: true,
          message: `Etherstub ${etherstub} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('Etherstub deleted but database cleanup failed', {
          etherstub,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `Etherstub ${etherstub} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('Etherstub deletion command failed', {
        etherstub,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete etherstub ${etherstub}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Etherstub deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Etherstub deletion task failed: ${error.message}` };
  }
};

/**
 * Execute VLAN creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateVlanTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { vid, link, name, force, temporary } = metadata;

    let command = `pfexec dladm create-vlan`;
    if (force) {
      command += ` -f`;
    }
    if (temporary) {
      command += ` -t`;
    }
    command += ` -l ${link} -v ${vid}`;
    if (name) {
      command += ` ${name}`;
    }

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `VLAN ${name || `${link}_${vid}`} created successfully (VID ${vid}) over ${link}`,
      };
    }
    return {
      success: false,
      error: `Failed to create VLAN ${name || `${link}_${vid}`}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `VLAN creation task failed: ${error.message}` };
  }
};

/**
 * Execute VLAN deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteVlanTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { vlan, temporary } = metadata;

    let command = `pfexec dladm delete-vlan`;
    if (temporary) {
      command += ` -t`;
    }
    command += ` ${vlan}`;

    const result = await executeCommand(command);

    if (result.success) {
      // Clean up associated data
      await NetworkInterfaces.destroy({ where: { link: vlan } });
      await NetworkUsage.destroy({ where: { link: vlan } });

      return {
        success: true,
        message: `VLAN ${vlan} deleted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to delete VLAN ${vlan}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `VLAN deletion task failed: ${error.message}` };
  }
};

/**
 * Execute bridge creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateBridgeTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const {
      name,
      protection,
      priority,
      max_age,
      hello_time,
      forward_delay,
      force_protocol,
      links,
    } = metadata;

    let command = `pfexec dladm create-bridge`;

    // Add protection
    if (protection && protection !== 'stp') {
      command += ` -P ${protection}`;
    }

    // Add priority
    if (priority && priority !== 32768) {
      command += ` -p ${priority}`;
    }

    // Add timing parameters
    if (max_age && max_age !== 20) {
      command += ` -m ${max_age}`;
    }
    if (hello_time && hello_time !== 2) {
      command += ` -h ${hello_time}`;
    }
    if (forward_delay && forward_delay !== 15) {
      command += ` -d ${forward_delay}`;
    }

    // Add force protocol
    if (force_protocol && force_protocol !== 3) {
      command += ` -f ${force_protocol}`;
    }

    // Add links
    if (links && links.length > 0) {
      for (const link of links) {
        command += ` -l ${link}`;
      }
    }

    // Add bridge name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Bridge ${name} created successfully${links && links.length > 0 ? ` with links: ${links.join(', ')}` : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to create bridge ${name}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Bridge creation task failed: ${error.message}` };
  }
};

/**
 * Execute bridge deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteBridgeTask = async metadataJson => {
  log.task.debug('Bridge deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { bridge, force } = metadata;

    log.task.debug('Bridge deletion task parameters', {
      bridge,
      force,
    });

    // If force deletion, first remove any attached links
    if (force) {
      log.task.debug('Force deletion enabled, checking for attached links');
      const linksResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -l -p -o link`);
      if (linksResult.success && linksResult.output.trim()) {
        const attachedLinks = linksResult.output.trim().split('\n');
        log.task.debug('Found attached links to remove', {
          count: attachedLinks.length,
          links: attachedLinks.join(', '),
        });
        for (const link of attachedLinks) {
          log.task.debug('Removing link from bridge', { link, bridge });
          await executeCommand(`pfexec dladm remove-bridge -l ${link} ${bridge}`);
        }
      } else {
        log.task.debug('No attached links found on bridge');
      }
    }

    log.task.debug('Executing bridge deletion command');
    const result = await executeCommand(`pfexec dladm delete-bridge ${bridge}`);

    if (result.success) {
      log.task.debug('Bridge deleted from system, cleaning up database');

      // Clean up all monitoring database entries for this bridge
      const hostname = os.hostname();
      const cleanupResults = {
        network_interfaces: 0,
        network_stats: 0,
        network_usage: 0,
      };

      try {
        // Clean up NetworkInterfaces table (monitoring data)
        const interfacesDeleted = await NetworkInterfaces.destroy({
          where: {
            host: hostname,
            link: bridge,
            class: 'bridge',
          },
        });
        cleanupResults.network_interfaces = interfacesDeleted;
        log.task.debug('Cleaned up network interface entries', {
          deleted_count: interfacesDeleted,
          bridge,
        });

        // Clean up NetworkUsage table (usage accounting)
        const usageDeleted = await NetworkUsage.destroy({
          where: {
            host: hostname,
            link: bridge,
          },
        });
        cleanupResults.network_usage = usageDeleted;
        log.task.debug('Cleaned up network usage entries', {
          deleted_count: usageDeleted,
          bridge,
        });

        const totalCleaned =
          cleanupResults.network_interfaces +
          cleanupResults.network_stats +
          cleanupResults.network_usage;
        log.task.info('Database cleanup completed for bridge', {
          total_cleaned: totalCleaned,
          bridge,
        });

        return {
          success: true,
          message: `Bridge ${bridge} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
          cleanup_summary: cleanupResults,
        };
      } catch (cleanupError) {
        log.task.warn('Bridge deleted but database cleanup failed', {
          bridge,
          error: cleanupError.message,
        });
        return {
          success: true,
          message: `Bridge ${bridge} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
          cleanup_error: cleanupError.message,
        };
      }
    } else {
      log.task.error('Bridge deletion command failed', {
        bridge,
        error: result.error,
      });
      return {
        success: false,
        error: `Failed to delete bridge ${bridge}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Bridge deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Bridge deletion task failed: ${error.message}` };
  }
};

/**
 * Execute bridge links modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeModifyBridgeLinksTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { bridge, operation, links } = metadata;

    let command = `pfexec dladm ${operation}-bridge`;

    // Add links
    for (const link of links) {
      command += ` -l ${link}`;
    }

    // Add bridge name
    command += ` ${bridge}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${operation}ed links ${links.join(', ')} ${operation === 'add' ? 'to' : 'from'} bridge ${bridge}`,
      };
    }
    return {
      success: false,
      error: `Failed to ${operation} links on bridge ${bridge}: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Bridge links modification task failed: ${error.message}` };
  }
};

/**
 * Execute package installation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgInstallTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { packages, accept_licenses, dry_run, be_name } = metadata;

    let command = `pfexec pkg install`;

    if (dry_run) {
      command += ` -n`;
    }

    if (accept_licenses) {
      command += ` --accept`;
    }

    if (be_name) {
      command += ` --be-name ${be_name}`;
    }

    // Add packages
    command += ` ${packages.join(' ')}`;

    const result = await executeCommand(command, 10 * 60 * 1000); // 10 minute timeout

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${dry_run ? 'planned installation of' : 'installed'} ${packages.length} package(s): ${packages.join(', ')}`,
      };
    }
    return {
      success: false,
      error: `Failed to install packages: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package installation task failed: ${error.message}` };
  }
};

/**
 * Execute package uninstallation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgUninstallTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { packages, dry_run, be_name } = metadata;

    let command = `pfexec pkg uninstall`;

    if (dry_run) {
      command += ` -n`;
    }

    if (be_name) {
      command += ` --be-name ${be_name}`;
    }

    // Add packages
    command += ` ${packages.join(' ')}`;

    const result = await executeCommand(command, 10 * 60 * 1000); // 10 minute timeout

    if (result.success) {
      return {
        success: true,
        message: `Successfully ${dry_run ? 'planned uninstallation of' : 'uninstalled'} ${packages.length} package(s): ${packages.join(', ')}`,
      };
    }
    return {
      success: false,
      error: `Failed to uninstall packages: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package uninstallation task failed: ${error.message}` };
  }
};

/**
 * Execute system update task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgUpdateTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { packages, accept_licenses, be_name, backup_be, reject_packages } = metadata;

    let command = `pfexec pkg update`;

    if (accept_licenses) {
      command += ` --accept`;
    }

    if (be_name) {
      command += ` --be-name ${be_name}`;
    }

    if (backup_be === false) {
      command += ` --no-backup-be`;
    }

    // Add reject packages
    if (reject_packages && reject_packages.length > 0) {
      for (const pkg of reject_packages) {
        command += ` --reject ${pkg}`;
      }
    }

    // Add specific packages if provided, otherwise update all
    if (packages && packages.length > 0) {
      command += ` ${packages.join(' ')}`;
    }

    const result = await executeCommand(command, 30 * 60 * 1000); // 30 minute timeout

    if (result.success) {
      return {
        success: true,
        message:
          packages && packages.length > 0
            ? `Successfully updated ${packages.length} specific package(s): ${packages.join(', ')}`
            : 'Successfully updated all available packages',
      };
    }
    return {
      success: false,
      error: `Failed to update packages: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package update task failed: ${error.message}` };
  }
};

/**
 * Execute package metadata refresh task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgRefreshTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { full, publishers } = metadata;

    let command = `pfexec pkg refresh`;

    if (full) {
      command += ` --full`;
    }

    // Add specific publishers if provided
    if (publishers && publishers.length > 0) {
      command += ` ${publishers.join(' ')}`;
    }

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message:
          publishers && publishers.length > 0
            ? `Successfully refreshed metadata for ${publishers.length} publisher(s): ${publishers.join(', ')}`
            : 'Successfully refreshed metadata for all publishers',
      };
    }
    return {
      success: false,
      error: `Failed to refresh metadata: ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Package refresh task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmCreateTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, description, source_be, snapshot, activate, zpool, properties } = metadata;

    let command = `pfexec beadm create`;

    if (activate) {
      command += ` -a`;
    }

    if (description) {
      command += ` -d "${description}"`;
    }

    if (source_be) {
      command += ` -e ${source_be}`;
    } else if (snapshot) {
      command += ` -e ${snapshot}`;
    }

    if (zpool) {
      command += ` -p ${zpool}`;
    }

    // Add properties if specified
    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` -o ${key}=${value}`;
      }
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' created successfully${activate ? ' and activated' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to create boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment creation task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmDeleteTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, force, snapshots } = metadata;

    let command = `pfexec beadm destroy`;

    if (force) {
      command += ` -F`;
    }

    if (snapshots) {
      command += ` -s`;
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' deleted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to delete boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment deletion task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment activation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmActivateTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, temporary } = metadata;

    let command = `pfexec beadm activate`;

    if (temporary) {
      command += ` -t`;
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' activated successfully${temporary ? ' (temporary)' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to activate boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment activation task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment mount task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmMountTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, mountpoint, shared_mode } = metadata;

    let command = `pfexec beadm mount`;

    if (shared_mode) {
      command += ` -s ${shared_mode}`;
    }

    // Add BE name and mountpoint
    command += ` ${name} ${mountpoint}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' mounted successfully at '${mountpoint}'`,
      };
    }
    return {
      success: false,
      error: `Failed to mount boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment mount task failed: ${error.message}` };
  }
};

/**
 * Execute boot environment unmount task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmUnmountTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name, force } = metadata;

    let command = `pfexec beadm unmount`;

    if (force) {
      command += ` -f`;
    }

    // Add BE name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Boot environment '${name}' unmounted successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to unmount boot environment '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Boot environment unmount task failed: ${error.message}` };
  }
};

/**
 * Execute repository addition task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryAddTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const {
      name,
      origin,
      mirrors,
      ssl_cert,
      ssl_key,
      enabled,
      sticky,
      search_first,
      search_before,
      search_after,
      properties,
      proxy,
    } = metadata;

    let command = `pfexec pkg set-publisher`;

    // Add SSL credentials
    if (ssl_cert) {
      command += ` -c ${ssl_cert}`;
    }
    if (ssl_key) {
      command += ` -k ${ssl_key}`;
    }

    // Add origin
    command += ` -g ${origin}`;

    // Add mirrors
    if (mirrors && mirrors.length > 0) {
      for (const mirror of mirrors) {
        command += ` -m ${mirror}`;
      }
    }

    // Add search order options
    if (search_first) {
      command += ` --search-first`;
    } else if (search_before) {
      command += ` --search-before ${search_before}`;
    } else if (search_after) {
      command += ` --search-after ${search_after}`;
    }

    // Add sticky/non-sticky
    if (sticky === false) {
      command += ` --non-sticky`;
    }

    // Add properties
    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` --set-property ${key}=${value}`;
      }
    }

    // Add proxy
    if (proxy) {
      command += ` --proxy ${proxy}`;
    }

    // Add publisher name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      // If enabled is false, disable the publisher
      if (enabled === false) {
        const disableResult = await executeCommand(`pfexec pkg set-publisher --disable ${name}`);
        if (!disableResult.success) {
          log.task.warn('Publisher added but failed to disable', {
            name,
            error: disableResult.error,
          });
        }
      }

      return {
        success: true,
        message: `Repository '${name}' added successfully${enabled === false ? ' (disabled)' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to add repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository addition task failed: ${error.message}` };
  }
};

/**
 * Execute repository removal task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryRemoveTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name } = metadata;

    const command = `pfexec pkg unset-publisher ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' removed successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to remove repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository removal task failed: ${error.message}` };
  }
};

/**
 * Execute repository modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryModifyTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const {
      name,
      origins_to_add,
      origins_to_remove,
      mirrors_to_add,
      mirrors_to_remove,
      ssl_cert,
      ssl_key,
      enabled,
      sticky,
      search_first,
      search_before,
      search_after,
      properties_to_set,
      properties_to_unset,
      proxy,
      reset_uuid,
      refresh,
    } = metadata;

    let command = `pfexec pkg set-publisher`;

    // Add SSL credentials
    if (ssl_cert) {
      command += ` -c ${ssl_cert}`;
    }
    if (ssl_key) {
      command += ` -k ${ssl_key}`;
    }

    // Add origins
    if (origins_to_add && origins_to_add.length > 0) {
      for (const origin of origins_to_add) {
        command += ` -g ${origin}`;
      }
    }
    if (origins_to_remove && origins_to_remove.length > 0) {
      for (const origin of origins_to_remove) {
        command += ` -G ${origin}`;
      }
    }

    // Add mirrors
    if (mirrors_to_add && mirrors_to_add.length > 0) {
      for (const mirror of mirrors_to_add) {
        command += ` -m ${mirror}`;
      }
    }
    if (mirrors_to_remove && mirrors_to_remove.length > 0) {
      for (const mirror of mirrors_to_remove) {
        command += ` -M ${mirror}`;
      }
    }

    // Add enable/disable
    if (enabled === true) {
      command += ` --enable`;
    } else if (enabled === false) {
      command += ` --disable`;
    }

    // Add sticky/non-sticky
    if (sticky === true) {
      command += ` --sticky`;
    } else if (sticky === false) {
      command += ` --non-sticky`;
    }

    // Add search order options
    if (search_first) {
      command += ` --search-first`;
    } else if (search_before) {
      command += ` --search-before ${search_before}`;
    } else if (search_after) {
      command += ` --search-after ${search_after}`;
    }

    // Add properties to set
    if (properties_to_set && Object.keys(properties_to_set).length > 0) {
      for (const [key, value] of Object.entries(properties_to_set)) {
        command += ` --set-property ${key}=${value}`;
      }
    }

    // Add properties to unset
    if (properties_to_unset && properties_to_unset.length > 0) {
      for (const prop of properties_to_unset) {
        command += ` --unset-property ${prop}`;
      }
    }

    // Add proxy
    if (proxy) {
      command += ` --proxy ${proxy}`;
    }

    // Add reset UUID
    if (reset_uuid) {
      command += ` --reset-uuid`;
    }

    // Add refresh
    if (refresh) {
      command += ` --refresh`;
    }

    // Add publisher name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' modified successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to modify repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository modification task failed: ${error.message}` };
  }
};

/**
 * Execute repository enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryEnableTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name } = metadata;

    const command = `pfexec pkg set-publisher --enable ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' enabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to enable repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository enable task failed: ${error.message}` };
  }
};

/**
 * Execute repository disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryDisableTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { name } = metadata;

    const command = `pfexec pkg set-publisher --disable ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' disabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to disable repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository disable task failed: ${error.message}` };
  }
};

/**
 * Execute time sync configuration update task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUpdateTimeSyncConfigTask = async metadataJson => {
  log.task.debug('Time sync config update task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { service, config_content, backup_existing, restart_service } = metadata;

    log.task.debug('Time sync config update parameters', {
      service,
      backup_existing,
      restart_service,
      config_content_length: config_content ? config_content.length : 0,
    });

    // Determine config file path based on service
    let configFile;
    if (service === 'ntp') {
      configFile = '/etc/inet/ntp.conf';
    } else if (service === 'chrony') {
      configFile = '/etc/inet/chrony.conf';
    } else {
      return { success: false, error: `Unknown time sync service: ${service}` };
    }

    log.task.debug('Target config file', { configFile });

    // Create backup if existing config exists and backup is requested
    if (backup_existing) {
      const backupResult = await executeCommand(
        `test -f ${configFile} && pfexec cp ${configFile} ${configFile}.backup.$(date +%Y%m%d_%H%M%S) || echo "No existing config to backup"`
      );
      if (backupResult.success) {
        log.task.debug('Config backup created (if file existed)');
      } else {
        log.task.warn('Failed to create backup', {
          error: backupResult.error,
        });
      }
    }

    // Write new config content
    const writeResult = await executeCommand(
      `echo '${config_content.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`
    );

    if (!writeResult.success) {
      return {
        success: false,
        error: `Failed to write config file ${configFile}: ${writeResult.error}`,
      };
    }

    log.task.info('Config file written successfully', { configFile });

    // Restart service if requested
    if (restart_service) {
      log.task.debug('Restarting service', { service });
      const restartResult = await executeCommand(`pfexec svcadm restart network/${service}`);

      if (!restartResult.success) {
        return {
          success: true, // Config was written successfully
          message: `Time sync configuration updated successfully, but service restart failed: ${restartResult.error}`,
          warning: `Service ${service} restart failed - may need manual restart`,
        };
      }
      log.task.info('Service restarted successfully', { service });
    }

    return {
      success: true,
      message: `Time sync configuration updated successfully for ${service}${restart_service ? ' (service restarted)' : ''}`,
      config_file: configFile,
    };
  } catch (error) {
    log.task.error('Time sync config update task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Time sync config update task failed: ${error.message}` };
  }
};

/**
 * Execute force time synchronization task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeForceTimeSyncTask = async metadataJson => {
  log.task.debug('Force time sync task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { service, server, timeout } = metadata;

    log.task.debug('Force time sync parameters', {
      service,
      server: server || 'auto-detect',
      timeout,
    });

    let syncResult;

    if (service === 'ntp') {
      // For NTP, use ntpdig for immediate sync
      let command = `pfexec ntpdig`;
      if (timeout) {
        command += ` -t ${timeout}`;
      }
      if (server) {
        command += ` ${server}`;
      } else {
        command += ` pool.ntp.org`; // Default fallback server
      }

      log.task.debug('Executing NTP sync command', { command });
      syncResult = await executeCommand(command, (timeout || 30) * 1000);
    } else if (service === 'chrony') {
      // For Chrony, use chronyc to force sync
      log.task.debug('Executing Chrony makestep command');
      syncResult = await executeCommand(`pfexec chronyc makestep`, (timeout || 30) * 1000);

      if (!syncResult.success) {
        // Fallback to burst command
        log.task.debug('Makestep failed, trying burst command');
        syncResult = await executeCommand(`pfexec chronyc burst 5/10`, (timeout || 30) * 1000);
      }
    } else {
      return { success: false, error: `Cannot force sync - unknown service: ${service}` };
    }

    if (syncResult.success) {
      log.task.info('Time sync command completed successfully');

      // Get current system time for confirmation
      const timeResult = await executeCommand('date');
      const currentTime = timeResult.success ? timeResult.output : 'unknown';

      return {
        success: true,
        message: `Time synchronization completed successfully using ${service}${server ? ` (server: ${server})` : ''}`,
        current_time: currentTime,
        sync_output: syncResult.output,
      };
    }
    log.task.error('Time sync command failed', {
      error: syncResult.error,
    });
    return {
      success: false,
      error: `Time synchronization failed: ${syncResult.error}`,
    };
  } catch (error) {
    log.task.error('Force time sync task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Force time sync task failed: ${error.message}` };
  }
};

/**
 * Execute timezone setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSetTimezoneTask = async metadataJson => {
  log.task.debug('Set timezone task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { timezone, backup_existing } = metadata;

    log.task.debug('Set timezone parameters', {
      timezone,
      backup_existing,
    });

    const configFile = '/etc/default/init';

    // Validate timezone exists
    const zonePath = `/usr/share/lib/zoneinfo/${timezone}`;
    const validateResult = await executeCommand(`test -f ${zonePath}`);
    if (!validateResult.success) {
      return {
        success: false,
        error: `Invalid timezone: ${timezone} - timezone file not found at ${zonePath}`,
      };
    }

    log.task.debug('Timezone validated successfully');

    // Create backup if requested
    if (backup_existing) {
      const backupResult = await executeCommand(
        `pfexec cp ${configFile} ${configFile}.backup.$(date +%Y%m%d_%H%M%S)`
      );
      if (backupResult.success) {
        log.task.debug('Config backup created');
      } else {
        log.task.warn('Failed to create backup', {
          error: backupResult.error,
        });
      }
    }

    // Read current config
    const readResult = await executeCommand(`cat ${configFile}`);
    if (!readResult.success) {
      return {
        success: false,
        error: `Failed to read config file ${configFile}: ${readResult.error}`,
      };
    }

    // Update timezone in config
    let configContent = readResult.output;
    const tzPattern = /^TZ=.*$/m;

    if (tzPattern.test(configContent)) {
      // Replace existing TZ line
      configContent = configContent.replace(tzPattern, `TZ=${timezone}`);
      log.task.debug('Updated existing TZ line');
    } else {
      // Add TZ line
      configContent += `\nTZ=${timezone}\n`;
      log.task.debug('Added new TZ line');
    }

    // Write updated config
    const writeResult = await executeCommand(
      `echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`
    );

    if (!writeResult.success) {
      return {
        success: false,
        error: `Failed to write config file ${configFile}: ${writeResult.error}`,
      };
    }

    log.task.info('Timezone config written successfully', { configFile });

    // Set reboot required flag
    await setRebootRequired('timezone_change', 'TaskQueue');

    // Verify the change
    const verifyResult = await executeCommand(`grep "^TZ=" ${configFile}`);
    const verifiedTz = verifyResult.success ? verifyResult.output : 'unknown';

    return {
      success: true,
      message: `Timezone set to ${timezone} successfully (reboot required for full effect)`,
      config_file: configFile,
      verified_setting: verifiedTz,
      requires_reboot: true,
      reboot_reason: 'Timezone change in /etc/default/init requires system reboot to take effect',
    };
  } catch (error) {
    log.task.error('Set timezone task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Set timezone task failed: ${error.message}` };
  }
};

/**
 * Execute time sync system switching task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSwitchTimeSyncSystemTask = async metadataJson => {
  log.task.debug('Time sync system switch task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { current_system, target_system, preserve_servers, install_if_needed, systems_info } =
      metadata;

    log.task.debug('Time sync system switch parameters', {
      current_system,
      target_system,
      preserve_servers,
      install_if_needed,
    });

    let migratedServers = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'];

    // Step 1: Extract servers from current config if requested
    if (preserve_servers && current_system !== 'none') {
      log.task.debug('Attempting to extract servers from current configuration');
      const currentInfo = systems_info.available[current_system];
      if (currentInfo && currentInfo.config_file) {
        const readConfigResult = await executeCommand(
          `cat ${currentInfo.config_file} 2>/dev/null || echo ""`
        );
        if (readConfigResult.success && readConfigResult.output.trim()) {
          const extractedServers = extractServersFromConfig(
            readConfigResult.output,
            current_system
          );
          if (extractedServers.length > 0) {
            migratedServers = extractedServers;
            log.task.info('Extracted servers from current config', {
              servers: migratedServers,
            });
          }
        } else {
          log.task.warn('Could not read current config, using defaults');
        }
      }
    }

    // Step 2: Disable current service if active
    if (current_system !== 'none') {
      log.task.debug('Disabling current service', { service: current_system });
      const disableResult = await executeCommand(`pfexec svcadm disable network/${current_system}`);
      if (!disableResult.success) {
        log.task.warn('Failed to disable service', {
          service: current_system,
          error: disableResult.error,
        });
      } else {
        log.task.info('Current service disabled', { service: current_system });
      }
    }

    // Step 3: Handle target system installation and configuration
    if (target_system === 'none') {
      log.task.debug('Target is "none" - time sync will be disabled');
      return {
        success: true,
        message: `Switched from ${current_system} to none (time sync disabled)`,
        current_system: 'none',
        original_system: current_system,
      };
    }

    const targetInfo = systems_info.available[target_system];
    if (!targetInfo) {
      return { success: false, error: `Unknown target system: ${target_system}` };
    }

    // Step 4: Install target package if needed
    if (!targetInfo.installed && install_if_needed) {
      log.task.info('Installing package', {
        system: target_system,
        package: targetInfo.package_name,
      });
      const installResult = await executeCommand(
        `pfexec pkg install ${targetInfo.package_name}`,
        5 * 60 * 1000
      );
      if (!installResult.success) {
        // Rollback: re-enable original service
        if (current_system !== 'none') {
          log.task.warn('Installation failed, rolling back', {
            target: target_system,
            rollback_to: current_system,
          });
          await executeCommand(`pfexec svcadm enable network/${current_system}`);
        }
        return {
          success: false,
          error: `Failed to install ${targetInfo.package_name}: ${installResult.error}`,
          rollback_performed: current_system !== 'none',
        };
      }
      log.task.info('Package installed successfully', {
        package: targetInfo.package_name,
      });
    }

    // Step 5: Generate configuration for target system
    log.task.debug('Generating configuration', { system: target_system });
    let configContent;
    try {
      configContent = generateConfigForSystem(target_system, migratedServers);
      log.task.debug('Configuration generated successfully');
    } catch (configError) {
      // Rollback: re-enable original service
      if (current_system !== 'none') {
        log.task.warn('Config generation failed, rolling back', {
          target: target_system,
          rollback_to: current_system,
          error: configError.message,
        });
        await executeCommand(`pfexec svcadm enable network/${current_system}`);
      }
      return {
        success: false,
        error: `Failed to generate configuration: ${configError.message}`,
        rollback_performed: current_system !== 'none',
      };
    }

    // Step 6: Write target configuration
    const configFile = targetInfo.config_file;
    log.task.debug('Writing configuration', { configFile });
    const writeResult = await executeCommand(
      `echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`
    );

    if (!writeResult.success) {
      // Rollback: re-enable original service
      if (current_system !== 'none') {
        log.task.warn('Config write failed, rolling back', {
          target: target_system,
          rollback_to: current_system,
          error: writeResult.error,
        });
        await executeCommand(`pfexec svcadm enable network/${current_system}`);
      }
      return {
        success: false,
        error: `Failed to write config file ${configFile}: ${writeResult.error}`,
        rollback_performed: current_system !== 'none',
      };
    }
    log.task.info('Configuration written successfully', { configFile });

    // Step 7: Enable target service
    log.task.debug('Enabling service', { service: target_system });
    const enableResult = await executeCommand(`pfexec svcadm enable network/${target_system}`);

    if (!enableResult.success) {
      // Rollback: re-enable original service
      if (current_system !== 'none') {
        log.task.warn('Service enable failed, rolling back', {
          target: target_system,
          rollback_to: current_system,
          error: enableResult.error,
        });
        await executeCommand(`pfexec svcadm enable network/${current_system}`);
      }
      return {
        success: false,
        error: `Failed to enable ${target_system} service: ${enableResult.error}`,
        rollback_performed: current_system !== 'none',
      };
    }

    // Step 8: Verify service is running
    log.task.debug('Verifying service status', { service: target_system });
    let verifyAttempts = 0;
    let serviceOnline = false;

    while (verifyAttempts < 10 && !serviceOnline) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
      const statusResult = await executeCommand(`svcs network/${target_system}`);
      if (statusResult.success && statusResult.output.includes('online')) {
        serviceOnline = true;
        log.task.info('Service is online', { service: target_system });
      } else {
        verifyAttempts++;
        log.task.debug('Waiting for service to come online', {
          service: target_system,
          attempt: verifyAttempts,
          max_attempts: 10,
        });
      }
    }

    if (!serviceOnline) {
      log.task.warn('Service may not be fully online yet', {
        service: target_system,
      });
    }

    // Step 9: Verify time sync is working (basic check)
    log.task.debug('Performing basic sync verification');
    let syncWorking = false;
    if (target_system === 'ntp') {
      const ntpqResult = await executeCommand(`ntpq -p`, 10000);
      syncWorking = ntpqResult.success && ntpqResult.output.includes('remote');
    } else if (target_system === 'chrony') {
      const chronycResult = await executeCommand(`chronyc sources`, 10000);
      syncWorking = chronycResult.success && chronycResult.output.includes('Name/IP address');
    }

    const finalMessage = `Successfully switched from ${current_system} to ${target_system}`;
    const result = {
      success: true,
      message: finalMessage,
      current_system: target_system,
      original_system: current_system,
      servers_migrated: preserve_servers,
      migrated_servers: migratedServers,
      config_file: configFile,
      service_online: serviceOnline,
      sync_verification: syncWorking ? 'working' : 'unknown',
    };

    if (preserve_servers) {
      result.message += ` (${migratedServers.length} servers migrated)`;
    }

    if (!serviceOnline) {
      result.message += ' (service may need additional time to fully start)';
    }

    log.task.info('Time sync system switch completed', {
      from: current_system,
      to: target_system,
      servers_migrated: preserve_servers,
      service_online: serviceOnline,
      sync_working: syncWorking,
    });
    return result;
  } catch (error) {
    log.task.error('Time sync system switch task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Time sync system switch failed: ${error.message}` };
  }
};

// Helper function to extract servers from config (for migration)
const extractServersFromConfig = (configContent, systemType) => {
  const servers = [];
  const lines = configContent.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip commented lines
    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('!') ||
      trimmed.startsWith('%') ||
      trimmed.startsWith(';')
    ) {
      continue;
    }

    // Handle both 'server' and 'pool' directives
    if (
      (trimmed.startsWith('server ') || trimmed.startsWith('pool ')) &&
      !trimmed.includes('127.127.1.0') &&
      !trimmed.includes('127.0.0.1')
    ) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        servers.push(parts[1]);
      }
    }
  }

  // Return extracted servers or appropriate defaults based on system type
  if (servers.length > 0) {
    return servers;
  }

  // System-specific defaults
  switch (systemType) {
    case 'chrony':
      return ['0.omnios.pool.ntp.org'];
    case 'ntp':
    case 'ntpsec':
    default:
      return ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'];
  }
};

// Helper function to generate config for target system
const generateConfigForSystem = (targetSystem, servers) => {
  let baseConfig = '';

  switch (targetSystem) {
    case 'ntp':
      baseConfig = `# Generated by Zoneweaver API - System Switch
# NTP configuration for OmniOS

driftfile /var/ntp/ntp.drift

# Access restrictions
restrict default ignore
restrict -6 default ignore
restrict 127.0.0.1
restrict -6 ::1

# Time servers
${servers.map(server => `server ${server} iburst`).join('\n')}

# Allow updates from configured servers
${servers.map(server => `restrict ${server} nomodify noquery notrap`).join('\n')}
`;
      break;
    case 'chrony':
      baseConfig = `# Generated by Zoneweaver API - System Switch
# Chrony configuration for OmniOS

# Time servers
${servers.map(server => `server ${server} iburst`).join('\n')}

# Drift file location
driftfile /var/lib/chrony/drift

# Allow chronyd to make gradual corrections
makestep 1.0 3

# Enable RTC sync
rtcsync

# Log measurements
logdir /var/log/chrony
log measurements statistics tracking
`;
      break;
    case 'ntpsec':
      baseConfig = `# Generated by Zoneweaver API - System Switch
# NTPsec configuration for OmniOS

driftfile /var/lib/ntp/ntp.drift

# Access restrictions
restrict default kod limited nomodify nopeer noquery notrap
restrict -6 default kod limited nomodify nopeer noquery notrap
restrict 127.0.0.1
restrict -6 ::1

# Time servers
${servers.map(server => `server ${server} iburst`).join('\n')}

# Allow updates from configured servers
${servers.map(server => `restrict ${server} nomodify noquery notrap`).join('\n')}
`;
      break;
    default:
      throw new Error(`Unknown target system: ${targetSystem}`);
  }

  return baseConfig;
};

/**
 * Execute process trace task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeProcessTraceTask = async metadataJson => {
  log.task.debug('Process trace task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { pid, duration = 30 } = metadata;

    log.task.debug('Process trace task parameters', {
      pid,
      duration,
    });

    // Use truss (OmniOS equivalent of strace) to trace the process
    const command = `pfexec truss -p ${pid}`;
    log.task.debug('Executing trace command', { command });

    // Start tracing for the specified duration
    const traceResult = await executeCommand(command, duration * 1000);

    if (traceResult.success || traceResult.output) {
      // truss may exit with non-zero when the process ends, but still provide useful output
      const outputLength = traceResult.output ? traceResult.output.length : 0;
      log.task.info('Process trace completed', {
        pid,
        duration,
        output_length: outputLength,
      });

      return {
        success: true,
        message: `Process trace completed for PID ${pid} over ${duration} seconds (${outputLength} characters captured)`,
        trace_output: traceResult.output?.substring(0, 10000) || '', // Limit output size
        duration_seconds: duration,
        pid: parseInt(pid),
      };
    }
    log.task.error('Process trace command failed', {
      pid,
      error: traceResult.error,
    });
    return {
      success: false,
      error: `Failed to trace process ${pid}: ${traceResult.error}`,
    };
  } catch (error) {
    log.task.error('Process trace task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Process trace task failed: ${error.message}` };
  }
};

/**
 * Execute file move task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeFileMoveTask = async metadataJson => {
  log.filesystem.debug('File move task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { source, destination } = metadata;

    log.filesystem.debug('File move task parameters', {
      source,
      destination,
    });

    await moveItem(source, destination);

    log.filesystem.info('File move completed', {
      source,
      destination,
    });

    return {
      success: true,
      message: `Successfully moved '${source}' to '${destination}'`,
    };
  } catch (error) {
    log.filesystem.error('File move task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `File move task failed: ${error.message}` };
  }
};

/**
 * Execute file copy task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeFileCopyTask = async metadataJson => {
  log.filesystem.debug('File copy task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { source, destination } = metadata;

    log.filesystem.debug('File copy task parameters', {
      source,
      destination,
    });

    await copyItem(source, destination);

    log.filesystem.info('File copy completed', {
      source,
      destination,
    });

    return {
      success: true,
      message: `Successfully copied '${source}' to '${destination}'`,
    };
  } catch (error) {
    log.filesystem.error('File copy task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `File copy task failed: ${error.message}` };
  }
};

/**
 * Execute file archive creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeFileArchiveCreateTask = async metadataJson => {
  log.filesystem.debug('File archive create task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { sources, archive_path, format } = metadata;

    log.filesystem.debug('Archive creation task parameters', {
      sources,
      archive_path,
      format,
    });

    await createArchive(sources, archive_path, format);

    log.filesystem.info('Archive created successfully', {
      archive_path,
      format,
      source_count: sources.length,
    });

    return {
      success: true,
      message: `Successfully created ${format} archive '${archive_path}' with ${sources.length} items`,
    };
  } catch (error) {
    log.filesystem.error('Archive creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Archive creation task failed: ${error.message}` };
  }
};

/**
 * Execute file archive extraction task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeFileArchiveExtractTask = async metadataJson => {
  log.filesystem.debug('File archive extract task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
    const { archive_path, extract_path } = metadata;

    log.filesystem.debug('Archive extraction task parameters', {
      archive_path,
      extract_path,
    });

    await extractArchive(archive_path, extract_path);

    log.filesystem.info('Archive extracted successfully', {
      archive_path,
      extract_path,
    });

    return {
      success: true,
      message: `Successfully extracted archive '${archive_path}' to '${extract_path}'`,
    };
  } catch (error) {
    log.filesystem.error('Archive extraction task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Archive extraction task failed: ${error.message}` };
  }
};

/**
 * Execute user creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserCreateTask = async metadataJson => {
  log.task.debug('User creation task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      username,
      uid,
      gid,
      groups = [],
      comment,
      home_directory,
      shell = '/bin/bash',
      create_home = true,
      skeleton_dir,
      expire_date,
      inactive_days,
      authorizations = [],
      profiles = [],
      roles = [],
      project,
      create_personal_group = true,
      force_zfs = false,
      prevent_zfs = false,
    } = metadata;

    log.task.debug('User creation task parameters', {
      username,
      uid,
      gid,
      create_personal_group,
      has_rbac: authorizations.length > 0 || profiles.length > 0 || roles.length > 0,
    });

    let warnings = [];
    let createdGroup = null;

    // Step 1: Create personal group if requested and no gid specified
    if (create_personal_group && !gid) {
      log.task.debug('Creating personal group', { groupname: username });
      
      let groupCommand = `pfexec groupadd`;
      if (uid) {
        groupCommand += ` -g ${uid}`;
      }
      groupCommand += ` ${username}`;

      const groupResult = await executeCommand(groupCommand);
      
      if (groupResult.success) {
        createdGroup = username;
        log.task.info('Personal group created', { groupname: username, gid: uid });
      } else {
        // Check if it's just a warning about name length
        if (groupResult.error && groupResult.error.includes('name too long')) {
          warnings.push(`Group name '${username}' is longer than recommended but was created`);
          createdGroup = username;
        } else {
          log.task.warn('Failed to create personal group, continuing without it', {
            groupname: username,
            error: groupResult.error,
          });
          warnings.push(`Failed to create personal group '${username}': ${groupResult.error}`);
        }
      }
    }

    // Step 2: Build useradd command
    let command = `pfexec useradd`;

    // Add UID
    if (uid) {
      command += ` -u ${uid}`;
    }

    // Add primary group (personal group if created, or specified gid)
    if (createdGroup) {
      command += ` -g ${createdGroup}`;
    } else if (gid) {
      command += ` -g ${gid}`;
    }

    // Add supplementary groups
    if (groups && groups.length > 0) {
      command += ` -G ${groups.join(',')}`;
    }

    // Add comment
    if (comment) {
      command += ` -c "${comment}"`;
    }

    // Add home directory
    if (home_directory) {
      command += ` -d "${home_directory}"`;
    }

    // Add shell
    if (shell && shell !== '/bin/sh') {
      command += ` -s "${shell}"`;
    }

    // Add home directory creation with ZFS options
    if (create_home) {
      if (force_zfs) {
        command += ` -m -z`;
      } else if (prevent_zfs) {
        command += ` -m -Z`;
      } else {
        command += ` -m`; // Let system decide based on MANAGE_ZFS setting
      }

      // Add skeleton directory
      if (skeleton_dir) {
        command += ` -k "${skeleton_dir}"`;
      }
    }

    // Add expiration date
    if (expire_date) {
      command += ` -e "${expire_date}"`;
    }

    // Add inactive days
    if (inactive_days) {
      command += ` -f ${inactive_days}`;
    }

    // Add project
    if (project) {
      command += ` -p "${project}"`;
    }

    // Add RBAC authorizations
    if (authorizations && authorizations.length > 0) {
      command += ` -A "${authorizations.join(',')}"`;
    }

    // Add RBAC profiles
    if (profiles && profiles.length > 0) {
      command += ` -P "${profiles.join(',')}"`;
    }

    // Add RBAC roles
    if (roles && roles.length > 0) {
      command += ` -R "${roles.join(',')}"`;
    }

    // Add username
    command += ` ${username}`;

    log.task.debug('Executing user creation command', { command });

    // Execute user creation
    const result = await executeCommand(command);

    if (result.success || (result.stderr && result.stderr.includes('name too long') && !result.stderr.includes('ERROR:'))) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Username '${username}' is longer than traditional 8-character limit`);
      }

      log.task.info('User created successfully', {
        username,
        uid: uid || 'auto-assigned',
        personal_group_created: !!createdGroup,
        warnings: warnings.length,
      });

      const message = `User ${username} created successfully${createdGroup ? ` with personal group '${createdGroup}'` : ''}${warnings.length > 0 ? ' (with warnings)' : ''}`;

      return {
        success: true,
        message,
        warnings: warnings.length > 0 ? warnings : undefined,
        created_group: createdGroup,
        system_output: result.output,
      };
    } else {
      log.task.error('User creation command failed', {
        username,
        error: result.error,
        created_group: createdGroup,
      });

      // If we created a group but user creation failed, clean up the group
      if (createdGroup) {
        log.task.debug('Cleaning up created group due to user creation failure');
        await executeCommand(`pfexec groupdel ${createdGroup}`);
      }

      return {
        success: false,
        error: `Failed to create user ${username}: ${result.error}`,
        group_cleanup_performed: !!createdGroup,
      };
    }
  } catch (error) {
    log.task.error('User creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User creation task failed: ${error.message}` };
  }
};

/**
 * Execute user modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserModifyTask = async metadataJson => {
  log.task.debug('User modification task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      username,
      new_username,
      new_uid,
      new_gid,
      new_groups = [],
      new_comment,
      new_home_directory,
      move_home = false,
      new_shell,
      new_expire_date,
      new_inactive_days,
      new_authorizations = [],
      new_profiles = [],
      new_roles = [],
      new_project,
      force_zfs = false,
      prevent_zfs = false,
    } = metadata;

    log.task.debug('User modification task parameters', {
      username,
      new_username,
      new_uid,
      move_home,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0 || new_roles.length > 0,
    });

    // Build usermod command
    let command = `pfexec usermod`;

    // Add new UID
    if (new_uid) {
      command += ` -u ${new_uid}`;
    }

    // Add new primary group
    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    // Add new supplementary groups
    if (new_groups && new_groups.length > 0) {
      command += ` -G ${new_groups.join(',')}`;
    }

    // Add new comment
    if (new_comment !== undefined) {
      command += ` -c "${new_comment}"`;
    }

    // Add new home directory with move option
    if (new_home_directory) {
      command += ` -d "${new_home_directory}"`;
      
      if (move_home) {
        if (force_zfs) {
          command += ` -m -z`;
        } else if (prevent_zfs) {
          command += ` -m -Z`;
        } else {
          command += ` -m`;
        }
      }
    }

    // Add new shell
    if (new_shell) {
      command += ` -s "${new_shell}"`;
    }

    // Add new expiration date
    if (new_expire_date !== undefined) {
      command += ` -e "${new_expire_date}"`;
    }

    // Add new inactive days
    if (new_inactive_days !== undefined) {
      command += ` -f ${new_inactive_days}`;
    }

    // Add new project
    if (new_project) {
      command += ` -p "${new_project}"`;
    }

    // Add new RBAC authorizations
    if (new_authorizations && new_authorizations.length > 0) {
      command += ` -A "${new_authorizations.join(',')}"`;
    }

    // Add new RBAC profiles
    if (new_profiles && new_profiles.length > 0) {
      command += ` -P "${new_profiles.join(',')}"`;
    }

    // Add new RBAC roles
    if (new_roles && new_roles.length > 0) {
      command += ` -R "${new_roles.join(',')}"`;
    }

    // Add new username (must be last for usermod -l)
    if (new_username) {
      command += ` -l ${new_username}`;
    }

    // Add current username
    command += ` ${username}`;

    log.task.debug('Executing user modification command', { command });

    const result = await executeCommand(command);
    
    let warnings = [];
    if (result.success || (result.stderr && result.stderr.includes('name too long') && !result.stderr.includes('ERROR:'))) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Username '${new_username || username}' is longer than traditional 8-character limit`);
      }

      log.task.info('User modified successfully', {
        username,
        new_username: new_username || username,
        move_home,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `User ${username}${new_username ? ` renamed to ${new_username}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_username: new_username || username,
      };
    } else {
      log.task.error('User modification command failed', {
        username,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to modify user ${username}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('User modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User modification task failed: ${error.message}` };
  }
};

/**
 * Execute user deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserDeleteTask = async metadataJson => {
  log.task.debug('User deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username, remove_home = false, delete_personal_group = false } = metadata;

    log.task.debug('User deletion task parameters', {
      username,
      remove_home,
      delete_personal_group,
    });

    // Build userdel command
    let command = `pfexec userdel`;
    
    if (remove_home) {
      command += ` -r`;
    }
    
    command += ` ${username}`;

    log.task.debug('Executing user deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      let groupDeleted = false;
      
      // Step 2: Delete personal group if requested and it exists
      if (delete_personal_group) {
        log.task.debug('Attempting to delete personal group', { groupname: username });
        
        const groupDelResult = await executeCommand(`pfexec groupdel ${username}`);
        
        if (groupDelResult.success) {
          groupDeleted = true;
          log.task.info('Personal group deleted', { groupname: username });
        } else {
          log.task.debug('Personal group deletion failed (may not exist)', {
            groupname: username,
            error: groupDelResult.error,
          });
        }
      }

      log.task.info('User deleted successfully', {
        username,
        home_removed: remove_home,
        group_deleted: groupDeleted,
      });

      return {
        success: true,
        message: `User ${username} deleted successfully${remove_home ? ' (home directory removed)' : ''}${groupDeleted ? ` (personal group '${username}' also deleted)` : ''}`,
        home_removed: remove_home,
        group_deleted: groupDeleted,
      };
    } else {
      log.task.error('User deletion command failed', {
        username,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to delete user ${username}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('User deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User deletion task failed: ${error.message}` };
  }
};

/**
 * Execute group creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeGroupCreateTask = async metadataJson => {
  log.task.debug('Group creation task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { groupname, gid } = metadata;

    log.task.debug('Group creation task parameters', {
      groupname,
      gid,
    });

    // Build groupadd command
    let command = `pfexec groupadd`;

    if (gid) {
      command += ` -g ${gid}`;
    }

    command += ` ${groupname}`;

    log.task.debug('Executing group creation command', { command });

    const result = await executeCommand(command);

    let warnings = [];
    if (result.success || (result.stderr && result.stderr.includes('name too long') && !result.stderr.includes('ERROR:'))) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Group name '${groupname}' is longer than traditional limit`);
      }

      log.task.info('Group created successfully', {
        groupname,
        gid: gid || 'auto-assigned',
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Group ${groupname} created successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } else {
      log.task.error('Group creation command failed', {
        groupname,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to create group ${groupname}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Group creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Group creation task failed: ${error.message}` };
  }
};

/**
 * Execute group modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeGroupModifyTask = async metadataJson => {
  log.task.debug('Group modification task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { groupname, new_groupname, new_gid } = metadata;

    log.task.debug('Group modification task parameters', {
      groupname,
      new_groupname,
      new_gid,
    });

    // Build groupmod command
    let command = `pfexec groupmod`;

    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    if (new_groupname) {
      command += ` -n ${new_groupname}`;
    }

    command += ` ${groupname}`;

    log.task.debug('Executing group modification command', { command });

    const result = await executeCommand(command);

    let warnings = [];
    if (result.success || (result.stderr && result.stderr.includes('name too long') && !result.stderr.includes('ERROR:'))) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Group name '${new_groupname || groupname}' is longer than traditional limit`);
      }

      log.task.info('Group modified successfully', {
        groupname,
        new_groupname: new_groupname || groupname,
        new_gid,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Group ${groupname}${new_groupname ? ` renamed to ${new_groupname}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_groupname: new_groupname || groupname,
      };
    } else {
      log.task.error('Group modification command failed', {
        groupname,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to modify group ${groupname}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Group modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Group modification task failed: ${error.message}` };
  }
};

/**
 * Execute group deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeGroupDeleteTask = async metadataJson => {
  log.task.debug('Group deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { groupname } = metadata;

    log.task.debug('Group deletion task parameters', {
      groupname,
    });

    const command = `pfexec groupdel ${groupname}`;

    log.task.debug('Executing group deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Group deleted successfully', {
        groupname,
      });

      return {
        success: true,
        message: `Group ${groupname} deleted successfully`,
      };
    } else {
      log.task.error('Group deletion command failed', {
        groupname,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to delete group ${groupname}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Group deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Group deletion task failed: ${error.message}` };
  }
};

/**
 * Execute user password setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserSetPasswordTask = async metadataJson => {
  log.task.debug('User password setting task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username, password, force_change = false, unlock_account = true } = metadata;

    log.task.debug('User password setting task parameters', {
      username,
      force_change,
      unlock_account,
      password_length: password ? password.length : 0,
    });

    // Set password using passwd command with echo
    const command = `echo "${password}" | pfexec passwd --stdin ${username}`;
    log.task.debug('Executing password setting command', { 
      command: command.replace(password, '[REDACTED]') 
    });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Password set successfully', {
        username,
        force_change,
        unlock_account,
      });

      // Force password change on next login if requested
      if (force_change) {
        const expireResult = await executeCommand(`pfexec passwd -f ${username}`);
        if (!expireResult.success) {
          log.task.warn('Password set but failed to force change on next login', {
            username,
            error: expireResult.error,
          });
        }
      }

      // Unlock account if requested (passwords are typically set for locked accounts)
      if (unlock_account) {
        const unlockResult = await executeCommand(`pfexec passwd -u ${username}`);
        if (!unlockResult.success) {
          log.task.warn('Password set but failed to unlock account', {
            username,
            error: unlockResult.error,
          });
        }
      }

      return {
        success: true,
        message: `Password set successfully for user ${username}${force_change ? ' (must change on next login)' : ''}${unlock_account ? ' (account unlocked)' : ''}`,
        force_change,
        unlock_account,
      };
    } else {
      log.task.error('Password setting command failed', {
        username,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to set password for user ${username}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('User password setting task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User password setting task failed: ${error.message}` };
  }
};

/**
 * Execute user account lock task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserLockTask = async metadataJson => {
  log.task.debug('User account lock task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username } = metadata;

    log.task.debug('User account lock task parameters', {
      username,
    });

    const command = `pfexec passwd -l ${username}`;

    log.task.debug('Executing user account lock command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('User account locked successfully', {
        username,
      });

      return {
        success: true,
        message: `User account ${username} locked successfully`,
      };
    } else {
      log.task.error('User account lock command failed', {
        username,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to lock user account ${username}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('User account lock task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User account lock task failed: ${error.message}` };
  }
};

/**
 * Execute user account unlock task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserUnlockTask = async metadataJson => {
  log.task.debug('User account unlock task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { username } = metadata;

    log.task.debug('User account unlock task parameters', {
      username,
    });

    const command = `pfexec passwd -u ${username}`;

    log.task.debug('Executing user account unlock command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('User account unlocked successfully', {
        username,
      });

      return {
        success: true,
        message: `User account ${username} unlocked successfully`,
      };
    } else {
      log.task.error('User account unlock command failed', {
        username,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to unlock user account ${username}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('User account unlock task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User account unlock task failed: ${error.message}` };
  }
};

/**
 * Execute role creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRoleCreateTask = async metadataJson => {
  log.task.debug('Role creation task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      rolename,
      uid,
      gid,
      comment,
      home_directory,
      shell = '/bin/pfsh',
      create_home = false,
      authorizations = [],
      profiles = [],
      project,
    } = metadata;

    log.task.debug('Role creation task parameters', {
      rolename,
      uid,
      gid,
      create_home,
      has_rbac: authorizations.length > 0 || profiles.length > 0,
    });

    // Build roleadd command
    let command = `pfexec roleadd`;

    // Add UID
    if (uid) {
      command += ` -u ${uid}`;
    }

    // Add primary group
    if (gid) {
      command += ` -g ${gid}`;
    }

    // Add comment
    if (comment) {
      command += ` -c "${comment}"`;
    }

    // Add home directory
    if (home_directory) {
      command += ` -d "${home_directory}"`;
    }

    // Add shell (defaults to /bin/pfsh for roles)
    if (shell && shell !== '/bin/pfsh') {
      command += ` -s "${shell}"`;
    }

    // Add home directory creation
    if (create_home) {
      command += ` -m`;
    }

    // Add project
    if (project) {
      command += ` -p "${project}"`;
    }

    // Add RBAC authorizations
    if (authorizations && authorizations.length > 0) {
      command += ` -A "${authorizations.join(',')}"`;
    }

    // Add RBAC profiles
    if (profiles && profiles.length > 0) {
      command += ` -P "${profiles.join(',')}"`;
    }

    // Add role name
    command += ` ${rolename}`;

    log.task.debug('Executing role creation command', { command });

    const result = await executeCommand(command);

    let warnings = [];
    if (result.success || (result.stderr && result.stderr.includes('name too long') && !result.stderr.includes('ERROR:'))) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Role name '${rolename}' is longer than traditional 8-character limit`);
      }

      log.task.info('Role created successfully', {
        rolename,
        uid: uid || 'auto-assigned',
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Role ${rolename} created successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } else {
      log.task.error('Role creation command failed', {
        rolename,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to create role ${rolename}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Role creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role creation task failed: ${error.message}` };
  }
};

/**
 * Execute role modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRoleModifyTask = async metadataJson => {
  log.task.debug('Role modification task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      rolename,
      new_rolename,
      new_uid,
      new_gid,
      new_comment,
      new_authorizations = [],
      new_profiles = [],
    } = metadata;

    log.task.debug('Role modification task parameters', {
      rolename,
      new_rolename,
      new_uid,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0,
    });

    // Build rolemod command
    let command = `pfexec rolemod`;

    // Add new UID
    if (new_uid) {
      command += ` -u ${new_uid}`;
    }

    // Add new primary group
    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    // Add new comment
    if (new_comment !== undefined) {
      command += ` -c "${new_comment}"`;
    }

    // Add new RBAC authorizations
    if (new_authorizations && new_authorizations.length > 0) {
      command += ` -A "${new_authorizations.join(',')}"`;
    }

    // Add new RBAC profiles
    if (new_profiles && new_profiles.length > 0) {
      command += ` -P "${new_profiles.join(',')}"`;
    }

    // Add new role name (must be last for rolemod -l)
    if (new_rolename) {
      command += ` -l ${new_rolename}`;
    }

    // Add current role name
    command += ` ${rolename}`;

    log.task.debug('Executing role modification command', { command });

    const result = await executeCommand(command);
    
    let warnings = [];
    if (result.success || (result.stderr && result.stderr.includes('name too long') && !result.stderr.includes('ERROR:'))) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Role name '${new_rolename || rolename}' is longer than traditional 8-character limit`);
      }

      log.task.info('Role modified successfully', {
        rolename,
        new_rolename: new_rolename || rolename,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Role ${rolename}${new_rolename ? ` renamed to ${new_rolename}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_rolename: new_rolename || rolename,
      };
    } else {
      log.task.error('Role modification command failed', {
        rolename,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to modify role ${rolename}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Role modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role modification task failed: ${error.message}` };
  }
};

/**
 * Execute role deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRoleDeleteTask = async metadataJson => {
  log.task.debug('Role deletion task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { rolename, remove_home = false } = metadata;

    log.task.debug('Role deletion task parameters', {
      rolename,
      remove_home,
    });

    // Build roledel command
    let command = `pfexec roledel`;
    
    if (remove_home) {
      command += ` -r`;
    }
    
    command += ` ${rolename}`;

    log.task.debug('Executing role deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Role deleted successfully', {
        rolename,
        home_removed: remove_home,
      });

      return {
        success: true,
        message: `Role ${rolename} deleted successfully${remove_home ? ' (home directory removed)' : ''}`,
        home_removed: remove_home,
      };
    } else {
      log.task.error('Role deletion command failed', {
        rolename,
        error: result.error,
      });

      return {
        success: false,
        error: `Failed to delete role ${rolename}: ${result.error}`,
      };
    }
  } catch (error) {
    log.task.error('Role deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role deletion task failed: ${error.message}` };
  }
};

/**
 * Execute artifact download from URL task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactDownloadTask = async metadataJson => {
  log.task.debug('Artifact download task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { 
      url, 
      storage_location_id, 
      filename, 
      checksum, 
      checksum_algorithm = 'sha256',
      overwrite_existing = false 
    } = metadata;

    log.task.debug('Artifact download task parameters', {
      url,
      storage_location_id,
      filename,
      has_checksum: !!checksum,
      checksum_algorithm,
      overwrite_existing,
    });

    // Get storage location
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);
    
    if (!storageLocation || !storageLocation.enabled) {
      return {
        success: false,
        error: `Storage location not found or disabled: ${storage_location_id}`,
      };
    }

    // Determine filename from URL if not provided
    let finalFilename = filename;
    if (!finalFilename) {
      const urlPath = new URL(url).pathname;
      finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
    }

    const final_path = path.join(storageLocation.path, finalFilename);

    // Check if file already exists
    if (!overwrite_existing && fs.existsSync(final_path)) {
      return {
        success: false,
        error: `File already exists: ${finalFilename}. Use overwrite_existing=true to replace.`,
      };
    }

    log.task.info('Starting download', {
      url,
      destination: final_path,
      storage_location: storageLocation.name,
    });

    try {
      // Pre-create file with pfexec and set writable permissions (same pattern as uploads)
      log.task.debug('Pre-creating download file with pfexec', {
        final_path,
      });

      const createResult = await executeCommand(`pfexec touch "${final_path}"`);
      if (!createResult.success) {
        throw new Error(`Failed to pre-create file: ${createResult.error}`);
      }

      // Set permissions so service user can write to the file
      const chmodResult = await executeCommand(`pfexec chmod 666 "${final_path}"`);
      if (!chmodResult.success) {
        throw new Error(`Failed to set file permissions: ${chmodResult.error}`);
      }

      log.task.debug('File pre-created successfully with proper permissions');

      // Get artifact configuration for timeouts
      const artifactConfig = config.getArtifactStorage();
      const downloadTimeout = (artifactConfig.download?.timeout_seconds || 60) * 1000;
      
      // Use axios for native streaming performance (like browser downloads)
      const response = await axios({
        method: 'get',
        url: url,
        responseType: 'stream',
        timeout: downloadTimeout,
      });

      const contentLength = response.headers['content-length'];
      const fileSize = contentLength ? parseInt(contentLength) : null;

      log.task.info('Download response received', {
        status: response.status,
        content_length: fileSize ? `${Math.round(fileSize / 1024 / 1024)}MB` : 'unknown',
        content_type: response.headers['content-type'],
      });

      // Create file stream and track progress
      const fileStream = fs.createWriteStream(final_path);
      const startTime = Date.now();
      let downloadedBytes = 0;
      let lastProgressUpdate = 0;

      log.task.debug('Starting optimized axios stream download with progress tracking');

      // Track download progress via stream events (no checksum calculation)
      response.data.on('data', (chunk) => {
        downloadedBytes += chunk.length;
        
        // Update database at configurable interval
        const progressUpdateInterval = (artifactConfig.download?.progress_update_seconds || 10) * 1000;
        const now = Date.now();
        if (fileSize && (now - lastProgressUpdate) > progressUpdateInterval) {
          lastProgressUpdate = now;
          
          // Async database update - don't block the download stream
          setImmediate(async () => {
            try {
              const progress = ((downloadedBytes / fileSize) * 100);
              const speedMbps = (downloadedBytes / 1024 / 1024) / ((now - startTime) / 1000);
              const remainingBytes = fileSize - downloadedBytes;
              const etaSeconds = remainingBytes / (downloadedBytes / ((now - startTime) / 1000));
              
              const taskToUpdate = await Tasks.findOne({
                where: {
                  operation: 'artifact_download_url',
                  status: 'running',
                  metadata: { [Op.like]: `%${url.substring(0, 50)}%` }
                }
              });

              if (taskToUpdate) {
                await taskToUpdate.update({
                  progress_percent: Math.round(progress * 100) / 100,
                  progress_info: {
                    downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
                    total_mb: Math.round(fileSize / 1024 / 1024),
                    speed_mbps: Math.round(speedMbps * 100) / 100,
                    eta_seconds: isFinite(etaSeconds) ? Math.round(etaSeconds) : null,
                    status: 'downloading',
                  },
                });
              }
            } catch (progressError) {
              // Don't let progress updates block the download
              log.task.debug('Progress update failed', { error: progressError.message });
            }
          });
        }
      });

      // Pure native streaming - maximum performance
      response.data.pipe(fileStream);

      // Wait for completion
      await new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
        response.data.on('error', reject);
      });

      const downloadTime = Date.now() - startTime;

      log.task.info('Download completed - starting post-processing', {
        url,
        downloaded_bytes: downloadedBytes,
        downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
        duration_ms: downloadTime,
        speed_mbps: Math.round((downloadedBytes / 1024 / 1024) / (downloadTime / 1000) * 100) / 100,
      });

      // ALWAYS calculate checksum after download (but not during)
      log.task.debug('Calculating checksum post-download');
      
      const hash = crypto.createHash(checksum_algorithm);
      const readStream = fs.createReadStream(final_path); // Pure streaming - let Node.js optimize
      
      await new Promise((resolve, reject) => {
        readStream.on('data', chunk => hash.update(chunk));
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });
      
      const calculatedChecksum = hash.digest('hex');
      let checksumVerified = false;
      
      // Verify checksum if provided
      if (checksum) {
        checksumVerified = calculatedChecksum === checksum;
        
        if (!checksumVerified) {
          // Delete the invalid file
          await executeCommand(`pfexec rm -f "${final_path}"`);
          return {
            success: false,
            error: `Checksum verification failed. Expected: ${checksum}, Got: ${calculatedChecksum}`,
            expected_checksum: checksum,
            calculated_checksum: calculatedChecksum,
          };
        }
        log.task.info('Checksum verification passed');
      }

      // Create artifact database record
      const extension = path.extname(finalFilename).toLowerCase();
      const mimeType = getMimeType(final_path);
      
      // Validate extension is not empty (required field)
      if (!extension) {
        return {
          success: false,
          error: `File has no extension - cannot determine artifact type: ${finalFilename}`,
        };
      }
      
      try {
        await Artifact.create({
          storage_location_id: storageLocation.id, // Fix: use database UUID, not metadata value
          filename: finalFilename,
          path: final_path,
          size: downloadedBytes,
          file_type: storageLocation.type,
          extension,
          mime_type: mimeType,
          checksum: calculatedChecksum,
          checksum_algorithm,
          source_url: url,
          discovered_at: new Date(),
          last_verified: new Date(),
        });
      } catch (dbError) {
        log.task.error('Failed to create artifact database record', {
          storage_location_id: storageLocation.id,
          filename: finalFilename,
          path: final_path,
          size: downloadedBytes,
          file_type: storageLocation.type,
          extension,
          mime_type: mimeType,
          error: dbError.message,
          validation_errors: dbError.errors || null,
        });
        
        // Clean up downloaded file since database record failed
        await executeCommand(`pfexec rm -f "${final_path}"`);
        
        return {
          success: false,
          error: `Download completed but failed to create database record: ${dbError.message}`,
        };
      }

      // Update storage location stats
      await storageLocation.increment('file_count', { by: 1 });
      await storageLocation.increment('total_size', { by: downloadedBytes });
      await storageLocation.update({ last_scan_at: new Date() });

      return {
        success: true,
        message: `Successfully downloaded ${finalFilename} (${Math.round(downloadedBytes / 1024 / 1024)}MB)${checksumVerified ? ' with verified checksum' : ''}`,
        downloaded_bytes: downloadedBytes,
        checksum_verified: checksumVerified,
        checksum: calculatedChecksum,
        final_path: final_path,
        duration_ms: downloadTime,
      };

    } catch (downloadError) {
      throw downloadError;
    }

  } catch (error) {
    log.task.error('Artifact download task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Download failed: ${error.message}` };
  }
};

/**
 * Execute scan all artifact locations task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactScanAllTask = async metadataJson => {
  log.task.debug('Artifact scan all task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { verify_checksums = false, remove_orphaned = false, source = 'manual' } = metadata;

    log.task.debug('Scan all task parameters', {
      verify_checksums,
      remove_orphaned,
      source,
    });

    // Get all enabled storage locations
    const locations = await ArtifactStorageLocation.findAll({
      where: { enabled: true },
    });

    let totalScanned = 0;
    let totalAdded = 0;
    let totalRemoved = 0;
    let errors = [];

    for (const location of locations) {
      try {
        const scanResult = await scanStorageLocation(location, {
          verify_checksums,
          remove_orphaned,
        });

        totalScanned += scanResult.scanned;
        totalAdded += scanResult.added;
        totalRemoved += scanResult.removed;

        // Update location stats
        await location.update({
          last_scan_at: new Date(),
          scan_errors: 0,
          last_error_message: null,
        });

      } catch (locationError) {
        const errorMsg = `Failed to scan ${location.name}: ${locationError.message}`;
        errors.push(errorMsg);
        
        await location.update({
          scan_errors: location.scan_errors + 1,
          last_error_message: locationError.message,
        });

        log.task.warn('Storage location scan failed', {
          location_id: location.id,
          location_name: location.name,
          error: locationError.message,
        });
      }
    }

    if (errors.length > 0 && errors.length === locations.length) {
      // All locations failed
      return {
        success: false,
        error: `All ${locations.length} storage locations failed to scan`,
        errors,
      };
    }

    const successCount = locations.length - errors.length;
    let message = `Scan completed: ${totalScanned} files scanned, ${totalAdded} added, ${totalRemoved} removed across ${successCount}/${locations.length} locations`;

    if (errors.length > 0) {
      message += ` (${errors.length} locations had errors)`;
    }

    log.task.info('Artifact scan all completed', {
      locations_scanned: successCount,
      locations_failed: errors.length,
      total_scanned: totalScanned,
      total_added: totalAdded,
      total_removed: totalRemoved,
      source,
    });

    return {
      success: true,
      message,
      stats: {
        locations_scanned: successCount,
        locations_failed: errors.length,
        files_scanned: totalScanned,
        files_added: totalAdded,
        files_removed: totalRemoved,
      },
      errors: errors.length > 0 ? errors : undefined,
    };

  } catch (error) {
    log.task.error('Artifact scan all task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Scan all task failed: ${error.message}` };
  }
};

/**
 * Execute scan specific location task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactScanLocationTask = async metadataJson => {
  log.task.debug('Artifact scan location task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { 
      storage_location_id, 
      verify_checksums = false, 
      remove_orphaned = false 
    } = metadata;

    log.task.debug('Scan location task parameters', {
      storage_location_id,
      verify_checksums,
      remove_orphaned,
    });

    const location = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!location) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    const scanResult = await scanStorageLocation(location, {
      verify_checksums,
      remove_orphaned,
    });

    // Update location stats and status
    await location.update({
      last_scan_at: new Date(),
      scan_errors: 0,
      last_error_message: null,
    });

    log.task.info('Storage location scan completed', {
      location_id: location.id,
      location_name: location.name,
      files_scanned: scanResult.scanned,
      files_added: scanResult.added,
      files_removed: scanResult.removed,
    });

    return {
      success: true,
      message: `Scan completed for ${location.name}: ${scanResult.scanned} files scanned, ${scanResult.added} added, ${scanResult.removed} removed`,
      stats: scanResult,
      location: {
        id: location.id,
        name: location.name,
        path: location.path,
      },
    };

  } catch (error) {
    log.task.error('Artifact scan location task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Scan location task failed: ${error.message}` };
  }
};

/**
 * Execute artifact file deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactDeleteFileTask = async metadataJson => {
  log.task.debug('Artifact delete file task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { artifact_ids, delete_files = true, force = false } = metadata;

    log.task.debug('Delete file task parameters', {
      artifact_count: artifact_ids.length,
      delete_files,
      force,
    });

    const artifacts = await Artifact.findAll({
      where: { id: artifact_ids },
      include: [{ 
        model: ArtifactStorageLocation, 
        as: 'storage_location' 
      }],
    });

    if (artifacts.length === 0) {
      return {
        success: false,
        error: 'No artifacts found for the provided IDs',
      };
    }

    let filesDeleted = 0;
    let recordsRemoved = 0;
    let errors = [];

    for (const artifact of artifacts) {
      try {
        // Delete physical file if requested
        if (delete_files) {
          if (fs.existsSync(artifact.path)) {
            if (force) {
              await executeCommand(`pfexec rm -f "${artifact.path}"`);
            } else {
              await executeCommand(`pfexec rm "${artifact.path}"`);
            }
            filesDeleted++;
            log.task.debug('Deleted artifact file', {
              filename: artifact.filename,
              path: artifact.path,
            });
          } else {
            log.task.warn('Artifact file not found on disk', {
              filename: artifact.filename,
              path: artifact.path,
            });
          }
        }

        // Remove database record
        await artifact.destroy();
        recordsRemoved++;

        // Update storage location stats
        if (artifact.storage_location) {
          await artifact.storage_location.decrement('file_count', { by: 1 });
          await artifact.storage_location.decrement('total_size', { by: artifact.size });
        }

      } catch (deleteError) {
        const errorMsg = `Failed to delete ${artifact.filename}: ${deleteError.message}`;
        errors.push(errorMsg);
        log.task.warn('Artifact deletion failed', {
          artifact_id: artifact.id,
          filename: artifact.filename,
          error: deleteError.message,
        });
      }
    }

    if (errors.length > 0 && errors.length === artifacts.length) {
      return {
        success: false,
        error: `Failed to delete all ${artifacts.length} artifacts`,
        errors,
      };
    }

    const successCount = artifacts.length - errors.length;
    let message = `Successfully deleted ${successCount}/${artifacts.length} artifacts`;
    
    if (delete_files) {
      message += ` (${filesDeleted} files removed from disk)`;
    }
    
    if (errors.length > 0) {
      message += ` (${errors.length} had errors)`;
    }

    log.task.info('Artifact deletion completed', {
      total_artifacts: artifacts.length,
      successful_deletions: successCount,
      files_deleted: filesDeleted,
      records_removed: recordsRemoved,
      errors_count: errors.length,
    });

    return {
      success: true,
      message,
      stats: {
        total_artifacts: artifacts.length,
        successful_deletions: successCount,
        files_deleted: filesDeleted,
        records_removed: recordsRemoved,
      },
      errors: errors.length > 0 ? errors : undefined,
    };

  } catch (error) {
    log.task.error('Artifact delete file task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Delete file task failed: ${error.message}` };
  }
};

/**
 * Execute artifact folder deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactDeleteFolderTask = async metadataJson => {
  log.task.debug('Artifact delete folder task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { 
      storage_location_id, 
      recursive = true, 
      remove_db_records = true, 
      force = false 
    } = metadata;

    log.task.debug('Delete folder task parameters', {
      storage_location_id,
      recursive,
      remove_db_records,
      force,
    });

    const location = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!location) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    log.task.info('Starting folder deletion', {
      location_name: location.name,
      location_path: location.path,
      recursive,
      remove_db_records,
    });

    let removedFiles = 0;
    let removedRecords = 0;

    // Remove database records first if requested
    if (remove_db_records) {
      const artifacts = await Artifact.findAll({
        where: { storage_location_id: location.id },
      });

      removedRecords = artifacts.length;
      if (removedRecords > 0) {
        await Artifact.destroy({
          where: { storage_location_id: location.id },
        });
        log.task.info('Removed artifact database records', {
          count: removedRecords,
        });
      }
    }

    // Delete physical folder and contents
    let command = `pfexec rm`;
    
    if (recursive && force) {
      command += ` -rf`;
    } else if (recursive) {
      command += ` -r`;
    } else if (force) {
      command += ` -f`;
    }
    
    command += ` "${location.path}"/*`; // Delete contents, not the folder itself

    const result = await executeCommand(command);

    if (result.success || (force && result.error.includes('No such file'))) {
      // Count as success even if no files were found (empty directory)
      log.task.info('Folder contents deleted successfully');
      
      // Reset location stats
      await location.update({
        file_count: 0,
        total_size: 0,
        last_scan_at: new Date(),
        scan_errors: 0,
        last_error_message: null,
      });

      return {
        success: true,
        message: `Successfully deleted folder contents for ${location.name}${remove_db_records ? ` (${removedRecords} database records removed)` : ''}`,
        location: {
          name: location.name,
          path: location.path,
        },
        stats: {
          removed_records: removedRecords,
          folder_cleared: true,
        },
      };
    }

    return {
      success: false,
      error: `Failed to delete folder contents: ${result.error}`,
    };

  } catch (error) {
    log.task.error('Artifact delete folder task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Delete folder task failed: ${error.message}` };
  }
};

/**
 * Execute artifact upload processing task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactUploadProcessTask = async metadataJson => {
  log.task.debug('Artifact upload process task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      final_path,
      original_name,
      size,
      storage_location_id,
      checksum,
      checksum_algorithm = 'sha256',
    } = metadata;

    if (!final_path) {
      log.task.error('No final_path provided in metadata', {
        metadata_keys: Object.keys(metadata),
      });
      return {
        success: false,
        error: 'No final_path provided in task metadata - cannot process upload',
      };
    }

    log.task.debug('Upload process task parameters', {
      final_path,
      original_name,
      size,
      storage_location_id,
      has_checksum: !!checksum,
    });

    // Get storage location
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!storageLocation) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    // Calculate checksum with progress tracking
    log.task.debug('Calculating checksum');
    
    const taskToUpdate = await Tasks.findOne({
      where: {
        operation: 'artifact_upload_process',
        status: 'running',
        metadata: { [Op.like]: `%${original_name}%` }
      }
    });

    const hash = crypto.createHash(checksum_algorithm);
    const fileBuffer = await fs.promises.readFile(final_path);
    
    // Update progress for checksum calculation
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 50,
        progress_info: {
          status: 'calculating_checksum',
          file_size_mb: Math.round(size / 1024 / 1024),
        },
      });
    }

    hash.update(fileBuffer);
    const calculatedChecksum = hash.digest('hex');
    
    // Update progress after checksum
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 80,
        progress_info: {
          status: 'checksum_complete',
          checksum: calculatedChecksum.substring(0, 16) + '...',
        },
      });
    }

    log.task.debug('Checksum calculated', {
      algorithm: checksum_algorithm,
      checksum: calculatedChecksum.substring(0, 16) + '...',
    });

    // Scenario 1: User provided checksum - verify and fail if mismatch
    if (checksum) {
      if (calculatedChecksum !== checksum) {
        return {
          success: false,
          error: `Checksum verification failed. Expected: ${checksum}, Got: ${calculatedChecksum}`,
        };
      }
      log.task.info('Upload checksum verification passed');
    }

    // Scenario 2: Both scenarios - store the calculated checksum as the final value
    const extension = path.extname(original_name).toLowerCase();
    const mimeType = getMimeType(final_path);

    // Create artifact database record with single checksum field
    await Artifact.create({
      storage_location_id: storageLocation.id,
      filename: original_name,
      path: final_path,
      size: size,
      file_type: storageLocation.type,
      extension,
      mime_type: mimeType,
      checksum: calculatedChecksum,
      checksum_algorithm,
      source_url: null,
      discovered_at: new Date(),
      last_verified: new Date(),
    });

    // Update storage location stats
    await storageLocation.increment('file_count', { by: 1 });
    await storageLocation.increment('total_size', { by: size });
    await storageLocation.update({ last_scan_at: new Date() });

    // Final progress update
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 100,
        progress_info: {
          status: 'completed',
          final_path: final_path,
          checksum_verified: !!checksum,
        },
      });
    }

    log.task.info('Artifact upload processing completed', {
      filename: original_name,
      size_mb: Math.round(size / 1024 / 1024),
      storage_location: storageLocation.name,
      checksum_verified: !!checksum,
    });

    return {
      success: true,
      message: `Successfully processed upload for ${original_name} (${Math.round(size / 1024 / 1024)}MB)${checksum ? ' with verified checksum' : ''}`,
      artifact: {
        filename: original_name,
        size,
        final_path: final_path,
        checksum_verified: !!checksum,
        checksum: calculatedChecksum,
      },
    };

  } catch (error) {
    // No cleanup needed - file is already in final location
    log.task.error('Artifact upload process task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Upload processing failed: ${error.message}` };
  }
};

/**
 * Scan a storage location for artifacts
 * @param {Object} location - Storage location object
 * @param {Object} options - Scan options
 * @returns {Promise<{scanned: number, added: number, removed: number}>}
 */
const scanStorageLocation = async (location, options = {}) => {
  const { verify_checksums = false, remove_orphaned = false } = options;
  
  log.artifact.debug('Scanning storage location', {
    location_id: location.id,
    location_name: location.name,
    location_path: location.path,
    verify_checksums,
    remove_orphaned,
  });

  try {
    // Get supported extensions for this location type
    const artifactConfig = config.getArtifactStorage();
    const supportedExtensions = artifactConfig?.scanning?.supported_extensions?.[location.type] || [];

    // Get running download tasks to avoid race conditions
    const runningDownloadTasks = Array.from(runningTasks.values()).filter(task => 
      task.operation === 'artifact_download_url'
    );

    log.artifact.debug('Race condition protection: checking running tasks', {
      total_running_tasks: runningTasks.size,
      running_download_tasks: runningDownloadTasks.length,
      location_id: location.id,
      location_path: location.path,
      running_task_ids: runningDownloadTasks.map(t => t.id),
    });

    const downloadingPaths = new Set();
    for (const downloadTask of runningDownloadTasks) {
      log.artifact.debug('Race condition protection: processing download task', {
        task_id: downloadTask.id,
        operation: downloadTask.operation,
        metadata_length: downloadTask.metadata?.length,
      });

      try {
        const downloadMetadata = await new Promise((resolve, reject) => {
          yj.parseAsync(downloadTask.metadata, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        });
        
        const { storage_location_id, filename, url } = downloadMetadata;
        
        log.artifact.debug('Race condition protection: parsed download metadata', {
          task_id: downloadTask.id,
          download_storage_location_id: storage_location_id,
          scan_location_id: location.id,
          storage_location_match: storage_location_id === location.id,
          filename,
          url: url?.substring(0, 100),
        });
        
        // If download targets this storage location
        if (storage_location_id === location.id) {
          // Calculate target path same way download does
          let finalFilename = filename;
          if (!finalFilename) {
            const urlPath = new URL(url).pathname;
            finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
          }
          const targetPath = path.join(location.path, finalFilename);
          downloadingPaths.add(targetPath);
          
          log.artifact.debug('Race condition protection: added downloading path', {
            task_id: downloadTask.id,
            final_filename: finalFilename,
            target_path: targetPath,
            total_downloading_paths: downloadingPaths.size,
          });
        }
      } catch (parseError) {
        // Skip if can't parse metadata
        log.artifact.error('Race condition protection: failed to parse download task metadata', {
          task_id: downloadTask.id,
          error: parseError.message,
          metadata_preview: downloadTask.metadata?.substring(0, 200),
        });
        continue;
      }
    }

    if (downloadingPaths.size > 0) {
      log.artifact.info('Race condition protection: found active downloads to skip during scan', {
        active_downloads: downloadingPaths.size,
        downloading_paths: Array.from(downloadingPaths),
        location_name: location.name,
      });
    } else {
      log.artifact.debug('Race condition protection: no active downloads found for this location', {
        location_name: location.name,
        total_running_downloads: runningDownloadTasks.length,
      });
    }

    // List directory contents
    const items = await listDirectory(location.path);
    const files = items.filter(item => !item.isDirectory);

    // Filter files by supported extensions
    const artifactFiles = files.filter(file => 
      supportedExtensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))
    );

    log.artifact.debug('Found potential artifacts', {
      total_files: files.length,
      artifact_files: artifactFiles.length,
      supported_extensions: supportedExtensions,
    });

    // Get existing database records for this location
    const existingArtifacts = await Artifact.findAll({
      where: { storage_location_id: location.id },
    });

    const existingPaths = new Set(existingArtifacts.map(a => a.path));
    const currentPaths = new Set(artifactFiles.map(f => f.path));

    let scanned = 0;
    let added = 0;
    let removed = 0;
    let skipped = 0;

    // Add new artifacts (skip files being downloaded)
    for (const file of artifactFiles) {
      log.artifact.debug('Race condition protection: checking file against downloading paths', {
        file_path: file.path,
        downloading_paths_count: downloadingPaths.size,
        should_skip: downloadingPaths.has(file.path),
        downloading_paths: Array.from(downloadingPaths),
        file_exists_in_db: existingPaths.has(file.path),
      });

      // Skip files that are currently being downloaded to prevent race condition
      if (downloadingPaths.has(file.path)) {
        log.artifact.info('Race condition protection: skipping file being downloaded', {
          filename: file.name,
          path: file.path,
          location_name: location.name,
        });
        skipped++;
        continue;
      }

      if (!existingPaths.has(file.path)) {
        // New artifact found
        const extension = path.extname(file.name).toLowerCase();
        const mimeType = getMimeType(file.path);

        log.artifact.debug('Race condition protection: creating new artifact record', {
          filename: file.name,
          path: file.path,
          size: file.size,
          extension,
          location_name: location.name,
        });

        await Artifact.create({
          storage_location_id: location.id,
          filename: file.name,
          path: file.path,
          size: file.size || 0,
          file_type: location.type,
          extension,
          mime_type: mimeType,
          checksum: null,
          checksum_algorithm: null,
          source_url: null,
          discovered_at: new Date(),
          last_verified: new Date(),
        });

        added++;
        log.artifact.debug('Added new artifact', {
          filename: file.name,
          path: file.path,
          size: file.size,
        });
      } else {
        // Update last_verified for existing artifacts
        await Artifact.update(
          { last_verified: new Date() },
          { where: { path: file.path } }
        );
      }
      scanned++;
    }

    // Remove orphaned artifacts if requested
    if (remove_orphaned) {
      for (const existingArtifact of existingArtifacts) {
        if (!currentPaths.has(existingArtifact.path)) {
          await existingArtifact.destroy();
          removed++;
          log.artifact.debug('Removed orphaned artifact', {
            filename: existingArtifact.filename,
            path: existingArtifact.path,
          });
        }
      }
    }

    // Update storage location stats
    const totalFiles = await Artifact.count({
      where: { storage_location_id: location.id },
    });

    const totalSize = await Artifact.sum('size', {
      where: { storage_location_id: location.id },
    }) || 0;

    await location.update({
      file_count: totalFiles,
      total_size: totalSize,
    });

    log.artifact.info('Storage location scan completed', {
      location_name: location.name,
      scanned,
      added,
      removed,
      skipped,
      total_files: totalFiles,
    });

    return { scanned, added, removed };

  } catch (error) {
    log.artifact.error('Storage location scan failed', {
      location_id: location.id,
      location_name: location.name,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

/**
 * Clean up old tasks based on retention policies
 * @description Removes completed, failed, and cancelled tasks older than the configured retention period
 */
export const cleanupOldTasks = async () => {
  const timer = createTimer('cleanup old tasks');
  try {
    const hostMonitoringConfig = config.getHostMonitoring();
    const retentionConfig = hostMonitoringConfig.retention;
    const now = new Date();

    // Clean up completed, failed, and cancelled tasks
    const tasksRetentionDate = new Date(
      now.getTime() - retentionConfig.tasks * 24 * 60 * 60 * 1000
    );
    const deletedTasks = await Tasks.destroy({
      where: {
        status: { [Op.in]: ['completed', 'failed', 'cancelled'] },
        created_at: { [Op.lt]: tasksRetentionDate },
      },
    });

    const duration = timer.end();

    if (deletedTasks > 0) {
      log.database.info('Tasks cleanup completed', {
        deleted_count: deletedTasks,
        retention_days: retentionConfig.tasks,
        duration_ms: duration,
      });
    }
  } catch (error) {
    timer.end();
    log.database.error('Failed to cleanup old tasks', {
      error: error.message,
      stack: error.stack,
    });
  }
};
