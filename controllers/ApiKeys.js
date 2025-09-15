import Entities from '../models/EntityModel.js';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';

// Generate a secure API key with wh_ prefix
const generateApiKeyString = () => {
  const apiKeyConfig = config.get('api_keys') || { key_length: 64 };
  const randomBytes = crypto.randomBytes(apiKeyConfig.key_length || 64);
  return `wh_${randomBytes.toString('base64url')}`;
};

/**
 * @swagger
 * /api-keys/bootstrap:
 *   post:
 *     summary: Generate initial bootstrap API key
 *     description: Creates the first API key for system setup. Auto-disables after first use unless configured otherwise.
 *     tags: [API Keys]
 *     security: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Name for the bootstrap API key
 *                 example: "Initial-Setup"
 *               description:
 *                 type: string
 *                 description: Description for the bootstrap API key
 *                 example: "Initial bootstrap API key"
 *     responses:
 *       200:
 *         description: Bootstrap API key generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/ApiKey'
 *                 - type: object
 *                   properties:
 *                     note:
 *                       type: string
 *                       description: Information about bootstrap auto-disable status
 *                       example: "Bootstrap endpoint will be auto-disabled for future requests"
 *       403:
 *         description: Bootstrap endpoint disabled or already used
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Bootstrap failed
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const bootstrapFirstApiKey = async (req, res) => {
  try {
    const apiKeyConfig = config.get('api_keys') || {};

    // Check if bootstrap is enabled in config
    if (!apiKeyConfig.bootstrap_enabled) {
      return res.status(403).json({ msg: 'Bootstrap endpoint is disabled' });
    }

    // Check if any entities already exist
    const entityCount = await Entities.count();
    if (entityCount > 0 && apiKeyConfig.bootstrap_auto_disable !== false) {
      return res.status(403).json({ msg: 'Bootstrap endpoint auto-disabled after first use' });
    }

    // Generate bootstrap API key
    const apiKey = generateApiKeyString();
    const hashRounds = apiKeyConfig.hash_rounds || 12;
    const hashedKey = await bcrypt.hash(apiKey, hashRounds);

    await Entities.create({
      name: req.body.name || 'Bootstrap-Key',
      api_key_hash: hashedKey,
      description: req.body.description || 'Initial bootstrap API key',
      is_active: true,
      created_at: new Date(),
      last_used: new Date(),
    });

    res.json({
      api_key: apiKey,
      message: 'Bootstrap API key generated successfully',
      note:
        apiKeyConfig.bootstrap_auto_disable !== false
          ? 'Bootstrap endpoint will be auto-disabled for future requests'
          : 'Bootstrap endpoint remains enabled per configuration',
    });
  } catch (error) {
    log.auth.error('Bootstrap API key generation failed', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ msg: 'Bootstrap failed' });
  }
};

/**
 * @swagger
 * /api-keys/generate:
 *   post:
 *     summary: Generate new API key
 *     description: Creates a new API key for accessing the Zoneweaver API. Requires existing valid API key.
 *     tags: [API Keys]
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
 *                 description: Name for the new API key
 *                 example: "Zoneweaver-Production"
 *               description:
 *                 type: string
 *                 description: Optional description for the API key
 *                 example: "API key for Zoneweaverfrontend"
 *     responses:
 *       200:
 *         description: API key generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ApiKey'
 *       400:
 *         description: Name is required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: API key required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to generate API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const generateApiKey = async (req, res) => {
  try {
    const { name, description } = req.body;

    if (!name) {
      return res.status(400).json({ msg: 'Name is required' });
    }

    // Generate new API key
    const apiKey = generateApiKeyString();
    const apiKeyConfig = config.get('api_keys') || {};
    const hashRounds = apiKeyConfig.hash_rounds || 12;
    const hashedKey = await bcrypt.hash(apiKey, hashRounds);

    const entity = await Entities.create({
      name,
      api_key_hash: hashedKey,
      description: description || null,
      is_active: true,
      created_at: new Date(),
      last_used: new Date(),
    });

    res.json({
      api_key: apiKey,
      entity_id: entity.id,
      name: entity.name,
      description: entity.description,
      message: 'API key generated successfully',
    });
  } catch (error) {
    log.auth.error('Failed to generate API key', {
      error: error.message,
      stack: error.stack,
      name,
    });
    res.status(500).json({ msg: 'Failed to generate API key' });
  }
};

/**
 * @swagger
 * /api-keys:
 *   get:
 *     summary: List all API keys
 *     description: Retrieves a list of all API keys (entities) with their metadata. Does not include the actual API key values.
 *     tags: [API Keys]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: List of API keys retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entities:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Entity'
 *                 total:
 *                   type: integer
 *                   description: Total number of entities
 *                   example: 2
 *       401:
 *         description: API key required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to list API keys
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const listApiKeys = async (req, res) => {
  try {
    const entities = await Entities.findAll({
      attributes: ['id', 'name', 'description', 'is_active', 'created_at', 'last_used'],
      order: [['created_at', 'DESC']],
    });

    res.json({
      entities,
      total: entities.length,
    });
  } catch (error) {
    log.auth.error('Failed to list API keys', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ msg: 'Failed to list API keys' });
  }
};

/**
 * @swagger
 * /api-keys/{id}:
 *   delete:
 *     summary: Delete API key
 *     description: Permanently deletes an API key from the database. This action cannot be undone.
 *     tags: [API Keys]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Entity ID of the API key to delete
 *         schema:
 *           type: integer
 *           example: 1
 *     responses:
 *       200:
 *         description: API key deleted successfully
 *       404:
 *         description: API key not found
 *       500:
 *         description: Failed to delete API key
 */
