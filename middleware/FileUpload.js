/**
 * @fileoverview File Upload Middleware for Zoneweaver API
 * @description Handles file uploads with security validation and size limits using multer
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import config from '../config/ConfigLoader.js';
import { validatePath } from '../lib/FileSystemManager.js';

/**
 * Storage configuration for multer
 */
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            const fileBrowserConfig = config.getFileBrowser();
            
            if (!fileBrowserConfig?.enabled) {
                return cb(new Error('File browser is disabled'), false);
            }
            
            // Get upload path from request body
            let uploadPath = req.body.uploadPath || req.query.path || '/tmp';
            
            // Validate the upload path
            const validation = validatePath(uploadPath);
            if (!validation.valid) {
                return cb(new Error(`Invalid upload path: ${validation.error}`), false);
            }
            
            const destinationPath = validation.normalizedPath;
            
            // Check if destination exists and is a directory
            if (!fs.existsSync(destinationPath)) {
                return cb(new Error('Upload destination does not exist'), false);
            }
            
            const stats = fs.statSync(destinationPath);
            if (!stats.isDirectory()) {
                return cb(new Error('Upload destination is not a directory'), false);
            }
            
            // Check if file already exists
            const fullFilePath = path.join(destinationPath, file.originalname);
            if (fs.existsSync(fullFilePath) && req.body.overwrite !== 'true') {
                return cb(new multer.MulterError('File already exists! Use overwrite=true to replace.', 'FILE_EXISTS'), false);
            }
            
            cb(null, destinationPath);
            
        } catch (error) {
            cb(new Error(`Upload destination error: ${error.message}`), false);
        }
    },
    
    filename: (req, file, cb) => {
        // Use original filename, but sanitize it
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, sanitizedName);
    }
});

/**
 * File filter function
 */
const fileFilter = (req, file, cb) => {
    try {
        const fileBrowserConfig = config.getFileBrowser();
        
        if (!fileBrowserConfig?.enabled) {
            return cb(new Error('File browser is disabled'), false);
        }
        
        // For now, allow all file types - the frontend can implement restrictions
        // In the future, we could add file type restrictions here based on config
        cb(null, true);
        
    } catch (error) {
        cb(new Error(`File filter error: ${error.message}`), false);
    }
};

/**
 * Create multer instance with configuration
 */
const createUploadMiddleware = () => {
    const fileBrowserConfig = config.getFileBrowser();
    
    if (!fileBrowserConfig?.enabled) {
        throw new Error('File browser is disabled');
    }
    
    // Convert GB to bytes
    const maxSizeBytes = fileBrowserConfig.upload_size_limit_gb * 1024 * 1024 * 1024;
    
    return multer({
        storage: storage,
        fileFilter: fileFilter,
        limits: {
            fileSize: maxSizeBytes,
            fieldSize: 10 * 1024 * 1024, // 10MB for form fields
            fields: 20, // Maximum number of non-file fields
            files: 10,  // Maximum number of files
            parts: 30   // Maximum number of parts (fields + files)
        },
        // Preserve file extensions and handle errors gracefully
        preservePath: false
    });
};

/**
 * Error handler for multer errors
 */
export const handleUploadError = (error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        switch (error.code) {
            case 'LIMIT_FILE_SIZE':
                const fileBrowserConfig = config.getFileBrowser();
                const limitGB = fileBrowserConfig?.upload_size_limit_gb || 50;
                return res.status(413).json({
                    error: 'File too large',
                    message: `File size exceeds the ${limitGB}GB limit`,
                    code: 'FILE_TOO_LARGE'
                });
                
            case 'LIMIT_FILE_COUNT':
                return res.status(413).json({
                    error: 'Too many files',
                    message: 'Maximum of 10 files can be uploaded at once',
                    code: 'TOO_MANY_FILES'
                });
                
            case 'LIMIT_UNEXPECTED_FILE':
                return res.status(400).json({
                    error: 'Unexpected file field',
                    message: 'Unexpected file field in upload',
                    code: 'UNEXPECTED_FIELD'
                });
                
            case 'FILE_EXISTS':
                return res.status(409).json({
                    error: 'File already exists',
                    message: 'A file with this name already exists. Use overwrite=true to replace it.',
                    code: 'FILE_EXISTS'
                });
                
            default:
                return res.status(400).json({
                    error: 'Upload error',
                    message: error.message,
                    code: error.code
                });
        }
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
 * Process file upload and save to destination (for multer compatibility)
 * @param {Object} file - Multer file object
 * @param {string} uploadPath - Destination path (already handled by multer storage)
 * @param {boolean} overwrite - Whether to overwrite existing files (already handled by multer)
 * @returns {Promise<Object>} Upload result
 */
export const saveUploadedFile = async (file, uploadPath, overwrite = false) => {
    try {
        return {
            success: true,
            filename: file.filename,
            path: file.path,
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
    const upload = createUploadMiddleware();
    return upload.single(fieldName);
};

/**
 * Multiple files upload middleware
 */
export const uploadMultiple = (fieldName = 'files', maxCount = 10) => {
    const upload = createUploadMiddleware();
    return upload.array(fieldName, maxCount);
};

/**
 * Fields upload middleware (mixed form data)
 */
export const uploadFields = (fields) => {
    const upload = createUploadMiddleware();
    return upload.fields(fields);
};

export default {
    uploadSingle,
    uploadMultiple,
    uploadFields,
    validateUploadRequest,
    handleUploadError,
    saveUploadedFile
};
