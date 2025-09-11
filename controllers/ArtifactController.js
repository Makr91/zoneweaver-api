/**
 * @fileoverview Artifact Controller for Zoneweaver API
 * @description Handles artifact storage management, file operations, and inventory tracking
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import config from '../config/ConfigLoader.js';
import ArtifactStorageLocation from '../models/ArtifactStorageLocationModel.js';
import Artifact from '../models/ArtifactModel.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import { getArtifactStorageService } from './ArtifactStorageService.js';
import { log, createTimer, createRequestLogger } from '../lib/Logger.js';
import { validatePath, getMimeType } from '../lib/FileSystemManager.js';
import { Op } from 'sequelize';
import yj from 'yieldable-json';

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
          const { executeCommand } = await import('../lib/FileSystemManager.js');
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
        await fs.promises.mkdir(normalizedPath, { recursive: true });
        log.artifact.info('Created storage directory', {
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

    // TODO: Update config.yaml with new path
    // This would require implementing config file update functionality
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
 * /artifacts/upload:
 *   post:
 *     summary: Upload artifact file
 *     description: Upload an artifact file to specified storage location
 *     tags: [Artifact Storage]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *               - storage_path_id
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Artifact file to upload
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
 *       202:
 *         description: Upload task created successfully
 *       400:
 *         description: Invalid upload request
 *       404:
 *         description: Storage location not found
 *       413:
 *         description: File too large
 *       500:
 *         description: Failed to process upload
 */
export const uploadArtifact = async (req, res) => {
  const requestId = `artifact-upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timer = createTimer('artifact_upload');
  const requestLogger = createRequestLogger(requestId, req);

  try {
    const artifactConfig = config.getArtifactStorage();

    if (!artifactConfig?.enabled) {
      requestLogger.error(503, 'Artifact storage disabled');
      return res.status(503).json({
        error: 'Artifact storage is disabled',
      });
    }

    if (!req.file) {
      requestLogger.error(400, 'No file uploaded');
      return res.status(400).json({
        error: 'No file uploaded',
      });
    }

    const { 
      storage_path_id, 
      expected_checksum, 
      checksum_algorithm = 'sha256',
      overwrite_existing = false 
    } = req.body;

    if (!storage_path_id) {
      requestLogger.error(400, 'Storage path ID required');
      return res.status(400).json({
        error: 'storage_path_id is required',
      });
    }

    // Validate checksum algorithm
    if (!['md5', 'sha1', 'sha256'].includes(checksum_algorithm)) {
      requestLogger.error(400, 'Invalid checksum algorithm');
      return res.status(400).json({
        error: 'checksum_algorithm must be md5, sha1, or sha256',
      });
    }

    // Verify storage location exists and is enabled
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_path_id);
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

    // Multer already saved the file to temp location
    const filePath = req.file.path;
    const { filename } = req.file;

    log.artifact.info('Artifact upload processing', {
      requestId,
      filename: req.file.originalname,
      sanitized_name: filename,
      size: req.file.size,
      storage_location: storageLocation.name,
      temp_path: filePath,
      has_expected_checksum: !!expected_checksum,
    });

    // Create task for post-processing (checksum calculation, move to final location)
    const task = await Tasks.create({
      zone_name: 'artifact',
      operation: 'artifact_upload_process',
      priority: TaskPriority.MEDIUM,
      created_by: req.entity.name,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            temp_path: filePath,
            original_name: req.file.originalname,
            size: req.file.size,
            storage_location_id: storage_path_id,
            expected_checksum,
            checksum_algorithm,
          },
          (err, result) => {
            if (err) reject(err);
            else resolve(result);
          }
        );
      }),
    });

    const duration = timer.end({
      filename: req.file.originalname,
      fileSize: req.file.size,
      temp_location: filePath,
    });

    log.artifact.info('Upload task created successfully', {
      requestId,
      task_id: task.id,
      filename: req.file.originalname,
      fileSize: req.file.size,
      duration_ms: duration,
    });

    const response = {
      success: true,
      message: `Upload task created for '${req.file.originalname}'`,
      task_id: task.id,
      file: {
        name: req.file.originalname,
        size: req.file.size,
        temp_location: filePath,
      },
      storage_location: {
        id: storageLocation.id,
        name: storageLocation.name,
        path: storageLocation.path,
      },
    };

    requestLogger.success(202, {
      filename: req.file.originalname,
      fileSize: req.file.size,
      task_id: task.id,
    });

    res.status(202).json(response);
  } catch (error) {
    timer.end({ error: error.message });
    log.artifact.error('Artifact upload failed', {
      requestId,
      error: error.message,
      stack: error.stack,
      filename: req.file?.originalname,
    });

    requestLogger.error(500, error.message);
    res.status(500).json({
      error: 'Failed to process upload',
      details: error.message,
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
