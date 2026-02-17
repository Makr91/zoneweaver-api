import { createDirectory, getItemInfo } from '../../lib/FileSystemManager.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import path from 'path';

/**
 * @fileoverview Directory creation controller
 */

/**
 * @swagger
 * /filesystem/folder:
 *   post:
 *     summary: Create directory
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
 *               - name
 *             properties:
 *               path:
 *                 type: string
 *                 description: Parent directory path
 *                 example: "/home/user"
 *               name:
 *                 type: string
 *                 description: New directory name
 *                 example: "new_folder"
 *               mode:
 *                 type: string
 *                 description: Permissions in octal format
 *                 example: "755"
 *               uid:
 *                 type: integer
 *                 description: User ID for ownership
 *               gid:
 *                 type: integer
 *                 description: Group ID for ownership
 *     responses:
 *       201:
 *         description: Directory created successfully
 *       400:
 *         description: Invalid request or directory already exists
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create directory
 */
export const createFolder = async (req, res) => {
  const { path: parentPath, name, mode, uid, gid } = req.body;
  let fullPath;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!parentPath || !name) {
      return res.status(400).json({
        error: 'path and name are required',
      });
    }

    fullPath = path.join(parentPath, name);

    const options = {};
    if (mode) {
      options.mode = parseInt(mode, 8);
    }
    if (uid !== undefined) {
      options.uid = uid;
    }
    if (gid !== undefined) {
      options.gid = gid;
    }

    await createDirectory(fullPath, options);

    const itemInfo = await getItemInfo(fullPath);

    return res.status(201).json({
      success: true,
      message: `Directory '${name}' created successfully`,
      item: itemInfo,
    });
  } catch (error) {
    log.filesystem.error('Error creating directory', {
      error: error.message,
      stack: error.stack,
      path: fullPath,
      name,
    });

    if (error.message.includes('already exists')) {
      return res.status(400).json({ error: error.message });
    }

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to create directory',
      details: error.message,
    });
  }
};
