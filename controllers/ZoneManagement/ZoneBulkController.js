import Zones from '../../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../../models/TaskModel.js';
import { log } from '../../lib/Logger.js';
import { getSystemZoneStatus } from './ZoneQueryController.js';

/**
 * @fileoverview Zone bulk operations - bulk start and stop
 */

/**
 * @swagger
 * /zones/bulk/start:
 *   post:
 *     summary: Bulk start zones
 *     description: |
 *       Queues start tasks for multiple zones. Accepts an array of zone names or `"all"` to start
 *       all stopped zones. Tasks are created respecting orchestration priority order.
 *       Zones that are already running are skipped.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [zones]
 *             properties:
 *               zones:
 *                 oneOf:
 *                   - type: string
 *                     enum: [all]
 *                     description: Start all stopped zones
 *                   - type: array
 *                     items:
 *                       type: string
 *                     description: Array of zone names to start
 *                 example: ["zone1.example.com", "zone2.example.com"]
 *     responses:
 *       200:
 *         description: Bulk start tasks queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 operation:
 *                   type: string
 *                   example: "bulk_start"
 *                 tasks_created:
 *                   type: integer
 *                 skipped:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       zone:
 *                         type: string
 *                       reason:
 *                         type: string
 *                 task_ids:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Failed to queue bulk start tasks
 */
export const bulkStartZones = async (req, res) => {
  try {
    const { zones } = req.body;

    if (!zones) {
      return res.status(400).json({ error: 'zones field is required (array of names or "all")' });
    }

    let targetZones;

    if (zones === 'all') {
      // Get all stopped (non-orphaned) zones
      targetZones = await Zones.findAll({
        where: { status: ['configured', 'installed'], is_orphaned: false },
        order: [['name', 'ASC']],
      });
    } else if (Array.isArray(zones)) {
      targetZones = await Zones.findAll({
        where: { name: zones },
        order: [['name', 'ASC']],
      });
    } else {
      return res.status(400).json({ error: 'zones must be "all" or an array of zone names' });
    }

    if (targetZones.length === 0) {
      return res.json({
        success: true,
        operation: 'bulk_start',
        tasks_created: 0,
        skipped: [],
        task_ids: [],
        message: 'No zones found to start',
      });
    }

    // Check current status for each zone in parallel
    const zoneStatuses = await Promise.all(
      targetZones.map(async zone => {
        const currentStatus = await getSystemZoneStatus(zone.name);
        return { zone, currentStatus };
      })
    );

    const skipped = [];
    const toStart = [];

    zoneStatuses.forEach(({ zone, currentStatus }) => {
      if (currentStatus === 'running') {
        skipped.push({ zone: zone.name, reason: 'already_running' });
      } else if (currentStatus === 'not_found') {
        skipped.push({ zone: zone.name, reason: 'not_found_on_system' });
      } else {
        toStart.push(zone);
      }
    });

    // Create start tasks for all eligible zones in parallel
    const tasks = await Promise.all(
      toStart.map(zone =>
        Tasks.create({
          zone_name: zone.name,
          operation: 'start',
          priority: TaskPriority.MEDIUM,
          created_by: req.entity.name,
          status: 'pending',
        })
      )
    );

    log.api.info('Bulk zone start queued', {
      triggered_by: req.entity.name,
      zones_started: toStart.length,
      zones_skipped: skipped.length,
    });

    return res.json({
      success: true,
      operation: 'bulk_start',
      tasks_created: tasks.length,
      skipped,
      task_ids: tasks.map(t => t.id),
      message: `${tasks.length} start tasks queued, ${skipped.length} skipped`,
    });
  } catch (error) {
    log.database.error('Database error in bulk zone start', {
      error: error.message,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue bulk start tasks' });
  }
};

/**
 * @swagger
 * /zones/bulk/stop:
 *   post:
 *     summary: Bulk stop zones
 *     description: |
 *       Queues stop tasks for multiple zones. Accepts an array of zone names or `"all"` to stop
 *       all running zones. Tasks are created with HIGH priority.
 *       Zones that are already stopped are skipped.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [zones]
 *             properties:
 *               zones:
 *                 oneOf:
 *                   - type: string
 *                     enum: [all]
 *                     description: Stop all running zones
 *                   - type: array
 *                     items:
 *                       type: string
 *                     description: Array of zone names to stop
 *                 example: ["zone1.example.com", "zone2.example.com"]
 *     responses:
 *       200:
 *         description: Bulk stop tasks queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 operation:
 *                   type: string
 *                   example: "bulk_stop"
 *                 tasks_created:
 *                   type: integer
 *                 skipped:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       zone:
 *                         type: string
 *                       reason:
 *                         type: string
 *                 task_ids:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: Invalid request body
 *       500:
 *         description: Failed to queue bulk stop tasks
 */
export const bulkStopZones = async (req, res) => {
  try {
    const { zones } = req.body;

    if (!zones) {
      return res.status(400).json({ error: 'zones field is required (array of names or "all")' });
    }

    let targetZones;

    if (zones === 'all') {
      // Get all running (non-orphaned) zones
      targetZones = await Zones.findAll({
        where: { status: 'running', is_orphaned: false },
        order: [['name', 'ASC']],
      });
    } else if (Array.isArray(zones)) {
      targetZones = await Zones.findAll({
        where: { name: zones },
        order: [['name', 'ASC']],
      });
    } else {
      return res.status(400).json({ error: 'zones must be "all" or an array of zone names' });
    }

    if (targetZones.length === 0) {
      return res.json({
        success: true,
        operation: 'bulk_stop',
        tasks_created: 0,
        skipped: [],
        task_ids: [],
        message: 'No zones found to stop',
      });
    }

    // Check current status for each zone in parallel
    const zoneStatuses = await Promise.all(
      targetZones.map(async zone => {
        const currentStatus = await getSystemZoneStatus(zone.name);
        return { zone, currentStatus };
      })
    );

    const skipped = [];
    const toStop = [];

    zoneStatuses.forEach(({ zone, currentStatus }) => {
      if (currentStatus === 'configured' || currentStatus === 'installed') {
        skipped.push({ zone: zone.name, reason: 'already_stopped' });
      } else if (currentStatus === 'not_found') {
        skipped.push({ zone: zone.name, reason: 'not_found_on_system' });
      } else {
        toStop.push(zone);
      }
    });

    // Cancel any pending start tasks for zones we're about to stop
    if (toStop.length > 0) {
      await Tasks.update(
        { status: 'cancelled' },
        {
          where: {
            zone_name: toStop.map(z => z.name),
            operation: 'start',
            status: 'pending',
          },
        }
      );
    }

    // Create stop tasks for all eligible zones in parallel
    const tasks = await Promise.all(
      toStop.map(zone =>
        Tasks.create({
          zone_name: zone.name,
          operation: 'stop',
          priority: TaskPriority.HIGH,
          created_by: req.entity.name,
          status: 'pending',
        })
      )
    );

    log.api.info('Bulk zone stop queued', {
      triggered_by: req.entity.name,
      zones_stopped: toStop.length,
      zones_skipped: skipped.length,
    });

    return res.json({
      success: true,
      operation: 'bulk_stop',
      tasks_created: tasks.length,
      skipped,
      task_ids: tasks.map(t => t.id),
      message: `${tasks.length} stop tasks queued, ${skipped.length} skipped`,
    });
  } catch (error) {
    log.database.error('Database error in bulk zone stop', {
      error: error.message,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue bulk stop tasks' });
  }
};
