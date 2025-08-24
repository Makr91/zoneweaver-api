import { execSync, spawn } from "child_process";
import Zones from "../models/ZoneModel.js";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import VncSessions from "../models/VncSessionModel.js";
import yj from "yieldable-json";
import os from "os";

/**
 * @fileoverview Zone Management controller for Zoneweaver API
 * @description Handles zone lifecycle operations, configuration retrieval, and status management
 */

/**
 * Get current zone status from system (asynchronous)
 * @param {string} zoneName - Name of the zone
 * @returns {Promise<string>} Zone status
 */
const getSystemZoneStatus = async (zoneName) => {
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', `pfexec zoneadm -z ${zoneName} list -p`], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let completed = false;
        
        // 10 second timeout
        const timeoutId = setTimeout(() => {
            if (!completed) {
                completed = true;
                child.kill('SIGTERM');
                resolve('timeout');
            }
        }, 10000);
        
        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });
        
        child.on('close', (code) => {
            if (!completed) {
                completed = true;
                clearTimeout(timeoutId);
                
                if (code === 0) {
                    const parts = stdout.trim().split(':');
                    resolve(parts[2] || 'unknown');
                } else {
                    resolve('not_found');
                }
            }
        });
        
        child.on('error', () => {
            if (!completed) {
                completed = true;
                clearTimeout(timeoutId);
                resolve('not_found');
            }
        });
    });
};

/**
 * Validate zone name for security
 * @param {string} zoneName - Zone name to validate
 * @returns {boolean} True if valid
 */
const validateZoneName = (zoneName) => {
    // Allow alphanumeric, hyphens, underscores, dots
    const validPattern = /^[a-zA-Z0-9\-_.]+$/;
    return validPattern.test(zoneName) && zoneName.length <= 64;
};

/**
 * @swagger
 * /zones:
 *   get:
 *     summary: List all zones
 *     description: Retrieves a list of all zones with their current status and metadata
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [running, configured, installed, stopped]
 *         description: Filter zones by status
 *       - in: query
 *         name: orphaned
 *         schema:
 *           type: boolean
 *         description: Include orphaned zones
 *     responses:
 *       200:
 *         description: List of zones retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zones:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Zone'
 *                 total:
 *                   type: integer
 *                   description: Total number of zones
 *       500:
 *         description: Failed to retrieve zones
 */
export const listZones = async (req, res) => {
    try {
        const { status, orphaned } = req.query;
        const whereClause = {};
        
        if (status) {
            whereClause.status = status;
        }
        
        if (orphaned !== undefined) {
            whereClause.is_orphaned = orphaned === 'true';
        }
        
        const zones = await Zones.findAll({
            where: whereClause,
            order: [['name', 'ASC']]
        });
        
        res.json({
            zones: zones,
            total: zones.length
        });
        
    } catch (error) {
        console.error('Error listing zones:', error);
        res.status(500).json({ error: 'Failed to retrieve zones' });
    }
};

/**
 * @swagger
 * /zones/{zoneName}:
 *   get:
 *     summary: Get zone details
 *     description: Retrieves detailed information about a specific zone including full configuration
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: Zone details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zone_info:
 *                   $ref: '#/components/schemas/Zone'
 *                 configuration:
 *                   type: object
 *                   description: Full zone configuration from zadm
 *                 active_vnc_session:
 *                   $ref: '#/components/schemas/VncSession'
 *                 pending_tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to retrieve zone details
 */
