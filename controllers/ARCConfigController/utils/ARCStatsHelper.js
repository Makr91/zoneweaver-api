import { exec } from 'child_process';
import util from 'util';
import fs from 'fs/promises';
import { log } from '../../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * @fileoverview ARC statistics and system information utilities
 */

/**
 * Helper function to format bytes for human-readable output
 * @param {number} bytes - Bytes to format
 * @returns {string} Formatted string
 */
export const formatBytes = bytes => {
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) {
    return '0 B';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / 1024 ** i).toFixed(2)} ${sizes[i]}`;
};

/**
 * Helper function to get current ARC statistics
 * @returns {Object} Current ARC statistics
 */
export const getCurrentARCStats = async () => {
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
export const getPhysicalMemoryBytes = async () => {
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
export const getZFSTunableParams = async () => {
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
export const getPersistentConfigInfo = async () => {
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
