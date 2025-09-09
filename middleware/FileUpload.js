/**
 * @fileoverview File Upload Middleware for Zoneweaver API
 * @description Handles file uploads with security validation and size limits using built-in Node.js functionality
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import config from '../config/ConfigLoader.js';
import { validatePath } from '../lib/FileSystemManager.js';

/**
 * Parse multipart form data manually
 * @param {Object} req - Express request object
 * @returns {Promise<{fields: Object, files: Array}>} Parsed form data
 */
const parseFormData = (req) => {
    return new Promise((resolve, reject) => {
        const fileBrowserConfig = config.getFileBrowser();
        const maxSizeBytes = fileBrowserConfig.upload_size_limit_gb * 1024 * 1024 * 1024;
        
        const fields = {};
        const files = [];
        let totalSize = 0;
        
        const contentType = req.headers['content-type'];
        if (!contentType || !contentType.includes('multipart/form-data')) {
            return reject(new Error('Content-Type must be multipart/form-data'));
        }
        
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
            return reject(new Error('Missing boundary in Content-Type'));
        }
        
        let buffer = Buffer.alloc(0);
        const boundaryBuffer = Buffer.from(`--${boundary}`);
        const endBoundaryBuffer = Buffer.from(`--${boundary}--`);
        
        req.on('data', (chunk) => {
            totalSize += chunk.length;
            if (totalSize > maxSizeBytes) {
                return reject(new Error(`File size exceeds ${fileBrowserConfig.upload_size_limit_gb}GB limit`));
            }
            buffer = Buffer.concat([buffer, chunk]);
        });
        
        req.on('end', () => {
            try {
                const parts = [];
                let start = 0;
                
                // Find all boundary positions
                while (true) {
                    const boundaryPos = buffer.indexOf(boundaryBuffer, start);
                    if (boundaryPos === -1) break;
                    
                    if (start > 0) {
                        parts.push(buffer.slice(start, boundaryPos));
                    }
                    start = boundaryPos + boundaryBuffer.length;
                }
                
                // Process each part
                for (const part of parts) {
                    if (part.length < 4) continue;
                    
                    // Find the double CRLF that separates headers from content
                    const headerEndPos = part.indexOf('\r\n\r\n');
                    if (headerEndPos === -1) continue;
                    
                    const headerSection = part.slice(0, headerEndPos).toString();
                    const contentSection = part.slice(headerEndPos + 4);
                    
                    // Parse Content-Disposition header
                    const dispositionMatch = headerSection.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/);
                    if (!dispositionMatch) continue;
                    
                    const fieldName = dispositionMatch[1];
                    const filename = dispositionMatch[2];
                    
                    if (filename !== undefined) {
                        // This is a file field
                        const contentTypeMatch = headerSection.match(/Content-Type:\s*([^\r\n]+)/);
                        const mimeType = contentTypeMatch ? contentTypeMatch[1] : 'application/octet-stream';
                        
                        files.push({
                            fieldname: fieldName,
                            originalname: filename,
                            mimetype: mimeType,
                            buffer: contentSection.slice(0, -2), // Remove trailing CRLF
                            size: contentSection.length - 2
                        });
                    } else {
                        // This is a regular field
                        fields[fieldName] = contentSection.slice(0, -2).toString(); // Remove trailing CRLF
                    }
                }
                
                resolve({ fields, files });
            } catch (error) {
                reject(new Error(`Failed to parse form data: ${error.message}`));
            }
        });
        
        req.on('error', reject);
    });
};

/**
 * Error handler for upload errors
 */
export const handleUploadError = (error, req, res, next) => {
    if (error.message.includes('File size exceeds')) {
        const fileBrowserConfig = config.getFileBrowser();
        const limitGB = fileBrowserConfig?.upload_size_limit_gb || 50;
        return res.status(413).json({
            error: 'File too large',
            message: `File size exceeds the ${limitGB}GB limit`,
            code: 'FILE_TOO_LARGE'
        });
    }
    
    if (error.message.includes('File already exists')) {
        return res.status(409).json({
            error: 'File already exists',
            message: 'A file with this name already exists. Use overwrite=true to replace it.',
            code: 'FILE_EXISTS'
        });
    }
    
    // Handle custom errors
    if (error.message) {
        return res.status(400).json({
            error: 'Upload failed',
            message: error.message
        });
    }
    
    // Pass other errors to the next handler
    next(error);
};

/**
 * Middleware to validate upload request
 */
