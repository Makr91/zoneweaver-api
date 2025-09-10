/**
 * @fileoverview Boot Environment Controller for Zoneweaver API
 * @description Handles boot environment management operations via beadm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { spawn } from 'child_process';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import os from 'os';
import { log } from '../lib/Logger.js';

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = 30000) =>
  new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
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
          output: stdout,
        });
      }
    }, timeout);

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);

        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
          });
        }
      }
    });

    child.on('error', error => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: error.message,
          output: stdout,
        });
      }
    });
  });

/**
 * Parse beadm list output into structured format
 * @param {string} output - Raw beadm list output
 * @returns {Array} Array of boot environment objects
 */
const parseBeadmListOutput = output => {
  const lines = output.split('\n').filter(line => line.trim());
  const bootEnvironments = [];

  // Skip header line if present
  let startIndex = 0;
  if (lines[0] && (lines[0].startsWith('BE') || lines[0].includes('Active'))) {
    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      // Format: BE Active Mountpoint Space Policy Created
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        const be = {
          name: parts[0],
          active: parts[1] || '-',
          mountpoint: parts[2] || '-',
          space: parts[3] || '-',
          policy: parts[4] || '-',
          created: parts[5] ? `${parts[5]} ${parts[6] || ''}`.trim() : '-',
          is_active_now: parts[1].includes('N'),
          is_active_on_reboot: parts[1].includes('R'),
          is_temporary: parts[1].includes('T'),
        };
        bootEnvironments.push(be);
      }
    }
  }

  return bootEnvironments;
};

/**
 * Parse beadm list -d output into structured format with datasets
 * @param {string} output - Raw beadm list -d output
 * @returns {Array} Array of boot environment objects with datasets
 */
const parseBeadmDetailedOutput = output => {
  const lines = output.split('\n').filter(line => line.trim());
  const bootEnvironments = [];
  let currentBE = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Skip header
    if (trimmed.startsWith('BE/Dataset') || trimmed.startsWith('--')) {
      continue;
    }

    // Check if this is a new BE (no leading spaces and only one part - the BE name)
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      // This is a BE name line (format: just the BE name on its own line)
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        // Create new BE with name only, metadata will come from first dataset
        currentBE = {
          name: parts[0],
          active: '-',
          mountpoint: '-',
          space: '-',
          policy: '-',
          created: '-',
          datasets: [],
          is_active_now: false,
          is_active_on_reboot: false,
          is_temporary: false,
        };
        bootEnvironments.push(currentBE);
      }
    } else if (currentBE && (line.startsWith('   ') || line.startsWith('\t'))) {
      // This is a dataset line - contains the actual metadata
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4) {
        const datasetInfo = {
          dataset: parts[0],
          active: parts[1] || '-',
          mountpoint: parts[2] || '-',
          space: parts[3] || '-',
          policy: parts[4] || '-',
          created: parts[5] ? `${parts[5]} ${parts[6] || ''}`.trim() : '-',
        };

        currentBE.datasets.push(datasetInfo);

        // Use the first dataset's metadata for the BE's main properties
        if (currentBE.datasets.length === 1) {
          currentBE.active = datasetInfo.active;
          currentBE.mountpoint = datasetInfo.mountpoint;
          currentBE.space = datasetInfo.space;
          currentBE.policy = datasetInfo.policy;
          currentBE.created = datasetInfo.created;
          currentBE.is_active_now = datasetInfo.active.includes('N');
          currentBE.is_active_on_reboot = datasetInfo.active.includes('R');
          currentBE.is_temporary = datasetInfo.active.includes('T');
        }
      }
    }
  }

  return bootEnvironments;
};

/**
 * @swagger
 * /system/boot-environments:
 *   get:
 *     summary: List boot environments
 *     description: Returns a list of boot environments with their status and metadata
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: detailed
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed dataset information
 *       - in: query
 *         name: snapshots
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include snapshot information
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by boot environment name
 *     responses:
 *       200:
 *         description: Boot environment list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 boot_environments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       active:
 *                         type: string
 *                       mountpoint:
 *                         type: string
 *                       space:
 *                         type: string
 *                       policy:
 *                         type: string
 *                       created:
 *                         type: string
 *                       is_active_now:
 *                         type: boolean
 *                       is_active_on_reboot:
 *                         type: boolean
 *                       is_temporary:
 *                         type: boolean
 *                       datasets:
 *                         type: array
 *                         items:
 *                           type: object
 *                 total:
 *                   type: integer
 *                 active_be:
 *                   type: string
 *       500:
 *         description: Failed to list boot environments
 */
