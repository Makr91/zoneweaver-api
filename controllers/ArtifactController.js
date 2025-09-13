/**
 * @fileoverview Artifact Controller for Zoneweaver API
 * @description Handles artifact storage management, file operations, and inventory tracking
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import yaml from 'js-yaml';
import multer from 'multer';
import config from '../config/ConfigLoader.js';
import ArtifactStorageLocation from '../models/ArtifactStorageLocationModel.js';
import Artifact from '../models/ArtifactModel.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import { getArtifactStorageService } from './ArtifactStorageService.js';
import { log, createTimer, createRequestLogger } from '../lib/Logger.js';
import { validatePath, getMimeType, executeCommand } from '../lib/FileSystemManager.js';
import { Op } from 'sequelize';
import yj from 'yieldable-json';

/**
 * Update config.yaml with new storage path
 * THIS SHOULD BE MOVED TO THE CONFIGLOADER FUNCTIONS
 * @param {Object} pathConfig - New path configuration
 * @returns {Promise<void>}
 */
const updateConfigWithNewPath = async (pathConfig) => {
  const configPath = process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');
  
  // Read current config
  const fileContents = await fs.promises.readFile(configPath, 'utf8');
  const fullConfig = yaml.load(fileContents);
  const currentConfig = fullConfig.zoneweaver_api_backend || fullConfig;
  
  // Ensure artifact_storage.paths array exists
  if (!currentConfig.artifact_storage) {
    currentConfig.artifact_storage = {};
  }
  if (!currentConfig.artifact_storage.paths) {
    currentConfig.artifact_storage.paths = [];
  }
  
  // Add new path to config
  currentConfig.artifact_storage.paths.push({
    name: pathConfig.name,
    path: pathConfig.path,
    type: pathConfig.type,
    enabled: pathConfig.enabled,
  });
  
  // Write updated config to temp file first
  const tempConfigPath = `${configPath}.tmp`;
  const updatedYaml = yaml.dump(fullConfig.zoneweaver_api_backend ? fullConfig : currentConfig);
  await fs.promises.writeFile(tempConfigPath, updatedYaml, 'utf8');
  
  // Atomically replace the old config
  await fs.promises.rename(tempConfigPath, configPath);
  
  // Reload configuration
  config.load();
  
  log.artifact.info('Config file updated with new storage path', {
    config_path: configPath,
    path_name: pathConfig.name,
    path_location: pathConfig.path,
  });
};

/**
 * @swagger
 * tags:
 *   name: Artifact Storage
 *   description: Artifact storage management and file operations for ISO and VM image files
 */

/**
 * @swagger
 * /artifacts/storage/paths:
 *   get:
 *     summary: List storage paths
 *     description: Retrieves all configured artifact storage paths with statistics
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [iso, image]
 *         description: Filter by storage type
 *       - in: query
 *         name: enabled
 *         schema:
 *           type: boolean
 *         description: Filter by enabled status
 *     responses:
 *       200:
 *         description: Storage paths retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 paths:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ArtifactStorageLocation'
 *                 total_paths:
 *                   type: integer
 *       500:
 *         description: Failed to retrieve storage paths
 */
