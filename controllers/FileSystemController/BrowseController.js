import { listDirectory } from '../../lib/FileSystemManager.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import path from 'path';

/**
 * @fileoverview File system browse controller
 */

/**
 * @swagger
 * tags:
 *   name: File System
 *   description: File browser and file management operations
 */

/**
 * @swagger
 * /filesystem:
 *   get:
 *     summary: Browse directory contents
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         schema:
 *           type: string
 *           default: "/"
 *         description: Directory path to browse
 *       - in: query
 *         name: show_hidden
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include hidden files and directories
 *       - in: query
 *         name: sort_by
 *         schema:
 *           type: string
 *           enum: [name, size, modified, type]
 *           default: name
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
 *         description: Directory contents retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/FileSystemItem'
 *                 current_path:
 *                   type: string
 *                 parent_path:
 *                   type: string
 *                 total_items:
 *                   type: integer
 *       403:
 *         description: Access forbidden
 *       404:
 *         description: Directory not found
 *       500:
 *         description: Failed to browse directory
 */
export const browseDirectory = async (req, res) => {
  const {
    path: dirPath = '/',
    show_hidden = false,
    sort_by = 'name',
    sort_order = 'asc',
  } = req.query;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    const items = await listDirectory(dirPath);

    // Filter hidden files if requested
    let filteredItems = items;
    if (!show_hidden) {
      filteredItems = items.filter(item => !item.name.startsWith('.'));
    }

    // Apply sorting
    filteredItems.sort((a, b) => {
      let aVal;
      let bVal;

      switch (sort_by) {
        case 'size':
          aVal = a.size || 0;
          bVal = b.size || 0;
          break;
        case 'modified':
          aVal = new Date(a.mtime);
          bVal = new Date(b.mtime);
          break;
        case 'type':
          aVal = a.isDirectory ? 'directory' : a.mimeType || 'file';
          bVal = b.isDirectory ? 'directory' : b.mimeType || 'file';
          break;
        default: // name
          aVal = a.name.toLowerCase();
          bVal = b.name.toLowerCase();
      }

      let result = 0;
      if (aVal < bVal) {
        result = -1;
      } else if (aVal > bVal) {
        result = 1;
      }
      return sort_order === 'desc' ? -result : result;
    });

    // Calculate parent path
    const parentPath = path.dirname(dirPath);

    return res.json({
      items: filteredItems,
      current_path: dirPath,
      parent_path: parentPath !== dirPath ? parentPath : null,
      total_items: filteredItems.length,
      hidden_items_filtered: show_hidden ? 0 : items.length - filteredItems.length,
    });
  } catch (error) {
    log.api.error('Error browsing directory', {
      error: error.message,
      stack: error.stack,
      path: dirPath,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      return res.status(404).json({ error: 'Directory not found' });
    }

    return res.status(500).json({
      error: 'Failed to browse directory',
      details: error.message,
    });
  }
};
