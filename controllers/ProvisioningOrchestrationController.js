/**
 * @fileoverview Provisioning Orchestration Controller for Zoneweaver API
 * @description High-level provisioning pipeline orchestration endpoints.
 *              Kicks off multi-step provisioning: extract artifact → boot → setup → wait SSH → sync → provision.
 */

import Zones from '../models/ZoneModel.js';
import Tasks from '../models/TaskModel.js';
import ProvisioningProfiles from '../models/ProvisioningProfileModel.js';
import Recipes from '../models/RecipeModel.js';
import { log } from '../lib/Logger.js';
import { validateZoneName } from '../lib/ZoneValidation.js';

/**
 * Validate provisioning request and zone state
 * @param {string} zoneName - Zone name
 * @param {Object} zone - Zone database record
 * @param {boolean} skipRecipe - Whether to skip recipe
 * @returns {Promise<{valid: boolean, error?: string, provisioning?: Object, recipeId?: string}>}
 */
const validateProvisioningRequest = async (zoneName, zone, skipRecipe) => {
  if (!validateZoneName(zoneName)) {
    return { valid: false, error: 'Invalid zone name' };
  }

  if (!zone) {
    return { valid: false, error: `Zone '${zoneName}' not found` };
  }

  const provisioning = zone.configuration?.provisioning;
  if (!provisioning) {
    return {
      valid: false,
      error:
        'No provisioning configuration found. Set provisioning config via PUT /zones/:name first.',
    };
  }

  const { recipe_id, credentials } = provisioning;

  if (!credentials || !credentials.username) {
    return { valid: false, error: 'Provisioning credentials are required (at minimum: username)' };
  }

  if (recipe_id && !skipRecipe) {
    const recipe = await Recipes.findByPk(recipe_id);
    if (!recipe) {
      return { valid: false, error: `Recipe '${recipe_id}' not found` };
    }
  }

  const zoneIP = provisioning.ip || provisioning.variables?.ip;
  if (!zoneIP) {
    return { valid: false, error: 'Zone IP address not configured in provisioning metadata' };
  }

  return { valid: true, provisioning, recipeId: recipe_id, zoneIP };
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
  });

/**
 * Build provisioning task chain
 * @param {Object} params - Parameters
 * @returns {Promise<Array>} Task chain
 */
const buildProvisioningTaskChain = async params => {
  const { zoneName, zone, skipBoot, skipRecipe, recipeId, provisioning, zoneIP, artifactId } =
    params;

  const taskChain = [];
  let previousTaskId = null;
  let provisioningDatasetPath = null;

  // Step 0: Extract artifact (if provided)
  if (artifactId) {
    const zoneConfig = zone.configuration || {};
    const zoneDataset = zoneConfig.zonepath
      ? zoneConfig.zonepath.replace('/path', '')
      : `/rpool/zones/${zoneName}`;
    const provisioningDataset = `${zoneDataset}/provisioning`;
    provisioningDatasetPath = `/${provisioningDataset}`;

    const extractTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provisioning_extract',
      metadata: {
        artifact_id: artifactId,
        dataset_path: provisioningDatasetPath,
      },
      depends_on: null,
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
    });
    taskChain.push({ step: 'boot', task_id: bootTask.id });
    previousTaskId = bootTask.id;
  }

  // Step 2: Run zlogin recipe
  if (recipeId && !skipRecipe) {
    const setupTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_setup',
      metadata: {
        recipe_id: recipeId,
        variables: provisioning.variables || {},
      },
      depends_on: previousTaskId,
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
      credentials: provisioning.credentials,
    },
    depends_on: previousTaskId,
  });
  taskChain.push({ step: 'wait_ssh', task_id: sshTask.id });
  previousTaskId = sshTask.id;

  // Step 4: Sync files
  const effectiveSyncFolders = [...(provisioning.sync_folders || [])];
  if (provisioningDatasetPath) {
    effectiveSyncFolders.push({
      source: provisioningDatasetPath,
      dest: '/vagrant',
      exclude: [],
    });
  }

  if (effectiveSyncFolders.length > 0) {
    const syncTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_sync',
      metadata: {
        ip: zoneIP,
        port: provisioning.ssh_port || 22,
        credentials: provisioning.credentials,
        sync_folders: effectiveSyncFolders,
      },
      depends_on: previousTaskId,
    });
    taskChain.push({ step: 'sync', task_id: syncTask.id });
    previousTaskId = syncTask.id;
  }

  // Step 5: Execute provisioners
  if (provisioning.provisioners && provisioning.provisioners.length > 0) {
    const provisionTask = await createTask({
      zone_name: zoneName,
      operation: 'zone_provision',
      metadata: {
        ip: zoneIP,
        port: provisioning.ssh_port || 22,
        credentials: provisioning.credentials,
        provisioners: provisioning.provisioners,
      },
      depends_on: previousTaskId,
    });
    taskChain.push({ step: 'provision', task_id: provisionTask.id });
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
    const { skip_boot = false, skip_recipe = false } = req.body;

    // Validate request
    const zone = await Zones.findOne({ where: { name: zoneName } });
    const validation = await validateProvisioningRequest(zoneName, zone, skip_recipe);
    if (!validation.valid) {
      return res
        .status(validation.error.includes('not found') ? 404 : 400)
        .json({ error: validation.error });
    }

    const { provisioning, recipeId, zoneIP } = validation;

    // Build task chain
    const taskChain = await buildProvisioningTaskChain({
      zoneName,
      zone,
      skipBoot: skip_boot,
      skipRecipe: skip_recipe,
      recipeId,
      provisioning,
      zoneIP,
      artifactId: provisioning.artifact_id,
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
