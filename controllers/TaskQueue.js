import { executeSetHostnameTask } from './TaskManager/SystemManager.js';
import {
  executeCreateIPAddressTask,
  executeDeleteIPAddressTask,
  executeEnableIPAddressTask,
  executeDisableIPAddressTask,
} from './TaskManager/NetworkManager.js';
import {
  executeStartTask,
  executeStopTask,
  executeRestartTask,
  executeDeleteTask,
  executeDiscoverTask,
} from './TaskManager/ZoneManager.js';
import {
  executeCreateVNICTask,
  executeDeleteVNICTask,
  executeSetVNICPropertiesTask,
} from './TaskManager/VNICManager.js';
import {
  executeCreateAggregateTask,
  executeDeleteAggregateTask,
  executeModifyAggregateLinksTask,
} from './TaskManager/AggregateManager.js';
import {
  executeCreateEtherstubTask,
  executeDeleteEtherstubTask,
} from './TaskManager/EtherstubManager.js';
import { executeCreateVlanTask, executeDeleteVlanTask } from './TaskManager/VLANManager.js';
import {
  executeCreateBridgeTask,
  executeDeleteBridgeTask,
  executeModifyBridgeLinksTask,
} from './TaskManager/BridgeManager.js';
import {
  executePkgInstallTask,
  executePkgUninstallTask,
  executePkgUpdateTask,
  executePkgRefreshTask,
} from './TaskManager/PackageManager.js';
import {
  executeRepositoryAddTask,
  executeRepositoryRemoveTask,
  executeRepositoryModifyTask,
  executeRepositoryEnableTask,
  executeRepositoryDisableTask,
} from './TaskManager/RepositoryManager.js';
import {
  executeBeadmCreateTask,
  executeBeadmDeleteTask,
  executeBeadmActivateTask,
  executeBeadmMountTask,
  executeBeadmUnmountTask,
} from './TaskManager/BootManager.js';
import {
  executeUpdateTimeSyncConfigTask,
  executeForceTimeSyncTask,
  executeSetTimezoneTask,
  executeSwitchTimeSyncSystemTask,
} from './TaskManager/TimeManager.js';
import { executeProcessTraceTask } from './TaskManager/ProcessManager.js';
import {
  executeFileMoveTask,
  executeFileCopyTask,
  executeFileArchiveCreateTask,
  executeFileArchiveExtractTask,
} from './TaskManager/FileManager.js';
import {
  executeUserCreateTask,
  executeUserModifyTask,
  executeUserDeleteTask,
  executeUserSetPasswordTask,
  executeUserLockTask,
  executeUserUnlockTask,
} from './TaskManager/UserManager.js';
import {
  executeGroupCreateTask,
  executeGroupModifyTask,
  executeGroupDeleteTask,
} from './TaskManager/GroupManager.js';
import {
  executeRoleCreateTask,
  executeRoleModifyTask,
  executeRoleDeleteTask,
} from './TaskManager/RoleManager.js';
import {
  executeArtifactDownloadTask,
  executeArtifactScanAllTask,
  executeArtifactScanLocationTask,
  executeArtifactDeleteFileTask,
  executeArtifactDeleteFolderTask,
  executeArtifactUploadProcessTask,
} from './TaskManager/ArtifactManager/index.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import { Op } from 'sequelize';
import config from '../config/ConfigLoader.js';
import {
  enableService,
  disableService,
  restartService,
  refreshService,
} from '../lib/ServiceManager.js';
import { log, createTimer } from '../lib/Logger.js';

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
 */
