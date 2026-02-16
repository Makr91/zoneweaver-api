import Zones from '../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import VncSessions from '../models/VncSessionModel.js';
import Template from '../models/TemplateModel.js';
import { executeCommand } from '../lib/CommandManager.js';
import { getZoneConfig as fetchZoneConfig } from '../lib/ZoneConfigUtils.js';
import { errorResponse } from './SystemHostController/utils/ResponseHelpers.js';
import { log } from '../lib/Logger.js';
import { validateZoneName } from '../lib/ZoneValidation.js';
import config from '../config/ConfigLoader.js';

/**
 * @fileoverview Zone Management controller for Zoneweaver API
 * @description Handles zone lifecycle operations, configuration retrieval, and status management
 */

/**
 * Get current zone status from system using CommandManager
 * @param {string} zoneName - Name of the zone
 * @returns {Promise<string>} Zone status
 */
const getSystemZoneStatus = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);

  if (result.success) {
    const parts = result.output.split(':');
    return parts[2] || 'unknown';
  }
  return 'not_found';
};

/**
 * Resolve box reference to template dataset path
 * @param {Object} settings - Settings object from request
 * @param {Object} disks - Disks object from request
 * @returns {Promise<{success: boolean, template_dataset?: string, error?: Object}>}
 */
const resolveBoxToTemplate = async (settings, disks) => {
  if (!settings.box || disks?.boot?.source?.template_dataset) {
    return { success: true };
  }

  const [org, boxName] = settings.box.split('/');
  if (!org || !boxName) {
    return {
      success: false,
      error: {
        status: 400,
        message: 'Invalid box format. Expected: "organization/box-name"',
        provided: settings.box,
      },
    };
  }

  const requestedVersion = settings.box_version || 'latest';
  const architecture = settings.box_arch || 'amd64';

  let template;
  if (requestedVersion === 'latest' || !requestedVersion) {
    template = await Template.findOne({
      where: { organization: org, box_name: boxName, architecture, provider: 'zone' },
      order: [['version', 'DESC']],
    });
  } else {
    template = await Template.findOne({
      where: {
        organization: org,
        box_name: boxName,
        version: requestedVersion,
        architecture,
        provider: 'zone',
      },
    });
  }

  // Verify ZFS dataset actually exists (self-healing for manually deleted templates)
  if (template) {
    const datasetCheck = await executeCommand(`pfexec zfs list ${template.dataset_path}@ready`);
    if (!datasetCheck.success) {
      log.api.warn('Template ZFS dataset missing, removing stale DB record', {
        box: `${org}/${boxName}`,
        dataset_path: template.dataset_path,
        template_id: template.id,
      });
      await template.destroy();
      template = null;
    }
  }

  if (!template) {
    const templateConfig = config.getTemplateSources();
    const defaultSource = templateConfig.sources?.find(
      s => s.enabled && (s.name === 'Default Registry' || s.default)
    );

    return {
      success: false,
      error: {
        status: 404,
        message: 'Template not available locally',
        box: `${org}/${boxName}`,
        requested_version: requestedVersion,
        architecture,
        hint: 'Download template first using POST /templates/pull',
        note: 'For private boxes, include "auth_token" parameter in the download request',
        download_example: {
          source_name: defaultSource?.name || 'Default Registry',
          organization: org,
          box_name: boxName,
          version: requestedVersion === 'latest' ? '<specific version>' : requestedVersion,
          provider: 'zone',
          architecture,
        },
      },
    };
  }

  log.api.info('Resolved box reference to template', {
    box: `${org}/${boxName}`,
    resolved_version: template.version,
    dataset_path: template.dataset_path,
  });

  return { success: true, template_dataset: template.dataset_path };
};

/**
 * Determine source_name from box_url or use default
 * @param {string} [boxUrl] - Optional box URL
 * @returns {{success: boolean, source_name?: string, error?: string}}
 */
const determineSourceFromBoxUrl = boxUrl => {
  const templateConfig = config.getTemplateSources();

  if (boxUrl) {
    const matchingSource = templateConfig.sources?.find(s => s.enabled && boxUrl.startsWith(s.url));
    if (matchingSource) {
      return { success: true, source_name: matchingSource.name };
    }
    return {
      success: false,
      error: `No configured source matches box_url: ${boxUrl}`,
    };
  }

  const defaultSource = templateConfig.sources?.find(
    s => s.enabled && (s.name === 'Default Registry' || s.default)
  );

  if (!defaultSource) {
    return {
      success: false,
      error: 'No default template source configured',
    };
  }

  return { success: true, source_name: defaultSource.name };
};

/**
 * Create zone creation sub-tasks with proper dependencies
 * @param {string} zoneName - Zone name
 * @param {Object} requestBody - Full request body
 * @param {string} parentTaskId - Parent task ID
 * @param {string} [firstDependency] - First task dependency (e.g., template_download)
 * @param {boolean} startAfterCreate - Whether to create start task
 * @param {string} createdBy - Created by identifier
 * @returns {Promise<{subTasks: Object}>}
 */
