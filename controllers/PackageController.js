/**
 * @fileoverview Package Management Controller for Zoneweaver API
 * @description Handles package management operations via pkg commands
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { execSync, spawn } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import os from "os";

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = 15 * 60 * 1000) => { // 15 minute default timeout
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
 * Parse pkg list output into structured format
 * @param {string} output - Raw pkg list output
 * @returns {Array} Array of package objects
 */
const parsePkgListOutput = (output) => {
    const lines = output.split('\n').filter(line => line.trim());
    const packages = [];
    
    // Skip header line if present
    let startIndex = 0;
    if (lines[0] && lines[0].startsWith('NAME')) {
        startIndex = 1;
    }
    
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            // Format: NAME (PUBLISHER) VERSION IFO
            const match = line.match(/^(\S+)(?:\s+\(([^)]+)\))?\s+(\S+)\s+(.*)$/);
            if (match) {
                const [, name, publisher, version, flags] = match;
                packages.push({
                    name: name,
                    publisher: publisher || null,
                    version: version,
                    flags: flags,
                    installed: flags.includes('i'),
                    frozen: flags.includes('f'),
                    manually_installed: flags.includes('m'),
                    obsolete: flags.includes('o'),
                    renamed: flags.includes('r')
                });
            }
        }
    }
    
    return packages;
};

/**
 * Parse pkg search output into structured format
 * @param {string} output - Raw pkg search output
 * @returns {Array} Array of search result objects
 */
const parsePkgSearchOutput = (output) => {
    const lines = output.split('\n').filter(line => line.trim());
    const results = [];
    
    // Skip header line if present
    let startIndex = 0;
    if (lines[0] && lines[0].startsWith('INDEX')) {
        startIndex = 1;
    }
    
    for (let i = startIndex; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line) {
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                results.push({
                    index: parts[0],
                    action: parts[1], 
                    value: parts[2],
                    package: parts[3]
                });
            }
        }
    }
    
    return results;
};

/**
 * @swagger
 * /system/packages:
 *   get:
 *     summary: List installed packages
 *     description: Returns a list of installed packages with their versions and status
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *         description: Filter packages by name pattern
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [default, parsable]
 *           default: default
 *         description: Output format
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include all packages (installed and available)
 *     responses:
 *       200:
 *         description: Package list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 packages:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       publisher:
 *                         type: string
 *                       version:
 *                         type: string
 *                       flags:
 *                         type: string
 *                       installed:
 *                         type: boolean
 *                       frozen:
 *                         type: boolean
 *                       manually_installed:
 *                         type: boolean
 *                       obsolete:
 *                         type: boolean
 *                       renamed:
 *                         type: boolean
 *                 total:
 *                   type: integer
 *                 format:
 *                   type: string
 *       500:
 *         description: Failed to list packages
 */
