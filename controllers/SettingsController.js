/**
 * @fileoverview Settings Management Controller for Zoneweaver API
 * @description Handles getting and updating application configuration
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import yj from 'yieldable-json';

// Get config path from environment variable (set by SMF) or fallback to local config
const getConfigPath = () => process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');
const configPath = getConfigPath();
const backupDir = path.join(path.dirname(configPath), 'backups');

/**
 * @swagger
 * tags:
 *   name: Settings
 *   description: Manage application configuration
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     AppConfig:
 *       type: object
 *       properties:
 *         server:
 *           type: object
 *           properties:
 *             http_port:
 *               type: integer
 *             https_port:
 *               type: integer
 *         ssl:
 *           type: object
 *           properties:
 *             key_path:
 *               type: string
 *             cert_path:
 *               type: string
 *         cors:
 *           type: object
 *           properties:
 *             whitelist:
 *               type: array
 *               items:
 *                 type: string
 *         database:
 *           type: object
 *           properties:
 *             dialect:
 *               type: string
 *             storage:
 *               type: string
 *             logging:
 *               type: boolean
 *         api_keys:
 *           type: object
 *           properties:
 *             bootstrap_enabled:
 *               type: boolean
 *             bootstrap_auto_disable:
 *               type: boolean
 *             key_length:
 *               type: integer
 *             hash_rounds:
 *               type: integer
 *         stats:
 *           type: object
 *           properties:
 *             public_access:
 *               type: boolean
 *         zones:
 *           type: object
 *         vnc:
 *           type: object
 *         host_monitoring:
 *           type: object
 */

/**
 * @swagger
 * /settings:
 *   get:
 *     summary: Get current application settings
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current application configuration
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AppConfig'
 *       500:
 *         description: Failed to get settings
 */
export const getSettings = async (req, res) => {
    try {
        // Return a sanitized version of the config, omitting sensitive details
        const currentConfig = config.getAll();

        if (!currentConfig) {
            return res.status(500).json({ error: 'Failed to get settings', details: 'Configuration not loaded' });
        }

        const sanitizedConfig = await new Promise((resolve, reject) => {
            yj.stringifyAsync(currentConfig, (err, jsonString) => {
                if (err) reject(err);
                else {
                    yj.parseAsync(jsonString, (err, result) => {
                        if (err) reject(err);
                        else resolve(result);
                    });
                }
            });
        });

        // Remove sensitive fields that should not be exposed to the frontend
        if (sanitizedConfig.database) {
            delete sanitizedConfig.database.password;
        }
        if (sanitizedConfig.api_keys) {
            // We might want to show some API key settings, but not all
        }

        res.json(sanitizedConfig);
    } catch (error) {
        console.error('Error getting settings:', error);
        res.status(500).json({ error: 'Failed to get settings', details: error.message });
    }
};

/**
 * @swagger
 * /settings:
 *   put:
 *     summary: Update application settings
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/AppConfig'
 *     responses:
 *       200:
 *         description: Settings updated successfully
 *       500:
 *         description: Failed to update settings
 */
export const updateSettings = async (req, res) => {
    try {
        const newSettings = req.body;

        // 1. Create a backup of the current config file
        await createBackup();

        // 2. Read the current config file
        const currentConfig = yaml.load(await fs.readFile(configPath, 'utf8'));

        // 3. Merge new settings into the current config (deep merge)
        const updatedConfig = { ...currentConfig, ...newSettings };

        // 4. Validate the new configuration (basic validation for now)
        if (!updatedConfig.server || !updatedConfig.server.http_port) {
            throw new Error('Invalid configuration: server.http_port is required');
        }

        // 5. Write the updated config to a temporary file
        const tempConfigPath = `${configPath}.tmp`;
        await fs.writeFile(tempConfigPath, yaml.dump(updatedConfig), 'utf8');

        // 6. Atomically replace the old config with the new one
        await fs.rename(tempConfigPath, configPath);

        // 7. Reload the configuration in the ConfigLoader
        config.load();

        res.json({ success: true, message: 'Settings updated successfully. Some changes may require a server restart.' });

    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ error: 'Failed to update settings', details: error.message });
    }
};

/**
 * Create a backup of the config.yaml file
 */
const createBackup = async () => {
    try {
        await fs.mkdir(backupDir, { recursive: true });
        const timestamp = Date.now();
        const backupPath = path.join(backupDir, `config-${timestamp}.yaml`);
        await fs.copyFile(configPath, backupPath);
        console.log(`Created config backup: ${backupPath}`);
    } catch (error) {
        console.error('Failed to create config backup:', error);
    }
};