export const listStoragePaths = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { type, enabled } = req.query;
    const whereClause = {};

    if (type) {
      whereClause.type = type;
    }
    if (enabled !== undefined) {
      whereClause.enabled = enabled === 'true';
    }

    const paths = await ArtifactStorageLocation.findAll({
      where: whereClause,
      order: [['type', 'ASC'], ['name', 'ASC']],
    });

    // Add disk usage information for each path
    const pathsWithStats = [];
    for (const storagePath of paths) {
      let diskUsage = null;
      try {
        if (fs.existsSync(storagePath.path)) {
          const dfResult = await executeCommand(`df -h "${storagePath.path}"`);
          if (dfResult.success) {
            const lines = dfResult.output.split('\n');
            if (lines.length > 1) {
              const parts = lines[1].split(/\s+/);
              if (parts.length >= 6) {
                diskUsage = {
                  filesystem: parts[0],
                  total: parts[1],
                  used: parts[2],
                  available: parts[3],
                  use_percent: parts[4],
                  mount_point: parts[5],
                };
              }
            }
          }
        }
      } catch (error) {
        log.artifact.warn('Failed to get disk usage', {
          path: storagePath.path,
          error: error.message,
        });
      }

      pathsWithStats.push({
        ...storagePath.toJSON(),
        disk_usage: diskUsage,
      });
    }

    res.json({
      paths: pathsWithStats,
      total_paths: pathsWithStats.length,
    });
  } catch (error) {
    log.api.error('Error listing storage paths', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to retrieve storage paths',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/storage/paths:
 *   post:
 *     summary: Add storage path
 *     description: Creates a new artifact storage path and updates configuration
 *     tags: [Artifact Storage]
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
 *               - path
 *               - type
 *             properties:
 *               name:
 *                 type: string
 *                 description: Display name for storage location
 *                 example: "Primary ISO Storage"
 *               path:
 *                 type: string
 *                 description: Filesystem path for storage
 *                 example: "/data/isos"
 *               type:
 *                 type: string
 *                 enum: [iso, image]
 *                 description: Type of artifacts to store
 *                 example: "iso"
 *               enabled:
 *                 type: boolean
 *                 description: Whether storage location should be enabled
 *                 default: true
 *     responses:
 *       201:
 *         description: Storage path created successfully
 *       400:
 *         description: Invalid request parameters
 *       409:
 *         description: Path already exists
 *       500:
 *         description: Failed to create storage path
 */
export const createStoragePath = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { name, path: storagePath, type, enabled = true } = req.body;

    if (!name || !storagePath || !type) {
      return res.status(400).json({
        error: 'name, path, and type are required',
      });
    }

    if (!['iso', 'image'].includes(type)) {
      return res.status(400).json({
        error: 'type must be either "iso" or "image"',
      });
    }

    // Validate the storage path
    const validation = validatePath(storagePath);
    if (!validation.valid) {
      return res.status(400).json({
        error: `Invalid storage path: ${validation.error}`,
      });
    }

    const normalizedPath = validation.normalizedPath;

    // Check if path already exists
    const existingPath = await ArtifactStorageLocation.findOne({
      where: { path: normalizedPath },
    });

    if (existingPath) {
      return res.status(409).json({
        error: `Storage path already exists: ${normalizedPath}`,
        existing_location: {
          id: existingPath.id,
          name: existingPath.name,
          type: existingPath.type,
        },
      });
    }

    // Create directory if it doesn't exist
    try {
      await fs.promises.access(normalizedPath);
    } catch (error) {
      try {
        log.artifact.info('Creating storage directory with pfexec', {
          path: normalizedPath,
          name,
        });

        const mkdirResult = await executeCommand(`pfexec mkdir -p "${normalizedPath}"`);

        if (!mkdirResult.success) {
          throw new Error(`mkdir failed: ${mkdirResult.error}`);
        }

        log.artifact.info('Storage directory created successfully', {
          path: normalizedPath,
          name,
        });
      } catch (mkdirError) {
        return res.status(400).json({
          error: `Cannot create storage directory: ${mkdirError.message}`,
        });
      }
    }

    // Create storage location record
    const configHash = crypto.createHash('md5')
      .update(JSON.stringify({ name, path: normalizedPath, type, enabled }))
      .digest('hex');

    const storageLocation = await ArtifactStorageLocation.create({
      name,
      path: normalizedPath,
      type,
      enabled,
      config_hash: configHash,
      file_count: 0,
      total_size: 0,
    });

    // Update config.yaml with new path
    try {
      await updateConfigWithNewPath({ name, path: normalizedPath, type, enabled });
      log.artifact.info('Storage path added to config.yaml successfully', {
        id: storageLocation.id,
        name,
        path: normalizedPath,
        type,
        enabled,
      });
    } catch (configError) {
      log.artifact.warn('Failed to update config.yaml - path only exists in database', {
        id: storageLocation.id,
        error: configError.message,
      });
    }

    log.artifact.info('Storage path created successfully', {
      id: storageLocation.id,
      name,
      path: normalizedPath,
      type,
      enabled,
    });

    // Trigger initial scan
    if (enabled) {
      try {
        const scanTask = await Tasks.create({
          zone_name: 'artifact',
          operation: 'artifact_scan_location',
          priority: TaskPriority.BACKGROUND,
          created_by: req.entity.name,
          status: 'pending',
          metadata: await new Promise((resolve, reject) => {
            yj.stringifyAsync(
              {
                storage_location_id: storageLocation.id,
                verify_checksums: false,
                remove_orphaned: false,
              },
              (err, result) => {
                if (err) reject(err);
                else resolve(result);
              }
            );
          }),
        });

        log.artifact.info('Initial scan task created for new storage location', {
          task_id: scanTask.id,
          storage_location_id: storageLocation.id,
        });
      } catch (taskError) {
        log.artifact.warn('Failed to create initial scan task', {
          error: taskError.message,
          storage_location_id: storageLocation.id,
        });
      }
    }

    res.status(201).json({
      success: true,
      message: `Storage path '${name}' created successfully`,
      storage_location: storageLocation,
    });
  } catch (error) {
    log.api.error('Error creating storage path', {
      error: error.message,
      stack: error.stack,
      name,
      path: storagePath,
      type,
    });

    if (error.name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({
        error: 'Storage path already exists',
        details: error.message,
      });
    }

    res.status(500).json({
      error: 'Failed to create storage path',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/storage/paths/{id}:
 *   put:
 *     summary: Update storage path
 *     description: Updates an existing storage path configuration
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Storage location ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Updated display name
 *               enabled:
 *                 type: boolean
 *                 description: Whether to enable/disable this location
 *     responses:
 *       200:
 *         description: Storage path updated successfully
 *       404:
 *         description: Storage path not found
 *       500:
 *         description: Failed to update storage path
 */
export const updateStoragePath = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { id } = req.params;
    const { name, enabled } = req.body;

    const storageLocation = await ArtifactStorageLocation.findByPk(id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage path not found',
      });
    }

    const updateData = {};
    if (name !== undefined) {
      updateData.name = name;
    }
    if (enabled !== undefined) {
      updateData.enabled = enabled;
    }

    await storageLocation.update(updateData);

    // TODO: Update config.yaml with changes
    log.artifact.info('Storage path updated successfully', {
      id,
      name: storageLocation.name,
      enabled: storageLocation.enabled,
      updated_fields: Object.keys(updateData),
    });

    res.json({
      success: true,
      message: `Storage path '${storageLocation.name}' updated successfully`,
      storage_location: storageLocation,
    });
  } catch (error) {
    log.api.error('Error updating storage path', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });
    res.status(500).json({
      error: 'Failed to update storage path',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/storage/paths/{id}:
 *   delete:
 *     summary: Delete storage path
 *     description: Creates a task to delete storage path and optionally its contents
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Storage location ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recursive:
 *                 type: boolean
 *                 description: Delete folder contents recursively
 *                 default: true
 *               remove_db_records:
 *                 type: boolean
 *                 description: Remove artifact database records
 *                 default: true
 *               force:
 *                 type: boolean
 *                 description: Force deletion even if errors occur
 *                 default: false
 *     responses:
 *       202:
 *         description: Deletion task created successfully
 *       404:
 *         description: Storage path not found
 *       500:
 *         description: Failed to create deletion task
 */
export const deleteStoragePath = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { id } = req.params;
    const { recursive = true, remove_db_records = true, force = false } = req.body;

    const storageLocation = await ArtifactStorageLocation.findByPk(id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage path not found',
      });
    }

    // Create deletion task
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_delete_folder',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            storage_location_id: id,
            recursive,
            remove_db_records,
            force,
          },
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      }),
    });

    log.artifact.info('Storage path deletion task created', {
      task_id: task.id,
      storage_location_id: id,
      name: storageLocation.name,
      path: storageLocation.path,
      recursive,
      remove_db_records,
    });

    res.status(202).json({
      success: true,
      message: `Deletion task created for storage path '${storageLocation.name}'`,
      task_id: task.id,
      location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
        file_count: storageLocation.file_count,
      },
    });
  } catch (error) {
    log.api.error('Error creating storage path deletion task', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });
    res.status(500).json({
      error: 'Failed to create deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts:
 *   get:
 *     summary: List artifacts
 *     description: Retrieves artifacts with optional filtering and pagination
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [iso, image]
 *         description: Filter by artifact type
 *       - in: query
 *         name: storage_path_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by storage location
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in filenames
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [filename, size, discovered_at]
 *           default: filename
 *         description: Sort criteria
 *       - in: query
 *         name: sort_order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: asc
 *         description: Sort order
 *     responses:
 *       200:
 *         description: Artifacts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 artifacts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Artifact'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                     limit:
 *                       type: integer
 *                     offset:
 *                       type: integer
 *                     has_more:
 *                       type: boolean
 *       500:
 *         description: Failed to retrieve artifacts
 */
export const listArtifacts = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      type,
      storage_path_id,
      search,
      limit = 50,
      offset = 0,
      sort_by = 'filename',
      sort_order = 'asc',
    } = req.query;

    const whereClause = {};

    if (type) {
      whereClause.file_type = type;
    }
    if (storage_path_id) {
      whereClause.storage_location_id = storage_path_id;
    }
    if (search) {
      whereClause.filename = { [Op.like]: `%${search}%` };
    }

    // Build order clause
    const orderField = ['filename', 'size', 'discovered_at'].includes(sort_by) ? sort_by : 'filename';
    const orderDirection = sort_order.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

    const artifacts = await Artifact.findAll({
      where: whereClause,
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
          attributes: ['id', 'name', 'path', 'type'],
        },
      ],
      order: [[orderField, orderDirection]],
      limit: parseInt(limit),
      offset: parseInt(offset),
    });

    const total = await Artifact.count({ where: whereClause });

    res.json({
      artifacts,
      pagination: {
        total,
        limit: parseInt(limit),
        offset: parseInt(offset),
        has_more: parseInt(offset) + parseInt(limit) < total,
      },
    });
  } catch (error) {
    log.api.error('Error listing artifacts', {
      error: error.message,
      stack: error.stack,
      query_params: req.query,
    });
    res.status(500).json({
      error: 'Failed to retrieve artifacts',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/iso:
 *   get:
 *     summary: List ISO artifacts
 *     description: Convenience endpoint to list only ISO artifacts
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: storage_path_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by storage location
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in filenames
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: ISO artifacts retrieved successfully
 *       500:
 *         description: Failed to retrieve artifacts
 */
export const listISOArtifacts = async (req, res) => {
  req.query.type = 'iso';
  return await listArtifacts(req, res);
};

/**
 * @swagger
 * /artifacts/image:
 *   get:
 *     summary: List image artifacts
 *     description: Convenience endpoint to list only image artifacts
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: storage_path_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by storage location
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search in filenames
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of results
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: Image artifacts retrieved successfully
 *       500:
 *         description: Failed to retrieve artifacts
 */
export const listImageArtifacts = async (req, res) => {
  req.query.type = 'image';
  return await listArtifacts(req, res);
};

/**
 * @swagger
 * /artifacts/{id}:
 *   get:
 *     summary: Get artifact details
 *     description: Retrieves detailed information about a specific artifact
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Artifact ID
 *     responses:
 *       200:
 *         description: Artifact details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Artifact'
 *       404:
 *         description: Artifact not found
 *       500:
 *         description: Failed to retrieve artifact details
 */
export const getArtifactDetails = async (req, res) => {
  try {
    const { id } = req.params;

    const artifact = await Artifact.findByPk(id, {
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
          attributes: ['id', 'name', 'path', 'type'],
        },
      ],
    });

    if (!artifact) {
      return res.status(404).json({
        error: 'Artifact not found',
      });
    }

    res.json(artifact);
  } catch (error) {
    log.api.error('Error getting artifact details', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });
    res.status(500).json({
      error: 'Failed to retrieve artifact details',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/download:
 *   post:
 *     summary: Download artifact from URL
 *     description: Creates a task to download an artifact from a URL to specified storage location
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - url
 *               - storage_path_id
 *             properties:
 *               url:
 *                 type: string
 *                 format: uri
 *                 description: URL to download from
 *                 example: "https://releases.ubuntu.com/22.04/ubuntu-22.04-server-amd64.iso"
 *               storage_path_id:
 *                 type: string
 *                 format: uuid
 *                 description: Target storage location ID
 *               filename:
 *                 type: string
 *                 description: Override filename (optional)
 *                 example: "ubuntu-22.04-server.iso"
 *               expected_checksum:
 *                 type: string
 *                 description: Expected checksum for verification
 *                 example: "abc123def456..."
 *               checksum_algorithm:
 *                 type: string
 *                 enum: [md5, sha1, sha256]
 *                 default: sha256
 *                 description: Checksum algorithm
 *               overwrite_existing:
 *                 type: boolean
 *                 default: false
 *                 description: Whether to overwrite existing files
 *     responses:
 *       202:
 *         description: Download task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Storage location not found
 *       500:
 *         description: Failed to create download task
 */
export const downloadFromUrl = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      url,
      storage_path_id,
      filename,
      expected_checksum,
      checksum_algorithm = 'sha256',
      overwrite_existing = false,
    } = req.body;

    if (!url || !storage_path_id) {
      return res.status(400).json({
        error: 'url and storage_path_id are required',
      });
    }

    // Validate URL
    try {
      new URL(url);
    } catch (urlError) {
      return res.status(400).json({
        error: 'Invalid URL format',
      });
    }

    // Validate checksum algorithm
    if (!['md5', 'sha1', 'sha256'].includes(checksum_algorithm)) {
      return res.status(400).json({
        error: 'checksum_algorithm must be md5, sha1, or sha256',
      });
    }

    // Verify storage location exists and is enabled
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_path_id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage location not found',
      });
    }

    if (!storageLocation.enabled) {
      return res.status(400).json({
        error: 'Storage location is disabled',
      });
    }

    // Create download task
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_download_url',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            url,
            storage_location_id: storage_path_id,
            filename,
            expected_checksum,
            checksum_algorithm,
            overwrite_existing,
          },
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      }),
    });

    // Determine filename for response
    const displayFilename = filename || path.basename(new URL(url).pathname) || 'download';

    log.artifact.info('Download task created', {
      task_id: task.id,
      url,
      storage_location: storageLocation.name,
      filename: displayFilename,
      has_checksum: !!expected_checksum,
    });

    res.status(202).json({
      success: true,
      message: `Download task created for '${displayFilename}'`,
      task_id: task.id,
      url,
      storage_location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
      },
      filename: displayFilename,
    });
  } catch (error) {
    log.api.error('Error creating download task', {
      error: error.message,
      stack: error.stack,
      url,
      storage_path_id,
    });
    res.status(500).json({
      error: 'Failed to create download task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/upload/prepare:
 *   post:
 *     summary: Prepare artifact upload
 *     description: Creates an upload task and returns upload URL for efficient large file handling
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - filename
 *               - size
 *               - storage_path_id
 *             properties:
 *               filename:
 *                 type: string
 *                 description: Original filename
 *                 example: "ubuntu-22.04-server-amd64.iso"
 *               size:
 *                 type: integer
 *                 format: int64
 *                 description: File size in bytes
 *                 example: 4294967296
 *               storage_path_id:
 *                 type: string
 *                 format: uuid
 *                 description: Target storage location ID
 *               expected_checksum:
 *                 type: string
 *                 description: Expected checksum for verification
 *               checksum_algorithm:
 *                 type: string
 *                 enum: [md5, sha1, sha256]
 *                 default: sha256
 *                 description: Checksum algorithm
 *               overwrite_existing:
 *                 type: boolean
 *                 default: false
 *                 description: Whether to overwrite existing files
 *     responses:
 *       200:
 *         description: Upload prepared successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 upload_url:
 *                   type: string
 *                 expires_at:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: Invalid request
 *       404:
 *         description: Storage location not found
 */
export const prepareArtifactUpload = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      filename,
      size,
      storage_path_id,
      expected_checksum,
      checksum_algorithm = 'sha256',
      overwrite_existing = false,
    } = req.body;

    if (!filename || !size || !storage_path_id) {
      return res.status(400).json({
        error: 'filename, size, and storage_path_id are required',
      });
    }

    // Check file size limit
    const maxUploadSize = (artifactConfig.security?.max_upload_size_gb || 50) * 1024 * 1024 * 1024;
    if (size > maxUploadSize) {
      return res.status(400).json({
        error: `File size ${Math.round(size / 1024 / 1024)}MB exceeds maximum upload size of ${artifactConfig.security?.max_upload_size_gb || 50}GB`,
      });
    }

    // Verify storage location exists and is enabled
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_path_id);
    if (!storageLocation) {
      return res.status(404).json({
        error: 'Storage location not found',
      });
    }

    if (!storageLocation.enabled) {
      return res.status(400).json({
        error: 'Storage location is disabled',
      });
    }

    // Create upload processing task (prepared status prevents TaskQueue from processing before upload)
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_upload_process',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'prepared',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            original_name: filename,
            size: parseInt(size),
            storage_location_id: storage_path_id,
            expected_checksum,
            checksum_algorithm,
            overwrite_existing,
            upload_prepared: true,
          },
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      }),
    });

    // Generate upload URL and expiration
    const uploadUrl = `/artifacts/upload/${task.id}`;
    const sessionTimeoutHours = artifactConfig.security?.upload_session_timeout_hours || 2;
    const expiresAt = new Date(Date.now() + sessionTimeoutHours * 60 * 60 * 1000);

    log.artifact.info('Upload prepared successfully', {
      task_id: task.id,
      filename,
      size_mb: Math.round(size / 1024 / 1024),
      storage_location: storageLocation.name,
      expires_at: expiresAt,
    });

    res.json({
      success: true,
      task_id: task.id,
      upload_url: uploadUrl,
      expires_at: expiresAt.toISOString(),
      storage_location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
      },
    });
  } catch (error) {
    log.api.error('Error preparing upload', {
      error: error.message,
      stack: error.stack,
      filename,
      size,
      storage_path_id,
    });
    res.status(500).json({
      error: 'Failed to prepare upload',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/upload/{taskId}:
 *   post:
 *     summary: Upload artifact file to prepared task
 *     description: Upload file directly to final storage location using prepared task
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Upload task ID from prepare endpoint
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Artifact file to upload
 *     responses:
 *       202:
 *         description: File uploaded successfully, processing started
 *       400:
 *         description: Invalid upload or task
 *       404:
 *         description: Task not found
 *       413:
 *         description: File too large
 *       500:
 *         description: Upload failed
 */
/**
 * @swagger
 * /artifacts/upload/{taskId}:
 *   post:
 *     summary: Upload artifact file to prepared task
 *     description: Upload file directly to final storage location using prepared task
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: taskId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Upload task ID from prepare endpoint
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Artifact file to upload
 *     responses:
 *       202:
 *         description: File uploaded successfully, processing started
 *       400:
 *         description: Invalid upload or task
 *       404:
 *         description: Task not found
 *       413:
 *         description: File too large
 *       500:
 *         description: Upload failed
 */
export const uploadArtifactToTask = async (req, res) => {
  const requestId = `artifact-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timer = createTimer('artifact_upload');
  const requestLogger = createRequestLogger(requestId, req);

  try {
    const artifactConfig = config.getArtifactStorage();

    // LOG: Configuration debugging
    log.artifact.info('UPLOAD DEBUG: Configuration loaded', {
      requestId,
      artifactConfig_enabled: artifactConfig?.enabled,
      artifactConfig_security: artifactConfig?.security,
      max_upload_size_gb: artifactConfig?.security?.max_upload_size_gb,
      calculated_max_size: (artifactConfig?.security?.max_upload_size_gb || 50) * 1024 * 1024 * 1024,
      config_paths: artifactConfig?.paths?.length || 0,
    });

    if (!artifactConfig?.enabled) {
      requestLogger.error(503, 'Artifact storage disabled');
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { taskId } = req.params;
    if (!taskId) {
      requestLogger.error(400, 'Task ID required');
      return res.status(400).json({
        error: 'taskId parameter is required',
      });
    }

    // LOG: Request details
    log.artifact.info('UPLOAD DEBUG: Request details', {
      requestId,
      taskId,
      method: req.method,
      headers: {
        'content-type': req.get('Content-Type'),
        'content-length': req.get('Content-Length'),
        'user-agent': req.get('User-Agent'),
      },
      ip: req.ip,
      query: req.query,
      params: req.params,
    });

    // Get the existing task created by prepareArtifactUpload
    const task = await Tasks.findByPk(taskId);
    if (!task) {
      requestLogger.error(404, 'Task not found');
      return res.status(404).json({
        error: 'Upload task not found',
      });
    }

    // LOG: Task details
    log.artifact.info('UPLOAD DEBUG: Task details', {
      requestId,
      task_id: task.id,
      task_operation: task.operation,
      task_status: task.status,
      task_priority: task.priority,
      task_created_by: task.created_by,
      task_created_at: task.created_at,
    });

    if (task.operation !== 'artifact_upload_process') {
      requestLogger.error(400, 'Invalid task type');
      return res.status(400).json({
        error: 'Invalid task type for upload',
      });
    }

    if (task.status !== 'prepared') {
      requestLogger.error(400, 'Task not prepared');
      log.artifact.error('UPLOAD DEBUG: Task status error', {
        requestId,
        expected_status: 'prepared',
        actual_status: task.status,
        task_id: taskId,
      });
      return res.status(400).json({
        error: 'Task is not in prepared state',
        current_status: task.status,
      });
    }

    // Parse task metadata to get storage location info
    let taskMetadata;
    try {
      taskMetadata = JSON.parse(task.metadata);
      
      // LOG: Task metadata
      log.artifact.info('UPLOAD DEBUG: Task metadata', {
        requestId,
        metadata: {
          original_name: taskMetadata.original_name,
          size: taskMetadata.size,
          storage_location_id: taskMetadata.storage_location_id,
          expected_checksum: taskMetadata.expected_checksum ? 'present' : 'none',
          checksum_algorithm: taskMetadata.checksum_algorithm,
          overwrite_existing: taskMetadata.overwrite_existing,
          upload_prepared: taskMetadata.upload_prepared,
        },
      });
    } catch (parseError) {
      requestLogger.error(500, 'Invalid task metadata');
      log.artifact.error('UPLOAD DEBUG: Metadata parse error', {
        requestId,
        raw_metadata: task.metadata,
        parse_error: parseError.message,
      });
      return res.status(500).json({
        error: 'Invalid task metadata',
        parse_error: parseError.message,
      });
    }

    const storage_location_id = taskMetadata.storage_location_id;
    if (!storage_location_id) {
      requestLogger.error(500, 'Missing storage location in task');
      return res.status(500).json({
        error: 'Storage location not found in task metadata',
      });
    }

    // Verify storage location exists and is enabled
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!storageLocation) {
      requestLogger.error(404, 'Storage location not found');
      return res.status(404).json({
        error: 'Storage location not found',
      });
    }

    if (!storageLocation.enabled) {
      requestLogger.error(400, 'Storage location disabled');
      return res.status(400).json({
        error: 'Storage location is disabled',
      });
    }

    // LOG: Storage location details
    log.artifact.info('UPLOAD DEBUG: Storage location details', {
      requestId,
      storage_location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
        type: storageLocation.type,
        enabled: storageLocation.enabled,
        file_count: storageLocation.file_count,
        total_size: storageLocation.total_size,
      },
    });

    // Calculate and log size limits
    const maxUploadSizeGB = artifactConfig.security?.max_upload_size_gb || 50;
    const maxUploadSizeBytes = maxUploadSizeGB * 1024 * 1024 * 1024;
    const expectedFileSizeBytes = taskMetadata.size || 0;
    
    log.artifact.info('UPLOAD DEBUG: Size calculations', {
      requestId,
      max_upload_size_gb: maxUploadSizeGB,
      max_upload_size_bytes: maxUploadSizeBytes,
      expected_file_size_bytes: expectedFileSizeBytes,
      expected_file_size_mb: Math.round(expectedFileSizeBytes / 1024 / 1024),
      size_limit_exceeded: expectedFileSizeBytes > maxUploadSizeBytes,
      content_length_header: req.get('Content-Length'),
    });

    // Create custom multer storage with pfexec file pre-creation
    const storage = multer.diskStorage({
      destination: (req, file, cb) => {
        log.artifact.info('UPLOAD DEBUG: Multer destination callback', {
          requestId,
          destination_path: storageLocation.path,
          filename: file.originalname,
          fieldname: file.fieldname,
          mimetype: file.mimetype,
        });
        cb(null, storageLocation.path);
      },
      filename: async (req, file, cb) => {
        try {
          const finalPath = path.join(storageLocation.path, file.originalname);
          
          log.artifact.info('UPLOAD DEBUG: Pre-creating file with pfexec', {
            requestId,
            original_filename: file.originalname,
            final_path: finalPath,
            mimetype: file.mimetype,
            encoding: file.encoding,
          });

          // Pre-create file with pfexec and set writable permissions
          const createResult = await executeCommand(`pfexec touch "${finalPath}"`);
          if (!createResult.success) {
            log.artifact.error('UPLOAD DEBUG: Failed to pre-create file', {
              requestId,
              final_path: finalPath,
              error: createResult.error,
            });
            return cb(new Error(`Failed to pre-create file: ${createResult.error}`));
          }

          // Set permissions so service user can write to the file
          const chmodResult = await executeCommand(`pfexec chmod 666 "${finalPath}"`);
          if (!chmodResult.success) {
            log.artifact.error('UPLOAD DEBUG: Failed to set file permissions', {
              requestId,
              final_path: finalPath,
              error: chmodResult.error,
            });
            return cb(new Error(`Failed to set file permissions: ${chmodResult.error}`));
          }

          log.artifact.info('UPLOAD DEBUG: File pre-created successfully', {
            requestId,
            final_path: finalPath,
            permissions_set: '666',
          });

          cb(null, file.originalname);
        } catch (error) {
          log.artifact.error('UPLOAD DEBUG: Exception in filename callback', {
            requestId,
            error: error.message,
            stack: error.stack,
          });
          cb(error);
        }
      },
    });

    // Get multer limits from config
    const multerConfig = {
      storage,
      limits: {
        fileSize: maxUploadSizeBytes,
        fieldSize: (artifactConfig.security?.max_form_field_size_mb || 10) * 1024 * 1024,
        files: artifactConfig.security?.max_files_per_upload || 1,
        fields: artifactConfig.security?.max_form_fields || 10,
      }
    };

    log.artifact.info('UPLOAD DEBUG: Multer configuration', {
      requestId,
      limits: multerConfig.limits,
      storage_type: 'diskStorage',
    });

    const upload = multer(multerConfig).single('file');

    // Process upload with direct-to-final storage
    upload(req, res, async (uploadError) => {
      if (uploadError) {
        // LOG: Detailed upload error
        log.artifact.error('UPLOAD DEBUG: Upload error occurred', {
          requestId,
          error_name: uploadError.name,
          error_message: uploadError.message,
          error_code: uploadError.code,
          error_field: uploadError.field,
          error_stack: uploadError.stack,
          upload_error_type: uploadError.constructor.name,
          multer_error_properties: Object.keys(uploadError),
        });

        requestLogger.error(400, `Upload failed: ${uploadError.message}`);
        return res.status(400).json({
          error: 'File upload failed',
          error_code: uploadError.code,
          error_type: uploadError.name,
          details: uploadError.message,
          debug_info: {
            expected_size_mb: Math.round(expectedFileSizeBytes / 1024 / 1024),
            max_size_mb: Math.round(maxUploadSizeBytes / 1024 / 1024),
            content_length: req.get('Content-Length'),
          },
        });
      }

      if (!req.file) {
        log.artifact.error('UPLOAD DEBUG: No file in request', {
          requestId,
          body_keys: Object.keys(req.body || {}),
          files_property: req.files,
          file_property: req.file,
        });
        requestLogger.error(400, 'No file uploaded');
        return res.status(400).json({
          error: 'No file uploaded',
        });
      }

      // LOG: Successful upload details
      log.artifact.info('UPLOAD DEBUG: File upload successful', {
        requestId,
        file: {
          fieldname: req.file.fieldname,
          originalname: req.file.originalname,
          encoding: req.file.encoding,
          mimetype: req.file.mimetype,
          destination: req.file.destination,
          filename: req.file.filename,
          path: req.file.path,
          size: req.file.size,
          size_mb: Math.round(req.file.size / 1024 / 1024),
        },
        upload_duration: timer.end(),
      });

      // File is now in final location
      const finalPath = req.file.path;

      log.artifact.info('Artifact uploaded directly to final location', {
        requestId,
        task_id: taskId,
        filename: req.file.originalname,
        size: req.file.size,
        storage_location: storageLocation.name,
        final_path: finalPath,
        has_expected_checksum: !!taskMetadata.expected_checksum,
      });

      // Update task metadata with final upload information
      const updatedMetadata = {
        ...taskMetadata,
        final_path: finalPath,
        original_name: req.file.originalname,
        size: req.file.size,
        upload_completed: true,
      };

      log.artifact.info('UPLOAD DEBUG: Updating task metadata', {
        requestId,
        task_id: taskId,
        updated_metadata: {
          final_path: updatedMetadata.final_path,
          original_name: updatedMetadata.original_name,
          size: updatedMetadata.size,
          upload_completed: updatedMetadata.upload_completed,
        },
      });

      await task.update({
        metadata: await new Promise((resolve, reject) => {
          yj.stringifyAsync(updatedMetadata, (err, result) => {
            if (err) reject(err);
            else resolve(result);
          });
        }),
        status: 'pending', // Mark as pending so task queue will process it
      });

      const duration = timer.end({
        filename: req.file.originalname,
        fileSize: req.file.size,
        final_location: finalPath,
      });

      log.artifact.info('Upload task updated successfully', {
        requestId,
        task_id: taskId,
        filename: req.file.originalname,
        fileSize: req.file.size,
        duration_ms: duration,
      });

      const response = {
        success: true,
        message: `Upload completed for '${req.file.originalname}'`,
        task_id: taskId,
        file: {
          name: req.file.originalname,
          size: req.file.size,
          final_location: finalPath,
        },
        storage_location: {
          id: storageLocation.id,
          name: storageLocation.name,
          path: storageLocation.path,
        },
      };

      log.artifact.info('UPLOAD DEBUG: Sending success response', {
        requestId,
        response_status: 202,
        response_body: response,
      });

      requestLogger.success(202, {
        filename: req.file.originalname,
        fileSize: req.file.size,
        task_id: taskId,
      });

      res.status(202).json(response);
    });

  } catch (error) {
    timer.end({ error: error.message });
    log.artifact.error('UPLOAD DEBUG: Exception in upload handler', {
      requestId,
      error: error.message,
      error_name: error.name,
      stack: error.stack,
      error_properties: Object.keys(error),
    });

    log.artifact.error('Artifact upload failed', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    requestLogger.error(500, error.message);
    res.status(500).json({
      error: 'Failed to process upload',
      details: error.message,
      debug_request_id: requestId,
    });
  }
};

/**
 * @swagger
 * /artifacts/{id}/download:
 *   get:
 *     summary: Download artifact file
 *     description: Stream download an artifact file
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Artifact ID
 *     responses:
 *       200:
 *         description: Artifact file downloaded successfully
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       404:
 *         description: Artifact not found
 *       500:
 *         description: Failed to download artifact
 */
export const downloadArtifact = async (req, res) => {
  try {
    const { id } = req.params;

    const artifact = await Artifact.findByPk(id, {
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
          attributes: ['id', 'name', 'path'],
        },
      ],
    });

    if (!artifact) {
      return res.status(404).json({
        error: 'Artifact not found',
      });
    }

    // Verify file exists
    if (!fs.existsSync(artifact.path)) {
      log.artifact.warn('Artifact file not found on disk', {
        artifact_id: id,
        filename: artifact.filename,
        path: artifact.path,
      });
      return res.status(404).json({
        error: 'Artifact file not found on disk',
      });
    }

    // Set headers for download (following FileSystemController pattern)
    res.setHeader('Content-Disposition', `attachment; filename="${artifact.filename}"`);
    res.setHeader('Content-Type', artifact.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', artifact.size);

    log.artifact.info('Streaming artifact download', {
      artifact_id: id,
      filename: artifact.filename,
      size_mb: Math.round(artifact.size / 1024 / 1024),
      client_ip: req.ip,
    });

    // Stream the file (following FileSystemController pattern)
    const readStream = fs.createReadStream(artifact.path);
    readStream.pipe(res);

    readStream.on('error', error => {
      log.artifact.error('Error streaming artifact', {
        error: error.message,
        artifact_id: id,
        path: artifact.path,
      });
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Failed to download artifact',
          details: error.message,
        });
      }
    });

    // Update last_verified timestamp
    artifact.update({ last_verified: new Date() }).catch(updateError => {
      log.artifact.warn('Failed to update last_verified timestamp', {
        artifact_id: id,
        error: updateError.message,
      });
    });

  } catch (error) {
    log.api.error('Error downloading artifact', {
      error: error.message,
      stack: error.stack,
      id: req.params.id,
    });

    if (!res.headersSent) {
      res.status(500).json({
        error: 'Failed to download artifact',
        details: error.message,
      });
    }
  }
};

/**
 * @swagger
 * /artifacts/scan:
 *   post:
 *     summary: Scan storage locations
 *     description: Creates a task to scan storage locations for new artifacts
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [iso, image]
 *                 description: Scan only locations of this type
 *               storage_path_id:
 *                 type: string
 *                 format: uuid
 *                 description: Scan only this specific location
 *               verify_checksums:
 *                 type: boolean
 *                 default: false
 *                 description: Recalculate and verify checksums
 *               remove_orphaned:
 *                 type: boolean
 *                 default: false
 *                 description: Remove database records for missing files
 *     responses:
 *       202:
 *         description: Scan task created successfully
 *       404:
 *         description: Storage location not found
 *       500:
 *         description: Failed to create scan task
 */
export const scanArtifacts = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const {
      type,
      storage_path_id,
      verify_checksums = false,
      remove_orphaned = false,
    } = req.body;

    let task;

    if (storage_path_id) {
      // Scan specific location
      const storageLocation = await ArtifactStorageLocation.findByPk(storage_path_id);
      if (!storageLocation) {
        return res.status(404).json({
          error: 'Storage location not found',
        });
      }

      task = await Tasks.create({
        zone_name: 'artifact',
        operation: 'artifact_scan_location',
        priority: TaskPriority.BACKGROUND,
        created_by: req.entity.name,
        status: 'pending',
        metadata: await new Promise((resolve, reject) => {
          yj.stringifyAsync(
            {
              storage_location_id: storage_path_id,
              verify_checksums,
              remove_orphaned,
            },
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            }
          );
        }),
      });

      res.status(202).json({
        success: true,
        message: `Scan task created for storage location '${storageLocation.name}'`,
        task_id: task.id,
        scope: 'single_location',
        location: {
          id: storageLocation.id,
          name: storageLocation.name,
          path: storageLocation.path,
        },
      });
    } else {
      // Scan all locations (optionally filtered by type)
      const whereClause = { enabled: true };
      if (type) {
        whereClause.type = type;
      }

      const locationsToScan = await ArtifactStorageLocation.findAll({
        where: whereClause,
        attributes: ['id', 'name', 'type'],
      });

      task = await Tasks.create({
        zone_name: 'artifact',
        operation: 'artifact_scan_all',
        priority: TaskPriority.BACKGROUND,
        created_by: req.entity.name,
        status: 'pending',
        metadata: await new Promise((resolve, reject) => {
          yj.stringifyAsync(
            {
              verify_checksums,
              remove_orphaned,
              source: 'manual_scan',
              filter_type: type || null,
            },
            (err, result) => {
              if (err) reject(err);
              else resolve(result);
            }
          );
        }),
      });

      res.status(202).json({
        success: true,
        message: `Scan task created for ${locationsToScan.length} storage location(s)${type ? ` (${type} only)` : ''}`,
        task_id: task.id,
        scope: type ? `${type}_locations` : 'all_locations',
        locations_to_scan: locationsToScan.length,
      });
    }

    log.artifact.info('Scan task created', {
      task_id: task.id,
      scope: storage_path_id ? 'single_location' : 'multiple_locations',
      type_filter: type,
      verify_checksums,
      remove_orphaned,
    });

  } catch (error) {
    log.api.error('Error creating scan task', {
      error: error.message,
      stack: error.stack,
      type,
      storage_path_id,
    });
    res.status(500).json({
      error: 'Failed to create scan task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/files:
 *   delete:
 *     summary: Delete artifact files
 *     description: Creates a task to delete specific artifact files
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - artifact_ids
 *             properties:
 *               artifact_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *                 description: List of artifact IDs to delete
 *               delete_files:
 *                 type: boolean
 *                 default: true
 *                 description: Whether to delete actual files from disk
 *               force:
 *                 type: boolean
 *                 default: false
 *                 description: Force deletion even if errors occur
 *     responses:
 *       202:
 *         description: Deletion task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create deletion task
 */
export const deleteArtifacts = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    const { artifact_ids, delete_files = true, force = false } = req.body;

    if (!artifact_ids || !Array.isArray(artifact_ids) || artifact_ids.length === 0) {
      return res.status(400).json({
        error: 'artifact_ids array is required and must not be empty',
      });
    }

    // Validate that artifacts exist
    const artifacts = await Artifact.findAll({
      where: { id: artifact_ids },
      attributes: ['id', 'filename', 'size'],
    });

    if (artifacts.length === 0) {
      return res.status(400).json({
        error: 'No artifacts found for the provided IDs',
      });
    }

    if (artifacts.length !== artifact_ids.length) {
      const foundIds = artifacts.map(a => a.id);
      const missingIds = artifact_ids.filter(id => !foundIds.includes(id));
      log.artifact.warn('Some artifact IDs not found', {
        requested_count: artifact_ids.length,
        found_count: artifacts.length,
        missing_ids: missingIds,
      });
    }

    // Create deletion task
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_delete_file',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            artifact_ids: artifacts.map(a => a.id),
            delete_files,
            force,
          },
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      }),
    });

    log.artifact.info('Artifact deletion task created', {
      task_id: task.id,
      artifact_count: artifacts.length,
      delete_files,
      force,
    });

    res.status(202).json({
      success: true,
      message: `Deletion task created for ${artifacts.length} artifact(s)`,
      task_id: task.id,
      artifacts: artifacts.map(a => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
      })),
      delete_files,
    });
  } catch (error) {
    log.api.error('Error creating artifact deletion task', {
      error: error.message,
      stack: error.stack,
      artifact_ids,
    });
    res.status(500).json({
      error: 'Failed to create deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/stats:
 *   get:
 *     summary: Get artifact statistics
 *     description: Retrieves statistics about artifacts and storage locations
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 by_type:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       count:
 *                         type: integer
 *                       total_size:
 *                         type: integer
 *                       locations:
 *                         type: integer
 *                 storage_locations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       name:
 *                         type: string
 *                       path:
 *                         type: string
 *                       type:
 *                         type: string
 *                       enabled:
 *                         type: boolean
 *                       file_count:
 *                         type: integer
 *                       total_size:
 *                         type: integer
 *                       last_scan:
 *                         type: string
 *                 recent_activity:
 *                   type: object
 *                   properties:
 *                     downloads_last_24h:
 *                       type: integer
 *                     uploads_last_24h:
 *                       type: integer
 *                     failed_operations_last_24h:
 *                       type: integer
 *       500:
 *         description: Failed to retrieve statistics
 */
export const getArtifactStats = async (req, res) => {
  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    // Get statistics from service
    const service = getArtifactStorageService();
    const stats = await service.getArtifactStats();

    // Get recent activity from tasks
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const recentTasks = await Tasks.findAll({
      where: {
        operation: {
          [Op.in]: ['artifact_download_url', 'artifact_upload_process'],
        },
        created_at: { [Op.gte]: yesterday },
      },
      attributes: ['operation', 'status'],
    });

    const recentActivity = {
      downloads_last_24h: recentTasks.filter(t => 
        t.operation === 'artifact_download_url' && t.status === 'completed'
      ).length,
      uploads_last_24h: recentTasks.filter(t => 
        t.operation === 'artifact_upload_process' && t.status === 'completed'
      ).length,
      failed_operations_last_24h: recentTasks.filter(t => 
        t.status === 'failed'
      ).length,
    };

    res.json({
      ...stats,
      recent_activity: recentActivity,
    });
  } catch (error) {
    log.api.error('Error getting artifact statistics', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to retrieve statistics',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /artifacts/service/status:
 *   get:
 *     summary: Get artifact storage service status
 *     description: Retrieves current status of the artifact storage service
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Service status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isRunning:
 *                   type: boolean
 *                 isInitialized:
 *                   type: boolean
 *                 config:
 *                   type: object
 *                 stats:
 *                   type: object
 *                 activeIntervals:
 *                   type: object
 *       500:
 *         description: Failed to retrieve service status
 */
export const getArtifactServiceStatus = async (req, res) => {
  try {
    const service = getArtifactStorageService();
    const status = service.getStatus();

    res.json(status);
  } catch (error) {
    log.api.error('Error getting artifact service status', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to retrieve service status',
      details: error.message,
    });
  }
};
