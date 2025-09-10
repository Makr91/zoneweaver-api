/**
 * @fileoverview Centralized Logging System for Zoneweaver API
 * @description Winston-based logging with daily rotation and compression
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import fs from 'fs';
import path from 'path';
import config from '../config/ConfigLoader.js';

// Get logging configuration (config is now loaded before Logger)
const loggingConfig = config.get('logging') || {
    level: 'info',
    console_enabled: true,
    log_directory: '/var/log/zoneweaver-api',
    file_rotation: { 
        max_size: '50m',        // Max size per file (can use k, m, g)
        max_files: '14d',       // Keep 14 days of logs
        compress: true,         // Compress archived logs
        date_pattern: 'YYYY-MM-DD' // Daily rotation pattern
    },
    performance_threshold_ms: 1000,
    categories: {}
};

// Ensure log directory exists
const logDir = loggingConfig.log_directory || '/var/log/zoneweaver-api';
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true, mode: 0o755 });
}

/**
 * Common log format configuration - optimized for production
 */
const logFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss.SSS'
    }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

/**
 * Console format for development - simplified
 */
const consoleFormat = winston.format.combine(
    winston.format.timestamp({
        format: 'HH:mm:ss'
    }),
    winston.format.colorize({ all: true }),
    winston.format.printf(({ level, message, timestamp, category, ...meta }) => {
        const categoryStr = category ? `[${category}]` : '';
        const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta, null, 0)}` : '';
        return `${timestamp} ${categoryStr} ${level}: ${message}${metaStr}`;
    })
);

/**
 * Create a logger for a specific category with daily rotation
 * @param {string} category - Log category name
 * @param {string} filename - Log filename (without extension)
 * @returns {winston.Logger} Configured winston logger
 */
const createCategoryLogger = (category, filename) => {
    const categoryLevel = loggingConfig.categories[category] || loggingConfig.level;
    const transports = [];
    
    // Category-specific daily rotating file transport
    transports.push(new DailyRotateFile({
        filename: path.join(logDir, `${filename}-%DATE%.log`),
        datePattern: loggingConfig.file_rotation.date_pattern || 'YYYY-MM-DD',
        level: categoryLevel,
        maxSize: loggingConfig.file_rotation.max_size || '50m',
        maxFiles: loggingConfig.file_rotation.max_files || '14d',
        zippedArchive: loggingConfig.file_rotation.compress !== false,
        format: logFormat,
        auditFile: path.join(logDir, `.${filename}-audit.json`), // Track rotation history
        createSymlink: true,  // Create symlink to current log file
        symlinkName: `${filename}.log` // Symlink name for easy access
    }));
    
    // All errors go to daily rotating error log
    transports.push(new DailyRotateFile({
        filename: path.join(logDir, 'error-%DATE%.log'),
        datePattern: loggingConfig.file_rotation.date_pattern || 'YYYY-MM-DD',
        level: 'error',
        maxSize: '50m',
        maxFiles: '30d', // Keep error logs for 30 days
        zippedArchive: true,
        format: logFormat,
        auditFile: path.join(logDir, '.error-audit.json'),
        createSymlink: true,
        symlinkName: 'error.log'
    }));
    
    // Console transport only if enabled and not in production
    if (loggingConfig.console_enabled && process.env.NODE_ENV !== 'production') {
        transports.push(new winston.transports.Console({
            level: categoryLevel,
            format: consoleFormat
        }));
    }
    
    return winston.createLogger({
        level: categoryLevel,
        format: logFormat,
        defaultMeta: { category, service: 'zoneweaver-api' },
        transports,
        exitOnError: false, // Don't exit on logging errors
        silent: loggingConfig.level === 'silent'
    });
};

/**
 * Category-specific loggers
 */
export const monitoringLogger = createCategoryLogger('monitoring', 'monitoring');
export const databaseLogger = createCategoryLogger('database', 'database');
export const apiRequestLogger = createCategoryLogger('api-request', 'api-requests');
export const filesystemLogger = createCategoryLogger('filesystem', 'filesystem');
export const taskLogger = createCategoryLogger('task', 'tasks');
export const authLogger = createCategoryLogger('auth', 'auth');
export const websocketLogger = createCategoryLogger('websocket', 'websocket');
export const performanceLogger = createCategoryLogger('performance', 'performance');

/**
 * General application logger with daily rotation
 */
export const appLogger = winston.createLogger({
    level: process.env.LOG_LEVEL || loggingConfig.level,
    format: logFormat,
    transports: [
        new DailyRotateFile({
            filename: path.join(logDir, 'application-%DATE%.log'),
            datePattern: loggingConfig.file_rotation.date_pattern || 'YYYY-MM-DD',
            maxSize: loggingConfig.file_rotation.max_size || '50m',
            maxFiles: loggingConfig.file_rotation.max_files || '14d',
            zippedArchive: loggingConfig.file_rotation.compress !== false,
            format: logFormat,
            auditFile: path.join(logDir, '.application-audit.json'),
            createSymlink: true,
            symlinkName: 'application.log'
        }),
        new DailyRotateFile({
            filename: path.join(logDir, 'error-%DATE%.log'),
            datePattern: loggingConfig.file_rotation.date_pattern || 'YYYY-MM-DD',
            level: 'error',
            maxSize: '50m',
            maxFiles: '30d',
            zippedArchive: true,
            format: logFormat,
            auditFile: path.join(logDir, '.error-audit.json'),
            createSymlink: true,
            symlinkName: 'error.log'
        })
    ],
    defaultMeta: { category: 'app', service: 'zoneweaver-api' },
    exitOnError: false
});

// Add console output for development
if (loggingConfig.console_enabled && process.env.NODE_ENV !== 'production') {
    appLogger.add(new winston.transports.Console({
        format: consoleFormat
    }));
}

/**
 * Helper function to safely log with fallback to console
 * @param {winston.Logger} logger - Winston logger instance
 * @param {string} level - Log level
 * @param {string} message - Log message
 * @param {Object} meta - Additional metadata
 */
const safeLog = (logger, level, message, meta = {}) => {
    try {
        logger[level](message, meta);
    } catch (error) {
        // Fallback to console if winston fails
        console[level] && console[level](`[${level.toUpperCase()}] ${message}`, meta);
    }
};

/**
 * Convenience logging functions for each category
 */
export const log = {
    monitoring: {
        info: (msg, meta) => safeLog(monitoringLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(monitoringLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(monitoringLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(monitoringLogger, 'debug', msg, meta)
    },
    
    database: {
        info: (msg, meta) => safeLog(databaseLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(databaseLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(databaseLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(databaseLogger, 'debug', msg, meta)
    },
    
    api: {
        info: (msg, meta) => safeLog(apiRequestLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(apiRequestLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(apiRequestLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(apiRequestLogger, 'debug', msg, meta)
    },
    
    filesystem: {
        info: (msg, meta) => safeLog(filesystemLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(filesystemLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(filesystemLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(filesystemLogger, 'debug', msg, meta)
    },
    
    task: {
        info: (msg, meta) => safeLog(taskLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(taskLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(taskLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(taskLogger, 'debug', msg, meta)
    },
    
    auth: {
        info: (msg, meta) => safeLog(authLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(authLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(authLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(authLogger, 'debug', msg, meta)
    },
    
    websocket: {
        info: (msg, meta) => safeLog(websocketLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(websocketLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(websocketLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(websocketLogger, 'debug', msg, meta)
    },
    
    performance: {
        info: (msg, meta) => safeLog(performanceLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(performanceLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(performanceLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(performanceLogger, 'debug', msg, meta)
    },
    
    app: {
        info: (msg, meta) => safeLog(appLogger, 'info', msg, meta),
        warn: (msg, meta) => safeLog(appLogger, 'warn', msg, meta),
        error: (msg, meta) => safeLog(appLogger, 'error', msg, meta),
        debug: (msg, meta) => safeLog(appLogger, 'debug', msg, meta)
    }
};

/**
 * Performance timing helper - optimized with threshold
 * @param {string} operation - Operation name
 * @returns {Object} Timer object with end() function
 */
export const createTimer = (operation) => {
    const start = process.hrtime.bigint();
    return {
        end: (meta = {}) => {
            const end = process.hrtime.bigint();
            const duration = Number(end - start) / 1000000; // Convert nanoseconds to milliseconds
            
            // Only log to performance category if exceeds threshold
            const thresholdMs = loggingConfig.performance_threshold_ms || 1000;
            if (duration >= thresholdMs) {
                performanceLogger.warn(`Slow operation detected: ${operation}`, {
                    operation,
                    duration_ms: Math.round(duration * 100) / 100, // Round to 2 decimal places
                    threshold_ms: thresholdMs,
                    ...meta
                });
            }
            
            return Math.round(duration * 100) / 100; // Return rounded duration
        }
    };
};

/**
 * Request logging middleware helper
 * @param {string} requestId - Unique request identifier
 * @param {Object} req - Express request object
 * @returns {Object} Request logger with timing
 */
export const createRequestLogger = (requestId, req) => {
    const start = Date.now();
    
    const logData = {
        requestId,
        method: req.method,
        path: req.path,
        user: req.entity?.name,
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('User-Agent')
    };
    
    apiRequestLogger.info('Request started', logData);
    
    return {
        success: (statusCode, meta = {}) => {
            const duration = Date.now() - start;
            apiRequestLogger.info('Request completed', {
                ...logData,
                status: statusCode,
                duration_ms: duration,
                success: true,
                ...meta
            });
        },
        
        error: (statusCode, error, meta = {}) => {
            const duration = Date.now() - start;
            apiRequestLogger.error('Request failed', {
                ...logData,
                status: statusCode,
                duration_ms: duration,
                success: false,
                error: error,
                ...meta
            });
        }
    };
};

export default {
    log,
    createTimer,
    createRequestLogger
};
