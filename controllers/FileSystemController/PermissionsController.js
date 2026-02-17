import { validatePath, getItemInfo } from '../../lib/FileSystemManager.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview File and directory permissions controller
 */

/**
 * @swagger
 * /filesystem/permissions:
 *   patch:
 *     summary: Change file or directory permissions
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
 *                 description: File or directory path
 *                 example: "/home/user/file.txt"
 *               uid:
 *                 type: integer
 *                 description: New user ID for ownership
 *                 example: 1000
 *               gid:
 *                 type: integer
 *                 description: New group ID for ownership
 *                 example: 1000
 *               mode:
 *                 type: string
 *                 description: New permissions in octal format
 *                 example: "644"
 *               recursive:
 *                 type: boolean
 *                 description: Apply changes recursively to directories
 *                 default: false
 *     responses:
 *       200:
 *         description: Permissions updated successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       404:
 *         description: File not found
 *       500:
 *         description: Failed to update permissions
 */
export const changePermissions = async (req, res) => {
  const { path: itemPath, uid, gid, mode, recursive = false } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!itemPath) {
      return res.status(400).json({
        error: 'path is required',
      });
    }

    if (uid === undefined && gid === undefined && mode === undefined) {
      return res.status(400).json({
        error: 'At least one of uid, gid, or mode must be specified',
      });
    }

    log.filesystem.info('Permission change request', {
      path: itemPath,
      uid,
      gid,
      mode,
      recursive,
      user: req.entity.name,
    });

    const validation = validatePath(itemPath);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }

    const { normalizedPath } = validation;
    const { executeCommand } = await import('../../lib/FileSystemManager.js');

    // Change ownership if specified
    if (uid !== undefined || gid !== undefined) {
      let chownCommand = `pfexec chown`;
      if (recursive) {
        chownCommand += ` -R`;
      }

      const uidVal = uid !== undefined ? uid : -1;
      const gidVal = gid !== undefined ? gid : -1;
      chownCommand += ` ${uidVal}:${gidVal} "${normalizedPath}"`;

      const chownResult = await executeCommand(chownCommand);
      if (!chownResult.success) {
        throw new Error(`Failed to change ownership: ${chownResult.error}`);
      }
    }

    // Change permissions if specified
    if (mode !== undefined) {
      let chmodCommand = `pfexec chmod`;
      if (recursive) {
        chmodCommand += ` -R`;
      }
      chmodCommand += ` ${mode} "${normalizedPath}"`;

      const chmodResult = await executeCommand(chmodCommand);
      if (!chmodResult.success) {
        throw new Error(`Failed to change permissions: ${chmodResult.error}`);
      }
    }

    // Get updated item info
    const itemInfo = await getItemInfo(itemPath);

    return res.json({
      success: true,
      message: `Permissions updated successfully for '${itemInfo.name}'`,
      item: itemInfo,
      changes_applied: {
        uid,
        gid,
        mode,
        recursive,
      },
    });
  } catch (error) {
    log.filesystem.error('Error changing permissions', {
      error: error.message,
      stack: error.stack,
      path: itemPath,
      uid,
      gid,
      mode,
      recursive,
    });

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      return res.status(404).json({ error: 'File not found' });
    }

    return res.status(500).json({
      error: 'Failed to update permissions',
      details: error.message,
    });
  }
};
