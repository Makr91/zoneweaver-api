/**
 * @fileoverview Host Monitoring Service for Zoneweaver API
 * @description Coordinates network and storage data collection with configurable intervals
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import config from "../config/ConfigLoader.js";
import NetworkCollector from "./NetworkCollector.js";
import StorageCollector from "./StorageCollector.js";
import DeviceCollector from "./DeviceCollector.js";
import SystemMetricsCollector from "./SystemMetricsCollector.js";
import { cleanupOldTasks } from "./TaskQueue.js";
import CleanupService from "./CleanupService.js";
import HostInfo from "../models/HostInfoModel.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import NetworkUsage from "../models/NetworkUsageModel.js";
import IPAddresses from "../models/IPAddressModel.js";
import Routes from "../models/RoutingTableModel.js";
import ZFSPools from "../models/ZFSPoolModel.js";
import ZFSDatasets from "../models/ZFSDatasetModel.js";
import Disks from "../models/DiskModel.js";
import VncSessions from "../models/VncSessionModel.js";
import Entities from "../models/EntityModel.js";
import Hosts from "../models/HostModel.js";
import Tasks from "../models/TaskModel.js";
import Zones from "../models/ZoneModel.js";
import db from "../config/Database.js";
import DatabaseMigrations from "../config/DatabaseMigrations.js";
import { getRebootStatus, checkAndClearAfterReboot } from "../lib/RebootManager.js";
import { getFaultStatusForHealth } from "./FaultManagementController.js";
import os from "os";

/**
 * Host Monitoring Service Class
 * @description Main service that orchestrates all host data collection activities
 */
class HostMonitoringService {
    constructor() {
        this.hostMonitoringConfig = config.getHostMonitoring();
        this.hostname = os.hostname();
        this.networkCollector = new NetworkCollector();
        this.storageCollector = new StorageCollector();
        this.deviceCollector = new DeviceCollector();
        this.systemMetricsCollector = new SystemMetricsCollector();
        
        // Interval IDs for cleanup
        this.intervals = {
            networkConfig: null,
            networkUsage: null,
            storage: null,
            storageFrequent: null,
            deviceDiscovery: null,
            systemMetrics: null,
            cleanup: null
        };
        
        this.isRunning = false;
        this.isInitialized = false;
        
        // Performance tracking
        this.stats = {
            networkConfigRuns: 0,
            networkUsageRuns: 0,
            storageRuns: 0,
            deviceRuns: 0,
            systemMetricsRuns: 0,
            lastNetworkConfigSuccess: null,
            lastNetworkUsageSuccess: null,
            lastStorageSuccess: null,
            lastDeviceSuccess: null,
            lastSystemMetricsSuccess: null,
            totalErrors: 0
        };
    }

    /**
     * Register cleanup tasks with CleanupService
     * @description Registers all collector cleanup functions with the centralized CleanupService
     */
    registerCleanupTasks() {
        try {
            // Register network data cleanup
            CleanupService.registerTask({
                name: 'network_cleanup',
                description: 'Clean up old network statistics and usage data',
                handler: async () => {
                    await this.networkCollector.cleanupOldData();
                }
            });

            // Register storage data cleanup
            CleanupService.registerTask({
                name: 'storage_cleanup', 
                description: 'Clean up old storage and ZFS data',
                handler: async () => {
                    await this.storageCollector.cleanupOldData();
                }
            });

            // Register device data cleanup
            CleanupService.registerTask({
                name: 'device_cleanup',
                description: 'Clean up old PCI device data',
                handler: async () => {
                    await this.deviceCollector.cleanupOldData();
                }
            });

            // Register system metrics cleanup
            CleanupService.registerTask({
                name: 'system_metrics_cleanup',
                description: 'Clean up old CPU and memory statistics',
                handler: async () => {
                    await this.systemMetricsCollector.cleanupOldData();
                }
            });

            // Register task cleanup
            CleanupService.registerTask({
                name: 'task_cleanup',
                description: 'Clean up old completed, failed, and cancelled tasks',
                handler: async () => {
                    await cleanupOldTasks();
                }
            });

            console.log('📋 Registered all cleanup tasks with CleanupService');
            
            // Start CleanupService now that all tasks are registered
            CleanupService.start();
            
        } catch (error) {
            console.error('❌ Failed to register cleanup tasks:', error.message);
        }
    }

