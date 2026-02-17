import { readFileContent, writeFileContent, getItemInfo } from '../../lib/FileSystemManager.js';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';

/**
 * @fileoverview File content read/write controllers
 */

/**
 * @swagger
 * /filesystem/content:
 *   get:
 *     summary: Read text file content
 *     tags: [File System]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: path
 *         required: true
 *         schema:
 *           type: string
 *         description: Text file path to read
 *         example: "/etc/hostname"
 *     responses:
 *       200:
 *         description: File content retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 content:
 *                   type: string
 *                 file_info:
 *                   $ref: '#/components/schemas/FileSystemItem'
 *                 encoding:
 *                   type: string
 *       400:
 *         description: Binary file or file too large
 *       403:
 *         description: Access forbidden
 *       404:
 *         description: File not found
 *       500:
 *         description: Failed to read file
 */
export const readFile = async (req, res) => {
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

    const content = await readFileContent(filePath);
    const itemInfo = await getItemInfo(filePath);

    return res.json({
      content,
      file_info: itemInfo,
      encoding: 'utf8',
      size_bytes: Buffer.byteLength(content, 'utf8'),
    });
  } catch (error) {
    log.api.error('Error reading file', {
      error: error.message,
      stack: error.stack,
      path: filePath,
    });

    if (error.message.includes('binary file')) {
      return res.status(400).json({ error: 'Cannot read binary file as text' });
    }

    if (error.message.includes('exceeds edit limit')) {
      return res.status(400).json({ error: error.message });
    }

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes('not found') || error.message.includes('ENOENT')) {
      return res.status(404).json({ error: 'File not found' });
    }

    return res.status(500).json({
      error: 'Failed to read file',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /filesystem/content:
 *   put:
 *     summary: Write text file content
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
 *               - content
 *             properties:
 *               path:
 *                 type: string
 *                 description: File path to write
 *                 example: "/etc/hostname"
 *               content:
 *                 type: string
 *                 description: File content to write
 *               backup:
 *                 type: boolean
 *                 description: Create backup of existing file
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
 *       200:
 *         description: File written successfully
 *       400:
 *         description: Content too large or invalid
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to write file
 */
export const writeFile = async (req, res) => {
  const { path: filePath, content, backup = false, uid, gid, mode } = req.body;

  try {
    const fileBrowserConfig = config.getFileBrowser();

    if (!fileBrowserConfig?.enabled) {
      return res.status(503).json({
        error: 'File browser is disabled',
      });
    }

    if (!filePath || content === undefined) {
      return res.status(400).json({
        error: 'path and content are required',
      });
    }

    const options = { backup };
    if (uid !== undefined) {
      options.uid = uid;
    }
    if (gid !== undefined) {
      options.gid = gid;
    }
    if (mode !== undefined) {
      options.mode = parseInt(mode, 8);
    }

    await writeFileContent(filePath, content, options);

    const itemInfo = await getItemInfo(filePath);

    return res.json({
      success: true,
      message: `File written successfully${backup ? ' (backup created)' : ''}`,
      file_info: itemInfo,
      content_size: Buffer.byteLength(content, 'utf8'),
    });
  } catch (error) {
    log.filesystem.error('Error writing file', {
      error: error.message,
      stack: error.stack,
      path: filePath,
      content_size: content ? Buffer.byteLength(content, 'utf8') : 0,
    });

    if (error.message.includes('exceeds edit limit')) {
      return res.status(400).json({ error: error.message });
    }

    if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({
      error: 'Failed to write file',
      details: error.message,
    });
  }
};
