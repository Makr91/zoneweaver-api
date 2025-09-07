/**
 * @fileoverview Fault Management Controller for Zoneweaver API
 * @description Provides API endpoints for managing system faults via fmadm
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from "child_process";
import util from "util";
import os from "os";
import config from "../config/ConfigLoader.js";

const execProm = util.promisify(exec);

// Fault cache to store results for configured interval
let faultCache = {
    data: null,
    timestamp: null,
    isStale: true
};

/**
 * @swagger
 * /system/fault-management/faults:
 *   get:
 *     summary: Get system faults
 *     description: Returns current system faults from fmadm faulty
 *     tags: [Fault Management]
 *     parameters:
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include all faults (including resolved ones)
 *       - in: query
 *         name: summary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Return one-line summary format
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of faults to return
 *       - in: query
 *         name: force_refresh
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force refresh of cached data
 *     responses:
 *       200:
 *         description: System faults data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 faults:
 *                   type: array
 *                   items:
 *                     type: object
 *                 summary:
 *                   type: object
 *                 raw_output:
 *                   type: string
 *                 cached:
 *                   type: boolean
 *                 last_updated:
 *                   type: string
 *       500:
 *         description: Failed to get system faults
 */
export const getFaults = async (req, res) => {
    try {
        const { all = false, summary = false, limit = 50, force_refresh = false } = req.query;
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return res.status(503).json({
                error: 'Fault management is disabled in configuration'
            });
        }

        // Check cache validity
        const now = Date.now();
        const cacheAge = faultCache.timestamp ? (now - faultCache.timestamp) / 1000 : Infinity;
        const useCache = !force_refresh && faultCache.data && cacheAge < faultConfig.cache_interval;

        let faultData;
        
        if (useCache) {
            faultData = faultCache.data;
        } else {
            // Build fmadm command with options
            let command = 'pfexec fmadm faulty';
            if (all) command += ' -a';
            if (summary) command += ' -s';
            if (limit && limit < 50) command += ` -n ${limit}`;

            const { stdout, stderr } = await execProm(command, { 
                timeout: faultConfig.timeout * 1000 
            });

            if (stderr && stderr.trim()) {
                console.warn('fmadm faulty stderr:', stderr);
            }

            faultData = {
                raw_output: stdout,
                parsed_faults: parseFaultOutput(stdout),
                command_used: command,
                timestamp: new Date().toISOString()
            };

            // Update cache
            faultCache = {
                data: faultData,
                timestamp: now,
                isStale: false
            };
        }

        // Generate summary
        const faultsSummary = generateFaultsSummary(faultData.parsed_faults);

        res.json({
            faults: faultData.parsed_faults,
            summary: faultsSummary,
            raw_output: faultData.raw_output,
            cached: useCache,
            last_updated: faultData.timestamp,
            cache_age_seconds: useCache ? Math.floor(cacheAge) : 0
        });

    } catch (error) {
        console.error('Error getting system faults:', error);
        res.status(500).json({ 
            error: 'Failed to get system faults',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/fault-management/faults/{uuid}:
 *   get:
 *     summary: Get specific fault details
 *     description: Returns detailed information for a specific fault by UUID
 *     tags: [Fault Management]
 *     parameters:
 *       - in: path
 *         name: uuid
 *         required: true
 *         schema:
 *           type: string
 *         description: Fault UUID
 *     responses:
 *       200:
 *         description: Specific fault details
 *       404:
 *         description: Fault not found
 *       500:
 *         description: Failed to get fault details
 */
export const getFaultDetails = async (req, res) => {
    try {
        const { uuid } = req.params;
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return res.status(503).json({
                error: 'Fault management is disabled in configuration'
            });
        }

        const command = `pfexec fmadm faulty -v -u ${uuid}`;
        const { stdout, stderr } = await execProm(command, { 
            timeout: faultConfig.timeout * 1000 
        });

        if (stderr && stderr.trim()) {
            console.warn(`fmadm faulty stderr for ${uuid}:`, stderr);
        }

        if (!stdout.trim()) {
            return res.status(404).json({
                error: `Fault with UUID ${uuid} not found`
            });
        }

        const parsedFault = parseFaultOutput(stdout)[0]; // Should only be one result

        res.json({
            fault: parsedFault,
            raw_output: stdout,
            uuid: uuid,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`Error getting fault details for ${req.params.uuid}:`, error);
        res.status(500).json({ 
            error: 'Failed to get fault details',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/fault-management/config:
 *   get:
 *     summary: Get fault manager configuration
 *     description: Returns fault manager module configuration
 *     tags: [Fault Management]
 *     responses:
 *       200:
 *         description: Fault manager configuration
 *       500:
 *         description: Failed to get fault manager configuration
 */
export const getFaultManagerConfig = async (req, res) => {
    try {
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return res.status(503).json({
                error: 'Fault management is disabled in configuration'
            });
        }

        const command = 'pfexec fmadm config';
        const { stdout, stderr } = await execProm(command, { 
            timeout: faultConfig.timeout * 1000 
        });

        if (stderr && stderr.trim()) {
            console.warn('fmadm config stderr:', stderr);
        }

        const parsedConfig = parseFaultManagerConfig(stdout);

        res.json({
            config: parsedConfig,
            raw_output: stdout,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error getting fault manager configuration:', error);
        res.status(500).json({ 
            error: 'Failed to get fault manager configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/fault-management/actions/acquit:
 *   post:
 *     summary: Acquit a fault or resource
 *     description: Mark a fault as acquitted (can be ignored safely)
 *     tags: [Fault Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target:
 *                 type: string
 *                 description: FMRI or UUID to acquit
 *               uuid:
 *                 type: string
 *                 description: Optional specific fault UUID
 *     responses:
 *       200:
 *         description: Fault acquitted successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to acquit fault
 */
export const acquitFault = async (req, res) => {
    try {
        const { target, uuid } = req.body;
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return res.status(503).json({
                error: 'Fault management is disabled in configuration'
            });
        }

        if (!target) {
            return res.status(400).json({
                error: 'Target (FMRI or UUID) is required'
            });
        }

        let command = `pfexec fmadm acquit ${target}`;
        if (uuid) {
            command += ` ${uuid}`;
        }

        const { stdout, stderr } = await execProm(command, { 
            timeout: faultConfig.timeout * 1000 
        });

        // Clear cache after administrative action
        faultCache.isStale = true;

        res.json({
            success: true,
            message: `Successfully acquitted ${target}`,
            target: target,
            uuid: uuid || null,
            raw_output: stdout,
            stderr: stderr || null,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error acquitting fault:', error);
        res.status(500).json({ 
            error: 'Failed to acquit fault',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/fault-management/actions/repaired:
 *   post:
 *     summary: Mark resource as repaired
 *     description: Notify fault manager that a resource has been repaired
 *     tags: [Fault Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fmri:
 *                 type: string
 *                 description: FMRI of the repaired resource
 *     responses:
 *       200:
 *         description: Resource marked as repaired successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to mark resource as repaired
 */
export const markRepaired = async (req, res) => {
    try {
        const { fmri } = req.body;
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return res.status(503).json({
                error: 'Fault management is disabled in configuration'
            });
        }

        if (!fmri) {
            return res.status(400).json({
                error: 'FMRI is required'
            });
        }

        const command = `pfexec fmadm repaired ${fmri}`;
        const { stdout, stderr } = await execProm(command, { 
            timeout: faultConfig.timeout * 1000 
        });

        // Clear cache after administrative action
        faultCache.isStale = true;

        res.json({
            success: true,
            message: `Successfully marked ${fmri} as repaired`,
            fmri: fmri,
            raw_output: stdout,
            stderr: stderr || null,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error marking resource as repaired:', error);
        res.status(500).json({ 
            error: 'Failed to mark resource as repaired',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/fault-management/actions/replaced:
 *   post:
 *     summary: Mark resource as replaced
 *     description: Notify fault manager that a resource has been replaced
 *     tags: [Fault Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fmri:
 *                 type: string
 *                 description: FMRI of the replaced resource
 *     responses:
 *       200:
 *         description: Resource marked as replaced successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to mark resource as replaced
 */
export const markReplaced = async (req, res) => {
    try {
        const { fmri } = req.body;
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return res.status(503).json({
                error: 'Fault management is disabled in configuration'
            });
        }

        if (!fmri) {
            return res.status(400).json({
                error: 'FMRI is required'
            });
        }

        const command = `pfexec fmadm replaced ${fmri}`;
        const { stdout, stderr } = await execProm(command, { 
            timeout: faultConfig.timeout * 1000 
        });

        // Clear cache after administrative action
        faultCache.isStale = true;

        res.json({
            success: true,
            message: `Successfully marked ${fmri} as replaced`,
            fmri: fmri,
            raw_output: stdout,
            stderr: stderr || null,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error marking resource as replaced:', error);
        res.status(500).json({ 
            error: 'Failed to mark resource as replaced',
            details: error.message 
        });
    }
};

/**
 * Get current fault status for health endpoint integration
 * @returns {Object} Fault status summary
 */
export const getFaultStatusForHealth = async () => {
    try {
        const faultConfig = config.getFaultManagement();
        
        if (!faultConfig?.enabled) {
            return {
                hasFaults: false,
                faultCount: 0,
                severityLevels: [],
                lastCheck: null,
                error: 'Fault management disabled'
            };
        }

        // Check cache validity
        const now = Date.now();
        const cacheAge = faultCache.timestamp ? (now - faultCache.timestamp) / 1000 : Infinity;
        const useCache = faultCache.data && cacheAge < faultConfig.cache_interval;

        let faultData;
        
        if (useCache) {
            faultData = faultCache.data;
        } else {
            // Refresh cache
            try {
                const command = 'pfexec fmadm faulty';
                const { stdout } = await execProm(command, { 
                    timeout: faultConfig.timeout * 1000 
                });

                faultData = {
                    raw_output: stdout,
                    parsed_faults: parseFaultOutput(stdout),
                    timestamp: new Date().toISOString()
                };

                // Update cache
                faultCache = {
                    data: faultData,
                    timestamp: now,
                    isStale: false
                };
            } catch (error) {
                console.error('Error refreshing fault cache for health check:', error);
                return {
                    hasFaults: false,
                    faultCount: 0,
                    severityLevels: [],
                    lastCheck: faultCache.data?.timestamp || null,
                    error: error.message
                };
            }
        }

        const summary = generateFaultsSummary(faultData.parsed_faults);
        
        return {
            hasFaults: summary.totalFaults > 0,
            faultCount: summary.totalFaults,
            severityLevels: summary.severityLevels,
            lastCheck: faultData.timestamp,
            faults: summary.totalFaults > 0 ? faultData.parsed_faults.slice(0, 5) : [] // Top 5 for health summary
        };

    } catch (error) {
        console.error('Error getting fault status for health check:', error);
        return {
            hasFaults: false,
            faultCount: 0,
            severityLevels: [],
            lastCheck: null,
            error: error.message
        };
    }
};

/**
 * Helper function to parse fmadm faulty output
 * @param {string} output - Raw fmadm output
 * @returns {Array} Parsed fault objects
 */
function parseFaultOutput(output) {
    const faults = [];
    
    if (!output || !output.trim()) {
        return faults;
    }

    // Split by fault entries (separated by blank lines in detailed output)
    const sections = output.split(/\n\s*\n/);
    
    for (const section of sections) {
        const lines = section.trim().split('\n');
        if (lines.length < 2) continue;

        // Check if this looks like a fault header
        if (lines[0].includes('TIME') && lines[0].includes('EVENT-ID')) {
            // Parse tabular format
            for (let i = 2; i < lines.length; i++) { // Skip header lines
                const line = lines[i];
                if (line.trim()) {
                    const fault = parseFaultLine(line);
                    if (fault) faults.push(fault);
                }
            }
        } else if (section.includes('Host') && section.includes('Fault class')) {
            // Parse detailed format
            const fault = parseDetailedFault(section);
            if (fault) faults.push(fault);
        }
    }

    return faults;
}

/**
 * Helper function to parse a single fault line from tabular output
 * @param {string} line - Single line from fmadm output
 * @returns {Object|null} Parsed fault object or null
 */
function parseFaultLine(line) {
    // Parse tabular format: TIME EVENT-ID MSG-ID SEVERITY
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) return null;

    return {
        time: parts[0] + (parts[1] ? ` ${parts[1]}` : ''), // Handle multi-part dates
        uuid: parts[parts.length - 3],
        msgId: parts[parts.length - 2],
        severity: parts[parts.length - 1],
        format: 'summary'
    };
}

/**
 * Helper function to parse detailed fault information
 * @param {string} section - Detailed fault section
 * @returns {Object|null} Parsed fault object or null
 */
function parseDetailedFault(section) {
    const fault = { format: 'detailed' };
    const lines = section.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.includes('Host') && trimmed.includes(':')) {
            fault.host = trimmed.split(':')[1]?.trim();
        } else if (trimmed.includes('Platform') && trimmed.includes(':')) {
            fault.platform = trimmed.split(':')[1]?.split('Chassis_id')[0]?.trim();
        } else if (trimmed.includes('Fault class') && trimmed.includes(':')) {
            fault.faultClass = trimmed.split(':')[1]?.trim();
        } else if (trimmed.includes('Affects') && trimmed.includes(':')) {
            fault.affects = trimmed.split(':')[1]?.trim();
        } else if (trimmed.includes('Problem in') && trimmed.includes(':')) {
            fault.problemIn = trimmed.split(':')[1]?.trim();
        } else if (trimmed.includes('Description') && trimmed.includes(':')) {
            fault.description = trimmed.split(':')[1]?.trim();
        } else if (trimmed.includes('Impact') && trimmed.includes(':')) {
            fault.impact = trimmed.split(':')[1]?.trim();
        } else if (trimmed.includes('Action') && trimmed.includes(':')) {
            fault.action = trimmed.split(':')[1]?.trim();
        }
    }

    return Object.keys(fault).length > 1 ? fault : null;
}

/**
 * Helper function to parse fmadm config output
 * @param {string} output - Raw fmadm config output
 * @returns {Array} Parsed module configurations
 */
function parseFaultManagerConfig(output) {
    const modules = [];
    const lines = output.trim().split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('MODULE')) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 3) {
                modules.push({
                    module: parts[0],
                    version: parts[1],
                    description: parts.slice(2).join(' ')
                });
            }
        }
    }

    return modules;
}

/**
 * Helper function to generate faults summary
 * @param {Array} faults - Array of parsed faults
 * @returns {Object} Summary statistics
 */
function generateFaultsSummary(faults) {
    const summary = {
        totalFaults: faults.length,
        severityLevels: [],
        faultClasses: [],
        affectedResources: []
    };

    const severityCount = {};
    const classCount = {};

    for (const fault of faults) {
        // Count severities
        if (fault.severity) {
            severityCount[fault.severity] = (severityCount[fault.severity] || 0) + 1;
        }

        // Count fault classes
        if (fault.faultClass) {
            classCount[fault.faultClass] = (classCount[fault.faultClass] || 0) + 1;
        }

        // Track affected resources
        if (fault.affects && !summary.affectedResources.includes(fault.affects)) {
            summary.affectedResources.push(fault.affects);
        }
    }

    summary.severityLevels = Object.keys(severityCount);
    summary.faultClasses = Object.keys(classCount);
    summary.severityBreakdown = severityCount;
    summary.classBreakdown = classCount;

    return summary;
}

export default {
    getFaults,
    getFaultDetails,
    getFaultManagerConfig,
    acquitFault,
    markRepaired,
    markReplaced,
    getFaultStatusForHealth
};