    /**
     * Initialize the monitoring service
     * @description Sets up network accounting and performs initial data collection
     */
    async initialize() {
        if (this.isInitialized) {
            return true;
        }

        if (!this.hostMonitoringConfig.enabled) {
            return false;
        }

        try {
            // Initialize database schema and run migrations
            try {
                // Run database migrations first
                await DatabaseMigrations.setupDatabase();
            } catch (error) {
                console.warn('⚠️  Database migration warning:', error.message);
                // Try basic sync as fallback
                try {
                    await db.sync({ alter: false, force: false });
                } catch (syncError) {
                    console.error('❌ Database initialization failed:', syncError.message);
                    throw syncError;
                }
            }

            // Initialize host info record
            await HostInfo.upsert({
                host: this.hostname,
                hostname: this.hostname,
                platform: os.platform(),
                release: os.release(),
                arch: os.arch(),
                uptime: Math.floor(os.uptime()),
                network_acct_enabled: false,
                network_scan_errors: 0,
                storage_scan_errors: 0,
                last_error_message: null
            });

            // Initialize network accounting
            const networkAcctEnabled = await this.networkCollector.initializeNetworkAccounting();
            if (!networkAcctEnabled) {
                console.warn('⚠️  Network accounting initialization failed or disabled');
            }

            // Perform initial data collection
            // Initial network config collection (async)
            this.networkCollector.collectNetworkConfig().catch(error => {
                console.error('❌ Initial network config collection failed:', error.message);
            });

            // Initial storage collection (async)
            this.storageCollector.collectStorageData().catch(error => {
                console.error('❌ Initial storage collection failed:', error.message);
            });

            // Initial system metrics collection (async)
            this.systemMetricsCollector.collectSystemMetrics().catch(error => {
                console.error('❌ Initial system metrics collection failed:', error.message);
            });

            // Check and clear reboot flags if system has rebooted since flags were created
            try {
                const rebootCheckResult = await checkAndClearAfterReboot();
                if (rebootCheckResult.action === 'cleared') {
                    console.log(`🔄 Cleared reboot flags on startup: ${rebootCheckResult.reasons_cleared?.join(', ')}`);
                } else if (rebootCheckResult.action === 'kept') {
                    console.log(`🔄 Keeping reboot flags (system not rebooted): age ${rebootCheckResult.flag_age_minutes}min`);
                }
            } catch (error) {
                console.warn('⚠️  Failed to check reboot flags on startup:', error.message);
            }

            // Register cleanup tasks with CleanupService
            this.registerCleanupTasks();

            this.isInitialized = true;
            return true;

        } catch (error) {
            console.error('❌ Failed to initialize host monitoring service:', error.message);
            return false;
        }
    }