const createZoneCreationSubTasks = async (
  zoneName,
  requestBody,
  parentTaskId,
  firstDependency,
  startAfterCreate,
  createdBy
) => {
  const baseMetadata = JSON.stringify(requestBody);

  // Sub-task 1: Storage
  const storageTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_storage',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: firstDependency,
    metadata: baseMetadata,
    status: 'pending',
  });

  // Sub-task 2: Config
  const configTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_config',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: storageTask.id,
    metadata: baseMetadata,
    status: 'pending',
  });

  // Sub-task 3: Install
  const installTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_install',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: configTask.id,
    metadata: baseMetadata,
    status: 'pending',
  });

  // Sub-task 4: Finalize
  const finalizeTask = await Tasks.create({
    zone_name: zoneName,
    operation: 'zone_create_finalize',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTaskId,
    depends_on: installTask.id,
    metadata: baseMetadata,
    status: 'pending',
  });

  const subTasks = {
    storage: storageTask.id,
    config: configTask.id,
    install: installTask.id,
    finalize: finalizeTask.id,
  };

  // Optional: Start task
  if (startAfterCreate) {
    const startTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: createdBy,
      parent_task_id: parentTaskId,
      depends_on: finalizeTask.id,
      status: 'pending',
    });
    subTasks.start = startTask.id;
  }

  return { subTasks };
};

/**
 * Handle auto-download scenario for missing templates
 * @param {string} finalZoneName - Final zone name
 * @param {Object} requestBody - Request body
 * @param {Object} settings - Settings object
 * @param {boolean} startAfterCreate - Start after create flag
 * @param {string} createdBy - Created by identifier
 * @returns {Promise<Object>} Response object
 */
const handleAutoDownload = async (
  finalZoneName,
  requestBody,
  settings,
  startAfterCreate,
  createdBy
) => {
  const parentTask = await Tasks.create({
    zone_name: finalZoneName,
    operation: 'zone_create_orchestration',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    metadata: JSON.stringify(requestBody),
    status: 'pending',
  });

  const sourceResult = determineSourceFromBoxUrl(settings.box_url);
  if (!sourceResult.success) {
    throw new Error(sourceResult.error);
  }

  const [org, boxName] = settings.box.split('/');

  const downloadTask = await Tasks.create({
    zone_name: 'system',
    operation: 'template_download',
    priority: TaskPriority.MEDIUM,
    created_by: createdBy,
    parent_task_id: parentTask.id,
    metadata: JSON.stringify({
      source_name: sourceResult.source_name,
      organization: org,
      box_name: boxName,
      version: settings.box_version || 'latest',
      provider: 'zone',
      architecture: settings.box_arch || 'amd64',
      auth_token: settings.box_auth_token,
    }),
    status: 'pending',
  });

  const { subTasks } = await createZoneCreationSubTasks(
    finalZoneName,
    requestBody,
    parentTask.id,
    downloadTask.id,
    startAfterCreate,
    createdBy
  );

  return {
    success: true,
    parent_task_id: parentTask.id,
    zone_name: finalZoneName,
    operation: 'zone_create_orchestration',
    status: 'pending',
    message: 'Template download and zone creation queued',
    requires_download: true,
    sub_tasks: {
      template_download: downloadTask.id,
      ...subTasks,
    },
  };
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
 *           enum: [running, configured, installed, stopped]
 *         description: Filter zones by status
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
    const { status, orphaned } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }

    if (orphaned !== undefined) {
      whereClause.is_orphaned = orphaned === 'true';
    }

    const zones = await Zones.findAll({
      where: whereClause,
      order: [['name', 'ASC']],
    });

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

/**
 * @swagger
 * /zones/{zoneName}/start:
 *   post:
 *     summary: Start zone
 *     description: Queues a task to start the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to start
 *     responses:
 *       200:
 *         description: Start task queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 task_id:
 *                   type: string
 *                 zone_name:
 *                   type: string
 *                 operation:
 *                   type: string
 *                 status:
 *                   type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid zone name or zone already running
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue start task
 */
