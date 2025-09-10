/**
 * @fileoverview Process Controller for Zoneweaver API
 * @description Handles API requests for OmniOS process management
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import {
    getProcesses,
    getProcessDetails,
    signalProcess,
    killProcess,
    getProcessFiles,
    getProcessStack,
    getProcessLimits,
    findProcesses,
    killProcessesByPattern,
    getProcessStats
} from '../lib/ProcessManager.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import { log, createTimer } from '../lib/Logger.js';

/**
 * @swagger
 * tags:
 *   name: Processes
 *   description: Manage and monitor system processes
 */

/**
 * @swagger
 * /system/processes:
 *   get:
 *     summary: List system processes
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter processes by zone name
 *       - in: query
 *         name: user
 *         schema:
 *           type: string
 *         description: Filter processes by username
 *       - in: query
 *         name: command
 *         schema:
 *           type: string
 *         description: Filter processes by command pattern (regex)
 *       - in: query
 *         name: detailed
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed CPU and memory statistics (instant response using ps auxww)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 100
 *         description: Maximum number of processes to return
 *     responses:
 *       200:
 *         description: List of processes
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   pid:
 *                     type: integer
 *                     description: Process ID
 *                   ppid:
 *                     type: integer
 *                     description: Parent process ID
 *                   zone:
 *                     type: string
 *                     description: Zone name
 *                   username:
 *                     type: string
 *                     description: Process owner
 *                   command:
 *                     type: string
 *                     description: Command name
 *                   cpu_percent:
 *                     type: number
 *                     description: CPU usage percentage (if detailed=true)
 *                   memory_percent:
 *                     type: number
 *                     description: Memory usage percentage (if detailed=true)
 *                   vsz:
 *                     type: integer
 *                     description: Virtual memory size in KB (if detailed=true)
 *                   rss:
 *                     type: integer
 *                     description: Resident memory size in KB (if detailed=true)
 *                   state:
 *                     type: string
 *                     description: Process state (if detailed=true)
 *                   start_time:
 *                     type: string
 *                     description: Process start time (if detailed=true)
 *                   cpu_time:
 *                     type: string
 *                     description: Total CPU time used (if detailed=true)
 *       500:
 *         description: Failed to retrieve processes
 */
export const listProcesses = async (req, res) => {
    try {
        const options = {
            zone: req.query.zone,
            user: req.query.user,
            command: req.query.command,
            detailed: req.query.detailed === 'true',
            limit: req.query.limit ? parseInt(req.query.limit) : 100
        };

        const processes = await getProcesses(options);
        res.json(processes);
    } catch (error) {
        log.api.error('Error listing processes', {
            error: error.message,
            query_params: req.query
        });
        res.status(500).json({ error: 'Failed to retrieve processes' });
    }
};

/**
 * @swagger
 * /system/processes/{pid}:
 *   get:
 *     summary: Get detailed process information
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Process details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pid:
 *                   type: integer
 *                 ppid:
 *                   type: integer
 *                 zone:
 *                   type: string
 *                 command:
 *                   type: string
 *                 vsz:
 *                   type: integer
 *                   description: Virtual memory size
 *                 rss:
 *                   type: integer
 *                   description: Resident memory size
 *                 open_files_sample:
 *                   type: string
 *                   description: Sample of open files
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve process details
 */
export const getProcessDetailsController = async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (isNaN(pid)) {
            return res.status(400).json({ error: 'Invalid process ID' });
        }

        const processInfo = await getProcessDetails(pid);
        res.json(processInfo);
    } catch (error) {
        log.api.error('Error getting process details', {
            error: error.message,
            pid: req.params.pid
        });
        if (error.message.includes('not found')) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Failed to retrieve process details' });
        }
    }
};

/**
 * @swagger
 * /system/processes/{pid}/signal:
 *   post:
 *     summary: Send signal to process
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               signal:
 *                 type: string
 *                 enum: [TERM, KILL, HUP, INT, USR1, USR2, STOP, CONT]
 *                 default: TERM
 *                 description: Signal to send
 *     responses:
 *       200:
 *         description: Signal sent successfully
 *       400:
 *         description: Invalid process ID or signal
 *       500:
 *         description: Failed to send signal
 */
export const sendSignalToProcess = async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (isNaN(pid)) {
            return res.status(400).json({ error: 'Invalid process ID' });
        }

        const { signal = 'TERM' } = req.body;
        const result = await signalProcess(pid, signal);

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                pid: pid,
                signal: signal
            });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        log.api.error('Error sending signal to process', {
            error: error.message,
            pid: req.params.pid,
            signal: req.body.signal
        });
        res.status(500).json({ error: 'Failed to send signal to process' });
    }
};