    /**
     * Start all monitoring intervals
     * @description Begins scheduled data collection based on configured intervals
     */
    async start() {
        if (!this.isInitialized) {
            const initialized = await this.initialize();
            if (!initialized) {
                console.error('❌ Cannot start host monitoring - initialization failed');
                return false;
            }
        }

        if (this.isRunning) {
            return true;
        }

        try {
            const intervals = this.hostMonitoringConfig.intervals;

            // Network configuration collection (1 minute default)
            this.intervals.networkConfig = setInterval(async () => {
                try {
                    this.stats.networkConfigRuns++;
                    const success = await this.networkCollector.collectNetworkConfig();
                    if (success) {
                        this.stats.lastNetworkConfigSuccess = new Date();
                    }
                } catch (error) {
                    this.stats.totalErrors++;
                    console.error('❌ Scheduled network config collection failed:', error.message);
                }
            }, intervals.network_config * 1000);


            // Network usage collection (10 seconds default)
            this.intervals.networkUsage = setInterval(async () => {
                try {
                    this.stats.networkUsageRuns++;
                    const success = await this.networkCollector.collectNetworkUsage();
                    if (success) {
                        this.stats.lastNetworkUsageSuccess = new Date();
                    }
                } catch (error) {
                    this.stats.totalErrors++;
                    console.error('❌ Scheduled network usage collection failed:', error.message);
                }
            }, intervals.network_usage * 1000);

            // Storage collection (5 minutes default)
            this.intervals.storage = setInterval(async () => {
                try {
                    this.stats.storageRuns++;
                    const success = await this.storageCollector.collectStorageData();
                    if (success) {
                        this.stats.lastStorageSuccess = new Date();
                    }
                } catch (error) {
                    this.stats.totalErrors++;
                    console.error('❌ Scheduled storage collection failed:', error.message);
                }
            }, intervals.storage * 1000);

            // Frequent storage metrics collection (10 seconds for disk I/O, 60 seconds for ARC)
            this.intervals.storageFrequent = setInterval(async () => {
                try {
                    const success = await this.storageCollector.collectFrequentStorageMetrics();
                    if (!success) {
                        this.stats.totalErrors++;
                    }
                } catch (error) {
                    this.stats.totalErrors++;
                    console.error('❌ Scheduled frequent storage collection failed:', error.message);
                }
            }, intervals.storage_frequent * 1000); // Configurable frequent storage interval

            // Device discovery collection (1 minute default)
            this.intervals.deviceDiscovery = setInterval(async () => {
                try {
                    this.stats.deviceRuns++;
                    const success = await this.deviceCollector.collectPCIDevices();
                    if (success) {
                        this.stats.lastDeviceSuccess = new Date();
                    }
                } catch (error) {
                    this.stats.totalErrors++;
                    console.error('❌ Scheduled device discovery failed:', error.message);
                }
            }, intervals.device_discovery * 1000);

            // System metrics collection (CPU + Memory, 30 seconds default)
            this.intervals.systemMetrics = setInterval(async () => {
                try {
                    this.stats.systemMetricsRuns++;
                    const success = await this.systemMetricsCollector.collectSystemMetrics();
                    if (success) {
                        this.stats.lastSystemMetricsSuccess = new Date();
                    }
                } catch (error) {
                    this.stats.totalErrors++;
                    console.error('❌ Scheduled system metrics collection failed:', error.message);
                }
            }, intervals.system_metrics * 1000);

            this.isRunning = true;
            return true;

        } catch (error) {
            console.error('❌ Failed to start host monitoring service:', error.message);
            this.stop(); // Cleanup any partial initialization
            return false;
        }
    }

    /**
     * Stop all monitoring intervals
     * @description Stops all scheduled data collection
     */
    stop() {
        Object.values(this.intervals).forEach(intervalId => {
            if (intervalId) {
                clearInterval(intervalId);
            }
        });

        // Reset interval IDs
        Object.keys(this.intervals).forEach(key => {
            this.intervals[key] = null;
        });

        this.isRunning = false;
    }

    /**
     * Restart the monitoring service
     * @description Stops and starts the service
     */
    async restart() {
        this.stop();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
        return await this.start();
    }

    /**
     * Get current service status
     * @returns {Object} Service status information
     */
    getStatus() {
        return {
            isRunning: this.isRunning,
            isInitialized: this.isInitialized,
            config: {
                enabled: this.hostMonitoringConfig.enabled,
                intervals: this.hostMonitoringConfig.intervals,
                retention: this.hostMonitoringConfig.retention
            },
            stats: {
                ...this.stats,
                uptime: this.isRunning ? Math.floor((Date.now() - (this.stats.lastNetworkConfigSuccess || Date.now())) / 1000) : 0
            },
            activeIntervals: {
                networkConfig: !!this.intervals.networkConfig,
                networkUsage: !!this.intervals.networkUsage,
                storage: !!this.intervals.storage,
                storageFrequent: !!this.intervals.storageFrequent,
                systemMetrics: !!this.intervals.systemMetrics,
                cleanup: !!this.intervals.cleanup
            }
        };
    }

