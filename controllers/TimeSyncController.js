/**
 * @fileoverview Time Synchronization Controller for Zoneweaver API
 * @description Handles NTP and Chrony service management, configuration, and timezone management on OmniOS
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { execSync } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import yj from "yieldable-json";
import fs from "fs";
import path from "path";

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = 30000) => {
    try {
        const output = execSync(command, { 
            encoding: 'utf8',
            timeout: timeout
        });
        return { success: true, output: output.trim() };
    } catch (error) {
        return { 
            success: false, 
            error: error.message,
            output: error.stdout || ''
        };
    }
};

/**
 * Detect available time synchronization service
 * @returns {Promise<{service: string, status: string, available: boolean, details?: object}>}
 */
const detectTimeService = async () => {
    // Check for NTP first
    const ntpCheck = await executeCommand('svcs ntp');
    if (ntpCheck.success) {
        const ntpDetails = await executeCommand('svcs -l ntp');
        return {
            service: 'ntp',
            status: 'available',
            available: true,
            details: parseServiceDetails(ntpDetails.output)
        };
    }

    // Check for Chrony
    const chronyCheck = await executeCommand('svcs chrony');
    if (chronyCheck.success) {
        const chronyDetails = await executeCommand('svcs -l chrony');
        return {
            service: 'chrony',
            status: 'available',
            available: true,
            details: parseServiceDetails(chronyDetails.output)
        };
    }

    // Check if either service exists but is disabled
    const allServices = await executeCommand('svcs -a | grep -E "(ntp|chrony)"');
    if (allServices.success && allServices.output) {
        const lines = allServices.output.split('\n');
        for (const line of lines) {
            if (line.includes('ntp:default')) {
                return {
                    service: 'ntp',
                    status: 'disabled',
                    available: true,
                    details: { state: 'disabled', note: 'Service exists but is disabled' }
                };
            }
            if (line.includes('chrony:default')) {
                return {
                    service: 'chrony',
                    status: 'disabled',
                    available: true,
                    details: { state: 'disabled', note: 'Service exists but is disabled' }
                };
            }
        }
    }

    return {
        service: 'none',
        status: 'unavailable',
        available: false,
        details: { note: 'No time synchronization service found (NTP or Chrony)' }
    };
};

/**
 * Parse SMF service details output
 * @param {string} serviceOutput - Output from svcs -l command
 * @returns {object} Parsed service details
 */
const parseServiceDetails = (serviceOutput) => {
    const details = {};
    const lines = serviceOutput.split('\n');
    
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2) {
            const key = parts[0];
            const value = parts.slice(1).join(' ');
            details[key] = value;
        }
    }
    
    return details;
};

/**
 * Parse NTP peer status from ntpq -p output
 * @param {string} ntpqOutput - Raw output from ntpq -p command
 * @returns {Array<Object>} Array of NTP peer objects
 */
const parseNtpPeers = (ntpqOutput) => {
    const lines = ntpqOutput.split('\n');
    const peers = [];
    
    // Skip header lines and process peer data
    for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse peer line - format: remote refid st t when poll reach delay offset jitter
        const parts = line.split(/\s+/);
        if (parts.length >= 10) {
            const remote = parts[0];
            const peer = {
                indicator: remote.charAt(0), // *, +, -, x, ., space
                remote: remote.substring(1),
                refid: parts[1],
                stratum: parseInt(parts[2]) || 16,
                type: parts[3],
                when: parts[4],
                poll: parseInt(parts[5]) || 0,
                reach: parts[6],
                delay: parseFloat(parts[7]) || 0,
                offset: parseFloat(parts[8]) || 0,
                jitter: parseFloat(parts[9]) || 0
            };
            
            // Determine peer status
            switch (peer.indicator) {
                case '*':
                    peer.status = 'selected_primary';
                    peer.description = 'Selected as primary time source';
                    break;
                case '+':
                    peer.status = 'selected_backup';
                    peer.description = 'Selected as backup time source';
                    break;
                case '-':
                    peer.status = 'rejected';
                    peer.description = 'Rejected by clustering algorithm';
                    break;
                case 'x':
                    peer.status = 'falseticker';
                    peer.description = 'Rejected as false ticker';
                    break;
                case '.':
                    peer.status = 'excess';
                    peer.description = 'Excess peer (not used)';
                    break;
                case ' ':
                default:
                    peer.status = 'candidate';
                    peer.description = 'Candidate for selection';
                    break;
            }
            
            // Calculate reachability percentage
            if (peer.reach !== '0') {
                const reachValue = parseInt(peer.reach, 8) || 0;
                peer.reachability_percent = Math.round((reachValue / 255) * 100);
            } else {
                peer.reachability_percent = 0;
            }
            
            peers.push(peer);
        }
    }
    
    return peers;
};

