import { getItemInfo, validatePath } from '../../lib/FileSystemManager.js';
import config from '../../config/ConfigLoader.js';
import { log, createRequestLogger, createTimer } from '../../lib/Logger.js';
import path from 'path';
import fs from 'fs';

/**
 * @fileoverview File upload and download controllers
 */

/**
 * @swagger
 * /filesystem/upload:
 *   post:
 *     summary: Upload file
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: File to upload
 *               uploadPath:
 *                 type: string
 *                 description: Destination directory path
 *                 example: "/home/user"
 *               overwrite:
 *                 type: boolean
 *                 description: Whether to overwrite existing files
 *                 default: false
 *               uid:
 *                 type: integer
 *                 description: User ID for file ownership
 *               gid:
 *                 type: integer
 *                 description: Group ID for file ownership
 *               mode:
 *                 type: string
 *                 description: File permissions in octal format
 *                 example: "644"
 *     responses:
 *       201:
 *         description: File uploaded successfully
 *       400:
 *         description: Invalid upload request
 *       403:
 *         description: Access forbidden
 *       409:
 *         description: File already exists
 *       413:
 *         description: File too large
 *       500:
 *         description: Upload failed
 */
export const uploadFile = async (req, res) => {
  const requestId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timer = createTimer('file_upload');
  const requestLogger = createRequestLogger(requestId, req);

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      requestLogger.error(503, 'File browser disabled');
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!req.file) {
      requestLogger.error(400, 'No file uploaded');
      return res.status(400).json({
        error: 'No file uploaded',
      });
    }

    const { uid, gid, mode } = req.body;

    // Multer already saved the file, just get its path
    const filePath = req.file.path;
    const { filename } = req.file;

    log.filesystem.info('File upload processing', {
      requestId,
      filename: req.file.originalname,
      sanitizedName: filename,
      size: req.file.size,
      mimetype: req.file.mimetype,
      destination: filePath,
      uploadPath: req.body.uploadPath,
      overwrite: req.body.overwrite,
      uid,
      gid,
      mode,
      user: req.entity.name,
    });

    // Set ownership and permissions quickly (skip on failure, don't block response)
    if (uid !== undefined || gid !== undefined) {
      const { executeCommand } = await import('../../lib/FileSystemManager.js');
      const uidVal = parseInt(uid) || -1;
      const gidVal = parseInt(gid) || -1;
      executeCommand(`pfexec chown ${uidVal}:${gidVal} "${filePath}"`).catch(err =>
        log.filesystem.warn('Failed to set ownership', { requestId, filePath, error: err.message })
      );
    }

    if (mode !== undefined) {
      const { executeCommand } = await import('../../lib/FileSystemManager.js');
      executeCommand(`pfexec chmod ${mode} "${filePath}"`).catch(err =>
        log.filesystem.warn('Failed to set permissions', {
          requestId,
          filePath,
          mode,
          error: err.message,
        })
      );
    }

    // Return basic info immediately without expensive operations
    const basicItemInfo = {
      name: filename,
      path: filePath,
      isDirectory: false,
      size: req.file.size,
      mimeType: req.file.mimetype || 'application/octet-stream',
      originalname: req.file.originalname,
    };

    const duration = timer.end({
      filename: req.file.originalname,
      fileSize: req.file.size,
      destination: filePath,
    });

    log.filesystem.info('File upload completed', {
      requestId,
      filename: req.file.originalname,
      fileSize: req.file.size,
      duration_ms: duration,
    });

    const response = {
      success: true,
      message: `File '${filename}' uploaded successfully`,
      file: basicItemInfo,
    };

    requestLogger.success(201, {
      filename: req.file.originalname,
      fileSize: req.file.size,
      destination: filePath,
    });

    return res.status(201).json(response);
  } catch (error) {
    timer.end({ error: error.message });
    log.filesystem.error('File upload failed', {
      requestId,
      error: error.message,
      stack: error.stack,
    });

    if (error.message.includes('already exists')) {
      requestLogger.error(409, 'File already exists');
      return res.status(409).json({ error: error.message });
    }

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      requestLogger.error(403, 'Access forbidden');
      return res.status(403).json({ error: error.message });
    }

    requestLogger.error(500, error.message);
    return res.status(500).json({
      error: 'Failed to upload file',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /filesystem/download:
 *   get:
 *     summary: Download file
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: File path to download
 *         example: "/home/user/document.txt"
 *     responses:
 *       200:
 *         description: File downloaded successfully
 *         content:
 *           application/octet-stream:
 *             schema:
 *               type: string
 *               format: binary
 *       403:
 *         description: Access forbidden
 *       404:
 *         description: File not found
 *       500:
 *         description: Download failed
 */
export const downloadFile = async (req, res) => {
  const { path: filePath } = req.query;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!filePath) {
      return res.status(400).json({
        error: 'path parameter is required',
      });
    }

    const validation = validatePath(filePath);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    const itemInfo = await getItemInfo(filePath);

    if (itemInfo.isDirectory) {
      return res.status(400).json({
        error: 'Cannot download directory - use archive creation instead',
      });
    }

    const { normalizedPath } = validation;
    const filename = path.basename(normalizedPath);

    // Set appropriate headers
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', itemInfo.mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', itemInfo.size);

    // Stream the file
    const readStream = fs.createReadStream(normalizedPath);

    readStream.on('error', error => {
      log.filesystem.error('Error streaming file', {
        error: error.message,
        stack: error.stack,
        path: normalizedPath,
      });
      if (!res.headersSent) {
        return res.status(500).json({
          error: 'Failed to download file',
          details: error.message,
        });
      }
      return undefined;
    });

    readStream.pipe(res);
    return res;
  } catch (error) {
    log.api.error('Error downloading file', {
      error: error.message,
      stack: error.stack,
      path: filePath,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      return res.status(404).json({ error: 'File not found' });
    }

    return res.status(500).json({
      error: 'Failed to download file',
      details: error.message,
    });
  }
};
