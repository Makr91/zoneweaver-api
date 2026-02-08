/**
 * @fileoverview ZFS Dataset Management Controller for Zoneweaver API
 * @description Handles ZFS dataset lifecycle, snapshots, clones, and property management
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

export const listDatasets = async (req, res) => {
  const { pool, type, recursive = false } = req.query;

  try {
    let command = 'pfexec zfs list -H -p -o name,type,used,avail,refer,mountpoint';

    if (recursive === 'true' || recursive === true) {
      command += ' -r';
    }

    if (type) {
      command += ` -t ${type}`;
    }

    if (pool) {
      command += ` ${pool}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list datasets',
        details: result.error,
      });
    }

    const datasets = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, datasetType, used, avail, refer, mountpoint] = line.split('\t');
        return {
          name,
          type: datasetType,
          used,
          avail,
          refer,
          mountpoint,
        };
      });

    return res.json({
      datasets,
      total: datasets.length,
    });
  } catch (error) {
    log.api.error('Error listing datasets', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to list datasets',
      details: error.message,
    });
  }
};

export const getDatasetDetails = async (req, res) => {
  const { name } = req.params;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    const result = await executeCommand(`pfexec zfs get all -H -p ${name}`);

    if (!result.success) {
      return res.status(404).json({
        error: 'Dataset not found',
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
      name,
      properties,
    });
  } catch (error) {
    log.api.error('Error getting dataset details', {
      error: error.message,
      stack: error.stack,
      dataset: name,
    });
    return res.status(500).json({
      error: 'Failed to get dataset details',
      details: error.message,
    });
  }
};

export const createDataset = async (req, res) => {
  const { name, type = 'filesystem', properties = {}, created_by = 'api' } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!['filesystem', 'volume'].includes(type)) {
      return res.status(400).json({ error: 'Type must be filesystem or volume' });
    }

    if (type === 'volume' && !properties.volsize) {
      return res.status(400).json({ error: 'volsize is required for volumes' });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_create_dataset',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            type,
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
      message: `Dataset creation task created for ${name}`,
      task_id: task.id,
      name,
      type,
    });
  } catch (error) {
    log.api.error('Error creating dataset task', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create dataset task',
      details: error.message,
    });
  }
};

export const destroyDataset = async (req, res) => {
  const { name } = req.params;
  const { recursive = false, force = false, created_by = 'api' } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_destroy_dataset',
      priority: TaskPriority.CRITICAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Dataset destruction task created for ${name}`,
      task_id: task.id,
      name,
      recursive: recursive === 'true' || recursive === true,
      force: force === 'true' || force === true,
    });
  } catch (error) {
    log.api.error('Error destroying dataset', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create dataset destruction task',
      details: error.message,
    });
  }
};

export const setDatasetProperties = async (req, res) => {
  const { name } = req.params;
  const { properties, created_by = 'api' } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
      return res.status(400).json({ error: 'Properties object is required' });
    }

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_set_properties',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
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
      message: `Property update task created for ${name}`,
      task_id: task.id,
      name,
      properties,
    });
  } catch (error) {
    log.api.error('Error setting dataset properties', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create property update task',
      details: error.message,
    });
  }
};

export const cloneDataset = async (req, res) => {
  const { snapshot } = req.params;
  const { target, properties = {}, created_by = 'api' } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!target) {
      return res.status(400).json({ error: 'Target dataset name is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    const result = await executeCommand(`pfexec zfs list -t snapshot ${snapshot}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_clone_dataset',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            target,
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
      message: `Clone task created from ${snapshot} to ${target}`,
      task_id: task.id,
      snapshot,
      target,
    });
  } catch (error) {
    log.api.error('Error cloning dataset', {
      error: error.message,
      stack: error.stack,
      snapshot,
      target,
    });
    return res.status(500).json({
      error: 'Failed to create clone task',
      details: error.message,
    });
  }
};

export const promoteDataset = async (req, res) => {
  const { name } = req.params;
  const { created_by = 'api' } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_promote_dataset',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
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
      message: `Promote task created for ${name}`,
      task_id: task.id,
      name,
    });
  } catch (error) {
    log.api.error('Error promoting dataset', {
      error: error.message,
      stack: error.stack,
      name,
    });
    return res.status(500).json({
      error: 'Failed to create promote task',
      details: error.message,
    });
  }
};

export const renameDataset = async (req, res) => {
  const { name } = req.params;
  const { new_name, recursive = false, force = false, created_by = 'api' } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!new_name) {
      return res.status(400).json({ error: 'New name is required' });
    }

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_rename_dataset',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            new_name,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Rename task created from ${name} to ${new_name}`,
      task_id: task.id,
      name,
      new_name,
    });
  } catch (error) {
    log.api.error('Error renaming dataset', {
      error: error.message,
      stack: error.stack,
      name,
      new_name,
    });
    return res.status(500).json({
      error: 'Failed to create rename task',
      details: error.message,
    });
  }
};

export const createSnapshot = async (req, res) => {
  const { name } = req.params;
  const { snapshot_name, recursive = false, properties = {}, created_by = 'api' } = req.body;

  try {
    if (!name) {
      return res.status(400).json({ error: 'Dataset name is required' });
    }

    if (!snapshot_name) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    const fullSnapshotName = `${name}@${snapshot_name}`;

    const result = await executeCommand(`pfexec zfs list ${name}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Dataset ${name} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_create_snapshot',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name: fullSnapshotName,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Snapshot creation task created for ${fullSnapshotName}`,
      task_id: task.id,
      snapshot: fullSnapshotName,
    });
  } catch (error) {
    log.api.error('Error creating snapshot', {
      error: error.message,
      stack: error.stack,
      name,
      snapshot_name,
    });
    return res.status(500).json({
      error: 'Failed to create snapshot task',
      details: error.message,
    });
  }
};

export const destroySnapshot = async (req, res) => {
  const { snapshot } = req.params;
  const { recursive = false, defer = false, created_by = 'api' } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    const result = await executeCommand(`pfexec zfs list -t snapshot ${snapshot}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_destroy_snapshot',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            recursive: recursive === 'true' || recursive === true,
            defer: defer === 'true' || defer === true,
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
      message: `Snapshot destruction task created for ${snapshot}`,
      task_id: task.id,
      snapshot,
    });
  } catch (error) {
    log.api.error('Error destroying snapshot', {
      error: error.message,
      stack: error.stack,
      snapshot,
    });
    return res.status(500).json({
      error: 'Failed to create snapshot destruction task',
      details: error.message,
    });
  }
};

export const rollbackSnapshot = async (req, res) => {
  const { snapshot } = req.params;
  const { recursive = false, force = false, created_by = 'api' } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    const result = await executeCommand(`pfexec zfs list -t snapshot ${snapshot}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_rollback_snapshot',
      priority: TaskPriority.CRITICAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Rollback task created for ${snapshot}`,
      task_id: task.id,
      snapshot,
    });
  } catch (error) {
    log.api.error('Error rolling back snapshot', {
      error: error.message,
      stack: error.stack,
      snapshot,
    });
    return res.status(500).json({
      error: 'Failed to create rollback task',
      details: error.message,
    });
  }
};

export const holdSnapshot = async (req, res) => {
  const { snapshot } = req.params;
  const { tag, recursive = false, created_by = 'api' } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!tag) {
      return res.status(400).json({ error: 'Hold tag is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    const result = await executeCommand(`pfexec zfs list -t snapshot ${snapshot}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_hold_snapshot',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            tag,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Hold task created for ${snapshot} with tag ${tag}`,
      task_id: task.id,
      snapshot,
      tag,
    });
  } catch (error) {
    log.api.error('Error holding snapshot', {
      error: error.message,
      stack: error.stack,
      snapshot,
      tag,
    });
    return res.status(500).json({
      error: 'Failed to create hold task',
      details: error.message,
    });
  }
};

export const releaseSnapshot = async (req, res) => {
  const { snapshot, tag } = req.params;
  const { recursive = false, created_by = 'api' } = req.body;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!tag) {
      return res.status(400).json({ error: 'Hold tag is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    const result = await executeCommand(`pfexec zfs list -t snapshot ${snapshot}`);
    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found`,
        details: result.error,
      });
    }

    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'zfs_release_snapshot',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            snapshot,
            tag,
            recursive: recursive === 'true' || recursive === true,
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
      message: `Release task created for ${snapshot} tag ${tag}`,
      task_id: task.id,
      snapshot,
      tag,
    });
  } catch (error) {
    log.api.error('Error releasing snapshot hold', {
      error: error.message,
      stack: error.stack,
      snapshot,
      tag,
    });
    return res.status(500).json({
      error: 'Failed to create release task',
      details: error.message,
    });
  }
};

export const listHolds = async (req, res) => {
  const { snapshot } = req.params;
  const { recursive = false } = req.query;

  try {
    if (!snapshot) {
      return res.status(400).json({ error: 'Snapshot name is required' });
    }

    if (!snapshot.includes('@')) {
      return res.status(400).json({ error: 'Snapshot must be in format dataset@snapshot' });
    }

    let command = `pfexec zfs holds -H`;

    if (recursive === 'true' || recursive === true) {
      command += ' -r';
    }

    command += ` ${snapshot}`;

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(404).json({
        error: `Snapshot ${snapshot} not found or has no holds`,
        details: result.error,
      });
    }

    const holds = result.output
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        const [name, tag, timestamp] = line.split('\t');
        return { name, tag, timestamp };
      });

    return res.json({
      snapshot,
      holds,
      total: holds.length,
    });
  } catch (error) {
    log.api.error('Error listing snapshot holds', {
      error: error.message,
      stack: error.stack,
      snapshot,
    });
    return res.status(500).json({
      error: 'Failed to list snapshot holds',
      details: error.message,
    });
  }
};
