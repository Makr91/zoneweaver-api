/**
 * @fileoverview Provisioning Orchestration Controller for Zoneweaver API
 * @description High-level provisioning pipeline orchestration endpoints.
 *              Kicks off multi-step provisioning: extract artifact → boot → setup → wait SSH → sync → provision.
 */

import Zones from '../models/ZoneModel.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import ProvisioningProfiles from '../models/ProvisioningProfileModel.js';
import Recipes from '../models/RecipeModel.js';
import { log } from '../lib/Logger.js';
import { validateZoneName } from '../lib/ZoneValidation.js';
import { waitForSSH } from '../lib/SSHManager.js';

/**
 * Validate provisioning request and zone state
 * Supports both old structure (provisioning) and new Hosts.yml structure (provisioner + settings/networks)
 * @param {string} zoneName - Zone name
 * @param {Object} zone - Zone database record
 * @param {boolean} skipRecipe - Whether to skip recipe
 * @returns {Promise<{valid: boolean, error?: string, provisioning?: Object, recipeId?: string, zoneIP?: string, credentials?: Object}>}
 */
const validateProvisioningRequest = async (zoneName, zone, skipRecipe) => {
  if (!validateZoneName(zoneName)) {
    return { valid: false, error: 'Invalid zone name' };
  }

  if (!zone) {
    return { valid: false, error: `Zone '${zoneName}' not found` };
  }

  let zoneConfig = zone.configuration;
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.api.warn('Failed to parse zone configuration', { error: e.message });
      zoneConfig = {};
    }
  }

  // NEW STRUCTURE: Read provisioner instead of provisioning
  const provisioner = zoneConfig?.provisioner;
  const provisioning = zoneConfig?.provisioning; // Fallback for old structure

  const config = provisioner || provisioning;
  if (!config) {
    return {
      valid: false,
      error:
        'No provisioner configuration found. Set provisioner config via PUT /zones/:name first.',
    };
  }

  // NEW STRUCTURE: Extract credentials from settings
  const { extractCredentialsFromSettings, extractControlIP } =
    await import('../lib/ProvisionerConfigBuilder.js');

  let credentials;
  let zoneIP;

  if (zoneConfig.settings) {
    // New Hosts.yml structure
    credentials = extractCredentialsFromSettings(zoneConfig.settings);
    if (!credentials.username) {
      return {
        valid: false,
        error: 'Credentials missing: settings.vagrant_user is required',
      };
    }

    // Extract IP from networks array
    zoneIP = extractControlIP(zoneConfig.networks);
    if (!zoneIP) {
      return {
        valid: false,
        error: 'Zone IP address not found in networks array (set is_control: true on one network)',
      };
    }
  } else {
    // OLD STRUCTURE: Fallback to provisioning.credentials and provisioning.ip
    const { credentials: configCredentials, ip: configIP, variables } = config;
    credentials = configCredentials;
    if (!credentials || !credentials.username) {
      return {
        valid: false,
        error: 'Provisioning credentials are required (at minimum: username)',
      };
    }

    zoneIP = configIP || variables?.ip;
    if (!zoneIP) {
      return { valid: false, error: 'Zone IP address not configured in provisioning metadata' };
    }
  }

  // Validate recipe if specified
  const recipeId = config.recipe_id;
  if (recipeId && !skipRecipe) {
    const recipe = await Recipes.findByPk(recipeId);
    if (!recipe) {
      return { valid: false, error: `Recipe '${recipeId}' not found` };
    }
  }

  return {
    valid: true,
    provisioning: config,
    recipeId,
    zoneIP,
    credentials,
  };
};

/**
 * Create a task in the chain
 * @param {Object} params - Task parameters
 * @returns {Promise<Object>} Created task
 */
const createTask = params =>
  Tasks.create({
    zone_name: params.zone_name,
    operation: params.operation,
    status: 'pending',
    metadata: params.metadata ? JSON.stringify(params.metadata) : null,
    depends_on: params.depends_on,
    parent_task_id: params.parent_task_id,
    created_by: params.created_by,
  });

