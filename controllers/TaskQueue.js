import { execSync, spawn } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import Zones from "../models/ZoneModel.js";
import VncSessions from "../models/VncSessionModel.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import NetworkUsage from "../models/NetworkUsageModel.js";
import IPAddresses from "../models/IPAddressModel.js";
import yj from "yieldable-json";
import { Op } from "sequelize";
import os from "os";
import config from "../config/ConfigLoader.js";
import {
    enableService,
    disableService,
    restartService,
    refreshService
} from "../lib/ServiceManager.js";

/**
 * @fileoverview Task Queue controller for Zoneweaver API
 * @description Manages task execution, prioritization, and conflict resolution for zone operations
 */

/**
 * Operation categories for conflict detection
 * Operations in the same category cannot run simultaneously
 */
const OPERATION_CATEGORIES = {
    // Package management operations (conflict with each other)
    'pkg_install': 'package_management',
    'pkg_uninstall': 'package_management',
    'pkg_update': 'package_management',
    'pkg_refresh': 'package_management',
    'beadm_create': 'package_management',
    'beadm_delete': 'package_management',
    'beadm_activate': 'package_management',
    'beadm_mount': 'package_management',
    'beadm_unmount': 'package_management',
    'repository_add': 'package_management',
    'repository_remove': 'package_management',
    'repository_modify': 'package_management',
    'repository_enable': 'package_management',
    'repository_disable': 'package_management',
    
    // Network datalink operations (may conflict with each other)
    'create_vnic': 'network_datalink',
    'delete_vnic': 'network_datalink',
    'set_vnic_properties': 'network_datalink',
    'create_aggregate': 'network_datalink',
    'delete_aggregate': 'network_datalink',
    'modify_aggregate_links': 'network_datalink',
    'create_etherstub': 'network_datalink',
    'delete_etherstub': 'network_datalink',
    'create_vlan': 'network_datalink',
    'delete_vlan': 'network_datalink',
    'create_bridge': 'network_datalink',
    'delete_bridge': 'network_datalink',
    'modify_bridge_links': 'network_datalink',
    
    // Network IP operations (may conflict with each other)
    'create_ip_address': 'network_ip',
    'delete_ip_address': 'network_ip',
    'enable_ip_address': 'network_ip',
    'disable_ip_address': 'network_ip',
    
    // System operations (serialized)
    'set_hostname': 'system_config',
    'update_time_sync_config': 'system_config',
    'force_time_sync': 'system_config', 
    'set_timezone': 'system_config',
    
    // Zone operations (safe to run concurrently - no category)
    // start, stop, restart, delete, discover - no category = no conflicts
    
    // Service operations (safe to run concurrently - no category)
    // service_enable, service_disable, service_restart, service_refresh - no category = no conflicts
};

/**
 * Task execution queue - in-memory tracking of running tasks
 */
let runningTasks = new Map();
let taskProcessor = null;

/**
 * Discovery interval ID for periodic zone discovery
 */
let discoveryProcessor = null;

/**
 * Track running operation categories to prevent conflicts
 */
