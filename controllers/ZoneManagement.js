import Zones from '../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import VncSessions from '../models/VncSessionModel.js';
import { executeCommand } from '../lib/CommandManager.js';
import { getZoneConfig as fetchZoneConfig } from '../lib/ZoneConfigUtils.js';
import { errorResponse } from './SystemHostController/utils/ResponseHelpers.js';
import { log } from '../lib/Logger.js';
import { validateZoneName } from '../lib/ZoneValidation.js';

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
    const config = await fetchZoneConfig(zoneName);

    return res.json({
      zone_name: zoneName,
      configuration: config,
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
 *       Queues a task to create a new zone with the specified configuration.
 *       Only `name` and `brand` are required - all other fields are optional.
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
 *             required: [name, brand]
 *             properties:
 *               name:
 *                 type: string
 *                 description: Zone name (alphanumeric, hyphens, underscores)
 *                 example: "web-server-01"
 *               brand:
 *                 type: string
 *                 description: Zone brand
 *                 enum: [bhyve, lx, lipkg, sparse, pkgsrc, kvm]
 *                 example: "bhyve"
 *               ram:
 *                 type: string
 *                 description: Memory allocation
 *                 example: "2G"
 *               vcpus:
 *                 type: string
 *                 description: Number of virtual CPUs
 *                 example: "2"
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
 *                 default: false
 *               zonepath:
 *                 type: string
 *                 description: Custom zone path (auto-generated if omitted)
 *                 example: "/rpool/zones/web-server-01/path"
 *               boot_volume:
 *                 type: object
 *                 description: Boot disk configuration. Omit entirely for diskless zones (PXE/netboot).
 *                 properties:
 *                   create_new:
 *                     type: boolean
 *                     description: Create a new ZFS volume for boot disk
 *                   existing_dataset:
 *                     type: string
 *                     description: Path to existing ZFS dataset to attach (mutually exclusive with create_new)
 *                     example: "rpool/vms/old-server/root"
 *                   pool:
 *                     type: string
 *                     description: ZFS pool for new volume
 *                     example: "rpool"
 *                   dataset:
 *                     type: string
 *                     description: Parent dataset path
 *                     example: "zones"
 *                   volume_name:
 *                     type: string
 *                     description: Volume name
 *                     example: "root"
 *                   size:
 *                     type: string
 *                     description: Volume size
 *                     example: "30G"
 *                   sparse:
 *                     type: boolean
 *                     description: Create sparse volume (thin provisioned)
 *               source:
 *                 type: object
 *                 description: Zone source - scratch (default) or template
 *                 properties:
 *                   type:
 *                     type: string
 *                     enum: [scratch, template]
 *                     example: "scratch"
 *                   template_dataset:
 *                     type: string
 *                     description: Template ZFS dataset (required if type is template)
 *                     example: "rpool/templates/omnios-base"
 *                   clone_strategy:
 *                     type: string
 *                     enum: [clone, copy]
 *                     description: "clone = thin ZFS clone, copy = full ZFS send/recv"
 *                     example: "clone"
 *               nics:
 *                 type: array
 *                 description: Network interfaces to configure
 *                 items:
 *                   type: object
 *                   properties:
 *                     physical:
 *                       type: string
 *                       description: VNIC name
 *                       example: "vnic0"
 *                     global_nic:
 *                       type: string
 *                       description: Bridge/physical NIC for on-demand VNIC creation. Omit for pre-created VNICs.
 *                       example: "igb0"
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
 *               additional_disks:
 *                 type: array
 *                 description: Additional disks beyond the boot volume
 *                 items:
 *                   type: object
 *                   properties:
 *                     create_new:
 *                       type: boolean
 *                       description: Create a new ZFS volume
 *                     existing_dataset:
 *                       type: string
 *                       description: Path to existing zvol
 *                     pool:
 *                       type: string
 *                       example: "rpool"
 *                     dataset:
 *                       type: string
 *                       example: "zones"
 *                     volume_name:
 *                       type: string
 *                       example: "data"
 *                     size:
 *                       type: string
 *                       example: "50G"
 *                     sparse:
 *                       type: boolean
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
 *               summary: Minimal zone (name + brand only)
 *               value:
 *                 name: "test-vm-01"
 *                 brand: "bhyve"
 *             with_resources:
 *               summary: Zone with resources
 *               value:
 *                 name: "web-server-01"
 *                 brand: "bhyve"
 *                 ram: "2G"
 *                 vcpus: "2"
 *                 boot_volume:
 *                   create_new: true
 *                   pool: "rpool"
 *                   dataset: "zones"
 *                   volume_name: "root"
 *                   size: "30G"
 *                 nics:
 *                   - physical: "vnic0"
 *                     global_nic: "igb0"
 *                 start_after_create: true
 *             from_template:
 *               summary: Zone from template
 *               value:
 *                 name: "from-template"
 *                 brand: "bhyve"
 *                 source:
 *                   type: "template"
 *                   template_dataset: "rpool/templates/omnios-base"
 *                   clone_strategy: "clone"
 *                 boot_volume:
 *                   pool: "rpool"
 *                   dataset: "zones"
 *                   volume_name: "root"
 *                   size: "30G"
 *             existing_zvol:
 *               summary: Zone with existing zvol
 *               value:
 *                 name: "migrated-vm"
 *                 brand: "bhyve"
 *                 ram: "4G"
 *                 vcpus: "4"
 *                 boot_volume:
 *                   create_new: false
 *                   existing_dataset: "rpool/vms/old-server/root"
 *     responses:
 *       200:
 *         description: Creation task queued successfully
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
 *                   example: "zone_create"
 *                 status:
 *                   type: string
 *                   example: "pending"
 *                 message:
 *                   type: string
 *                   example: "Zone creation task queued successfully"
 *                 start_task_id:
 *                   type: string
 *                   format: uuid
 *                   description: Present only when start_after_create is true
 *       400:
 *         description: Invalid parameters (missing name/brand or invalid zone name)
 *       409:
 *         description: Zone already exists in database or on system
 *       500:
 *         description: Failed to queue creation task
 */
export const createZone = async (req, res) => {
  try {
    const { name, brand, start_after_create } = req.body;

    if (!name || !brand) {
      return res.status(400).json({ error: 'Missing required parameters: name and brand' });
    }

    if (!validateZoneName(name)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check zone doesn't exist in DB
    const existingZone = await Zones.findOne({ where: { name } });
    if (existingZone) {
      return res.status(409).json({ error: `Zone ${name} already exists in database` });
    }

    // Check zone doesn't exist on system
    const systemStatus = await getSystemZoneStatus(name);
    if (systemStatus !== 'not_found') {
      return res.status(409).json({
        error: `Zone ${name} already exists on the system`,
        system_status: systemStatus,
      });
    }

    // Create the zone_create task
    const createTask = await Tasks.create({
      zone_name: name,
      operation: 'zone_create',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      metadata: JSON.stringify(req.body),
      status: 'pending',
    });

    const response = {
      success: true,
      task_id: createTask.id,
      zone_name: name,
      operation: 'zone_create',
      status: 'pending',
      message: 'Zone creation task queued successfully',
    };

    // If start_after_create, create a dependent start task
    if (start_after_create) {
      const startTask = await Tasks.create({
        zone_name: name,
        operation: 'start',
        priority: TaskPriority.MEDIUM,
        created_by: req.entity.name,
        depends_on: createTask.id,
        status: 'pending',
      });
      response.start_task_id = startTask.id;
      response.message = 'Zone creation task queued with auto-start';
    }

    return res.json(response);
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
      'provisioning',
    ];
    const hasChanges = changeFields.some(field => req.body[field] !== undefined);

    if (!hasChanges) {
      return res.status(400).json({ error: 'No modification fields specified' });
    }

    // Handle provisioning config update immediately (DB only)
    // This ensures the config is available for the provision endpoint without waiting for the task
    if (req.body.provisioning) {
      const currentConfig = zone.configuration || {};
      const newConfig = { ...currentConfig, provisioning: req.body.provisioning };
      await zone.update({ configuration: newConfig });

      // If this is the only change, we can return early without queuing a task
      const otherChanges = changeFields
        .filter(f => f !== 'provisioning')
        .some(field => req.body[field] !== undefined);
      if (!otherChanges) {
        return res.json({
          success: true,
          zone_name: zoneName,
          operation: 'zone_modify',
          status: 'completed',
          message: 'Provisioning configuration updated successfully.',
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