/**
 * Create sequential folder sync tasks
 * @param {Array} folders - Folders to sync
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} syncParentTaskId - Parent task ID
 * @param {string} createdBy - Task creator
 * @returns {Promise<void>}
 */
const createSequentialFolderTasks = (
  folders,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  syncParentTaskId,
  createdBy
) =>
  folders.reduce(
    (promise, folder) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_sync',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            folder,
          },
          depends_on: prevTaskId,
          parent_task_id: syncParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(syncParentTaskId)
  );

/**
 * Create sequential playbook provision tasks
 * @param {Array} playbooks - Playbooks to execute
 * @param {string} zoneName - Zone name
 * @param {string} zoneIP - Zone IP address
 * @param {Object} credentials - SSH credentials
 * @param {Object} provisioning - Provisioning config
 * @param {string} provisionParentTaskId - Parent task ID
 * @param {string} createdBy - Task creator
 * @returns {Promise<void>}
 */
const createSequentialPlaybookTasks = (
  playbooks,
  zoneName,
  zoneIP,
  credentials,
  provisioning,
  provisionParentTaskId,
  createdBy
) =>
  playbooks.reduce(
    (promise, playbook) =>
      promise.then(prevTaskId =>
        createTask({
          zone_name: zoneName,
          operation: 'zone_provision',
          metadata: {
            ip: zoneIP,
            port: provisioning.ssh_port || 22,
            credentials,
            playbook,
          },
          depends_on: prevTaskId,
          parent_task_id: provisionParentTaskId,
          created_by: createdBy,
        }).then(task => task.id)
      ),
    Promise.resolve(provisionParentTaskId)
  );

/**
 * Check if SSH is accessible and zone_setup can be skipped
 * @param {Object} zone - Zone database record
 * @param {string} zoneIP - Zone IP address
 * @param {Object} provisioning - Provisioning config
 * @returns {Promise<boolean>} True if should skip zone_setup
 */
const shouldSkipZoneSetup = async (zone, zoneIP, provisioning) => {
  if (zone.status !== 'running') {
    return false;
  }

  try {
    const zoneConfig =
      typeof zone.configuration === 'string' ? JSON.parse(zone.configuration) : zone.configuration;
    const provisioningBasePath = zoneConfig.zonepath
      ? `${zoneConfig.zonepath.replace('/path', '')}/provisioning`
      : null;

    const sshCheck = await waitForSSH(
      zoneIP,
      provisioning.credentials?.username || 'root',
      provisioning.credentials,
      provisioning.ssh_port || 22,
      5000,
      2000,
      provisioningBasePath
    );

    if (sshCheck.success) {
      log.api.info('SSH already accessible, skipping zone_setup', {
        zone_name: zone.name,
        ip: zoneIP,
      });
      return true;
    }
  } catch (error) {
    log.api.debug('SSH check failed, will run zone_setup', {
      zone_name: zone.name,
      error: error.message,
    });
  }

  return false;
};

/**
 * Build provisioning task chain with granular folder/playbook tasks
 * Creates parent tasks for sync and provision steps with individual child tasks
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} Task chain
 */