export const validateUploadRequest = (req, res, next) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return res.status(503).json({
                error: 'File browser disabled',
                message: 'File browser functionality is disabled'
            });
        }
        
        // Validate required authentication
        if (!req.entity) {
            return res.status(401).json({
                error: 'Authentication required',
                message: 'Valid API key required for file uploads'
            });
        }
        
        next();
        
    } catch (error) {
        return res.status(500).json({
            error: 'Validation failed',
            message: error.message
        });
    }
};

/**
 * Process file upload and save to destination
 * @param {Object} file - File object from form data
 * @param {string} uploadPath - Destination path
 * @param {boolean} overwrite - Whether to overwrite existing files
 * @returns {Promise<Object>} Upload result
 */
export const saveUploadedFile = async (file, uploadPath, overwrite = false) => {
    try {
        // Validate the upload path
        const validation = validatePath(uploadPath);
        if (!validation.valid) {
            throw new Error(`Invalid upload path: ${validation.error}`);
        }
        
        const destinationPath = validation.normalizedPath;
        
        // Check if destination exists and is a directory
        if (!fsSync.existsSync(destinationPath)) {
            throw new Error('Upload destination does not exist');
        }
        
        const stats = fsSync.statSync(destinationPath);
        if (!stats.isDirectory()) {
            throw new Error('Upload destination is not a directory');
        }
        
        // Sanitize filename
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        const fullFilePath = path.join(destinationPath, sanitizedName);
        
        // Check if file already exists
        if (fsSync.existsSync(fullFilePath) && !overwrite) {
            throw new Error('File already exists! Use overwrite=true to replace.');
        }
        
        // Write file to disk
        await fs.writeFile(fullFilePath, file.buffer);
        
        return {
            success: true,
            filename: sanitizedName,
            path: fullFilePath,
            size: file.size,
            mimetype: file.mimetype
        };
        
    } catch (error) {
        throw new Error(`Failed to save file: ${error.message}`);
    }
};

/**
 * Single file upload middleware
 */
export const uploadSingle = (fieldName = 'file') => {
    return async (req, res, next) => {
        try {
            const { fields, files } = await parseFormData(req);
            
            // Add fields to request body
            Object.assign(req.body, fields);
            
            // Find the specified file
            const file = files.find(f => f.fieldname === fieldName);
            if (!file) {
                return res.status(400).json({
                    error: 'No file uploaded',
                    message: `Expected file field: ${fieldName}`
                });
            }
            
            // Add file to request
            req.file = file;
            next();
            
        } catch (error) {
            handleUploadError(error, req, res, next);
        }
    };
};

/**
 * Multiple files upload middleware
 */
export const uploadMultiple = (fieldName = 'files', maxCount = 10) => {
    return async (req, res, next) => {
        try {
            const { fields, files } = await parseFormData(req);
            
            // Add fields to request body
            Object.assign(req.body, fields);
            
            // Filter files by field name
            const fieldFiles = files.filter(f => f.fieldname === fieldName);
            
            if (fieldFiles.length === 0) {
                return res.status(400).json({
                    error: 'No files uploaded',
                    message: `Expected files field: ${fieldName}`
                });
            }
            
            if (fieldFiles.length > maxCount) {
                return res.status(400).json({
                    error: 'Too many files',
                    message: `Maximum of ${maxCount} files allowed`
                });
            }
            
            // Add files to request
            req.files = fieldFiles;
            next();
            
        } catch (error) {
            handleUploadError(error, req, res, next);
        }
    };
};

/**
 * Fields upload middleware (mixed form data)
 */
export const uploadFields = (fieldConfigs) => {
    return async (req, res, next) => {
        try {
            const { fields, files } = await parseFormData(req);
            
            // Add fields to request body
            Object.assign(req.body, fields);
            
            // Group files by field name
            const groupedFiles = {};
            
            for (const config of fieldConfigs) {
                const fieldName = config.name;
                const maxCount = config.maxCount || 1;
                const fieldFiles = files.filter(f => f.fieldname === fieldName);
                
                if (fieldFiles.length > maxCount) {
                    return res.status(400).json({
                        error: 'Too many files',
                        message: `Maximum of ${maxCount} files allowed for field ${fieldName}`
                    });
                }
                
                if (maxCount === 1) {
                    groupedFiles[fieldName] = fieldFiles[0] || null;
                } else {
                    groupedFiles[fieldName] = fieldFiles;
                }
            }
            
            // Add files to request
            req.files = groupedFiles;
            next();
            
        } catch (error) {
            handleUploadError(error, req, res, next);
        }
    };
};

export default {
    uploadSingle,
    uploadMultiple,
    uploadFields,
    validateUploadRequest,
    handleUploadError,
    saveUploadedFile
};