/**
 * Parse Chrony sources from chronyc sources output
 * @param {string} chronycOutput - Raw output from chronyc sources command
 * @returns {Array<Object>} Array of chrony source objects
 */
const parseChronySources = (chronycOutput) => {
    const lines = chronycOutput.split('\n');
    const sources = [];
    
    // Skip header lines and process source data
    for (let i = 2; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        // Parse source line - format: MS Name/IP address Stratum Poll Reach LastRx Last sample
        const parts = line.split(/\s+/);
        if (parts.length >= 8) {
            const msField = parts[0];
            const source = {
                mode_indicator: msField.charAt(0), // M field: ^, =, #, ?
                state_indicator: msField.charAt(1), // S field: *, +, -, x, ?, ~
                name: parts[1],
                stratum: parseInt(parts[2]) || 16,
                poll: parseInt(parts[3]) || 0,
                reach: parseInt(parts[4]) || 0,
                last_rx: parts[5],
                last_sample: parts.slice(6).join(' ')
            };
            
            // Interpret mode indicator
            switch (source.mode_indicator) {
                case '^':
                    source.mode = 'server';
                    break;
                case '=':
                    source.mode = 'peer';
                    break;
                case '#':
                    source.mode = 'local_reference';
                    break;
                default:
                    source.mode = 'unknown';
                    break;
            }
            
            // Interpret state indicator
            switch (source.state_indicator) {
                case '*':
                    source.status = 'selected_primary';
                    source.description = 'Selected as primary time source';
                    break;
                case '+':
                    source.status = 'selected_backup';
                    source.description = 'Selected as backup time source';
                    break;
                case '-':
                    source.status = 'rejected';
                    source.description = 'Rejected by selection algorithm';
                    break;
                case 'x':
                    source.status = 'falseticker';
                    source.description = 'Rejected as false ticker';
                    break;
                case '?':
                    source.status = 'unreachable';
                    source.description = 'Connectivity lost';
                    break;
                case '~':
                    source.status = 'high_variance';
                    source.description = 'Variable time source';
                    break;
                default:
                    source.status = 'candidate';
                    source.description = 'Candidate for selection';
                    break;
            }
            
            // Calculate reachability percentage (chrony uses decimal, not octal)
            source.reachability_percent = Math.round((source.reach / 255) * 100);
            
            sources.push(source);
        }
    }
    
    return sources;
};

/**
 * Get current timezone from /etc/default/init
 * @returns {Promise<{success: boolean, timezone?: string, error?: string}>}
 */
