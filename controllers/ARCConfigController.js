/**
 * @fileoverview ZFS ARC Configuration Controller for Zoneweaver API
 * @description Provides API endpoints for managing ZFS Adaptive Replacement Cache settings
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import os from 'os';
import fs from 'fs/promises';
import { setRebootRequired, getRebootStatus } from '../lib/RebootManager.js';
import { log } from '../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Helper function to categorize ZFS parameters into dynamic and non-dynamic
 * @param {Object} params - ZFS parameters
 * @returns {Object} Categorized parameters
 */
const categorizeZFSParameters = params => {
  const {
    arcMaxBytes,
    arcMinBytes,
    arc_max_percent,
    vdev_max_pending,
    user_reserve_hint_pct,
    prefetch_disable,
  } = params;

  const nonDynamicParams = [];
  const dynamicParams = [];

  if (arcMaxBytes || arcMinBytes) {
    nonDynamicParams.push('zfs_arc_max/zfs_arc_min');
  }
  if (arc_max_percent !== undefined) {
    dynamicParams.push('zfs_arc_max_percent');
  }
  if (vdev_max_pending !== undefined) {
    dynamicParams.push('zfs_vdev_max_pending');
  }
  if (user_reserve_hint_pct !== undefined) {
    dynamicParams.push('user_reserve_hint_pct');
  }
  if (prefetch_disable !== undefined) {
    dynamicParams.push('zfs_prefetch_disable');
  }

  return { nonDynamicParams, dynamicParams };
};

/**
 * Helper function to add parameter warnings
 * @param {Object} results - Results object to add warnings to
 * @param {string} applyMethod - Apply method (runtime/persistent/both)
 * @param {Array} nonDynamicParams - List of non-dynamic parameters
 * @param {Array} dynamicParams - List of dynamic parameters
 */
const addParameterWarnings = (results, applyMethod, nonDynamicParams, dynamicParams) => {
  if (applyMethod === 'runtime' || applyMethod === 'both') {
    if (nonDynamicParams.length > 0) {
      results.warnings.push(
        `WARNING: ${nonDynamicParams.join(', ')} are NOT dynamic parameters and require system reboot to take effect.`
      );
    }
    if (dynamicParams.length > 0) {
      results.warnings.push(
        `INFO: ${dynamicParams.join(', ')} are dynamic parameters and will take effect immediately.`
      );
    }
  }
};

/**
 * Helper function to apply runtime ZFS setting
 * @param {string} parameter - Parameter name (e.g., 'zfs_arc_max', 'zfs_vdev_max_pending')
 * @param {number} value - Value to set
 */
const applyRuntimeZFSSetting = async (parameter, value) => {
  try {
    const command = `echo "${parameter}/W0t${value}" | pfexec mdb -kw`;
    log.app.info('Applying runtime ZFS setting', {
      parameter,
      value,
    });

    await execProm(command, { timeout: 10000 });
  } catch (error) {
    throw new Error(`Failed to apply runtime ZFS setting ${parameter}: ${error.message}`);
  }
};

/**
 * Helper function to format bytes for human-readable output
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
const formatBytes = bytes => {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) {
    return '0 B';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Helper function to apply runtime ZFS configuration
 * @param {Object} params - ZFS parameters
 * @param {Object} results - Results object to update
 */
const applyRuntimeZFSConfiguration = async (params, results) => {
  const {
    arcMaxBytes,
    arcMinBytes,
    arc_max_percent,
    vdev_max_pending,
    user_reserve_hint_pct,
    prefetch_disable,
  } = params;

  if (arcMaxBytes) {
    await applyRuntimeZFSSetting('zfs_arc_max', arcMaxBytes);
    results.changes.push(`Runtime: Set ARC max to ${formatBytes(arcMaxBytes)} (requires reboot)`);
  }
  if (arcMinBytes) {
    await applyRuntimeZFSSetting('zfs_arc_min', arcMinBytes);
    results.changes.push(`Runtime: Set ARC min to ${formatBytes(arcMinBytes)} (requires reboot)`);
  }
  if (arc_max_percent !== undefined) {
    await applyRuntimeZFSSetting('zfs_arc_max_percent', arc_max_percent);
    results.changes.push(`Runtime: Set ARC max percent to ${arc_max_percent}%`);
  }
  if (vdev_max_pending !== undefined) {
    await applyRuntimeZFSSetting('zfs_vdev_max_pending', vdev_max_pending);
    results.changes.push(`Runtime: Set vdev max pending to ${vdev_max_pending}`);
  }
  if (user_reserve_hint_pct !== undefined) {
    await applyRuntimeZFSSetting('user_reserve_hint_pct', user_reserve_hint_pct);
    results.changes.push(`Runtime: Set user reserve hint to ${user_reserve_hint_pct}%`);
  }
  if (prefetch_disable !== undefined) {
    const prefetchValue = prefetch_disable ? 1 : 0;
    await applyRuntimeZFSSetting('zfs_prefetch_disable', prefetchValue);
    results.changes.push(`Runtime: ${prefetch_disable ? 'Disabled' : 'Enabled'} ZFS prefetching`);
  }

  results.runtime_applied = true;
};

