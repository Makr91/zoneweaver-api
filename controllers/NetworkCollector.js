/**
 * @fileoverview Network Data Collection Controller for Zoneweaver API
 * @description Collects network interface information, statistics, and usage data from OmniOS dladm commands
 * @author makr91

 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec, execSync } from "child_process";
import util from "util";
import os from "os";
import config from "../config/ConfigLoader.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import NetworkStats from "../models/NetworkStatsModel.js";
import NetworkUsage from "../models/NetworkUsageModel.js";
import IPAddresses from "../models/IPAddressModel.js";
import Routes from "../models/RoutingTableModel.js";
import HostInfo from "../models/HostInfoModel.js";

const execProm = util.promisify(exec);

/**
 * Network Data Collector Class
 * @description Handles collection of network interface configuration, statistics, and usage data
 */
class NetworkCollector {
    constructor() {
        this.hostMonitoringConfig = config.getHostMonitoring();
        this.hostname = os.hostname();
        this.isCollecting = false;
        this.errorCount = 0;
        this.lastErrorReset = Date.now();
    }

    /**
     * Initialize network accounting if not already enabled
     * @description Enables network accounting using acctadm if auto_enable_network_accounting is true
     */
    async initializeNetworkAccounting() {
        if (!this.hostMonitoringConfig.auto_enable_network_accounting) {
            return false;
        }

        try {
            // Check if network accounting is already enabled
            const { stdout } = await execProm('pfexec acctadm net', { timeout: 10000 });
            
            if (stdout.includes('Net accounting: active')) {
                await this.updateHostInfo({ network_acct_enabled: true });
                return true;
            }

            // Enable network accounting
            const acctFile = this.hostMonitoringConfig.network_accounting_file;
            
            await execProm(`pfexec acctadm -e basic -f ${acctFile} net`, { timeout: 10000 });
            
            // Verify it was enabled
            const { stdout: verifyOutput } = await execProm('pfexec acctadm net', { timeout: 10000 });
            const enabled = verifyOutput.includes('Net accounting: active');
            
            await this.updateHostInfo({ 
                network_acct_enabled: enabled,
                network_acct_file: enabled ? acctFile : null
            });

            if (enabled) {
                return true;
            } else {
                console.warn('⚠️  Network accounting enable command succeeded but verification failed');
                return false;
            }

        } catch (error) {
            console.error('❌ Failed to initialize network accounting:', error.message);
            await this.updateHostInfo({ 
                network_acct_enabled: false,
                last_error_message: `Network accounting init failed: ${error.message}`
            });
            return false;
        }
    }

    /**
     * Update host information record
     * @param {Object} updates - Fields to update
     */
    async updateHostInfo(updates) {
        try {
            await HostInfo.upsert({
                host: this.hostname,
                hostname: this.hostname,
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                uptime: Math.floor(os.uptime()),
                ...updates,
                updated_at: new Date()
            });
        } catch (error) {
            console.error('❌ Failed to update host info:', error.message);
        }
    }

    /**
     * Handle collection errors
     * @param {Error} error - The error that occurred
     * @param {string} operation - The operation that failed
     */
    async handleError(error, operation) {
        this.errorCount++;
        
        const now = Date.now();
        const timeSinceLastReset = now - this.lastErrorReset;
        const resetInterval = this.hostMonitoringConfig.error_handling.reset_error_count_after * 1000;
        
        // Reset error count if enough time has passed
        if (timeSinceLastReset > resetInterval) {
            this.errorCount = 1;
            this.lastErrorReset = now;
        }

        const maxErrors = this.hostMonitoringConfig.error_handling.max_consecutive_errors;
        const errorMessage = `${operation} failed: ${error.message}`;
        
        console.error(`❌ Network collection error (${this.errorCount}/${maxErrors}): ${errorMessage}`);

        await this.updateHostInfo({
            network_scan_errors: this.errorCount,
            last_error_message: errorMessage
        });

        if (this.errorCount >= maxErrors) {
            console.error(`🚫 Network collector disabled due to ${maxErrors} consecutive errors`);
            return false; // Signal to disable collector
        }

        return true; // Continue collecting
    }

    /**
     * Reset error count on successful operation
     */
    async resetErrorCount() {
        if (this.errorCount > 0) {
            this.errorCount = 0;
            await this.updateHostInfo({
                network_scan_errors: 0,
                last_error_message: null
            });
        }
    }

    /**
     * Parse dladm show-vnic output (parseable format)
     * @param {string} output - Command output from dladm show-vnic -p -o LINK,OVER,SPEED,MACADDRESS,MACADDRTYPE,VID,ZONE
     * @returns {Array} Parsed interface data
     */
    parseVnicParseable(output) {
        const lines = output.trim().split('\n');
        const interfaces = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Split by colon, but handle escaped colons in MAC addresses
            const parts = trimmed.split(':');
            if (parts.length >= 7) {
                // Handle escaped MAC address format (f2\:2\:0\:1\:0\:1 becomes f2:2:0:1:0:1)
                const macParts = [];
                let macStart = 3; // MAC address starts at index 3
                let macEnd = macStart;
                
                // Find where the MAC address ends (look for 'fixed' or 'random')
                for (let i = macStart; i < parts.length; i++) {
                    if (parts[i] === 'fixed' || parts[i] === 'random') {
                        macEnd = i;
                        break;
                    }
                }
                
                // Reconstruct MAC address
                const macAddress = parts.slice(macStart, macEnd).join(':').replace(/\\/g, '');
                
                interfaces.push({
                    host: this.hostname,
                    link: parts[0],
                    class: 'vnic',
                    over: parts[1],
                    speed: parseInt(parts[2]) || null,
                    macaddress: macAddress,
                    macaddrtype: parts[macEnd], // 'fixed' or 'random'
                    vid: parseInt(parts[macEnd + 1]) || null,
                    zone: parts[macEnd + 2] !== '--' ? parts[macEnd + 2] : null,
                    scan_timestamp: new Date()
                });
            }
        }
        