const OPERATION_CATEGORIES = {
  // Package management operations
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

  // Network datalink operations
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

  // Network IP operations
  create_ip_address: 'network_ip',
  delete_ip_address: 'network_ip',
  enable_ip_address: 'network_ip',
  disable_ip_address: 'network_ip',

  // System operations
  set_hostname: 'system_config',
  update_time_sync_config: 'system_config',
  force_time_sync: 'system_config',
  set_timezone: 'system_config',

  // User management operations
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
 * Execute zone-related tasks
 * @param {string} operation - Operation type
 * @param {string} zoneName - Zone name
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeZoneTask = (operation, zoneName) => {
  switch (operation) {
    case 'start':
      return executeStartTask(zoneName);
    case 'stop':
      return executeStopTask(zoneName);
    case 'restart':
      return executeRestartTask(zoneName);
    case 'delete':
      return executeDeleteTask(zoneName);
    case 'discover':
      return executeDiscoverTask();
    default:
      return { success: false, error: `Unknown zone operation: ${operation}` };
  }
};

/**
 * Execute service-related tasks
 * @param {string} operation - Operation type
 * @param {string} zoneName - Zone name
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeServiceTask = (operation, zoneName) => {
  switch (operation) {
    case 'service_enable':
      return enableService(zoneName);
    case 'service_disable':
      return disableService(zoneName);
    case 'service_restart':
      return restartService(zoneName);
    case 'service_refresh':
      return refreshService(zoneName);
    default:
      return { success: false, error: `Unknown service operation: ${operation}` };
  }
};

/**
 * Execute system-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSystemTask = (operation, metadata) => {
  switch (operation) {
    case 'set_hostname':
      return executeSetHostnameTask(metadata);
    case 'update_time_sync_config':
      return executeUpdateTimeSyncConfigTask(metadata);
    case 'force_time_sync':
      return executeForceTimeSyncTask(metadata);
    case 'set_timezone':
      return executeSetTimezoneTask(metadata);
    case 'switch_time_sync_system':
      return executeSwitchTimeSyncSystemTask(metadata);
    default:
      return { success: false, error: `Unknown system operation: ${operation}` };
  }
};

/**
 * Execute network-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeNetworkTask = (operation, metadata) => {
  switch (operation) {
    case 'create_ip_address':
      return executeCreateIPAddressTask(metadata);
    case 'delete_ip_address':
      return executeDeleteIPAddressTask(metadata);
    case 'enable_ip_address':
      return executeEnableIPAddressTask(metadata);
    case 'disable_ip_address':
      return executeDisableIPAddressTask(metadata);
    case 'create_vnic':
      return executeCreateVNICTask(metadata);
    case 'delete_vnic':
      return executeDeleteVNICTask(metadata);
    case 'set_vnic_properties':
      return executeSetVNICPropertiesTask(metadata);
    case 'create_aggregate':
      return executeCreateAggregateTask(metadata);
    case 'delete_aggregate':
      return executeDeleteAggregateTask(metadata);
    case 'modify_aggregate_links':
      return executeModifyAggregateLinksTask(metadata);
    case 'create_etherstub':
      return executeCreateEtherstubTask(metadata);
    case 'delete_etherstub':
      return executeDeleteEtherstubTask(metadata);
    case 'create_vlan':
      return executeCreateVlanTask(metadata);
    case 'delete_vlan':
      return executeDeleteVlanTask(metadata);
    case 'create_bridge':
      return executeCreateBridgeTask(metadata);
    case 'delete_bridge':
      return executeDeleteBridgeTask(metadata);
    case 'modify_bridge_links':
      return executeModifyBridgeLinksTask(metadata);
    default:
      return { success: false, error: `Unknown network operation: ${operation}` };
  }
};

/**
 * Execute package-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePackageTask = (operation, metadata) => {
  switch (operation) {
    case 'pkg_install':
      return executePkgInstallTask(metadata);
    case 'pkg_uninstall':
      return executePkgUninstallTask(metadata);
    case 'pkg_update':
      return executePkgUpdateTask(metadata);
    case 'pkg_refresh':
      return executePkgRefreshTask(metadata);
    case 'beadm_create':
      return executeBeadmCreateTask(metadata);
    case 'beadm_delete':
      return executeBeadmDeleteTask(metadata);
    case 'beadm_activate':
      return executeBeadmActivateTask(metadata);
    case 'beadm_mount':
      return executeBeadmMountTask(metadata);
    case 'beadm_unmount':
      return executeBeadmUnmountTask(metadata);
    case 'repository_add':
      return executeRepositoryAddTask(metadata);
    case 'repository_remove':
      return executeRepositoryRemoveTask(metadata);
    case 'repository_modify':
      return executeRepositoryModifyTask(metadata);
    case 'repository_enable':
      return executeRepositoryEnableTask(metadata);
    case 'repository_disable':
      return executeRepositoryDisableTask(metadata);
    default:
      return { success: false, error: `Unknown package operation: ${operation}` };
  }
};

/**
 * Execute user management tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUserTask = (operation, metadata) => {
  switch (operation) {
    case 'user_create':
      return executeUserCreateTask(metadata);
    case 'user_modify':
      return executeUserModifyTask(metadata);
    case 'user_delete':
      return executeUserDeleteTask(metadata);
    case 'user_set_password':
      return executeUserSetPasswordTask(metadata);
    case 'user_lock':
      return executeUserLockTask(metadata);
    case 'user_unlock':
      return executeUserUnlockTask(metadata);
    case 'group_create':
      return executeGroupCreateTask(metadata);
    case 'group_modify':
      return executeGroupModifyTask(metadata);
    case 'group_delete':
      return executeGroupDeleteTask(metadata);
    case 'role_create':
      return executeRoleCreateTask(metadata);
    case 'role_modify':
      return executeRoleModifyTask(metadata);
    case 'role_delete':
      return executeRoleDeleteTask(metadata);
    default:
      return { success: false, error: `Unknown user operation: ${operation}` };
  }
};

/**
 * Execute file-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeFileTask = (operation, metadata) => {
  switch (operation) {
    case 'file_move':
      return executeFileMoveTask(metadata);
    case 'file_copy':
      return executeFileCopyTask(metadata);
    case 'file_archive_create':
      return executeFileArchiveCreateTask(metadata);
    case 'file_archive_extract':
      return executeFileArchiveExtractTask(metadata);
    default:
      return { success: false, error: `Unknown file operation: ${operation}` };
  }
};

/**
 * Execute artifact-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeArtifactTask = (operation, metadata) => {
  switch (operation) {
    case 'artifact_download_url':
      return executeArtifactDownloadTask(metadata);
    case 'artifact_scan_all':
      return executeArtifactScanAllTask(metadata);
    case 'artifact_scan_location':
      return executeArtifactScanLocationTask(metadata);
    case 'artifact_delete_file':
      return executeArtifactDeleteFileTask(metadata);
    case 'artifact_delete_folder':
      return executeArtifactDeleteFolderTask(metadata);
    case 'artifact_upload_process':
      return executeArtifactUploadProcessTask(metadata);
    default:
      return { success: false, error: `Unknown artifact operation: ${operation}` };
  }
};
/**
 * Execute a specific task
 * @param {Object} task - Task object from database
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeTask = async task => {
  const { operation, zone_name } = task;

  try {
    // Zone operations
    if (['start', 'stop', 'restart', 'delete', 'discover'].includes(operation)) {
      return await executeZoneTask(operation, zone_name);
    }

    // Service operations
    if (operation.startsWith('service_')) {
      return await executeServiceTask(operation, zone_name);
    }

    // System operations
    if (
      [
        'set_hostname',
        'update_time_sync_config',
        'force_time_sync',
        'set_timezone',
        'switch_time_sync_system',
      ].includes(operation)
    ) {
      return await executeSystemTask(operation, task.metadata);
    }

    // Network operations
    if (
      [
        'create_ip_address',
        'delete_ip_address',
        'enable_ip_address',
        'disable_ip_address',
        'create_vnic',
        'delete_vnic',
        'set_vnic_properties',
        'create_aggregate',
        'delete_aggregate',
        'modify_aggregate_links',
        'create_etherstub',
        'delete_etherstub',
        'create_vlan',
        'delete_vlan',
        'create_bridge',
        'delete_bridge',
        'modify_bridge_links',
      ].includes(operation)
    ) {
      return await executeNetworkTask(operation, task.metadata);
    }

    // Package operations
    if (
      [
        'pkg_install',
        'pkg_uninstall',
        'pkg_update',
        'pkg_refresh',
        'beadm_create',
        'beadm_delete',
        'beadm_activate',
        'beadm_mount',
        'beadm_unmount',
        'repository_add',
        'repository_remove',
        'repository_modify',
        'repository_enable',
        'repository_disable',
      ].includes(operation)
    ) {
      return await executePackageTask(operation, task.metadata);
    }

    // User management operations
    if (
      [
        'user_create',
        'user_modify',
        'user_delete',
        'user_set_password',
        'user_lock',
        'user_unlock',
        'group_create',
        'group_modify',
        'group_delete',
        'role_create',
        'role_modify',
        'role_delete',
      ].includes(operation)
    ) {
      return await executeUserTask(operation, task.metadata);
    }

    // File operations
    if (operation.startsWith('file_')) {
      return await executeFileTask(operation, task.metadata);
    }

    // Artifact operations
    if (operation.startsWith('artifact_')) {
      return await executeArtifactTask(operation, task.metadata);
    }

    // Process operations
    if (operation === 'process_trace') {
      return await executeProcessTraceTask(task.metadata);
    }

    return { success: false, error: `Unknown operation: ${operation}` };
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
    const {
      limit = defaultLimit,
      status,
      zone_name,
      operation,
      operation_ne,
      since,
      include_count,
    } = req.query;
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
      // Fix: Use updatedAt instead of created_at for incremental updates
      whereClause.updatedAt = { [Op.gte]: new Date(since) };
    }

    const tasks = await Tasks.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
      limit: parseInt(limit),
    });

    // Only run expensive count query if explicitly requested
    const response = {
      tasks,
      running_count: runningTasks.size,
    };

    // Add total count only if requested (for performance)
    if (include_count === 'true') {
      const total = await Tasks.count({ where: whereClause });
      response.total = total;
    }

    res.json(response);
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

    return res.json(task);
  } catch (error) {
    log.database.error('Database error getting task details', {
      error: error.message,
      stack: error.stack,
      task_id: req.params.taskId,
    });
    return res.status(500).json({ error: 'Failed to retrieve task details' });
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

    return res.json({
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
    return res.status(500).json({ error: 'Failed to cancel task' });
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