export const startZone = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check if zone exists in database
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Get current system status
    const currentStatus = await getSystemZoneStatus(zoneName);

    // If already running, no need to start
    if (currentStatus === 'running') {
      return res.json({
        success: true,
        zone_name: zoneName,
        operation: 'start',
        status: 'already_running',
        message: 'Zone is already running',
      });
    }

    // Check for existing pending/running start tasks
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'start',
        status: ['pending', 'running'],
      },
    });

    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        zone_name: zoneName,
        operation: 'start',
        status: existingTask.status,
        message: 'Start task already queued',
      });
    }

    // Create new start task
    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      zone_name: zoneName,
      operation: 'start',
      status: 'pending',
      message: 'Start task queued successfully',
    });
  } catch (error) {
    log.database.error('Database error starting zone task', {
      error: error.message,
      zone_name: req.params.zoneName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue start task' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/stop:
 *   post:
 *     summary: Stop zone
 *     description: Queues a task to stop the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to stop
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force shutdown (halt instead of graceful shutdown)
 *     responses:
 *       200:
 *         description: Stop task queued successfully
 *       400:
 *         description: Invalid zone name or zone already stopped
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue stop task
 */
export const stopZone = async (req, res) => {
  try {
    const { zoneName } = req.params;
    const { force = false } = req.query;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);

    // If already stopped, no need to stop
    if (currentStatus === 'configured' || currentStatus === 'installed') {
      return res.json({
        success: true,
        zone_name: zoneName,
        operation: 'stop',
        status: 'already_stopped',
        message: 'Zone is already stopped',
      });
    }

    // Cancel any pending start tasks for this zone
    await Tasks.update(
      { status: 'cancelled' },
      {
        where: {
          zone_name: zoneName,
          operation: 'start',
          status: 'pending',
        },
      }
    );

    // Check for existing stop task
    const existingTask = await Tasks.findOne({
      where: {
        zone_name: zoneName,
        operation: 'stop',
        status: ['pending', 'running'],
      },
    });

    if (existingTask) {
      return res.json({
        success: true,
        task_id: existingTask.id,
        zone_name: zoneName,
        operation: 'stop',
        status: existingTask.status,
        message: 'Stop task already queued',
      });
    }

    const task = await Tasks.create({
      zone_name: zoneName,
      operation: 'stop',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: task.id,
      zone_name: zoneName,
      operation: 'stop',
      status: 'pending',
      message: 'Stop task queued successfully',
      force,
    });
  } catch (error) {
    log.database.error('Database error stopping zone task', {
      error: error.message,
      zone_name: req.params.zoneName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue stop task' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/restart:
 *   post:
 *     summary: Restart zone
 *     description: Queues tasks to stop and then start the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to restart
 *     responses:
 *       200:
 *         description: Restart tasks queued successfully
 *       400:
 *         description: Invalid zone name
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue restart tasks
 */
export const restartZone = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Create stop task
    const stopTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'stop',
      priority: TaskPriority.HIGH,
      created_by: req.entity.name,
      status: 'pending',
    });

    // Create start task that depends on stop task
    const startTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'start',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      depends_on: stopTask.id,
      status: 'pending',
    });

    return res.json({
      success: true,
      restart_tasks: {
        stop_task_id: stopTask.id,
        start_task_id: startTask.id,
      },
      zone_name: zoneName,
      operation: 'restart',
      status: 'pending',
      message: 'Restart tasks queued successfully',
    });
  } catch (error) {
    log.database.error('Database error restarting zone task', {
      error: error.message,
      zone_name: req.params.zoneName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue restart tasks' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}:
 *   delete:
 *     summary: Delete zone
 *     description: Queues tasks to stop, uninstall, and delete the specified zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if zone is running
 *       - in: query
 *         name: cleanup_datasets
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Also destroy ZFS datasets (boot volume, zone root dataset) after zone deletion. External datasets not in the zone hierarchy are skipped for safety.
 *     responses:
 *       200:
 *         description: Delete tasks queued successfully
 *       400:
 *         description: Invalid zone name or zone is running without force
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue delete tasks
 */
/**
 * @swagger
 * /zones:
 *   post:
 *     summary: Create a new zone
 *     description: |
 *       Queues a task to create a new zone with the specified configuration using Hosts.yml structure.
 *       Required: `settings.hostname`, `settings.domain`, `zones.brand`
 *       Optional: Box reference (`settings.box`) auto-resolves to template if available locally.
 *       The zone is created via `zonecfg` and installed via `zoneadm install`.
 *       Use `start_after_create` to automatically boot the zone after creation.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [settings, zones]
 *             properties:
 *               settings:
 *                 type: object
 *                 description: Host settings (Hosts.yml format)
 *                 required: [hostname, domain]
 *                 properties:
 *                   hostname:
 *                     type: string
 *                     description: Zone hostname (combined with domain to form FQDN)
 *                     example: "web-server-01"
 *                   domain:
 *                     type: string
 *                     description: Domain name (combined with hostname to form FQDN)
 *                     example: "example.com"
 *                   server_id:
 *                     type: string
 *                     description: Numeric server identifier (required if prefix_zone_names enabled)
 *                     example: "0001"
 *                   box:
 *                     type: string
 *                     description: "Box reference in format 'organization/box-name'. Auto-resolves to template if available locally."
 *                     example: "STARTcloud/debian13-server"
 *                   box_version:
 *                     type: string
 *                     description: "Box version. Defaults to 'latest' if omitted."
 *                     default: "latest"
 *                     example: "2025.8.22"
 *                   box_arch:
 *                     type: string
 *                     description: Box architecture
 *                     default: "amd64"
 *                     example: "amd64"
 *                   box_url:
 *                     type: string
 *                     description: "Box registry URL. Defaults to configured 'Default Registry' if omitted."
 *                     example: "https://boxvault.startcloud.com"
 *                   vcpus:
 *                     type: integer
 *                     description: Number of virtual CPUs
 *                     example: 2
 *                   memory:
 *                     type: string
 *                     description: Memory allocation
 *                     example: "2G"
 *                   os_type:
 *                     type: string
 *                     description: Guest OS type
 *                     example: "Debian_64"
 *                   consoleport:
 *                     type: integer
 *                     description: "Static VNC console port (1025-65535). If specified, this port will be reserved for this zone's VNC console. If omitted, a dynamic port is assigned."
 *                     minimum: 1025
 *                     maximum: 65535
 *                     example: 6001
 *                   consolehost:
 *                     type: string
 *                     description: "VNC bind address. Defaults to '0.0.0.0' (all interfaces). Set to '127.0.0.1' for localhost-only access."
 *                     default: "0.0.0.0"
 *                     example: "0.0.0.0"
 *               zones:
 *                 type: object
 *                 description: Zone configuration (Hosts.yml format)
 *                 required: [brand]
 *                 properties:
 *                   brand:
 *                     type: string
 *                     description: Zone brand
 *                     enum: [bhyve, lx, lipkg, sparse, pkgsrc, kvm]
 *                     example: "bhyve"
 *                   vmtype:
 *                     type: string
 *                     description: VM type classification
 *                     enum: [template, development, production, firewall, other]
 *                     default: "production"
 *                     example: "production"
 *                   hostbridge:
 *                     type: string
 *                     description: Host bridge emulation
 *                     example: "i440fx"
 *                   diskif:
 *                     type: string
 *                     description: Disk interface type
 *                     example: "virtio"
 *                   netif:
 *                     type: string
 *                     description: Network interface type
 *                     example: "virtio-net-viona"
 *                   acpi:
 *                     type: string
 *                     description: ACPI support
 *                     example: "on"
 *                   vnc:
 *                     type: string
 *                     description: VNC console setting
 *                     example: "on"
 *                   autostart:
 *                     type: boolean
 *                     description: Auto-boot zone on system startup
 *                     default: false
 *                   cpu_configuration:
 *                     type: string
 *                     enum: [simple, complex]
 *                     description: "CPU topology mode. 'simple' uses vcpus as-is, 'complex' builds topology string from complex_cpu_conf."
 *                     default: "simple"
 *                     example: "complex"
 *                   complex_cpu_conf:
 *                     type: array
 *                     description: "CPU topology specification (required if cpu_configuration is 'complex'). Array should contain one topology object."
 *                     items:
 *                       type: object
 *                       required: [sockets, cores, threads]
 *                       properties:
 *                         sockets:
 *                           type: integer
 *                           minimum: 1
 *                           maximum: 16
 *                           description: "Number of CPU sockets (bhyve limit: 16)"
 *                           example: 2
 *                         cores:
 *                           type: integer
 *                           minimum: 1
 *                           maximum: 32
 *                           description: "Cores per socket (bhyve limit: 32)"
 *                           example: 2
 *                         threads:
 *                           type: integer
 *                           minimum: 1
 *                           maximum: 2
 *                           description: "Threads per core (SMT: 1 or 2)"
 *                           example: 1
 *                     example:
 *                       - sockets: 2
 *                         cores: 2
 *                         threads: 1
 *               networks:
 *                 type: array
 *                 description: Network configuration (Hosts.yml format)
 *                 items:
 *                   type: object
 *                   properties:
 *                     type:
 *                       type: string
 *                       enum: [internal, external]
 *                       example: "internal"
 *                     address:
 *                       type: string
 *                       description: IP address
 *                       example: "10.190.190.10"
 *                     netmask:
 *                       type: string
 *                       example: "255.255.255.0"
 *                     gateway:
 *                       type: string
 *                       example: "10.190.190.1"
 *                     is_control:
 *                       type: boolean
 *                       description: Whether this is the control/management network
 *                     provisional:
 *                       type: boolean
 *                       description: Whether this is the provisioning network
 *                     dns:
 *                       type: array
 *                       description: DNS servers
 *                       items:
 *                         type: string
 *                       example: ["8.8.8.8"]
 *               disks:
 *                 type: object
 *                 description: Disk configuration. Omit entirely for diskless zones (PXE/netboot).
 *                 properties:
 *                   boot:
 *                     type: object
 *                     description: Boot disk configuration
 *                     properties:
 *                       source:
 *                         type: object
 *                         description: Boot disk source (template or scratch). Omit for existing dataset.
 *                         properties:
 *                           type:
 *                             type: string
 *                             enum: [template, scratch]
 *                             description: "template = clone from template, scratch = blank volume"
 *                             example: "template"
 *                           template_dataset:
 *                             type: string
 *                             description: Template ZFS dataset path (required if type is template)
 *                             example: "rpool/templates/STARTcloud/debian13-server/2025.8.22"
 *                           clone_strategy:
 *                             type: string
 *                             enum: [clone, copy]
 *                             description: "clone = thin ZFS clone (default), copy = full ZFS send/recv"
 *                             default: "clone"
 *                             example: "clone"
 *                       pool:
 *                         type: string
 *                         description: ZFS pool for new volume
 *                         default: "rpool"
 *                         example: "rpool"
 *                       dataset:
 *                         type: string
 *                         description: "Parent dataset path (e.g., 'zones' or 'zones/companyA/suborgB'). For existing zvol, provide full path without pool/volume_name."
 *                         default: "zones"
 *                         example: "zones"
 *                       volume_name:
 *                         type: string
 *                         description: Volume name for new volume
 *                         default: "boot"
 *                         example: "boot"
 *                       size:
 *                         type: string
 *                         description: "Volume size. For templates, volume will be grown if template is smaller."
 *                         default: "48G"
 *                         example: "48G"
 *                       sparse:
 *                         type: boolean
 *                         description: Create sparse volume (thin provisioned)
 *                         default: true
 *                   additional:
 *                     type: array
 *                     description: Additional disks beyond the boot volume
 *                     items:
 *                       type: object
 *                       properties:
 *                         pool:
 *                           type: string
 *                           description: ZFS pool
 *                           default: "rpool"
 *                           example: "rpool"
 *                         dataset:
 *                           type: string
 *                           description: "Parent dataset path or full path for existing zvol"
 *                           default: "zones"
 *                           example: "zones"
 *                         volume_name:
 *                           type: string
 *                           description: Volume name
 *                           example: "data"
 *                         size:
 *                           type: string
 *                           description: Volume size
 *                           example: "100G"
 *                         sparse:
 *                           type: boolean
 *                           description: Create sparse volume
 *                           default: true
 *               nics:
 *                 type: array
 *                 description: Network interfaces to configure
 *                 items:
 *                   type: object
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: VNIC name. Auto-generated from server_id if omitted.
 *                       example: "vnice3_0001_0"
 *                     global_nic:
 *                       type: string
 *                       description: Bridge/physical NIC for on-demand VNIC creation at zone boot. Omit for pre-created VNICs.
 *                       example: "ixgbe1"
 *                     nic_type:
 *                       type: string
 *                       description: NIC type for auto-naming convention (e=external, i=internal, etc.)
 *                       enum: [external, internal, carp, management, host]
 *                       default: "external"
 *                     vlan_id:
 *                       type: integer
 *                       description: VLAN tag ID
 *                       example: 11
 *                     mac_addr:
 *                       type: string
 *                       description: MAC address for the VNIC
 *                       example: "02:08:20:c1:38:e7"
 *                     allowed_address:
 *                       type: string
 *                       description: IP/prefix for cloud-init allowed-address (e.g. "192.168.1.10/24")
 *                       example: "192.168.1.10/24"
 *               cdroms:
 *                 type: array
 *                 description: ISO images to attach as CD-ROMs
 *                 items:
 *                   type: object
 *                   properties:
 *                     path:
 *                       type: string
 *                       description: Path to ISO file
 *                       example: "/iso/omnios-r151050.iso"
 *               cloud_init:
 *                 type: object
 *                 description: Cloud-init provisioning attributes
 *                 properties:
 *                   enabled:
 *                     type: string
 *                     description: Enable cloud-init (on/off or config filename)
 *                     example: "on"
 *                   dns_domain:
 *                     type: string
 *                     example: "example.com"
 *                   password:
 *                     type: string
 *                     example: "changeme"
 *                   resolvers:
 *                     type: string
 *                     description: Comma-separated DNS resolvers
 *                     example: "8.8.8.8,8.8.4.4"
 *                   sshkey:
 *                     type: string
 *                     description: SSH public key for root access
 *                     example: "ssh-rsa AAAA..."
 *               force:
 *                 type: boolean
 *                 description: Force attach zvols even if in use by another zone
 *                 default: false
 *               start_after_create:
 *                 type: boolean
 *                 description: Automatically start zone after creation
 *                 default: false
 *           examples:
 *             minimal:
 *               summary: Minimal zone (hostname + domain + brand only)
 *               value:
 *                 settings:
 *                   hostname: "test-vm-01"
 *                   domain: "example.com"
 *                 zones:
 *                   brand: "bhyve"
 *             with_scratch_disk:
 *               summary: Zone with blank scratch disk
 *               value:
 *                 settings:
 *                   hostname: "web-server-01"
 *                   domain: "example.com"
 *                   server_id: "0001"
 *                   vcpus: 2
 *                   memory: "2G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "scratch"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "boot"
 *                     size: "30G"
 *                     sparse: true
 *                 nics:
 *                   - global_nic: "igb0"
 *                     nic_type: "external"
 *                 start_after_create: true
 *             from_template:
 *               summary: Zone from template with additional disk
 *               value:
 *                 settings:
 *                   hostname: "debian-server"
 *                   domain: "startcloud.com"
 *                   server_id: "0002"
 *                   vcpus: 4
 *                   memory: "4G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                   hostbridge: "i440fx"
 *                   diskif: "virtio"
 *                   netif: "virtio-net-viona"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *                       template_dataset: "rpool/templates/STARTcloud/debian13-server/2025.8.22"
 *                       clone_strategy: "clone"
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "boot"
 *                     size: "48G"
 *                     sparse: true
 *                   additional:
 *                     - pool: "rpool"
 *                       dataset: "zones"
 *                       volume_name: "data"
 *                       size: "100G"
 *                       sparse: true
 *                 nics:
 *                   - global_nic: "estub_vz_1"
 *                     nic_type: "internal"
 *                   - global_nic: "ixgbe1"
 *                     vlan_id: 11
 *                     nic_type: "external"
 *                 start_after_create: false
 *             existing_dataset:
 *               summary: Zone with existing dataset
 *               value:
 *                 settings:
 *                   hostname: "migrated-vm"
 *                   domain: "example.com"
 *                   vcpus: 4
 *                   memory: "4G"
 *                 zones:
 *                   brand: "bhyve"
 *                 disks:
 *                   boot:
 *                     dataset: "rpool/vms/old-server/root"
 *             from_box_reference:
 *               summary: Zone from box reference (auto-resolve template)
 *               value:
 *                 settings:
 *                   hostname: "auto-resolved"
 *                   domain: "startcloud.com"
 *                   server_id: "0003"
 *                   box: "STARTcloud/debian13-server"
 *                   box_version: "2025.8.22"
 *                   box_arch: "amd64"
 *                   vcpus: 2
 *                   memory: "4G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *                 nics:
 *                   - global_nic: "estub_vz_1"
 *                     nic_type: "internal"
 *                 start_after_create: false
 *             from_box_latest:
 *               summary: Zone from box (latest version)
 *               value:
 *                 settings:
 *                   hostname: "latest-test"
 *                   domain: "example.com"
 *                   box: "STARTcloud/debian13-server"
 *                 zones:
 *                   brand: "bhyve"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *             with_complex_cpu:
 *               summary: Zone with complex CPU topology
 *               value:
 *                 settings:
 *                   hostname: "high-performance"
 *                   domain: "example.com"
 *                   server_id: "0010"
 *                   vcpus: 8
 *                   memory: "16G"
 *                 zones:
 *                   brand: "bhyve"
 *                   vmtype: "production"
 *                   cpu_configuration: "complex"
 *                   complex_cpu_conf:
 *                     - sockets: 2
 *                       cores: 2
 *                       threads: 2
 *                   hostbridge: "i440fx"
 *                   diskif: "virtio"
 *                   netif: "virtio-net-viona"
 *                 disks:
 *                   boot:
 *                     source:
 *                       type: "template"
 *                       template_dataset: "rpool/templates/STARTcloud/debian13-server/2025.8.22"
 *                 nics:
 *                   - global_nic: "ixgbe1"
 *                     vlan_id: 11
 *                     nic_type: "external"
 *     responses:
 *       200:
 *         description: Zone creation orchestration queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 parent_task_id:
 *                   type: string
 *                   format: uuid
 *                   description: Parent orchestration task ID (poll this for overall progress)
 *                 zone_name:
 *                   type: string
 *                   example: "0001--web-server-01.example.com"
 *                 operation:
 *                   type: string
 *                   example: "zone_create_orchestration"
 *                 status:
 *                   type: string
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Template download and zone creation queued"
 *                 requires_download:
 *                   type: boolean
 *                   description: Whether template auto-download was triggered
 *                   example: true
 *                 sub_tasks:
 *                   type: object
 *                   description: IDs of all sub-tasks
 *                   properties:
 *                     template_download:
 *                       type: string
 *                       format: uuid
 *                       description: Template download task (only if requires_download is true)
 *                     storage:
 *                       type: string
 *                       format: uuid
 *                     config:
 *                       type: string
 *                       format: uuid
 *                     install:
 *                       type: string
 *                       format: uuid
 *                     finalize:
 *                       type: string
 *                       format: uuid
 *                     start:
 *                       type: string
 *                       format: uuid
 *                       description: Start task (only if start_after_create is true)
 *       400:
 *         description: Invalid parameters (missing name/brand or invalid zone name)
 *       409:
 *         description: Zone already exists in database or on system
 *       500:
 *         description: Failed to queue creation task
 */
export const createZone = async (req, res) => {
  try {
    // NEW HOSTS.YML STRUCTURE ONLY
    const { settings, zones, start_after_create } = req.body;

    if (!settings?.hostname || !settings?.domain || !zones?.brand) {
      return res.status(400).json({
        error:
          'Missing required parameters: settings.hostname, settings.domain, and zones.brand are required',
      });
    }

    // Build base FQDN: hostname.domain
    const baseName = `${settings.hostname}.${settings.domain}`;

    if (!validateZoneName(baseName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check if prefix mode is enabled
    const zonesConfig = config.getZones();
    let finalZoneName = baseName;
    let serverId = null;

    if (zonesConfig.prefix_zone_names) {
      // Prefix mode enabled - server_id is REQUIRED
      if (!settings.server_id) {
        return res.status(400).json({
          error: 'server_id required when prefix_zone_names is enabled',
          hint: 'Use GET /zones/ids to find available server IDs',
          config: {
            prefix_zone_names: true,
            constraints: {
              format: 'numeric',
              min_length: 4,
              max_length: 8,
              min_value: 1,
              max_value: 99999999,
            },
          },
        });
      }

      // Validate server_id format (numeric, will be padded to 4 digits minimum)
      serverId = String(settings.server_id).padStart(4, '0');
      if (!/^\d+$/u.test(settings.server_id)) {
        return res.status(400).json({
          error: 'server_id must be numeric',
          provided: settings.server_id,
        });
      }

      // Check if server_id is already in use
      const existingServerId = await Zones.findOne({ where: { server_id: serverId } });
      if (existingServerId) {
        return res.status(409).json({
          error: `Server ID ${serverId} is already in use`,
          zone: existingServerId.name,
          hint: 'Use GET /zones/ids/next to get the next available ID',
        });
      }

      // Build final zone name with prefix
      finalZoneName = `${serverId}--${baseName}`;
    }

    // Check zone doesn't exist in DB (using final name)
    const existingZone = await Zones.findOne({ where: { name: finalZoneName } });
    if (existingZone) {
      return res.status(409).json({ error: `Zone ${finalZoneName} already exists in database` });
    }

    // Check zone doesn't exist on system (using final name)
    const systemStatus = await getSystemZoneStatus(finalZoneName);
    if (systemStatus !== 'not_found') {
      return res.status(409).json({
        error: `Zone ${finalZoneName} already exists on the system`,
        system_status: systemStatus,
      });
    }

    // Box resolution: convert settings.box reference to template_dataset path
    const boxResolution = await resolveBoxToTemplate(settings, req.body.disks);

    // Ensure metadata.name is set for task executor (base name, not prefixed)
    req.body.name = baseName;

    // Template found locally - inject template_dataset
    if (boxResolution.success && boxResolution.template_dataset) {
      req.body.disks = req.body.disks || {};
      req.body.disks.boot = req.body.disks.boot || {};
      req.body.disks.boot.source = {
        type: 'template',
        template_dataset: boxResolution.template_dataset,
        clone_strategy: 'clone',
      };
    }

    // Handle missing template with auto-download
    if (!boxResolution.success && boxResolution.error.status === 404 && settings.box) {
      const response = await handleAutoDownload(
        finalZoneName,
        req.body,
        settings,
        start_after_create,
        req.entity.name
      );
      return res.json(response);
    }

    // Template missing but cannot auto-download (no box reference)
    if (!boxResolution.success) {
      return res.status(boxResolution.error.status).json(boxResolution.error);
    }

    // Template available - create orchestration with sub-tasks (no download)
    const parentTask = await Tasks.create({
      zone_name: finalZoneName,
      operation: 'zone_create_orchestration',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(req.body),
      status: 'pending',
    });

    // Create zone creation sub-tasks (no download dependency)
    const { subTasks } = await createZoneCreationSubTasks(
      finalZoneName,
      req.body,
      parentTask.id,
      null,
      start_after_create,
      req.entity.name
    );

    return res.json({
      success: true,
      parent_task_id: parentTask.id,
      zone_name: finalZoneName,
      operation: 'zone_create_orchestration',
      status: 'pending',
      message: 'Zone creation queued',
      requires_download: false,
      sub_tasks: subTasks,
    });
  } catch (error) {
    log.database.error('Database error creating zone task', {
      error: error.message,
      zone_name: req.body.name,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue zone creation task' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}:
 *   put:
 *     summary: Modify zone configuration
 *     description: |
 *       Queues a task to modify an existing zone's configuration via `zonecfg`.
 *       Changes are applied to the zone config but take effect on next zone boot.
 *       The zone can continue running while modifications are queued.
 *       At least one modification field must be provided.
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ram:
 *                 type: string
 *                 description: Memory allocation
 *                 example: "4G"
 *               vcpus:
 *                 type: string
 *                 description: Number of virtual CPUs
 *                 example: "4"
 *               bootrom:
 *                 type: string
 *                 description: Boot ROM firmware
 *                 example: "BHYVE_RELEASE_CSM"
 *               hostbridge:
 *                 type: string
 *                 description: Host bridge emulation
 *                 example: "i440fx"
 *               diskif:
 *                 type: string
 *                 description: Disk interface type
 *                 example: "virtio"
 *               netif:
 *                 type: string
 *                 description: Network interface type
 *                 example: "virtio"
 *               os_type:
 *                 type: string
 *                 description: Guest OS type
 *                 example: "generic"
 *               vnc:
 *                 type: string
 *                 description: VNC console setting
 *                 example: "on"
 *               acpi:
 *                 type: string
 *                 description: ACPI support
 *                 example: "on"
 *               xhci:
 *                 type: string
 *                 description: xHCI USB controller
 *                 example: "on"
 *               autoboot:
 *                 type: boolean
 *                 description: Auto-boot zone on system startup
 *               cpu_configuration:
 *                 type: string
 *                 enum: [simple, complex]
 *                 description: "Change CPU topology mode"
 *                 example: "complex"
 *               complex_cpu_conf:
 *                 type: array
 *                 description: "New CPU topology (required if cpu_configuration is 'complex')"
 *                 items:
 *                   type: object
 *                   required: [sockets, cores, threads]
 *                   properties:
 *                     sockets:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 16
 *                     cores:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 32
 *                     threads:
 *                       type: integer
 *                       minimum: 1
 *                       maximum: 2
 *                 example:
 *                   - sockets: 2
 *                     cores: 2
 *                     threads: 1
 *               add_nics:
 *                 type: array
 *                 description: NICs to add to the zone
 *                 items:
 *                   type: object
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: VNIC name
 *                       example: "vnic1"
 *                     global_nic:
 *                       type: string
 *                       description: Bridge/physical NIC for on-demand creation
 *                       example: "igb0"
 *               remove_nics:
 *                 type: array
 *                 description: VNIC names to remove
 *                 items:
 *                   type: string
 *                   example: "vnic0"
 *               add_disks:
 *                 type: array
 *                 description: Disks to add (new zvols or existing datasets)
 *                 items:
 *                   type: object
 *                   properties:
 *                     create_new:
 *                       type: boolean
 *                     existing_dataset:
 *                       type: string
 *                     pool:
 *                       type: string
 *                       example: "rpool"
 *                     dataset:
 *                       type: string
 *                       example: "zones"
 *                     volume_name:
 *                       type: string
 *                       example: "extra"
 *                     size:
 *                       type: string
 *                       example: "100G"
 *               remove_disks:
 *                 type: array
 *                 description: Disk attribute names to remove (e.g. "disk0")
 *                 items:
 *                   type: string
 *                   example: "disk0"
 *               add_cdroms:
 *                 type: array
 *                 description: ISO images to attach
 *                 items:
 *                   type: object
 *                   properties:
 *                     path:
 *                       type: string
 *                       example: "/iso/install.iso"
 *               remove_cdroms:
 *                 type: array
 *                 description: CDROM attribute names to remove (e.g. "cdrom0")
 *                 items:
 *                   type: string
 *                   example: "cdrom0"
 *               cloud_init:
 *                 type: object
 *                 description: Cloud-init attributes to set or update
 *                 properties:
 *                   enabled:
 *                     type: string
 *                     example: "on"
 *                   dns_domain:
 *                     type: string
 *                     example: "example.com"
 *                   password:
 *                     type: string
 *                   resolvers:
 *                     type: string
 *                     example: "8.8.8.8,8.8.4.4"
 *                   sshkey:
 *                     type: string
 *           examples:
 *             change_resources:
 *               summary: Change RAM and vCPUs
 *               value:
 *                 ram: "4G"
 *                 vcpus: "4"
 *             add_nic:
 *               summary: Add a NIC
 *               value:
 *                 add_nics:
 *                   - physical: "vnic1"
 *                     global_nic: "igb0"
 *             add_disk:
 *               summary: Add a new disk
 *               value:
 *                 add_disks:
 *                   - create_new: true
 *                     pool: "rpool"
 *                     dataset: "zones"
 *                     volume_name: "extra"
 *                     size: "100G"
 *     responses:
 *       200:
 *         description: Modification task queued successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 zone_name:
 *                   type: string
 *                   example: "web-server-01"
 *                 operation:
 *                   type: string
 *                   example: "zone_modify"
 *                 status:
 *                   type: string
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Modification queued. Changes will take effect on next zone boot."
 *                 requires_restart:
 *                   type: boolean
 *                   example: true
 *       400:
 *         description: Invalid parameters or no changes specified
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to queue modification task
 */
export const modifyZone = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check zone exists in DB
    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    // Validate that at least one change field is present
    const changeFields = [
      'ram',
      'vcpus',
      'bootrom',
      'hostbridge',
      'diskif',
      'netif',
      'os_type',
      'vnc',
      'acpi',
      'xhci',
      'autoboot',
      'add_nics',
      'remove_nics',
      'add_disks',
      'remove_disks',
      'add_cdroms',
      'remove_cdroms',
      'cloud_init',
      'provisioner',
    ];
    const hasChanges = changeFields.some(field => req.body[field] !== undefined);

    if (!hasChanges) {
      return res.status(400).json({ error: 'No modification fields specified' });
    }

    // Handle provisioner config update immediately (DB only)
    // This ensures the config is available for the provision endpoint without waiting for the task
    if (req.body.provisioner) {
      let currentConfig = zone.configuration || {};
      if (typeof currentConfig === 'string') {
        try {
          currentConfig = JSON.parse(currentConfig);
        } catch (e) {
          log.database.warn('Failed to parse current zone configuration', { error: e.message });
          currentConfig = {};
        }
      }
      const newConfig = { ...currentConfig, provisioner: req.body.provisioner };
      await zone.update({ configuration: newConfig });

      // If this is the only change, we can return early without queuing a task
      const otherChanges = changeFields
        .filter(f => f !== 'provisioner')
        .some(field => req.body[field] !== undefined);
      if (!otherChanges) {
        return res.json({
          success: true,
          zone_name: zoneName,
          operation: 'zone_modify',
          status: 'completed',
          message: 'Provisioner configuration updated successfully.',
          requires_restart: false,
        });
      }
    }

    // Create the zone_modify task
    const modifyTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'zone_modify',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(req.body),
      status: 'pending',
    });

    return res.json({
      success: true,
      task_id: modifyTask.id,
      zone_name: zoneName,
      operation: 'zone_modify',
      status: 'pending',
      message: 'Modification queued. Changes will take effect on next zone boot.',
      requires_restart: true,
    });
  } catch (error) {
    log.database.error('Database error modifying zone task', {
      error: error.message,
      zone_name: req.params.zoneName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue zone modification task' });
  }
};

export const deleteZone = async (req, res) => {
  try {
    const { zoneName } = req.params;
    const { force = false, cleanup_datasets = false, cleanup_networking = false } = req.query;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const currentStatus = await getSystemZoneStatus(zoneName);

    const tasks = [];

    // If zone is running and force is not specified, require explicit force
    if (currentStatus === 'running' && !force) {
      return res.status(400).json({
        error: 'Zone is running. Use force=true to stop and delete',
        current_status: currentStatus,
      });
    }

    // Build delete task metadata
    const deleteMetadata = JSON.stringify({
      cleanup_datasets: cleanup_datasets === 'true' || cleanup_datasets === true,
      cleanup_networking: cleanup_networking === 'true' || cleanup_networking === true,
    });

    // If zone is running, create stop task first
    if (currentStatus === 'running') {
      const stopTask = await Tasks.create({
        zone_name: zoneName,
        operation: 'stop',
        priority: TaskPriority.CRITICAL,
        created_by: req.entity.name,
        status: 'pending',
      });
      tasks.push(stopTask);

      // Create delete task that depends on stop
      const deleteTask = await Tasks.create({
        zone_name: zoneName,
        operation: 'delete',
        priority: TaskPriority.CRITICAL,
        created_by: req.entity.name,
        depends_on: stopTask.id,
        metadata: deleteMetadata,
        status: 'pending',
      });
      tasks.push(deleteTask);
    } else {
      // Zone is not running, just delete
      const deleteTask = await Tasks.create({
        zone_name: zoneName,
        operation: 'delete',
        priority: TaskPriority.CRITICAL,
        created_by: req.entity.name,
        metadata: deleteMetadata,
        status: 'pending',
      });
      tasks.push(deleteTask);
    }

    return res.json({
      success: true,
      delete_tasks: tasks.map(t => t.id),
      zone_name: zoneName,
      operation: 'delete',
      status: 'pending',
      message: 'Delete tasks queued successfully',
      force,
    });
  } catch (error) {
    log.database.error('Database error deleting zone task', {
      error: error.message,
      zone_name: req.params.zoneName,
      user: req.entity.name,
    });
    return res.status(500).json({ error: 'Failed to queue delete tasks' });
  }
};