export const deleteApiKey = async (req, res) => {
  try {
    const entityId = req.params.id;

    const entity = await Entities.findByPk(entityId);
    if (!entity) {
      return res.status(404).json({ msg: 'API key not found' });
    }

    await entity.destroy();

    res.json({
      message: 'API key deleted successfully',
      entity_id: entityId,
      name: entity.name,
    });
  } catch (error) {
    log.auth.error('Failed to delete API key', {
      error: error.message,
      stack: error.stack,
      entity_id: entityId,
    });
    res.status(500).json({ msg: 'Failed to delete API key' });
  }
};

/**
 * @swagger
 * /api-keys/{id}/revoke:
 *   put:
 *     summary: Revoke API key
 *     description: Deactivates an API key by setting is_active to false. The key can be re-enabled later.
 *     tags: [API Keys]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         description: Entity ID of the API key to revoke
 *         schema:
 *           type: integer
 *           example: 1
 *     responses:
 *       200:
 *         description: API key revoked successfully
 *       404:
 *         description: API key not found
 *       500:
 *         description: Failed to revoke API key
 */
export const revokeApiKey = async (req, res) => {
  try {
    const entityId = req.params.id;

    const entity = await Entities.findByPk(entityId);
    if (!entity) {
      return res.status(404).json({ msg: 'API key not found' });
    }

    await entity.update({ is_active: false });

    res.json({
      message: 'API key revoked successfully',
      entity_id: entityId,
      name: entity.name,
    });
  } catch (error) {
    log.auth.error('Failed to revoke API key', {
      error: error.message,
      stack: error.stack,
      entity_id: entityId,
    });
    res.status(500).json({ msg: 'Failed to revoke API key' });
  }
};

/**
 * @swagger
 * /api-keys/info:
 *   get:
 *     summary: Get current API key information
 *     description: Returns information about the API key currently being used to make the request.
 *     tags: [API Keys]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: API key information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Entity'
 *       401:
 *         description: API key required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Invalid API key
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Entity not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Failed to get API key info
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
export const getApiKeyInfo = async (req, res) => {
  try {
    // Return info about the current API key being used
    const entity = await Entities.findByPk(req.entity.id, {
      attributes: ['id', 'name', 'description', 'created_at', 'last_used'],
    });

    if (!entity) {
      return res.status(404).json({ msg: 'Entity not found' });
    }

    res.json(entity);
  } catch (error) {
    log.auth.error('Failed to get API key info', {
      error: error.message,
      stack: error.stack,
      entity_id: req.entity?.id,
    });
    res.status(500).json({ msg: 'Failed to get API key info' });
  }
};