let runningCategories = new Set();

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
    return new Promise((resolve) => {
        console.log(`🔧 Executing command: ${command}`);
        
        const child = spawn('sh', ['-c', command], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        let completed = false;
        
        // Set up timeout
        const timeoutId = setTimeout(() => {
            if (!completed) {
                completed = true;
                child.kill('SIGTERM');
                console.error(`Command timed out: ${command}`);
                resolve({
                    success: false,
                    error: `Command timed out after ${timeout}ms`,
                    output: stdout
                });
            }
        }, timeout);
        
        // Collect output
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });
        
        // Handle completion
        child.on('close', (code) => {
            if (!completed) {
                completed = true;
                clearTimeout(timeoutId);
                
                if (code === 0) {
                    resolve({
                        success: true,
                        output: stdout.trim()
                    });
                } else {
                    console.error(`Command failed: ${command}`, stderr.trim());
                    resolve({
                        success: false,
                        error: stderr.trim() || `Command exited with code ${code}`,
                        output: stdout.trim()
                    });
                }
            }
        });
        
        // Handle errors
        child.on('error', (error) => {
            if (!completed) {
                completed = true;
                clearTimeout(timeoutId);
                console.error(`Command error: ${command}`, error.message);
                resolve({
                    success: false,
                    error: error.message,
                    output: stdout
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
const executeTask = async (task) => {
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
            default:
                return { success: false, error: `Unknown operation: ${operation}` };
        }
    } catch (error) {
        console.error(`Task execution failed for ${operation} on ${zone_name}:`, error);
        return { success: false, error: error.message };
    }
};

/**
 * Execute zone start task
 * @param {string} zoneName - Name of zone to start
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeStartTask = async (zoneName) => {
    const result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);
    
    if (result.success) {
        // Update zone status in database
        await Zones.update(
            { 
                status: 'running',
                last_seen: new Date(),
                is_orphaned: false
            },
            { where: { name: zoneName } }
        );
        
        return { 
            success: true, 
            message: `Zone ${zoneName} started successfully` 
        };
    } else {
        return { 
            success: false, 
            error: `Failed to start zone ${zoneName}: ${result.error}` 
        };
    }
};

/**
 * Execute zone stop task
 * @param {string} zoneName - Name of zone to stop
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeStopTask = async (zoneName) => {
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
                last_seen: new Date()
            },
            { where: { name: zoneName } }
        );
        
        // Terminate any active VNC sessions for this zone
        await terminateVncSession(zoneName);
        
        return { 
            success: true, 
            message: `Zone ${zoneName} stopped successfully` 
        };
    } else {
        return { 
            success: false, 
            error: `Failed to stop zone ${zoneName}: ${result.error}` 
        };
    }
};

/**
 * Execute zone restart task
 * @param {string} zoneName - Name of zone to restart
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRestartTask = async (zoneName) => {
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
const executeDeleteTask = async (zoneName) => {
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
                error: `Failed to uninstall zone ${zoneName}: ${uninstallResult.error}` 
            };
        }
        
        // Delete zone configuration
        const deleteResult = await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);
        
        if (!deleteResult.success) {
            return { 
                success: false, 
                error: `Failed to delete zone configuration ${zoneName}: ${deleteResult.error}` 
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
                    status: 'pending'
                } 
            }
        );
        
        return { 
            success: true, 
            message: `Zone ${zoneName} deleted successfully` 
        };
        
    } catch (error) {
        return { 
            success: false, 
            error: `Failed to delete zone ${zoneName}: ${error.message}` 
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
                if (err) reject(err);
                else resolve(result);
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
                    status: status,
                    brand: zoneConfig.brand || 'unknown',
                    auto_discovered: true,
                    last_seen: new Date()
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
                let status = dbZone.status;
                if (statusResult.success) {
                    const parts = statusResult.output.split(':');
                    status = parts[2] || dbZone.status;
                }
                
                await dbZone.update({
                    status: status,
                    brand: zoneConfig.brand || dbZone.brand,
                    last_seen: new Date(),
                    is_orphaned: false
                });
            }
        }
        
        return { 
            success: true, 
            message: `Discovery completed: ${discovered} new zones discovered, ${orphaned} zones orphaned` 
        };
        
    } catch (error) {
        return { 
            success: false, 
            error: `Zone discovery failed: ${error.message}` 
        };
    }
};

/**
 * Terminate VNC session for a zone
 * @param {string} zoneName - Name of zone
 */
const terminateVncSession = async (zoneName) => {
    try {
        const session = await VncSessions.findOne({
            where: { zone_name: zoneName, status: 'active' }
        });
        
        if (session && session.process_id) {
            try {
                process.kill(session.process_id, 'SIGTERM');
            } catch (error) {
                console.warn(`Failed to kill VNC process ${session.process_id}:`, error.message);
            }
            
            await session.update({ status: 'stopped' });
        }
    } catch (error) {
        console.warn(`Failed to terminate VNC session for ${zoneName}:`, error.message);
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
                                attributes: ['id']
                            }).then(tasks => tasks.map(t => t.id))
                        }
                    }
                ]
            },
            order: [['priority', 'DESC'], ['created_at', 'ASC']]
        });
        
        if (!task) {
            return; // No tasks available
        }
        
        // Check for operation category conflicts
        const operationCategory = OPERATION_CATEGORIES[task.operation];
        if (operationCategory && runningCategories.has(operationCategory)) {
            console.log(`⏳ Task ${task.id} (${task.operation}) waiting - category '${operationCategory}' already running`);
            return; // Cannot start this task due to category conflict
        }
        
        // Mark task as running
        await task.update({ 
            status: 'running',
            started_at: new Date()
        });
        
        runningTasks.set(task.id, task);
        
        // Add operation category to running set if it has one
        if (operationCategory) {
            runningCategories.add(operationCategory);
            console.log(`🔒 Task ${task.id}: Acquired category lock '${operationCategory}'`);
        }
        
        console.log(`🚀 Starting task ${task.id}: ${task.operation} on ${task.zone_name}`);
        console.log(`📋 Task object:`, {
            id: task.id,
            operation: task.operation,
            zone_name: task.zone_name,
            category: operationCategory || 'none',
            metadata: task.metadata,
            metadata_type: typeof task.metadata,
            metadata_length: task.metadata ? task.metadata.length : 'N/A'
        });
        
        // Execute task
        const result = await executeTask(task);
        
        // Update task status
        await task.update({
            status: result.success ? 'completed' : 'failed',
            completed_at: new Date(),
            error_message: result.error || null
        });
        
        runningTasks.delete(task.id);
        
        // Release operation category lock if it had one
        if (operationCategory) {
            runningCategories.delete(operationCategory);
            console.log(`🔓 Task ${task.id}: Released category lock '${operationCategory}'`);
        }
        
        if (result.success) {
            console.log(`✅ Task ${task.id} completed successfully: ${result.message}`);
        } else {
            console.error(`❌ Task ${task.id} failed: ${result.error}`);
        }
        
    } catch (error) {
        console.error('Error processing task:', error);
        
        // Make sure to clean up category lock on error
        const task = await Tasks.findOne({
            where: { status: 'running' },
            order: [['started_at', 'DESC']]
        });
        
        if (task) {
            const operationCategory = OPERATION_CATEGORIES[task.operation];
            if (operationCategory && runningCategories.has(operationCategory)) {
                runningCategories.delete(operationCategory);
                console.log(`🔓 Emergency cleanup: Released category lock '${operationCategory}' for task ${task.id}`);
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
    
    console.log('Starting task processor...');
    
    // Process tasks every 2 seconds
    taskProcessor = setInterval(async () => {
        await processNextTask();
    }, 2000);
    
    // Get zones configuration for discovery settings
    const zonesConfig = config.getZones();
    
    // Start periodic discovery if enabled
    if (zonesConfig.auto_discovery && zonesConfig.discovery_interval) {
        console.log(`Starting periodic zone discovery every ${zonesConfig.discovery_interval} seconds...`);
        
        // Start periodic discovery interval
        discoveryProcessor = setInterval(async () => {
            await Tasks.create({
                zone_name: 'system',
                operation: 'discover',
                priority: TaskPriority.BACKGROUND,
                created_by: 'system_periodic',
                status: 'pending'
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
            status: 'pending'
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
        console.log('Task processor stopped');
    }
    
    if (discoveryProcessor) {
        clearInterval(discoveryProcessor);
        discoveryProcessor = null;
        console.log('Periodic discovery stopped');
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

        if (status) whereClause.status = status;
        if (zone_name) whereClause.zone_name = zone_name;
        if (operation) whereClause.operation = operation;
        if (operation_ne) {
            whereClause.operation = { [Op.ne]: operation_ne };
        }
        if (since) {
            whereClause.created_at = { [Op.gte]: new Date(since) };
        }
        
        const tasks = await Tasks.findAll({
            where: whereClause,
            order: [['created_at', 'DESC']],
            limit: parseInt(limit)
        });
        
        const total = await Tasks.count({ where: whereClause });
        
        res.json({
            tasks: tasks,
            total: total,
            running_count: runningTasks.size
        });
        
    } catch (error) {
        console.error('Error listing tasks:', error);
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
        console.error('Error getting task details:', error);
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
                current_status: task.status
            });
        }
        
        await task.update({ status: 'cancelled' });
        
        res.json({
            success: true,
            task_id: taskId,
            message: 'Task cancelled successfully'
        });
        
    } catch (error) {
        console.error('Error cancelling task:', error);
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
            attributes: [
                'status',
                [Tasks.sequelize.fn('COUNT', '*'), 'count']
            ],
            group: ['status']
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
            task_processor_running: taskProcessor !== null
        });
        
    } catch (error) {
        console.error('Error getting task stats:', error);
        res.status(500).json({ error: 'Failed to retrieve task statistics' });
    }
};

/**
 * Execute hostname change task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSetHostnameTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { hostname, apply_immediately } = metadata;

        // Write to /etc/nodename
        const writeResult = await executeCommand(`echo "${hostname}" | pfexec tee /etc/nodename`);
        if (!writeResult.success) {
            return { 
                success: false, 
                error: `Failed to write to /etc/nodename: ${writeResult.error}` 
            };
        }

        // Apply immediately if requested
        if (apply_immediately) {
            const hostnameResult = await executeCommand(`pfexec hostname ${hostname}`);
            if (!hostnameResult.success) {
                return { 
                    success: false, 
                    error: `Failed to set hostname immediately: ${hostnameResult.error}` 
                };
            }
        }

        return { 
            success: true, 
            message: `Hostname set to ${hostname}${apply_immediately ? ' (applied immediately)' : ' (reboot required)'}`,
            requires_reboot: true,
            reboot_reason: apply_immediately ? 'Hostname applied immediately but reboot required for full persistence' : 'Hostname written to /etc/nodename - reboot required to take effect'
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
const executeCreateIPAddressTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
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
                if (down) command += ` -d`;
                command += ` -a ${address} ${addrobj}`;
                break;
            case 'dhcp':
                command += ` -T dhcp`;
                if (primary) command += ` -1`;
                if (wait) command += ` -w ${wait}`;
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
                message: `VLAN ${vlan} deleted successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to delete VLAN ${vlan}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `IP address creation task failed: ${error.message}` };
    }
};

/**
 * Execute IP address deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteIPAddressTask = async (metadataJson) => {
    console.log('🔧 === IP ADDRESS DELETION TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { addrobj, release } = metadata;

        console.log('📋 IP address deletion task parameters:');
        console.log('   - addrobj:', addrobj);
        console.log('   - release:', release);

        let command = `pfexec ipadm delete-addr`;
        if (release) command += ` -r`;
        command += ` ${addrobj}`;

        console.log('🔧 Executing IP address deletion command:', command);

        const result = await executeCommand(command);
        
        if (result.success) {
            console.log('✅ IP address deleted from system successfully, cleaning up IP interface and database entries...');
            
            // Clean up all monitoring database entries for this IP address
            const hostname = os.hostname();
            const [interfaceName] = addrobj.split('/'); // Extract interface from addrobj (e.g., vnic0/v4static -> vnic0)
            
            let cleanupResults = {
                ip_addresses: 0,
                network_interfaces: 0,
                ip_interface_deleted: false
            };

            // Check if there are any remaining IP addresses on this interface
            console.log(`🔍 Checking for remaining IP addresses on interface ${interfaceName}...`);
            const remainingAddrsResult = await executeCommand(`pfexec ipadm show-addr ${interfaceName} -p`);
            
            if (!remainingAddrsResult.success || !remainingAddrsResult.output.trim()) {
                // No remaining IP addresses, delete the IP interface
                console.log(`🗑️  No remaining IP addresses on ${interfaceName}, deleting IP interface...`);
                const deleteInterfaceResult = await executeCommand(`pfexec ipadm delete-if ${interfaceName}`);
                
                if (deleteInterfaceResult.success) {
                    cleanupResults.ip_interface_deleted = true;
                    console.log(`✅ IP interface ${interfaceName} deleted successfully`);
                } else {
                    console.warn(`⚠️  Failed to delete IP interface ${interfaceName}:`, deleteInterfaceResult.error);
                }
            } else {
                console.log(`ℹ️  Interface ${interfaceName} still has IP addresses, keeping IP interface`);
            }

            try {
                // Clean up IPAddresses table (IP address monitoring data)
                const ipAddressesDeleted = await IPAddresses.destroy({
                    where: {
                        host: hostname,
                        addrobj: addrobj
                    }
                });
                cleanupResults.ip_addresses = ipAddressesDeleted;
                console.log(`🗑️  Cleaned up ${ipAddressesDeleted} IP address entries for ${addrobj}`);

                // Note: NetworkInterfaces table tracks interfaces (like VNICs), not IP addresses
                // When deleting an IP address, we don't delete the interface entry itself
                // since the interface may still exist with other IP addresses
                cleanupResults.network_interfaces = 0;

                const totalCleaned = cleanupResults.ip_addresses;
                console.log(`✅ Database cleanup completed: ${totalCleaned} total entries removed for IP address ${addrobj}`);

                return { 
                    success: true, 
                    message: `IP address ${addrobj} deleted successfully${cleanupResults.ip_interface_deleted ? ` (IP interface ${interfaceName} also deleted)` : ''} (system + ${totalCleaned} database entries cleaned)`,
                    cleanup_summary: cleanupResults
                };

            } catch (cleanupError) {
                console.warn(`⚠️  IP address ${addrobj} deleted from system but database cleanup failed:`, cleanupError.message);
                return { 
                    success: true, 
                    message: `IP address ${addrobj} deleted successfully${cleanupResults.ip_interface_deleted ? ` (IP interface ${interfaceName} also deleted)` : ''} (warning: database cleanup failed - ${cleanupError.message})`,
                    cleanup_error: cleanupError.message
                };
            }
        } else {
            console.error('❌ IP address deletion command failed:', result.error);
            return { 
                success: false, 
                error: `Failed to delete IP address ${addrobj}: ${result.error}` 
            };
        }

    } catch (error) {
        console.error('❌ IP address deletion task exception:', error);
        return { success: false, error: `IP address deletion task failed: ${error.message}` };
    }
};

/**
 * Execute IP address enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeEnableIPAddressTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { addrobj } = metadata;

        const result = await executeCommand(`pfexec ipadm enable-addr ${addrobj}`);
        
        if (result.success) {
            return { 
                success: true, 
                message: `IP address ${addrobj} enabled successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to enable IP address ${addrobj}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `IP address enable task failed: ${error.message}` };
    }
};

/**
 * Execute IP address disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDisableIPAddressTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { addrobj } = metadata;

        const result = await executeCommand(`pfexec ipadm disable-addr ${addrobj}`);
        
        if (result.success) {
            return { 
                success: true, 
                message: `IP address ${addrobj} disabled successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to disable IP address ${addrobj}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `IP address disable task failed: ${error.message}` };
    }
};

/**
 * Execute VNIC creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateVNICTask = async (metadataJson) => {
    console.log('🔧 === VNIC CREATION TASK STARTING ===');
    console.log('📋 Raw metadata received:', metadataJson);
    console.log('📋 Metadata type:', typeof metadataJson);
    console.log('📋 Metadata length:', metadataJson ? metadataJson.length : 'N/A');
    
    try {
        if (!metadataJson) {
            console.error('❌ VNIC creation task metadata is undefined or null');
            console.log('🔧 Would have run command: pfexec dladm create-vnic [MISSING PARAMETERS]');
            return { success: false, error: 'Task metadata is missing - cannot build dladm command' };
        }

        let metadata;
        try {
            metadata = await new Promise((resolve, reject) => {
                yj.parseAsync(metadataJson, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
            console.log('✅ Successfully parsed metadata:', metadata);
        } catch (parseError) {
            console.error('❌ Failed to parse metadata JSON:', parseError.message);
            console.log('🔧 Would have run command: pfexec dladm create-vnic [INVALID JSON]');
            return { success: false, error: `Invalid JSON metadata: ${parseError.message}` };
        }

        const { name, link, mac_address, mac_prefix, slot, vlan_id, temporary, properties } = metadata;

        // Always show what command we're building
        console.log('🔧 Building dladm create-vnic command with parameters:');
        console.log('   - name:', name);
        console.log('   - link:', link);
        console.log('   - mac_address:', mac_address);
        console.log('   - mac_prefix:', mac_prefix);
        console.log('   - slot:', slot);
        console.log('   - vlan_id:', vlan_id);
        console.log('   - temporary:', temporary);
        console.log('   - properties:', properties);

        let command = `pfexec dladm create-vnic`;
        
        // Add temporary flag
        if (temporary) {
            command += ` -t`;
            console.log('   + Added temporary flag: -t');
        }

        // Add link
        if (link) {
            command += ` -l ${link}`;
            console.log(`   + Added link: -l ${link}`);
        } else {
            console.log('   ⚠️  Missing required link parameter');
        }

        // Add MAC address configuration
        if (mac_address === 'factory') {
            command += ` -m factory -n ${slot}`;
            console.log(`   + Added factory MAC: -m factory -n ${slot}`);
        } else if (mac_address === 'random') {
            command += ` -m random`;
            console.log('   + Added random MAC: -m random');
            if (mac_prefix) {
                command += ` -r ${mac_prefix}`;
                console.log(`   + Added MAC prefix: -r ${mac_prefix}`);
            }
        } else if (mac_address === 'auto') {
            command += ` -m auto`;
            console.log('   + Added auto MAC: -m auto');
        } else if (mac_address && mac_address !== 'auto') {
            // Specific MAC address provided
            command += ` -m ${mac_address}`;
            console.log(`   + Added specific MAC: -m ${mac_address}`);
        } else {
            console.log('   + Using default MAC assignment');
        }

        // Add VLAN ID if specified
        if (vlan_id) {
            command += ` -v ${vlan_id}`;
            console.log(`   + Added VLAN ID: -v ${vlan_id}`);
        }

        // Add properties if specified
        if (properties && Object.keys(properties).length > 0) {
            const propList = Object.entries(properties)
                .map(([key, value]) => `${key}=${value}`)
                .join(',');
            command += ` -p ${propList}`;
            console.log(`   + Added properties: -p ${propList}`);
        }

        // Add VNIC name
        if (name) {
            command += ` ${name}`;
            console.log(`   + Added VNIC name: ${name}`);
        } else {
            console.log('   ⚠️  Missing required VNIC name parameter');
        }

        console.log('🔧 FINAL COMMAND TO EXECUTE:', command);

        // Validate required parameters before executing
        if (!name || !link) {
            console.error('❌ Missing required parameters - cannot execute command');
            return { 
                success: false, 
                error: `Missing required parameters: ${!name ? 'name ' : ''}${!link ? 'link' : ''}` 
            };
        }

        const result = await executeCommand(command);
        
        if (result.success) {
            console.log('✅ VNIC creation command completed successfully');
            return { 
                success: true, 
                message: `VNIC ${name} created successfully over ${link}` 
            };
        } else {
            console.error('❌ VNIC creation command failed');
            return { 
                success: false, 
                error: `Failed to create VNIC ${name}: ${result.error}` 
            };
        }

    } catch (error) {
        console.error('❌ VNIC creation task exception:', error);
        console.log('🔧 Command execution was aborted due to error');
        return { success: false, error: `VNIC creation task failed: ${error.message}` };
    }
};

/**
 * Execute VNIC deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteVNICTask = async (metadataJson) => {
    console.log('🔧 === VNIC DELETION TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { vnic, temporary } = metadata;

        console.log('📋 VNIC deletion task parameters:');
        console.log('   - vnic:', vnic);
        console.log('   - temporary:', temporary);

        let command = `pfexec dladm delete-vnic`;
        if (temporary) command += ` -t`;
        command += ` ${vnic}`;

        console.log('🔧 Executing VNIC deletion command:', command);

        const result = await executeCommand(command);
        
        if (result.success) {
            console.log('✅ VNIC deleted from system successfully, cleaning up database entries...');
            
            // Clean up all monitoring database entries for this VNIC
            const hostname = os.hostname();
            let cleanupResults = {
                network_interfaces: 0,
                network_stats: 0,
                network_usage: 0
            };

            try {
                // Clean up NetworkInterfaces table (monitoring data)
                const interfacesDeleted = await NetworkInterfaces.destroy({
                    where: {
                        host: hostname,
                        link: vnic,
                        class: 'vnic'
                    }
                });
                cleanupResults.network_interfaces = interfacesDeleted;
                console.log(`🗑️  Cleaned up ${interfacesDeleted} network interface entries for VNIC ${vnic}`);

                // Clean up NetworkUsage table (usage accounting)
                const usageDeleted = await NetworkUsage.destroy({
                    where: {
                        host: hostname,
                        link: vnic
                    }
                });
                cleanupResults.network_usage = usageDeleted;
                console.log(`🗑️  Cleaned up ${usageDeleted} network usage entries for VNIC ${vnic}`);

                const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_usage;
                console.log(`✅ Database cleanup completed: ${totalCleaned} total entries removed for VNIC ${vnic}`);

                return { 
                    success: true, 
                    message: `VNIC ${vnic} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
                    cleanup_summary: cleanupResults
                };

            } catch (cleanupError) {
                console.warn(`⚠️  VNIC ${vnic} deleted from system but database cleanup failed:`, cleanupError.message);
                return { 
                    success: true, 
                    message: `VNIC ${vnic} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
                    cleanup_error: cleanupError.message
                };
            }
        } else {
            console.error('❌ VNIC deletion command failed:', result.error);
            return { 
                success: false, 
                error: `Failed to delete VNIC ${vnic}: ${result.error}` 
            };
        }

    } catch (error) {
        console.error('❌ VNIC deletion task exception:', error);
        return { success: false, error: `VNIC deletion task failed: ${error.message}` };
    }
};

/**
 * Execute VNIC properties setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSetVNICPropertiesTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { vnic, properties, temporary } = metadata;

        let command = `pfexec dladm set-linkprop`;
        if (temporary) command += ` -t`;
        
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
                message: `VLAN ${vlan} deleted successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to set VNIC ${vnic} properties: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `VNIC properties task failed: ${error.message}` };
    }
};

/**
 * Execute aggregate creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateAggregateTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
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
                message: `Aggregate ${name} created successfully with links: ${links.join(', ')}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to create aggregate ${name}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Aggregate creation task failed: ${error.message}` };
    }
};

/**
 * Execute aggregate deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteAggregateTask = async (metadataJson) => {
    console.log('🔧 === AGGREGATE DELETION TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { aggregate, temporary } = metadata;

        console.log('📋 Aggregate deletion task parameters:');
        console.log('   - aggregate:', aggregate);
        console.log('   - temporary:', temporary);

        let command = `pfexec dladm delete-aggr`;
        if (temporary) command += ` -t`;
        command += ` ${aggregate}`;

        console.log('🔧 Executing aggregate deletion command:', command);

        const result = await executeCommand(command);
        
        if (result.success) {
            console.log('✅ Aggregate deleted from system successfully, cleaning up database entries...');
            
            // Clean up all monitoring database entries for this aggregate
            const hostname = os.hostname();
            let cleanupResults = {
                network_interfaces: 0,
                network_usage: 0
            };

            try {
                // Clean up NetworkInterfaces table (monitoring data)
                const interfacesDeleted = await NetworkInterfaces.destroy({
                    where: {
                        host: hostname,
                        link: aggregate,
                        class: 'aggr'
                    }
                });
                cleanupResults.network_interfaces = interfacesDeleted;
                console.log(`🗑️  Cleaned up ${interfacesDeleted} network interface entries for aggregate ${aggregate}`);

                // Clean up NetworkUsage table (usage accounting)
                const usageDeleted = await NetworkUsage.destroy({
                    where: {
                        host: hostname,
                        link: aggregate
                    }
                });
                cleanupResults.network_usage = usageDeleted;
                console.log(`🗑️  Cleaned up ${usageDeleted} network usage entries for aggregate ${aggregate}`);

                const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_usage;
                console.log(`✅ Database cleanup completed: ${totalCleaned} total entries removed for aggregate ${aggregate}`);

                return { 
                    success: true, 
                    message: `Aggregate ${aggregate} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
                    cleanup_summary: cleanupResults
                };

            } catch (cleanupError) {
                console.warn(`⚠️  Aggregate ${aggregate} deleted from system but database cleanup failed:`, cleanupError.message);
                return { 
                    success: true, 
                    message: `Aggregate ${aggregate} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
                    cleanup_error: cleanupError.message
                };
            }
        } else {
            console.error('❌ Aggregate deletion command failed:', result.error);
            return { 
                success: false, 
                error: `Failed to delete aggregate ${aggregate}: ${result.error}` 
            };
        }

    } catch (error) {
        console.error('❌ Aggregate deletion task exception:', error);
        return { success: false, error: `Aggregate deletion task failed: ${error.message}` };
    }
};

/**
 * Execute aggregate links modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeModifyAggregateLinksTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { aggregate, operation, links, temporary } = metadata;

        let command = `pfexec dladm ${operation}-aggr`;
        if (temporary) command += ` -t`;
        
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
                message: `Successfully ${operation}ed links ${links.join(', ')} ${operation === 'add' ? 'to' : 'from'} aggregate ${aggregate}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to ${operation} links on aggregate ${aggregate}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Aggregate links modification task failed: ${error.message}` };
    }
};

/**
 * Execute etherstub creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateEtherstubTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, temporary } = metadata;

        let command = `pfexec dladm create-etherstub`;
        if (temporary) command += ` -t`;
        command += ` ${name}`;

        const result = await executeCommand(command);
        
        if (result.success) {
            return { 
                success: true, 
                message: `Etherstub ${name} created successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to create etherstub ${name}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Etherstub creation task failed: ${error.message}` };
    }
};

/**
 * Execute etherstub deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteEtherstubTask = async (metadataJson) => {
    console.log('🔧 === ETHERSTUB DELETION TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { etherstub, temporary, force } = metadata;

        console.log('📋 Etherstub deletion task parameters:');
        console.log('   - etherstub:', etherstub);
        console.log('   - temporary:', temporary);
        console.log('   - force:', force);

        // If force deletion, first remove any VNICs on the etherstub
        if (force) {
            console.log('🔧 Force deletion enabled, checking for VNICs on etherstub...');
            const vnicResult = await executeCommand(`pfexec dladm show-vnic -l ${etherstub} -p -o link`);
            if (vnicResult.success && vnicResult.output.trim()) {
                const vnics = vnicResult.output.trim().split('\n');
                console.log(`🗑️  Found ${vnics.length} VNICs to remove: ${vnics.join(', ')}`);
                for (const vnic of vnics) {
                    console.log(`🔧 Removing VNIC ${vnic}...`);
                    await executeCommand(`pfexec dladm delete-vnic ${temporary ? '-t' : ''} ${vnic}`);
                }
            } else {
                console.log('ℹ️  No VNICs found on etherstub');
            }
        }

        let command = `pfexec dladm delete-etherstub`;
        if (temporary) command += ` -t`;
        command += ` ${etherstub}`;

        console.log('🔧 Executing etherstub deletion command:', command);

        const result = await executeCommand(command);
        
        if (result.success) {
            console.log('✅ Etherstub deleted from system successfully, cleaning up database entries...');
            
            // Clean up all monitoring database entries for this etherstub
            const hostname = os.hostname();
            let cleanupResults = {
                network_interfaces: 0,
                network_stats: 0,
                network_usage: 0
            };

            try {
                // Clean up NetworkInterfaces table (monitoring data)
                const interfacesDeleted = await NetworkInterfaces.destroy({
                    where: {
                        host: hostname,
                        link: etherstub,
                        class: 'etherstub'
                    }
                });
                cleanupResults.network_interfaces = interfacesDeleted;
                console.log(`🗑️  Cleaned up ${interfacesDeleted} network interface entries for etherstub ${etherstub}`);

                // Clean up NetworkUsage table (usage accounting)
                const usageDeleted = await NetworkUsage.destroy({
                    where: {
                        host: hostname,
                        link: etherstub
                    }
                });
                cleanupResults.network_usage = usageDeleted;
                console.log(`🗑️  Cleaned up ${usageDeleted} network usage entries for etherstub ${etherstub}`);

                const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_stats + cleanupResults.network_usage;
                console.log(`✅ Database cleanup completed: ${totalCleaned} total entries removed for etherstub ${etherstub}`);

                return { 
                    success: true, 
                    message: `Etherstub ${etherstub} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
                    cleanup_summary: cleanupResults
                };

            } catch (cleanupError) {
                console.warn(`⚠️  Etherstub ${etherstub} deleted from system but database cleanup failed:`, cleanupError.message);
                return { 
                    success: true, 
                    message: `Etherstub ${etherstub} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
                    cleanup_error: cleanupError.message
                };
            }
        } else {
            console.error('❌ Etherstub deletion command failed:', result.error);
            return { 
                success: false, 
                error: `Failed to delete etherstub ${etherstub}: ${result.error}` 
            };
        }

    } catch (error) {
        console.error('❌ Etherstub deletion task exception:', error);
        return { success: false, error: `Etherstub deletion task failed: ${error.message}` };
    }
};

/**
 * Execute VLAN creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateVlanTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { vid, link, name, force, temporary } = metadata;

        let command = `pfexec dladm create-vlan`;
        if (force) command += ` -f`;
        if (temporary) command += ` -t`;
        command += ` -l ${link} -v ${vid}`;
        if (name) command += ` ${name}`;

        const result = await executeCommand(command);
        
        if (result.success) {
            return { 
                success: true, 
                message: `VLAN ${name || `${link}_${vid}`} created successfully (VID ${vid}) over ${link}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to create VLAN ${name || `${link}_${vid}`}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `VLAN creation task failed: ${error.message}` };
    }
};

/**
 * Execute VLAN deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteVlanTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { vlan, temporary } = metadata;

        let command = `pfexec dladm delete-vlan`;
        if (temporary) command += ` -t`;
        command += ` ${vlan}`;

        const result = await executeCommand(command);
        
        if (result.success) {
            // Clean up associated data
            await NetworkInterfaces.destroy({ where: { link: vlan } });
            await NetworkUsage.destroy({ where: { link: vlan } });

            return { 
                success: true, 
                message: `VLAN ${vlan} deleted successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to delete VLAN ${vlan}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `VLAN deletion task failed: ${error.message}` };
    }
};

/**
 * Execute bridge creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeCreateBridgeTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, protection, priority, max_age, hello_time, forward_delay, force_protocol, links } = metadata;

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
                message: `Bridge ${name} created successfully${links && links.length > 0 ? ` with links: ${links.join(', ')}` : ''}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to create bridge ${name}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Bridge creation task failed: ${error.message}` };
    }
};

/**
 * Execute bridge deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeDeleteBridgeTask = async (metadataJson) => {
    console.log('🔧 === BRIDGE DELETION TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { bridge, force } = metadata;

        console.log('📋 Bridge deletion task parameters:');
        console.log('   - bridge:', bridge);
        console.log('   - force:', force);

        // If force deletion, first remove any attached links
        if (force) {
            console.log('🔧 Force deletion enabled, checking for attached links...');
            const linksResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -l -p -o link`);
            if (linksResult.success && linksResult.output.trim()) {
                const attachedLinks = linksResult.output.trim().split('\n');
                console.log(`🗑️  Found ${attachedLinks.length} attached links to remove: ${attachedLinks.join(', ')}`);
                for (const link of attachedLinks) {
                    console.log(`🔧 Removing link ${link} from bridge...`);
                    await executeCommand(`pfexec dladm remove-bridge -l ${link} ${bridge}`);
                }
            } else {
                console.log('ℹ️  No attached links found on bridge');
            }
        }

        console.log('🔧 Executing bridge deletion command...');
        const result = await executeCommand(`pfexec dladm delete-bridge ${bridge}`);
        
        if (result.success) {
            console.log('✅ Bridge deleted from system successfully, cleaning up database entries...');
            
            // Clean up all monitoring database entries for this bridge
            const hostname = os.hostname();
            let cleanupResults = {
                network_interfaces: 0,
                network_stats: 0,
                network_usage: 0
            };

            try {
                // Clean up NetworkInterfaces table (monitoring data)
                const interfacesDeleted = await NetworkInterfaces.destroy({
                    where: {
                        host: hostname,
                        link: bridge,
                        class: 'bridge'
                    }
                });
                cleanupResults.network_interfaces = interfacesDeleted;
                console.log(`🗑️  Cleaned up ${interfacesDeleted} network interface entries for bridge ${bridge}`);

                // Clean up NetworkUsage table (usage accounting)
                const usageDeleted = await NetworkUsage.destroy({
                    where: {
                        host: hostname,
                        link: bridge
                    }
                });
                cleanupResults.network_usage = usageDeleted;
                console.log(`🗑️  Cleaned up ${usageDeleted} network usage entries for bridge ${bridge}`);

                const totalCleaned = cleanupResults.network_interfaces + cleanupResults.network_stats + cleanupResults.network_usage;
                console.log(`✅ Database cleanup completed: ${totalCleaned} total entries removed for bridge ${bridge}`);

                return { 
                    success: true, 
                    message: `Bridge ${bridge} deleted successfully (system + ${totalCleaned} database entries cleaned)`,
                    cleanup_summary: cleanupResults
                };

            } catch (cleanupError) {
                console.warn(`⚠️  Bridge ${bridge} deleted from system but database cleanup failed:`, cleanupError.message);
                return { 
                    success: true, 
                    message: `Bridge ${bridge} deleted successfully (warning: database cleanup failed - ${cleanupError.message})`,
                    cleanup_error: cleanupError.message
                };
            }
        } else {
            console.error('❌ Bridge deletion command failed:', result.error);
            return { 
                success: false, 
                error: `Failed to delete bridge ${bridge}: ${result.error}` 
            };
        }

    } catch (error) {
        console.error('❌ Bridge deletion task exception:', error);
        return { success: false, error: `Bridge deletion task failed: ${error.message}` };
    }
};

/**
 * Execute bridge links modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeModifyBridgeLinksTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { bridge, operation, links } = metadata;

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
                message: `Successfully ${operation}ed links ${links.join(', ')} ${operation === 'add' ? 'to' : 'from'} bridge ${bridge}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to ${operation} links on bridge ${bridge}: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Bridge links modification task failed: ${error.message}` };
    }
};

/**
 * Execute package installation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgInstallTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { packages, accept_licenses, dry_run, be_name } = metadata;

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
                message: `Successfully ${dry_run ? 'planned installation of' : 'installed'} ${packages.length} package(s): ${packages.join(', ')}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to install packages: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Package installation task failed: ${error.message}` };
    }
};

/**
 * Execute package uninstallation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgUninstallTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { packages, dry_run, be_name } = metadata;

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
                message: `Successfully ${dry_run ? 'planned uninstallation of' : 'uninstalled'} ${packages.length} package(s): ${packages.join(', ')}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to uninstall packages: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Package uninstallation task failed: ${error.message}` };
    }
};

/**
 * Execute system update task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgUpdateTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { packages, accept_licenses, be_name, backup_be, reject_packages } = metadata;

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
                message: packages && packages.length > 0 
                    ? `Successfully updated ${packages.length} specific package(s): ${packages.join(', ')}`
                    : 'Successfully updated all available packages'
            };
        } else {
            return { 
                success: false, 
                error: `Failed to update packages: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Package update task failed: ${error.message}` };
    }
};

/**
 * Execute package metadata refresh task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executePkgRefreshTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { full, publishers } = metadata;

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
                message: publishers && publishers.length > 0 
                    ? `Successfully refreshed metadata for ${publishers.length} publisher(s): ${publishers.join(', ')}`
                    : 'Successfully refreshed metadata for all publishers'
            };
        } else {
            return { 
                success: false, 
                error: `Failed to refresh metadata: ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Package refresh task failed: ${error.message}` };
    }
};

/**
 * Execute boot environment creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmCreateTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, description, source_be, snapshot, activate, zpool, properties } = metadata;

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
                message: `Boot environment '${name}' created successfully${activate ? ' and activated' : ''}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to create boot environment '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Boot environment creation task failed: ${error.message}` };
    }
};

/**
 * Execute boot environment deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmDeleteTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, force, snapshots } = metadata;

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
                message: `Boot environment '${name}' deleted successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to delete boot environment '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Boot environment deletion task failed: ${error.message}` };
    }
};

/**
 * Execute boot environment activation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmActivateTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, temporary } = metadata;

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
                message: `Boot environment '${name}' activated successfully${temporary ? ' (temporary)' : ''}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to activate boot environment '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Boot environment activation task failed: ${error.message}` };
    }
};

/**
 * Execute boot environment mount task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmMountTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, mountpoint, shared_mode } = metadata;

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
                message: `Boot environment '${name}' mounted successfully at '${mountpoint}'` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to mount boot environment '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Boot environment mount task failed: ${error.message}` };
    }
};

/**
 * Execute boot environment unmount task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeBeadmUnmountTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, force } = metadata;

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
                message: `Boot environment '${name}' unmounted successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to unmount boot environment '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Boot environment unmount task failed: ${error.message}` };
    }
};

/**
 * Execute repository addition task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryAddTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, origin, mirrors, ssl_cert, ssl_key, enabled, sticky, search_first, search_before, search_after, properties, proxy } = metadata;

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
                    console.warn(`Publisher ${name} added but failed to disable: ${disableResult.error}`);
                }
            }
            
            return { 
                success: true, 
                message: `Repository '${name}' added successfully${enabled === false ? ' (disabled)' : ''}` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to add repository '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Repository addition task failed: ${error.message}` };
    }
};

/**
 * Execute repository removal task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryRemoveTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name } = metadata;

        const command = `pfexec pkg unset-publisher ${name}`;

        const result = await executeCommand(command);
        
        if (result.success) {
            return { 
                success: true, 
                message: `Repository '${name}' removed successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to remove repository '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Repository removal task failed: ${error.message}` };
    }
};

/**
 * Execute repository modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryModifyTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name, origins_to_add, origins_to_remove, mirrors_to_add, mirrors_to_remove, ssl_cert, ssl_key, enabled, sticky, search_first, search_before, search_after, properties_to_set, properties_to_unset, proxy, reset_uuid, refresh } = metadata;

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
                message: `Repository '${name}' modified successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to modify repository '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Repository modification task failed: ${error.message}` };
    }
};

/**
 * Execute repository enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryEnableTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name } = metadata;

        const command = `pfexec pkg set-publisher --enable ${name}`;

        const result = await executeCommand(command);
        
        if (result.success) {
            return { 
                success: true, 
                message: `Repository '${name}' enabled successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to enable repository '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Repository enable task failed: ${error.message}` };
    }
};

/**
 * Execute repository disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeRepositoryDisableTask = async (metadataJson) => {
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });        const { name } = metadata;

        const command = `pfexec pkg set-publisher --disable ${name}`;

        const result = await executeCommand(command);
        
        if (result.success) {
            return { 
                success: true, 
                message: `Repository '${name}' disabled successfully` 
            };
        } else {
            return { 
                success: false, 
                error: `Failed to disable repository '${name}': ${result.error}` 
            };
        }

    } catch (error) {
        return { success: false, error: `Repository disable task failed: ${error.message}` };
    }
};

/**
 * Execute time sync configuration update task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeUpdateTimeSyncConfigTask = async (metadataJson) => {
    console.log('🔧 === TIME SYNC CONFIG UPDATE TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { service, config_content, backup_existing, restart_service } = metadata;

        console.log('📋 Time sync config update parameters:');
        console.log('   - service:', service);
        console.log('   - backup_existing:', backup_existing);
        console.log('   - restart_service:', restart_service);
        console.log('   - config_content length:', config_content ? config_content.length : 'N/A');

        // Determine config file path based on service
        let configFile;
        if (service === 'ntp') {
            configFile = '/etc/inet/ntp.conf';
        } else if (service === 'chrony') {
            configFile = '/etc/inet/chrony.conf';
        } else {
            return { success: false, error: `Unknown time sync service: ${service}` };
        }

        console.log('🔧 Target config file:', configFile);

        // Create backup if existing config exists and backup is requested
        if (backup_existing) {
            const backupResult = await executeCommand(`test -f ${configFile} && pfexec cp ${configFile} ${configFile}.backup.$(date +%Y%m%d_%H%M%S) || echo "No existing config to backup"`);
            if (backupResult.success) {
                console.log('✅ Config backup created (if file existed)');
            } else {
                console.warn('⚠️  Failed to create backup:', backupResult.error);
            }
        }

        // Write new config content
        const writeResult = await executeCommand(`echo '${config_content.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`);
        
        if (!writeResult.success) {
            return { 
                success: false, 
                error: `Failed to write config file ${configFile}: ${writeResult.error}` 
            };
        }

        console.log('✅ Config file written successfully');

        // Restart service if requested
        if (restart_service) {
            console.log(`🔄 Restarting ${service} service...`);
            const restartResult = await executeCommand(`pfexec svcadm restart network/${service}`);
            
            if (!restartResult.success) {
                return { 
                    success: true, // Config was written successfully
                    message: `Time sync configuration updated successfully, but service restart failed: ${restartResult.error}`,
                    warning: `Service ${service} restart failed - may need manual restart`
                };
            }
            console.log('✅ Service restarted successfully');
        }

        return { 
            success: true, 
            message: `Time sync configuration updated successfully for ${service}${restart_service ? ' (service restarted)' : ''}`,
            config_file: configFile
        };

    } catch (error) {
        console.error('❌ Time sync config update task exception:', error);
        return { success: false, error: `Time sync config update task failed: ${error.message}` };
    }
};

/**
 * Execute force time synchronization task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeForceTimeSyncTask = async (metadataJson) => {
    console.log('🔧 === FORCE TIME SYNC TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { service, server, timeout } = metadata;

        console.log('📋 Force time sync parameters:');
        console.log('   - service:', service);
        console.log('   - server:', server || 'auto-detect');
        console.log('   - timeout:', timeout);

        let syncResult;

        if (service === 'ntp') {
            // For NTP, use ntpdig for immediate sync
            let command = `pfexec ntpdig`;
            if (timeout) command += ` -t ${timeout}`;
            if (server) {
                command += ` ${server}`;
            } else {
                command += ` pool.ntp.org`; // Default fallback server
            }

            console.log('🔧 Executing NTP sync command:', command);
            syncResult = await executeCommand(command, (timeout || 30) * 1000);
            
        } else if (service === 'chrony') {
            // For Chrony, use chronyc to force sync
            console.log('🔧 Executing Chrony makestep command...');
            syncResult = await executeCommand(`pfexec chronyc makestep`, (timeout || 30) * 1000);
            
            if (!syncResult.success) {
                // Fallback to burst command
                console.log('🔧 Makestep failed, trying burst command...');
                syncResult = await executeCommand(`pfexec chronyc burst 5/10`, (timeout || 30) * 1000);
            }
            
        } else {
            return { success: false, error: `Cannot force sync - unknown service: ${service}` };
        }

        if (syncResult.success) {
            console.log('✅ Time sync command completed successfully');
            
            // Get current system time for confirmation
            const timeResult = await executeCommand('date');
            const currentTime = timeResult.success ? timeResult.output : 'unknown';
            
            return { 
                success: true, 
                message: `Time synchronization completed successfully using ${service}${server ? ` (server: ${server})` : ''}`,
                current_time: currentTime,
                sync_output: syncResult.output
            };
        } else {
            console.error('❌ Time sync command failed:', syncResult.error);
            return { 
                success: false, 
                error: `Time synchronization failed: ${syncResult.error}` 
            };
        }

    } catch (error) {
        console.error('❌ Force time sync task exception:', error);
        return { success: false, error: `Force time sync task failed: ${error.message}` };
    }
};

/**
 * Execute timezone setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSetTimezoneTask = async (metadataJson) => {
    console.log('🔧 === SET TIMEZONE TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { timezone, backup_existing } = metadata;

        console.log('📋 Set timezone parameters:');
        console.log('   - timezone:', timezone);
        console.log('   - backup_existing:', backup_existing);

        const configFile = '/etc/default/init';

        // Validate timezone exists
        const zonePath = `/usr/share/lib/zoneinfo/${timezone}`;
        const validateResult = await executeCommand(`test -f ${zonePath}`);
        if (!validateResult.success) {
            return { 
                success: false, 
                error: `Invalid timezone: ${timezone} - timezone file not found at ${zonePath}` 
            };
        }

        console.log('✅ Timezone validated successfully');

        // Create backup if requested
        if (backup_existing) {
            const backupResult = await executeCommand(`pfexec cp ${configFile} ${configFile}.backup.$(date +%Y%m%d_%H%M%S)`);
            if (backupResult.success) {
                console.log('✅ Config backup created');
            } else {
                console.warn('⚠️  Failed to create backup:', backupResult.error);
            }
        }

        // Read current config
        const readResult = await executeCommand(`cat ${configFile}`);
        if (!readResult.success) {
            return { 
                success: false, 
                error: `Failed to read config file ${configFile}: ${readResult.error}` 
            };
        }

        // Update timezone in config
        let configContent = readResult.output;
        const tzPattern = /^TZ=.*$/m;
        
        if (tzPattern.test(configContent)) {
            // Replace existing TZ line
            configContent = configContent.replace(tzPattern, `TZ=${timezone}`);
            console.log('✅ Updated existing TZ line');
        } else {
            // Add TZ line
            configContent += `\nTZ=${timezone}\n`;
            console.log('✅ Added new TZ line');
        }

        // Write updated config
        const writeResult = await executeCommand(`echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`);
        
        if (!writeResult.success) {
            return { 
                success: false, 
                error: `Failed to write config file ${configFile}: ${writeResult.error}` 
            };
        }

        console.log('✅ Timezone config written successfully');

        // Verify the change
        const verifyResult = await executeCommand(`grep "^TZ=" ${configFile}`);
        const verifiedTz = verifyResult.success ? verifyResult.output : 'unknown';

        return { 
            success: true, 
            message: `Timezone set to ${timezone} successfully (reboot required for full effect)`,
            config_file: configFile,
            verified_setting: verifiedTz,
            requires_reboot: true,
            reboot_reason: 'Timezone change in /etc/default/init requires system reboot to take effect'
        };

    } catch (error) {
        console.error('❌ Set timezone task exception:', error);
        return { success: false, error: `Set timezone task failed: ${error.message}` };
    }
};

/**
 * Execute time sync system switching task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const executeSwitchTimeSyncSystemTask = async (metadataJson) => {
    console.log('🔧 === TIME SYNC SYSTEM SWITCH TASK STARTING ===');
    
    try {
        const metadata = await new Promise((resolve, reject) => {
            yj.parseAsync(metadataJson, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        });
        const { current_system, target_system, preserve_servers, install_if_needed, systems_info } = metadata;

        console.log('📋 Time sync system switch parameters:');
        console.log('   - current_system:', current_system);
        console.log('   - target_system:', target_system);
        console.log('   - preserve_servers:', preserve_servers);
        console.log('   - install_if_needed:', install_if_needed);

        let migratedServers = ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'];

        // Step 1: Extract servers from current config if requested
        if (preserve_servers && current_system !== 'none') {
            console.log('🔧 Attempting to extract servers from current configuration...');
            const currentInfo = systems_info.available[current_system];
            if (currentInfo && currentInfo.config_file) {
                const readConfigResult = await executeCommand(`cat ${currentInfo.config_file} 2>/dev/null || echo ""`);
                if (readConfigResult.success && readConfigResult.output.trim()) {
                    const extractedServers = extractServersFromConfig(readConfigResult.output, current_system);
                    if (extractedServers.length > 0) {
                        migratedServers = extractedServers;
                        console.log('✅ Extracted servers from current config:', migratedServers);
                    }
                } else {
                    console.log('⚠️  Could not read current config, using defaults');
                }
            }
        }

        // Step 2: Disable current service if active
        if (current_system !== 'none') {
            console.log(`🔧 Disabling current ${current_system} service...`);
            const disableResult = await executeCommand(`pfexec svcadm disable network/${current_system}`);
            if (!disableResult.success) {
                console.warn(`⚠️  Failed to disable ${current_system}:`, disableResult.error);
            } else {
                console.log(`✅ Current ${current_system} service disabled`);
            }
        }

        // Step 3: Handle target system installation and configuration
        if (target_system === 'none') {
            console.log('🔧 Target is "none" - time sync will be disabled');
            return { 
                success: true, 
                message: `Switched from ${current_system} to none (time sync disabled)`,
                current_system: 'none',
                original_system: current_system
            };
        }

        const targetInfo = systems_info.available[target_system];
        if (!targetInfo) {
            return { success: false, error: `Unknown target system: ${target_system}` };
        }

        // Step 4: Install target package if needed
        if (!targetInfo.installed && install_if_needed) {
            console.log(`🔧 Installing ${target_system} package (${targetInfo.package_name})...`);
            const installResult = await executeCommand(`pfexec pkg install ${targetInfo.package_name}`, 5 * 60 * 1000);
            if (!installResult.success) {
                // Rollback: re-enable original service
                if (current_system !== 'none') {
                    console.log(`🔄 Installation failed, rolling back to ${current_system}...`);
                    await executeCommand(`pfexec svcadm enable network/${current_system}`);
                }
                return { 
                    success: false, 
                    error: `Failed to install ${targetInfo.package_name}: ${installResult.error}`,
                    rollback_performed: current_system !== 'none'
                };
            }
            console.log(`✅ Package ${targetInfo.package_name} installed successfully`);
        }

        // Step 5: Generate configuration for target system
        console.log(`🔧 Generating configuration for ${target_system}...`);
        let configContent;
        try {
            configContent = generateConfigForSystem(target_system, migratedServers);
            console.log('✅ Configuration generated successfully');
        } catch (configError) {
            // Rollback: re-enable original service
            if (current_system !== 'none') {
                console.log(`🔄 Config generation failed, rolling back to ${current_system}...`);
                await executeCommand(`pfexec svcadm enable network/${current_system}`);
            }
            return { 
                success: false, 
                error: `Failed to generate configuration: ${configError.message}`,
                rollback_performed: current_system !== 'none'
            };
        }

        // Step 6: Write target configuration
        const configFile = targetInfo.config_file;
        console.log(`🔧 Writing configuration to ${configFile}...`);
        const writeResult = await executeCommand(`echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configFile}`);
        
        if (!writeResult.success) {
            // Rollback: re-enable original service
            if (current_system !== 'none') {
                console.log(`🔄 Config write failed, rolling back to ${current_system}...`);
                await executeCommand(`pfexec svcadm enable network/${current_system}`);
            }
            return { 
                success: false, 
                error: `Failed to write config file ${configFile}: ${writeResult.error}`,
                rollback_performed: current_system !== 'none'
            };
        }
        console.log('✅ Configuration written successfully');

        // Step 7: Enable target service
        console.log(`🔧 Enabling ${target_system} service...`);
        const enableResult = await executeCommand(`pfexec svcadm enable network/${target_system}`);
        
        if (!enableResult.success) {
            // Rollback: re-enable original service
            if (current_system !== 'none') {
                console.log(`🔄 Service enable failed, rolling back to ${current_system}...`);
                await executeCommand(`pfexec svcadm enable network/${current_system}`);
            }
            return { 
                success: false, 
                error: `Failed to enable ${target_system} service: ${enableResult.error}`,
                rollback_performed: current_system !== 'none'
            };
        }

        // Step 8: Verify service is running
        console.log(`🔧 Verifying ${target_system} service status...`);
        let verifyAttempts = 0;
        let serviceOnline = false;
        
        while (verifyAttempts < 10 && !serviceOnline) {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
            const statusResult = await executeCommand(`svcs network/${target_system}`);
            if (statusResult.success && statusResult.output.includes('online')) {
                serviceOnline = true;
                console.log(`✅ ${target_system} service is online`);
            } else {
                verifyAttempts++;
                console.log(`⏳ Waiting for ${target_system} service to come online (attempt ${verifyAttempts}/10)...`);
            }
        }

        if (!serviceOnline) {
            console.warn(`⚠️  ${target_system} service may not be fully online yet`);
        }

        // Step 9: Verify time sync is working (basic check)
        console.log(`🔧 Performing basic sync verification...`);
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
            sync_verification: syncWorking ? 'working' : 'unknown'
        };

        if (preserve_servers) {
            result.message += ` (${migratedServers.length} servers migrated)`;
        }
        
        if (!serviceOnline) {
            result.message += ' (service may need additional time to fully start)';
        }

        console.log(`✅ Time sync system switch completed: ${current_system} → ${target_system}`);
        return result;

    } catch (error) {
        console.error('❌ Time sync system switch task exception:', error);
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
        if (trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed.startsWith('%') || trimmed.startsWith(';')) {
            continue;
        }
        
        // Handle both 'server' and 'pool' directives
        if ((trimmed.startsWith('server ') || trimmed.startsWith('pool ')) && 
            !trimmed.includes('127.127.1.0') && !trimmed.includes('127.0.0.1')) {
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
 * Clean up old tasks based on retention policies
 * @description Removes completed, failed, and cancelled tasks older than the configured retention period
 */
export const cleanupOldTasks = async () => {
    try {
        const hostMonitoringConfig = config.getHostMonitoring();
        const retentionConfig = hostMonitoringConfig.retention;
        const now = new Date();

        // Clean up completed, failed, and cancelled tasks
        const tasksRetentionDate = new Date(now.getTime() - (retentionConfig.tasks * 24 * 60 * 60 * 1000));
        const deletedTasks = await Tasks.destroy({
            where: {
                status: { [Op.in]: ['completed', 'failed', 'cancelled'] },
                created_at: { [Op.lt]: tasksRetentionDate }
            }
        });

        if (deletedTasks > 0) {
            console.log(`🧹 Tasks cleanup completed: ${deletedTasks} old tasks deleted (older than ${retentionConfig.tasks} days)`);
        }

    } catch (error) {
        console.error('❌ Failed to cleanup old tasks:', error.message);
    }
};