        return interfaces;
    }

    /**
     * Parse dladm show-vnic output (legacy table format)
     * @param {string} output - Command output
     * @returns {Array} Parsed interface data
     */
    parseVnicOutput(output) {
        const lines = output.trim().split('\n');
        const interfaces = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 6) {
                interfaces.push({
                    host: this.hostname,
                    link: parts[0],
                    class: 'vnic',
                    over: parts[1],
                    speed: parseInt(parts[2]) || null,
                    macaddress: parts[3],
                    macaddrtype: parts[4],
                    vid: parseInt(parts[5]) || null,
                    zone: parts[6] || null,
                    scan_timestamp: new Date()
                });
            }
        }
        
        return interfaces;
    }

    /**
     * Parse dladm show-ether output
     * @param {string} output - Command output
     * @returns {Array} Parsed interface data
     */
    parseEtherOutput(output) {
        const lines = output.trim().split('\n');
        const interfaces = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 5) {
                interfaces.push({
                    host: this.hostname,
                    link: parts[0],
                    ptype: parts[1],
                    state: parts[2],
                    auto: parts[3],
                    speed: parts[4].includes('G') ? parseInt(parts[4]) * 1000 : parseInt(parts[4]) || null,
                    duplex: parts[4].includes('-h') ? 'half' : parts[4].includes('-f') ? 'full' : null,
                    pause: parts[5] || null,
                    scan_timestamp: new Date()
                });
            }
        }
        
        return interfaces;
    }

    /**
     * Parse dladm show-phys output
     * @param {string} output - Command output
     * @returns {Array} Parsed interface data
     */
    parsePhysOutput(output) {
        const lines = output.trim().split('\n');
        const interfaces = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 6) {
                interfaces.push({
                    host: this.hostname,
                    link: parts[0],
                    class: 'phys',
                    media: parts[1],
                    state: parts[2],
                    speed: parseInt(parts[3]) || null,
                    duplex: parts[4],
                    device: parts[5],
                    scan_timestamp: new Date()
                });
            }
        }
        
        return interfaces;
    }

    /**
     * Parse dladm show-link output
     * @param {string} output - Command output
     * @returns {Array} Parsed interface data
     */
    parseLinkOutput(output) {
        const lines = output.trim().split('\n');
        const interfaces = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Skip header lines - check for common header keywords
            if (trimmed.includes('LINK') && (trimmed.includes('CLASS') || trimmed.includes('MTU') || trimmed.includes('STATE'))) {
                continue;
            }
            
            // Skip separator lines
            if (trimmed.includes('---') || trimmed.includes('===')) {
                continue;
            }
            
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 5) {
                // Additional validation - skip if first part looks like a header
                if (parts[0] === 'LINK' || parts[0].includes('LINK')) {
                    continue;
                }
                
                interfaces.push({
                    host: this.hostname,
                    link: parts[0],
                    class: parts[1],
                    mtu: parseInt(parts[2]) || null,
                    state: parts[3],
                    bridge: parts[4] !== '--' ? parts[4] : null,
                    over: parts[5] !== '--' ? parts[5] : null,
                    scan_timestamp: new Date()
                });
            }
        }
        
        return interfaces;
    }

    /**
     * Parse dladm show-link -s output (statistics)
     * @param {string} output - Command output
     * @returns {Array} Parsed statistics data
     */
    parseStatsOutput(output) {
        const lines = output.trim().split('\n');
        const stats = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 7) {
                stats.push({
                    host: this.hostname,
                    link: parts[0],
                    ipackets: parts[1],
                    rbytes: parts[2],
                    ierrors: parts[3],
                    opackets: parts[4],
                    obytes: parts[5],
                    oerrors: parts[6],
                    scan_timestamp: new Date()
                });
            }
        }
        
        return stats;
    }

    /**
     * Parse dladm show-usage output
     * @param {string} output - Command output
     * @returns {Array} Parsed usage data
     */
    parseUsageOutput(output) {
        const lines = output.trim().split('\n');
        const usage = [];
        
        let headerFound = false;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Skip header line - look for the line with column headers
            if (trimmed.includes('LINK') && trimmed.includes('DURATION') && trimmed.includes('BANDWIDTH')) {
                headerFound = true;
                continue;
            }
            
            // Skip lines until we find the header
            if (!headerFound) continue;
            
            // Skip separator lines
            if (trimmed.includes('---')) continue;
            
            // Parse data lines - use more careful parsing to handle long interface names
            const parts = trimmed.split(/\s+/);
            
            // Need at least 7 parts for valid data
            if (parts.length >= 7) {
                const linkName = parts[0];
                
                // Skip header data that might have been parsed as a row
                if (linkName === 'LINK' || linkName.includes('DURATION') || linkName.includes('BANDWIDTH')) {
                    continue;
                }
                
                // Extract bandwidth string and parse numeric value
                const bandwidthStr = parts.slice(6).join(' ');
                const bandwidthMatch = bandwidthStr.match(/([0-9.]+)\s*Mbps/);
                const bandwidthMbps = bandwidthMatch ? parseFloat(bandwidthMatch[1]) : null;
                
                usage.push({
                    host: this.hostname,
                    link: linkName,
                    duration: parseInt(parts[1]) || null,
                    ipackets: parts[2],
                    rbytes: parts[3],
                    opackets: parts[4],
                    obytes: parts[5],
                    bandwidth: bandwidthStr,
                    bandwidth_mbps: bandwidthMbps,
                    scan_timestamp: new Date()
                });
            }
        }
        
        return usage;
    }

    /**
     * Parse ipadm show-addr output
     * @param {string} output - Command output
     * @returns {Array} Parsed IP address data
     */
    parseIPAddrOutput(output) {
        const lines = output.trim().split('\n');
        const addresses = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                const addrobj = parts[0];
                const interfaceName = addrobj.split('/')[0];
                const ipVersion = addrobj.includes('/v6') ? 'v6' : 'v4';
                const addr = parts[3];
                
                // Parse IP and prefix
                let ipAddress = addr;
                let prefixLength = null;
                
                if (addr.includes('/')) {
                    const addrParts = addr.split('/');
                    ipAddress = addrParts[0];
                    prefixLength = parseInt(addrParts[1]) || null;
                }
                
                addresses.push({
                    host: this.hostname,
                    addrobj: addrobj,
                    interface: interfaceName,
                    type: parts[1],
                    state: parts[2],
                    addr: addr,
                    ip_address: ipAddress,
                    prefix_length: prefixLength,
                    ip_version: ipVersion,
                    scan_timestamp: new Date()
                });
            }
        }
        
        return addresses;
    }

    /**
     * Parse netstat -rn output
     * @param {string} output - Command output
     * @returns {Array} Parsed routing table data
     */
    parseRoutingOutput(output) {
        const lines = output.trim().split('\n');
        const routes = [];
        
        let currentIPVersion = null;
        let inDataSection = false;
        
        for (const line of lines) {
            const trimmed = line.trim();
            
            // Detect IP version sections
            if (trimmed.includes('Routing Table: IPv4')) {
                currentIPVersion = 'v4';
                inDataSection = false;
                continue;
            } else if (trimmed.includes('Routing Table: IPv6')) {
                currentIPVersion = 'v6';
                inDataSection = false;
                continue;
            }
            
            // Skip header lines
            if (trimmed.includes('Destination') || trimmed.includes('---') || !trimmed) {
                if (trimmed.includes('Destination')) {
                    inDataSection = true;
                }
                continue;
            }
            
            if (!inDataSection || !currentIPVersion) continue;
            
            const parts = trimmed.split(/\s+/);
            
            if (currentIPVersion === 'v4' && parts.length >= 6) {
                const destination = parts[0];
                const gateway = parts[1];
                const flags = parts[2];
                const ref = parseInt(parts[3]) || null;
                const use = parts[4];
                const interfaceName = parts[5];
                
                routes.push({
                    host: this.hostname,
                    destination: destination,
                    gateway: gateway,
                    flags: flags,
                    ref: ref,
                    use: use,
                    interface: interfaceName,
                    ip_version: currentIPVersion,
                    is_default: destination === 'default',
                    scan_timestamp: new Date()
                });
            } else if (currentIPVersion === 'v6' && parts.length >= 6) {
                const destinationMask = parts[0];
                const gateway = parts[1];
                const flags = parts[2];
                const ref = parseInt(parts[3]) || null;
                const use = parts[4];
                const interfaceName = parts[5];
                
                routes.push({
                    host: this.hostname,
                    destination: destinationMask,
                    destination_mask: destinationMask,
                    gateway: gateway,
                    flags: flags,
                    ref: ref,
                    use: use,
                    interface: interfaceName,
                    ip_version: currentIPVersion,
                    is_default: destinationMask === 'default' || destinationMask === '::/0',
                    scan_timestamp: new Date()
                });
            }
        }
        
        return routes;
    }

    /**
     * Collect IP address information
     * @description Gathers IP address assignments from ipadm show-addr
     */
    async collectIPAddresses() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const { stdout } = await execProm('pfexec ipadm show-addr', { timeout });
            
            const ipData = this.parseIPAddrOutput(stdout);
            
            if (ipData.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < ipData.length; i += batchSize) {
                    const batch = ipData.slice(i, i + batchSize);
                    await IPAddresses.bulkCreate(batch, {
                        updateOnDuplicate: Object.keys(IPAddresses.rawAttributes).filter(key => key !== 'id')
                    });
                }
            }

            return ipData;

        } catch (error) {
            console.warn('⚠️  Failed to collect IP addresses:', error.message);
            return [];
        }
    }

    /**
     * Collect routing table information
     * @description Gathers routing table from netstat -rn
     */
    async collectRoutingTable() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const { stdout } = await execProm('netstat -rn', { timeout });
            
            const routeData = this.parseRoutingOutput(stdout);
            
            if (routeData.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < routeData.length; i += batchSize) {
                    const batch = routeData.slice(i, i + batchSize);
                    await Routes.bulkCreate(batch, {
                        updateOnDuplicate: Object.keys(Routes.rawAttributes).filter(key => key !== 'id')
                    });
                }
            }

            return routeData;

        } catch (error) {
            console.warn('⚠️  Failed to collect routing table:', error.message);
            return [];
        }
    }

    /**
     * Parse dladm show-aggr output 
     * @param {string} output - Command output
     * @returns {Array} Parsed aggregate data
     */
    parseAggregateOutput(output) {
        const lines = output.trim().split('\n');
        const aggregates = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 6) {
                aggregates.push({
                    host: this.hostname,
                    link: parts[0],
                    class: 'aggr',
                    policy: parts[1],
                    address_policy: parts[2], 
                    lacp_activity: parts[3],
                    lacp_timer: parts[4],
                    flags: parts[5],
                    scan_timestamp: new Date()
                });
            }
        }
        
        return aggregates;
    }

    /**
     * Collect aggregate configuration
     * @description Gathers aggregate configuration from dladm show-aggr
     */
    async collectAggregateConfig() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // Get basic aggregate configuration
            const { stdout: aggrOutput } = await execProm('pfexec dladm show-aggr', { timeout });
            const aggrData = this.parseAggregateOutput(aggrOutput);
            
            // For each aggregate, get detailed information
            for (const aggr of aggrData) {
                try {
                    // Get extended information with port details
                    const { stdout: extendedOutput } = await execProm(`pfexec dladm show-aggr ${aggr.link} -x -p -o link,port,speed,duplex,state,address,portstate`, { timeout });
                    
                    let aggregateSpeed = null;
                    let aggregateState = 'unknown';
                    let aggregateAddress = null;
                    let portList = [];
                    let ports = [];

                    if (extendedOutput.trim()) {
                        const portLines = extendedOutput.split('\n').filter(line => line.trim());
                        
                        portLines.forEach(line => {
                            const [linkName, port, speed, duplex, portState, address, portStateInfo] = line.split(':');
                            
                            if (!port) {
                                // This is the aggregate summary line
                                aggregateSpeed = speed ? parseInt(speed.replace('Mb', '')) || null : null;
                                aggregateState = portState || 'unknown';
                                aggregateAddress = address ? address.replace(/\\/g, '') : null;
                            } else {
                                // This is a port line
                                ports.push({
                                    port,
                                    speed: speed ? parseInt(speed.replace('Mb', '')) || null : null,
                                    duplex,
                                    state: portState,
                                    address: address ? address.replace(/\\/g, '') : null,
                                    port_state: portStateInfo
                                });
                                portList.push(port);
                            }
                        });
                    }

                    // Get LACP information
                    try {
                        const { stdout: lacpOutput } = await execProm(`pfexec dladm show-aggr ${aggr.link} -L -p -o link,port,aggregatable,sync,coll,dist,defaulted,expired`, { timeout });
                        
                        let lacpInfo = [];
                        if (lacpOutput.trim()) {
                            const lacpLines = lacpOutput.split('\n').filter(line => line.trim());
                            
                            lacpLines.forEach(line => {
                                const [linkName, port, aggregatable, sync, coll, dist, defaulted, expired] = line.split(':');
                                lacpInfo.push({
                                    port,
                                    aggregatable: aggregatable === 'yes',
                                    sync: sync === 'yes',
                                    collecting: coll === 'yes',
                                    distributing: dist === 'yes',
                                    defaulted: defaulted === 'yes',
                                    expired: expired === 'yes'
                                });
                            });
                        }

                        // Store detailed LACP info as JSON
                        if (lacpInfo.length > 0) {
                            aggr.lacp_detail = JSON.stringify(lacpInfo);
                        }
                    } catch (lacpError) {
                        console.warn(`⚠️  Failed to get LACP info for ${aggr.link}:`, lacpError.message);
                    }

                    // Update aggregate record with detailed information
                    aggr.speed = aggregateSpeed;
                    aggr.state = aggregateState;
                    aggr.macaddress = aggregateAddress;
                    aggr.over = portList.length > 0 ? portList.join(',') : null;
                    
                    // Store port details as JSON
                    if (ports.length > 0) {
                        aggr.ports_detail = JSON.stringify(ports);
                    }

                } catch (detailError) {
                    console.warn(`⚠️  Failed to get detailed info for aggregate ${aggr.link}:`, detailError.message);
                }
            }

            return aggrData;

        } catch (error) {
            console.warn('⚠️  Failed to collect aggregate data:', error.message);
            return [];
        }
    }

    /**
     * Collect network interface configuration
     * @description Gathers interface configuration from various dladm commands
     */
    async collectNetworkConfig() {
        if (this.isCollecting) {
            return;
        }

        this.isCollecting = true;

        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const allInterfaces = [];

            // Collect VNIC information using parseable format for better accuracy
            try {
                const { stdout: vnicOutput } = await execProm('pfexec dladm show-vnic -p -o LINK,OVER,SPEED,MACADDRESS,MACADDRTYPE,VID,ZONE', { timeout });
                const vnicData = this.parseVnicParseable(vnicOutput);
                allInterfaces.push(...vnicData);
            } catch (error) {
                console.warn('⚠️  Failed to collect VNIC data with parseable format, trying legacy format:', error.message);
                // Fallback to legacy format
                try {
                    const { stdout: vnicOutput } = await execProm('pfexec dladm show-vnic', { timeout });
                    const vnicData = this.parseVnicOutput(vnicOutput);
                    allInterfaces.push(...vnicData);
                } catch (fallbackError) {
                    console.warn('⚠️  Failed to collect VNIC data with legacy format:', fallbackError.message);
                }
            }

            // Collect Ethernet information
            try {
                const { stdout: etherOutput } = await execProm('pfexec dladm show-ether', { timeout });
                const etherData = this.parseEtherOutput(etherOutput);
                
                // Merge with existing interfaces or add new ones
                etherData.forEach(etherInterface => {
                    const existing = allInterfaces.find(iface => iface.link === etherInterface.link);
                    if (existing) {
                        Object.assign(existing, etherInterface);
                    } else {
                        allInterfaces.push(etherInterface);
                    }
                });
            } catch (error) {
                console.warn('⚠️  Failed to collect Ethernet data:', error.message);
            }

            // Collect Physical interface information
            try {
                const { stdout: physOutput } = await execProm('pfexec dladm show-phys', { timeout });
                const physData = this.parsePhysOutput(physOutput);
                
                // Merge with existing interfaces or add new ones
                physData.forEach(physInterface => {
                    const existing = allInterfaces.find(iface => iface.link === physInterface.link);
                    if (existing) {
                        Object.assign(existing, physInterface);
                    } else {
                        allInterfaces.push(physInterface);
                    }
                });
            } catch (error) {
                console.warn('⚠️  Failed to collect Physical interface data:', error.message);
            }

            // Collect Link information
            try {
                const { stdout: linkOutput } = await execProm('pfexec dladm show-link', { timeout });
                const linkData = this.parseLinkOutput(linkOutput);
                
                // Merge with existing interfaces or add new ones - PRESERVE aggregate-specific data
                linkData.forEach(linkInterface => {
                    const existing = allInterfaces.find(iface => iface.link === linkInterface.link);
                    if (existing) {
                        // Only merge non-null values and don't overwrite aggregate-specific fields
                        Object.keys(linkInterface).forEach(key => {
                            // Skip aggregate-specific fields to prevent overwriting
                            if (existing.class === 'aggr' && [
                                'policy', 'address_policy', 'lacp_activity', 'lacp_timer', 
                                'flags', 'ports_detail', 'lacp_detail', 'speed', 'state', 'macaddress'
                            ].includes(key)) {
                                return; // Don't overwrite these fields for aggregates
                            }
                            
                            // Only assign if the new value is not null/undefined and existing is null/undefined
                            if (linkInterface[key] != null && (existing[key] == null || existing[key] === '')) {
                                existing[key] = linkInterface[key];
                            }
                        });
                    } else {
                        allInterfaces.push(linkInterface);
                    }
                });
            } catch (error) {
                console.warn('⚠️  Failed to collect Link data:', error.message);
            }

            // Collect Aggregate information
            try {
                const aggregateData = await this.collectAggregateConfig();
                
                if (aggregateData.length > 0) {
                    // Remove any existing aggregate entries from allInterfaces to prevent duplicates
                    const aggregateLinks = aggregateData.map(aggr => aggr.link);
                    const filteredInterfaces = allInterfaces.filter(iface => 
                        !aggregateLinks.includes(iface.link) || iface.class !== 'aggr'
                    );
                    
                    // Add comprehensive aggregate data
                    filteredInterfaces.push(...aggregateData);
                    allInterfaces.length = 0; // Clear array
                    allInterfaces.push(...filteredInterfaces); // Repopulate
                }
            } catch (error) {
                console.warn('⚠️  Failed to collect Aggregate data:', error.message);
            }

            // Remove duplicate etherstubs, VLANs, and other interface types
            const uniqueInterfaces = new Map();
            
            allInterfaces.forEach(iface => {
                const key = `${iface.host}:${iface.link}:${iface.class}`;
                if (!uniqueInterfaces.has(key)) {
                    uniqueInterfaces.set(key, iface);
                } else {
                    // If we have a duplicate, merge the data (keep non-null values)
                    const existing = uniqueInterfaces.get(key);
                    Object.keys(iface).forEach(prop => {
                        if (iface[prop] != null && (existing[prop] == null || existing[prop] === '')) {
                            existing[prop] = iface[prop];
                        }
                    });
                }
            });
            
            // Replace allInterfaces with deduplicated data
            allInterfaces.length = 0;
            allInterfaces.push(...Array.from(uniqueInterfaces.values()));

            // Remove existing records for interfaces we're about to update to prevent duplicates
            if (allInterfaces.length > 0) {
                const interfaceLinks = allInterfaces.map(iface => iface.link);
                await NetworkInterfaces.destroy({
                    where: {
                        host: this.hostname,
                        link: interfaceLinks
                    }
                });
            }

            // Store in database in batches
            const batchSize = this.hostMonitoringConfig.performance.batch_size;
            for (let i = 0; i < allInterfaces.length; i += batchSize) {
                const batch = allInterfaces.slice(i, i + batchSize);
                await NetworkInterfaces.bulkCreate(batch);
            }

            // Collect IP addresses and routing table
            const ipData = await this.collectIPAddresses();
            const routeData = await this.collectRoutingTable();

            await this.updateHostInfo({ last_network_scan: new Date() });
            await this.resetErrorCount();
            
        } catch (error) {
            const shouldContinue = await this.handleError(error, 'Network config collection');
            if (!shouldContinue) {
                this.isCollecting = false;
                return false;
            }
        } finally {
            this.isCollecting = false;
        }

        return true;
    }

    /**
     * Collect network statistics
     * @description Gathers traffic statistics from dladm show-link -s
     */
    async collectNetworkStats() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const { stdout } = await execProm('dladm show-link -s', { timeout });
            
            const statsData = this.parseStatsOutput(stdout);
            
            if (statsData.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < statsData.length; i += batchSize) {
                    const batch = statsData.slice(i, i + batchSize);
                    await NetworkStats.bulkCreate(batch);
                }
                
                await this.updateHostInfo({ last_network_stats_scan: new Date() });
            }

            await this.resetErrorCount();
            return true;

        } catch (error) {
            const shouldContinue = await this.handleError(error, 'Network stats collection');
            return shouldContinue;
        }
    }

    /**
     * Check if interface name appears to be truncated and find matches
     * @param {string} linkName - The interface name from usage output
     * @param {Array} allInterfaces - All known interfaces from configuration
     * @returns {Array} Array of possible full interface names
     */
    findPossibleFullInterfaceNames(linkName, allInterfaces) {
        // If the link name already exists exactly, return it
        if (allInterfaces.some(iface => iface.link === linkName)) {
            return [linkName];
        }
        
        // Find interfaces that start with this truncated name
        const matches = allInterfaces
            .filter(iface => iface.link.startsWith(linkName))
            .map(iface => iface.link);
            
        return matches.length > 0 ? matches : [linkName];
    }

    /**
     * Correlate usage data with full interface names
     * @param {Array} usageData - Usage data with potentially truncated names
     * @param {Array} allInterfaces - All known interfaces from configuration
     * @returns {Array} Usage data with correlation information
     */
    correlateUsageWithInterfaces(usageData, allInterfaces) {
        const correlatedData = [];
        const usageGrouped = new Map();
        
        // Group usage entries by link name
        usageData.forEach(usage => {
            if (!usageGrouped.has(usage.link)) {
                usageGrouped.set(usage.link, []);
            }
            usageGrouped.get(usage.link).push(usage);
        });
        
        // Process each unique link name
        usageGrouped.forEach((usageEntries, linkName) => {
            const possibleMatches = this.findPossibleFullInterfaceNames(linkName, allInterfaces);
            
            if (possibleMatches.length === 1) {
                // Direct match or exact truncated name
                usageEntries.forEach(usage => {
                    correlatedData.push({
                        ...usage,
                        full_interface_name: possibleMatches[0],
                        is_truncated: possibleMatches[0] !== linkName,
                        match_confidence: 'high'
                    });
                });
            } else if (possibleMatches.length > 1) {
                // Multiple possible matches - this indicates truncation
                // Distribute the usage entries among the possible matches
                // For now, we'll create separate entries with distributed data
                usageEntries.forEach((usage, index) => {
                    if (index < possibleMatches.length) {
                        // Assign to a specific interface
                        correlatedData.push({
                            ...usage,
                            full_interface_name: possibleMatches[index],
                            is_truncated: true,
                            match_confidence: 'medium',
                            truncation_note: `One of ${possibleMatches.length} possible matches: ${possibleMatches.join(', ')}`
                        });
                    } else {
                        // Extra entries get assigned to first interface with a note
                        correlatedData.push({
                            ...usage,
                            full_interface_name: possibleMatches[0],
                            is_truncated: true,
                            match_confidence: 'low',
                            truncation_note: `Extra entry - may represent aggregated data for: ${possibleMatches.join(', ')}`
                        });
                    }
                });
            } else {
                // No matches found - keep original
                usageEntries.forEach(usage => {
                    correlatedData.push({
                        ...usage,
                        full_interface_name: linkName,
                        is_truncated: false,
                        match_confidence: 'unknown'
                    });
                });
            }
        });
        
        return correlatedData;
    }

    /**
     * Collect network usage data for a specific interface
     * @param {string} interfaceName - The full interface name
     * @param {string} acctFile - Path to accounting file
     * @param {number} timeout - Command timeout in milliseconds
     * @returns {Object|null} Usage data for the interface
     */
    async collectSingleInterfaceUsage(interfaceName, acctFile, timeout) {
        try {
            // Try summary data first (without -a flag)
            let stdout;
            try {
                const result = await execProm(`pfexec dladm show-usage -f ${acctFile} ${interfaceName}`, { timeout });
                stdout = result.stdout;
            } catch (summaryError) {
                // If summary fails, try with -a flag to get all records
                if (summaryError.message.includes('no records') || summaryError.message.includes('not found')) {
                    return null;
                }
                
                // Try with -a flag for detailed records
                try {
                    const result = await execProm(`pfexec dladm show-usage -a -f ${acctFile} ${interfaceName}`, { timeout });
                    stdout = result.stdout;
                } catch (detailedError) {
                    if (detailedError.message.includes('no records') || detailedError.message.includes('not found')) {
                        return null;
                    }
                    throw detailedError;
                }
            }
            
            if (!stdout || !stdout.trim()) {
                return null; // No usage data for this interface
            }
            
            // Parse the output
            const usageData = this.parseUsageOutput(stdout);
            
            if (usageData.length > 0) {
                // Override the potentially truncated link name with the actual interface name
                const usage = usageData[0]; // Take the first entry
                usage.link = interfaceName; // Use the full interface name we queried
                return usage;
            }
            
            return null;
            
        } catch (error) {
            // Interface might not have usage data yet, which is normal
            if (error.message.includes('no records') || 
                error.message.includes('not found') ||
                error.message.includes('invalid link')) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Calculate bandwidth utilization percentage
     * @param {string} bytes - Bytes transferred
     * @param {number} speedMbps - Interface speed in Mbps
     * @param {number} timePeriod - Time period in seconds
     * @returns {number|null} Utilization percentage
     */
    calculateBandwidthUtilization(bytes, speedMbps, timePeriod) {
        if (!bytes || !speedMbps || !timePeriod || speedMbps === 0) return null;
        
        const bytesNum = parseInt(bytes) || 0;
        
        // Validate inputs to prevent NaN
        if (isNaN(bytesNum) || isNaN(speedMbps) || isNaN(timePeriod)) {
            console.warn('⚠️  Invalid inputs in bandwidth utilization calculation');
            return null;
        }
        
        const bitsTransferred = bytesNum * 8; // Convert bytes to bits
        const maxBits = speedMbps * 1000000 * timePeriod; // Max bits in time period
        
        if (maxBits === 0) return null;
        
        const utilization = (bitsTransferred / maxBits) * 100;
        
        // Validate result to prevent NaN
        if (isNaN(utilization)) {
            console.warn('⚠️  NaN result in bandwidth utilization calculation');
            return null;
        }
        
        return Math.round(utilization * 100) / 100; // Round to 2 decimal places
    }

    /**
     * Calculate instantaneous bandwidth from byte counters
     * @param {Object} currentStats - Current interface statistics
     * @param {Object} previousStats - Previous interface statistics  
     * @returns {Object} Calculated bandwidth information
     */
    calculateInstantaneousBandwidth(currentStats, previousStats) {
        if (!previousStats) {
            return {
                rx_bps: null,
                tx_bps: null,
                rx_mbps: null,
                tx_mbps: null,
                time_delta: null
            };
        }

        // Ensure timestamps are valid Date objects
        const currentTime = new Date(currentStats.scan_timestamp).getTime();
        const previousTime = new Date(previousStats.scan_timestamp).getTime();
        
        if (isNaN(currentTime) || isNaN(previousTime)) {
            console.warn('⚠️  Invalid timestamps in bandwidth calculation');
            return {
                rx_bps: null,
                tx_bps: null,
                rx_mbps: null,
                tx_mbps: null,
                time_delta: null
            };
        }

        const timeDelta = (currentTime - previousTime) / 1000; // seconds
        
        if (timeDelta <= 0) {
            return { 
                rx_bps: null, 
                tx_bps: null, 
                rx_mbps: null, 
                tx_mbps: null, 
                time_delta: timeDelta 
            };
        }

        // Parse byte counters safely
        const currentRxBytes = parseInt(currentStats.rbytes) || 0;
        const previousRxBytes = parseInt(previousStats.rbytes) || 0;
        const currentTxBytes = parseInt(currentStats.obytes) || 0;
        const previousTxBytes = parseInt(previousStats.obytes) || 0;

        const rxBytes = Math.max(0, currentRxBytes - previousRxBytes);
        const txBytes = Math.max(0, currentTxBytes - previousTxBytes);

        const rxBps = rxBytes / timeDelta; // bytes per second
        const txBps = txBytes / timeDelta; // bytes per second
        
        // Validate calculated values and ensure they're not NaN
        const safeRxBps = isNaN(rxBps) ? null : Math.round(Math.max(0, rxBps));
        const safeTxBps = isNaN(txBps) ? null : Math.round(Math.max(0, txBps));
        const safeRxMbps = safeRxBps !== null ? Math.round((safeRxBps * 8 / 1000000) * 100) / 100 : null;
        const safeTxMbps = safeTxBps !== null ? Math.round((safeTxBps * 8 / 1000000) * 100) / 100 : null;
        
        return {
            rx_bps: safeRxBps,
            tx_bps: safeTxBps,
            rx_mbps: safeRxMbps,
            tx_mbps: safeTxMbps,
            time_delta: timeDelta
        };
    }

    /**
     * Collect network usage data using link statistics
     * @description Gathers usage data from dladm show-link -s and calculates bandwidth utilization
     */
    async collectNetworkUsage() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // Get current link statistics
            const { stdout } = await execProm('dladm show-link -s', { timeout });
            const currentStats = this.parseStatsOutput(stdout);
            
            if (currentStats.length === 0) {
                return true;
            }

            // Get interface configuration data for speed information
            let interfaceConfigs = [];
            try {
                interfaceConfigs = await NetworkInterfaces.findAll({
                    where: { host: this.hostname },
                    attributes: ['link', 'speed', 'class'],
                    order: [['scan_timestamp', 'DESC']],
                    limit: 1000
                });
                
                // Create map for quick lookup of interface speeds
                const speedMap = new Map();
                interfaceConfigs.forEach(iface => {
                    if (!speedMap.has(iface.link) && iface.speed) {
                        speedMap.set(iface.link, { 
                            speed: iface.speed, 
                            class: iface.class 
                        });
                    }
                });
                interfaceConfigs = speedMap;
                
            } catch (error) {
                console.warn('⚠️  Could not fetch interface configuration for speed data:', error.message);
                interfaceConfigs = new Map();
            }

            // Get previous statistics for bandwidth calculation
            let previousStatsMap = new Map();
            try {
                const previousStats = await NetworkStats.findAll({
                    where: { host: this.hostname },
                    order: [['scan_timestamp', 'DESC']],
                    limit: interfaceConfigs.size * 2 // Get last 2 entries per interface
                });
                
                // Group by interface and keep only the latest previous entry
                const grouped = new Map();
                previousStats.forEach(stat => {
                    if (!grouped.has(stat.link)) {
                        grouped.set(stat.link, stat);
                    }
                });
                previousStatsMap = grouped;
                
            } catch (error) {
                console.warn('⚠️  Could not fetch previous statistics for bandwidth calculation:', error.message);
            }

            const usageDataResults = [];
            
            // Process each interface's statistics
            for (const currentStat of currentStats) {
                const interfaceConfig = interfaceConfigs.get(currentStat.link);
                const previousStat = previousStatsMap.get(currentStat.link);
                
                // Calculate delta values from previous sample
                let deltaValues = {
                    ipackets_delta: null,
                    rbytes_delta: null,
                    ierrors_delta: null,
                    opackets_delta: null,
                    obytes_delta: null,
                    oerrors_delta: null
                };

                if (previousStat) {
                    // Calculate deltas (difference from previous sample)
                    const currentIPackets = parseInt(currentStat.ipackets) || 0;
                    const previousIPackets = parseInt(previousStat.ipackets) || 0;
                    deltaValues.ipackets_delta = Math.max(0, currentIPackets - previousIPackets);

                    const currentRBytes = parseInt(currentStat.rbytes) || 0;
                    const previousRBytes = parseInt(previousStat.rbytes) || 0;
                    deltaValues.rbytes_delta = Math.max(0, currentRBytes - previousRBytes);

                    const currentIErrors = parseInt(currentStat.ierrors) || 0;
                    const previousIErrors = parseInt(previousStat.ierrors) || 0;
                    deltaValues.ierrors_delta = Math.max(0, currentIErrors - previousIErrors);

                    const currentOPackets = parseInt(currentStat.opackets) || 0;
                    const previousOPackets = parseInt(previousStat.opackets) || 0;
                    deltaValues.opackets_delta = Math.max(0, currentOPackets - previousOPackets);

                    const currentOBytes = parseInt(currentStat.obytes) || 0;
                    const previousOBytes = parseInt(previousStat.obytes) || 0;
                    deltaValues.obytes_delta = Math.max(0, currentOBytes - previousOBytes);

                    const currentOErrors = parseInt(currentStat.oerrors) || 0;
                    const previousOErrors = parseInt(previousStat.oerrors) || 0;
                    deltaValues.oerrors_delta = Math.max(0, currentOErrors - previousOErrors);
                }

                // Calculate instantaneous bandwidth
                const bandwidth = this.calculateInstantaneousBandwidth(currentStat, previousStat);
                
                // Calculate utilization if we have speed info
                let rxUtilization = null;
                let txUtilization = null;
                
                if (interfaceConfig && interfaceConfig.speed && bandwidth.time_delta) {
                    rxUtilization = this.calculateBandwidthUtilization(
                        currentStat.rbytes, 
                        interfaceConfig.speed, 
                        bandwidth.time_delta
                    );
                    txUtilization = this.calculateBandwidthUtilization(
                        currentStat.obytes, 
                        interfaceConfig.speed, 
                        bandwidth.time_delta
                    );
                }

                // Validate and create usage record (ensure no NaN values)
                const safeValue = (value) => {
                    if (value === null || value === undefined) return null;
                    if (isNaN(value)) {
                        console.warn(`⚠️  NaN value detected in usage record for interface ${currentStat.link}`);
                        return null;
                    }
                    return value;
                };

                const usageRecord = {
                    host: this.hostname,
                    link: currentStat.link,
                    
                    // Raw counters (validated)
                    ipackets: currentStat.ipackets || null,
                    rbytes: currentStat.rbytes || null,
                    ierrors: currentStat.ierrors || null,
                    opackets: currentStat.opackets || null,
                    obytes: currentStat.obytes || null,
                    oerrors: currentStat.oerrors || null,
                    
                    // Delta values (validated)
                    ipackets_delta: safeValue(deltaValues.ipackets_delta),
                    rbytes_delta: safeValue(deltaValues.rbytes_delta),
                    ierrors_delta: safeValue(deltaValues.ierrors_delta),
                    opackets_delta: safeValue(deltaValues.opackets_delta),
                    obytes_delta: safeValue(deltaValues.obytes_delta),
                    oerrors_delta: safeValue(deltaValues.oerrors_delta),
                    
                    // Calculated bandwidth (validated)
                    rx_bps: safeValue(bandwidth.rx_bps),
                    tx_bps: safeValue(bandwidth.tx_bps),
                    rx_mbps: safeValue(bandwidth.rx_mbps),
                    tx_mbps: safeValue(bandwidth.tx_mbps),
                    
                    // Utilization percentages (validated)
                    rx_utilization_pct: safeValue(rxUtilization),
                    tx_utilization_pct: safeValue(txUtilization),
                    
                    // Interface information (validated)
                    interface_speed_mbps: interfaceConfig && interfaceConfig.speed ? safeValue(interfaceConfig.speed) : null,
                    interface_class: interfaceConfig ? interfaceConfig.class : null,
                    
                    // Metadata (validated)
                    time_delta_seconds: safeValue(bandwidth.time_delta),
                    scan_timestamp: new Date()
                };
                
                usageDataResults.push(usageRecord);
            }

            // Store collected usage data
            if (usageDataResults.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < usageDataResults.length; i += batchSize) {
                    const batch = usageDataResults.slice(i, i + batchSize);
                    await NetworkUsage.bulkCreate(batch);
                }
                
                await this.updateHostInfo({ last_network_usage_scan: new Date() });
                
                // Log some sample data for verification
                const activeBandwidth = usageDataResults.filter(u => u.rx_mbps > 0 || u.tx_mbps > 0);
                if (activeBandwidth.length > 0) {
                }
            }

            await this.resetErrorCount();
            return true;

        } catch (error) {
            const shouldContinue = await this.handleError(error, 'Network usage collection');
            return shouldContinue;
        }
    }

    /**
     * Clean up old data based on retention policies
     */
    async cleanupOldData() {
        try {
            const retentionConfig = this.hostMonitoringConfig.retention;
            const now = new Date();

            // Clean network stats
            const statsRetentionDate = new Date(now.getTime() - (retentionConfig.network_stats * 24 * 60 * 60 * 1000));
            const deletedStats = await NetworkStats.destroy({
                where: {
                    scan_timestamp: { [require('sequelize').Op.lt]: statsRetentionDate }
                }
            });

            // Clean network usage
            const usageRetentionDate = new Date(now.getTime() - (retentionConfig.network_usage * 24 * 60 * 60 * 1000));
            const deletedUsage = await NetworkUsage.destroy({
                where: {
                    scan_timestamp: { [require('sequelize').Op.lt]: usageRetentionDate }
                }
            });

            // Clean network config
            const configRetentionDate = new Date(now.getTime() - (retentionConfig.network_config * 24 * 60 * 60 * 1000));
            const deletedConfig = await NetworkInterfaces.destroy({
                where: {
                    scan_timestamp: { [require('sequelize').Op.lt]: configRetentionDate }
                }
            });

            if (deletedStats > 0 || deletedUsage > 0 || deletedConfig > 0) {
            }

        } catch (error) {
            console.error('❌ Failed to cleanup old network data:', error.message);
        }
    }
}

export default NetworkCollector;
