/**
 * @fileoverview Repository Controller for Zoneweaver API
 * @description Handles package repository management operations via pkg publisher commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { spawn } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import yj from "yieldable-json";
import os from "os";

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = 30000) => {
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
 * Parse pkg publisher output into structured format
 * @param {string} output - Raw pkg publisher output
 * @returns {Array} Array of publisher objects
 */
const parsePublisherOutput = (output) => {
    const lines = output.split('\n').filter(line => line.trim());
    const publishers = [];
    
    // Skip header line if present
    let startIndex = 0;
    if (lines[0] && lines[0].startsWith('PUBLISHER')) {
        startIndex = 1;
    }
    
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            // Format: PUBLISHER TYPE STATUS P LOCATION
            // Use regex to properly handle whitespace and capture groups
            const match = line.match(/^(\S+)\s+(\S+(?:\s+\S+)*?)\s+(online|offline)\s+([FT-])\s+(.+)$/i);
            
            if (match) {
                publishers.push({
                    name: match[1],
                    type: match[2],
                    status: match[3],
                    proxy: match[4],
                    location: match[5]
                });
            } else {
                // Fallback to original parsing if regex doesn't match
                const parts = line.split(/\s+/);
                if (parts.length >= 5) {
                    publishers.push({
                        name: parts[0],
                        type: parts[1],
                        status: parts[2],
                        proxy: parts[3],
                        location: parts.slice(4).join(' ')
                    });
                }
            }
        }
    }
    
    return publishers;
};

/**
 * Parse pkg publisher -F tsv output into structured format
 * @param {string} output - Raw pkg publisher -F tsv output
 * @returns {Array} Array of detailed publisher objects
 */
const parsePublisherTsvOutput = (output) => {
    const lines = output.split('\n').filter(line => line.trim());
    const publishers = [];
    
    for (const line of lines) {
        const parts = line.split('\t');
        if (parts.length >= 5) {
            publishers.push({
                name: parts[0],
                sticky: parts[1] === 'true',
                syspub: parts[2] === 'true', 
                enabled: parts[3] === 'true',
                type: parts[4],
                status: parts[5],
                location: parts[6],
                proxy: parts[7] || null
            });
        }
    }
    
    return publishers;
};

/**
 * @swagger
 * /system/repositories:
 *   get:
 *     summary: List package repositories
 *     description: Returns a list of configured package repositories (publishers)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [default, tsv, detailed]
 *           default: default
 *         description: Output format
 *       - in: query
 *         name: enabled_only
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Show only enabled publishers
 *       - in: query
 *         name: publisher
 *         schema:
 *           type: string
 *         description: Filter by specific publisher name
 *     responses:
 *       200:
 *         description: Repository list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 publishers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                       status:
 *                         type: string
 *                       proxy:
 *                         type: string
 *                       location:
 *                         type: string
 *                       sticky:
 *                         type: boolean
 *                       enabled:
 *                         type: boolean
 *                 total:
 *                   type: integer
 *                 format:
 *                   type: string
 *       500:
 *         description: Failed to list repositories
 */