    /**
     * Trigger immediate data collection
     * @param {string} type - Type of collection ('network', 'storage', 'devices', 'system', 'all')
     * @returns {Object} Collection results
     */
    async triggerCollection(type = 'all') {
        const results = {
            networkConfig: null,
            networkUsage: null,
            storage: null,
            devices: null,
            systemMetrics: null,
            errors: []
        };

        try {
            if (type === 'network' || type === 'all') {
                try {
                    results.networkConfig = await this.networkCollector.collectNetworkConfig();
                    results.networkUsage = await this.networkCollector.collectNetworkUsage();
                } catch (error) {
                    results.errors.push(`Network collection: ${error.message}`);
                }
            }

            if (type === 'storage' || type === 'all') {
                try {
                    results.storage = await this.storageCollector.collectStorageData();
                } catch (error) {
                    results.errors.push(`Storage collection: ${error.message}`);
                }
            }

            if (type === 'devices' || type === 'all') {
                try {
                    results.devices = await this.deviceCollector.collectPCIDevices();
                } catch (error) {
                    results.errors.push(`Device collection: ${error.message}`);
                }
            }

            if (type === 'system' || type === 'all') {
                try {
                    results.systemMetrics = await this.systemMetricsCollector.collectSystemMetrics();
                } catch (error) {
                    results.errors.push(`System metrics collection: ${error.message}`);
                }
            }

            return results;

        } catch (error) {
            console.error(`❌ Immediate ${type} collection failed:`, error.message);
            results.errors.push(`General error: ${error.message}`);
            return results;
        }
    }

    /**
     * Update configuration and restart if needed
     * @param {Object} newConfig - New configuration settings
     */
    async updateConfig(newConfig) {
        try {
            // This would typically involve updating the config file
            // For now, we'll just restart with current config
            Object.assign(this.hostMonitoringConfig, newConfig);
            
            if (this.isRunning) {
                await this.restart();
            }
            
            return true;

        } catch (error) {
            console.error('❌ Failed to update configuration:', error.message);
            return false;
        }
    }

    /**
     * Get health check information
     * @returns {Object} Health status
     */
    async getHealthCheck() {
        try {
            const hostInfo = await HostInfo.findOne({
                where: { host: this.hostname }
            });

            const now = new Date();
            const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

            // Get reboot status
            const rebootStatus = await getRebootStatus();

            // Get fault status
            const faultStatus = await getFaultStatusForHealth();

            // Calculate overall system health status
            let overallStatus = this.isRunning ? 'healthy' : 'stopped';
            
            if (faultStatus.hasFaults) {
                const hasCritical = faultStatus.severityLevels.includes('Critical');
                const hasMajor = faultStatus.severityLevels.includes('Major');
                
                if (hasCritical) {
                    overallStatus = 'critical';
                } else if (hasMajor) {
                    overallStatus = 'faulted';
                } else {
                    overallStatus = 'degraded';
                }
            }

            return {
                status: overallStatus,
                lastUpdate: hostInfo ? hostInfo.updated_at : null,
                networkErrors: hostInfo ? hostInfo.network_scan_errors : 0,
                storageErrors: hostInfo ? hostInfo.storage_scan_errors : 0,
                faultStatus: {
                    hasFaults: faultStatus.hasFaults,
                    faultCount: faultStatus.faultCount,
                    severityLevels: faultStatus.severityLevels,
                    lastCheck: faultStatus.lastCheck,
                    faults: faultStatus.faults || [],
                    error: faultStatus.error || null
                },
                recentActivity: {
                    network: hostInfo && hostInfo.last_network_scan > fiveMinutesAgo,
                    storage: hostInfo && hostInfo.last_storage_scan > fiveMinutesAgo
                },
                uptime: Math.floor(os.uptime()),
                reboot_required: rebootStatus.reboot_required,
                reboot_info: rebootStatus.reboot_required ? {
                    timestamp: rebootStatus.timestamp,
                    reasons: rebootStatus.reasons,
                    age_minutes: rebootStatus.age_minutes,
                    created_by: rebootStatus.created_by
                } : null,
                service: this.getStatus()
            };

        } catch (error) {
            return {
                status: 'error',
                error: error.message,
                uptime: Math.floor(os.uptime())
            };
        }
    }
}

// Create singleton instance
const hostMonitoringService = new HostMonitoringService();

/**
 * Start host monitoring service
 * @description Exported function to start the service
 */
export const startHostMonitoring = async () => {
    return await hostMonitoringService.start();
};

/**
 * Stop host monitoring service
 * @description Exported function to stop the service
 */
export const stopHostMonitoring = () => {
    hostMonitoringService.stop();
};

/**
 * Get service instance
 * @description Exported function to get the service instance
 */
export const getHostMonitoringService = () => {
    return hostMonitoringService;
};

export default hostMonitoringService;
