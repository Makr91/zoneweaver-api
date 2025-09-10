/**
 * @fileoverview Link Aggregation Management Controller for Zoneweaver API
 * @description Handles link aggregation creation, deletion, and management via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { execSync } from 'child_process';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import { Op } from 'sequelize';
import yj from 'yieldable-json';
import os from 'os';
import { log } from '../lib/Logger.js';

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async command => {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
    });
    return { success: true, output: output.trim() };
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
 * /network/aggregates:
 *   get:
 *     summary: List link aggregations
 *     description: Returns link aggregation information from monitoring data or live system query
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *           enum: [up, down, unknown]
 *         description: Filter by aggregate state
 *       - in: query
 *         name: policy
 *         schema:
 *           type: string
 *           enum: [L2, L3, L4, L2L3, L2L4, L3L4, L2L3L4]
 *         description: Filter by load balancing policy
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of aggregates to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *       - in: query
 *         name: extended
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed port information
 *     responses:
 *       200:
 *         description: Aggregates retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 aggregates:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get aggregates
 */
export const getAggregates = async (req, res) => {
  try {
    const { state, policy, limit = 100 } = req.query;

    // Always get data from database (monitoring data) - only get the latest record per aggregate
    const hostname = os.hostname();
    const whereClause = {
      host: hostname,
      class: 'aggr',
    };

    if (state) {
      whereClause.state = state;
    }

    // Optimize: Simple query with selective fetching, only existing columns
    const rows = await NetworkInterfaces.findAll({
      where: whereClause,
      attributes: [
        'id',
        'link',
        'class',
        'state',
        'policy',
        'scan_timestamp',
        'over',
        'lacp_activity',
        'flags',
      ], // Only include columns that exist in database
      limit: parseInt(limit),
      order: [
        ['scan_timestamp', 'DESC'],
        ['link', 'ASC'],
      ],
    });

    res.json({
      aggregates: rows,
      source: 'database',
      returned: rows.length,
    });
  } catch (error) {
    log.api.error('Error getting aggregates', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get aggregates',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}:
 *   get:
 *     summary: Get aggregate details
 *     description: Returns detailed information about a specific link aggregate
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate link name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *       - in: query
 *         name: extended
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed port information
 *       - in: query
 *         name: lacp
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include LACP information
 *     responses:
 *       200:
 *         description: Aggregate details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to get aggregate details
 */
export const getAggregateDetails = async (req, res) => {
  try {
    const { aggregate } = req.params;

    // Always get data from database
    log.api.debug('Getting aggregate details from database', { aggregate });
    const hostname = os.hostname();
    const aggregateData = await NetworkInterfaces.findOne({
      where: {
        host: hostname,
        link: aggregate,
        class: 'aggr',
      },
      order: [['scan_timestamp', 'DESC']],
    });

    if (!aggregateData) {
      log.api.warn('Aggregate not found in database', { aggregate });
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found`,
      });
    }

    log.api.debug('Aggregate data retrieved from database', { aggregate });
    res.json(aggregateData);
  } catch (error) {
    log.api.error('Error getting aggregate details', {
      aggregate,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get aggregate details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates:
 *   post:
 *     summary: Create link aggregation
 *     description: Creates a new link aggregation using dladm create-aggr
 *     tags: [Link Aggregation]
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
 *               - links
 *             properties:
 *               name:
 *                 type: string
 *                 description: Aggregate link name
 *                 example: "aggr0"
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Physical links to aggregate
 *                 example: ["e1000g0", "e1000g1"]
 *               policy:
 *                 type: string
 *                 enum: [L2, L3, L4, L2L3, L2L4, L3L4, L2L3L4]
 *                 description: Load balancing policy
 *                 default: "L4"
 *               lacp_mode:
 *                 type: string
 *                 enum: [off, active, passive]
 *                 description: LACP mode
 *                 default: "off"
 *               lacp_timer:
 *                 type: string
 *                 enum: [short, long]
 *                 description: LACP timer value
 *                 default: "short"
 *               unicast_address:
 *                 type: string
 *                 description: Fixed unicast address for the aggregate
 *                 example: "02:08:20:12:34:56"
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary aggregate (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User creating this aggregate
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Aggregate creation task created successfully
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
 *                 aggregate_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create aggregate task
 */
export const createAggregate = async (req, res) => {
  try {
    const {
      name,
      links,
      policy = 'L4',
      lacp_mode = 'off',
      lacp_timer = 'short',
      unicast_address,
      temporary = false,
      created_by = 'api',
    } = req.body;

    // Validate required fields
    if (!name || !links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({
        error: 'name and links array (with at least one link) are required',
      });
    }

    // Validate aggregate name format
    const aggrNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*[0-9]+$/;
    if (!aggrNameRegex.test(name)) {
      return res.status(400).json({
        error:
          'Aggregate name must start with letter, contain alphanumeric/underscore, and end with number',
      });
    }

    // Validate policy
    const validPolicies = ['L2', 'L3', 'L4', 'L2L3', 'L2L4', 'L3L4', 'L2L3L4'];
    if (!validPolicies.includes(policy)) {
      return res.status(400).json({
        error: `Policy must be one of: ${validPolicies.join(', ')}`,
      });
    }

    // Validate LACP mode
    const validLacpModes = ['off', 'active', 'passive'];
    if (!validLacpModes.includes(lacp_mode)) {
      return res.status(400).json({
        error: `LACP mode must be one of: ${validLacpModes.join(', ')}`,
      });
    }

    // Validate LACP timer
    const validLacpTimers = ['short', 'long'];
    if (!validLacpTimers.includes(lacp_timer)) {
      return res.status(400).json({
        error: `LACP timer must be one of: ${validLacpTimers.join(', ')}`,
      });
    }

    // Validate unicast address format if provided
    if (unicast_address && !/^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(unicast_address)) {
      return res.status(400).json({
        error: 'unicast_address must be in format XX:XX:XX:XX:XX:XX',
      });
    }

    // Check if aggregate already exists
    const existsResult = await executeCommand(`pfexec dladm show-aggr ${name}`);
    if (existsResult.success) {
      return res.status(400).json({
        error: `Aggregate ${name} already exists`,
      });
    }

    // Validate that all links exist and are physical interfaces
    for (const link of links) {
      const linkResult = await executeCommand(`pfexec dladm show-phys ${link}`);
      if (!linkResult.success) {
        return res.status(400).json({
          error: `Physical link ${link} not found or not available`,
        });
      }
    }

    // Create task for aggregate creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'create_aggregate',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            name,
            links,
            policy,
            lacp_mode,
            lacp_timer,
            unicast_address,
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
      message: `Aggregate creation task created for ${name}`,
      task_id: task.id,
      aggregate_name: name,
      links,
      policy,
    });
  } catch (error) {
    log.api.error('Error creating aggregate', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to create aggregate task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}:
 *   delete:
 *     summary: Delete link aggregation
 *     description: Deletes a link aggregation using dladm delete-aggr
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this aggregate
 *     responses:
 *       202:
 *         description: Aggregate deletion task created successfully
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
 *                 aggregate_name:
 *                   type: string
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to create aggregate deletion task
 */
export const deleteAggregate = async (req, res) => {
  log.api.debug('Aggregate deletion request starting', {
    aggregate: req.params.aggregate,
    query_params: req.query,
  });

  try {
    const { aggregate } = req.params;
    const { temporary = false, created_by = 'api' } = req.query;

    log.api.debug('Aggregate deletion - parsed parameters', {
      aggregate,
      temporary,
      created_by,
    });

    // Check if aggregate exists
    log.api.debug('Checking if aggregate exists', { aggregate });
    const existsResult = await executeCommand(`pfexec dladm show-aggr ${aggregate}`);
    log.api.debug('Aggregate existence check result', {
      aggregate,
      exists: existsResult.success,
    });

    if (!existsResult.success) {
      log.api.warn('Aggregate not found', {
        aggregate,
        error: existsResult.error,
      });
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found`,
        details: existsResult.error,
      });
    }

    log.api.debug('Aggregate exists, creating deletion task', { aggregate });

    // Create task for aggregate deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'delete_aggregate',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            aggregate,
            temporary: temporary === 'true' || temporary === true,
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

    log.api.info('Aggregate deletion task created successfully', {
      task_id: task.id,
      aggregate,
      temporary: temporary === 'true' || temporary === true,
    });

    res.status(202).json({
      success: true,
      message: `Aggregate deletion task created for ${aggregate}`,
      task_id: task.id,
      aggregate_name: aggregate,
      temporary: temporary === 'true' || temporary === true,
    });

    log.api.debug('Aggregate deletion response sent successfully', { aggregate });
  } catch (error) {
    log.api.error('Error deleting aggregate', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to create aggregate deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}/links:
 *   put:
 *     summary: Modify aggregate links
 *     description: Add or remove links from an existing aggregation using dladm add-aggr/remove-aggr
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *               - links
 *             properties:
 *               operation:
 *                 type: string
 *                 enum: [add, remove]
 *                 description: Whether to add or remove links
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Links to add or remove
 *                 example: ["e1000g2", "e1000g3"]
 *               temporary:
 *                 type: boolean
 *                 description: Temporary modification (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User making this modification
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Aggregate link modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to create link modification task
 */
export const modifyAggregateLinks = async (req, res) => {
  try {
    const { aggregate } = req.params;
    const { operation, links, temporary = false, created_by = 'api' } = req.body;

    // Validate required fields
    if (!operation || !links || !Array.isArray(links) || links.length === 0) {
      return res.status(400).json({
        error: 'operation and links array (with at least one link) are required',
      });
    }

    // Validate operation
    if (!['add', 'remove'].includes(operation)) {
      return res.status(400).json({
        error: 'operation must be either "add" or "remove"',
      });
    }

    // Check if aggregate exists
    const existsResult = await executeCommand(`pfexec dladm show-aggr ${aggregate}`);
    if (!existsResult.success) {
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found`,
        details: existsResult.error,
      });
    }

    // If adding links, validate that they exist and are physical interfaces
    if (operation === 'add') {
      for (const link of links) {
        const linkResult = await executeCommand(`pfexec dladm show-phys ${link}`);
        if (!linkResult.success) {
          return res.status(400).json({
            error: `Physical link ${link} not found or not available`,
          });
        }
      }
    }

    // Create task for aggregate link modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'modify_aggregate_links',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            aggregate,
            operation,
            links,
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
      message: `Aggregate link ${operation} task created for ${aggregate}`,
      task_id: task.id,
      aggregate_name: aggregate,
      operation,
      links,
      temporary,
    });
  } catch (error) {
    log.api.error('Error modifying aggregate links', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to create aggregate link modification task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /network/aggregates/{aggregate}/stats:
 *   get:
 *     summary: Get aggregate statistics
 *     description: Returns live statistics for a specific aggregate using dladm show-aggr -s
 *     tags: [Link Aggregation]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: aggregate
 *         required: true
 *         schema:
 *           type: string
 *         description: Aggregate name
 *       - in: query
 *         name: interval
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Interval between samples (for continuous monitoring)
 *     responses:
 *       200:
 *         description: Aggregate statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 aggregate:
 *                   type: string
 *                 statistics:
 *                   type: object
 *                   properties:
 *                     ipackets:
 *                       type: integer
 *                     rbytes:
 *                       type: integer
 *                     ierrors:
 *                       type: integer
 *                     opackets:
 *                       type: integer
 *                     obytes:
 *                       type: integer
 *                     oerrors:
 *                       type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: Aggregate not found
 *       500:
 *         description: Failed to get aggregate statistics
 */
export const getAggregateStats = async (req, res) => {
  try {
    const { aggregate } = req.params;
    const { interval = 1 } = req.query;

    // Get live statistics from dladm
    const result = await executeCommand(
      `pfexec dladm show-aggr ${aggregate} -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors`
    );

    if (!result.success) {
      return res.status(404).json({
        error: `Aggregate ${aggregate} not found or failed to get statistics`,
        details: result.error,
      });
    }

    const [link, ipackets, rbytes, ierrors, opackets, obytes, oerrors] = result.output.split(':');

    const statistics = {
      link,
      ipackets: parseInt(ipackets) || 0,
      rbytes: parseInt(rbytes) || 0,
      ierrors: parseInt(ierrors) || 0,
      opackets: parseInt(opackets) || 0,
      obytes: parseInt(obytes) || 0,
      oerrors: parseInt(oerrors) || 0,
    };

    res.json({
      aggregate,
      statistics,
      timestamp: new Date().toISOString(),
      interval: parseInt(interval),
    });
  } catch (error) {
    log.api.error('Error getting aggregate statistics', {
      aggregate: req.params.aggregate,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to get aggregate statistics',
      details: error.message,
    });
  }
};