/**
 * Helper function to apply persistent ZFS configuration messages
 * @param {Object} params - ZFS parameters
 * @param {Object} results - Results object to update
 */
const addPersistentConfigurationMessages = (params, results) => {
  const {
    arcMaxBytes,
    arcMinBytes,
    arc_max_percent,
    vdev_max_pending,
    user_reserve_hint_pct,
    prefetch_disable,
  } = params;

  if (arcMaxBytes) {
    results.changes.push(`Persistent: Set ARC max to ${formatBytes(arcMaxBytes)}`);
  }
  if (arcMinBytes) {
    results.changes.push(`Persistent: Set ARC min to ${formatBytes(arcMinBytes)}`);
  }
  if (arc_max_percent !== undefined) {
    results.changes.push(`Persistent: Set ARC max percent to ${arc_max_percent}%`);
  }
  if (vdev_max_pending !== undefined) {
    results.changes.push(`Persistent: Set vdev max pending to ${vdev_max_pending}`);
  }
  if (user_reserve_hint_pct !== undefined) {
    results.changes.push(`Persistent: Set user reserve hint to ${user_reserve_hint_pct}%`);
  }
  if (prefetch_disable !== undefined) {
    results.changes.push(
      `Persistent: ${prefetch_disable ? 'Disabled' : 'Enabled'} ZFS prefetching`
    );
  }
};

/**
 * Helper function to trigger immediate ARC stats collection
 */
const triggerARCStatsCollection = async () => {
  try {
    const StorageCollector = (await import('./StorageCollector.js')).default;
    const collector = new StorageCollector();
    await collector.collectARCStats();
  } catch (collectionError) {
    log.monitoring.warn('Failed to immediately update ARC stats data', {
      error: collectionError.message,
    });
  }
};

/**
 * Helper function to get current ARC statistics
 * @returns {Object} Current ARC statistics
 */
const getCurrentARCStats = async () => {
  try {
    // Get latest ARC statistics from kstat
    const { stdout: kstatOutput } = await execProm(
      'kstat -p zfs:0:arcstats:size zfs:0:arcstats:c zfs:0:arcstats:c_max zfs:0:arcstats:c_min zfs:0:arcstats:arc_meta_used zfs:0:arcstats:arc_meta_limit zfs:0:arcstats:arc_meta_min',
      { timeout: 10000 }
    );

    const arcData = {};
    const lines = kstatOutput.trim().split('\n');

    lines.forEach(line => {
      const match = line.match(/^zfs:0:arcstats:(?<param>\S+)\s+(?<value>\d+)$/);
      if (match) {
        const { param, value } = match.groups;
        switch (param) {
          case 'size':
            arcData.arc_size_bytes = parseInt(value);
            break;
          case 'c':
            arcData.arc_target_size_bytes = parseInt(value);
            break;
          case 'c_max':
            arcData.arc_max_bytes = parseInt(value);
            break;
          case 'c_min':
            arcData.arc_min_bytes = parseInt(value);
            break;
          case 'arc_meta_used':
            arcData.arc_meta_used_bytes = parseInt(value);
            break;
          case 'arc_meta_limit':
            arcData.arc_meta_limit_bytes = parseInt(value);
            break;
          case 'arc_meta_min':
            arcData.arc_meta_min_bytes = parseInt(value);
            break;
        }
      }
    });

    arcData.scan_timestamp = new Date().toISOString();
    return arcData;
  } catch (error) {
    log.monitoring.error('Error getting current ARC stats', {
      error: error.message,
      stack: error.stack,
    });
    throw new Error(`Failed to get ARC statistics: ${error.message}`);
  }
};