export const getZoneDetails = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        
        // Get current system status
        const currentStatus = await getSystemZoneStatus(zoneName);
        
        // Update database if status changed
        if (currentStatus !== zone.status && currentStatus !== 'not_found') {
            await zone.update({ 
                status: currentStatus,
                last_seen: new Date(),
                is_orphaned: false
            });
        } else if (currentStatus === 'not_found') {
            await zone.update({ is_orphaned: true });
        }
        
        // Get detailed zone configuration from zadm (asynchronously)
        let configuration = {};
        let configError = null;
        
        try {
            console.log(`Getting configuration for zone: ${zoneName}`);
            const configResult = await new Promise((resolve) => {
                const child = spawn('sh', ['-c', `pfexec zadm show ${zoneName}`], {
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let stdout = '';
                let stderr = '';
                let completed = false;
                
                const timeoutId = setTimeout(() => {
                    if (!completed) {
                        completed = true;
                        child.kill('SIGTERM');
                        console.warn(`zadm show ${zoneName} timed out`);
                        resolve({ success: false, error: 'Command timed out after 10 seconds' });
                    }
                }, 10000);
                
                child.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                child.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                child.on('close', (code) => {
                    if (!completed) {
                        completed = true;
                        clearTimeout(timeoutId);
                        
                        console.log(`zadm show ${zoneName} completed with code ${code}`);
                        if (stdout) console.log(`zadm stdout: ${stdout.substring(0, 200)}...`);
                        if (stderr) console.log(`zadm stderr: ${stderr}`);
                        
                        if (code === 0) {
                            resolve({ success: true, output: stdout });
                        } else {
                            resolve({ success: false, error: stderr || `Exit code ${code}`, output: stdout });
                        }
                    }
                });
                
                child.on('error', (error) => {
                    if (!completed) {
                        completed = true;
                        clearTimeout(timeoutId);
                        console.error(`zadm show ${zoneName} process error:`, error.message);
                        resolve({ success: false, error: error.message });
                    }
                });
            });
            
            if (configResult.success && configResult.output) {
                try {
                    const configData = JSON.parse(configResult.output);
                    
                    // For single zone requests, zadm returns the config directly (not wrapped)
                    if (configData && typeof configData === 'object' && configData.zonename === zoneName) {
                        configuration = configData;
                        console.log(`Successfully loaded configuration for zone ${zoneName}`);
                        console.log(`Zone specs: RAM=${configData.ram}, vCPUs=${configData.vcpus}, Brand=${configData.brand}`);
                    } else if (configData && typeof configData === 'object') {
                        // Still use the config even if zonename doesn't match exactly
                        configuration = configData;
                        console.log(`Loaded configuration (zonename mismatch: expected ${zoneName}, got ${configData.zonename})`);
                        console.log(`Zone specs: RAM=${configData.ram}, vCPUs=${configData.vcpus}, Brand=${configData.brand}`);
                    } else {
                        console.warn(`Invalid configuration format for zone ${zoneName}`);
                        console.log(`Raw response type: ${typeof configData}`);
                        configError = 'Invalid configuration format returned by zadm';
                    }
                } catch (parseError) {
                    console.error(`Failed to parse zadm JSON output for ${zoneName}:`, parseError.message);
                    console.error(`Raw output: ${configResult.output.substring(0, 500)}...`);
                    configError = `Failed to parse zadm output: ${parseError.message}`;
                }
            } else {
                console.warn(`zadm show failed for zone ${zoneName}:`, configResult.error);
                configError = configResult.error || 'zadm command failed';
            }
        } catch (error) {
            console.error(`Exception getting configuration for zone ${zoneName}:`, error.message);
            configError = error.message;
        }
        
        // Get active VNC session if any
        let activeVncSession = null;
        try {
            const vncSession = await VncSessions.findOne({
                where: { zone_name: zoneName, status: 'active' }
            });
            if (vncSession) {
                activeVncSession = vncSession.toJSON();
                // Add console URL
                activeVncSession.console_url = `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`;
            }
        } catch (error) {
            console.warn(`Failed to get VNC session for zone ${zoneName}:`, error.message);
        }
        
        // Get pending tasks for this zone
        let pendingTasks = [];
        try {
            pendingTasks = await Tasks.findAll({
                where: { 
                    zone_name: zoneName,
                    status: ['pending', 'running']
                },
                order: [['created_at', 'DESC']],
                limit: 10
            });
        } catch (error) {
            console.warn(`Failed to get tasks for zone ${zoneName}:`, error.message);
        }
        
        // Refresh zone data after potential update
        await zone.reload();
        
        res.json({
            zone_info: zone.toJSON(),
            configuration: configuration,
            active_vnc_session: activeVncSession,
            pending_tasks: pendingTasks,
            system_status: currentStatus
        });
        
    } catch (error) {
        console.error('Error getting zone details:', error);
        res.status(500).json({ error: 'Failed to retrieve zone details' });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/config:
 *   get:
 *     summary: Get zone configuration
 *     description: Retrieves the complete zone configuration using zadm show
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: Zone configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zone_name:
 *                   type: string
 *                 configuration:
 *                   type: object
 *                   description: Complete zone configuration from zadm
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to retrieve zone configuration
 */
export const getZoneConfig = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Get zone configuration using zadm show (asynchronously)
        const configResult = await new Promise((resolve) => {
            const child = spawn('sh', ['-c', `pfexec zadm show ${zoneName}`], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stdout = '';
            let stderr = '';
            let completed = false;
            
            const timeoutId = setTimeout(() => {
                if (!completed) {
                    completed = true;
                    child.kill('SIGTERM');
                    resolve({ success: false, error: 'Timeout' });
                }
            }, 10000);
            
            child.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            
            child.on('close', (code) => {
                if (!completed) {
                    completed = true;
                    clearTimeout(timeoutId);
                    
                    if (code === 0) {
                        resolve({ success: true, output: stdout });
                    } else {
                        resolve({ success: false, error: stderr || `Exit code ${code}` });
                    }
                }
            });
            
            child.on('error', (error) => {
                if (!completed) {
                    completed = true;
                    clearTimeout(timeoutId);
                    resolve({ success: false, error: error.message });
                }
            });
        });
        
        if (!configResult.success) {
            if (configResult.error.includes('does not exist')) {
                return res.status(404).json({ error: 'Zone not found' });
            } else {
                return res.status(500).json({ 
                    error: 'Failed to retrieve zone configuration',
                    details: configResult.error
                });
            }
        }
        
        const config = JSON.parse(configResult.output);
        
        res.json({
            zone_name: zoneName,
            configuration: config  // zadm show zonename returns config directly, not wrapped
        });
        
    } catch (error) {
        console.error('Error getting zone config:', error);
        res.status(500).json({ error: 'Failed to retrieve zone configuration' });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/start:
 *   post:
 *     summary: Start zone
 *     description: Queues a task to start the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to start
 *     responses:
 *       200:
 *         description: Start task queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 task_id:
 *                   type: string
 *                 zone_name:
 *                   type: string
 *                 operation:
 *                   type: string
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid zone name or zone already running
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue start task
 */
export const startZone = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Check if zone exists in database
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        
        // Get current system status
        const currentStatus = await getSystemZoneStatus(zoneName);
        
        // If already running, no need to start
        if (currentStatus === 'running') {
            return res.json({
                success: true,
                zone_name: zoneName,
                operation: 'start',
                status: 'already_running',
                message: 'Zone is already running'
            });
        }
        
        // Check for existing pending/running start tasks
        const existingTask = await Tasks.findOne({
            where: {
                zone_name: zoneName,
                operation: 'start',
                status: ['pending', 'running']
            }
        });
        
        if (existingTask) {
            return res.json({
                success: true,
                task_id: existingTask.id,
                zone_name: zoneName,
                operation: 'start',
                status: existingTask.status,
                message: 'Start task already queued'
            });
        }
        
        // Create new start task
        const task = await Tasks.create({
            zone_name: zoneName,
            operation: 'start',
            priority: TaskPriority.MEDIUM,
            created_by: req.entity.name,
            status: 'pending'
        });
        
        res.json({
            success: true,
            task_id: task.id,
            zone_name: zoneName,
            operation: 'start',
            status: 'pending',
            message: 'Start task queued successfully'
        });
        
    } catch (error) {
        console.error('Error starting zone:', error);
        res.status(500).json({ error: 'Failed to queue start task' });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/stop:
 *   post:
 *     summary: Stop zone
 *     description: Queues a task to stop the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to stop
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force shutdown (halt instead of graceful shutdown)
 *     responses:
 *       200:
 *         description: Stop task queued successfully
 *       400:
 *         description: Invalid zone name or zone already stopped
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue stop task
 */
export const stopZone = async (req, res) => {
    try {
        const { zoneName } = req.params;
        const { force = false } = req.query;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        
        const currentStatus = await getSystemZoneStatus(zoneName);
        
        // If already stopped, no need to stop
        if (currentStatus === 'configured' || currentStatus === 'installed') {
            return res.json({
                success: true,
                zone_name: zoneName,
                operation: 'stop',
                status: 'already_stopped',
                message: 'Zone is already stopped'
            });
        }
        
        // Cancel any pending start tasks for this zone
        await Tasks.update(
            { status: 'cancelled' },
            {
                where: {
                    zone_name: zoneName,
                    operation: 'start',
                    status: 'pending'
                }
            }
        );
        
        // Check for existing stop task
        const existingTask = await Tasks.findOne({
            where: {
                zone_name: zoneName,
                operation: 'stop',
                status: ['pending', 'running']
            }
        });
        
        if (existingTask) {
            return res.json({
                success: true,
                task_id: existingTask.id,
                zone_name: zoneName,
                operation: 'stop',
                status: existingTask.status,
                message: 'Stop task already queued'
            });
        }
        
        const task = await Tasks.create({
            zone_name: zoneName,
            operation: 'stop',
            priority: TaskPriority.HIGH,
            created_by: req.entity.name,
            status: 'pending'
        });
        
        res.json({
            success: true,
            task_id: task.id,
            zone_name: zoneName,
            operation: 'stop',
            status: 'pending',
            message: 'Stop task queued successfully',
            force: force
        });
        
    } catch (error) {
        console.error('Error stopping zone:', error);
        res.status(500).json({ error: 'Failed to queue stop task' });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/restart:
 *   post:
 *     summary: Restart zone
 *     description: Queues tasks to stop and then start the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to restart
 *     responses:
 *       200:
 *         description: Restart tasks queued successfully
 *       400:
 *         description: Invalid zone name
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue restart tasks
 */
export const restartZone = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        
        // Create stop task
        const stopTask = await Tasks.create({
            zone_name: zoneName,
            operation: 'stop',
            priority: TaskPriority.HIGH,
            created_by: req.entity.name,
            status: 'pending'
        });
        
        // Create start task that depends on stop task
        const startTask = await Tasks.create({
            zone_name: zoneName,
            operation: 'start',
            priority: TaskPriority.MEDIUM,
            created_by: req.entity.name,
            depends_on: stopTask.id,
            status: 'pending'
        });
        
        res.json({
            success: true,
            restart_tasks: {
                stop_task_id: stopTask.id,
                start_task_id: startTask.id
            },
            zone_name: zoneName,
            operation: 'restart',
            status: 'pending',
            message: 'Restart tasks queued successfully'
        });
        
    } catch (error) {
        console.error('Error restarting zone:', error);
        res.status(500).json({ error: 'Failed to queue restart tasks' });
    }
};

/**
 * @swagger
 * /zones/{zoneName}:
 *   delete:
 *     summary: Delete zone
 *     description: Queues tasks to stop, uninstall, and delete the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if zone is running
 *     responses:
 *       200:
 *         description: Delete tasks queued successfully
 *       400:
 *         description: Invalid zone name or zone is running without force
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue delete tasks
 */
export const deleteZone = async (req, res) => {
    try {
        const { zoneName } = req.params;
        const { force = false } = req.query;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        
        const currentStatus = await getSystemZoneStatus(zoneName);
        
        let tasks = [];
        
        // If zone is running and force is not specified, require explicit force
        if (currentStatus === 'running' && !force) {
            return res.status(400).json({ 
                error: 'Zone is running. Use force=true to stop and delete',
                current_status: currentStatus
            });
        }
        
        // If zone is running, create stop task first
        if (currentStatus === 'running') {
            const stopTask = await Tasks.create({
                zone_name: zoneName,
                operation: 'stop',
                priority: TaskPriority.CRITICAL,
                created_by: req.entity.name,
                status: 'pending'
            });
            tasks.push(stopTask);
            
            // Create delete task that depends on stop
            const deleteTask = await Tasks.create({
                zone_name: zoneName,
                operation: 'delete',
                priority: TaskPriority.CRITICAL,
                created_by: req.entity.name,
                depends_on: stopTask.id,
                status: 'pending'
            });
            tasks.push(deleteTask);
        } else {
            // Zone is not running, just delete
            const deleteTask = await Tasks.create({
                zone_name: zoneName,
                operation: 'delete',
                priority: TaskPriority.CRITICAL,
                created_by: req.entity.name,
                status: 'pending'
            });
            tasks.push(deleteTask);
        }
        
        res.json({
            success: true,
            delete_tasks: tasks.map(t => t.id),
            zone_name: zoneName,
            operation: 'delete',
            status: 'pending',
            message: 'Delete tasks queued successfully',
            force: force
        });
        
    } catch (error) {
        console.error('Error deleting zone:', error);
        res.status(500).json({ error: 'Failed to queue delete tasks' });
    }
};