export const listBootEnvironments = async (req, res) => {
  try {
    const { detailed = false, snapshots = false, name } = req.query;

    let command = 'pfexec beadm list';

    if (detailed === 'true' || detailed === true) {
      command += ' -d';
    }

    if (snapshots === 'true' || snapshots === true) {
      command += ' -s';
    }

    if (name) {
      command += ` ${name}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list boot environments',
        details: result.error,
      });
    }

    let bootEnvironments;
    if (detailed === 'true' || detailed === true) {
      bootEnvironments = parseBeadmDetailedOutput(result.output);
    } else {
      bootEnvironments = parseBeadmListOutput(result.output);
    }

    // Find active BE
    const activeBE = bootEnvironments.find(be => be.is_active_now);

    res.json({
      boot_environments: bootEnvironments,
      total: bootEnvironments.length,
      active_be: activeBE ? activeBE.name : null,
      detailed: detailed === 'true' || detailed === true,
      snapshots: snapshots === 'true' || snapshots === true,
      filter: name || null,
    });
  } catch (error) {
    log.api.error('Error listing boot environments', {
      error: error.message,
      stack: error.stack,
      detailed,
      snapshots,
      name,
    });
    res.status(500).json({
      error: 'Failed to list boot environments',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments:
 *   post:
 *     summary: Create boot environment
 *     description: Create a new boot environment
 *     tags: [Boot Environment Management]
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
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the new boot environment
 *               description:
 *                 type: string
 *                 description: Description for the boot environment
 *               source_be:
 *                 type: string
 *                 description: Source boot environment to clone from
 *               snapshot:
 *                 type: string
 *                 description: Snapshot to create BE from (format -- be@snapshot)
 *               activate:
 *                 type: boolean
 *                 default: false
 *                 description: Activate the new boot environment
 *               zpool:
 *                 type: string
 *                 description: ZFS pool to create the BE in
 *               properties:
 *                 type: object
 *                 description: ZFS properties to set
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Boot environment creation task created successfully
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
 *                 be_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create boot environment task
 */
export const createBootEnvironment = async (req, res) => {
  try {
    const {
      name,
      description,
      source_be,
      snapshot,
      activate = false,
      zpool,
      properties = {},
      created_by = 'api',
    } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    // Validate name (basic validation)
    if (!/^[a-zA-Z0-9\-_.]+$/.test(name)) {
      return res.status(400).json({
        error: 'Boot environment name contains invalid characters',
      });
    }

    // Create task for boot environment creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_create',
      priority: TaskPriority.MEDIUM,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            description,
            source_be,
            snapshot,
            activate,
            zpool,
            properties,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    res.status(202).json({
      success: true,
      message: `Boot environment creation task created for '${name}'`,
      task_id: task.id,
      be_name: name,
      activate,
    });
  } catch (error) {
    log.api.error('Error creating boot environment task', {
      error: error.message,
      stack: error.stack,
      name,
      activate,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create boot environment task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}:
 *   delete:
 *     summary: Delete boot environment
 *     description: Delete a boot environment
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion
 *       - in: query
 *         name: snapshots
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete all snapshots as well
 *     responses:
 *       202:
 *         description: Boot environment deletion task created successfully
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
 *                 be_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create deletion task
 */
export const deleteBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { force = false, snapshots = false, created_by = 'api' } = req.query;

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    // Create task for boot environment deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_delete',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            force: force === 'true' || force === true,
            snapshots: snapshots === 'true' || snapshots === true,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    res.status(202).json({
      success: true,
      message: `Boot environment deletion task created for '${name}'`,
      task_id: task.id,
      be_name: name,
      force: force === 'true' || force === true,
      snapshots: snapshots === 'true' || snapshots === true,
    });
  } catch (error) {
    log.api.error('Error creating boot environment deletion task', {
      error: error.message,
      stack: error.stack,
      name,
      force,
      snapshots,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create boot environment deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}/activate:
 *   post:
 *     summary: Activate boot environment
 *     description: Activate a boot environment for next boot
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to activate
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               temporary:
 *                 type: boolean
 *                 default: false
 *                 description: Temporary activation (one-time boot)
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Boot environment activation task created successfully
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
 *                 be_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create activation task
 */
export const activateBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { temporary = false, created_by = 'api' } = req.body || {};

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    // Create task for boot environment activation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_activate',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            temporary,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    res.status(202).json({
      success: true,
      message: `Boot environment activation task created for '${name}'${temporary ? ' (temporary)' : ''}`,
      task_id: task.id,
      be_name: name,
      temporary,
    });
  } catch (error) {
    log.api.error('Error creating boot environment activation task', {
      error: error.message,
      stack: error.stack,
      name,
      temporary,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create boot environment activation task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}/mount:
 *   post:
 *     summary: Mount boot environment
 *     description: Mount a boot environment at specified location
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to mount
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - mountpoint
 *             properties:
 *               mountpoint:
 *                 type: string
 *                 description: Directory to mount the BE at
 *               shared_mode:
 *                 type: string
 *                 enum: [ro, rw]
 *                 description: Mount shared filesystems as read-only or read-write
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Boot environment mount task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create mount task
 */
export const mountBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { mountpoint, shared_mode, created_by = 'api' } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    if (!mountpoint) {
      return res.status(400).json({
        error: 'Mountpoint is required',
      });
    }

    // Create task for boot environment mounting
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_mount',
      priority: TaskPriority.LOW,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            mountpoint,
            shared_mode,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    res.status(202).json({
      success: true,
      message: `Boot environment mount task created for '${name}' at '${mountpoint}'`,
      task_id: task.id,
      be_name: name,
      mountpoint,
    });
  } catch (error) {
    log.api.error('Error creating boot environment mount task', {
      error: error.message,
      stack: error.stack,
      name,
      mountpoint,
      shared_mode,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create boot environment mount task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/boot-environments/{name}/unmount:
 *   post:
 *     summary: Unmount boot environment
 *     description: Unmount a boot environment
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the boot environment to unmount
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: Force unmount even if busy
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this task
 *     responses:
 *       202:
 *         description: Boot environment unmount task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create unmount task
 */
export const unmountBootEnvironment = async (req, res) => {
  try {
    const { name } = req.params;
    const { force = false, created_by = 'api' } = req.body || {};

    if (!name) {
      return res.status(400).json({
        error: 'Boot environment name is required',
      });
    }

    // Create task for boot environment unmounting
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'beadm_unmount',
      priority: TaskPriority.LOW,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            force,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    res.status(202).json({
      success: true,
      message: `Boot environment unmount task created for '${name}'`,
      task_id: task.id,
      be_name: name,
      force,
    });
  } catch (error) {
    log.api.error('Error creating boot environment unmount task', {
      error: error.message,
      stack: error.stack,
      name,
      force,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create boot environment unmount task',
      details: error.message,
    });
  }
};