/**
 * Helper function to get physical memory in bytes
 * @returns {number} Physical memory in bytes
 */
const getPhysicalMemoryBytes = async () => {
  try {
    const { stdout } = await execProm('prtconf | grep "Memory size"', { timeout: 5000 });
    const match = stdout.match(/Memory size:\s*(?<megabytes>\d+)\s*Megabytes/);

    if (!match) {
      throw new Error('Could not parse memory size from prtconf output');
    }

    return parseInt(match.groups.megabytes) * 1024 * 1024; // Convert MB to bytes
  } catch (error) {
    log.monitoring.error('Error getting physical memory', {
      error: error.message,
      stack: error.stack,
    });
    throw new Error(`Failed to get physical memory: ${error.message}`);
  }
};

/**
 * Helper function to get ZFS tunable parameters
 * @returns {Object} ZFS tunable parameters
 */
const getZFSTunableParams = async () => {
  try {
    const { stdout } = await execProm('echo "::zfs_params" | pfexec mdb -k', { timeout: 15000 });

    const params = {};
    const lines = stdout.trim().split('\n');

    lines.forEach(line => {
      if (line.startsWith('mdb: variable') && line.includes('not found')) {
        // Skip missing variables
        return;
      }

      const match = line.match(/^(?<paramName>\w+)\s*=\s*0x(?<hexValue>[a-fA-F0-9]+)$/);
      if (match) {
        const { paramName, hexValue } = match.groups;
        params[paramName] = parseInt(hexValue, 16);
      }
    });

    return params;
  } catch (error) {
    log.monitoring.warn('Error getting ZFS tunable parameters', {
      error: error.message,
    });
    // Return empty object if we can't get tunables - not critical for basic functionality
    return {};
  }
};

/**
 * Helper function to get persistent configuration information
 * @returns {Object} Configuration source information
 */
const getPersistentConfigInfo = async () => {
  const configPath = '/etc/system.d/zfs-arc.conf';

  try {
    await fs.access(configPath);
    const stats = await fs.stat(configPath);
    return {
      source: `file: ${configPath}`,
      filePath: configPath,
      rebootRequired: false,
      lastModified: stats.mtime.toISOString(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        source: 'auto-calculated',
        filePath: null,
        rebootRequired: false,
        lastModified: null,
      };
    }
    throw error;
  }
};

/**
 * Helper function to validate ARC settings
 * @param {Object} settings - Settings to validate
 * @param {number} physicalMemoryBytes - Physical memory in bytes
 * @returns {Object} Validation result
 */
