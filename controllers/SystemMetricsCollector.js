/**
 * @fileoverview System Metrics Data Collection Controller for Zoneweaver API
 * @description Collects CPU and memory statistics from OmniOS system utilities
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import config from '../config/ConfigLoader.js';
import CPUStats from '../models/CPUStatsModel.js';
import MemoryStats from '../models/MemoryStatsModel.js';
import SwapArea from '../models/SwapAreaModel.js';
import HostInfo from '../models/HostInfoModel.js';
import { Op } from 'sequelize';
import { log, createTimer } from '../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * System Metrics Data Collector Class
 * @description Handles collection of CPU and memory performance data
 */
class SystemMetricsCollector {
  constructor() {
    this.hostMonitoringConfig = config.getHostMonitoring();
    this.hostname = os.hostname();
    this.isCollecting = false;
    this.errorCount = 0;
    this.lastErrorReset = Date.now();
    this.lastCPUTimes = null;
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
        updated_at: new Date(),
      });
    } catch (error) {
      log.database.error('Failed to update host info', {
        error: error.message,
        hostname: this.hostname,
        updates: Object.keys(updates),
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

    log.monitoring.error('System metrics collection error', {
      error: error.message,
      operation,
      error_count: this.errorCount,
      max_errors: maxErrors,
      hostname: this.hostname,
    });

    await this.updateHostInfo({
      system_scan_errors: this.errorCount,
      last_error_message: errorMessage,
    });

    if (this.errorCount >= maxErrors) {
      log.monitoring.error('System metrics collector disabled due to consecutive errors', {
        error_count: this.errorCount,
        max_errors: maxErrors,
        operation,
        hostname: this.hostname,
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
        system_scan_errors: 0,
        last_error_message: null,
      });
    }
  }

  /**
   * Parse vmstat output for CPU and memory statistics
   * @param {string} output - vmstat command output
   * @returns {Object} Parsed statistics
   */
  parseVmstatOutput(output) {
    const lines = output.trim().split('\n');
    const stats = {
      cpu: {},
      memory: {},
      processes: {},
    };

    try {
      // Find the data line (usually the last line)
      const dataLine = lines[lines.length - 1];
      const values = dataLine.trim().split(/\s+/);

      if (values.length >= 22) {
        // OmniOS vmstat format (approximate):
        // kthr      memory            page            disk          faults      cpu
        // r b   swap  free  re  mf pi po fr de sr s0 s1 s2 s3   in   sy   cs us sy id

        // Process statistics
        stats.processes.running = parseInt(values[0]) || 0;
        stats.processes.blocked = parseInt(values[1]) || 0;

        // Memory statistics (in KB typically)
        stats.memory.swap_kb = parseInt(values[2]) || 0;
        stats.memory.free_kb = parseInt(values[3]) || 0;

        // Page statistics
        stats.memory.page_reclaims = parseInt(values[4]) || 0;
        stats.memory.minor_faults = parseInt(values[5]) || 0;
        stats.memory.page_in = parseInt(values[6]) || 0;
        stats.memory.page_out = parseInt(values[7]) || 0;

        // System statistics
        stats.cpu.interrupts = parseInt(values[values.length - 6]) || 0;
        stats.cpu.system_calls = parseInt(values[values.length - 5]) || 0;
        stats.cpu.context_switches = parseInt(values[values.length - 4]) || 0;

        // CPU percentages
        stats.cpu.user_pct = parseFloat(values[values.length - 3]) || 0;
        stats.cpu.system_pct = parseFloat(values[values.length - 2]) || 0;
        stats.cpu.idle_pct = parseFloat(values[values.length - 1]) || 0;
      }
    } catch (error) {
      log.monitoring.warn('Failed to parse vmstat output', {
        error: error.message,
        hostname: this.hostname,
      });
    }

    return stats;
  }

  /**
   * Parse kstat memory information
   * @param {string} output - kstat command output
   * @returns {Object} Memory statistics
   */
  parseKstatMemory(output) {
    const stats = {};
    const lines = output.trim().split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }

      // Handle kstat format: unix:0:system_pages:physmem     50313829
      // Split on whitespace, expecting key and value
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const key = parts[0];
        const value = parts[parts.length - 1]; // Take last part as value

        if (key.endsWith(':physmem')) {
          stats.physmem_pages = parseInt(value) || 0;
        } else if (key.endsWith(':freemem')) {
          stats.freemem_pages = parseInt(value) || 0;
        } else if (key.endsWith(':availrmem')) {
          stats.availrmem_pages = parseInt(value) || 0;
        } else if (key.endsWith(':pagestotal')) {
          stats.pagestotal_pages = parseInt(value) || 0;
        } else if (key.endsWith(':pagesfree')) {
          stats.pagesfree_pages = parseInt(value) || 0;
        } else if (key.endsWith(':pageslocked')) {
          stats.pageslocked_pages = parseInt(value) || 0;
        } else if (key.endsWith(':lotsfree')) {
          stats.lotsfree_pages = parseInt(value) || 0;
        } else if (key.endsWith(':desfree')) {
          stats.desfree_pages = parseInt(value) || 0;
        } else if (key.endsWith(':minfree')) {
          stats.minfree_pages = parseInt(value) || 0;
        } else if (key.endsWith(':pp_kernel')) {
          stats.pp_kernel_pages = parseInt(value) || 0;
        } else if (key.endsWith(':nalloc')) {
          stats.page_allocs = parseInt(value) || 0;
        } else if (key.endsWith(':nfree')) {
          stats.page_frees = parseInt(value) || 0;
        } else if (key.endsWith(':nscan')) {
          stats.page_scans = parseInt(value) || 0;
        }
      }
    }

    // Set default page size (standard for most systems)
    stats.page_size_bytes = 4096;

    return stats;
  }

  /**
   * Parse swap -s output for swap statistics
   * @param {string} output - swap -s command output
   * @returns {Object} Swap statistics
   */
  parseSwapOutput(output) {
    const stats = {};

    try {
      // Example: total: 8388608k bytes allocated + 0k reserved = 8388608k used, 16777216k available
      const match = output.match(/total:\s+(\d+)k.*?=\s+(\d+)k\s+used,\s+(\d+)k\s+available/);
      if (match) {
        stats.swap_allocated_kb = parseInt(match[1]) || 0;
        stats.swap_used_kb = parseInt(match[2]) || 0;
        stats.swap_available_kb = parseInt(match[3]) || 0;
        stats.swap_total_kb = stats.swap_used_kb + stats.swap_available_kb;
      }
    } catch (error) {
      log.monitoring.warn('Failed to parse swap output', {
        error: error.message,
        hostname: this.hostname,
      });
    }

    return stats;
  }

  /**
   * Get load averages
   * @returns {Object} Load average statistics
   */
  getLoadAverages() {
    const loadavg = os.loadavg();
    return {
      load_avg_1min: loadavg[0] || 0,
      load_avg_5min: loadavg[1] || 0,
      load_avg_15min: loadavg[2] || 0,
    };
  }

  /**
   * Collect CPU statistics with per-core data
   * @returns {Promise<boolean>} Success status
   */
  async collectCPUStats() {
    if (this.isCollecting) {
      return true;
    }

    this.isCollecting = true;

    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get vmstat data (2 samples, 1 second apart for accurate CPU usage)
      const { stdout: vmstatOutput } = await execProm('vmstat 1 2', { timeout });
      const vmstatStats = this.parseVmstatOutput(vmstatOutput);

      // Get per-core CPU data using os.cpus()
      const currentCPUTimes = os.cpus();
      let perCoreData = [];

      if (this.lastCPUTimes) {
        perCoreData = currentCPUTimes.map((core, i) => {
          const lastCore = this.lastCPUTimes[i];
          const totalDiff =
            core.times.user -
            lastCore.times.user +
            (core.times.nice - lastCore.times.nice) +
            (core.times.sys - lastCore.times.sys) +
            (core.times.idle - lastCore.times.idle) +
            (core.times.irq - lastCore.times.irq);

          if (totalDiff === 0) {
            return {
              cpu_id: `cpu${i}`,
              user_pct: 0,
              system_pct: 0,
              idle_pct: 100,
              iowait_pct: 0,
              utilization_pct: 0,
            };
          }

          const idleDiff = core.times.idle - lastCore.times.idle;
          const userDiff = core.times.user - lastCore.times.user;
          const sysDiff = core.times.sys - lastCore.times.sys;

          return {
            cpu_id: `cpu${i}`,
            user_pct: (userDiff / totalDiff) * 100,
            system_pct: (sysDiff / totalDiff) * 100,
            idle_pct: (idleDiff / totalDiff) * 100,
            iowait_pct: 0, // Not available in os.cpus()
            utilization_pct: ((totalDiff - idleDiff) / totalDiff) * 100,
          };
        });
      }

      this.lastCPUTimes = currentCPUTimes;

      // Get load averages
      const loadStats = this.getLoadAverages();

      // Get CPU count
      const cpuCount = os.cpus().length;

      // Calculate overall CPU utilization
      const cpuUtilization = 100 - vmstatStats.cpu.idle_pct;

      // Serialize per-core data using non-blocking JSON
      const perCoreDataJson = perCoreData.length > 0 ? JSON.stringify(perCoreData) : null;

      const cpuData = {
        host: this.hostname,
        cpu_count: cpuCount,
        cpu_utilization_pct: cpuUtilization,
        user_pct: vmstatStats.cpu.user_pct,
        system_pct: vmstatStats.cpu.system_pct,
        idle_pct: vmstatStats.cpu.idle_pct,
        iowait_pct: null, // OmniOS vmstat doesn't directly show iowait
        load_avg_1min: loadStats.load_avg_1min,
        load_avg_5min: loadStats.load_avg_5min,
        load_avg_15min: loadStats.load_avg_15min,
        processes_running: vmstatStats.processes.running,
        processes_blocked: vmstatStats.processes.blocked,
        context_switches: vmstatStats.cpu.context_switches,
        interrupts: vmstatStats.cpu.interrupts,
        system_calls: vmstatStats.cpu.system_calls,
        page_faults: vmstatStats.memory.minor_faults,
        page_ins: vmstatStats.memory.page_in,
        page_outs: vmstatStats.memory.page_out,
        per_core_data: perCoreDataJson,
        scan_timestamp: new Date(),
      };

      // Store CPU statistics
      await CPUStats.create(cpuData);

      const coreInfo = perCoreData.length > 0 ? ` (${perCoreData.length} cores)` : '';
      if (perCoreData.length > 0) {
      }

      await this.updateHostInfo({
        last_cpu_scan: new Date(),
        cpu_count: cpuCount,
      });

      return true;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'CPU statistics collection');
      return shouldContinue;
    } finally {
      this.isCollecting = false;
    }
  }

  /**
   * Collect memory statistics
   * @returns {Promise<boolean>} Success status
   */
  async collectMemoryStats() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get comprehensive memory information from kstat
      const { stdout: kstatOutput } = await execProm('kstat -p unix:0:system_pages', { timeout });
      const kstatStats = this.parseKstatMemory(kstatOutput);

      // Debug output for kstat parsing

      // Get swap information
      const { stdout: swapOutput } = await execProm('pfexec swap -s', { timeout });
      const swapStats = this.parseSwapOutput(swapOutput);

      // Also get memory information from Node.js os module for cross-reference
      const nodeTotalMem = os.totalmem();
      const nodeFreeMem = os.freemem();

      // Calculate memory values
      const pageSize = kstatStats.page_size_bytes || 4096;
      const totalMemoryBytes = (kstatStats.physmem_pages || 0) * pageSize;
      const freeMemoryBytes = (kstatStats.freemem_pages || 0) * pageSize;
      const availableMemoryBytes =
        (kstatStats.availrmem_pages || kstatStats.freemem_pages || 0) * pageSize;
      const usedMemoryBytes = totalMemoryBytes - freeMemoryBytes;

      // Use Node.js values as fallback if kstat parsing failed
      const finalTotalBytes = totalMemoryBytes > 0 ? totalMemoryBytes : nodeTotalMem;
      const finalFreeBytes = freeMemoryBytes > 0 ? freeMemoryBytes : nodeFreeMem;
      const finalUsedBytes = finalTotalBytes - finalFreeBytes;

      // Calculate memory utilization percentage
      const memoryUtilization = finalTotalBytes > 0 ? (finalUsedBytes / finalTotalBytes) * 100 : 0;

      // Convert swap from KB to bytes
      const swapTotalBytes = (swapStats.swap_total_kb || 0) * 1024;
      const swapUsedBytes = (swapStats.swap_used_kb || 0) * 1024;
      const swapFreeBytes = swapTotalBytes - swapUsedBytes;
      const swapUtilization = swapTotalBytes > 0 ? (swapUsedBytes / swapTotalBytes) * 100 : 0;

      // Additional memory statistics from kstat
      const kernelMemoryBytes = (kstatStats.pp_kernel_pages || 0) * pageSize;

      const memoryData = {
        host: this.hostname,
        total_memory_bytes: finalTotalBytes,
        available_memory_bytes: availableMemoryBytes,
        used_memory_bytes: finalUsedBytes,
        free_memory_bytes: finalFreeBytes,
        buffers_bytes: null, // Not easily available on OmniOS
        cached_bytes: null, // Not easily available on OmniOS
        memory_utilization_pct: memoryUtilization,
        swap_total_bytes: swapTotalBytes,
        swap_used_bytes: swapUsedBytes,
        swap_free_bytes: swapFreeBytes,
        swap_utilization_pct: swapUtilization,
        arc_size_bytes: null, // Could be collected from ZFS ARC stats
        arc_target_bytes: null,
        kernel_memory_bytes: kernelMemoryBytes,
        page_size_bytes: pageSize,
        pages_total: kstatStats.physmem_pages || Math.floor(nodeTotalMem / pageSize),
        pages_free: kstatStats.freemem_pages || Math.floor(nodeFreeMem / pageSize),
        scan_timestamp: new Date(),
      };

      // Store memory statistics
      await MemoryStats.create(memoryData);

      const totalGB = (finalTotalBytes / 1024 ** 3).toFixed(1);
      const usedGB = (finalUsedBytes / 1024 ** 3).toFixed(1);
      const swapGB = (swapTotalBytes / 1024 ** 3).toFixed(1);

      await this.updateHostInfo({
        last_memory_scan: new Date(),
        total_memory_bytes: finalTotalBytes,
      });

      return true;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'CPU statistics collection');
      return shouldContinue;
    }
  }

  /**
   * Parse swap -l output for detailed swap area information
   * @param {string} output - swap -l command output
   * @returns {Array} Array of swap area objects
   */
  parseSwapListOutput(output) {
    const swapAreas = [];
    const lines = output.trim().split('\n');

    // Skip header line
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line === '') {
        continue;
      }

      // Parse swap -l output format:
      // swapfile             dev    swaplo   blocks     free
      // /dev/zvol/dsk/rpool/swap 265,1         8 88080376 88080376
      const parts = line.split(/\s+/);

      if (parts.length >= 5) {
        const swapfilePath = parts[0];
        const deviceInfo = parts[1];
        const swaplo = parseInt(parts[2]) || 0;
        const blocks = parseInt(parts[3]) || 0;
        const freeBlocks = parseInt(parts[4]) || 0;

        // Calculate sizes in bytes (512-byte blocks)
        const sizeBytes = blocks * 512;
        const freeBytes = freeBlocks * 512;
        const usedBytes = sizeBytes - freeBytes;
        const utilizationPct = sizeBytes > 0 ? (usedBytes / sizeBytes) * 100 : 0;

        // Extract pool assignment from path
        const poolMatch = swapfilePath.match(/\/dev\/zvol\/dsk\/([^\/]+)/);
        const poolAssignment = poolMatch ? poolMatch[1] : null;

        // Use clean SwapAreaModel field names (after cleanup migration)
        swapAreas.push({
          swapfile: swapfilePath, // SwapAreaModel expects 'swapfile'
          dev: deviceInfo, // SwapAreaModel expects 'dev'
          swaplo, // SwapAreaModel expects 'swaplo'
          blocks, // SwapAreaModel expects 'blocks'
          free: freeBlocks, // SwapAreaModel expects 'free'
          size_bytes: sizeBytes,
          free_bytes: freeBytes,
          used_bytes: usedBytes,
          utilization_pct: utilizationPct,
          pool_assignment: poolAssignment,
          is_active: true,
          scan_timestamp: new Date(),
        });
      }
    }

    return swapAreas;
  }

  /**
   * Collect detailed swap area information
   * @returns {Promise<boolean>} Success status
   */
  async collectSwapAreas() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get detailed swap area information
      const { stdout: swapListOutput } = await execProm('pfexec swap -l', { timeout });
      const swapAreas = this.parseSwapListOutput(swapListOutput);

      if (swapAreas.length === 0) {
        log.monitoring.warn('No swap areas found in swap -l output', {
          hostname: this.hostname,
        });
        return true; // Not necessarily an error
      }

      // Get current active swap devices for this host
      const currentSwapDevices = new Set();

      // Use proper upsert with unique constraint on (host, swapfile)
      for (const swapArea of swapAreas) {
        currentSwapDevices.add(swapArea.swapfile);

        await SwapArea.upsert(
          {
            host: this.hostname,
            ...swapArea,
          },
          {
            conflictFields: ['host', 'swapfile'],
          }
        );
      }

      // Mark any swap areas that are no longer active as inactive
      // (devices that existed before but are not in current scan)
      if (currentSwapDevices.size > 0) {
        await SwapArea.update(
          { is_active: false },
          {
            where: {
              host: this.hostname,
              swapfile: { [Op.notIn]: [...currentSwapDevices] },
              is_active: true,
            },
          }
        );
      }

      log.monitoring.debug('Swap area collection completed', {
        count: swapAreas.length,
        hostname: this.hostname,
      });

      await this.updateHostInfo({
        last_swap_scan: new Date(),
      });

      return true;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'Swap area collection');
      return shouldContinue;
    }
  }

  /**
   * Collect both CPU and memory statistics
   * @returns {Promise<boolean>} Success status
   */
  async collectSystemMetrics() {
    try {
      // Collect CPU stats
      const cpuSuccess = await this.collectCPUStats();

      // Collect memory stats
      const memorySuccess = await this.collectMemoryStats();

      // Collect swap areas
      const swapSuccess = await this.collectSwapAreas();

      if (cpuSuccess && memorySuccess && swapSuccess) {
        await this.resetErrorCount();
        return true;
      }
      log.monitoring.warn('System metrics collection completed with some errors', {
        cpu_success: cpuSuccess,
        memory_success: memorySuccess,
        swap_success: swapSuccess,
        hostname: this.hostname,
      });
      return false;
    } catch (error) {
      const shouldContinue = await this.handleError(error, 'System metrics collection');
      return shouldContinue;
    }
  }

  /**
   * Clean up old system metrics data based on retention policies
   */
  async cleanupOldData() {
    const timer = createTimer('system_metrics_cleanup');
    try {
      const retentionConfig = this.hostMonitoringConfig.retention;
      const now = new Date();

      // Clean CPU data
      const cpuRetentionDate = new Date(
        now.getTime() - retentionConfig.cpu_stats * 24 * 60 * 60 * 1000
      );
      const deletedCPU = await CPUStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: cpuRetentionDate },
        },
      });

      // Clean memory data
      const memoryRetentionDate = new Date(
        now.getTime() - retentionConfig.memory_stats * 24 * 60 * 60 * 1000
      );
      const deletedMemory = await MemoryStats.destroy({
        where: {
          scan_timestamp: { [Op.lt]: memoryRetentionDate },
        },
      });

      // Clean swap areas data
      const swapRetentionDate = new Date(
        now.getTime() - retentionConfig.system_metrics * 24 * 60 * 60 * 1000
      );
      const deletedSwapAreas = await SwapArea.destroy({
        where: {
          scan_timestamp: { [Op.lt]: swapRetentionDate },
        },
      });

      const duration = timer.end();

      if (deletedCPU > 0 || deletedMemory > 0 || deletedSwapAreas > 0) {
        log.database.info('System metrics cleanup completed', {
          deleted_cpu: deletedCPU,
          deleted_memory: deletedMemory,
          deleted_swap_areas: deletedSwapAreas,
          duration_ms: duration,
          hostname: this.hostname,
        });
      }
    } catch (error) {
      timer.end();
      log.database.error('Failed to cleanup old system metrics data', {
        error: error.message,
        hostname: this.hostname,
      });
    }
  }
}

export default SystemMetricsCollector;