export const listPackages = async (req, res) => {
    try {
        const { filter, format = 'default', all = false } = req.query;
        
        let command = 'pfexec pkg list';
        
        if (all === 'true' || all === true) {
            command += ' -a';
        }
        
        if (format === 'parsable') {
            command += ' -H';
        }
        
        if (filter) {
            command += ` ${filter}`;
        }
        
        const result = await executeCommand(command);
        
        if (!result.success) {
            return res.status(500).json({
                error: 'Failed to list packages',
                details: result.error
            });
        }
        
        let packages;
        if (format === 'parsable') {
            // For parsable format, return raw lines
            packages = result.output.split('\n').filter(line => line.trim());
        } else {
            packages = parsePkgListOutput(result.output);
        }
        
        res.json({
            packages: packages,
            total: packages.length,
            format: format,
            filter: filter || null,
            all_packages: all === 'true' || all === true
        });
        
    } catch (error) {
        console.error('Error listing packages:', error);
        res.status(500).json({ 
            error: 'Failed to list packages',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/packages/search:
 *   get:
 *     summary: Search for packages
 *     description: Search for packages by name or description
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: query
 *         required: true
 *         schema:
 *           type: string
 *         description: Search query (package name or keyword)
 *       - in: query
 *         name: local
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Search only installed packages
 *       - in: query
 *         name: remote
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Search only remote repositories
 *     responses:
 *       200:
 *         description: Search results retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 results:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       index:
 *                         type: string
 *                       action:
 *                         type: string
 *                       value:
 *                         type: string
 *                       package:
 *                         type: string
 *                 total:
 *                   type: integer
 *                 query:
 *                   type: string
 *       400:
 *         description: Missing search query
 *       500:
 *         description: Failed to search packages
 */
export const searchPackages = async (req, res) => {
    try {
        const { query, local = false, remote = false } = req.query;
        
        if (!query) {
            return res.status(400).json({ 
                error: 'Search query is required' 
            });
        }
        
        let command = 'pfexec pkg search';
        
        if (local === 'true' || local === true) {
            command += ' -l';
        }
        
        if (remote === 'true' || remote === true) {
            command += ' -r';
        }
        
        command += ` ${query}`;
        
        const result = await executeCommand(command);
        
        if (!result.success) {
            return res.status(500).json({
                error: 'Failed to search packages',
                details: result.error
            });
        }
        
        const results = parsePkgSearchOutput(result.output);
        
        res.json({
            results: results,
            total: results.length,
            query: query,
            local: local === 'true' || local === true,
            remote: remote === 'true' || remote === true
        });
        
    } catch (error) {
        console.error('Error searching packages:', error);
        res.status(500).json({ 
            error: 'Failed to search packages',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/packages/info:
 *   get:
 *     summary: Get package information
 *     description: Get detailed information about a specific package
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: package
 *         required: true
 *         schema:
 *           type: string
 *         description: Package name or FMRI
 *       - in: query
 *         name: remote
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get info from remote repository
 *     responses:
 *       200:
 *         description: Package information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 package:
 *                   type: string
 *                 info:
 *                   type: string
 *                   description: Raw package information
 *       400:
 *         description: Missing package name
 *       500:
 *         description: Failed to get package information
 */
export const getPackageInfo = async (req, res) => {
    try {
        const { package: pkgName, remote = false } = req.query;
        
        if (!pkgName) {
            return res.status(400).json({ 
                error: 'Package name is required' 
            });
        }
        
        let command = 'pfexec pkg info';
        
        if (remote === 'true' || remote === true) {
            command += ' -r';
        }
        
        command += ` ${pkgName}`;
        
        const result = await executeCommand(command);
        
        if (!result.success) {
            return res.status(500).json({
                error: 'Failed to get package information',
                details: result.error
            });
        }
        
        res.json({
            package: pkgName,
            info: result.output,
            remote: remote === 'true' || remote === true
        });
        
    } catch (error) {
        console.error('Error getting package info:', error);
        res.status(500).json({ 
            error: 'Failed to get package information',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/packages/install:
 *   post:
 *     summary: Install package
 *     description: Install one or more packages
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - packages
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of package names to install
 *               accept_licenses:
 *                 type: boolean
 *                 default: false
 *                 description: Accept package licenses automatically
 *               dry_run:
 *                 type: boolean
 *                 default: false
 *                 description: Perform dry run without installing
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for installation
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Package installation task created successfully
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
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create installation task
 */
export const installPackages = async (req, res) => {
    try {
        const { 
            packages, 
            accept_licenses = false, 
            dry_run = false, 
            be_name, 
            created_by = 'api' 
        } = req.body;

        if (!packages || !Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({ 
                error: 'packages array is required and must not be empty' 
            });
        }

        // Create task for package installation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'pkg_install',
            priority: TaskPriority.MEDIUM,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                packages: packages,
                accept_licenses: accept_licenses,
                dry_run: dry_run,
                be_name: be_name
            })
        });

        res.status(202).json({
            success: true,
            message: `Package installation task created for ${packages.length} package(s)`,
            task_id: task.id,
            packages: packages,
            dry_run: dry_run
        });

    } catch (error) {
        console.error('Error installing packages:', error);
        res.status(500).json({ 
            error: 'Failed to create package installation task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/packages/uninstall:
 *   post:
 *     summary: Uninstall package
 *     description: Uninstall one or more packages
 *     tags: [Package Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - packages
 *             properties:
 *               packages:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: List of package names to uninstall
 *               dry_run:
 *                 type: boolean
 *                 default: false
 *                 description: Perform dry run without uninstalling
 *               be_name:
 *                 type: string
 *                 description: Boot environment name to create for uninstallation
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Package uninstallation task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create uninstallation task
 */
export const uninstallPackages = async (req, res) => {
    try {
        const { 
            packages, 
            dry_run = false, 
            be_name, 
            created_by = 'api' 
        } = req.body;

        if (!packages || !Array.isArray(packages) || packages.length === 0) {
            return res.status(400).json({ 
                error: 'packages array is required and must not be empty' 
            });
        }

        // Create task for package uninstallation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'pkg_uninstall',
            priority: TaskPriority.MEDIUM,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                packages: packages,
                dry_run: dry_run,
                be_name: be_name
            })
        });

        res.status(202).json({
            success: true,
            message: `Package uninstallation task created for ${packages.length} package(s)`,
            task_id: task.id,
            packages: packages,
            dry_run: dry_run
        });

    } catch (error) {
        console.error('Error uninstalling packages:', error);
        res.status(500).json({ 
            error: 'Failed to create package uninstallation task',
            details: error.message 
        });
    }
};