const validateARCSettings = (settings, physicalMemoryBytes) => {
  const errors = [];
  const warnings = [];

  const maxSafeARC = Math.floor(physicalMemoryBytes * 0.85);
  const minRecommendedARC = Math.floor(physicalMemoryBytes * 0.01);

  // Validate ARC max
  if (settings.arc_max_bytes) {
    if (settings.arc_max_bytes > maxSafeARC) {
      errors.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} exceeds safe limit of ${formatBytes(maxSafeARC)} (85% of ${formatBytes(physicalMemoryBytes)} physical memory)`
      );
    }

    if (settings.arc_max_bytes < minRecommendedARC) {
      warnings.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} is below recommended minimum of ${formatBytes(minRecommendedARC)}`
      );
    }
  }

  // Validate ARC min
  if (settings.arc_min_bytes) {
    if (settings.arc_min_bytes < 134217728) {
      // 128MB
      errors.push(
        `ARC min ${formatBytes(settings.arc_min_bytes)} is below absolute minimum of 128MB`
      );
    }

    if (settings.arc_min_bytes > Math.floor(physicalMemoryBytes * 0.1)) {
      warnings.push(`ARC min ${formatBytes(settings.arc_min_bytes)} exceeds 10% of system memory`);
    }
  }

  // Validate relationship between min and max
  if (settings.arc_min_bytes && settings.arc_max_bytes) {
    if (settings.arc_min_bytes >= settings.arc_max_bytes) {
      errors.push(
        `ARC min ${formatBytes(settings.arc_min_bytes)} must be less than ARC max ${formatBytes(settings.arc_max_bytes)}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
};

/**
 * Validate dynamic ZFS parameters
 * @param {Object} settings - Settings to validate
 * @param {Array} errors - Errors array to populate
 * @param {Array} warnings - Warnings array to populate
 */
const validateDynamicParameters = (settings, errors, warnings) => {
  if (settings.arc_max_percent !== undefined) {
    if (settings.arc_max_percent < 1 || settings.arc_max_percent > 100) {
      errors.push(`ARC max percent ${settings.arc_max_percent}% must be between 1 and 100`);
    } else if (settings.arc_max_percent > 85) {
      warnings.push(
        `ARC max percent ${settings.arc_max_percent}% exceeds recommended maximum of 85%`
      );
    }
  }

  if (settings.vdev_max_pending !== undefined) {
    if (settings.vdev_max_pending < 1 || settings.vdev_max_pending > 100) {
      errors.push(`Vdev max pending ${settings.vdev_max_pending} must be between 1 and 100`);
    } else if (settings.vdev_max_pending > 50) {
      warnings.push(
        `Vdev max pending ${settings.vdev_max_pending} is quite high - may increase latency for synchronous writes`
      );
    }
  }

  if (settings.user_reserve_hint_pct !== undefined) {
    if (settings.user_reserve_hint_pct < 0 || settings.user_reserve_hint_pct > 99) {
      errors.push(`User reserve hint ${settings.user_reserve_hint_pct}% must be between 0 and 99`);
    } else if (settings.user_reserve_hint_pct > 50) {
      warnings.push(
        `User reserve hint ${settings.user_reserve_hint_pct}% is quite high - may severely limit ARC effectiveness`
      );
    }
  }

  if (settings.prefetch_disable !== undefined && typeof settings.prefetch_disable !== 'boolean') {
    errors.push(`Prefetch disable must be a boolean value (true/false)`);
  }
};

/**
 * Helper function to validate all ZFS settings
 * @param {Object} settings - Settings to validate
 * @param {number} physicalMemoryBytes - Physical memory in bytes
 * @returns {Object} Validation result
 */
const validateAllZFSSettings = (settings, physicalMemoryBytes) => {
  const errors = [];
  const warnings = [];

  const maxSafeARC = Math.floor(physicalMemoryBytes * 0.85);
  const minRecommendedARC = Math.floor(physicalMemoryBytes * 0.01);

  // Validate ARC max bytes
  if (settings.arc_max_bytes) {
    if (settings.arc_max_bytes > maxSafeARC) {
      errors.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} exceeds safe limit of ${formatBytes(maxSafeARC)} (85% of ${formatBytes(physicalMemoryBytes)} physical memory)`
      );
    }
    if (settings.arc_max_bytes < minRecommendedARC) {
      warnings.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} is below recommended minimum of ${formatBytes(minRecommendedARC)}`
      );
    }
  }

  // Validate ARC min bytes
  if (settings.arc_min_bytes) {
    if (settings.arc_min_bytes < 134217728) {
      errors.push(
        `ARC min ${formatBytes(settings.arc_min_bytes)} is below absolute minimum of 128MB`
      );
    }
    if (settings.arc_min_bytes > Math.floor(physicalMemoryBytes * 0.1)) {
      warnings.push(`ARC min ${formatBytes(settings.arc_min_bytes)} exceeds 10% of system memory`);
    }
  }

  // Validate dynamic parameters
  validateDynamicParameters(settings, errors, warnings);

  // Validate relationship between min and max
  if (
    settings.arc_min_bytes &&
    settings.arc_max_bytes &&
    settings.arc_min_bytes >= settings.arc_max_bytes
  ) {
    errors.push(
      `ARC min ${formatBytes(settings.arc_min_bytes)} must be less than ARC max ${formatBytes(settings.arc_max_bytes)}`
    );
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
};

/**
 * Helper function to apply persistent ZFS settings
 * @param {Object} settings - Settings to apply
 */
const applyPersistentZFSSettings = async settings => {
  const configPath = '/etc/system.d/zfs-arc.conf';

  try {
    let configContent = `# ZFS Configuration - Generated by Zoneweaver API\n`;
    configContent += `# Created: ${new Date().toISOString()}\n`;
    configContent += `# WARNING: This file is managed by the Zoneweaver API\n\n`;

    // ARC memory settings (non-dynamic)
    if (settings.arc_max_bytes) {
      configContent += `set zfs:zfs_arc_max = ${settings.arc_max_bytes}\n`;
    }

    if (settings.arc_min_bytes) {
      configContent += `set zfs:zfs_arc_min = ${settings.arc_min_bytes}\n`;
    }

    // Dynamic parameters (can be set persistently for boot-time defaults)
    if (settings.arc_max_percent !== undefined) {
      configContent += `set zfs:zfs_arc_max_percent = ${settings.arc_max_percent}\n`;
    }

    if (settings.vdev_max_pending !== undefined) {
      configContent += `set zfs:zfs_vdev_max_pending = ${settings.vdev_max_pending}\n`;
    }

    if (settings.user_reserve_hint_pct !== undefined) {
      configContent += `set zfs:user_reserve_hint_pct = ${settings.user_reserve_hint_pct}\n`;
    }

    if (settings.prefetch_disable !== undefined) {
      const prefetchValue = settings.prefetch_disable ? 1 : 0;
      configContent += `set zfs:zfs_prefetch_disable = ${prefetchValue}\n`;
    }

    // Use pfexec to write the file with proper permissions
    const command = `echo '${configContent.replace(/'/g, "'\\''")}' | pfexec tee ${configPath}`;
    await execProm(command, { timeout: 10000 });

    log.app.info('Successfully created persistent ZFS configuration', {
      config_path: configPath,
    });
  } catch (error) {
    throw new Error(`Failed to create persistent ZFS configuration: ${error.message}`);
  }
};

