/**
 * @fileoverview System Update Controller for Zoneweaver API
 * @description Handles system update operations via pkg update commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { spawn } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import yj from "yieldable-json";
import os from "os";
import { log } from "../lib/Logger.js";

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = 20 * 60 * 1000) => { // 20 minute default timeout
    return new Promise((resolve) => {
        const child = spawn('sh', ['-c', command], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        let stdout = '';
        let stderr = '';
        let completed = false;
        
        const timeoutId = setTimeout(() => {
            if (!completed) {
                completed = true;
                child.kill('SIGTERM');
                resolve({
                    success: false,
                    error: `Command timed out after ${timeout}ms`,
                    output: stdout
                });
            }
        }, timeout);
        
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
                    resolve({
                        success: true,
                        output: stdout.trim()
                    });
                } else {
                    resolve({
                        success: false,
                        error: stderr.trim() || `Command exited with code ${code}`,
                        output: stdout.trim()
                    });
                }
            }
        });
        
        child.on('error', (error) => {
            if (!completed) {
                completed = true;
                clearTimeout(timeoutId);
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
 * Parse pkg update -n output to extract update information
 * @param {string} output - Raw pkg update -n output
 * @returns {Object} Parsed update information
 */
const parseUpdateCheckOutput = (output) => {
    const lines = output.split('\n').filter(line => line.trim());
    const updates = [];
    let planSummary = {
        packages_to_install: 0,
        packages_to_update: 0,
        packages_to_remove: 0,
        total_download_size: null,
        estimated_time: null
    };
    
    let inPackageList = false;
    
    for (const line of lines) {
        if (line.includes('Packages to install:') || line.includes('Packages to update:') || line.includes('Packages to remove:')) {
            inPackageList = true;
            continue;
        }
        
        // Parse summary information
        if (line.includes('packages to install')) {
            const match = line.match(/(\d+) packages? to install/);
            if (match) planSummary.packages_to_install = parseInt(match[1]);
        } else if (line.includes('packages to update')) {
            const match = line.match(/(\d+) packages? to update/);
            if (match) planSummary.packages_to_update = parseInt(match[1]);
        } else if (line.includes('packages to remove')) {
            const match = line.match(/(\d+) packages? to remove/);
            if (match) planSummary.packages_to_remove = parseInt(match[1]);
        } else if (line.includes('download size:') || line.includes('Download:')) {
            const match = line.match(/(\d+(?:\.\d+)?)\s*([KMGT]?B)/);
            if (match) planSummary.total_download_size = `${match[1]} ${match[2]}`;
        }
        
        // Parse individual package entries
        if (inPackageList && line.trim() && !line.includes('Plan Creation:') && !line.includes('State')) {
            const trimmed = line.trim();
            if (trimmed.match(/^\w/)) { // Likely a package name
                updates.push(trimmed);
            }
        }
        
        // Stop parsing packages when we hit plan summary
        if (line.includes('Plan Creation:') || line.includes('Download:') || line.includes('Space:')) {
            inPackageList = false;
        }
    }
    
    return {
        updates_available: updates.length > 0,
        total_updates: updates.length,
        packages: updates,
        plan_summary: planSummary,
        raw_output: output
    };
};

/**
 * @swagger
 * /system/updates/check:
 *   get:
 *     summary: Check for system updates
 *     description: Check for available system updates using pkg update -n (dry run)
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [structured, raw]
 *           default: structured
 *         description: Response format (structured or raw output)
 *     responses:
 *       200:
 *         description: Update check completed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updates_available:
 *                   type: boolean
 *                 total_updates:
 *                   type: integer
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: string
 *                 plan_summary:
 *                   type: object
 *                   properties:
 *                     packages_to_install:
 *                       type: integer
 *                     packages_to_update:
 *                       type: integer
 *                     packages_to_remove:
 *                       type: integer
 *                     total_download_size:
 *                       type: string
 *                 last_checked:
 *                   type: string
 *                   format: date-time
 *       500:
 *         description: Failed to check for updates
 */