export const listRepositories = async (req, res) => {
    try {
        const { format = 'default', enabled_only = false, publisher } = req.query;
        
        let command = 'pfexec pkg publisher';
        
        if (enabled_only === 'true' || enabled_only === true) {
            command += ' -n';
        }
        
        if (format === 'tsv' || format === 'detailed') {
            command += ' -F tsv';
        }
        
        if (publisher) {
            command += ` ${publisher}`;
        }
        
        const result = await executeCommand(command);
        
        if (!result.success) {
            return res.status(500).json({
                error: 'Failed to list repositories',
                details: result.error
            });
        }
        
        let publishers;
        if (format === 'tsv' || format === 'detailed') {
            publishers = parsePublisherTsvOutput(result.output);
        } else {
            publishers = parsePublisherOutput(result.output);
        }
        
        res.json({
            publishers: publishers,
            total: publishers.length,
            format: format,
            enabled_only: enabled_only === 'true' || enabled_only === true,
            filter: publisher || null
        });
        
    } catch (error) {
        console.error('Error listing repositories:', error);
        res.status(500).json({ 
            error: 'Failed to list repositories',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/repositories:
 *   post:
 *     summary: Add package repository
 *     description: Add a new package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - origin
 *             properties:
 *               name:
 *                 type: string
 *                 description: Publisher name
 *               origin:
 *                 type: string
 *                 description: Repository origin URI
 *               mirrors:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Mirror URIs
 *               ssl_cert:
 *                 type: string
 *                 description: Path to SSL certificate
 *               ssl_key:
 *                 type: string
 *                 description: Path to SSL key
 *               enabled:
 *                 type: boolean
 *                 default: true
 *                 description: Enable the publisher
 *               sticky:
 *                 type: boolean
 *                 default: true
 *                 description: Make the publisher sticky
 *               search_first:
 *                 type: boolean
 *                 default: false
 *                 description: Set as first in search order
 *               search_before:
 *                 type: string
 *                 description: Position before this publisher in search order
 *               search_after:
 *                 type: string
 *                 description: Position after this publisher in search order
 *               properties:
 *                 type: object
 *                 description: Publisher properties to set
 *               proxy:
 *                 type: string
 *                 description: Proxy URI for this publisher
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Repository addition task created successfully
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
 *                 publisher_name:
 *                   type: string
 *                 origin:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create repository addition task
 */
export const addRepository = async (req, res) => {
    try {
        const { 
            name, 
            origin, 
            mirrors = [],
            ssl_cert,
            ssl_key,
            enabled = true,
            sticky = true,
            search_first = false,
            search_before,
            search_after,
            properties = {},
            proxy,
            created_by = 'api' 
        } = req.body;

        if (!name) {
            return res.status(400).json({ 
                error: 'Publisher name is required' 
            });
        }

        if (!origin) {
            return res.status(400).json({ 
                error: 'Origin URI is required' 
            });
        }

        // Validate name (basic validation)
        if (!/^[a-zA-Z0-9\-_.]+$/.test(name)) {
            return res.status(400).json({
                error: 'Publisher name contains invalid characters'
            });
        }

        // Create task for repository addition
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'repository_add',
            priority: TaskPriority.MEDIUM,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    name: name,
                    origin: origin,
                    mirrors: mirrors,
                    ssl_cert: ssl_cert,
                    ssl_key: ssl_key,
                    enabled: enabled,
                    sticky: sticky,
                    search_first: search_first,
                    search_before: search_before,
                    search_after: search_after,
                    properties: properties,
                    proxy: proxy
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Repository addition task created for publisher '${name}'`,
            task_id: task.id,
            publisher_name: name,
            origin: origin
        });

    } catch (error) {
        console.error('Error creating repository addition task:', error);
        res.status(500).json({ 
            error: 'Failed to create repository addition task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/repositories/{name}:
 *   delete:
 *     summary: Remove package repository
 *     description: Remove a package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to remove
 *     responses:
 *       202:
 *         description: Repository removal task created successfully
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
 *                 publisher_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create removal task
 */
export const removeRepository = async (req, res) => {
    try {
        const { name } = req.params;
        const { created_by = 'api' } = req.query;

        if (!name) {
            return res.status(400).json({ 
                error: 'Publisher name is required' 
            });
        }

        // Create task for repository removal
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'repository_remove',
            priority: TaskPriority.MEDIUM,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    name: name
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Repository removal task created for publisher '${name}'`,
            task_id: task.id,
            publisher_name: name
        });

    } catch (error) {
        console.error('Error creating repository removal task:', error);
        res.status(500).json({ 
            error: 'Failed to create repository removal task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/repositories/{name}:
 *   put:
 *     summary: Modify package repository
 *     description: Modify an existing package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               origins_to_add:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Origin URIs to add
 *               origins_to_remove:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Origin URIs to remove
 *               mirrors_to_add:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Mirror URIs to add
 *               mirrors_to_remove:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Mirror URIs to remove
 *               ssl_cert:
 *                 type: string
 *                 description: Path to SSL certificate
 *               ssl_key:
 *                 type: string
 *                 description: Path to SSL key
 *               enabled:
 *                 type: boolean
 *                 description: Enable/disable the publisher
 *               sticky:
 *                 type: boolean
 *                 description: Make the publisher sticky/non-sticky
 *               search_first:
 *                 type: boolean
 *                 description: Set as first in search order
 *               search_before:
 *                 type: string
 *                 description: Position before this publisher in search order
 *               search_after:
 *                 type: string
 *                 description: Position after this publisher in search order
 *               properties_to_set:
 *                 type: object
 *                 description: Publisher properties to set
 *               properties_to_unset:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Publisher properties to unset
 *               proxy:
 *                 type: string
 *                 description: Proxy URI for this publisher
 *               reset_uuid:
 *                 type: boolean
 *                 default: false
 *                 description: Generate new UUID for this image
 *               refresh:
 *                 type: boolean
 *                 default: false
 *                 description: Refresh publisher metadata after modification
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Repository modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create modification task
 */
export const modifyRepository = async (req, res) => {
    try {
        const { name } = req.params;
        const { 
            origins_to_add = [],
            origins_to_remove = [],
            mirrors_to_add = [],
            mirrors_to_remove = [],
            ssl_cert,
            ssl_key,
            enabled,
            sticky,
            search_first,
            search_before,
            search_after,
            properties_to_set = {},
            properties_to_unset = [],
            proxy,
            reset_uuid = false,
            refresh = false,
            created_by = 'api' 
        } = req.body;

        if (!name) {
            return res.status(400).json({ 
                error: 'Publisher name is required' 
            });
        }

        // Create task for repository modification
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'repository_modify',
            priority: TaskPriority.MEDIUM,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    name: name,
                    origins_to_add: origins_to_add,
                    origins_to_remove: origins_to_remove,
                    mirrors_to_add: mirrors_to_add,
                    mirrors_to_remove: mirrors_to_remove,
                    ssl_cert: ssl_cert,
                    ssl_key: ssl_key,
                    enabled: enabled,
                    sticky: sticky,
                    search_first: search_first,
                    search_before: search_before,
                    search_after: search_after,
                    properties_to_set: properties_to_set,
                    properties_to_unset: properties_to_unset,
                    proxy: proxy,
                    reset_uuid: reset_uuid,
                    refresh: refresh
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Repository modification task created for publisher '${name}'`,
            task_id: task.id,
            publisher_name: name
        });

    } catch (error) {
        console.error('Error creating repository modification task:', error);
        res.status(500).json({ 
            error: 'Failed to create repository modification task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/repositories/{name}/enable:
 *   post:
 *     summary: Enable package repository
 *     description: Enable a package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to enable
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Repository enable task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create enable task
 */
export const enableRepository = async (req, res) => {
    try {
        const { name } = req.params;
        const { created_by = 'api' } = req.body || {};

        if (!name) {
            return res.status(400).json({ 
                error: 'Publisher name is required' 
            });
        }

        // Create task for repository enabling
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'repository_enable',
            priority: TaskPriority.LOW,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    name: name
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Repository enable task created for publisher '${name}'`,
            task_id: task.id,
            publisher_name: name
        });

    } catch (error) {
        console.error('Error creating repository enable task:', error);
        res.status(500).json({ 
            error: 'Failed to create repository enable task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/repositories/{name}/disable:
 *   post:
 *     summary: Disable package repository
 *     description: Disable a package repository (publisher)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the publisher to disable
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Repository disable task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create disable task
 */
export const disableRepository = async (req, res) => {
    try {
        const { name } = req.params;
        const { created_by = 'api' } = req.body || {};

        if (!name) {
            return res.status(400).json({ 
                error: 'Publisher name is required' 
            });
        }

        // Create task for repository disabling
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'repository_disable',
            priority: TaskPriority.LOW,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    name: name
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Repository disable task created for publisher '${name}'`,
            task_id: task.id,
            publisher_name: name
        });

    } catch (error) {
        console.error('Error creating repository disable task:', error);
        res.status(500).json({ 
            error: 'Failed to create repository disable task',
            details: error.message 
        });
    }
};