/**
 * @swagger
 * /system/zfs/arc/config:
 *   get:
 *     summary: Get ZFS ARC configuration
 *     description: Returns current ZFS ARC settings, available tunables, and system constraints
 *     tags: [ZFS ARC Management]
 *     responses:
 *       200:
 *         description: ZFS ARC configuration data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current_config:
 *                   type: object
 *                   properties:
 *                     arc_size_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC size in bytes
 *                     arc_max_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC maximum size in bytes
 *                     arc_min_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC minimum size in bytes
 *                     arc_meta_used_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC metadata usage in bytes
 *                     arc_meta_limit_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Current ARC metadata limit in bytes
 *                 system_constraints:
 *                   type: object
 *                   properties:
 *                     physical_memory_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Total physical memory in bytes
 *                     max_safe_arc_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Maximum safe ARC size (85% of physical memory)
 *                     min_recommended_arc_bytes:
 *                       type: integer
 *                       format: int64
 *                       description: Minimum recommended ARC size
 *                 available_tunables:
 *                   type: object
 *                   description: Available ZFS ARC tunable parameters
 *                 config_source:
 *                   type: string
 *                   description: Source of current configuration
 *                 reboot_required:
 *                   type: boolean
 *                   description: Whether a reboot is required for persistent changes
 *       500:
 *         description: Failed to get ZFS ARC configuration
 */
