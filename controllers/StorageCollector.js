/**
 * @fileoverview Storage Data Collection Controller for Zoneweaver API
 * @description Collects ZFS pool and dataset information from OmniOS zpool and zfs commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec, execSync } from "child_process";
import util from "util";
import os from "os";
import { Op } from "sequelize";
import config from "../config/ConfigLoader.js";
import ZFSPools from "../models/ZFSPoolModel.js";
import ZFSDatasets from "../models/ZFSDatasetModel.js";
import Disks from "../models/DiskModel.js";
import DiskIOStats from "../models/DiskIOStatsModel.js";
import ARCStats from "../models/ARCStatsModel.js";
import PoolIOStats from "../models/PoolIOStatsModel.js";
import HostInfo from "../models/HostInfoModel.js";
import { log, createTimer } from "../lib/Logger.js";

const execProm = util.promisify(exec);

/**
 * Storage Data Collector Class
 * @description Handles collection of ZFS pool and dataset information
 */
class StorageCollector {
    constructor() {
        this.hostMonitoringConfig = config.getHostMonitoring();
        this.hostname = os.hostname();
        this.isCollecting = false;
        this.errorCount = 0;
        this.lastErrorReset = Date.now();
        this.discoveredPools = new Set(); // Cache discovered pool names
        this.discoveredZones = new Set(); // Cache discovered zone names
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
            log.database.error('Failed to update host info', {
                error: error.message,
                hostname: this.hostname,
                updates: Object.keys(updates)
            });
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
        
        log.monitoring.error('Storage collection error', {
            error: error.message,
            operation: operation,
            error_count: this.errorCount,
            max_errors: maxErrors,
            hostname: this.hostname
        });

        await this.updateHostInfo({
            storage_scan_errors: this.errorCount,
            last_error_message: errorMessage
        });

        if (this.errorCount >= maxErrors) {
            log.monitoring.error('Storage collector disabled due to consecutive errors', {
                error_count: this.errorCount,
                max_errors: maxErrors,
                operation: operation,
                hostname: this.hostname
            });
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
                storage_scan_errors: 0,
                last_error_message: null
            });
        }
    }

    /**
     * Discover actual pool names from the system
     * @description Uses zpool list to get real pool names instead of hardcoded assumptions
     * @returns {Promise<Set>} Set of discovered pool names
     */
    async discoverPools() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const { stdout: poolListOutput } = await execProm('zpool list -H -o name', { timeout });
            
            const pools = new Set();
            const lines = poolListOutput.trim().split('\n');
            
            for (const line of lines) {
                const poolName = line.trim();
                if (poolName) {
                    pools.add(poolName);
                    this.discoveredPools.add(poolName);
                }
            }
            
            return pools;
            
        } catch (error) {
            log.monitoring.warn('Failed to discover pools dynamically', {
                error: error.message,
                hostname: this.hostname
            });
            return new Set();
        }
    }

    /**
     * Discover actual zone names from the system  
     * @description Uses zoneadm list to get real zone names instead of hardcoded patterns
     * @returns {Promise<Set>} Set of discovered zone names
     */
    async discoverZones() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const { stdout: zoneListOutput } = await execProm('pfexec zoneadm list -icv', { timeout });
            
            const zones = new Set();
            const lines = zoneListOutput.trim().split('\n');
            
            // Skip header line
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                
                const parts = line.split(/\s+/);
                if (parts.length >= 2) {
                    const zoneName = parts[1]; // Zone name is in second column
                    if (zoneName && zoneName !== 'global') {
                        zones.add(zoneName);
                        this.discoveredZones.add(zoneName);
                    }
                }
            }
            
            return zones;
            
        } catch (error) {
            log.monitoring.warn('Failed to discover zones dynamically', {
                error: error.message,
                hostname: this.hostname
            });
            return new Set();
        }
    }

    /**
     * Parse unit string to bytes
     * @param {string} unitStr - String like "6.05G", "176G", "5.20M"
     * @returns {string|null} Bytes as string for large number storage
     */
    parseUnitToBytes(unitStr) {
        if (!unitStr || unitStr === '-' || unitStr === 'none') return null;
        
        const match = unitStr.match(/^([0-9.]+)([KMGTPEZ]?)/i);
        if (!match) return null;
        
        const value = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        
        const multipliers = {
            '': 1,
            'K': 1024,
            'M': 1024 * 1024,
            'G': 1024 * 1024 * 1024,
            'T': 1024 * 1024 * 1024 * 1024,
            'P': 1024 * 1024 * 1024 * 1024 * 1024,
            'E': 1024 * 1024 * 1024 * 1024 * 1024 * 1024,
            'Z': 1024 * 1024 * 1024 * 1024 * 1024 * 1024 * 1024
        };
        
        const multiplier = multipliers[unit] || 1;
        return Math.floor(value * multiplier).toString();
    }

    /**
     * Calculate capacity percentage
     * @param {string} allocBytes - Allocated bytes
     * @param {string} freeBytes - Free bytes
     * @returns {number|null} Capacity percentage
     */
    calculateCapacity(allocBytes, freeBytes) {
        if (!allocBytes || !freeBytes) return null;
        
        const alloc = parseFloat(allocBytes);
        const free = parseFloat(freeBytes);
        const total = alloc + free;
        
        if (total === 0) return 0;
        return Math.round((alloc / total) * 100 * 100) / 100; // Round to 2 decimal places
    }

    /**
     * Parse zpool iostat output
     * @param {string} output - Command output
     * @returns {Array} Parsed pool data
     */
    parsePoolIostatOutput(output) {
        const lines = output.trim().split('\n');
        const pools = [];
        
        let inDataSection = false;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip header lines until we find the pool data
            if (line.includes('pool') && line.includes('alloc') && line.includes('free')) {
                inDataSection = true;
                continue;
            }
            
            if (line.includes('-----')) continue;
            
            if (inDataSection && line && !line.includes('pool')) {
                const parts = line.split(/\s+/);
                if (parts.length >= 7) {
                    const allocBytes = this.parseUnitToBytes(parts[1]);
                    const freeBytes = this.parseUnitToBytes(parts[2]);
                    
                    pools.push({
                        host: this.hostname,
                        pool: parts[0],
                        alloc: parts[1],
                        free: parts[2],
                        alloc_bytes: allocBytes,
                        free_bytes: freeBytes,
                        capacity: this.calculateCapacity(allocBytes, freeBytes),
                        read_ops: parts[3],
                        write_ops: parts[4],
                        read_bandwidth: parts[5],
                        write_bandwidth: parts[6],
                        scan_type: 'iostat',
                        scan_timestamp: new Date()
                    });
                }
            }
        }
        
        return pools;
    }

    /**
     * Parse zpool status output
     * @param {string} output - Command output
     * @returns {Array} Parsed pool status data
     */
    parsePoolStatusOutput(output) {
        const pools = [];
        const sections = output.split(/pool:/);
        
        for (let i = 1; i < sections.length; i++) {
            const section = sections[i].trim();
            const lines = section.split('\n');
            
            if (lines.length === 0) continue;
            
            const poolName = lines[0].trim();
            let state = null;
            let status = null;
            let errors = null;
            
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('state:')) {
                    state = trimmed.replace('state:', '').trim();
                } else if (trimmed.startsWith('status:')) {
                    status = trimmed.replace('status:', '').trim();
                } else if (trimmed.startsWith('errors:')) {
                    errors = trimmed.replace('errors:', '').trim();
                }
            }
            
            pools.push({
                host: this.hostname,
                pool: poolName,
                health: state,
                status: status,
                errors: errors,
                scan_type: 'status',
                scan_timestamp: new Date()
            });
        }
        
        return pools;
    }

    /**
     * Parse zfs list output
     * @param {string} output - Command output
     * @returns {Array} Parsed dataset data
     */
    parseDatasetListOutput(output) {
        const lines = output.trim().split('\n');
        const datasets = [];
        
        // Skip header line
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 5) {
                const poolMatch = parts[0].match(/^([^\/]+)/);
                const pool = poolMatch ? poolMatch[1] : null;
                
                datasets.push({
                    host: this.hostname,
                    name: parts[0],
                    pool: pool,
                    used: parts[1],
                    used_bytes: this.parseUnitToBytes(parts[1]),
                    available: parts[2],
                    available_bytes: this.parseUnitToBytes(parts[2]),
                    referenced: parts[3],
                    referenced_bytes: this.parseUnitToBytes(parts[3]),
                    mountpoint: parts[4],
                    scan_timestamp: new Date()
                });
            }
        }
        
        return datasets;
    }

    /**
     * Parse zfs get all output
     * @param {string} output - Command output
     * @param {string} datasetName - Dataset name being queried
     * @returns {Object} Parsed dataset properties
     */
    parseDatasetPropertiesOutput(output, datasetName) {
        const lines = output.trim().split('\n');
        const properties = {
            host: this.hostname,
            name: datasetName,
            scan_timestamp: new Date()
        };

        // Extract pool name from dataset name
        const poolMatch = datasetName.match(/^([^\/]+)/);
        if (poolMatch) {
            properties.pool = poolMatch[1];
        }
        
        for (let i = 1; i < lines.length; i++) { // Skip header
            const line = lines[i].trim();
            if (!line) continue;
            
            const parts = line.split(/\s+/);
            if (parts.length >= 3) {
                const property = parts[1];
                const value = parts[2];
                
                // Map ZFS properties to our model fields
                switch (property) {
                    case 'type':
                        properties.type = value;
                        break;
                    case 'creation':
                        properties.creation = parts.slice(2).join(' ');
                        break;
                    case 'used':
                        properties.used = value;
                        properties.used_bytes = this.parseUnitToBytes(value);
                        break;
                    case 'available':
                        properties.available = value;
                        properties.available_bytes = this.parseUnitToBytes(value);
                        break;
                    case 'referenced':
                        properties.referenced = value;
                        properties.referenced_bytes = this.parseUnitToBytes(value);
                        break;
                    case 'compressratio':
                        properties.compressratio = value;
                        break;
                    case 'reservation':
                        properties.reservation = value;
                        break;
                    case 'volsize':
                        properties.volsize = value;
                        break;
                    case 'volblocksize':
                        properties.volblocksize = value;
                        break;
                    case 'checksum':
                        properties.checksum = value;
                        break;
                    case 'compression':
                        properties.compression = value;
                        break;
                    case 'readonly':
                        properties.readonly = value;
                        break;
                    case 'copies':
                        properties.copies = value;
                        break;
                    case 'guid':
                        properties.guid = value;
                        break;
                    case 'usedbysnapshots':
                        properties.usedbysnapshots = value;
                        break;
                    case 'usedbydataset':
                        properties.usedbydataset = value;
                        break;
                    case 'usedbychildren':
                        properties.usedbychildren = value;
                        break;
                    case 'logicalused':
                        properties.logicalused = value;
                        break;
                    case 'logicalreferenced':
                        properties.logicalreferenced = value;
                        break;
                    case 'written':
                        properties.written = value;
                        break;
                    case 'mountpoint':
                        properties.mountpoint = value;
                        break;
                    case 'mounted':
                        properties.mounted = value;
                        break;
                }
            }
        }
        
        return properties;
    }

    /**
     * Collect ZFS pool information
     * @description Gathers pool I/O statistics and status
     */
    async collectPoolData() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const allPools = [];

            // Collect pool iostat data
            try {
                const { stdout: iostatOutput } = await execProm('zpool iostat', { timeout });
                const iostatData = this.parsePoolIostatOutput(iostatOutput);
                allPools.push(...iostatData);
            } catch (error) {
                log.monitoring.warn('Failed to collect pool iostat data', {
                    error: error.message,
                    hostname: this.hostname
                });
            }

            // Collect pool status data
            try {
                const { stdout: statusOutput } = await execProm('zpool status', { timeout });
                const statusData = this.parsePoolStatusOutput(statusOutput);
                
                // Merge status data with iostat data
                statusData.forEach(statusPool => {
                    const existing = allPools.find(pool => pool.pool === statusPool.pool && pool.scan_type === 'iostat');
                    if (existing) {
                        Object.assign(existing, {
                            health: statusPool.health,
                            status: statusPool.status,
                            errors: statusPool.errors
                        });
                    } else {
                        allPools.push(statusPool);
                    }
                });
                
            } catch (error) {
                log.monitoring.warn('Failed to collect pool status data', {
                    error: error.message,
                    hostname: this.hostname
                });
            }

            // Store pool data in database
            if (allPools.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < allPools.length; i += batchSize) {
                    const batch = allPools.slice(i, i + batchSize);
                    await ZFSPools.bulkCreate(batch);
                }
            }

            return allPools;

        } catch (error) {
            log.monitoring.error('Failed to collect pool data', {
                error: error.message,
                hostname: this.hostname
            });
            throw error;
        }
    }

    /**
     * Filter datasets to only include zone/VM-related datasets using dynamic zone discovery
     * @param {Array} datasets - Array of all datasets
     * @returns {Array} Filtered datasets for zones/VMs only
     */
    async filterZoneDatasets(datasets) {
        // Get actual zone names from the system instead of hardcoded patterns
        await this.discoverZones();
        
        return datasets.filter(dataset => {
            const name = dataset.name.toLowerCase();
            
            // Include datasets that contain "zones" in the path (generic pattern)
            if (name.includes('/zones/')) {
                return true;
            }
            
            // Include datasets that match common VM/zone patterns (generic)
            if (name.includes('/vm/') || name.includes('/vms/')) {
                return true;
            }
            
            // Include datasets that match discovered zone names
            for (const zoneName of this.discoveredZones) {
                const zoneNameLower = zoneName.toLowerCase();
                if (name.includes(`/${zoneNameLower}/`) || name.includes(`/${zoneNameLower}`)) {
                    return true;
                }
            }
            
            // Include bhyve/kvm patterns (generic hypervisor patterns)
            if (name.includes('/bhyve/') || name.includes('/kvm/')) {
                return true;
            }
            
            // Exclude root pools and system datasets
            if (name.split('/').length <= 1) {
                return false;
            }
            
            return false;
        });
    }

    /**
     * Collect ZFS dataset information for zones/VMs only
     * @description Gathers dataset list and detailed properties for zone-related datasets only
     */
    async collectDatasetData() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // Get basic dataset list
            const { stdout: listOutput } = await execProm('zfs list -H', { timeout });
            const allDatasets = this.parseDatasetListOutput(listOutput);

            // Filter to only zone/VM-related datasets
            const zoneDatasets = await this.filterZoneDatasets(allDatasets);

            if (zoneDatasets.length === 0) {
                return [];
            }
            
            const detailedDatasets = [];
            
            // Collect detailed properties for all zone datasets (since the list is now filtered)
            for (const dataset of zoneDatasets) {
                // First verify the dataset still exists
                let datasetExists = false;
                
                try {
                    await execProm(`zfs list -H "${dataset.name}"`, { timeout });
                    datasetExists = true;
                } catch (listError) {
                    log.monitoring.debug('Dataset no longer exists, skipping detailed properties', {
                        dataset: dataset.name,
                        hostname: this.hostname
                    });
                    datasetExists = false;
                }
                
                if (!datasetExists) {
                    // Still include basic dataset info but mark it as non-existent
                    detailedDatasets.push({
                        ...dataset,
                        dataset_exists: false
                    });
                    continue; // Skip to next dataset
                }
                
                // Dataset exists, try to get detailed properties
                try {
                    const { stdout: propsOutput } = await execProm(`zfs get all "${dataset.name}"`, { timeout });
                    const detailedProps = this.parseDatasetPropertiesOutput(propsOutput, dataset.name);
                    
                    // Merge basic and detailed data
                    detailedDatasets.push({
                        ...dataset,
                        ...detailedProps,
                        dataset_exists: true
                    });
                    
                } catch (error) {
                    log.monitoring.warn('Failed to get detailed properties for dataset', {
                        dataset: dataset.name,
                        error: error.message,
                        hostname: this.hostname
                    });
                    // Still include basic dataset info
                    detailedDatasets.push({
                        ...dataset,
                        dataset_exists: false
                    });
                }
            }

            // Store dataset data in database
            if (detailedDatasets.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < detailedDatasets.length; i += batchSize) {
                    const batch = detailedDatasets.slice(i, i + batchSize);
                    await ZFSDatasets.bulkCreate(batch, {
                        updateOnDuplicate: Object.keys(ZFSDatasets.rawAttributes).filter(key => key !== 'id')
                    });
                }
            }

            return detailedDatasets;

        } catch (error) {
            log.monitoring.error('Failed to collect dataset data', {
                error: error.message,
                hostname: this.hostname
            });
            throw error;
        }
    }

    /**
     * Parse disk format output to extract disk information
     * @param {string} output - Format command output
     * @returns {Array} Parsed disk data
     */
    parseFormatOutput(output) {
        const lines = output.trim().split('\n');
        const disks = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Match format: "0. c0t5F8DB4C101905B5Ad0 <ATA-PNY CS900 120GB-0613-111.79GB>"
            const match = trimmed.match(/^(\d+)\.\s+(\S+)\s+<([^>]+)>/);
            if (match) {
                const index = parseInt(match[1]);
                const deviceName = match[2];
                const description = match[3];
                
                // Extract serial number from device name (e.g., c0t5F8DB4C101905B5Ad0 -> 5F8DB4C101905B5A)
                const serialMatch = deviceName.match(/c\d+t([A-F0-9]+)d\d+$/i);
                const serialNumber = serialMatch ? serialMatch[1] : null;
                
                // Parse description (e.g., "ATA-PNY CS900 120GB-0613-111.79GB")
                const descParts = description.split('-');
                let manufacturer = null;
                let model = null;
                let firmware = null;
                let capacity = null;
                let diskType = 'HDD'; // Default to HDD
                let interfaceType = 'UNKNOWN';
                
                if (descParts.length >= 3) {
                    manufacturer = descParts[0];
                    model = descParts[1];
                    firmware = descParts[2];
                    capacity = descParts[3] || null;
                    
                    // Determine disk type based on model/manufacturer
                    const modelLower = model ? model.toLowerCase() : '';
                    if (modelLower.includes('ssd') || modelLower.includes('cs900') || 
                        modelLower.includes('nvme') || manufacturer === 'ATA') {
                        diskType = 'SSD';
                    }
                    
                    // Determine interface type
                    if (manufacturer === 'ATA' || deviceName.includes('c1t')) {
                        interfaceType = 'SATA';
                    } else if (manufacturer === 'SEAGATE' || manufacturer === 'Hitachi') {
                        interfaceType = 'SAS';
                    }
                }
                
                // Parse capacity to bytes
                const capacityBytes = capacity ? this.parseUnitToBytes(capacity) : null;
                
                disks.push({
                    host: this.hostname,
                    disk_index: index,
                    device_name: deviceName,
                    serial_number: serialNumber,
                    manufacturer: manufacturer,
                    model: model,
                    firmware: firmware,
                    capacity: capacity,
                    capacity_bytes: capacityBytes,
                    device_path: null, // Will be populated if we can get it from format -e
                    disk_type: diskType,
                    interface_type: interfaceType,
                    pool_assignment: null, // Will be determined by cross-referencing with zpool status
                    is_available: true, // Will be updated based on pool assignment
                    scan_timestamp: new Date()
                });
            }
        }
        
        return disks;
    }

    /**
     * Collect disk inventory information
     * @description Gathers physical disk information using format command
     */
    async collectDiskData() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // Get disk list using format command
            const { stdout: formatOutput } = await execProm('echo | pfexec format | grep "^[ ]*[0-9]"', { timeout });
            const diskData = this.parseFormatOutput(formatOutput);

            // Cross-reference with zpool status to determine pool assignments
            try {
                const { stdout: zpoolStatusOutput } = await execProm('zpool status', { timeout });
                await this.assignDisksToePools(diskData, zpoolStatusOutput);
            } catch (error) {
                log.monitoring.warn('Failed to cross-reference disk assignments with zpool status', {
                    error: error.message,
                    hostname: this.hostname
                });
            }

            // Store disk data in database with proper upsert
            if (diskData.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < diskData.length; i += batchSize) {
                    const batch = diskData.slice(i, i + batchSize);
                    await Disks.bulkCreate(batch, {
                        updateOnDuplicate: Object.keys(Disks.rawAttributes).filter(key => 
                            key !== 'id' && key !== 'createdAt'
                        ),
                        conflictAttributes: ['host', 'device_name']
                    });
                }
            }

            return diskData;

        } catch (error) {
            log.monitoring.error('Failed to collect disk data', {
                error: error.message,
                hostname: this.hostname
            });
            throw error;
        }
    }

    /**
     * Assign disks to pools based on zpool status output
     * @param {Array} diskData - Array of disk objects
     * @param {string} zpoolStatusOutput - Output from zpool status command
     */
    async assignDisksToePools(diskData, zpoolStatusOutput) {
        const poolSections = zpoolStatusOutput.split(/pool:/);
        
        for (let i = 1; i < poolSections.length; i++) {
            const section = poolSections[i].trim();
            const lines = section.split('\n');
            
            if (lines.length === 0) continue;
            
            const poolName = lines[0].trim();
            
            // Look for disk device names in the pool status
            for (const line of lines) {
                const trimmed = line.trim();
                
                // Look for device names that match our disk inventory
                for (const disk of diskData) {
                    // Check if the device name or serial number appears in the zpool status
                    if (trimmed.includes(disk.device_name) || 
                        (disk.serial_number && trimmed.includes(disk.serial_number.toLowerCase()))) {
                        disk.pool_assignment = poolName;
                        disk.is_available = false; // Disk is in use
                    }
                }
            }
        }
    }

    /**
     * Collect extended ZFS pool information
     * @description Gathers additional pool information using various zpool commands
     */
    async collectExtendedPoolData() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            const extendedData = [];

            // Collect zpool list output for detailed pool information
            try {
                const { stdout: listOutput } = await execProm('zpool list -H', { timeout });
                const listData = this.parsePoolListOutput(listOutput);
                extendedData.push(...listData);
            } catch (error) {
                log.monitoring.warn('Failed to collect zpool list data', {
                    error: error.message,
                    hostname: this.hostname
                });
            }

            // Store extended pool data
            if (extendedData.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < extendedData.length; i += batchSize) {
                    const batch = extendedData.slice(i, i + batchSize);
                    await ZFSPools.bulkCreate(batch, {
                        updateOnDuplicate: Object.keys(ZFSPools.rawAttributes).filter(key => key !== 'id')
                    });
                }
            }

            return extendedData;

        } catch (error) {
            log.monitoring.error('Failed to collect extended pool data', {
                error: error.message,
                hostname: this.hostname
            });
            throw error;
        }
    }

    /**
     * Parse zpool list output
     * @param {string} output - Command output
     * @returns {Array} Parsed pool data
     */
    parsePoolListOutput(output) {
        const lines = output.trim().split('\n');
        const pools = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            const parts = trimmed.split(/\s+/);
            if (parts.length >= 10) {
                const allocBytes = this.parseUnitToBytes(parts[2]);
                const freeBytes = this.parseUnitToBytes(parts[3]);
                
                pools.push({
                    host: this.hostname,
                    pool: parts[0],
                    alloc: parts[2],
                    free: parts[3],
                    alloc_bytes: allocBytes,
                    free_bytes: freeBytes,
                    capacity: this.calculateCapacity(allocBytes, freeBytes),
                    health: parts[6],
                    scan_type: 'list',
                    scan_timestamp: new Date()
                });
            }
        }
        
        return pools;
    }

    /**
     * Parse zpool iostat -Hv output for per-disk I/O statistics
     * @param {string} output - Command output
     * @returns {Array} Parsed disk I/O data
     */
    parsePoolIostatVerboseOutput(output) {
        const lines = output.trim().split('\n');
        const diskStats = [];
        let currentPool = null;
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            const parts = trimmed.split(/\s+/);
            if (parts.length < 6) continue; // Need at least 6 columns
            
            // Detect pool lines (pool names like Array-0, Array-1, rpool)
            if (parts[0].match(/^(Array-\d+|rpool|[a-zA-Z][\w-]*pool?)$/) && parts.length >= 7) {
                currentPool = parts[0];
                continue;
            }
            
            // Skip raidz/mirror lines (intermediate levels)
            if (trimmed.startsWith('raidz') || trimmed.startsWith('mirror') || 
                trimmed.startsWith('logs') || trimmed.startsWith('cache') ||
                trimmed.startsWith('spares')) {
                continue;
            }
            
            // Process device lines (individual disks starting with c and containing t)
            if (currentPool && parts[0].startsWith('c') && parts[0].includes('t') && parts.length >= 6) {
                const deviceName = parts[0];
                
                // Device format: c0t5F8DB4C192001CC8d0s1 - - 0 26 4.83K 675K
                // Columns: device_name, alloc, free, read_ops, write_ops, read_bandwidth, write_bandwidth
                const diskStat = {
                    host: this.hostname,
                    pool: currentPool,
                    device_name: deviceName,
                    alloc: parts[1] === '-' ? '0' : parts[1],
                    free: parts[2] === '-' ? '0' : parts[2],
                    read_ops: parts[3],
                    write_ops: parts[4],
                    read_bandwidth: parts[5],
                    write_bandwidth: parts[6],
                    read_bandwidth_bytes: this.parseUnitToBytes(parts[5]),
                    write_bandwidth_bytes: this.parseUnitToBytes(parts[6]),
                    scan_timestamp: new Date()
                };
                
                diskStats.push(diskStat);
            }
        }
        
        return diskStats;
    }

    /**
     * Parse kstat arcstats output
     * @param {string} output - Command output
     * @returns {Object} Parsed ARC stats
     */
    parseARCStatsOutput(output) {
        const lines = output.trim().split('\n');
        const arcStats = {
            host: this.hostname,
            scan_timestamp: new Date()
        };
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Parse format: zfs:0:arcstats:property_name    value
            const match = trimmed.match(/^zfs:0:arcstats:(\S+)\s+(\d+)$/);
            if (match) {
                const property = match[1];
                const value = match[2];
                
                // Map kstat properties to our model fields
                switch (property) {
                    case 'size':
                        arcStats.arc_size = value;
                        break;
                    case 'c':
                        arcStats.arc_target_size = value;
                        break;
                    case 'c_min':
                        arcStats.arc_min_size = value;
                        break;
                    case 'c_max':
                        arcStats.arc_max_size = value;
                        break;
                    case 'arc_meta_used':
                        arcStats.arc_meta_used = value;
                        break;
                    case 'arc_meta_limit':
                        arcStats.arc_meta_limit = value;
                        break;
                    case 'mru_size':
                        arcStats.mru_size = value;
                        break;
                    case 'mfu_size':
                        arcStats.mfu_size = value;
                        break;
                    case 'data_size':
                        arcStats.data_size = value;
                        break;
                    case 'metadata_size':
                        arcStats.metadata_size = value;
                        break;
                    case 'hits':
                        arcStats.hits = value;
                        break;
                    case 'misses':
                        arcStats.misses = value;
                        break;
                    case 'demand_data_hits':
                        arcStats.demand_data_hits = value;
                        break;
                    case 'demand_data_misses':
                        arcStats.demand_data_misses = value;
                        break;
                    case 'demand_metadata_hits':
                        arcStats.demand_metadata_hits = value;
                        break;
                    case 'demand_metadata_misses':
                        arcStats.demand_metadata_misses = value;
                        break;
                    case 'prefetch_data_hits':
                        arcStats.prefetch_data_hits = value;
                        break;
                    case 'prefetch_data_misses':
                        arcStats.prefetch_data_misses = value;
                        break;
                    case 'mru_hits':
                        arcStats.mru_hits = value;
                        break;
                    case 'mfu_hits':
                        arcStats.mfu_hits = value;
                        break;
                    case 'mru_ghost_hits':
                        arcStats.mru_ghost_hits = value;
                        break;
                    case 'mfu_ghost_hits':
                        arcStats.mfu_ghost_hits = value;
                        break;
                    case 'p':
                        arcStats.arc_p = value;
                        break;
                    case 'compressed_size':
                        arcStats.compressed_size = value;
                        break;
                    case 'uncompressed_size':
                        arcStats.uncompressed_size = value;
                        break;
                    case 'l2_size':
                        arcStats.l2_size = value;
                        break;
                    case 'l2_hits':
                        arcStats.l2_hits = value;
                        break;
                    case 'l2_misses':
                        arcStats.l2_misses = value;
                        break;
                }
            }
        }
        
        // Calculate efficiency metrics
        if (arcStats.hits && arcStats.misses) {
            const totalAccess = parseInt(arcStats.hits) + parseInt(arcStats.misses);
            if (totalAccess > 0) {
                arcStats.hit_ratio = ((parseInt(arcStats.hits) / totalAccess) * 100).toFixed(2);
            }
        }
        
        if (arcStats.demand_data_hits && arcStats.demand_data_misses) {
            const totalDemandData = parseInt(arcStats.demand_data_hits) + parseInt(arcStats.demand_data_misses);
            if (totalDemandData > 0) {
                arcStats.data_demand_efficiency = ((parseInt(arcStats.demand_data_hits) / totalDemandData) * 100).toFixed(2);
            }
        }
        
        if (arcStats.prefetch_data_hits && arcStats.prefetch_data_misses) {
            const totalPrefetchData = parseInt(arcStats.prefetch_data_hits) + parseInt(arcStats.prefetch_data_misses);
            if (totalPrefetchData > 0) {
                arcStats.data_prefetch_efficiency = ((parseInt(arcStats.prefetch_data_hits) / totalPrefetchData) * 100).toFixed(2);
            }
        }
        
        return arcStats;
    }


    /**
     * Collect ZFS ARC statistics
     * @description Gathers ARC cache performance metrics using kstat
     */
    async collectARCStats() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // Get ARC stats using kstat (kstat doesn't need pfexec but let's be safe)
            const { stdout: kstatOutput } = await execProm('kstat -p zfs:0:arcstats', { timeout });
            const arcStatsData = this.parseARCStatsOutput(kstatOutput);

            // Store ARC data in database
            await ARCStats.create(arcStatsData);

            return arcStatsData;

        } catch (error) {
            log.monitoring.error('Failed to collect ARC statistics', {
                error: error.message,
                hostname: this.hostname
            });
            throw error;
        }
    }

    /**
     * Collect all storage information
     * @description Main entry point for storage data collection
     */
    async collectStorageData() {
        if (this.isCollecting) {
            return;
        }

        this.isCollecting = true;

        try {
            const poolData = await this.collectPoolData();
            const extendedPoolData = await this.collectExtendedPoolData();
            const datasetData = await this.collectDatasetData();
            const diskData = await this.collectDiskData();

            await this.updateHostInfo({ last_storage_scan: new Date() });
            await this.resetErrorCount();
            
            return true;

        } catch (error) {
            const shouldContinue = await this.handleError(error, 'Storage data collection');
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
     * Parse zpool iostat -l -H -v output for BOTH pool and disk performance data
     * @param {string} output - Command output from pfexec zpool iostat -l -H -v 1 2
     * @returns {Object} Object containing both poolStats and diskStats arrays
     */
    parseComprehensiveIOStats(output) {
        const lines = output.trim().split('\n');
        const poolStats = [];
        const diskStats = [];
        let currentPool = null;
        let isInSecondDataSet = false;
        
        // Track per-pool state instead of global state
        const poolDataSets = new Map(); // poolName -> { foundFirst: boolean, vdevCount: 0, diskCount: 0 }
        
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            const parts = trimmed.split(/\s+/);
            
            // Skip lines that don't have the expected number of columns
            if (parts.length !== 17) continue;
            
            // FIRST: Check if this is a topology line (raidz1, raidz2, mirror) - these should NOT be treated as pools
            if (parts[0].match(/^(raidz1|raidz2|raidz3|mirror|cache|log|spare)(-\d+)?$/)) {
                // Only process topology lines if we're in the second dataset and have a current pool
                if (isInSecondDataSet && currentPool) {
                    const poolType = parts[0].replace(/-\d+$/, '');
                    
                    // Increment vdev count for this pool
                    if (poolDataSets.has(currentPool)) {
                        poolDataSets.get(currentPool).vdevCount++;
                    }
                    
                    // Find the pool record we just created and update its pool_type (only if not already set)
                    const lastPool = poolStats.find(p => p.pool === currentPool);
                    if (lastPool && !lastPool.pool_type) {
                        lastPool.pool_type = poolType;
                    }
                    
                }
                continue; // Skip further processing for topology lines
            }
            
            // SECOND: Check if this is a pool line
            if (this.discoveredPools.has(parts[0])) {
                const poolName = parts[0];
                
                // Initialize pool tracking if not exists
                if (!poolDataSets.has(poolName)) {
                    poolDataSets.set(poolName, { foundFirst: false, vdevCount: 0, diskCount: 0 });
                }
                
                const poolData = poolDataSets.get(poolName);
                
                if (!poolData.foundFirst) {
                    // This is the first data set (cumulative) for this pool, skip it
                    poolData.foundFirst = true;
                    continue;
                } else {
                    // This is the second data set (real-time) for this pool, process it
                    isInSecondDataSet = true;
                    currentPool = poolName;
                    
                    const poolStat = {
                        host: this.hostname,
                        pool: currentPool,
                        pool_type: null, // Will be set by topology line
                        alloc: parts[1],
                        free: parts[2],
                        read_ops: parts[3],
                        write_ops: parts[4],
                        read_bandwidth: parts[5],
                        write_bandwidth: parts[6],
                        read_bandwidth_bytes: this.parseUnitToBytes(parts[5]),
                        write_bandwidth_bytes: this.parseUnitToBytes(parts[6]),
                        total_wait_read: parts[7],
                        total_wait_write: parts[8],
                        disk_wait_read: parts[9],
                        disk_wait_write: parts[10],
                        syncq_wait_read: parts[11],
                        syncq_wait_write: parts[12],
                        asyncq_wait_read: parts[13],
                        asyncq_wait_write: parts[14],
                        scrub_wait: parts[15],
                        trim_wait: parts[16],
                        scan_timestamp: new Date()
                    };
                    
                    poolStats.push(poolStat);
                }
                continue;
            }
            
            // THIRD: Check if this is a disk line (only if we're in the second dataset)
            if (isInSecondDataSet && currentPool && parts[0].startsWith('c') && parts[0].includes('t')) {
                const deviceName = parts[0];
                
                // Increment disk count for this pool
                if (poolDataSets.has(currentPool)) {
                    poolDataSets.get(currentPool).diskCount++;
                }
                
                const diskStat = {
                    host: this.hostname,
                    pool: currentPool,
                    device_name: deviceName,
                    alloc: parts[1] === '-' ? '0' : parts[1],
                    free: parts[2] === '-' ? '0' : parts[2],
                    read_ops: parts[3],
                    write_ops: parts[4],
                    read_bandwidth: parts[5],
                    write_bandwidth: parts[6],
                    read_bandwidth_bytes: this.parseUnitToBytes(parts[5]),
                    write_bandwidth_bytes: this.parseUnitToBytes(parts[6]),
                    scan_timestamp: new Date()
                };
                
                diskStats.push(diskStat);
            }
        }
        
        // Log vdev summary for each pool
        for (const [poolName, data] of poolDataSets.entries()) {
        }
        
        return { poolStats, diskStats };
    }

    /**
     * Collect comprehensive I/O statistics (BOTH pool and disk level)
     * @description Single efficient call to get both pool and disk performance data
     */
    async collectComprehensiveIOStats() {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // First, discover pools dynamically to avoid hardcoded assumptions
            await this.discoverPools();
            
            // Single call to get BOTH pool and disk performance data with latency
            // Use -H for script-friendly output and 1 2 to get real-time data (second sample)
            const { stdout: iostatOutput } = await execProm('pfexec zpool iostat -l -H -v 1 2', { timeout });
            const { poolStats, diskStats } = this.parseComprehensiveIOStats(iostatOutput);

            // Store pool I/O data
            if (poolStats.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < poolStats.length; i += batchSize) {
                    const batch = poolStats.slice(i, i + batchSize);
                    await PoolIOStats.bulkCreate(batch);
                }
            }

            // Store disk I/O data  
            if (diskStats.length > 0) {
                const batchSize = this.hostMonitoringConfig.performance.batch_size;
                for (let i = 0; i < diskStats.length; i += batchSize) {
                    const batch = diskStats.slice(i, i + batchSize);
                    await DiskIOStats.bulkCreate(batch);
                }
            }

            return { poolStats, diskStats };

        } catch (error) {
            log.monitoring.error('Failed to collect comprehensive I/O statistics', {
                error: error.message,
                hostname: this.hostname
            });
            throw error;
        }
    }

    /**
     * Collect frequent storage metrics (I/O and ARC stats)
     * @description Collects high-frequency metrics using efficient single command approach
     */
    async collectFrequentStorageMetrics() {
        try {
            // SINGLE EFFICIENT CALL: Collect both pool + disk I/O performance 
            const { poolStats, diskStats } = await this.collectComprehensiveIOStats();
            
            // Collect ARC statistics (every minute)
            const arcStatsData = await this.collectARCStats();
            
            return true;

        } catch (error) {
            const shouldContinue = await this.handleError(error, 'Frequent storage metrics collection');
            return shouldContinue;
        }
    }

    /**
     * Clean up old storage data based on retention policies
     */
    async cleanupOldData() {
        try {
            const retentionConfig = this.hostMonitoringConfig.retention;
            const now = new Date();

            // Clean pool data
            const poolRetentionDate = new Date(now.getTime() - (retentionConfig.storage * 24 * 60 * 60 * 1000));
            const deletedPools = await ZFSPools.destroy({
                where: {
                    scan_timestamp: { [Op.lt]: poolRetentionDate }
                }
            });

            // Clean dataset data
            const datasetRetentionDate = new Date(now.getTime() - (retentionConfig.storage * 24 * 60 * 60 * 1000));
            const deletedDatasets = await ZFSDatasets.destroy({
                where: {
                    scan_timestamp: { [Op.lt]: datasetRetentionDate }
                }
            });

            // Clean disk data
            const deletedDisks = await Disks.destroy({
                where: {
                    scan_timestamp: { [Op.lt]: datasetRetentionDate }
                }
            });

            // Clean disk I/O stats
            const deletedDiskIO = await DiskIOStats.destroy({
                where: {
                    scan_timestamp: { [Op.lt]: poolRetentionDate }
                }
            });

            // Clean pool I/O stats
            const deletedPoolIO = await PoolIOStats.destroy({
                where: {
                    scan_timestamp: { [Op.lt]: poolRetentionDate }
                }
            });

            // Clean ARC stats
            const deletedARC = await ARCStats.destroy({
                where: {
                    scan_timestamp: { [Op.lt]: poolRetentionDate }
                }
            });

            if (deletedPools > 0 || deletedDatasets > 0 || deletedDisks > 0 || deletedDiskIO > 0 || deletedPoolIO > 0 || deletedARC > 0) {
                log.database.info('Storage cleanup completed', {
                    deleted_pools: deletedPools,
                    deleted_datasets: deletedDatasets,
                    deleted_disks: deletedDisks,
                    deleted_disk_io: deletedDiskIO,
                    deleted_pool_io: deletedPoolIO,
                    deleted_arc: deletedARC,
                    hostname: this.hostname
                });
            }

        } catch (error) {
            log.database.error('Failed to cleanup old storage data', {
                error: error.message,
                hostname: this.hostname
            });
        }
    }
}

export default StorageCollector;
