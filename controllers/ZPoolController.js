/**
 * @fileoverview ZFS Pool Management Controller for Zoneweaver API
 * @description Handles ZFS pool lifecycle, device management, scrub, import/export, and property management
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';

const execPromise = util.promisify(exec);

const executeCommand = async command => {
  try {
    const { stdout } = await execPromise(command, {
      encoding: 'utf8',
      timeout: 30000,
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
    };
  }
};

/**
 * @swagger
 * /storage/pools:
 *   get:
 *     summary: List ZFS pools
 *     description: Retrieves a list of all ZFS storage pools
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Pools retrieved successfully
 */
export const listPools = async (req, res) => {
  try {
    const result = await executeCommand(
      'pfexec zpool list -H -p -o name,size,alloc,free,cap,dedup,health,altroot'
    );

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list pools',
        details: result.error,
      });
    }

    const pools = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, size, alloc, free, cap, dedup, health, altroot] = line.split('\t');
        return {
          name,
          size,
          alloc,
          free,
          capacity_percent: cap,
          dedup_ratio: dedup,
          health,
          altroot: altroot === '-' ? null : altroot,
        };
      });

    return res.json({
      pools,
      total: pools.length,
    });
  } catch (error) {
    log.api.error('Error listing pools', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list pools',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}:
 *   get:
 *     summary: Get pool details
 *     description: Retrieves all properties for a specific ZFS pool
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     responses:
 *       200:
 *         description: Pool details retrieved successfully
 *       404:
 *         description: Pool not found
 */
export const getPoolDetails = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool get all -H -p ${pool}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Pool not found',
        details: result.error,
      });
    }

    const properties = {};
    result.output.split('\n').forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 4) {
        const [, prop, value, source] = parts;
        properties[prop] = { value, source };
      }
    });

    return res.json({
      name: pool,
      properties,
    });
  } catch (error) {
    log.api.error('Error getting pool details', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to get pool details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/status:
 *   get:
 *     summary: Get pool status
 *     description: Retrieves detailed status information for a ZFS pool including vdev tree and scan status
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     responses:
 *       200:
 *         description: Pool status retrieved successfully
 *       404:
 *         description: Pool not found
 */
export const getPoolStatus = async (req, res) => {
  const { pool } = req.params;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool status ${pool}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Pool not found',
        details: result.error,
      });
    }

    return res.json({
      name: pool,
      status: result.output,
    });
  } catch (error) {
    log.api.error('Error getting pool status', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to get pool status',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools:
 *   post:
 *     summary: Create ZFS pool
 *     description: Creates a new ZFS storage pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pool_name
 *               - vdevs
 *             properties:
 *               pool_name:
 *                 type: string
 *               vdevs:
 *                 type: array
 *                 description: Array of vdev specs (strings or {type, devices} objects)
 *               properties:
 *                 type: object
 *               force:
 *                 type: boolean
 *               mount_point:
 *                 type: string
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Pool creation task created
 *       400:
 *         description: Invalid request
 */
export const createPool = async (req, res) => {
  const {
    pool_name,
    vdevs,
    properties = {},
    force = false,
    mount_point,
    created_by = 'api',
  } = req.body;

  try {
    if (!pool_name) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!vdevs || !Array.isArray(vdevs) || vdevs.length === 0) {
      return res.status(400).json({ error: 'Vdevs array is required and must not be empty' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_create',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name,
            vdevs,
            properties,
            force: force === 'true' || force === true,
            mount_point,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Pool creation task created for ${pool_name}`,
      task_id: task.id,
      pool_name,
    });
  } catch (error) {
    log.api.error('Error creating pool task', {
      error: error.message,
      stack: error.stack,
      pool_name,
    });
    return res.status(500).json({
      error: 'Failed to create pool task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}:
 *   delete:
 *     summary: Destroy ZFS pool
 *     description: Destroys a ZFS storage pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *         description: Pool name
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Pool destruction task created
 *       404:
 *         description: Pool not found
 */
export const destroyPool = async (req, res) => {
  const { pool } = req.params;
  const { force = false, created_by = 'api' } = req.body || {};

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_destroy',
      priority: TaskPriority.CRITICAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Pool destruction task created for ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error destroying pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create pool destruction task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/properties:
 *   put:
 *     summary: Set pool properties
 *     description: Updates properties on a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - properties
 *             properties:
 *               properties:
 *                 type: object
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Property update task created
 *       404:
 *         description: Pool not found
 */
export const setPoolProperties = async (req, res) => {
  const { pool } = req.params;
  const { properties, created_by = 'api' } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'Properties object is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_set_properties',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            properties,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Property update task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      properties,
    });
  } catch (error) {
    log.api.error('Error setting pool properties', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create property update task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/vdevs:
 *   post:
 *     summary: Add vdev to pool
 *     description: Adds a new vdev to an existing ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vdevs
 *             properties:
 *               vdevs:
 *                 type: array
 *               force:
 *                 type: boolean
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Add vdev task created
 *       404:
 *         description: Pool not found
 */
export const addVdev = async (req, res) => {
  const { pool } = req.params;
  const { vdevs, force = false, created_by = 'api' } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!vdevs || !Array.isArray(vdevs) || vdevs.length === 0) {
      return res.status(400).json({ error: 'Vdevs array is required and must not be empty' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_add_vdev',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            vdevs,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Add vdev task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error adding vdev to pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create add vdev task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/vdevs/remove:
 *   post:
 *     summary: Remove vdev from pool
 *     description: Removes a device from a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - device
 *             properties:
 *               device:
 *                 type: string
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Remove vdev task created
 *       404:
 *         description: Pool not found
 */
export const removeVdev = async (req, res) => {
  const { pool } = req.params;
  const { device, created_by = 'api' } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_remove_vdev',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            device,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Remove vdev task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      device,
    });
  } catch (error) {
    log.api.error('Error removing vdev from pool', {
      error: error.message,
      stack: error.stack,
      pool,
      device,
    });
    return res.status(500).json({
      error: 'Failed to create remove vdev task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/devices/replace:
 *   post:
 *     summary: Replace device in pool
 *     description: Replaces a device in a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - old_device
 *               - new_device
 *             properties:
 *               old_device:
 *                 type: string
 *               new_device:
 *                 type: string
 *               force:
 *                 type: boolean
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Replace device task created
 *       404:
 *         description: Pool not found
 */
export const replaceDevice = async (req, res) => {
  const { pool } = req.params;
  const { old_device, new_device, force = false, created_by = 'api' } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!old_device) {
      return res.status(400).json({ error: 'Old device is required' });
    }

    if (!new_device) {
      return res.status(400).json({ error: 'New device is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_replace_device',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            old_device,
            new_device,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Replace device task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      old_device,
      new_device,
    });
  } catch (error) {
    log.api.error('Error replacing device in pool', {
      error: error.message,
      stack: error.stack,
      pool,
      old_device,
      new_device,
    });
    return res.status(500).json({
      error: 'Failed to create replace device task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/devices/online:
 *   post:
 *     summary: Online device in pool
 *     description: Brings a device online in a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - device
 *             properties:
 *               device:
 *                 type: string
 *               expand:
 *                 type: boolean
 *                 description: Expand device to use all available space
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Online device task created
 *       404:
 *         description: Pool not found
 */
export const onlineDevice = async (req, res) => {
  const { pool } = req.params;
  const { device, expand = false, created_by = 'api' } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_online_device',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            device,
            expand: expand === 'true' || expand === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Online device task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      device,
    });
  } catch (error) {
    log.api.error('Error onlining device in pool', {
      error: error.message,
      stack: error.stack,
      pool,
      device,
    });
    return res.status(500).json({
      error: 'Failed to create online device task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/devices/offline:
 *   post:
 *     summary: Offline device in pool
 *     description: Takes a device offline in a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - device
 *             properties:
 *               device:
 *                 type: string
 *               temporary:
 *                 type: boolean
 *                 description: Temporarily offline (will online on reboot)
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Offline device task created
 *       404:
 *         description: Pool not found
 */
export const offlineDevice = async (req, res) => {
  const { pool } = req.params;
  const { device, temporary = false, created_by = 'api' } = req.body;

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    if (!device) {
      return res.status(400).json({ error: 'Device is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_offline_device',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            device,
            temporary: temporary === 'true' || temporary === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Offline device task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
      device,
    });
  } catch (error) {
    log.api.error('Error offlining device in pool', {
      error: error.message,
      stack: error.stack,
      pool,
      device,
    });
    return res.status(500).json({
      error: 'Failed to create offline device task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/scrub:
 *   post:
 *     summary: Start pool scrub
 *     description: Starts a scrub operation on a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Scrub task created
 *       404:
 *         description: Pool not found
 */
export const scrubPool = async (req, res) => {
  const { pool } = req.params;
  const { created_by = 'api' } = req.body || {};

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_scrub',
      priority: TaskPriority.LOW,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Scrub task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error starting pool scrub', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create scrub task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/scrub/stop:
 *   post:
 *     summary: Stop pool scrub
 *     description: Stops an in-progress scrub on a ZFS pool (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       202:
 *         description: Stop scrub task created
 *       404:
 *         description: Pool not found
 */
export const stopScrub = async (req, res) => {
  const { pool } = req.params;
  const { created_by = 'api' } = req.body || {};

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_stop_scrub',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Stop scrub task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error stopping pool scrub', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create stop scrub task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/export:
 *   post:
 *     summary: Export ZFS pool
 *     description: Exports a ZFS pool from the system (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               force:
 *                 type: boolean
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Export task created
 *       404:
 *         description: Pool not found
 */
export const exportPool = async (req, res) => {
  const { pool } = req.params;
  const { force = false, created_by = 'api' } = req.body || {};

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_export',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Export task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error exporting pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create export task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/import:
 *   post:
 *     summary: Import ZFS pool
 *     description: Imports a ZFS pool into the system (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               pool_name:
 *                 type: string
 *               pool_id:
 *                 type: string
 *               new_name:
 *                 type: string
 *               properties:
 *                 type: object
 *               force:
 *                 type: boolean
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Import task created
 *       400:
 *         description: Invalid request
 */
export const importPool = async (req, res) => {
  const {
    pool_name,
    pool_id,
    new_name,
    properties = {},
    force = false,
    created_by = 'api',
  } = req.body;

  try {
    if (!pool_name && !pool_id) {
      return res.status(400).json({ error: 'Pool name or pool ID is required' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_import',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name,
            pool_id,
            new_name,
            properties,
            force: force === 'true' || force === true,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Import task created for pool ${pool_name || pool_id}`,
      task_id: task.id,
      pool_name: pool_name || pool_id,
    });
  } catch (error) {
    log.api.error('Error importing pool', {
      error: error.message,
      stack: error.stack,
      pool_name,
      pool_id,
    });
    return res.status(500).json({
      error: 'Failed to create import task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/importable:
 *   get:
 *     summary: List importable pools
 *     description: Lists ZFS pools available for import
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Importable pools listed successfully
 */
export const listImportablePools = async (req, res) => {
  try {
    const result = await executeCommand('pfexec zpool import');

    if (!result.success && !result.output) {
      return res.json({
        pools: [],
        total: 0,
        message: 'No pools available for import',
      });
    }

    return res.json({
      output: result.output || result.error,
      total: result.output ? result.output.split('pool:').length - 1 : 0,
    });
  } catch (error) {
    log.api.error('Error listing importable pools', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list importable pools',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /storage/pools/{pool}/upgrade:
 *   post:
 *     summary: Upgrade ZFS pool
 *     description: Upgrades a ZFS pool to the latest supported version (async task)
 *     tags: [ZFS Pool Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: pool
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *     responses:
 *       202:
 *         description: Upgrade task created
 *       404:
 *         description: Pool not found
 */
export const upgradePool = async (req, res) => {
  const { pool } = req.params;
  const { created_by = 'api' } = req.body || {};

  try {
    if (!pool) {
      return res.status(400).json({ error: 'Pool name is required' });
    }

    const result = await executeCommand(`pfexec zpool list ${pool}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Pool ${pool} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zpool_upgrade',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            pool_name: pool,
          },
          (err, jsonResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(jsonResult);
            }
          }
        );
      }),
    });

    return res.status(202).json({
      success: true,
      message: `Upgrade task created for pool ${pool}`,
      task_id: task.id,
      pool_name: pool,
    });
  } catch (error) {
    log.api.error('Error upgrading pool', {
      error: error.message,
      stack: error.stack,
      pool,
    });
    return res.status(500).json({
      error: 'Failed to create upgrade task',
      details: error.message,
    });
  }
};