export const getARCConfig = async (req, res) => {
  const hostname = os.hostname();
  try {
    // Get current ARC statistics
    const arcStats = await getCurrentARCStats();

    // Get system memory information
    const physicalMemoryBytes = await getPhysicalMemoryBytes();

    // Get ZFS tunable parameters
    const tunableParams = await getZFSTunableParams();

    // Check for persistent configuration
    const configInfo = await getPersistentConfigInfo();

    // Get actual reboot status from RebootManager
    const rebootStatus = await getRebootStatus();

    // Calculate system constraints
    const maxSafeARCBytes = Math.floor(physicalMemoryBytes * 0.85);
    const minRecommendedARCBytes = Math.floor(physicalMemoryBytes * 0.01);

    // Build available tunables info
    const availableTunables = {
      zfs_arc_max: {
        current_value: tunableParams.zfs_arc_max || 0,
        effective_value: arcStats.arc_max_bytes,
        min_safe: minRecommendedARCBytes,
        max_safe: maxSafeARCBytes,
        description: 'Maximum ARC size in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
      zfs_arc_min: {
        current_value: tunableParams.zfs_arc_min || 0,
        effective_value: arcStats.arc_min_bytes,
        min_safe: 134217728, // 128MB
        max_safe: Math.floor(physicalMemoryBytes * 0.1), // 10% of system memory
        description: 'Minimum ARC size in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
      zfs_arc_max_percent: {
        current_value: tunableParams.zfs_arc_max_percent || 90,
        effective_value: Math.round((arcStats.arc_max_bytes / physicalMemoryBytes) * 100),
        min_safe: 1,
        max_safe: 100,
        description: 'Maximum ARC size as percentage of physical memory',
        dynamic: true,
        requires_reboot: false,
      },
      zfs_vdev_max_pending: {
        current_value: tunableParams.zfs_vdev_max_pending || 10,
        effective_value: tunableParams.zfs_vdev_max_pending || 10,
        min_safe: 1,
        max_safe: 100,
        description: 'Maximum number of concurrent I/Os pending to each device',
        dynamic: true,
        requires_reboot: false,
      },
      user_reserve_hint_pct: {
        current_value: tunableParams.user_reserve_hint_pct || 0,
        effective_value: tunableParams.user_reserve_hint_pct || 0,
        min_safe: 0,
        max_safe: 99,
        description:
          'Percentage of memory reserved for application use (alternative to zfs_arc_max)',
        dynamic: true,
        requires_reboot: false,
      },
      zfs_prefetch_disable: {
        current_value: tunableParams.zfs_prefetch_disable || 0,
        effective_value: tunableParams.zfs_prefetch_disable || 0,
        min_safe: 0,
        max_safe: 1,
        description: 'Disable ZFS file-level prefetching (0=enabled, 1=disabled)',
        dynamic: true,
        requires_reboot: false,
      },
      zfs_arc_meta_limit: {
        current_value: tunableParams.zfs_arc_meta_limit || 0,
        effective_value: arcStats.arc_meta_limit_bytes,
        min_safe: 67108864, // 64MB
        max_safe: Math.floor(physicalMemoryBytes * 0.25), // 25% of system memory
        description: 'ARC metadata limit in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
      zfs_arc_meta_min: {
        current_value: tunableParams.zfs_arc_meta_min || 0,
        effective_value: arcStats.arc_meta_min_bytes,
        min_safe: 16777216, // 16MB
        max_safe: Math.floor(physicalMemoryBytes * 0.05), // 5% of system memory
        description: 'Minimum ARC metadata size in bytes (0 = auto-calculated)',
        dynamic: false,
        requires_reboot: true,
      },
    };

    res.json({
      host: hostname,
      current_config: {
        arc_size_bytes: arcStats.arc_size_bytes,
        arc_max_bytes: arcStats.arc_max_bytes,
        arc_min_bytes: arcStats.arc_min_bytes,
        arc_meta_used_bytes: arcStats.arc_meta_used_bytes,
        arc_meta_limit_bytes: arcStats.arc_meta_limit_bytes,
        arc_meta_min_bytes: arcStats.arc_meta_min_bytes,
      },
      system_constraints: {
        physical_memory_bytes: physicalMemoryBytes,
        max_safe_arc_bytes: maxSafeARCBytes,
        min_recommended_arc_bytes: minRecommendedARCBytes,
      },
      available_tunables: availableTunables,
      config_source: configInfo.source,
      config_file_path: configInfo.filePath,
      reboot_required: rebootStatus.required,
      last_collected: arcStats.scan_timestamp,
    });
  } catch (error) {
    log.api.error('Error getting ZFS ARC configuration', {
      error: error.message,
      stack: error.stack,
      host: hostname,
    });
    res.status(500).json({
      error: 'Failed to get ZFS ARC configuration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/zfs/arc/config:
 *   put:
 *     summary: Update ZFS ARC configuration
 *     description: Updates ZFS ARC settings with safety validations
 *     tags: [ZFS ARC Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               arc_max_gb:
 *                 type: number
 *                 description: ARC maximum size in GB
 *                 example: 153
 *               arc_min_gb:
 *                 type: number
 *                 description: ARC minimum size in GB
 *                 example: 4
 *               arc_max_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: ARC maximum size in bytes (alternative to arc_max_gb)
 *               arc_min_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: ARC minimum size in bytes (alternative to arc_min_gb)
 *               arc_max_percent:
 *                 type: number
 *                 description: ARC maximum size as percentage of physical memory (1-100)
 *                 example: 75
 *               vdev_max_pending:
 *                 type: integer
 *                 description: Maximum concurrent I/Os per device (1-100)
 *                 example: 35
 *               user_reserve_hint_pct:
 *                 type: number
 *                 description: Percentage of memory reserved for applications (0-99)
 *                 example: 25
 *               prefetch_disable:
 *                 type: boolean
 *                 description: Disable ZFS file-level prefetching
 *                 example: false
 *               apply_method:
 *                 type: string
 *                 enum: [persistent, runtime, both]
 *                 default: persistent
 *                 description: How to apply the configuration. Note - Runtime changes are only supported for dynamic parameters (arc_max_percent, vdev_max_pending, user_reserve_hint_pct, prefetch_disable).
 *     responses:
 *       200:
 *         description: ARC configuration updated successfully
 *       400:
 *         description: Invalid configuration or safety check failed
 *       500:
 *         description: Failed to update ARC configuration
 */
export const updateARCConfig = async (req, res) => {
  try {
    const {
      arc_max_gb,
      arc_min_gb,
      arc_max_bytes,
      arc_min_bytes,
      arc_max_percent,
      vdev_max_pending,
      user_reserve_hint_pct,
      prefetch_disable,
      apply_method = 'persistent',
    } = req.body;

    // Convert GB to bytes if provided in GB
    const arcMaxBytes = arc_max_bytes || (arc_max_gb ? arc_max_gb * 1024 ** 3 : null);
    const arcMinBytes = arc_min_bytes || (arc_min_gb ? arc_min_gb * 1024 ** 3 : null);

    // Check if at least one parameter is provided
    const hasAnyParam =
      arcMaxBytes ||
      arcMinBytes ||
      arc_max_percent !== undefined ||
      vdev_max_pending !== undefined ||
      user_reserve_hint_pct !== undefined ||
      prefetch_disable !== undefined;

    if (!hasAnyParam) {
      return res.status(400).json({
        error: 'At least one ZFS parameter must be provided',
      });
    }

    // Get system constraints for validation
    const physicalMemoryBytes = await getPhysicalMemoryBytes();

    // Perform validation for all parameters
    const validationResult = validateAllZFSSettings(
      {
        arc_max_bytes: arcMaxBytes,
        arc_min_bytes: arcMinBytes,
        arc_max_percent,
        vdev_max_pending,
        user_reserve_hint_pct,
        prefetch_disable,
      },
      physicalMemoryBytes
    );

    if (!validationResult.valid) {
      return res.status(400).json({
        error: 'Configuration validation failed',
        details: validationResult.errors,
      });
    }

    const results = {
      runtime_applied: false,
      persistent_applied: false,
      changes: [],
      warnings: validationResult.warnings || [],
    };

    const params = {
      arcMaxBytes,
      arcMinBytes,
      arc_max_percent,
      vdev_max_pending,
      user_reserve_hint_pct,
      prefetch_disable,
    };
    const { nonDynamicParams, dynamicParams } = categorizeZFSParameters(params);

    addParameterWarnings(results, apply_method, nonDynamicParams, dynamicParams);

    // Apply runtime configuration
    if (apply_method === 'runtime' || apply_method === 'both') {
      await applyRuntimeZFSConfiguration(params, results);
    }

    // Apply persistent configuration
    if (apply_method === 'persistent' || apply_method === 'both') {
      await applyPersistentZFSSettings({
        arc_max_bytes: arcMaxBytes,
        arc_min_bytes: arcMinBytes,
        arc_max_percent,
        vdev_max_pending,
        user_reserve_hint_pct,
        prefetch_disable,
      });

      if (nonDynamicParams.length > 0) {
        await setRebootRequired('zfs_arc_config', 'ARCConfigController');
        results.reboot_required = true;
      }

      addPersistentConfigurationMessages(params, results);
      results.persistent_applied = true;
    }

    await triggerARCStatsCollection();

    return res.json({
      success: true,
      message: 'ZFS configuration updated successfully',
      apply_method,
      results,
    });
  } catch (error) {
    log.api.error('Error updating ZFS configuration', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to update ZFS configuration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/zfs/arc/validate:
 *   post:
 *     summary: Validate ZFS ARC configuration
 *     description: Validates proposed ZFS ARC settings without applying them
 *     tags: [ZFS ARC Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               arc_max_gb:
 *                 type: number
 *                 description: Proposed ARC maximum size in GB
 *               arc_min_gb:
 *                 type: number
 *                 description: Proposed ARC minimum size in GB
 *               arc_max_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: Proposed ARC maximum size in bytes
 *               arc_min_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: Proposed ARC minimum size in bytes
 *     responses:
 *       200:
 *         description: Validation results
 *       500:
 *         description: Failed to validate configuration
 */
export const validateARCConfig = async (req, res) => {
  try {
    const { arc_max_gb, arc_min_gb, arc_max_bytes, arc_min_bytes } = req.body;

    // Convert GB to bytes if provided in GB
    const arcMaxBytes = arc_max_bytes || (arc_max_gb ? arc_max_gb * 1024 ** 3 : null);
    const arcMinBytes = arc_min_bytes || (arc_min_gb ? arc_min_gb * 1024 ** 3 : null);

    // Get current settings for comparison
    const currentConfig = await getCurrentARCStats();
    const physicalMemoryBytes = await getPhysicalMemoryBytes();

    const settingsToValidate = {
      arc_max_bytes: arcMaxBytes || currentConfig.arc_max_bytes,
      arc_min_bytes: arcMinBytes || currentConfig.arc_min_bytes,
    };

    const validationResult = validateARCSettings(settingsToValidate, physicalMemoryBytes);

    res.json({
      valid: validationResult.valid,
      errors: validationResult.errors || [],
      warnings: validationResult.warnings || [],
      proposed_settings: {
        arc_max_bytes: settingsToValidate.arc_max_bytes,
        arc_min_bytes: settingsToValidate.arc_min_bytes,
        arc_max_gb: (settingsToValidate.arc_max_bytes / 1024 ** 3).toFixed(2),
        arc_min_gb: (settingsToValidate.arc_min_bytes / 1024 ** 3).toFixed(2),
      },
      system_constraints: {
        physical_memory_bytes: physicalMemoryBytes,
        max_safe_arc_bytes: Math.floor(physicalMemoryBytes * 0.85),
        min_recommended_arc_bytes: Math.floor(physicalMemoryBytes * 0.01),
      },
    });
  } catch (error) {
    log.api.error('Error validating ZFS ARC configuration', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to validate ZFS ARC configuration',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/zfs/arc/reset:
 *   post:
 *     summary: Reset ZFS ARC configuration to defaults
 *     description: Resets ZFS ARC settings to system defaults
 *     tags: [ZFS ARC Management]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               apply_method:
 *                 type: string
 *                 enum: [runtime, persistent, both]
 *                 default: both
 *                 description: How to apply the reset
 *     responses:
 *       200:
 *         description: ARC configuration reset successfully
 *       500:
 *         description: Failed to reset ARC configuration
 */
export const resetARCConfig = async (req, res) => {
  try {
    const { apply_method = 'both' } = req.body;

    const results = {
      runtime_applied: false,
      persistent_applied: false,
      changes: [],
    };

    // Apply runtime reset (set to 0 = auto-calculate)
    if (apply_method === 'runtime' || apply_method === 'both') {
      await applyRuntimeZFSSetting('zfs_arc_max', 0);
      await applyRuntimeZFSSetting('zfs_arc_min', 0);
      results.changes.push('Runtime: Reset ARC max and min to auto-calculated defaults');
      results.runtime_applied = true;
    }

    // Remove persistent configuration file
    if (apply_method === 'persistent' || apply_method === 'both') {
      const configPath = '/etc/system.d/zfs-arc.conf';
      try {
        // Use pfexec to remove the file with proper permissions
        await execProm(`pfexec rm -f ${configPath}`, { timeout: 5000 });

        results.changes.push(`Persistent: Removed configuration file ${configPath}`);
      } catch (error) {
        log.filesystem.warn('Failed to remove config file', {
          error: error.message,
          config_path: configPath,
        });
        results.changes.push(`Persistent: No configuration file to remove (${configPath})`);
      }

      // Set reboot required flag
      await setRebootRequired('zfs_arc_config', 'ARCConfigController');

      results.persistent_applied = true;
      results.reboot_required = true;
    }

    res.json({
      success: true,
      message: 'ZFS ARC configuration reset to defaults',
      apply_method,
      results,
    });
  } catch (error) {
    log.api.error('Error resetting ZFS ARC configuration', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to reset ZFS ARC configuration',
      details: error.message,
    });
  }
};