/**
 * @swagger
 * /system/processes/{pid}/kill:
 *   post:
 *     summary: Kill a process
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: If true, send SIGKILL immediately instead of SIGTERM first
 *     responses:
 *       200:
 *         description: Process killed successfully
 *       400:
 *         description: Invalid process ID
 *       500:
 *         description: Failed to kill process
 */
export const killProcessController = async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (isNaN(pid)) {
            return res.status(400).json({ error: 'Invalid process ID' });
        }

        const { force = false } = req.body;
        const result = await killProcess(pid, force);

        if (result.success) {
            res.json({
                success: true,
                message: result.message,
                pid: pid,
                method: force ? 'SIGKILL' : 'SIGTERM'
            });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        log.api.error('Error killing process', {
            error: error.message,
            pid: req.params.pid,
            force: req.body.force
        });
        res.status(500).json({ error: 'Failed to kill process' });
    }
};

/**
 * @swagger
 * /system/processes/{pid}/files:
 *   get:
 *     summary: Get open files for process
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: List of open files
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   fd:
 *                     type: integer
 *                     description: File descriptor number
 *                   description:
 *                     type: string
 *                     description: File description
 *                   details:
 *                     type: string
 *                     description: Additional file details
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve process files
 */
export const getProcessFilesController = async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (isNaN(pid)) {
            return res.status(400).json({ error: 'Invalid process ID' });
        }

        const files = await getProcessFiles(pid);
        res.json(files);
    } catch (error) {
        log.api.error('Error getting process files', {
            error: error.message,
            pid: req.params.pid
        });
        if (error.message.includes('not found')) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Failed to retrieve process files' });
        }
    }
};

/**
 * @swagger
 * /system/processes/{pid}/stack:
 *   get:
 *     summary: Get process stack trace
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Process stack trace
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve stack trace
 */
export const getProcessStackController = async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (isNaN(pid)) {
            return res.status(400).json({ error: 'Invalid process ID' });
        }

        const stackTrace = await getProcessStack(pid);
        res.type('text/plain').send(stackTrace);
    } catch (error) {
        log.api.error('Error getting process stack', {
            error: error.message,
            pid: req.params.pid
        });
        if (error.message.includes('not found')) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Failed to retrieve stack trace' });
        }
    }
};

/**
 * @swagger
 * /system/processes/{pid}/limits:
 *   get:
 *     summary: Get process resource limits
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pid
 *         required: true
 *         schema:
 *           type: integer
 *         description: Process ID
 *     responses:
 *       200:
 *         description: Process resource limits
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: string
 *       404:
 *         description: Process not found
 *       500:
 *         description: Failed to retrieve process limits
 */
export const getProcessLimitsController = async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (isNaN(pid)) {
            return res.status(400).json({ error: 'Invalid process ID' });
        }

        const limits = await getProcessLimits(pid);
        res.json(limits);
    } catch (error) {
        log.api.error('Error getting process limits', {
            error: error.message,
            pid: req.params.pid
        });
        if (error.message.includes('not found')) {
            res.status(404).json({ error: error.message });
        } else {
            res.status(500).json({ error: 'Failed to retrieve process limits' });
        }
    }
};

/**
 * @swagger
 * /system/processes/find:
 *   get:
 *     summary: Find processes by pattern
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: pattern
 *         required: true
 *         schema:
 *           type: string
 *         description: Process name pattern
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone name
 *       - in: query
 *         name: user
 *         schema:
 *           type: string
 *         description: Filter by username
 *     responses:
 *       200:
 *         description: List of matching process IDs
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pattern:
 *                   type: string
 *                 pids:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 count:
 *                   type: integer
 *       400:
 *         description: Missing pattern parameter
 *       500:
 *         description: Failed to find processes
 */
export const findProcessesController = async (req, res) => {
    try {
        const { pattern, zone, user } = req.query;
        
        if (!pattern) {
            return res.status(400).json({ error: 'Pattern parameter is required' });
        }

        const options = {};
        if (zone) options.zone = zone;
        if (user) options.user = user;

        const pids = await findProcesses(pattern, options);
        res.json({
            pattern: pattern,
            pids: pids,
            count: pids.length,
            filters: options
        });
    } catch (error) {
        log.api.error('Error finding processes', {
            error: error.message,
            pattern: req.query.pattern
        });
        res.status(500).json({ error: 'Failed to find processes' });
    }
};

