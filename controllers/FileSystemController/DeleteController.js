import { deleteItem, validatePath } from '../../lib/FileSystemManager.js';
import config from '../../config/ConfigLoader.js';
import { log, createRequestLogger, createTimer } from '../../lib/Logger.js';
import path from 'path';
import fs from 'fs';

/**
 * @fileoverview File and directory deletion controller
 */

/**
 * @swagger
 * /filesystem:
 *   delete:
 *     summary: Delete item
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - path
 *             properties:
 *               path:
 *                 type: string
 *                 description: Item path to delete
 *                 example: "/home/user/file.txt"
 *               recursive:
 *                 type: boolean
 *                 description: Delete directories recursively
 *                 default: false
 *               force:
 *                 type: boolean
 *                 description: Force deletion
 *                 default: false
 *     responses:
 *       200:
 *         description: Item deleted successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       404:
 *         description: Item not found
 *       500:
 *         description: Failed to delete item
 */
export const deleteFileItem = async (req, res) => {
  const requestId = `delete-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timer = createTimer('file_delete');
  const requestLogger = createRequestLogger(requestId, req);

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      requestLogger.error(503, 'File browser disabled');
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    const { path: itemPath, recursive = false, force = false } = req.body;

    if (!itemPath) {
      requestLogger.error(400, 'Path required');
      return res.status(400).json({
        error: 'path is required',
      });
    }

    log.filesystem.info('File deletion started', {
      requestId,
      path: itemPath,
      recursive,
      force,
      user: req.entity.name,
    });

    // Fast path validation without expensive operations
    const validation = validatePath(itemPath);
    if (!validation.valid) {
      requestLogger.error(403, 'Path validation failed');
      return res.status(403).json({ error: validation.error });
    }

    // Get basic item info quickly (no binary detection)
    let itemInfo;
    try {
      const stats = await fs.promises.stat(validation.normalizedPath);
      itemInfo = {
        name: path.basename(itemPath),
        path: itemPath,
        isDirectory: stats.isDirectory(),
        size: stats.isDirectory() ? null : stats.size,
      };

      log.filesystem.debug('Item info retrieved', {
        requestId,
        name: itemInfo.name,
        isDirectory: itemInfo.isDirectory,
        size: itemInfo.size,
      });
    } catch (infoError) {
      log.filesystem.warn('Could not stat file before deletion', {
        requestId,
        path: itemPath,
        error: infoError.message,
      });
      itemInfo = {
        name: path.basename(itemPath),
        isDirectory: false,
        path: itemPath,
        size: null,
      };
    }

    // Perform the actual deletion immediately
    await deleteItem(itemPath, { recursive, force });

    const duration = timer.end({
      itemName: itemInfo.name,
      itemType: itemInfo.isDirectory ? 'directory' : 'file',
      size: itemInfo.size,
    });

    log.filesystem.info('File deletion completed', {
      requestId,
      path: itemPath,
      itemName: itemInfo.name,
      itemType: itemInfo.isDirectory ? 'directory' : 'file',
      size: itemInfo.size,
      recursive,
      force,
      duration_ms: duration,
    });

    const response = {
      success: true,
      message: `${itemInfo.isDirectory ? 'Directory' : 'File'} '${itemInfo.name}' deleted successfully`,
      deleted_item: itemInfo,
    };

    requestLogger.success(200, {
      itemName: itemInfo.name,
      itemType: itemInfo.isDirectory ? 'directory' : 'file',
      size: itemInfo.size,
    });

    return res.json(response);
  } catch (error) {
    timer.end({ error: error.message });
    log.filesystem.error('File deletion failed', {
      requestId,
      path: req.body.path,
      error: error.message,
      stack: error.stack,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      requestLogger.error(403, 'Access forbidden');
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      requestLogger.error(404, 'Item not found');
      return res.status(404).json({ error: 'Item not found' });
    }

    requestLogger.error(500, error.message);
    return res.status(500).json({
      error: 'Failed to delete item',
      details: error.message,
    });
  }
};