const getCurrentTimezone = async () => {
    try {
        if (!fs.existsSync('/etc/default/init')) {
            return { success: false, error: 'Timezone configuration file not found' };
        }
        
        const content = fs.readFileSync('/etc/default/init', 'utf8');
        const lines = content.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('TZ=')) {
                const timezone = trimmed.substring(3).replace(/['"]/g, '');
                return { success: true, timezone };
            }
        }
        
        return { success: false, error: 'TZ variable not found in /etc/default/init' };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get available timezones from the system
 * @returns {Promise<{success: boolean, timezones?: Array, error?: string}>}
 */
const getAvailableTimezones = async () => {
    try {
        const zoneinfoPath = '/usr/share/lib/zoneinfo';
        if (!fs.existsSync(zoneinfoPath)) {
            return { success: false, error: 'Timezone database not found' };
        }
        
        const timezones = [];
        
        // Read continent directories
        const continents = fs.readdirSync(zoneinfoPath, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
            .map(entry => entry.name);
        
        for (const continent of continents) {
            const continentPath = path.join(zoneinfoPath, continent);
            try {
                const cities = fs.readdirSync(continentPath, { withFileTypes: true });
                for (const city of cities) {
                    if (city.isFile()) {
                        timezones.push(`${continent}/${city.name}`);
                    } else if (city.isDirectory()) {
                        // Handle nested directories (like America/Argentina)
                        const subcities = fs.readdirSync(path.join(continentPath, city.name));
                        for (const subcity of subcities) {
                            timezones.push(`${continent}/${city.name}/${subcity}`);
                        }
                    }
                }
            } catch (error) {
                // Skip directories we can't read
                continue;
            }
        }
        
        return { success: true, timezones: timezones.sort() };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Generate default NTP configuration
 * @returns {string} Default NTP configuration content
 */
const generateDefaultNtpConfig = () => {
    return `# Generated by Zoneweaver API
# Default NTP configuration for OmniOS

driftfile /var/ntp/ntp.drift

# Access restrictions
restrict default ignore
restrict -6 default ignore
restrict 127.0.0.1
restrict -6 ::1

# Default NTP servers (configure as needed)
server 0.pool.ntp.org iburst
server 1.pool.ntp.org iburst  
server 2.pool.ntp.org iburst
server 3.pool.ntp.org iburst

# Allow updates from configured servers
restrict 0.pool.ntp.org nomodify noquery notrap
restrict 1.pool.ntp.org nomodify noquery notrap
restrict 2.pool.ntp.org nomodify noquery notrap
restrict 3.pool.ntp.org nomodify noquery notrap
`;
};

/**
 * Generate default Chrony configuration
 * @returns {string} Default Chrony configuration content
 */
const generateDefaultChronyConfig = () => {
    return `# Generated by Zoneweaver API
# Default Chrony configuration for OmniOS

# Default NTP servers (configure as needed)
server 0.pool.ntp.org iburst
server 1.pool.ntp.org iburst
server 2.pool.ntp.org iburst
server 3.pool.ntp.org iburst

# Drift file location
driftfile /var/lib/chrony/drift

# Allow chronyd to make gradual corrections
makestep 1.0 3

# Enable RTC sync
rtcsync

# Log measurements
logdir /var/log/chrony
log measurements statistics tracking
`;
};

/**
 * Generate default NTPsec configuration
 * @returns {string} Default NTPsec configuration content
 */
const generateDefaultNtpsecConfig = () => {
    return `# Generated by Zoneweaver API
# Default NTPsec configuration for OmniOS

driftfile /var/lib/ntp/ntp.drift

# Access restrictions
restrict default kod limited nomodify nopeer noquery notrap
restrict -6 default kod limited nomodify nopeer noquery notrap
restrict 127.0.0.1
restrict -6 ::1

# Default NTP servers (configure as needed)
server 0.pool.ntp.org iburst
server 1.pool.ntp.org iburst
server 2.pool.ntp.org iburst
server 3.pool.ntp.org iburst

# Allow updates from configured servers
restrict 0.pool.ntp.org nomodify noquery notrap
restrict 1.pool.ntp.org nomodify noquery notrap
restrict 2.pool.ntp.org nomodify noquery notrap
restrict 3.pool.ntp.org nomodify noquery notrap
`;
};

/**
 * Detect available time sync packages and services
 * @returns {Promise<{current: object, available: object}>}
 */
const detectAvailableTimeSyncSystems = async () => {
    const systems = {
        ntp: {
            package_name: 'service/network/ntp',
            service_name: 'svc:/network/ntp:default',
            config_file: '/etc/inet/ntp.conf',
            installed: false,
            enabled: false,
            active: false,
            can_switch_to: false
        },
        chrony: {
            package_name: 'service/network/chrony',
            service_name: 'svc:/network/chrony:default',
            config_file: '/etc/chrony.conf',
            installed: false,
            enabled: false,
            active: false,
            can_switch_to: false
        },
        ntpsec: {
            package_name: 'service/network/ntpsec',
            service_name: 'svc:/network/ntpsec:default',
            config_file: '/etc/ntpsec/ntp.conf',
            installed: false,
            enabled: false,
            active: false,
            can_switch_to: false
        }
    };

    // Check current service status
    const currentService = await detectTimeService();

    // Check package installation status
    for (const [systemName, systemInfo] of Object.entries(systems)) {
        // Check if package is installed
        const pkgResult = await executeCommand(`pkg list ${systemInfo.package_name} 2>/dev/null`);
        systemInfo.installed = pkgResult.success;

        if (systemInfo.installed) {
            // Check service status
            const serviceResult = await executeCommand(`svcs ${systemName} 2>/dev/null`);
            if (serviceResult.success) {
                const serviceLines = serviceResult.output.split('\n');
                for (const line of serviceLines) {
                    if (line.includes(`${systemName}:default`)) {
                        const parts = line.trim().split(/\s+/);
                        systemInfo.enabled = parts[0] !== 'disabled';
                        systemInfo.active = parts[0] === 'online';
                        break;
                    }
                }
            }
        }

        // Determine if we can switch to this system
        systemInfo.can_switch_to = systemInfo.installed || (!systemInfo.installed && systemName !== currentService.service);
    }

    return {
        current: {
            service: currentService.service,
            status: currentService.status,
            available: currentService.available
        },
        available: systems,
        recommendations: {
            modern: 'chrony',
            traditional: 'ntp',
            secure: 'ntpsec',
            description: 'Chrony is recommended for modern systems, NTP for compatibility, NTPsec for enhanced security'
        }
    };
};

/**
 * Extract server list from configuration content
 * @param {string} configContent - Configuration file content
 * @param {string} systemType - Type of system (ntp, chrony, ntpsec)
 * @returns {Array<string>} Array of server addresses
 */
const extractServersFromConfig = (configContent, systemType) => {
    const servers = [];
    const lines = configContent.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('server ') && !trimmed.includes('127.127.1.0')) {
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 2) {
                servers.push(parts[1]);
            }
        }
    }

    return servers.length > 0 ? servers : ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'];
};

/**
 * Generate configuration for target system with migrated servers
 * @param {string} targetSystem - Target system type (ntp, chrony, ntpsec)
 * @param {Array<string>} servers - Server list to include
 * @returns {string} Generated configuration content
 */
const generateConfigForSystem = (targetSystem, servers) => {
    let baseConfig = '';
    
    switch (targetSystem) {
        case 'ntp':
            baseConfig = generateDefaultNtpConfig();
            break;
        case 'chrony':
            baseConfig = generateDefaultChronyConfig();
            break;
        case 'ntpsec':
            baseConfig = generateDefaultNtpsecConfig();
            break;
        default:
            throw new Error(`Unknown target system: ${targetSystem}`);
    }

    // Replace default servers with migrated ones
    const lines = baseConfig.split('\n');
    const newLines = [];
    let inServerSection = false;

    for (const line of lines) {
        if (line.includes('server ') && line.includes('pool.ntp.org')) {
            if (!inServerSection) {
                // Replace with migrated servers
                servers.forEach((server, index) => {
                    if (targetSystem === 'chrony') {
                        newLines.push(`server ${server} iburst`);
                    } else {
                        newLines.push(`server ${server} iburst`);
                        // Add restrict line for NTP/NTPsec
                        if (targetSystem === 'ntp' || targetSystem === 'ntpsec') {
                            newLines.push(`restrict ${server} nomodify noquery notrap`);
                        }
                    }
                });
                inServerSection = true;
            }
            // Skip original server lines
        } else if (line.includes('restrict ') && line.includes('pool.ntp.org')) {
            // Skip original restrict lines, we added them with servers
        } else {
            newLines.push(line);
        }
    }

    return newLines.join('\n');
};

/**
 * @swagger
 * /system/time-sync/status:
 *   get:
 *     summary: Get time synchronization status
 *     description: Returns current time sync service status, peer information, and sync status
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Time sync status retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                   enum: [ntp, chrony, none]
 *                   description: Detected time sync service
 *                 status:
 *                   type: string
 *                   enum: [available, disabled, unavailable]
 *                   description: Service availability status
 *                 service_details:
 *                   type: object
 *                   description: SMF service details
 *                 peers:
 *                   type: array
 *                   description: NTP peers or Chrony sources
 *                 sync_status:
 *                   type: object
 *                   description: Current synchronization status
 *       500:
 *         description: Failed to get time sync status
 */
export const getTimeSyncStatus = async (req, res) => {
    try {
        // Detect available service
        const serviceInfo = await detectTimeService();
        
        let peers = [];
        let syncStatus = null;
        
        if (serviceInfo.available && serviceInfo.details?.state === 'online') {
            if (serviceInfo.service === 'ntp') {
                // Get NTP peer information
                const ntpqResult = await executeCommand('ntpq -p');
                if (ntpqResult.success) {
                    peers = parseNtpPeers(ntpqResult.output);
                }
            } else if (serviceInfo.service === 'chrony') {
                // Get Chrony source information
                const chronycResult = await executeCommand('chronyc sources');
                if (chronycResult.success) {
                    peers = parseChronySources(chronycResult.output);
                }
            }
        }
        
        // Get current timezone
        const timezoneResult = await getCurrentTimezone();
        
        res.json({
            service: serviceInfo.service,
            status: serviceInfo.status,
            available: serviceInfo.available,
            service_details: serviceInfo.details,
            peers: peers,
            peer_count: peers.length,
            synchronized_peers: peers.filter(p => p.status === 'selected_primary' || p.status === 'selected_backup').length,
            timezone: timezoneResult.success ? timezoneResult.timezone : null,
            last_checked: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error getting time sync status:', error);
        res.status(500).json({ 
            error: 'Failed to get time sync status',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/time-sync/config:
 *   get:
 *     summary: Get time sync configuration
 *     description: Returns current time sync configuration and suggested defaults
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Configuration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 service:
 *                   type: string
 *                 config_file:
 *                   type: string
 *                 config_exists:
 *                   type: boolean
 *                 current_config:
 *                   type: string
 *                 suggested_defaults:
 *                   type: object
 *       500:
 *         description: Failed to get configuration
 */
export const getTimeSyncConfig = async (req, res) => {
    try {
        // Detect available service
        const serviceInfo = await detectTimeService();
        
        if (!serviceInfo.available) {
            return res.status(404).json({
                error: 'No time synchronization service available',
                service: serviceInfo.service,
                details: serviceInfo.details
            });
        }
        
        let configFile = '';
        let currentConfig = '';
        let configExists = false;
        let suggestedDefaults = {};
        
        if (serviceInfo.service === 'ntp') {
            configFile = '/etc/inet/ntp.conf';
            suggestedDefaults = {
                servers: ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'],
                config_template: generateDefaultNtpConfig()
            };
        } else if (serviceInfo.service === 'chrony') {
            configFile = '/etc/chrony.conf';
            suggestedDefaults = {
                servers: ['0.pool.ntp.org', '1.pool.ntp.org', '2.pool.ntp.org', '3.pool.ntp.org'],
                config_template: generateDefaultChronyConfig()
            };
        }
        
        // Read existing config if it exists
        try {
            if (fs.existsSync(configFile)) {
                currentConfig = fs.readFileSync(configFile, 'utf8');
                configExists = true;
            }
        } catch (error) {
            console.warn(`Failed to read config file ${configFile}:`, error.message);
        }
        
        res.json({
            service: serviceInfo.service,
            config_file: configFile,
            config_exists: configExists,
            current_config: currentConfig,
            suggested_defaults: suggestedDefaults,
            service_details: serviceInfo.details
        });
        
    } catch (error) {
        console.error('Error getting time sync config:', error);
        res.status(500).json({ 
            error: 'Failed to get time sync configuration',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/time-sync/config:
 *   put:
 *     summary: Update time sync configuration
 *     description: Updates the time sync configuration file and restarts the service
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               config_content:
 *                 type: string
 *                 description: Complete configuration file content
 *               backup_existing:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup of existing config
 *               restart_service:
 *                 type: boolean
 *                 default: true
 *                 description: Restart service after config update
 *               created_by:
 *                 type: string
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Configuration update task created
 *       404:
 *         description: No time sync service available
 *       400:
 *         description: Invalid configuration content
 */
export const updateTimeSyncConfig = async (req, res) => {
    try {
        const { config_content, backup_existing = true, restart_service = true, created_by = 'api' } = req.body;
        
        if (!config_content || typeof config_content !== 'string') {
            return res.status(400).json({ 
                error: 'config_content is required and must be a string' 
            });
        }
        
        // Detect available service
        const serviceInfo = await detectTimeService();
        
        if (!serviceInfo.available) {
            return res.status(404).json({
                error: 'No time synchronization service available',
                service: serviceInfo.service,
                details: serviceInfo.details
            });
        }
        
        // Create task for config update
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'update_time_sync_config',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    service: serviceInfo.service,
                    config_content: config_content,
                    backup_existing: backup_existing,
                    restart_service: restart_service
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });
        
        res.status(202).json({
            success: true,
            message: `Time sync configuration update task created for ${serviceInfo.service}`,
            task_id: task.id,
            service: serviceInfo.service
        });
        
    } catch (error) {
        console.error('Error updating time sync config:', error);
        res.status(500).json({ 
            error: 'Failed to create time sync config update task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/time-sync/sync:
 *   post:
 *     summary: Force time synchronization
 *     description: Forces an immediate time sync using ntpdig or chrony
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               server:
 *                 type: string
 *                 description: Specific NTP server to sync from (optional)
 *               timeout:
 *                 type: integer
 *                 default: 30
 *                 description: Sync timeout in seconds
 *               created_by:
 *                 type: string
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Sync task created successfully
 *       404:
 *         description: No time sync service available
 */
export const forceTimeSync = async (req, res) => {
    try {
        const { server, timeout = 30, created_by = 'api' } = req.body || {};
        
        // Detect available service
        const serviceInfo = await detectTimeService();
        
        if (!serviceInfo.available) {
            return res.status(404).json({
                error: 'No time synchronization service available',
                service: serviceInfo.service,
                details: serviceInfo.details
            });
        }
        
        // Create task for forced sync
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'force_time_sync',
            priority: TaskPriority.HIGH,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    service: serviceInfo.service,
                    server: server,
                    timeout: timeout
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });
        
        res.status(202).json({
            success: true,
            message: `Time sync task created for ${serviceInfo.service}${server ? ` using server ${server}` : ''}`,
            task_id: task.id,
            service: serviceInfo.service,
            server: server || 'auto-detect'
        });
        
    } catch (error) {
        console.error('Error creating force time sync task:', error);
        res.status(500).json({ 
            error: 'Failed to create time sync task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/timezone:
 *   get:
 *     summary: Get current timezone
 *     description: Returns the current system timezone configuration
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current timezone retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timezone:
 *                   type: string
 *                   example: "America/Chicago"
 *                 config_file:
 *                   type: string
 *                   example: "/etc/default/init"
 *                 available_timezones_count:
 *                   type: integer
 *       500:
 *         description: Failed to get timezone
 */
export const getTimezone = async (req, res) => {
    try {
        const timezoneResult = await getCurrentTimezone();
        
        if (!timezoneResult.success) {
            return res.status(500).json({
                error: 'Failed to get current timezone',
                details: timezoneResult.error
            });
        }
        
        // Get count of available timezones
        const availableTimezones = await getAvailableTimezones();
        
        res.json({
            timezone: timezoneResult.timezone,
            config_file: '/etc/default/init',
            available_timezones_count: availableTimezones.success ? availableTimezones.timezones.length : 0,
            last_checked: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error getting timezone:', error);
        res.status(500).json({ 
            error: 'Failed to get timezone',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/timezone:
 *   put:
 *     summary: Set system timezone
 *     description: Updates the system timezone in /etc/default/init
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - timezone
 *             properties:
 *               timezone:
 *                 type: string
 *                 description: Timezone to set (e.g., America/New_York)
 *                 example: "America/New_York"
 *               backup_existing:
 *                 type: boolean
 *                 default: true
 *                 description: Create backup of existing config
 *               created_by:
 *                 type: string
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Timezone update task created
 *       400:
 *         description: Invalid timezone or request
 */
export const setTimezone = async (req, res) => {
    try {
        const { timezone, backup_existing = true, created_by = 'api' } = req.body;
        
        if (!timezone || typeof timezone !== 'string') {
            return res.status(400).json({ 
                error: 'timezone is required and must be a string' 
            });
        }
        
        // Validate timezone exists
        const zonePath = `/usr/share/lib/zoneinfo/${timezone}`;
        if (!fs.existsSync(zonePath)) {
            return res.status(400).json({
                error: 'Invalid timezone',
                timezone: timezone,
                details: `Timezone file not found: ${zonePath}`
            });
        }
        
        // Create task for timezone update
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'set_timezone',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    timezone: timezone,
                    backup_existing: backup_existing
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });
        
        res.status(202).json({
            success: true,
            message: `Timezone update task created: ${timezone}`,
            task_id: task.id,
            timezone: timezone
        });
        
    } catch (error) {
        console.error('Error setting timezone:', error);
        res.status(500).json({ 
            error: 'Failed to create timezone update task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/timezones:
 *   get:
 *     summary: List available timezones
 *     description: Returns a list of all available timezones from the system
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: region
 *         schema:
 *           type: string
 *         description: Filter by region (e.g., America, Europe, Asia)
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search for timezone names containing this string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of timezones to return
 *     responses:
 *       200:
 *         description: Available timezones retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 timezones:
 *                   type: array
 *                   items:
 *                     type: string
 *                 total:
 *                   type: integer
 *                 filtered:
 *                   type: boolean
 */
export const listTimezones = async (req, res) => {
    try {
        const { region, search, limit = 100 } = req.query;
        
        const availableTimezones = await getAvailableTimezones();
        
        if (!availableTimezones.success) {
            return res.status(500).json({
                error: 'Failed to get available timezones',
                details: availableTimezones.error
            });
        }
        
        let timezones = availableTimezones.timezones;
        let filtered = false;
        
        // Apply region filter
        if (region) {
            timezones = timezones.filter(tz => tz.startsWith(region + '/'));
            filtered = true;
        }
        
        // Apply search filter
        if (search) {
            const searchLower = search.toLowerCase();
            timezones = timezones.filter(tz => tz.toLowerCase().includes(searchLower));
            filtered = true;
        }
        
        // Apply limit
        const total = timezones.length;
        timezones = timezones.slice(0, parseInt(limit));
        
        res.json({
            timezones: timezones,
            total: total,
            showing: timezones.length,
            filtered: filtered,
            filters: {
                region: region || null,
                search: search || null,
                limit: parseInt(limit)
            }
        });
        
    } catch (error) {
        console.error('Error listing timezones:', error);
        res.status(500).json({ 
            error: 'Failed to list timezones',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/time-sync/available-systems:
 *   get:
 *     summary: Get available time sync systems
 *     description: Returns information about available time sync systems and their installation status
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Available systems retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current:
 *                   type: object
 *                   properties:
 *                     service:
 *                       type: string
 *                       enum: [ntp, chrony, ntpsec, none]
 *                     status:
 *                       type: string
 *                       enum: [available, disabled, unavailable]
 *                     available:
 *                       type: boolean
 *                 available:
 *                   type: object
 *                   additionalProperties:
 *                     type: object
 *                     properties:
 *                       package_name:
 *                         type: string
 *                       service_name:
 *                         type: string
 *                       config_file:
 *                         type: string
 *                       installed:
 *                         type: boolean
 *                       enabled:
 *                         type: boolean
 *                       active:
 *                         type: boolean
 *                       can_switch_to:
 *                         type: boolean
 *                 recommendations:
 *                   type: object
 *       500:
 *         description: Failed to get available systems
 */
export const getAvailableTimeSyncSystems = async (req, res) => {
    try {
        const systemsInfo = await detectAvailableTimeSyncSystems();
        
        res.json(systemsInfo);
        
    } catch (error) {
        console.error('Error getting available time sync systems:', error);
        res.status(500).json({ 
            error: 'Failed to get available time sync systems',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /system/time-sync/switch:
 *   post:
 *     summary: Switch time sync system
 *     description: Switches between different time synchronization systems (NTP, Chrony, NTPsec, or none)
 *     tags: [Time Synchronization]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - target_system
 *             properties:
 *               target_system:
 *                 type: string
 *                 enum: [ntp, chrony, ntpsec, none]
 *                 description: Target time sync system to switch to
 *               preserve_servers:
 *                 type: boolean
 *                 default: true
 *                 description: Attempt to migrate server list from current config
 *               install_if_needed:
 *                 type: boolean
 *                 default: true
 *                 description: Install target package if not present
 *               created_by:
 *                 type: string
 *                 default: "api"
 *     responses:
 *       202:
 *         description: System switch task created
 *       400:
 *         description: Invalid request or target system
 *       409:
 *         description: Cannot switch to requested system
 */
export const switchTimeSyncSystem = async (req, res) => {
    try {
        const { target_system, preserve_servers = true, install_if_needed = true, created_by = 'api' } = req.body;
        
        if (!target_system || !['ntp', 'chrony', 'ntpsec', 'none'].includes(target_system)) {
            return res.status(400).json({ 
                error: 'target_system is required and must be one of: ntp, chrony, ntpsec, none' 
            });
        }
        
        // Get current system info
        const systemsInfo = await detectAvailableTimeSyncSystems();
        const currentSystem = systemsInfo.current.service;
        
        // Check if already using target system
        if (currentSystem === target_system) {
            return res.status(400).json({
                error: `Already using ${target_system}`,
                current_system: currentSystem,
                target_system: target_system
            });
        }
        
        // Check if we can switch to target system
        if (target_system !== 'none') {
            const targetInfo = systemsInfo.available[target_system];
            if (!targetInfo) {
                return res.status(400).json({
                    error: `Unknown target system: ${target_system}`
                });
            }
            
            if (!targetInfo.can_switch_to) {
                return res.status(409).json({
                    error: `Cannot switch to ${target_system}`,
                    details: `System is not available for switching`,
                    target_info: targetInfo
                });
            }
            
            // If package is not installed and install_if_needed is false
            if (!targetInfo.installed && !install_if_needed) {
                return res.status(409).json({
                    error: `Cannot switch to ${target_system}`,
                    details: `Package ${targetInfo.package_name} is not installed and install_if_needed is false`,
                    requires_installation: true
                });
            }
        }
        
        // Create task for system switch
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'switch_time_sync_system',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    current_system: currentSystem,
                    target_system: target_system,
                    preserve_servers: preserve_servers,
                    install_if_needed: install_if_needed,
                    systems_info: systemsInfo
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });
        
        // Estimate duration based on what needs to be done
        let estimatedDuration = '30-60 seconds';
        if (target_system !== 'none') {
            const targetInfo = systemsInfo.available[target_system];
            if (!targetInfo.installed && install_if_needed) {
                estimatedDuration = '2-5 minutes';
            }
        }
        
        res.status(202).json({
            success: true,
            message: `Time sync system switch task created: ${currentSystem} → ${target_system}`,
            task_id: task.id,
            current_system: currentSystem,
            target_system: target_system,
            requires_installation: target_system !== 'none' ? !systemsInfo.available[target_system]?.installed : false,
            estimated_duration: estimatedDuration
        });
        
    } catch (error) {
        console.error('Error switching time sync system:', error);
        res.status(500).json({ 
            error: 'Failed to create time sync system switch task',
            details: error.message 
        });
    }
};
