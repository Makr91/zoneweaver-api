/**
 * @fileoverview ZFS ARC Configuration Controller for Zoneweaver API
 * @description Provides API endpoints for managing ZFS Adaptive Replacement Cache settings
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from "child_process";
import util from "util";
import os from "os";
import fs from "fs/promises";
import { setRebootRequired } from "../lib/RebootManager.js";

const execProm = util.promisify(exec);

/**
 * @swagger
 * /system/zfs/arc/config:
 *   get:
 *     summary: Get ZFS ARC configuration
 *     description: Returns current ZFS ARC settings, available tunables, and system constraints
 *     tags: [ZFS ARC Management]
 *     responses:
 *       200:
 *         description: ZFS ARC configuration data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current_config:
 *                   type: object
 *                   properties:
 *                     arc_size_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC size in bytes
 *                     arc_max_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC maximum size in bytes
 *                     arc_min_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC minimum size in bytes
 *                     arc_meta_used_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC metadata usage in bytes
 *                     arc_meta_limit_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC metadata limit in bytes
 *                 system_constraints:
 *                   type: object
 *                   properties:
 *                     physical_memory_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Total physical memory in bytes
 *                     max_safe_arc_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Maximum safe ARC size (85% of physical memory)
 *                     min_recommended_arc_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Minimum recommended ARC size
 *                 available_tunables:
 *                   type: object
 *                   description: Available ZFS ARC tunable parameters
 *                 config_source:
 *                   type: string
 *                   description: Source of current configuration
 *                 reboot_required:
 *                   type: boolean
 *                   description: Whether a reboot is required for persistent changes
 *       500:
 *         description: Failed to get ZFS ARC configuration
 */