const buildProvisioningTaskChain = async params => {
  const {
    zoneName,
    zone,
    skipBoot,
    skipRecipe,
    recipeId,
    provisioning,
    zoneIP,
    credentials,
    artifactId,
    parentTaskId,
    createdBy,
  } = params;

  const taskChain = [];
  let previousTaskId = null;
  let provisioningDatasetPath = null;

  // Step 0: Extract artifact (if provided)
  if (artifactId) {
    let zoneConfig = zone.configuration || {};
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (e) {
        log.api.warn('Failed to parse zone configuration', { error: e.message });
        zoneConfig = {};
      }
    }
    const zoneDataset = zoneConfig.zonepath
      ? zoneConfig.zonepath.replace('/path', '')
      : `/rpool/zones/${zoneName}`;

    const cleanZoneDataset = zoneDataset.startsWith('/') ? zoneDataset.substring(1) : zoneDataset;
    const provisioningDataset = `${cleanZoneDataset}/provisioning`;
    provisioningDatasetPath = `/${provisioningDataset}`;

    const extractTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provisioning_extract',
      metadata: {
        artifact_id: artifactId,
        dataset_path: provisioningDatasetPath,
      },
      depends_on: null,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({ step: 'extract', task_id: extractTask.id });
    previousTaskId = extractTask.id;
  }

  // Step 1: Boot zone
  if (!skipBoot && zone.status !== 'running') {
    const bootTask = await createTask({
      zone_name: zoneName,
      operation: 'start',
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({ step: 'boot', task_id: bootTask.id });
    previousTaskId = bootTask.id;
  }

  // Step 2: Run zlogin recipe (skip if SSH is already accessible)
  let shouldRunSetup = recipeId && !skipRecipe;
  if (shouldRunSetup) {
    const skipDueToSSH = await shouldSkipZoneSetup(zone, zoneIP, {
      credentials,
      ssh_port: provisioning.ssh_port,
    });
    if (skipDueToSSH) {
      shouldRunSetup = false;
    }
  }

  if (shouldRunSetup) {
    const recipeVariables = {
      ...(provisioning.variables || {}),
      username: credentials.username,
      password: credentials.password,
    };

    const setupTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_setup',
      metadata: {
        recipe_id: recipeId,
        variables: recipeVariables,
      },
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({ step: 'setup', task_id: setupTask.id });
    previousTaskId = setupTask.id;
  }

  // Step 3: Wait for SSH
  const sshTask = await createTask({
    zone_name: zoneName,
    operation: 'zone_wait_ssh',
    metadata: {
      ip: zoneIP,
      port: provisioning.ssh_port || 22,
      credentials,
    },
    depends_on: previousTaskId,
    parent_task_id: parentTaskId,
    created_by: createdBy,
  });
  taskChain.push({ step: 'wait_ssh', task_id: sshTask.id });
  previousTaskId = sshTask.id;

  // Step 4: Sync files with GRANULAR TASKS (one task per folder)
  const folders = provisioning.folders || provisioning.sync_folders || [];

  if (folders.length > 0) {
    // Create parent task for folder sync
    const syncParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_sync_parent',
      metadata: { total_folders: folders.length },
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({
      step: 'sync_parent',
      task_id: syncParentTask.id,
      folder_count: folders.length,
    });

    // Create individual sync tasks sequentially (each depends on previous)
    await createSequentialFolderTasks(
      folders,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      syncParentTask.id,
      createdBy
    );
    previousTaskId = syncParentTask.id;
  }

  // Step 5: Execute provisioners with GRANULAR TASKS (one task per playbook)
  const playbooks =
    provisioning.provisioning?.ansible?.playbooks?.local || provisioning.provisioners || [];

  if (playbooks.length > 0) {
    // Create parent task for provisioning
    const provisionParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provision_parent',
      metadata: { total_playbooks: playbooks.length },
      depends_on: previousTaskId,
      parent_task_id: parentTaskId,
      created_by: createdBy,
    });
    taskChain.push({
      step: 'provision_parent',
      task_id: provisionParentTask.id,
      playbook_count: playbooks.length,
    });

    // Create individual provision tasks sequentially (each depends on previous)
    await createSequentialPlaybookTasks(
      playbooks,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      provisionParentTask.id,
      createdBy
    );
  }

  return taskChain;
};

