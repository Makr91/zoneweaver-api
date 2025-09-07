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

// Fault cache to store results for configured interval - parameter-aware caching
let faultCache = new Map();

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

        // Create cache key based on parameters to avoid conflicts
        const cacheKey = `all=${all}&summary=${summary}&limit=${limit}`;
        const now = Date.now();
        
        // Check cache validity for this specific parameter combination
        let cachedEntry = faultCache.get(cacheKey);
        const cacheAge = cachedEntry?.timestamp ? (now - cachedEntry.timestamp) / 1000 : Infinity;
        const useCache = !force_refresh && cachedEntry?.data && cacheAge < faultConfig.cache_interval;

        let faultData;
        
        if (useCache) {
            faultData = cachedEntry.data;
            console.log(`🔍 Fault Management Debug - Using cached data for: ${cacheKey}`);
        } else {
            // Build fmadm command with options
            let command = 'pfexec fmadm faulty';
            if (all) command += ' -a';
            if (summary) command += ' -s';
            if (limit && limit < 50) command += ` -n ${limit}`;

            console.log(`🔍 Fault Management Debug - Parameters: all=${all}, summary=${summary}, limit=${limit}`);
            console.log(`🔍 Fault Management Debug - Command: ${command}`);
            console.log(`🔍 Fault Management Debug - Cache key: ${cacheKey}`);

            const { stdout, stderr } = await execProm(command, { 
                timeout: faultConfig.timeout * 1000 
            });

            if (stderr && stderr.trim()) {
                console.warn('fmadm faulty stderr:', stderr);
            }

            console.log(`🔍 Fault Management Debug - Raw output length: ${stdout.length} chars`);
            console.log(`🔍 Fault Management Debug - First 200 chars: ${stdout.substring(0, 200)}`);

            faultData = {
                raw_output: stdout,
                parsed_faults: parseFaultOutput(stdout),
                command_used: command,
                timestamp: new Date().toISOString()
            };

            console.log(`🔍 Fault Management Debug - Parsed ${faultData.parsed_faults.length} faults`);

            // Update cache for this parameter combination
            faultCache.set(cacheKey, {
                data: faultData,
                timestamp: now
            });
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

        // Clear all cache entries after administrative action
        faultCache.clear();

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

        // Clear all cache entries after administrative action
        faultCache.clear();

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

        // Clear all cache entries after administrative action
        faultCache.clear();

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

        // Use cache for health endpoint (default parameters: all=false)
        const healthCacheKey = 'all=false&summary=false&limit=50';
        const now = Date.now();
        
        let cachedEntry = faultCache.get(healthCacheKey);
        const cacheAge = cachedEntry?.timestamp ? (now - cachedEntry.timestamp) / 1000 : Infinity;
        const useCache = cachedEntry?.data && cacheAge < faultConfig.cache_interval;

        let faultData;
        
        if (useCache) {
            faultData = cachedEntry.data;
        } else {
            // Refresh cache for health endpoint
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
                faultCache.set(healthCacheKey, {
                    data: faultData,
                    timestamp: now
                });
            } catch (error) {
                console.error('Error refreshing fault cache for health check:', error);
                return {
                    hasFaults: false,
                    faultCount: 0,
                    severityLevels: [],
                    lastCheck: cachedEntry?.data?.timestamp || null,
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

    const lines = output.trim().split('\n');
    let currentFault = null;
    let collectingDetails = false;
    let detailLines = [];
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Skip dash separator lines
        if (line.match(/^-{15,}/)) {
            continue;
        }
        
        // Skip table header lines
        if (line.includes('TIME') && line.includes('EVENT-ID') && line.includes('MSG-ID') && line.includes('SEVERITY')) {
            continue;
        }
        
        // Skip empty lines
        if (!line.trim()) {
            if (collectingDetails && detailLines.length > 0) {
                // End of detail section - process collected details
                const detailedInfo = parseDetailedFault(detailLines.join('\n'));
                if (currentFault && detailedInfo) {
                    currentFault.details = {
                        host: detailedInfo.host,
                        platform: detailedInfo.platform,
                        faultClass: detailedInfo.faultClass,
                        affects: detailedInfo.affects,
                        problemIn: detailedInfo.problemIn,
                        description: detailedInfo.description,
                        response: detailedInfo.response,
                        impact: detailedInfo.impact,
                        action: detailedInfo.action
                    };
                }
                collectingDetails = false;
                detailLines = [];
            }
            continue;
        }
        
        // Try to parse as fault line (contains UUID)
        const possibleFault = parseFaultLine(line);
        if (possibleFault) {
            // Save previous fault if we were working on one
            if (currentFault) {
                if (collectingDetails && detailLines.length > 0) {
                    const detailedInfo = parseDetailedFault(detailLines.join('\n'));
                    if (detailedInfo) {
                        currentFault.details = {
                            host: detailedInfo.host,
                            platform: detailedInfo.platform,
                            faultClass: detailedInfo.faultClass,
                            affects: detailedInfo.affects,
                            problemIn: detailedInfo.problemIn,
                            description: detailedInfo.description,
                            response: detailedInfo.response,
                            impact: detailedInfo.impact,
                            action: detailedInfo.action
                        };
                    }
                }
                faults.push(currentFault);
            }
            
            // Start new fault
            currentFault = possibleFault;
            collectingDetails = false;
            detailLines = [];
            continue;
        }
        
        // Check if this is start of detailed section
        if (line.includes('Host') && line.includes(':')) {
            collectingDetails = true;
            detailLines = [line];
            continue;
        }
        
        // If we're collecting details, add this line
        if (collectingDetails) {
            detailLines.push(line);
        }
    }
    
    // Don't forget the last fault
    if (currentFault) {
        if (collectingDetails && detailLines.length > 0) {
            const detailedInfo = parseDetailedFault(detailLines.join('\n'));
            if (detailedInfo) {
                currentFault.details = {
                    host: detailedInfo.host,
                    platform: detailedInfo.platform,
                    faultClass: detailedInfo.faultClass,
                    affects: detailedInfo.affects,
                    problemIn: detailedInfo.problemIn,
                    description: detailedInfo.description,
                    response: detailedInfo.response,
                    impact: detailedInfo.impact,
                    action: detailedInfo.action
                };
            }
        }
        faults.push(currentFault);
    }

    return faults;
}

/**
 * Helper function to parse a single fault line from tabular output
 * @param {string} line - Single line from fmadm output
 * @returns {Object|null} Parsed fault object or null
 */
function parseFaultLine(line) {
    const trimmed = line.trim();
    
    // Skip empty lines and lines that are clearly not fault data
    if (!trimmed || trimmed.length < 20) return null;
    
    // Parse the format: "Jan 19 2025     c543b4ad-6cc7-40bc-891a-186100ef16a7  ZFS-8000-CS    Major"
    // Use regex to match the UUID pattern
    const uuidPattern = /([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})/;
    const match = trimmed.match(uuidPattern);
    
    if (!match) return null;
    
    const uuid = match[1];
    const beforeUuid = trimmed.substring(0, match.index).trim();
    const afterUuid = trimmed.substring(match.index + uuid.length).trim();
    
    // Split the part after UUID to get MSG-ID and SEVERITY
    const afterParts = afterUuid.split(/\s+/);
    if (afterParts.length < 2) return null;
    
    const msgId = afterParts[0];
    const severity = afterParts[1];

    return {
        time: beforeUuid,
        uuid: uuid,
        msgId: msgId,
        severity: normalizeSeverity(severity),
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
    let currentField = null;
    let currentValue = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Skip empty lines
        if (!trimmed) {
            continue;
        }

        // Check if this line starts a new field - only recognize expected fields
        let newField = false;
        
        if (line.match(/^Host\s*:/)) {
            // Save previous field
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'host';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Platform\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'platform';
            currentValue = line.split(':')[1]?.split('Chassis_id')[0]?.trim() || '';
            newField = true;
        } else if (line.match(/^Fault class\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'faultClass';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Affects\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'affects';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Problem in\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'problemIn';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Description\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'description';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Response\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'response';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Impact\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'impact';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.match(/^Action\s*:/)) {
            if (currentField && currentValue) {
                fault[currentField] = currentValue.trim();
            }
            currentField = 'action';
            currentValue = line.split(':')[1]?.trim() || '';
            newField = true;
        } else if (line.includes(':') && (line.startsWith('Product_sn') || line.startsWith('Chassis_id'))) {
            // Skip these fields - they're not part of our fault data
            newField = true; // Mark as new field but don't set currentField
        }

        // If this isn't a new field and we have a current field, it's a continuation line
        if (!newField && currentField && trimmed) {
            if (currentValue) {
                currentValue += ' ' + trimmed;
            } else {
                currentValue = trimmed;
            }
        }
    }

    // Save the last field
    if (currentField && currentValue) {
        fault[currentField] = currentValue.trim();
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
 * Helper function to normalize severity levels
 * @param {string} severity - Raw severity from fmadm
 * @returns {string} Normalized severity
 */
function normalizeSeverity(severity) {
    if (!severity) return severity;
    
    // Normalize case - capitalize first letter, lowercase rest
    return severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();
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

        // Count fault classes from details if available, otherwise from fault object
        const faultClass = fault.details?.faultClass || fault.faultClass;
        if (faultClass) {
            classCount[faultClass] = (classCount[faultClass] || 0) + 1;
        }

        // Track affected resources from details if available
        const affects = fault.details?.affects || fault.affects;
        if (affects && !summary.affectedResources.includes(affects)) {
            summary.affectedResources.push(affects);
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
