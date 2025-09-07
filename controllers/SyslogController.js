/**
 * @fileoverview Syslog Configuration Controller for Zoneweaver API
 * @description Provides API endpoints for managing syslog configuration
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from "child_process";
import util from "util";
import fs from "fs/promises";
import config from "../config/ConfigLoader.js";

const execProm = util.promisify(exec);

/**
 * @swagger
 * /system/syslog/config:
 *   get:
 *     summary: Get syslog configuration
 *     description: Returns current syslog.conf configuration
 *     tags: [Syslog Management]
 *     responses:
 *       200:
 *         description: Syslog configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 config_content:
 *                   type: string
 *                 parsed_rules:
 *                   type: array
 *                 service_status:
 *                   type: object
 *                 config_file:
 *                   type: string
 *       500:
 *         description: Failed to get syslog configuration
 */
export const getSyslogConfig = async (req, res) => {
    try {
        const logsConfig = config.getSystemLogs();
        
        if (!logsConfig?.enabled) {
            return res.status(503).json({
                error: 'System logs are disabled in configuration'
            });
        }

        const configFile = '/etc/syslog.conf';

        // Read current configuration
        let configContent = '';
        let configExists = false;
        
        try {
            configContent = await fs.readFile(configFile, 'utf8');
            configExists = true;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error; // Re-throw if it's not a "file not found" error
            }
        }

        // Get syslog service status
        const { stdout: serviceStatus } = await execProm('svcs -l svc:/system/system-log:default', {
            timeout: 10000
        });

        // Parse configuration into structured rules
        const parsedRules = parseSyslogConfig(configContent);

        res.json({
            config_content: configContent,
            parsed_rules: parsedRules,
            config_exists: configExists,
            config_file: configFile,
            service_status: parseServiceStatus(serviceStatus),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error getting syslog configuration:', error);
        res.status(500).json({ 
            error: 'Failed to get syslog configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/syslog/config:
 *   put:
 *     summary: Update syslog configuration
 *     description: Updates syslog.conf and reloads the service
 *     tags: [Syslog Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config_content:
 *                 type: string
 *                 description: Complete syslog.conf content
 *               backup_existing:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup of existing config
 *               reload_service:
 *                 type: boolean
 *                 default: true
 *                 description: Reload syslog service after update
 *     responses:
 *       200:
 *         description: Syslog configuration updated successfully
 *       400:
 *         description: Invalid configuration content
 *       500:
 *         description: Failed to update syslog configuration
 */
export const updateSyslogConfig = async (req, res) => {
    try {
        const { config_content, backup_existing = true, reload_service = true } = req.body;
        const logsConfig = config.getSystemLogs();
        
        if (!logsConfig?.enabled) {
            return res.status(503).json({
                error: 'System logs are disabled in configuration'
            });
        }

        if (!config_content || typeof config_content !== 'string') {
            return res.status(400).json({
                error: 'config_content is required and must be a string'
            });
        }

        // Validate configuration syntax
        const validationResult = validateSyslogConfig(config_content);
        if (!validationResult.valid) {
            return res.status(400).json({
                error: 'Invalid syslog configuration',
                details: validationResult.errors
            });
        }

        const configFile = '/etc/syslog.conf';
        const results = {
            backup_created: false,
            config_updated: false,
            service_reloaded: false,
            warnings: []
        };

        // Create backup if requested and file exists
        if (backup_existing) {
            try {
                await fs.access(configFile);
                const backupFile = `${configFile}.backup.${Date.now()}`;
                await execProm(`pfexec cp "${configFile}" "${backupFile}"`);
                results.backup_created = true;
                results.backup_file = backupFile;
            } catch (error) {
                if (error.code !== 'ENOENT') {
                    results.warnings.push(`Failed to create backup: ${error.message}`);
                }
            }
        }

        // Write new configuration
        const tempFile = `/tmp/syslog.conf.tmp.${Date.now()}`;
        await fs.writeFile(tempFile, config_content, 'utf8');
        
        // Move to final location with proper permissions
        await execProm(`pfexec mv "${tempFile}" "${configFile}"`);
        await execProm(`pfexec chmod 644 "${configFile}"`);
        
        results.config_updated = true;

        // Reload syslog service if requested
        if (reload_service) {
            try {
                const { stdout, stderr } = await execProm('pfexec svcadm restart svc:/system/system-log:default', {
                    timeout: 30000
                });
                results.service_reloaded = true;
                if (stderr) results.warnings.push(`Service restart stderr: ${stderr}`);
            } catch (error) {
                results.warnings.push(`Failed to reload syslog service: ${error.message}`);
            }
        }

        res.json({
            success: true,
            message: 'Syslog configuration updated successfully',
            results: results,
            parsed_rules: parseSyslogConfig(config_content),
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error updating syslog configuration:', error);
        res.status(500).json({ 
            error: 'Failed to update syslog configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/syslog/facilities:
 *   get:
 *     summary: Get available syslog facilities and levels
 *     description: Returns list of available syslog facilities and severity levels
 *     tags: [Syslog Management]
 *     responses:
 *       200:
 *         description: Available facilities and levels
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 facilities:
 *                   type: array
 *                 levels:
 *                   type: array
 *       500:
 *         description: Failed to get facilities
 */
export const getSyslogFacilities = async (req, res) => {
    try {
        const facilities = [
            { name: 'kern', description: 'Messages generated by the kernel' },
            { name: 'user', description: 'Messages generated by user processes (default)' },
            { name: 'mail', description: 'The mail system' },
            { name: 'daemon', description: 'Various system daemons' },
            { name: 'auth', description: 'The authorization system (login, su, getty)' },
            { name: 'lpr', description: 'Line printer spooling system' },
            { name: 'news', description: 'USENET network news system' },
            { name: 'uucp', description: 'UUCP system' },
            { name: 'altcron', description: 'BSD cron/at system' },
            { name: 'authpriv', description: 'BSD security/authorization system' },
            { name: 'ftp', description: 'File transfer system' },
            { name: 'ntp', description: 'Network time system' },
            { name: 'audit', description: 'Audit messages' },
            { name: 'console', description: 'BSD console system' },
            { name: 'cron', description: 'Cron/at messages' },
            { name: 'local0', description: 'Local use facility 0' },
            { name: 'local1', description: 'Local use facility 1' },
            { name: 'local2', description: 'Local use facility 2' },
            { name: 'local3', description: 'Local use facility 3' },
            { name: 'local4', description: 'Local use facility 4' },
            { name: 'local5', description: 'Local use facility 5' },
            { name: 'local6', description: 'Local use facility 6' },
            { name: 'local7', description: 'Local use facility 7' },
            { name: 'mark', description: 'Timestamp messages (internal)' },
            { name: '*', description: 'All facilities except mark' }
        ];

        const levels = [
            { name: 'emerg', value: 0, description: 'Panic conditions broadcast to all users' },
            { name: 'alert', value: 1, description: 'Conditions requiring immediate correction' },
            { name: 'crit', value: 2, description: 'Critical conditions (hard device errors)' },
            { name: 'err', value: 3, description: 'Other errors' },
            { name: 'warning', value: 4, description: 'Warning messages' },
            { name: 'notice', value: 5, description: 'Conditions requiring special handling' },
            { name: 'info', value: 6, description: 'Informational messages' },
            { name: 'debug', value: 7, description: 'Debug messages' },
            { name: 'none', value: -1, description: 'Do not log messages from this facility' }
        ];

        res.json({
            facilities: facilities,
            levels: levels,
            example_rules: [
                '*.notice\t\t\t/var/log/notice',
                'mail.info\t\t\t/var/log/maillog',
                '*.crit\t\t\t\t/var/log/critical',
                'kern.err\t\t\t@loghost',
                '*.emerg\t\t\t\t*',
                '*.alert\t\t\t\troot,operator'
            ],
            syntax_notes: [
                'Use TAB to separate selector from action',
                'Multiple facilities: kern,mail.info',
                'Multiple selectors: *.notice;mail.none',
                'Actions: filename, @hostname, username, *'
            ],
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error getting syslog facilities:', error);
        res.status(500).json({ 
            error: 'Failed to get syslog facilities',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/syslog/validate:
 *   post:
 *     summary: Validate syslog configuration
 *     description: Validates syslog configuration without applying it
 *     tags: [Syslog Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config_content:
 *                 type: string
 *                 description: Syslog configuration to validate
 *     responses:
 *       200:
 *         description: Validation results
 *       400:
 *         description: Invalid configuration
 */
export const validateSyslogConfig = async (req, res) => {
    try {
        const { config_content } = req.body;

        if (!config_content || typeof config_content !== 'string') {
            return res.status(400).json({
                error: 'config_content is required and must be a string'
            });
        }

        const validationResult = validateSyslogConfig(config_content);

        res.json({
            valid: validationResult.valid,
            errors: validationResult.errors,
            warnings: validationResult.warnings,
            parsed_rules: validationResult.parsed_rules,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error validating syslog configuration:', error);
        res.status(500).json({ 
            error: 'Failed to validate syslog configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/syslog/reload:
 *   post:
 *     summary: Reload syslog service
 *     description: Reloads the syslog service to apply configuration changes
 *     tags: [Syslog Management]
 *     responses:
 *       200:
 *         description: Syslog service reloaded successfully
 *       500:
 *         description: Failed to reload syslog service
 */
export const reloadSyslogService = async (req, res) => {
    try {
        const logsConfig = config.getSystemLogs();
        
        if (!logsConfig?.enabled) {
            return res.status(503).json({
                error: 'System logs are disabled in configuration'
            });
        }

        // Restart syslog service to reload configuration
        const { stdout, stderr } = await execProm('pfexec svcadm restart svc:/system/system-log:default', {
            timeout: 30000
        });

        // Wait a moment and check service status
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const { stdout: statusOutput } = await execProm('svcs svc:/system/system-log:default');

        res.json({
            success: true,
            message: 'Syslog service reloaded successfully',
            service_status: statusOutput.trim(),
            stdout: stdout,
            stderr: stderr || null,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error reloading syslog service:', error);
        res.status(500).json({ 
            error: 'Failed to reload syslog service',
            details: error.message 
        });
    }
};

/**
 * Helper function to parse syslog configuration
 * @param {string} configContent - Syslog configuration content
 * @returns {Array} Parsed rules
 */
function parseSyslogConfig(configContent) {
    const rules = [];
    
    if (!configContent) return rules;

    const lines = configContent.split('\n');
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum].trim();
        
        // Skip empty lines and comments
        if (!line || line.startsWith('#')) continue;
        
        // Parse selector and action (separated by TAB or multiple spaces)
        const parts = line.split(/\t+|\s{2,}/);
        if (parts.length >= 2) {
            const selector = parts[0];
            const action = parts.slice(1).join(' ');
            
            rules.push({
                line_number: lineNum + 1,
                selector: selector,
                action: action,
                full_line: line,
                parsed: parseSelectorAndAction(selector, action)
            });
        } else {
            rules.push({
                line_number: lineNum + 1,
                full_line: line,
                error: 'Could not parse selector and action'
            });
        }
    }
    
    return rules;
}

/**
 * Helper function to parse selector and action
 * @param {string} selector - Selector part (e.g., "*.notice;mail.none")
 * @param {string} action - Action part (e.g., "/var/log/messages")
 * @returns {Object} Parsed selector and action
 */
function parseSelectorAndAction(selector, action) {
    const parsed = {
        selectors: [],
        action_type: 'unknown',
        action_target: action
    };
    
    // Parse selectors (semicolon separated)
    const selectorParts = selector.split(';');
    
    for (const part of selectorParts) {
        const trimmed = part.trim();
        if (trimmed.includes('.')) {
            const [facility, level] = trimmed.split('.');
            parsed.selectors.push({
                facility: facility,
                level: level
            });
        } else {
            parsed.selectors.push({
                facility: trimmed,
                level: null
            });
        }
    }
    
    // Determine action type
    if (action.startsWith('/')) {
        parsed.action_type = 'file';
    } else if (action.startsWith('@')) {
        parsed.action_type = 'remote_host';
        parsed.action_target = action.substring(1);
    } else if (action === '*') {
        parsed.action_type = 'all_users';
    } else if (action.includes(',')) {
        parsed.action_type = 'specific_users';
        parsed.action_target = action.split(',').map(u => u.trim());
    } else {
        parsed.action_type = 'user';
    }
    
    return parsed;
}

/**
 * Helper function to validate syslog configuration
 * @param {string} configContent - Configuration content to validate
 * @returns {Object} Validation result
 */
function validateSyslogConfig(configContent) {
    const errors = [];
    const warnings = [];
    const parsedRules = [];
    
    if (!configContent) {
        return { valid: true, errors, warnings, parsed_rules: parsedRules };
    }

    const lines = configContent.split('\n');
    const knownFacilities = [
        'kern', 'user', 'mail', 'daemon', 'auth', 'lpr', 'news', 'uucp',
        'altcron', 'authpriv', 'ftp', 'ntp', 'audit', 'console', 'cron',
        'local0', 'local1', 'local2', 'local3', 'local4', 'local5', 'local6', 'local7',
        'mark', '*'
    ];
    const knownLevels = ['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug', 'none'];
    
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
        const line = lines[lineNum].trim();
        
        // Skip empty lines and comments
        if (!line || line.startsWith('#')) continue;
        
        // Check for TAB separation
        if (!line.includes('\t') && !line.match(/\s{2,}/)) {
            warnings.push(`Line ${lineNum + 1}: Should use TAB to separate selector from action`);
        }
        
        // Parse rule
        const parts = line.split(/\t+|\s{2,}/);
        if (parts.length < 2) {
            errors.push(`Line ${lineNum + 1}: Missing action field`);
            continue;
        }
        
        const selector = parts[0];
        const action = parts.slice(1).join(' ');
        
        // Validate selectors
        const selectors = selector.split(';');
        for (const sel of selectors) {
            const trimmed = sel.trim();
            if (trimmed.includes('.')) {
                const [facility, level] = trimmed.split('.');
                
                if (!knownFacilities.includes(facility)) {
                    warnings.push(`Line ${lineNum + 1}: Unknown facility '${facility}'`);
                }
                
                if (!knownLevels.includes(level)) {
                    errors.push(`Line ${lineNum + 1}: Unknown level '${level}'`);
                }
            }
        }
        
        // Validate action
        if (action.startsWith('/')) {
            // File path - check if directory exists
            const dir = action.substring(0, action.lastIndexOf('/'));
            if (!dir) {
                warnings.push(`Line ${lineNum + 1}: File path should be absolute`);
            }
        } else if (action.startsWith('@')) {
            // Remote host
            const hostname = action.substring(1);
            if (!hostname) {
                errors.push(`Line ${lineNum + 1}: Remote host name required after @`);
            }
        } else if (action !== '*' && !action.match(/^[a-zA-Z][a-zA-Z0-9_,]*$/)) {
            warnings.push(`Line ${lineNum + 1}: Action '${action}' may not be valid`);
        }
        
        parsedRules.push(parseSelectorAndAction(selector, action));
    }
    
    return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
        warnings: warnings.length > 0 ? warnings : undefined,
        parsed_rules: parsedRules
    };
}

/**
 * Helper function to parse service status
 * @param {string} serviceOutput - Output from svcs -l command
 * @returns {Object} Parsed service status
 */
function parseServiceStatus(serviceOutput) {
    const status = {};
    const lines = serviceOutput.split('\n');
    
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes(':')) {
            const [key, value] = trimmed.split(':', 2);
            status[key.trim()] = value.trim();
        }
    }
    
    return status;
}

export default {
    getSyslogConfig,
    updateSyslogConfig,
    getSyslogFacilities,
    validateSyslogConfig,
    reloadSyslogService
};