/**
 * @swagger
 * /system/processes/batch-kill:
 *   post:
 *     summary: Kill multiple processes by pattern
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pattern
 *             properties:
 *               pattern:
 *                 type: string
 *                 description: Process name pattern
 *               zone:
 *                 type: string
 *                 description: Filter by zone name
 *               user:
 *                 type: string
 *                 description: Filter by username
 *               signal:
 *                 type: string
 *                 enum: [TERM, KILL, HUP, INT, USR1, USR2, STOP, CONT]
 *                 default: TERM
 *                 description: Signal to send
 *     responses:
 *       200:
 *         description: Batch kill results
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 pattern:
 *                   type: string
 *                 killed:
 *                   type: array
 *                   items:
 *                     type: integer
 *                 errors:
 *                   type: array
 *                   items:
 *                     type: object
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing pattern parameter
 *       500:
 *         description: Failed to kill processes
 */
export const batchKillProcesses = async (req, res) => {
    try {
        const { pattern, zone, user, signal = 'TERM' } = req.body;
        
        if (!pattern) {
            return res.status(400).json({ error: 'Pattern parameter is required' });
        }

        const options = { signal };
        if (zone) options.zone = zone;
        if (user) options.user = user;

        const result = await killProcessesByPattern(pattern, options);
        
        res.json({
            ...result,
            pattern: pattern,
            signal: signal,
            filters: { zone, user }
        });
    } catch (error) {
        log.api.error('Error in batch kill processes', {
            error: error.message,
            pattern: req.body.pattern,
            signal: req.body.signal
        });
        res.status(500).json({ error: 'Failed to kill processes' });
    }
};

/**
 * @swagger
 * /system/processes/stats:
 *   get:
 *     summary: Get real-time process statistics
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone name
 *       - in: query
 *         name: interval
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 60
 *           default: 1
 *         description: Update interval in seconds
 *       - in: query
 *         name: count
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 10
 *           default: 1
 *         description: Number of samples to collect
 *     responses:
 *       200:
 *         description: Process statistics
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   pid:
 *                     type: integer
 *                   username:
 *                     type: string
 *                   cpu_percent:
 *                     type: number
 *                   size:
 *                     type: string
 *                   rss:
 *                     type: string
 *                   command:
 *                     type: string
 *       500:
 *         description: Failed to retrieve process statistics
 */
export const getProcessStatsController = async (req, res) => {
    try {
        const options = {
            zone: req.query.zone,
            interval: req.query.interval ? parseInt(req.query.interval) : 1,
            count: req.query.count ? parseInt(req.query.count) : 1
        };

        // Validate parameters
        if (options.interval < 1 || options.interval > 60) {
            return res.status(400).json({ error: 'Interval must be between 1 and 60 seconds' });
        }
        if (options.count < 1 || options.count > 10) {
            return res.status(400).json({ error: 'Count must be between 1 and 10' });
        }

        const stats = await getProcessStats(options);
        res.json(stats);
    } catch (error) {
        log.api.error('Error getting process statistics', {
            error: error.message,
            query_params: req.query
        });
        res.status(500).json({ error: 'Failed to retrieve process statistics' });
    }
};

/**
 * @swagger
 * /system/processes/trace/start:
 *   post:
 *     summary: Start process tracing (async task)
 *     tags: [Processes]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pid
 *             properties:
 *               pid:
 *                 type: integer
 *                 description: Process ID to trace
 *               duration:
 *                 type: integer
 *                 minimum: 5
 *                 maximum: 300
 *                 default: 30
 *                 description: Trace duration in seconds
 *     responses:
 *       200:
 *         description: Tracing task created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                 pid:
 *                   type: integer
 *       400:
 *         description: Invalid parameters
 *       500:
 *         description: Failed to create tracing task
 */
export const startProcessTrace = async (req, res) => {
    try {
        const { pid, duration = 30 } = req.body;
        
        if (!pid || isNaN(parseInt(pid))) {
            return res.status(400).json({ error: 'Valid process ID is required' });
        }
        
        if (duration < 5 || duration > 300) {
            return res.status(400).json({ error: 'Duration must be between 5 and 300 seconds' });
        }

        // Create a task for the tracing operation
        const task = await Tasks.create({
            zone_name: `process-${pid}`,
            operation: 'process_trace',
            priority: TaskPriority.BACKGROUND,
            created_by: req.entity.name,
            status: 'pending',
            metadata: JSON.stringify({ pid, duration })
        });

        res.json({
            success: true,
            message: `Process trace task created for PID ${pid}`,
            task_id: task.id,
            pid: parseInt(pid),
            duration: duration
        });
    } catch (error) {
        log.database.error('Error creating process trace task', {
            error: error.message,
            pid: req.body.pid,
            duration: req.body.duration,
            user: req.entity.name
        });
        res.status(500).json({ error: 'Failed to create tracing task' });
    }
};