/**
 * @swagger
 * /zones/{name}/provision:
 *   post:
 *     summary: Kick off provisioning pipeline for a zone
 *     description: |
 *       Orchestrates the full provisioning pipeline:
 *       1. Boot zone (if not running)
 *       2. Run zlogin recipe (zone_setup) to configure network
 *       3. Wait for SSH to become available (zone_wait_ssh)
 *       4. Sync provisioning files to zone (zone_sync)
 *       5. Execute provisioners (zone_provision)
 *
 *       Prerequisites:
 *       - Zone must have provisioning config set via PUT /zones/:name
 *       - Provisioning artifact must be uploaded
 *       - Recipe must exist (if specified)
 *     tags: [Provisioning Pipeline]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               skip_boot:
 *                 type: boolean
 *                 default: false
 *               skip_recipe:
 *                 type: boolean
 *                 default: false
 *     responses:
 *       200:
 *         description: Provisioning pipeline started
 *       400:
 *         description: Invalid request or missing provisioning config
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to start provisioning
 */
export const provisionZone = async (req, res) => {
  try {
    const zoneName = req.params.name;
    const { skip_boot = false, skip_recipe = false } = req.body || {};

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, skip_recipe);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, recipeId, zoneIP, credentials } = validation;

    // Create Parent Task
    const parentTask = await Tasks.create({
      zone_name: zoneName,
      operation: 'zone_provision_orchestration',
      priority: TaskPriority.NORMAL,
      created_by: req.entity.name,
      status: 'running', // Start immediately as a container
      metadata: JSON.stringify({ provisioning, recipeId, zoneIP, credentials }),
    });

    // Build task chain
    const taskChain = await buildProvisioningTaskChain({
      zoneName,
      zone,
      skipBoot: skip_boot,
      skipRecipe: skip_recipe,
      recipeId,
      provisioning,
      zoneIP,
      credentials,
      artifactId: provisioning.artifact_id,
      parentTaskId: parentTask.id,
      createdBy: req.entity.name,
    });

    log.api.info('Provisioning pipeline started', {
      zone_name: zoneName,
      steps: taskChain.length,
      first_task: taskChain[0]?.task_id,
      last_task: taskChain[taskChain.length - 1]?.task_id,
    });

    return res.json({
      success: true,
      message: `Provisioning pipeline started for ${zoneName}`,
      zone_name: zoneName,
      parent_task_id: parentTask.id,
      steps: taskChain.length,
      task_chain: taskChain,
    });
  } catch (error) {
    log.api.error('Failed to start provisioning pipeline', { error: error.message });
    return res.status(500).json({
      error: 'Failed to start provisioning pipeline',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/{name}/provision/status:
 *   get:
 *     summary: Get provisioning pipeline status
 *     description: Returns the status of all provisioning-related tasks for a zone.
 *     tags: [Provisioning Pipeline]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Provisioning status
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to get status
 */
export const getProvisioningStatus = async (req, res) => {
  try {
    const zoneName = req.params.name;

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: `Zone '${zoneName}' not found` });
    }

    // Find all provisioning-related tasks for this zone
    const tasks = await Tasks.findAll({
      where: {
        zone_name: zoneName,
        operation: ['zone_setup', 'zone_wait_ssh', 'zone_sync', 'zone_provision'],
      },
      order: [['created_at', 'DESC']],
      limit: 20,
    });

    const provisioning = zone.configuration?.provisioning || {};

    return res.json({
      success: true,
      zone_name: zoneName,
      provisioning_configured: !!zone.configuration?.provisioning,
      provisioning_status: provisioning.status || 'not_started',
      last_provisioned_at: provisioning.last_provisioned_at,
      recent_tasks: tasks,
    });
  } catch (error) {
    log.api.error('Failed to get provisioning status', { error: error.message });
    return res.status(500).json({
      error: 'Failed to get provisioning status',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles:
 *   get:
 *     summary: List all provisioning profiles
 *     description: Returns all saved provisioning profiles.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of profiles
 *       500:
 *         description: Failed to list profiles
 */
export const listProvisioningProfiles = async (req, res) => {
  try {
    const profiles = await ProvisioningProfiles.findAll({
      order: [['name', 'ASC']],
    });

    return res.json({
      success: true,
      count: profiles.length,
      profiles,
    });
  } catch (error) {
    log.api.error('Failed to list provisioning profiles', { error: error.message });
    return res.status(500).json({
      error: 'Failed to list provisioning profiles',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles:
 *   post:
 *     summary: Create a provisioning profile
 *     description: Creates a reusable provisioning profile combining recipe, credentials, and provisioners.
 *     tags: [Provisioning Profiles]
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
 *               description:
 *                 type: string
 *               recipe_id:
 *                 type: string
 *               default_credentials:
 *                 type: object
 *               default_sync_folders:
 *                 type: array
 *               default_provisioners:
 *                 type: array
 *               default_variables:
 *                 type: object
 *     responses:
 *       201:
 *         description: Profile created
 *       400:
 *         description: Invalid profile data
 *       409:
 *         description: Profile already exists
 *       500:
 *         description: Failed to create profile
 */
export const createProvisioningProfile = async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const existing = await ProvisioningProfiles.findOne({ where: { name } });
    if (existing) {
      return res.status(409).json({ error: `Profile '${name}' already exists` });
    }

    const profile = await ProvisioningProfiles.create({
      name,
      description: req.body.description,
      recipe_id: req.body.recipe_id,
      default_credentials: req.body.default_credentials,
      default_sync_folders: req.body.default_sync_folders,
      default_provisioners: req.body.default_provisioners,
      default_variables: req.body.default_variables || {},
      created_by: req.body.created_by,
    });

    log.api.info('Provisioning profile created', { id: profile.id, name });
    return res.status(201).json({ success: true, profile });
  } catch (error) {
    log.api.error('Failed to create provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles/{id}:
 *   get:
 *     summary: Get profile details
 *     description: Returns a single provisioning profile by ID.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Profile details
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Failed to get profile
 */
export const getProvisioningProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const profile = await ProvisioningProfiles.findByPk(id);

    if (!profile) {
      return res.status(404).json({ error: `Profile '${id}' not found` });
    }

    return res.json({ success: true, profile });
  } catch (error) {
    log.api.error('Failed to get provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to get provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles/{id}:
 *   put:
 *     summary: Update a provisioning profile
 *     description: Updates an existing profile.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *     responses:
 *       200:
 *         description: Profile updated
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Failed to update profile
 */
export const updateProvisioningProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const profile = await ProvisioningProfiles.findByPk(id);

    if (!profile) {
      return res.status(404).json({ error: `Profile '${id}' not found` });
    }

    const allowedFields = [
      'name',
      'description',
      'recipe_id',
      'default_credentials',
      'default_sync_folders',
      'default_provisioners',
      'default_variables',
      'created_by',
    ];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    updates.updated_at = new Date();

    await profile.update(updates);

    log.api.info('Provisioning profile updated', { id, name: profile.name });
    return res.json({ success: true, profile });
  } catch (error) {
    log.api.error('Failed to update provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to update provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /provisioning/profiles/{id}:
 *   delete:
 *     summary: Delete a provisioning profile
 *     description: Permanently removes a profile.
 *     tags: [Provisioning Profiles]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Profile deleted
 *       404:
 *         description: Profile not found
 *       500:
 *         description: Failed to delete profile
 */
export const deleteProvisioningProfile = async (req, res) => {
  try {
    const { id } = req.params;
    const profile = await ProvisioningProfiles.findByPk(id);

    if (!profile) {
      return res.status(404).json({ error: `Profile '${id}' not found` });
    }

    const { name } = profile;
    await profile.destroy();

    log.api.info('Provisioning profile deleted', { id, name });
    return res.json({ success: true, message: `Profile '${name}' deleted` });
  } catch (error) {
    log.api.error('Failed to delete provisioning profile', { error: error.message });
    return res.status(500).json({
      error: 'Failed to delete provisioning profile',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/{name}/sync:
 *   post:
 *     summary: Sync zone files ad-hoc
 *     description: |
 *       Creates a zone_sync task to sync provisioning files to the zone.
 *       This is independent of the full provisioning pipeline and can be called
 *       anytime after SSH is accessible.
 *
 *       Prerequisites:
 *       - Zone must be running
 *       - Zone must have provisioning config with sync_folders
 *       - SSH must be accessible
 *     tags: [Provisioning Tasks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sync task created
 *       400:
 *         description: Invalid request or missing provisioning config
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to create sync task
 */
export const syncZone = async (req, res) => {
  try {
    const zoneName = req.params.name;

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, zoneIP, credentials } = validation;

    // Check if there are folders configured
    const folders = provisioning.folders || provisioning.sync_folders || [];
    if (folders.length === 0) {
      return res.status(400).json({
        error: 'No folders configured in provisioner metadata',
      });
    }

    // Create parent task for folder sync
    const syncParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_sync_parent',
      metadata: { total_folders: folders.length },
      depends_on: null,
      parent_task_id: null,
      created_by: req.entity.name,
    });

    // Create individual sync tasks sequentially (each depends on previous)
    await createSequentialFolderTasks(
      folders,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      syncParentTask.id,
      req.entity.name
    );

    log.api.info('Zone sync task chain created', {
      zone_name: zoneName,
      parent_task_id: syncParentTask.id,
      folder_count: folders.length,
    });

    return res.json({
      success: true,
      message: `Zone sync task chain created for ${zoneName}`,
      zone_name: zoneName,
      parent_task_id: syncParentTask.id,
      folder_count: folders.length,
    });
  } catch (error) {
    log.api.error('Failed to create zone sync task', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create zone sync task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /zones/{name}/run-provisioners:
 *   post:
 *     summary: Run zone provisioners ad-hoc
 *     description: |
 *       Creates a zone_provision task to execute provisioners (shell scripts, ansible, etc.)
 *       against the zone. This is independent of the full provisioning pipeline and can be
 *       called anytime after SSH is accessible.
 *
 *       Prerequisites:
 *       - Zone must be running
 *       - Zone must have provisioning config with provisioners
 *       - SSH must be accessible
 *     tags: [Provisioning Tasks]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Provisioning task created
 *       400:
 *         description: Invalid request or missing provisioning config
 *       404:
 *         description: Zone not found
 *       500:
 *         description: Failed to create provisioning task
 */
export const runProvisioners = async (req, res) => {
  try {
    const zoneName = req.params.name;

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, true);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, zoneIP, credentials } = validation;

    // Check if there are playbooks configured
    const playbooks =
      provisioning.provisioning?.ansible?.playbooks?.local || provisioning.provisioners || [];

    if (playbooks.length === 0) {
      return res.status(400).json({
        error: 'No playbooks configured in provisioner metadata',
      });
    }

    // Create parent task for provisioning
    const provisionParentTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provision_parent',
      metadata: { total_playbooks: playbooks.length },
      depends_on: null,
      parent_task_id: null,
      created_by: req.entity.name,
    });

    // Create individual provision tasks sequentially (each depends on previous)
    await createSequentialPlaybookTasks(
      playbooks,
      zoneName,
      zoneIP,
      credentials,
      provisioning,
      provisionParentTask.id,
      req.entity.name
    );

    log.api.info('Zone provision task chain created', {
      zone_name: zoneName,
      parent_task_id: provisionParentTask.id,
      playbook_count: playbooks.length,
    });

    return res.json({
      success: true,
      message: `Zone provisioners task chain created for ${zoneName}`,
      zone_name: zoneName,
      parent_task_id: provisionParentTask.id,
      playbook_count: playbooks.length,
    });
  } catch (error) {
    log.api.error('Failed to create zone provisioners task', { error: error.message });
    return res.status(500).json({
      error: 'Failed to create zone provisioners task',
      details: error.message,
    });
  }
};
