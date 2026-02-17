/**
 * @fileoverview Settings Management Controller for Zoneweaver API
 * @description Handles getting and updating application configuration
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import { promises as fs } from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';

// Get config path from environment variable (set by SMF) or fallback to local config
const getConfigPath = () =>
  process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');
const configPath = getConfigPath();
const backupDir = path.join(path.dirname(configPath), 'backups');

/**
 * Static schema describing all configuration sections, their properties,
 * types, descriptions, defaults, valid ranges, and restart requirements.
 */
const SETTINGS_SCHEMA = {
  server: {
    description: 'HTTP/HTTPS server configuration',
    requires_restart: true,
    properties: {
      http_port: {
        type: 'integer',
        description: 'HTTP server port',
        default: 5000,
        min: 1,
        max: 65535,
      },
      https_port: {
        type: 'integer',
        description: 'HTTPS server port',
        default: 5001,
        min: 1,
        max: 65535,
      },
    },
  },
  ssl: {
    description: 'SSL/TLS certificate configuration',
    requires_restart: true,
    properties: {
      enabled: { type: 'boolean', description: 'Enable HTTPS', default: true },
      generate_ssl: {
        type: 'boolean',
        description: 'Auto-generate self-signed SSL certificates',
        default: true,
      },
      key_path: {
        type: 'string',
        description: 'Path to SSL private key file',
        default: '/etc/zoneweaver-api/ssl/server.key',
      },
      cert_path: {
        type: 'string',
        description: 'Path to SSL certificate file',
        default: '/etc/zoneweaver-api/ssl/server.crt',
      },
    },
  },
  cors: {
    description: 'Cross-Origin Resource Sharing configuration',
    requires_restart: true,
    properties: {
      whitelist: {
        type: 'array',
        items: 'string',
        description: 'Allowed origins for CORS requests',
        default: [],
      },
    },
  },
  database: {
    description: 'Database connection configuration',
    requires_restart: true,
    properties: {
      dialect: {
        type: 'string',
        description: 'Database dialect',
        default: 'sqlite',
        enum: ['sqlite'],
      },
      storage: {
        type: 'string',
        description: 'SQLite database file path',
        default: '/var/lib/zoneweaver-api/database/database.sqlite',
      },
      logging: { type: 'boolean', description: 'Enable SQL query logging', default: false },
    },
  },
  api_keys: {
    description: 'API key authentication configuration',
    requires_restart: false,
    properties: {
      bootstrap_enabled: {
        type: 'boolean',
        description: 'Enable bootstrap key generation endpoint',
        default: true,
      },
      bootstrap_auto_disable: {
        type: 'boolean',
        description: 'Auto-disable bootstrap after first key generation',
        default: true,
      },
      key_length: {
        type: 'integer',
        description: 'Random byte length for API key generation',
        default: 64,
        min: 32,
        max: 256,
      },
      hash_rounds: {
        type: 'integer',
        description: 'bcrypt hash rounds for API key storage',
        default: 12,
        min: 4,
        max: 31,
      },
    },
  },
  stats: {
    description: 'Server statistics endpoint configuration',
    requires_restart: true,
    properties: {
      public_access: {
        type: 'boolean',
        description: 'Allow unauthenticated access to /stats endpoint',
        default: false,
      },
    },
  },
  zones: {
    description: 'Zone management configuration',
    requires_restart: false,
    properties: {
      discovery_interval: {
        type: 'integer',
        description: 'Seconds between automatic zone discovery scans',
        default: 300,
        min: 10,
      },
      auto_discovery: {
        type: 'boolean',
        description: 'Enable automatic zone discovery',
        default: true,
      },
      max_concurrent_tasks: {
        type: 'integer',
        description: 'Maximum concurrent zone operations',
        default: 5,
        min: 1,
        max: 50,
      },
      task_timeout: {
        type: 'integer',
        description: 'Task execution timeout in seconds',
        default: 300,
        min: 30,
      },
      orphan_retention: {
        type: 'integer',
        description: 'Days to keep orphaned zones in database',
        default: 7,
        min: 1,
      },
      default_pagination_limit: {
        type: 'integer',
        description: 'Default items per page for list endpoints',
        default: 50,
        min: 10,
        max: 500,
      },
      server_id_start: {
        type: 'integer',
        description: 'Starting server_id for auto-generation (set per-host for HA/distributed)',
        default: 1,
        min: 1,
      },
      prefix_zone_names: {
        type: 'boolean',
        description: 'Prefix zone names with server_id',
        default: true,
      },
      prefix_datasets: {
        type: 'boolean',
        description: 'Prefix dataset paths with server_id',
        default: true,
      },
    },
  },
  provisioning: {
    description: 'Zone provisioning configuration',
    requires_restart: true,
    properties: {
      install_tools: {
        type: 'boolean',
        description: 'Auto-install required tools (Ansible, rsync, git, dhcpd) on startup',
        default: true,
      },
      staging_path: {
        type: 'string',
        description: 'Path for provisioning staging files',
        default: '/var/lib/zoneweaver-api/provisioning',
      },
    },
  },
  cleanup: {
    description: 'Database cleanup service configuration',
    requires_restart: false,
    properties: {
      interval: {
        type: 'integer',
        description: 'Cleanup cycle interval in seconds',
        default: 300,
        min: 60,
      },
    },
  },
  vnc: {
    description: 'VNC console configuration',
    requires_restart: true,
    properties: {
      web_port_range_start: {
        type: 'integer',
        description: 'Starting port for noVNC web interfaces',
        default: 8000,
        min: 1024,
        max: 65535,
      },
      web_port_range_end: {
        type: 'integer',
        description: 'Ending port for noVNC web interfaces',
        default: 8100,
        min: 1024,
        max: 65535,
      },
      session_timeout: {
        type: 'integer',
        description: 'VNC session timeout in seconds',
        default: 1800,
        min: 60,
      },
      cleanup_interval: {
        type: 'integer',
        description: 'VNC session cleanup interval in seconds',
        default: 300,
        min: 60,
      },
      bind_address: {
        type: 'string',
        description: 'Bind address for VNC servers',
        default: '127.0.0.1',
      },
      max_concurrent_sessions: {
        type: 'integer',
        description: 'Maximum concurrent VNC sessions',
        default: 10,
        min: 1,
        max: 100,
      },
    },
  },
  host_monitoring: {
    description: 'Host monitoring and data collection configuration',
    requires_restart: true,
    properties: {
      enabled: { type: 'boolean', description: 'Enable host monitoring service', default: true },
      auto_enable_network_accounting: {
        type: 'boolean',
        description: 'Auto-enable network accounting on startup',
        default: true,
      },
      network_accounting_file: {
        type: 'string',
        description: 'Network accounting log file path',
        default: '/var/log/net.log',
      },
    },
  },
  logging: {
    description: 'Application logging configuration',
    requires_restart: true,
    properties: {
      level: {
        type: 'string',
        description: 'Default log level',
        default: 'warn',
        enum: ['error', 'warn', 'info', 'debug'],
      },
      console_enabled: { type: 'boolean', description: 'Enable console output', default: false },
      log_directory: {
        type: 'string',
        description: 'Log file directory',
        default: '/var/log/zoneweaver-api',
      },
      enable_compression: {
        type: 'boolean',
        description: 'Enable gzip compression of aged archive logs',
        default: true,
      },
      compression_age_days: {
        type: 'integer',
        description: 'Days before archived logs are compressed',
        default: 7,
        min: 1,
      },
      max_files: {
        type: 'integer',
        description: 'Maximum archived log files to keep per category',
        default: 30,
        min: 1,
      },
      performance_threshold_ms: {
        type: 'integer',
        description: 'Only log operations slower than this (ms)',
        default: 1000,
        min: 0,
      },
    },
  },
  reconciliation: {
    description: 'Zone reconciliation configuration',
    requires_restart: false,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable periodic zone reconciliation',
        default: true,
      },
      interval: {
        type: 'integer',
        description: 'Reconciliation interval in seconds',
        default: 3600,
        min: 60,
      },
      log_level: {
        type: 'string',
        description: 'Reconciliation log level',
        default: 'warn',
        enum: ['error', 'warn', 'info', 'debug'],
      },
    },
  },
  api_docs: {
    description: 'API documentation configuration',
    requires_restart: true,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable Swagger API documentation at /api-docs',
        default: true,
      },
    },
  },
  fault_management: {
    description: 'System fault management configuration',
    requires_restart: false,
    properties: {
      enabled: {
        type: 'boolean',
        description: 'Enable fault management monitoring',
        default: true,
      },
      cache_interval: {
        type: 'integer',
        description: 'Cache interval for fault data in seconds',
        default: 3600,
        min: 60,
      },
      timeout: {
        type: 'integer',
        description: 'Command timeout in seconds',
        default: 30,
        min: 5,
      },
      max_faults_displayed: {
        type: 'integer',
        description: 'Maximum faults to display',
        default: 50,
        min: 1,
      },
    },
  },
  system_logs: {
    description: 'System log viewing configuration',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable system log viewing', default: true },
      max_lines: {
        type: 'integer',
        description: 'Maximum lines to read from log files',
        default: 1000,
        min: 100,
      },
      default_tail_lines: {
        type: 'integer',
        description: 'Default number of lines for tail operations',
        default: 100,
        min: 10,
      },
      timeout: {
        type: 'integer',
        description: 'File read timeout in seconds',
        default: 30,
        min: 5,
      },
      max_concurrent_streams: {
        type: 'integer',
        description: 'Maximum concurrent WebSocket log streams',
        default: 10,
        min: 1,
      },
      stream_session_timeout: {
        type: 'integer',
        description: 'Log stream session timeout in seconds',
        default: 3600,
        min: 60,
      },
    },
  },
  file_browser: {
    description: 'File browser configuration',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable file browser', default: true },
      upload_size_limit_gb: {
        type: 'integer',
        description: 'Maximum file upload size in GB',
        default: 50,
        min: 1,
      },
    },
  },
  artifact_storage: {
    description: 'Artifact storage configuration for ISOs and VM images',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable artifact storage', default: true },
    },
  },
  template_sources: {
    description: 'Template source registry configuration',
    requires_restart: false,
    properties: {
      enabled: { type: 'boolean', description: 'Enable template sources', default: true },
      local_storage_path: {
        type: 'string',
        description: 'ZFS dataset path for local templates',
        default: 'rpool/templates',
      },
    },
  },
  updates: {
    description: 'Application update checking configuration',
    requires_restart: false,
    properties: {
      versioninfo_url: {
        type: 'string',
        description: 'URL to remote versioninfo.json for update checking',
        default: '',
      },
      check_interval: {
        type: 'integer',
        description: 'Automatic update check interval in seconds (0 to disable)',
        default: 0,
        min: 0,
      },
    },
  },
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
    log.app.info('Created config backup', {
      backup_path: backupPath,
      timestamp,
    });
  } catch (error) {
    log.app.error('Failed to create config backup', {
      error: error.message,
      stack: error.stack,
      backup_dir: backupDir,
    });
  }
};

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
 *         template_sources:
 *           type: object
 *           properties:
 *             enabled:
 *               type: boolean
 *             local_storage_path:
 *               type: string
 *             sources:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   name:
 *                     type: string
 *                   url:
 *                     type: string
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
  void req;
  try {
    // Return a sanitized version of the config, omitting sensitive details
    const currentConfig = config.getAll();

    if (!currentConfig) {
      return res
        .status(500)
        .json({ error: 'Failed to get settings', details: 'Configuration not loaded' });
    }

    const sanitizedConfig = await new Promise((resolve, reject) => {
      yj.stringifyAsync(currentConfig, (err, jsonString) => {
        if (err) {
          reject(err);
        } else {
          yj.parseAsync(jsonString, (parseErr, result) => {
            if (parseErr) {
              reject(parseErr);
            } else {
              resolve(result);
            }
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

    return res.json(sanitizedConfig);
  } catch (error) {
    log.api.error('Error getting settings', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to get settings', details: error.message });
  }
};

/**
 * @swagger
 * /settings/schema:
 *   get:
 *     summary: Get settings schema
 *     description: |
 *       Returns a JSON schema describing each configuration section, its properties,
 *       types, descriptions, defaults, valid ranges, and whether changes require a restart.
 *     tags: [Settings]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Settings schema retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: object
 *                 properties:
 *                   description:
 *                     type: string
 *                   requires_restart:
 *                     type: boolean
 *                   properties:
 *                     type: object
 */
export const getSettingsSchema = (req, res) => {
  void req;
  return res.json(SETTINGS_SCHEMA);
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

    return res.json({
      success: true,
      message: 'Settings updated successfully. Some changes may require a server restart.',
    });
  } catch (error) {
    log.api.error('Error updating settings', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to update settings', details: error.message });
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
  void req;
  try {
    await fs.mkdir(backupDir, { recursive: true });
    const timestamp = Date.now();
    const filename = `config-${timestamp}.yaml`;
    const backupPath = path.join(backupDir, filename);

    await fs.copyFile(configPath, backupPath);
    log.app.info('Created config backup', {
      backup_path: backupPath,
      filename,
      timestamp,
    });

    return res.json({
      success: true,
      message: 'Backup created successfully',
      backup: {
        filename,
        createdAt: new Date(timestamp).toISOString(),
      },
    });
  } catch (error) {
    log.api.error('Error creating backup', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({ error: 'Failed to create backup', details: error.message });
  }
};

export const listBackups = async (req, res) => {
  void req;
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
          createdAt: new Date(timestamp).toISOString(),
        };
      })
      .filter(backup => backup !== null)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json(backups);
  } catch (error) {
    log.api.error('Error listing backups', {
      error: error.message,
      stack: error.stack,
      backup_dir: backupDir,
    });
    return res.status(500).json({ error: 'Failed to list backups', details: error.message });
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
  const { filename } = req.params;

  try {
    // Basic security check to prevent path traversal
    if (filename.includes('..')) {
      return res.status(400).json({ error: 'Invalid filename' });
    }

    const backupPath = path.join(backupDir, filename);

    // Check if backup file exists
    await fs.access(backupPath);

    // Delete the file
    await fs.unlink(backupPath);

    return res.json({ success: true, message: `Backup ${filename} deleted successfully.` });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(404).json({ error: 'Backup not found' });
    }
    log.api.error('Error deleting backup', {
      error: error.message,
      stack: error.stack,
      filename,
    });
    return res.status(500).json({ error: 'Failed to delete backup', details: error.message });
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
  const { filename } = req.params;

  try {
    const backupPath = path.join(backupDir, filename);

    // Check if backup file exists
    await fs.access(backupPath);

    // Create a backup of the current config before restoring
    await createBackup();

    // Restore the backup
    await fs.copyFile(backupPath, configPath);

    // Reload the configuration
    config.load();

    return res.json({
      success: true,
      message: `Restored configuration from ${filename}. A server restart may be required.`,
    });
  } catch (error) {
    log.api.error('Error restoring backup', {
      error: error.message,
      stack: error.stack,
      filename,
    });
    return res.status(500).json({ error: 'Failed to restore backup', details: error.message });
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
 *       200:
 *         description: Server restart initiated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       500:
 *         description: Failed to initiate server restart
 */
export const restartServer = (req, res) => {
  void req;
  try {
    // Send success response immediately before initiating restart
    const response = res.json({
      success: true,
      message:
        'Server restart initiated. Please wait 30-60 seconds before reconnecting. The server will reload all configuration changes.',
    });

    // Schedule restart in detached process after response is sent
    // This ensures the HTTP response is delivered before the process is terminated
    setTimeout(() => {
      log.app.warn('Initiating server restart via SMF');

      // Import exec here to avoid loading it at module level
      import('child_process')
        .then(({ exec }) => {
          // Use pfexec to restart the SMF service in a detached process
          exec(
            'pfexec svcadm restart system/virtualization/zoneweaver-api',
            {
              detached: true,
              stdio: 'ignore',
            },
            (error, _stdout, _stderr) => {
              void _stdout;
              void _stderr;
              // This callback likely won't execute since the process will be killed
              // but we include it for completeness
              if (error) {
                log.app.error('Restart command error', {
                  error: error.message,
                });
              }
            }
          );
        })
        .catch(err => {
          log.app.error('Failed to import child_process for restart', {
            error: err.message,
          });
        });
    }, 1000); // 1 second delay to ensure HTTP response is fully sent

    return response;
  } catch (error) {
    log.api.error('Error initiating server restart', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      success: false,
      error: 'Failed to initiate server restart',
      details: error.message,
    });
  }
};
