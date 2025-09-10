/**
 * @fileoverview File System Controller for Zoneweaver API
 * @description Handles file browser operations with full host filesystem access
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import {
    listDirectory,
    getItemInfo,
    readFileContent,
    writeFileContent,
    createDirectory,
    deleteItem,
    moveItem,
    validatePath
} from '../lib/FileSystemManager.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import config from '../config/ConfigLoader.js';
import { log, createRequestLogger, createTimer } from '../lib/Logger.js';
import yj from 'yieldable-json';
import path from 'path';
import fs from 'fs';

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
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const {
            path: dirPath = '/',
            show_hidden = false,
            sort_by = 'name',
            sort_order = 'asc'
        } = req.query;

        const items = await listDirectory(dirPath);
        
        // Filter hidden files if requested
        let filteredItems = items;
        if (!show_hidden) {
            filteredItems = items.filter(item => !item.name.startsWith('.'));
        }
        
        // Apply sorting
        filteredItems.sort((a, b) => {
            let aVal, bVal;
            
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
                    aVal = a.isDirectory ? 'directory' : (a.mimeType || 'file');
                    bVal = b.isDirectory ? 'directory' : (b.mimeType || 'file');
                    break;
                default: // name
                    aVal = a.name.toLowerCase();
                    bVal = b.name.toLowerCase();
            }
            
            const result = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
            return sort_order === 'desc' ? -result : result;
        });

        // Calculate parent path
        const parentPath = path.dirname(dirPath);
        
        res.json({
            items: filteredItems,
            current_path: dirPath,
            parent_path: parentPath !== dirPath ? parentPath : null,
            total_items: filteredItems.length,
            hidden_items_filtered: show_hidden ? 0 : items.length - filteredItems.length
        });

    } catch (error) {
        console.error('Error browsing directory:', error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        if (error.message.includes('not found') || error.message.includes('ENOENT')) {
            return res.status(404).json({ error: 'Directory not found' });
        }
        
        res.status(500).json({ 
            error: 'Failed to browse directory',
            details: error.message 
        });
    }
};

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
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { path: parentPath, name, mode, uid, gid } = req.body;
        
        if (!parentPath || !name) {
            return res.status(400).json({
                error: 'path and name are required'
            });
        }

        const fullPath = path.join(parentPath, name);
        
        const options = {};
        if (mode) options.mode = parseInt(mode, 8);
        if (uid !== undefined) options.uid = uid;
        if (gid !== undefined) options.gid = gid;

        await createDirectory(fullPath, options);

        const itemInfo = await getItemInfo(fullPath);

        res.status(201).json({
            success: true,
            message: `Directory '${name}' created successfully`,
            item: itemInfo
        });

    } catch (error) {
        console.error('Error creating directory:', error);
        
        if (error.message.includes('already exists')) {
            return res.status(400).json({ error: error.message });
        }
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to create directory',
            details: error.message 
        });
    }
};

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
                error: 'File browser is disabled'
            });
        }

        if (!req.file) {
            requestLogger.error(400, 'No file uploaded');
            return res.status(400).json({
                error: 'No file uploaded'
            });
        }

        const { uid, gid, mode } = req.body;
        
        // Multer already saved the file, just get its path
        const filePath = req.file.path;
        const filename = req.file.filename;
        
        log.filesystem.info('File upload processing', {
            requestId,
            filename: req.file.originalname,
            sanitizedName: filename,
            size: req.file.size,
            mimetype: req.file.mimetype,
            destination: filePath,
            uploadPath: req.body.uploadPath,
            overwrite: req.body.overwrite,
            uid: uid,
            gid: gid,
            mode: mode,
            user: req.entity.name
        });
        
        // Set ownership and permissions quickly (skip on failure, don't block response)
        if (uid !== undefined || gid !== undefined) {
            const { executeCommand } = await import('../lib/FileSystemManager.js');
            const uidVal = parseInt(uid) || -1;
            const gidVal = parseInt(gid) || -1;
            executeCommand(`pfexec chown ${uidVal}:${gidVal} "${filePath}"`).catch(err => 
                log.filesystem.warn('Failed to set ownership', { requestId, filePath, error: err.message })
            );
        }
        
        if (mode !== undefined) {
            const { executeCommand } = await import('../lib/FileSystemManager.js');
            executeCommand(`pfexec chmod ${mode} "${filePath}"`).catch(err => 
                log.filesystem.warn('Failed to set permissions', { requestId, filePath, mode, error: err.message })
            );
        }

        // Return basic info immediately without expensive operations
        const basicItemInfo = {
            name: filename,
            path: filePath,
            isDirectory: false,
            size: req.file.size,
            mimeType: req.file.mimetype || 'application/octet-stream',
            originalname: req.file.originalname
        };

        const duration = timer.end({
            filename: req.file.originalname,
            fileSize: req.file.size,
            destination: filePath
        });

        log.filesystem.info('File upload completed', {
            requestId,
            filename: req.file.originalname,
            fileSize: req.file.size,
            duration_ms: duration
        });

        const response = {
            success: true,
            message: `File '${filename}' uploaded successfully`,
            file: basicItemInfo
        };

        requestLogger.success(201, {
            filename: req.file.originalname,
            fileSize: req.file.size,
            destination: filePath
        });

        res.status(201).json(response);

    } catch (error) {
        timer.end({ error: error.message });
        log.filesystem.error('File upload failed', {
            requestId,
            error: error.message,
            stack: error.stack
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
        res.status(500).json({ 
            error: 'Failed to upload file',
            details: error.message 
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
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { path: filePath } = req.query;
        
        if (!filePath) {
            return res.status(400).json({
                error: 'path parameter is required'
            });
        }

        const validation = validatePath(filePath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const itemInfo = await getItemInfo(filePath);
        
        if (itemInfo.isDirectory) {
            return res.status(400).json({
                error: 'Cannot download directory - use archive creation instead'
            });
        }

        const normalizedPath = validation.normalizedPath;
        const filename = path.basename(normalizedPath);

        // Set appropriate headers
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', itemInfo.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', itemInfo.size);

        // Stream the file
        const readStream = fs.createReadStream(normalizedPath);
        readStream.pipe(res);

        readStream.on('error', (error) => {
            console.error('Error streaming file:', error);
            if (!res.headersSent) {
                res.status(500).json({ 
                    error: 'Failed to download file',
                    details: error.message 
                });
            }
        });

    } catch (error) {
        console.error('Error downloading file:', error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        if (error.message.includes('not found') || error.message.includes('ENOENT')) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        res.status(500).json({ 
            error: 'Failed to download file',
            details: error.message 
        });
    }
};

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
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { path: filePath } = req.query;
        
        if (!filePath) {
            return res.status(400).json({
                error: 'path parameter is required'
            });
        }

        const content = await readFileContent(filePath);
        const itemInfo = await getItemInfo(filePath);

        res.json({
            content: content,
            file_info: itemInfo,
            encoding: 'utf8',
            size_bytes: Buffer.byteLength(content, 'utf8')
        });

    } catch (error) {
        console.error('Error reading file:', error);
        
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
        
        res.status(500).json({ 
            error: 'Failed to read file',
            details: error.message 
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
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { path: filePath, content, backup = false, uid, gid, mode } = req.body;
        
        if (!filePath || content === undefined) {
            return res.status(400).json({
                error: 'path and content are required'
            });
        }

        const options = { backup };
        if (uid !== undefined) options.uid = uid;
        if (gid !== undefined) options.gid = gid;
        if (mode !== undefined) options.mode = parseInt(mode, 8);

        await writeFileContent(filePath, content, options);
        
        const itemInfo = await getItemInfo(filePath);

        res.json({
            success: true,
            message: `File written successfully${backup ? ' (backup created)' : ''}`,
            file_info: itemInfo,
            content_size: Buffer.byteLength(content, 'utf8')
        });

    } catch (error) {
        console.error('Error writing file:', error);
        
        if (error.message.includes('exceeds edit limit')) {
            return res.status(400).json({ error: error.message });
        }
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to write file',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /filesystem/move:
 *   put:
 *     summary: Move or rename item
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
 *               - source
 *               - destination
 *             properties:
 *               source:
 *                 type: string
 *                 description: Source path
 *                 example: "/home/user/file.txt"
 *               destination:
 *                 type: string
 *                 description: Destination path
 *                 example: "/home/user/renamed.txt"
 *     responses:
 *       202:
 *         description: Move task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create move task
 */