export const getARCConfig = async (req, res) => {
    try {
        const hostname = os.hostname();

        // Get current ARC statistics
        const arcStats = await getCurrentARCStats();
        
        // Get system memory information
        const physicalMemoryBytes = await getPhysicalMemoryBytes();
        
        // Get ZFS tunable parameters
        const tunableParams = await getZFSTunableParams();
        
        // Check for persistent configuration
        const configInfo = await getPersistentConfigInfo();
        
        // Calculate system constraints
        const maxSafeARCBytes = Math.floor(physicalMemoryBytes * 0.85);
        const minRecommendedARCBytes = Math.floor(physicalMemoryBytes * 0.01);
        
        // Build available tunables info
        const availableTunables = {
            zfs_arc_max: {
                current_value: tunableParams.zfs_arc_max || 0,
                effective_value: arcStats.arc_max_bytes,
                min_safe: minRecommendedARCBytes,
                max_safe: maxSafeARCBytes,
                description: "Maximum ARC size in bytes (0 = auto-calculated)"
            },
            zfs_arc_min: {
                current_value: tunableParams.zfs_arc_min || 0,
                effective_value: arcStats.arc_min_bytes,
                min_safe: 134217728, // 128MB
                max_safe: Math.floor(physicalMemoryBytes * 0.1), // 10% of system memory
                description: "Minimum ARC size in bytes (0 = auto-calculated)"
            },
            zfs_arc_meta_limit: {
                current_value: tunableParams.zfs_arc_meta_limit || 0,
                effective_value: arcStats.arc_meta_limit_bytes,
                min_safe: 67108864, // 64MB
                max_safe: Math.floor(physicalMemoryBytes * 0.25), // 25% of system memory
                description: "ARC metadata limit in bytes (0 = auto-calculated)"
            },
            zfs_arc_meta_min: {
                current_value: tunableParams.zfs_arc_meta_min || 0,
                effective_value: arcStats.arc_meta_min_bytes,
                min_safe: 16777216, // 16MB
                max_safe: Math.floor(physicalMemoryBytes * 0.05), // 5% of system memory
                description: "Minimum ARC metadata size in bytes (0 = auto-calculated)"
            }
        };

        res.json({
            host: hostname,
            current_config: {
                arc_size_bytes: arcStats.arc_size_bytes,
                arc_max_bytes: arcStats.arc_max_bytes,
                arc_min_bytes: arcStats.arc_min_bytes,
                arc_meta_used_bytes: arcStats.arc_meta_used_bytes,
                arc_meta_limit_bytes: arcStats.arc_meta_limit_bytes,
                arc_meta_min_bytes: arcStats.arc_meta_min_bytes
            },
            system_constraints: {
                physical_memory_bytes: physicalMemoryBytes,
                max_safe_arc_bytes: maxSafeARCBytes,
                min_recommended_arc_bytes: minRecommendedARCBytes
            },
            available_tunables: availableTunables,
            config_source: configInfo.source,
            config_file_path: configInfo.filePath,
            reboot_required: configInfo.rebootRequired,
            last_collected: arcStats.scan_timestamp
        });

    } catch (error) {
        console.error('Error getting ZFS ARC configuration:', error);
        res.status(500).json({ 
            error: 'Failed to get ZFS ARC configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/zfs/arc/config:
 *   put:
 *     summary: Update ZFS ARC configuration
 *     description: Updates ZFS ARC settings with safety validations
 *     tags: [ZFS ARC Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               arc_max_gb:
 *                 type: number
 *                 description: ARC maximum size in GB
 *                 example: 153
 *               arc_min_gb:
 *                 type: number
 *                 description: ARC minimum size in GB
 *                 example: 4
 *               arc_max_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: ARC maximum size in bytes (alternative to arc_max_gb)
 *               arc_min_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: ARC minimum size in bytes (alternative to arc_min_gb)
 *               apply_method:
 *                 type: string
 *                 enum: [runtime, persistent, both]
 *                 default: both
 *                 description: How to apply the configuration
 *     responses:
 *       200:
 *         description: ARC configuration updated successfully
 *       400:
 *         description: Invalid configuration or safety check failed
 *       500:
 *         description: Failed to update ARC configuration
 */
export const updateARCConfig = async (req, res) => {
    try {
        const { 
            arc_max_gb, 
            arc_min_gb, 
            arc_max_bytes, 
            arc_min_bytes,
            apply_method = 'both'
        } = req.body;

        // Convert GB to bytes if provided in GB
        const arcMaxBytes = arc_max_bytes || (arc_max_gb ? arc_max_gb * (1024**3) : null);
        const arcMinBytes = arc_min_bytes || (arc_min_gb ? arc_min_gb * (1024**3) : null);

        if (!arcMaxBytes && !arcMinBytes) {
            return res.status(400).json({
                error: 'At least one parameter (arc_max or arc_min) must be provided'
            });
        }

        // Get system constraints for validation
        const physicalMemoryBytes = await getPhysicalMemoryBytes();
        const currentConfig = await getCurrentARCStats();
        
        // Perform validation
        const validationResult = await validateARCSettings({
            arc_max_bytes: arcMaxBytes || currentConfig.arc_max_bytes,
            arc_min_bytes: arcMinBytes || currentConfig.arc_min_bytes
        }, physicalMemoryBytes);

        if (!validationResult.valid) {
            return res.status(400).json({
                error: 'Configuration validation failed',
                details: validationResult.errors
            });
        }

        const results = {
            runtime_applied: false,
            persistent_applied: false,
            changes: [],
            warnings: validationResult.warnings || []
        };

        // Apply runtime configuration
        if (apply_method === 'runtime' || apply_method === 'both') {
            if (arcMaxBytes) {
                await applyRuntimeARCSetting('zfs_arc_max', arcMaxBytes);
                results.changes.push(`Runtime: Set ARC max to ${formatBytes(arcMaxBytes)}`);
            }
            if (arcMinBytes) {
                await applyRuntimeARCSetting('zfs_arc_min', arcMinBytes);
                results.changes.push(`Runtime: Set ARC min to ${formatBytes(arcMinBytes)}`);
            }
            results.runtime_applied = true;
        }

        // Apply persistent configuration  
        if (apply_method === 'persistent' || apply_method === 'both') {
            await applyPersistentARCSettings({
                arc_max_bytes: arcMaxBytes,
                arc_min_bytes: arcMinBytes
            });
            
            // Set reboot required flag
            await setRebootRequired('zfs_arc_config', 'ARCConfigController');
            
            if (arcMaxBytes) {
                results.changes.push(`Persistent: Set ARC max to ${formatBytes(arcMaxBytes)}`);
            }
            if (arcMinBytes) {
                results.changes.push(`Persistent: Set ARC min to ${formatBytes(arcMinBytes)}`);
            }
            results.persistent_applied = true;
            results.reboot_required = true;
        }

        // Trigger immediate ARC stats collection to update database
        try {
            const StorageCollector = (await import('./StorageCollector.js')).default;
            const collector = new StorageCollector();
            await collector.collectARCStats();
        } catch (collectionError) {
            console.warn('Failed to immediately update ARC stats data:', collectionError.message);
        }

        res.json({
            success: true,
            message: 'ZFS ARC configuration updated successfully',
            apply_method: apply_method,
            results: results
        });

    } catch (error) {
        console.error('Error updating ZFS ARC configuration:', error);
        res.status(500).json({ 
            error: 'Failed to update ZFS ARC configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/zfs/arc/validate:
 *   post:
 *     summary: Validate ZFS ARC configuration
 *     description: Validates proposed ZFS ARC settings without applying them
 *     tags: [ZFS ARC Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               arc_max_gb:
 *                 type: number
 *                 description: Proposed ARC maximum size in GB
 *               arc_min_gb:
 *                 type: number  
 *                 description: Proposed ARC minimum size in GB
 *               arc_max_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: Proposed ARC maximum size in bytes
 *               arc_min_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: Proposed ARC minimum size in bytes
 *     responses:
 *       200:
 *         description: Validation results
 *       500:
 *         description: Failed to validate configuration
 */
export const validateARCConfig = async (req, res) => {
    try {
        const { 
            arc_max_gb, 
            arc_min_gb, 
            arc_max_bytes, 
            arc_min_bytes
        } = req.body;

        // Convert GB to bytes if provided in GB
        const arcMaxBytes = arc_max_bytes || (arc_max_gb ? arc_max_gb * (1024**3) : null);
        const arcMinBytes = arc_min_bytes || (arc_min_gb ? arc_min_gb * (1024**3) : null);

        // Get current settings for comparison
        const currentConfig = await getCurrentARCStats();
        const physicalMemoryBytes = await getPhysicalMemoryBytes();

        const settingsToValidate = {
            arc_max_bytes: arcMaxBytes || currentConfig.arc_max_bytes,
            arc_min_bytes: arcMinBytes || currentConfig.arc_min_bytes
        };

        const validationResult = await validateARCSettings(settingsToValidate, physicalMemoryBytes);

        res.json({
            valid: validationResult.valid,
            errors: validationResult.errors || [],
            warnings: validationResult.warnings || [],
            proposed_settings: {
                arc_max_bytes: settingsToValidate.arc_max_bytes,
                arc_min_bytes: settingsToValidate.arc_min_bytes,
                arc_max_gb: (settingsToValidate.arc_max_bytes / (1024**3)).toFixed(2),
                arc_min_gb: (settingsToValidate.arc_min_bytes / (1024**3)).toFixed(2)
            },
            system_constraints: {
                physical_memory_bytes: physicalMemoryBytes,
                max_safe_arc_bytes: Math.floor(physicalMemoryBytes * 0.85),
                min_recommended_arc_bytes: Math.floor(physicalMemoryBytes * 0.01)
            }
        });

    } catch (error) {
        console.error('Error validating ZFS ARC configuration:', error);
        res.status(500).json({ 
            error: 'Failed to validate ZFS ARC configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/zfs/arc/reset:
 *   post:
 *     summary: Reset ZFS ARC configuration to defaults
 *     description: Resets ZFS ARC settings to system defaults
 *     tags: [ZFS ARC Management]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               apply_method:
 *                 type: string
 *                 enum: [runtime, persistent, both]
 *                 default: both
 *                 description: How to apply the reset
 *     responses:
 *       200:
 *         description: ARC configuration reset successfully
 *       500:
 *         description: Failed to reset ARC configuration
 */
export const resetARCConfig = async (req, res) => {
    try {
        const { apply_method = 'both' } = req.body;

        const results = {
            runtime_applied: false,
            persistent_applied: false,
            changes: []
        };

        // Apply runtime reset (set to 0 = auto-calculate)
        if (apply_method === 'runtime' || apply_method === 'both') {
            await applyRuntimeARCSetting('zfs_arc_max', 0);
            await applyRuntimeARCSetting('zfs_arc_min', 0);
            results.changes.push('Runtime: Reset ARC max and min to auto-calculated defaults');
            results.runtime_applied = true;
        }

        // Remove persistent configuration file
        if (apply_method === 'persistent' || apply_method === 'both') {
            const configPath = '/etc/system.d/zfs-arc.conf';
            try {
                await fs.unlink(configPath);
                results.changes.push(`Persistent: Removed configuration file ${configPath}`);
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    throw error;
                }
                results.changes.push(`Persistent: No configuration file to remove (${configPath})`);
            }
            
            // Set reboot required flag
            await setRebootRequired('zfs_arc_config', 'ARCConfigController');
            
            results.persistent_applied = true;
            results.reboot_required = true;
        }

        res.json({
            success: true,
            message: 'ZFS ARC configuration reset to defaults',
            apply_method: apply_method,
            results: results
        });

    } catch (error) {
        console.error('Error resetting ZFS ARC configuration:', error);
        res.status(500).json({ 
            error: 'Failed to reset ZFS ARC configuration',
            details: error.message 
        });
    }
};

/**
 * Helper function to get current ARC statistics
 * @returns {Object} Current ARC statistics
 */
async function getCurrentARCStats() {
    try {
        // Get latest ARC statistics from kstat
        const { stdout: kstatOutput } = await execProm('kstat -p zfs:0:arcstats:size zfs:0:arcstats:c zfs:0:arcstats:c_max zfs:0:arcstats:c_min zfs:0:arcstats:arc_meta_used zfs:0:arcstats:arc_meta_limit zfs:0:arcstats:arc_meta_min', { timeout: 10000 });
        
        const arcData = {};
        const lines = kstatOutput.trim().split('\n');
        
        lines.forEach(line => {
            const match = line.match(/^zfs:0:arcstats:(\S+)\s+(\d+)$/);
            if (match) {
                const [, param, value] = match;
                switch (param) {
                    case 'size':
                        arcData.arc_size_bytes = parseInt(value);
                        break;
                    case 'c':
                        arcData.arc_target_size_bytes = parseInt(value);
                        break;
                    case 'c_max':
                        arcData.arc_max_bytes = parseInt(value);
                        break;
                    case 'c_min':
                        arcData.arc_min_bytes = parseInt(value);
                        break;
                    case 'arc_meta_used':
                        arcData.arc_meta_used_bytes = parseInt(value);
                        break;
                    case 'arc_meta_limit':
                        arcData.arc_meta_limit_bytes = parseInt(value);
                        break;
                    case 'arc_meta_min':
                        arcData.arc_meta_min_bytes = parseInt(value);
                        break;
                }
            }
        });

        arcData.scan_timestamp = new Date().toISOString();
        return arcData;
        
    } catch (error) {
        console.error('Error getting current ARC stats:', error);
        throw new Error(`Failed to get ARC statistics: ${error.message}`);
    }
}

/**
 * Helper function to get physical memory in bytes
 * @returns {number} Physical memory in bytes
 */
async function getPhysicalMemoryBytes() {
    try {
        const { stdout } = await execProm('prtconf | grep "Memory size"', { timeout: 5000 });
        const match = stdout.match(/Memory size:\s*(\d+)\s*Megabytes/);
        
        if (!match) {
            throw new Error('Could not parse memory size from prtconf output');
        }
        
        return parseInt(match[1]) * 1024 * 1024; // Convert MB to bytes
        
    } catch (error) {
        console.error('Error getting physical memory:', error);
        throw new Error(`Failed to get physical memory: ${error.message}`);
    }
}

/**
 * Helper function to get ZFS tunable parameters
 * @returns {Object} ZFS tunable parameters
 */
async function getZFSTunableParams() {
    try {
        const { stdout } = await execProm('echo "::zfs_params" | pfexec mdb -k', { timeout: 15000 });
        
        const params = {};
        const lines = stdout.trim().split('\n');
        
        lines.forEach(line => {
            if (line.startsWith('mdb: variable') && line.includes('not found')) {
                // Skip missing variables
                return;
            }
            
            const match = line.match(/^(\w+)\s*=\s*0x([a-fA-F0-9]+)$/);
            if (match) {
                const [, paramName, hexValue] = match;
                params[paramName] = parseInt(hexValue, 16);
            }
        });
        
        return params;
        
    } catch (error) {
        console.warn('Error getting ZFS tunable parameters:', error.message);
        // Return empty object if we can't get tunables - not critical for basic functionality
        return {};
    }
}

/**
 * Helper function to get persistent configuration information
 * @returns {Object} Configuration source information
 */
async function getPersistentConfigInfo() {
    const configPath = '/etc/system.d/zfs-arc.conf';
    
    try {
        await fs.access(configPath);
        const stats = await fs.stat(configPath);
        return {
            source: `file: ${configPath}`,
            filePath: configPath,
            rebootRequired: false,
            lastModified: stats.mtime.toISOString()
        };
    } catch (error) {
        if (error.code === 'ENOENT') {
            return {
                source: 'auto-calculated',
                filePath: null,
                rebootRequired: false,
                lastModified: null
            };
        }
        throw error;
    }
}

/**
 * Helper function to validate ARC settings
 * @param {Object} settings - Settings to validate
 * @param {number} physicalMemoryBytes - Physical memory in bytes
 * @returns {Object} Validation result
 */
async function validateARCSettings(settings, physicalMemoryBytes) {
    const errors = [];
    const warnings = [];
    
    const maxSafeARC = Math.floor(physicalMemoryBytes * 0.85);
    const minRecommendedARC = Math.floor(physicalMemoryBytes * 0.01);
    
    // Validate ARC max
    if (settings.arc_max_bytes) {
        if (settings.arc_max_bytes > maxSafeARC) {
            errors.push(`ARC max ${formatBytes(settings.arc_max_bytes)} exceeds safe limit of ${formatBytes(maxSafeARC)} (85% of ${formatBytes(physicalMemoryBytes)} physical memory)`);
        }
        
        if (settings.arc_max_bytes < minRecommendedARC) {
            warnings.push(`ARC max ${formatBytes(settings.arc_max_bytes)} is below recommended minimum of ${formatBytes(minRecommendedARC)}`);
        }
    }
    
    // Validate ARC min
    if (settings.arc_min_bytes) {
        if (settings.arc_min_bytes < 134217728) { // 128MB
            errors.push(`ARC min ${formatBytes(settings.arc_min_bytes)} is below absolute minimum of 128MB`);
        }
        
        if (settings.arc_min_bytes > Math.floor(physicalMemoryBytes * 0.1)) {
            warnings.push(`ARC min ${formatBytes(settings.arc_min_bytes)} exceeds 10% of system memory`);
        }
    }
    
    // Validate relationship between min and max
    if (settings.arc_min_bytes && settings.arc_max_bytes) {
        if (settings.arc_min_bytes >= settings.arc_max_bytes) {
            errors.push(`ARC min ${formatBytes(settings.arc_min_bytes)} must be less than ARC max ${formatBytes(settings.arc_max_bytes)}`);
        }
    }
    
    return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined
    };
}

/**
 * Helper function to apply runtime ARC setting
 * @param {string} parameter - Parameter name (e.g., 'zfs_arc_max')
 * @param {number} value - Value to set
 */
async function applyRuntimeARCSetting(parameter, value) {
    try {
        const command = `echo "${parameter}/W0t${value}" | pfexec mdb -kw`;
        console.log(`Applying runtime ARC setting: ${command}`);
        
        const { stdout, stderr } = await execProm(command, { timeout: 10000 });
        
        if (stderr && stderr.trim()) {
            console.warn(`Runtime ARC setting stderr for ${parameter}:`, stderr);
        }
        
        console.log(`Successfully applied runtime setting: ${parameter} = ${value}`);
        
    } catch (error) {
        throw new Error(`Failed to apply runtime ARC setting ${parameter}: ${error.message}`);
    }
}

/**
 * Helper function to apply persistent ARC settings
 * @param {Object} settings - Settings to apply
 */
async function applyPersistentARCSettings(settings) {
    const configPath = '/etc/system.d/zfs-arc.conf';
    
    try {
        let configContent = `# ZFS ARC Configuration - Generated by Zoneweaver API\n`;
        configContent += `# Created: ${new Date().toISOString()}\n`;
        configContent += `# WARNING: This file is managed by the Zoneweaver API\n\n`;
        
        if (settings.arc_max_bytes) {
            configContent += `set zfs:zfs_arc_max = ${settings.arc_max_bytes}\n`;
        }
        
        if (settings.arc_min_bytes) {
            configContent += `set zfs:zfs_arc_min = ${settings.arc_min_bytes}\n`;
        }
        
        await fs.writeFile(configPath, configContent, 'utf8');
        console.log(`Successfully created persistent ARC configuration: ${configPath}`);
        
    } catch (error) {
        throw new Error(`Failed to create persistent ARC configuration: ${error.message}`);
    }
}

/**
 * Helper function to format bytes for human-readable output
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
function formatBytes(bytes) {
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    if (bytes === 0) return '0 B';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}
