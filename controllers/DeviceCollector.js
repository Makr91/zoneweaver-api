/**
 * @fileoverview Device Data Collection Controller for Zoneweaver API
 * @description Collects PCI device information and passthrough capabilities from OmniOS prtconf and pptadm commands
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec, execSync } from "child_process";
import util from "util";
import os from "os";
import config from "../config/ConfigLoader.js";
import PCIDevices from "../models/PCIDeviceModel.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import Disks from "../models/DiskModel.js";
import Zones from "../models/ZoneModel.js";
import HostInfo from "../models/HostInfoModel.js";

const execProm = util.promisify(exec);

/**
 * Device Data Collector Class
 * @description Handles collection of PCI device information and passthrough capabilities
 */
class DeviceCollector {
    constructor() {
        this.hostMonitoringConfig = config.getHostMonitoring();
        this.hostname = os.hostname();
        this.isCollecting = false;
        this.errorCount = 0;
        this.lastErrorReset = Date.now();
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
        
        console.error(`❌ Device collection error (${this.errorCount}/${maxErrors}): ${errorMessage}`);

        await this.updateHostInfo({
            device_scan_errors: this.errorCount,
            last_error_message: errorMessage
        });

        if (this.errorCount >= maxErrors) {
            console.error(`🚫 Device collector disabled due to ${maxErrors} consecutive errors`);
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
                device_scan_errors: 0,
                last_error_message: null
            });
        }
    }

    /**
     * Parse prtconf -dD output to extract PCI device information
     * @param {string} output - Command output from prtconf -dD
     * @returns {Array} Parsed device data
     */
    parsePrtconfOutput(output) {
        const lines = output.trim().split('\n');
        const devices = [];
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            
            // Look for PCI device lines with format:
            // pci8086,34dc (pciex8086,10fb) [Intel Corporation 82599ES 10-Gigabit...], instance #0 (driver name: ixgbe)
            const pciMatch = trimmed.match(/^(\w+),(\w+)\s+\((pciex[\w,]+)\)\s+\[([^\]]+)\](?:,\s*instance\s+#(\d+))?\s*(?:\(driver name:\s*(\w+)\))?/);
            
            if (pciMatch) {
                const vendorDevice = pciMatch[1];
                const pciAddress = pciMatch[3]; // The pciex format
                const description = pciMatch[4];
                const instance = pciMatch[5] ? parseInt(pciMatch[5]) : null;
                const driverName = pciMatch[6] || null;
                
                // Extract vendor and device IDs from pciex format (e.g., pciex8086,10fb)
                const addressMatch = pciAddress.match(/pciex(\w+),(\w+)/);
                const vendorId = addressMatch ? addressMatch[1] : null;
                const deviceId = addressMatch ? addressMatch[2] : null;
                
                // Parse description to extract vendor name and device name
                let vendorName = null;
                let deviceName = null;
                
                if (description) {
                    // Try to split on common patterns
                    const descParts = description.split(/\s+/);
                    if (descParts.length >= 2) {
                        // First part is usually vendor (Intel, Broadcom, etc.)
                        vendorName = descParts[0] + (descParts[1] === 'Corporation' ? ' Corporation' : '');
                        // Rest is device name
                        deviceName = descParts.slice(vendorName.split(' ').length).join(' ');
                    } else {
                        deviceName = description;
                    }
                }
                
                // Determine device category based on description and driver
                const deviceCategory = this.categorizeDevice(description, driverName);
                
                // Check if driver is attached
                const driverAttached = !!driverName;
                
                // Create device object for PPT capability check
                const deviceObj = {
                    host: this.hostname,
                    pci_address: pciAddress,
                    vendor_id: vendorId,
                    device_id: deviceId,
                    vendor_name: vendorName,
                    device_name: deviceName,
                    driver_name: driverName,
                    driver_instance: instance,
                    driver_attached: driverAttached,
                    device_category: deviceCategory,
                    pci_path: null, // Will be populated if we can extract it
                    ppt_device_path: null,
                    ppt_enabled: false,
                    ppt_capable: false, // Will be calculated below
                    assigned_to_zones: [],
                    found_in_network_interfaces: false,
                    found_in_disk_inventory: false,
                    scan_timestamp: new Date()
                };
                
                // Calculate PPT capability
                deviceObj.ppt_capable = this.isPPTCapable(deviceObj);
                
                devices.push(deviceObj);
            }
        }
        
        return devices;
    }

    /**
     * Determine if a device is capable of PCI passthrough
     * @param {Object} device - Device object with vendor_id, device_category, assigned_to_zones
     * @returns {boolean} True if device is PPT-capable
     */
    isPPTCapable(device) {
        // Exclude devices already assigned to zones
        if (device.assigned_to_zones && Array.isArray(device.assigned_to_zones) && device.assigned_to_zones.length > 0) {
            return false;
        }
        
        // Intel devices (vendor_id 8086) - allow ONLY network cards
        // All other Intel devices are system-critical (chipset, I/O hub, etc.)
        if (device.vendor_id === "8086") {
            return device.device_category === "network";
        }
        
        // AMD devices (vendor_id 1022) - exclude system critical components
        // TODO: Expand this list as we get more AMD system data
        if (device.vendor_id === "1022") {
            // For now, be conservative and exclude AMD devices until we have test data
            // Exception: allow discrete GPUs and add-in cards
            return device.device_category === "display" || device.device_category === "network" || device.device_category === "storage";
        }
        
        // All other vendors (non-Intel, non-AMD) are generally PPT-capable
        // This includes add-in cards from vendors like:
        // - Broadcom/LSI storage controllers
        // - NVIDIA GPUs  
        // - Renesas USB controllers
        // - Matrox display controllers
        // - Other specialty PCI cards
        return true;
    }

    /**
     * Categorize device based on description and driver name
     * @param {string} description - Device description
     * @param {string} driverName - Driver name
     * @returns {string} Device category
     */
    categorizeDevice(description, driverName) {
        if (!description) return 'other';
        
        const desc = description.toLowerCase();
        const driver = (driverName || '').toLowerCase();
        
        // Network devices
        if (desc.includes('network') || desc.includes('ethernet') || desc.includes('gigabit') ||
            driver.includes('igb') || driver.includes('ixgbe') || driver.includes('e1000') ||
            driver.includes('bnx') || driver.includes('bge')) {
            return 'network';
        }
        
        // Storage devices
        if (desc.includes('storage') || desc.includes('sas') || desc.includes('sata') ||
            desc.includes('scsi') || desc.includes('raid') ||
            driver.includes('mpt') || driver.includes('ahci') || driver.includes('nvme')) {
            return 'storage';
        }
        
        // Display devices
        if (desc.includes('display') || desc.includes('vga') || desc.includes('graphics') ||
            desc.includes('video') || driver.includes('vgatext')) {
            return 'display';
        }
        
        // USB devices
        if (desc.includes('usb') || desc.includes('universal serial bus') ||
            driver.includes('usb') || driver.includes('ehci') || driver.includes('uhci')) {
            return 'usb';
        }
        
        // Audio devices
        if (desc.includes('audio') || desc.includes('sound') || desc.includes('multimedia')) {
            return 'audio';
        }
        
        return 'other';
    }

    /**
     * Parse pptadm list output
     * @param {string} output - Command output from pptadm list -j -a
     * @returns {Array} Parsed PPT device data
     */
    parsePPTOutput(output) {
        const pptDevices = [];
        
        try {
            const data = JSON.parse(output);
            if (data.devices && Array.isArray(data.devices)) {
                data.devices.forEach(device => {
                    pptDevices.push({
                        dev: device.dev,
                        path: device.path,
                        vendor_id: device['vendor-id'],
                        device_id: device['device-id'],
                        label: device.label
                    });
                });
            }
        } catch (error) {
            console.warn('⚠️  Failed to parse pptadm JSON output:', error.message);
            // Try to parse text format as fallback
            const lines = output.trim().split('\n');
            for (let i = 1; i < lines.length; i++) { // Skip header
                const line = lines[i].trim();
                if (!line) continue;
                
                const parts = line.split(/\s+/);
                if (parts.length >= 4) {
                    pptDevices.push({
                        dev: parts[0],
                        vendor_id: parts[1],
                        device_id: parts[2],
                        path: parts[3],
                        label: parts.slice(4).join(' ')
                    });
                }
            }
        }
        
        return pptDevices;
    }

    /**
     * Check PPT status and update device data
     * @param {Array} deviceData - Array of device objects to update
     */
    async checkPPTStatus(deviceData) {
        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // Try JSON format first
            let pptDevices = [];
            try {
                const { stdout: pptOutput } = await execProm('pfexec pptadm list -j -a', { timeout });
                pptDevices = this.parsePPTOutput(pptOutput);
            } catch (error) {
                // Fallback to text format
                try {
                    const { stdout: pptOutput } = await execProm('pfexec pptadm list -a', { timeout });
                    pptDevices = this.parsePPTOutput(pptOutput);
                } catch (fallbackError) {
                    console.warn('⚠️  Failed to get PPT status:', fallbackError.message);
                    return;
                }
            }
            
            // Match PPT devices with PCI devices
            for (const pptDevice of pptDevices) {
                const matchingPciDevice = deviceData.find(device => 
                    device.vendor_id === pptDevice.vendor_id && 
                    device.device_id === pptDevice.device_id
                );
                
                if (matchingPciDevice) {
                    matchingPciDevice.ppt_enabled = true;
                    matchingPciDevice.ppt_device_path = pptDevice.dev;
                }
            }
            
        } catch (error) {
            console.warn('⚠️  Failed to check PPT status:', error.message);
        }
    }

    /**
     * Check zone assignments from database (no command execution)
     * @param {Array} deviceData - Array of device objects to update
     */
    async checkZoneAssignments(deviceData) {
        try {
            // Query existing zone data from database - NO zadm/zonecfg calls
            const zones = await Zones.findAll({
                where: { host: this.hostname },
                attributes: ['name', 'brand', 'status'] // Basic zone info for now
            });
            
            // For now, just log that we found zones
            // Zone configuration parsing will be enhanced when we have actual zone configs with device assignments
            for (const zone of zones) {
                if (zone.brand === 'bhyve') {
                }
            }
            
        } catch (error) {
            console.warn('⚠️  Failed to check zone assignments:', error.message);
        }
    }

    /**
     * Cross-reference devices with existing collector data (no command execution)
     * @param {Array} deviceData - Array of device objects to update
     */
    async crossReferenceWithCollectors(deviceData) {
        try {
            // Query NetworkInterfaces table - NO dladm re-execution
            const networkInterfaces = await NetworkInterfaces.findAll({
                where: { host: this.hostname },
                attributes: ['link', 'over', 'device'],
                order: [['scan_timestamp', 'DESC']],
                limit: 100
            });
            
            // Query Disks table - NO format re-execution  
            const diskInventory = await Disks.findAll({
                where: { host: this.hostname },
                attributes: ['device_name', 'manufacturer', 'model', 'interface_type'],
                order: [['scan_timestamp', 'DESC']],
                limit: 100
            });
            
            // Match PCI devices with network interfaces by device name
            for (const netInterface of networkInterfaces) {
                const matchingDevice = deviceData.find(device => 
                    // Match by driver name with device field (e.g., ixgbe0 -> ixgbe driver)
                    (device.driver_name && netInterface.device && netInterface.device.startsWith(device.driver_name)) ||
                    // Match by device category and device field
                    (device.device_category === 'network' && netInterface.device && 
                     device.driver_name && netInterface.device.includes(device.driver_name))
                );
                
                if (matchingDevice) {
                    matchingDevice.found_in_network_interfaces = true;
                }
            }
            
            // Match PCI devices with storage controllers
            for (const disk of diskInventory) {
                const matchingDevice = deviceData.find(device => 
                    device.device_category === 'storage' && (
                        device.device_name && device.device_name.toLowerCase().includes('sas') ||
                        device.driver_name && (device.driver_name.includes('mpt') || device.driver_name.includes('ahci'))
                    )
                );
                
                if (matchingDevice && !matchingDevice.found_in_disk_inventory) {
                    matchingDevice.found_in_disk_inventory = true;
                }
            }
            
        } catch (error) {
            console.warn('⚠️  Failed to cross-reference with collectors:', error.message);
        }
    }

    /**
     * Collect PCI device information
     * @description Main entry point for device data collection - follows established collector patterns
     */
    async collectPCIDevices() {
        if (this.isCollecting) {
            return true;
        }

        this.isCollecting = true;

        try {
            const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
            
            // NEW COMMAND: Parse prtconf -dD output for PCI devices
            const { stdout: prtconfOutput } = await execProm('prtconf -dD', { timeout });
            const deviceData = this.parsePrtconfOutput(prtconfOutput);

            if (deviceData.length === 0) {
                return true;
            }

            // Check PPT status if available (NEW COMMAND)
            await this.checkPPTStatus(deviceData);
            
            // Cross-reference with zone configurations (DATABASE QUERY ONLY)
            await this.checkZoneAssignments(deviceData);
            
            // Cross-reference with existing network/storage data (DATABASE QUERY ONLY)
            await this.crossReferenceWithCollectors(deviceData);
            
            // Store in database with batching (STANDARD PATTERN)
            const batchSize = this.hostMonitoringConfig.performance.batch_size;
            for (let i = 0; i < deviceData.length; i += batchSize) {
                const batch = deviceData.slice(i, i + batchSize);
                await PCIDevices.bulkCreate(batch, {
                    updateOnDuplicate: Object.keys(PCIDevices.rawAttributes).filter(key => key !== 'id')
                });
            }
            
            await this.updateHostInfo({ last_device_scan: new Date() });
            await this.resetErrorCount();
            
            // Log summary by category
            const categoryCount = {};
            deviceData.forEach(device => {
                categoryCount[device.device_category] = (categoryCount[device.device_category] || 0) + 1;
            });
            
            return true;

        } catch (error) {
            const shouldContinue = await this.handleError(error, 'PCI device collection');
            return shouldContinue;
        } finally {
            this.isCollecting = false;
        }
    }

    /**
     * Clean up old device data based on retention policies
     */
    async cleanupOldData() {
        try {
            const retentionConfig = this.hostMonitoringConfig.retention;
            const now = new Date();

            // Clean device data (use same retention as storage data)
            const deviceRetentionDate = new Date(now.getTime() - (retentionConfig.storage * 24 * 60 * 60 * 1000));
            const deletedDevices = await PCIDevices.destroy({
                where: {
                    scan_timestamp: { [require('sequelize').Op.lt]: deviceRetentionDate }
                }
            });

            if (deletedDevices > 0) {
            }

        } catch (error) {
            console.error('❌ Failed to cleanup old device data:', error.message);
        }
    }
}

export default DeviceCollector;