export const moveFileItem = async (req, res) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { source, destination } = req.body;
        
        if (!source || !destination) {
            return res.status(400).json({
                error: 'source and destination are required'
            });
        }

        // Create task for move operation (async for large files/directories)
        const task = await Tasks.create({
            zone_name: 'filesystem',
            operation: 'file_move',
            priority: TaskPriority.MEDIUM,
            created_by: req.entity.name,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    source: source,
                    destination: destination
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Move task created for '${path.basename(source)}'`,
            task_id: task.id,
            source: source,
            destination: destination
        });

    } catch (error) {
        console.error('Error creating move task:', error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to create move task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /filesystem/copy:
 *   post:
 *     summary: Copy item
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
 *               - source
 *               - destination
 *             properties:
 *               source:
 *                 type: string
 *                 description: Source path
 *                 example: "/home/user/file.txt"
 *               destination:
 *                 type: string
 *                 description: Destination path
 *                 example: "/home/user/file_copy.txt"
 *     responses:
 *       202:
 *         description: Copy task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create copy task
 */
export const copyFileItem = async (req, res) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { source, destination } = req.body;
        
        if (!source || !destination) {
            return res.status(400).json({
                error: 'source and destination are required'
            });
        }

        // Create task for copy operation (async for large files/directories)
        const task = await Tasks.create({
            zone_name: 'filesystem',
            operation: 'file_copy',
            priority: TaskPriority.MEDIUM,
            created_by: req.entity.name,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    source: source,
                    destination: destination
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Copy task created for '${path.basename(source)}'`,
            task_id: task.id,
            source: source,
            destination: destination
        });

    } catch (error) {
        console.error('Error creating copy task:', error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to create copy task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /filesystem/rename:
 *   patch:
 *     summary: Rename item
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
 *               - new_name
 *             properties:
 *               path:
 *                 type: string
 *                 description: Current item path
 *                 example: "/home/user/old_name.txt"
 *               new_name:
 *                 type: string
 *                 description: New name for the item
 *                 example: "new_name.txt"
 *     responses:
 *       200:
 *         description: Item renamed successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       409:
 *         description: Target name already exists
 *       500:
 *         description: Failed to rename item
 */
export const renameItem = async (req, res) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { path: itemPath, new_name } = req.body;
        
        if (!itemPath || !new_name) {
            return res.status(400).json({
                error: 'path and new_name are required'
            });
        }

        // Sanitize new name
        const sanitizedName = new_name.replace(/[^a-zA-Z0-9._-]/g, '_');
        if (sanitizedName !== new_name) {
            console.warn(`Sanitized filename from '${new_name}' to '${sanitizedName}'`);
        }

        const parentDir = path.dirname(itemPath);
        const newPath = path.join(parentDir, sanitizedName);

        await moveItem(itemPath, newPath);
        
        const itemInfo = await getItemInfo(newPath);

        res.json({
            success: true,
            message: `Item renamed to '${sanitizedName}' successfully`,
            item: itemInfo,
            old_path: itemPath,
            new_path: newPath
        });

    } catch (error) {
        console.error('Error renaming item:', error);
        
        if (error.message.includes('already exists')) {
            return res.status(409).json({ error: error.message });
        }
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to rename item',
            details: error.message 
        });
    }
};

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
                error: 'File browser is disabled'
            });
        }

        const { path: itemPath, recursive = false, force = false } = req.body;
        
        if (!itemPath) {
            requestLogger.error(400, 'Path required');
            return res.status(400).json({
                error: 'path is required'
            });
        }

        log.filesystem.info('File deletion started', {
            requestId,
            path: itemPath,
            recursive: recursive,
            force: force,
            user: req.entity.name
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
                size: stats.isDirectory() ? null : stats.size
            };
            
            log.filesystem.debug('Item info retrieved', {
                requestId,
                name: itemInfo.name,
                isDirectory: itemInfo.isDirectory,
                size: itemInfo.size
            });
        } catch (infoError) {
            log.filesystem.warn('Could not stat file before deletion', {
                requestId,
                path: itemPath,
                error: infoError.message
            });
            itemInfo = { 
                name: path.basename(itemPath), 
                isDirectory: false, 
                path: itemPath,
                size: null
            };
        }
        
        // Perform the actual deletion immediately
        await deleteItem(itemPath, { recursive, force });

        const duration = timer.end({
            itemName: itemInfo.name,
            itemType: itemInfo.isDirectory ? 'directory' : 'file',
            size: itemInfo.size
        });

        log.filesystem.info('File deletion completed', {
            requestId,
            path: itemPath,
            itemName: itemInfo.name,
            itemType: itemInfo.isDirectory ? 'directory' : 'file',
            size: itemInfo.size,
            recursive: recursive,
            force: force,
            duration_ms: duration
        });

        const response = {
            success: true,
            message: `${itemInfo.isDirectory ? 'Directory' : 'File'} '${itemInfo.name}' deleted successfully`,
            deleted_item: itemInfo
        };

        requestLogger.success(200, {
            itemName: itemInfo.name,
            itemType: itemInfo.isDirectory ? 'directory' : 'file',
            size: itemInfo.size
        });

        res.json(response);

    } catch (error) {
        timer.end({ error: error.message });
        log.filesystem.error('File deletion failed', {
            requestId,
            path: req.body.path,
            error: error.message,
            stack: error.stack
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
        res.status(500).json({ 
            error: 'Failed to delete item',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /filesystem/archive/create:
 *   post:
 *     summary: Create archive
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
 *               - sources
 *               - archive_path
 *               - format
 *             properties:
 *               sources:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Array of source paths to archive
 *                 example: ["/home/user/file1.txt", "/home/user/folder"]
 *               archive_path:
 *                 type: string
 *                 description: Destination archive file path
 *                 example: "/home/user/backup.tar.gz"
 *               format:
 *                 type: string
 *                 enum: [zip, tar, tar.gz, tar.bz2, gz]
 *                 description: Archive format
 *     responses:
 *       202:
 *         description: Archive creation task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create archive task
 */
export const createArchiveTask = async (req, res) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled || !fileBrowserConfig.archive?.enabled) {
            return res.status(503).json({
                error: 'Archive operations are disabled'
            });
        }

        const { sources, archive_path, format } = req.body;
        
        if (!sources || !Array.isArray(sources) || sources.length === 0) {
            return res.status(400).json({
                error: 'sources array is required and must not be empty'
            });
        }

        if (!archive_path || !format) {
            return res.status(400).json({
                error: 'archive_path and format are required'
            });
        }

        // Create task for archive creation (async operation)
        const task = await Tasks.create({
            zone_name: 'filesystem',
            operation: 'file_archive_create',
            priority: TaskPriority.LOW,
            created_by: req.entity.name,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    sources: sources,
                    archive_path: archive_path,
                    format: format
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Archive creation task created for ${sources.length} items`,
            task_id: task.id,
            sources: sources,
            archive_path: archive_path,
            format: format
        });

    } catch (error) {
        console.error('Error creating archive task:', error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to create archive task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /filesystem/archive/extract:
 *   post:
 *     summary: Extract archive
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
 *               - archive_path
 *               - extract_path
 *             properties:
 *               archive_path:
 *                 type: string
 *                 description: Archive file path to extract
 *                 example: "/home/user/backup.tar.gz"
 *               extract_path:
 *                 type: string
 *                 description: Directory to extract files into
 *                 example: "/home/user/extracted"
 *     responses:
 *       202:
 *         description: Archive extraction task created successfully
 *       400:
 *         description: Invalid request
 *       403:
 *         description: Access forbidden
 *       500:
 *         description: Failed to create extraction task
 */
export const extractArchiveTask = async (req, res) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled || !fileBrowserConfig.archive?.enabled) {
            return res.status(503).json({
                error: 'Archive operations are disabled'
            });
        }

        const { archive_path, extract_path } = req.body;
        
        if (!archive_path || !extract_path) {
            return res.status(400).json({
                error: 'archive_path and extract_path are required'
            });
        }

        // Create task for archive extraction (async operation)
        const task = await Tasks.create({
            zone_name: 'filesystem',
            operation: 'file_archive_extract',
            priority: TaskPriority.LOW,
            created_by: req.entity.name,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    archive_path: archive_path,
                    extract_path: extract_path
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Archive extraction task created for '${path.basename(archive_path)}'`,
            task_id: task.id,
            archive_path: archive_path,
            extract_path: extract_path
        });

    } catch (error) {
        console.error('Error creating extraction task:', error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        res.status(500).json({ 
            error: 'Failed to create extraction task',
            details: error.message 
        });
    }
};

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
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser is disabled'
            });
        }

        const { path: itemPath, uid, gid, mode, recursive = false } = req.body;
        
        if (!itemPath) {
            return res.status(400).json({
                error: 'path is required'
            });
        }

        if (uid === undefined && gid === undefined && mode === undefined) {
            return res.status(400).json({
                error: 'At least one of uid, gid, or mode must be specified'
            });
        }

        console.log(`🔧 [CHMOD] Permission change request:`, {
            path: itemPath,
            uid: uid,
            gid: gid,
            mode: mode,
            recursive: recursive,
            user: req.entity.name
        });

        const validation = validatePath(itemPath);
        if (!validation.valid) {
            return res.status(403).json({ error: validation.error });
        }

        const normalizedPath = validation.normalizedPath;
        const { executeCommand } = await import('../lib/FileSystemManager.js');

        // Change ownership if specified
        if (uid !== undefined || gid !== undefined) {
            let chownCommand = `pfexec chown`;
            if (recursive) chownCommand += ` -R`;
            
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
            if (recursive) chmodCommand += ` -R`;
            chmodCommand += ` ${mode} "${normalizedPath}"`;
            
            const chmodResult = await executeCommand(chmodCommand);
            if (!chmodResult.success) {
                throw new Error(`Failed to change permissions: ${chmodResult.error}`);
            }
        }

        // Get updated item info
        const itemInfo = await getItemInfo(itemPath);

        console.log(`✅ [CHMOD] Successfully changed permissions for: ${itemPath}`);

        res.json({
            success: true,
            message: `Permissions updated successfully for '${itemInfo.name}'`,
            item: itemInfo,
            changes_applied: {
                uid: uid,
                gid: gid, 
                mode: mode,
                recursive: recursive
            }
        });

    } catch (error) {
        console.error(`❌ [CHMOD] Error changing permissions:`, error);
        
        if (error.message.includes('forbidden') || error.message.includes('not allowed')) {
            return res.status(403).json({ error: error.message });
        }
        
        if (error.message.includes('not found') || error.message.includes('ENOENT')) {
            return res.status(404).json({ error: 'File not found' });
        }
        
        res.status(500).json({ 
            error: 'Failed to update permissions',
            details: error.message 
        });
    }
};