/**
 * @swagger
 * /settings/backups:
 *   get:
 *     summary: List available configuration backups
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of configuration backups
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   filename:
 *                     type: string
 *                   createdAt:
 *                     type: string
 *                     format: date-time
 *       500:
 *         description: Failed to list backups
 */
/**
 * @swagger
 * /settings/backup:
 *   post:
 *     summary: Create a backup of the current configuration
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Backup created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 backup:
 *                   type: object
 *                   properties:
 *                     filename:
 *                       type: string
 *                     createdAt:
 *                       type: string
 *                       format: date-time
 *       500:
 *         description: Failed to create backup
 */
export const createConfigBackup = async (req, res) => {
    try {
        await fs.mkdir(backupDir, { recursive: true });
        const timestamp = Date.now();
        const filename = `config-${timestamp}.yaml`;
        const backupPath = path.join(backupDir, filename);
        
        await fs.copyFile(configPath, backupPath);
        console.log(`Created config backup: ${backupPath}`);
        
        res.json({ 
            success: true, 
            message: 'Backup created successfully',
            backup: {
                filename: filename,
                createdAt: new Date(timestamp).toISOString()
            }
        });
    } catch (error) {
        console.error('Error creating backup:', error);
        res.status(500).json({ error: 'Failed to create backup', details: error.message });
    }
};

export const listBackups = async (req, res) => {
    try {
        await fs.mkdir(backupDir, { recursive: true });
        const files = await fs.readdir(backupDir);
        const backups = files
            .filter(file => file.endsWith('.yaml'))
            .map(file => {
                // Extract timestamp from filename (config-1749723866123.yaml -> 1749723866123)
                const timestampStr = file.replace('config-', '').replace('.yaml', '');
                const timestamp = parseInt(timestampStr, 10);
                
                // Only include valid timestamps
                if (isNaN(timestamp)) {
                    return null;
                }
                
                return {
                    filename: file,
                    createdAt: new Date(timestamp).toISOString()
                };
            })
            .filter(backup => backup !== null)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        
        res.json(backups);
    } catch (error) {
        console.error('Error listing backups:', error);
        res.status(500).json({ error: 'Failed to list backups', details: error.message });
    }
};

/**
 * @swagger
 * /settings/backups/{filename}:
 *   delete:
 *     summary: Delete a specific configuration backup
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *         description: The filename of the backup to delete
 *     responses:
 *       200:
 *         description: Backup deleted successfully
 *       404:
 *         description: Backup not found
 *       500:
 *         description: Failed to delete backup
 */
export const deleteBackup = async (req, res) => {
    try {
        const { filename } = req.params;

        // Basic security check to prevent path traversal
        if (filename.includes('..')) {
            return res.status(400).json({ error: 'Invalid filename' });
        }

        const backupPath = path.join(backupDir, filename);

        // Check if backup file exists
        await fs.access(backupPath);

        // Delete the file
        await fs.unlink(backupPath);

        res.json({ success: true, message: `Backup ${filename} deleted successfully.` });

    } catch (error) {
        if (error.code === 'ENOENT') {
            return res.status(404).json({ error: 'Backup not found' });
        }
        console.error('Error deleting backup:', error);
        res.status(500).json({ error: 'Failed to delete backup', details: error.message });
    }
};

/**
 * @swagger
 * /settings/restore/{filename}:
 *   post:
 *     summary: Restore configuration from a backup
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: filename
 *         required: true
 *         schema:
 *           type: string
 *         description: The filename of the backup to restore
 *     responses:
 *       200:
 *         description: Configuration restored successfully
 *       500:
 *         description: Failed to restore backup
 */
export const restoreBackup = async (req, res) => {
    try {
        const { filename } = req.params;
        const backupPath = path.join(backupDir, filename);

        // Check if backup file exists
        await fs.access(backupPath);

        // Create a backup of the current config before restoring
        await createBackup();

        // Restore the backup
        await fs.copyFile(backupPath, configPath);

        // Reload the configuration
        config.load();

        res.json({ success: true, message: `Restored configuration from ${filename}. A server restart may be required.` });

    } catch (error) {
        console.error('Error restoring backup:', error);
        res.status(500).json({ error: 'Failed to restore backup', details: error.message });
    }
};

/**
 * @swagger
 * /server/restart:
 *   post:
 *     summary: Restart the server
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       501:
 *         description: Not Implemented
 */
export const restartServer = (req, res) => {
    res.status(501).json({ 
        message: 'Server restart functionality is not implemented in this version. Please restart the server manually.',
        details: 'This is a placeholder for future integration with a process manager like PM2 or systemd.'
    });
};