export const checkForUpdates = async (req, res) => {
    try {
        const { format = 'structured' } = req.query;
        
        log.monitoring.info('Checking for system updates', {
            format: format
        });
        const result = await executeCommand('pfexec pkg update -n');
        
        if (format === 'raw') {
            return res.json({
                success: result.success,
                raw_output: result.output,
                error: result.error,
                last_checked: new Date().toISOString()
            });
        }
        
        if (!result.success) {
            // pkg update -n can return non-zero even when successful if no updates
            // Check if output contains useful information anyway
            if (result.output && (result.output.includes('No updates available') || result.output.includes('No packages installed'))) {
                return res.json({
                    updates_available: false,
                    total_updates: 0,
                    packages: [],
                    plan_summary: {
                        packages_to_install: 0,
                        packages_to_update: 0,
                        packages_to_remove: 0,
                        total_download_size: null
                    },
                    message: 'No updates available',
                    last_checked: new Date().toISOString()
                });
            }
            
            return res.status(500).json({
                error: 'Failed to check for updates',
                details: result.error,
                output: result.output
            });
        }
        
        const updateInfo = parseUpdateCheckOutput(result.output);
        
        res.json({
            ...updateInfo,
            last_checked: new Date().toISOString()
        });
        
    } catch (error) {
        log.monitoring.error('Error checking for updates', {
            error: error.message,
            stack: error.stack,
            format: format
        });
        res.status(500).json({ 
            error: 'Failed to check for updates',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/updates/install:
 *   post:
 *     summary: Install system updates
 *     description: Install available system updates using pkg update
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific packages to update (optional, updates all if not specified)
 *               accept_licenses:
 *                 type: boolean
 *                 default: false
 *                 description: Accept package licenses automatically
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for updates
 *               backup_be:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup boot environment
 *               reject_packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Package patterns to reject during update
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: System update task created successfully
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
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: string
 *       500:
 *         description: Failed to create update task
 */
export const installUpdates = async (req, res) => {
    try {
        const { 
            packages = [], 
            accept_licenses = false, 
            be_name, 
            backup_be = true,
            reject_packages = [],
            created_by = 'api' 
        } = req.body || {};

        // Create task for system update
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'pkg_update',
            priority: TaskPriority.HIGH,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    packages: packages,
                    accept_licenses: accept_licenses,
                    be_name: be_name,
                    backup_be: backup_be,
                    reject_packages: reject_packages
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: packages.length > 0 
                ? `System update task created for ${packages.length} specific package(s)`
                : 'System update task created for all available updates',
            task_id: task.id,
            packages: packages,
            backup_be: backup_be,
            be_name: be_name || 'auto-generated'
        });

    } catch (error) {
        log.api.error('Error creating system update task', {
            error: error.message,
            stack: error.stack,
            packages: packages,
            backup_be: backup_be,
            created_by: created_by
        });
        res.status(500).json({ 
            error: 'Failed to create system update task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/updates/history:
 *   get:
 *     summary: Get update history
 *     description: Get history of package operations using pkg history
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: Maximum number of history entries to return
 *       - in: query
 *         name: operation
 *         schema:
 *           type: string
 *           enum: [install, update, uninstall]
 *         description: Filter by operation type
 *     responses:
 *       200:
 *         description: Update history retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 history:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 raw_output:
 *                   type: string
 *       500:
 *         description: Failed to get update history
 */
export const getUpdateHistory = async (req, res) => {
    try {
        const { limit = 20, operation } = req.query;
        
        let command = 'pfexec pkg history -H';
        
        if (limit) {
            command += ` -n ${limit}`;
        }
        
        const result = await executeCommand(command);
        
        if (!result.success) {
            return res.status(500).json({
                error: 'Failed to get update history',
                details: result.error
            });
        }
        
        // Parse history output
        const lines = result.output.split('\n').filter(line => line.trim());
        const history = [];
        
        for (const line of lines) {
            const parts = line.split('\t');
            if (parts.length >= 4) {
                const entry = {
                    start_time: parts[0],
                    operation_name: parts[1],
                    client: parts[2],
                    outcome: parts[3]
                };
                
                // Filter by operation if specified
                if (!operation || entry.operation_name.toLowerCase().includes(operation.toLowerCase())) {
                    history.push(entry);
                }
            }
        }
        
        res.json({
            history: history,
            total: history.length,
            limit: parseInt(limit),
            operation_filter: operation || null,
            raw_output: result.output
        });
        
    } catch (error) {
        log.monitoring.error('Error getting update history', {
            error: error.message,
            stack: error.stack,
            limit: limit,
            operation: operation
        });
        res.status(500).json({ 
            error: 'Failed to get update history',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/updates/refresh:
 *   post:
 *     summary: Refresh package metadata
 *     description: Refresh package repository metadata using pkg refresh
 *     tags: [System Updates]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full:
 *                 type: boolean
 *                 default: false
 *                 description: Force full retrieval of all metadata
 *               publishers:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Specific publishers to refresh (optional)
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Metadata refresh task created successfully
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
 *       500:
 *         description: Failed to create refresh task
 */
export const refreshMetadata = async (req, res) => {
    try {
        const { 
            full = false, 
            publishers = [],
            created_by = 'api' 
        } = req.body || {};

        // Create task for metadata refresh
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'pkg_refresh',
            priority: TaskPriority.LOW,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    full: full,
                    publishers: publishers
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: publishers.length > 0 
                ? `Metadata refresh task created for ${publishers.length} publisher(s)`
                : 'Metadata refresh task created for all publishers',
            task_id: task.id,
            full: full,
            publishers: publishers
        });

    } catch (error) {
        log.api.error('Error creating metadata refresh task', {
            error: error.message,
            stack: error.stack,
            full: full,
            publishers: publishers,
            created_by: created_by
        });
        res.status(500).json({ 
            error: 'Failed to create metadata refresh task',
            details: error.message 
        });
    }
};
