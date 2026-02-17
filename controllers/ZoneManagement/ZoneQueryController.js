import Zones from '../../models/ZoneModel.js';
import Tasks from '../../models/TaskModel.js';
import VncSessions from '../../models/VncSessionModel.js';
import { executeCommand } from '../../lib/CommandManager.js';
import { getZoneConfig as fetchZoneConfig } from '../../lib/ZoneConfigUtils.js';
import { errorResponse } from '../SystemHostController/utils/ResponseHelpers.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';

/**
 * @fileoverview Zone query controllers - list, details, config retrieval
 */

/**
 * Get current zone status from system using CommandManager
 * @param {string} zoneName - Name of the zone
 * @returns {Promise<string>} Zone status
 */
export const getSystemZoneStatus = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);

  if (result.success) {
    const parts = result.output.split(':');
    return parts[2] || 'unknown';
  }
  return 'not_found';
};

/**
 * @swagger
 * /zones:
 *   get:
 *     summary: List all zones
 *     description: Retrieves a list of all zones with their current status and metadata
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [configured, incomplete, installed, ready, running, shutting_down, down]
 *         description: Filter zones by status
 *       - in: query
 *         name: tag
 *         schema:
 *           type: string
 *         description: Filter zones by tag (zones must contain this tag)
 *       - in: query
 *         name: orphaned
 *         schema:
 *           type: boolean
 *         description: Include orphaned zones
 *     responses:
 *       200:
 *         description: List of zones retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zones:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Zone'
 *                 total:
 *                   type: integer
 *                   description: Total number of zones
 *       500:
 *         description: Failed to retrieve zones
 */
export const listZones = async (req, res) => {
  try {
    const { status, orphaned, tag } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }

    if (orphaned !== undefined) {
      whereClause.is_orphaned = orphaned === 'true';
    }

    let zones = await Zones.findAll({
      where: whereClause,
      order: [['name', 'ASC']],
    });

    if (tag) {
      zones = zones.filter(zone => {
        const zoneTags = zone.tags || [];
        return Array.isArray(zoneTags) && zoneTags.includes(tag);
      });
    }

    return res.json({
      zones,
      total: zones.length,
    });
  } catch (error) {
    log.database.error('Database error listing zones', {
      error: error.message,
      query_params: req.query,
    });
    return res.status(500).json({ error: 'Failed to retrieve zones' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}:
 *   get:
 *     summary: Get zone details
 *     description: Retrieves detailed information about a specific zone including full configuration
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: Zone details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zone_info:
 *                   $ref: '#/components/schemas/Zone'
 *                 configuration:
 *                   type: object
 *                   description: Full zone configuration from zadm
 *                 active_vnc_session:
 *                   $ref: '#/components/schemas/VncSession'
 *                 pending_tasks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Task'
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to retrieve zone details
 */
export const getZoneDetails = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Get current system status
    const currentStatus = await getSystemZoneStatus(zoneName);

    // Update database if status changed
    if (currentStatus !== zone.status && currentStatus !== 'not_found') {
      await zone.update({
        status: currentStatus,
        last_seen: new Date(),
        is_orphaned: false,
      });
    } else if (currentStatus === 'not_found') {
      await zone.update({ is_orphaned: true });
    }

    // Get all data in parallel for optimal performance (fixes slow frontend loading)
    const [configuration, vncSession, pendingTasks] = await Promise.all([
      // Get zone configuration using shared utility
      fetchZoneConfig(zoneName).catch(error => {
        log.monitoring.error('Failed to get zone configuration', {
          zone_name: zoneName,
          error: error.message,
        });
        return {};
      }),

      // Get VNC session
      VncSessions.findOne({
        where: { zone_name: zoneName, status: 'active' },
      }).catch(error => {
        log.database.warn('Failed to get VNC session for zone', {
          zone_name: zoneName,
          error: error.message,
        });
        return null;
      }),

      // Get pending tasks
      Tasks.findAll({
        where: {
          zone_name: zoneName,
          status: ['pending', 'running'],
        },
        order: [['created_at', 'DESC']],
        limit: 10,
      }).catch(error => {
        log.database.warn('Failed to get tasks for zone', {
          zone_name: zoneName,
          error: error.message,
        });
        return [];
      }),

      // Refresh zone data after potential update
      zone.reload(),
    ]);

    // Log configuration details if successfully loaded
    if (configuration && Object.keys(configuration).length > 0) {
      log.monitoring.debug('Zone configuration loaded successfully', {
        zone_name: zoneName,
        ram: configuration.ram,
        vcpus: configuration.vcpus,
        brand: configuration.brand,
      });
    }

    // Process VNC session data
    let activeVncSession = null;
    if (vncSession) {
      activeVncSession = vncSession.toJSON();
      activeVncSession.console_url = `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`;
    }

    return res.json({
      zone_info: zone.toJSON(),
      configuration,
      active_vnc_session: activeVncSession,
      pending_tasks: pendingTasks,
      system_status: currentStatus,
    });
  } catch (error) {
    log.database.error('Database error getting zone details', {
      error: error.message,
      zone_name: req.params.zoneName,
    });
    return res.status(500).json({ error: 'Failed to retrieve zone details' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/config:
 *   get:
 *     summary: Get zone configuration
 *     description: Retrieves the complete zone configuration using zadm show
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: Zone configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zone_name:
 *                   type: string
 *                 configuration:
 *                   type: object
 *                   description: Complete zone configuration from zadm
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to retrieve zone configuration
 */
export const getZoneConfig = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return errorResponse(res, 400, 'Invalid zone name');
    }

    // Get zone configuration using shared utility
    const zoneConfig = await fetchZoneConfig(zoneName);

    return res.json({
      zone_name: zoneName,
      configuration: zoneConfig,
    });
  } catch (error) {
    log.monitoring.error('Error getting zone config', {
      error: error.message,
      zone_name: req.params.zoneName,
    });

    // Check if it's a "zone does not exist" error
    if (error.message && error.message.includes('does not exist')) {
      return errorResponse(res, 404, 'Zone not found');
    }

    return errorResponse(res, 500, 'Failed to retrieve zone configuration', error.message);
  }
};
