/**
 * @fileoverview Host Monitoring Service for Zoneweaver API
 * @description Coordinates network and storage data collection with configurable intervals
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import NetworkCollector from './NetworkCollectorController/index.js';
import StorageCollector from './StorageController/index.js';
import DeviceCollector from './DeviceCollector.js';
import SystemMetricsCollector from './SystemMetricsCollector.js';
import { cleanupOldTasks } from './TaskQueue.js';
import CleanupService from './CleanupService.js';
import HostInfo from '../models/HostInfoModel.js';
import NetworkInterfaces from '../models/NetworkInterfaceModel.js';
import NetworkUsage from '../models/NetworkUsageModel.js';
import IPAddresses from '../models/IPAddressModel.js';
import Routes from '../models/RoutingTableModel.js';
import ZFSPools from '../models/ZFSPoolModel.js';
import ZFSDatasets from '../models/ZFSDatasetModel.js';
import Disks from '../models/DiskModel.js';
import VncSessions from '../models/VncSessionModel.js';
import Entities from '../models/EntityModel.js';
import Hosts from '../models/HostModel.js';
import Tasks from '../models/TaskModel.js';
import Zones from '../models/ZoneModel.js';
import db from '../config/Database.js';
import DatabaseMigrations from '../config/DatabaseMigrations.js';
import { getRebootStatus, checkAndClearAfterReboot } from '../lib/RebootManager.js';
import { getFaultStatusForHealth } from './FaultManagementController.js';
import { log, createTimer } from '../lib/Logger.js';
import os from 'os';

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
      cleanup: null,
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
      totalErrors: 0,
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
        },
      });

      // Register storage data cleanup
      CleanupService.registerTask({
        name: 'storage_cleanup',
        description: 'Clean up old storage and ZFS data',
        handler: async () => {
          await this.storageCollector.cleanupOldData();
        },
      });

      // Register device data cleanup
      CleanupService.registerTask({
        name: 'device_cleanup',
        description: 'Clean up old PCI device data',
        handler: async () => {
          await this.deviceCollector.cleanupOldData();
        },
      });

      // Register system metrics cleanup
      CleanupService.registerTask({
        name: 'system_metrics_cleanup',
        description: 'Clean up old CPU and memory statistics',
        handler: async () => {
          await this.systemMetricsCollector.cleanupOldData();
        },
      });

      // Register task cleanup
      CleanupService.registerTask({
        name: 'task_cleanup',
        description: 'Clean up old completed, failed, and cancelled tasks',
        handler: async () => {
          await cleanupOldTasks();
        },
      });

      log.monitoring.info('Cleanup tasks registration completed', {
        tasks_registered: 5,
        cleanup_service_started: true,
      });

      // Start CleanupService now that all tasks are registered
      CleanupService.start();
    } catch (error) {
      log.monitoring.error('Failed to register cleanup tasks', {
        error: error.message,
        stack: error.stack,
      });
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
        log.database.warn('Database migration warning', {
          error: error.message,
          hostname: this.hostname,
        });
        // Try basic sync as fallback
        try {
          await db.sync({ alter: false, force: false });
        } catch (syncError) {
          log.database.error('Database initialization failed', {
            error: syncError.message,
            stack: syncError.stack,
            hostname: this.hostname,
          });
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
        last_error_message: null,
      });

      // Initialize network accounting
      const networkAcctEnabled = await this.networkCollector.initializeNetworkAccounting();
      if (!networkAcctEnabled) {
        log.monitoring.warn('Network accounting initialization failed or disabled', {
          hostname: this.hostname,
        });
      }

      // Perform initial data collection
      // Initial network config collection (async)
      this.networkCollector.collectNetworkConfig().catch(error => {
        log.monitoring.error('Initial network config collection failed', {
          error: error.message,
          hostname: this.hostname,
        });
      });

      // Initial storage collection (async)
      this.storageCollector.collectStorageData().catch(error => {
        log.monitoring.error('Initial storage collection failed', {
          error: error.message,
          hostname: this.hostname,
        });
      });

      // Initial system metrics collection (async)
      this.systemMetricsCollector.collectSystemMetrics().catch(error => {
        log.monitoring.error('Initial system metrics collection failed', {
          error: error.message,
          hostname: this.hostname,
        });
      });

      // Check and clear reboot flags if system has rebooted since flags were created
      try {
        const rebootCheckResult = await checkAndClearAfterReboot();
        if (rebootCheckResult.action === 'cleared') {
          log.monitoring.info('Reboot flags cleared on startup', {
            reasons_cleared: rebootCheckResult.reasons_cleared,
            hostname: this.hostname,
          });
        } else if (rebootCheckResult.action === 'kept') {
          log.monitoring.debug('Keeping reboot flags (system not rebooted)', {
            flag_age_minutes: rebootCheckResult.flag_age_minutes,
            hostname: this.hostname,
          });
        }
      } catch (error) {
        log.monitoring.warn('Failed to check reboot flags on startup', {
          error: error.message,
          hostname: this.hostname,
        });
      }

      // Register cleanup tasks with CleanupService
      this.registerCleanupTasks();

      this.isInitialized = true;
      return true;
    } catch (error) {
      log.monitoring.error('Failed to initialize host monitoring service', {
        error: error.message,
        stack: error.stack,
        hostname: this.hostname,
      });
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
        log.monitoring.error('Cannot start host monitoring - initialization failed', {
          hostname: this.hostname,
        });
        return false;
      }
    }

    if (this.isRunning) {
      return true;
    }

    try {
      const { intervals } = this.hostMonitoringConfig;

      // Network configuration collection (1 minute default)
      this.intervals.networkConfig = setInterval(async () => {
        try {
          this.stats.networkConfigRuns++;
          const timer = createTimer('network_config_collection');
          const success = await this.networkCollector.collectNetworkConfig();
          const duration = timer.end();

          if (success) {
            this.stats.lastNetworkConfigSuccess = new Date();
            if (duration > 5000) {
              // Log slow collections
              log.performance.warn('Slow network config collection', {
                duration_ms: duration,
                hostname: this.hostname,
              });
            }
          }
        } catch (error) {
          this.stats.totalErrors++;
          log.monitoring.error('Scheduled network config collection failed', {
            error: error.message,
            hostname: this.hostname,
            run_count: this.stats.networkConfigRuns,
          });
        }
      }, intervals.network_config * 1000);

      // Network usage collection (10 seconds default)
      this.intervals.networkUsage = setInterval(async () => {
        try {
          this.stats.networkUsageRuns++;
          const timer = createTimer('network_usage_collection');
          const success = await this.networkCollector.collectNetworkUsage();
          const duration = timer.end();

          if (success) {
            this.stats.lastNetworkUsageSuccess = new Date();
            if (duration > 3000) {
              // Log slow collections (this runs frequently)
              log.performance.warn('Slow network usage collection', {
                duration_ms: duration,
                hostname: this.hostname,
              });
            }
          }
        } catch (error) {
          this.stats.totalErrors++;
          log.monitoring.error('Scheduled network usage collection failed', {
            error: error.message,
            hostname: this.hostname,
            run_count: this.stats.networkUsageRuns,
          });
        }
      }, intervals.network_usage * 1000);

      // Storage collection (5 minutes default)
      this.intervals.storage = setInterval(async () => {
        try {
          this.stats.storageRuns++;
          const timer = createTimer('storage_collection');
          const success = await this.storageCollector.collectStorageData();
          const duration = timer.end();

          if (success) {
            this.stats.lastStorageSuccess = new Date();
            if (duration > 10000) {
              // Log slow collections
              log.performance.warn('Slow storage collection', {
                duration_ms: duration,
                hostname: this.hostname,
              });
            }
          }
        } catch (error) {
          this.stats.totalErrors++;
          log.monitoring.error('Scheduled storage collection failed', {
            error: error.message,
            hostname: this.hostname,
            run_count: this.stats.storageRuns,
          });
        }
      }, intervals.storage * 1000);

      // Frequent storage metrics collection (10 seconds for disk I/O, 60 seconds for ARC)
      this.intervals.storageFrequent = setInterval(async () => {
        try {
          const timer = createTimer('frequent_storage_collection');
          const success = await this.storageCollector.collectFrequentStorageMetrics();
          const duration = timer.end();

          if (!success) {
            this.stats.totalErrors++;
          } else if (duration > 2000) {
            // Log slow frequent collections
            log.performance.warn('Slow frequent storage collection', {
              duration_ms: duration,
              hostname: this.hostname,
            });
          }
        } catch (error) {
          this.stats.totalErrors++;
          log.monitoring.error('Scheduled frequent storage collection failed', {
            error: error.message,
            hostname: this.hostname,
          });
        }
      }, intervals.storage_frequent * 1000);

      // Device discovery collection (1 minute default)
      this.intervals.deviceDiscovery = setInterval(async () => {
        try {
          this.stats.deviceRuns++;
          const timer = createTimer('device_discovery_collection');
          const success = await this.deviceCollector.collectPCIDevices();
          const duration = timer.end();

          if (success) {
            this.stats.lastDeviceSuccess = new Date();
            if (duration > 5000) {
              // Log slow collections
              log.performance.warn('Slow device discovery collection', {
                duration_ms: duration,
                hostname: this.hostname,
              });
            }
          }
        } catch (error) {
          this.stats.totalErrors++;
          log.monitoring.error('Scheduled device discovery failed', {
            error: error.message,
            hostname: this.hostname,
            run_count: this.stats.deviceRuns,
          });
        }
      }, intervals.device_discovery * 1000);

      // System metrics collection (CPU + Memory, 30 seconds default)
      this.intervals.systemMetrics = setInterval(async () => {
        try {
          this.stats.systemMetricsRuns++;
          const timer = createTimer('system_metrics_collection');
          const success = await this.systemMetricsCollector.collectSystemMetrics();
          const duration = timer.end();

          if (success) {
            this.stats.lastSystemMetricsSuccess = new Date();
            if (duration > 3000) {
              // Log slow collections
              log.performance.warn('Slow system metrics collection', {
                duration_ms: duration,
                hostname: this.hostname,
              });
            }
          }
        } catch (error) {
          this.stats.totalErrors++;
          log.monitoring.error('Scheduled system metrics collection failed', {
            error: error.message,
            hostname: this.hostname,
            run_count: this.stats.systemMetricsRuns,
          });
        }
      }, intervals.system_metrics * 1000);

      this.isRunning = true;
      return true;
    } catch (error) {
      log.monitoring.error('Failed to start host monitoring service', {
        error: error.message,
        stack: error.stack,
        hostname: this.hostname,
      });
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
        retention: this.hostMonitoringConfig.retention,
      },
      stats: {
        ...this.stats,
        uptime: this.isRunning
          ? Math.floor((Date.now() - (this.stats.lastNetworkConfigSuccess || Date.now())) / 1000)
          : 0,
      },
      activeIntervals: {
        networkConfig: !!this.intervals.networkConfig,
        networkUsage: !!this.intervals.networkUsage,
        storage: !!this.intervals.storage,
        storageFrequent: !!this.intervals.storageFrequent,
        systemMetrics: !!this.intervals.systemMetrics,
        cleanup: !!this.intervals.cleanup,
      },
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
      errors: [],
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
      log.monitoring.error('Immediate collection failed', {
        error: error.message,
        type,
        hostname: this.hostname,
      });
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
      log.monitoring.error('Failed to update configuration', {
        error: error.message,
        stack: error.stack,
        hostname: this.hostname,
      });
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
        where: { host: this.hostname },
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
          error: faultStatus.error || null,
        },
        recentActivity: {
          network: hostInfo && hostInfo.last_network_scan > fiveMinutesAgo,
          storage: hostInfo && hostInfo.last_storage_scan > fiveMinutesAgo,
        },
        uptime: Math.floor(os.uptime()),
        reboot_required: rebootStatus.reboot_required,
        reboot_info: rebootStatus.reboot_required
          ? {
              timestamp: rebootStatus.timestamp,
              reasons: rebootStatus.reasons,
              age_minutes: rebootStatus.age_minutes,
              created_by: rebootStatus.created_by,
            }
          : null,
        service: this.getStatus(),
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        uptime: Math.floor(os.uptime()),
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
export const startHostMonitoring = async () => await hostMonitoringService.start();

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
export const getHostMonitoringService = () => hostMonitoringService;

export default hostMonitoringService;
