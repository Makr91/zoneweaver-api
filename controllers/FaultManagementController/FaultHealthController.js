/**
 * @fileoverview Fault health check integration
 */

import { exec } from 'child_process';
import util from 'util';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { faultCache } from './utils/CacheHelper.js';
import { parseFaultOutput, generateFaultsSummary } from './utils/ParsingHelpers.js';

const execProm = util.promisify(exec);

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
        error: 'Fault management disabled',
      };
    }

    // Use cache for health endpoint (default parameters: all=false)
    const healthCacheKey = 'all=false&summary=false&limit=50';
    const now = Date.now();

    const cachedEntry = faultCache.get(healthCacheKey);
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
          timeout: faultConfig.timeout * 1000,
        });

        faultData = {
          raw_output: stdout,
          parsed_faults: parseFaultOutput(stdout),
          timestamp: new Date().toISOString(),
        };

        // Update cache
        faultCache.set(healthCacheKey, {
          data: faultData,
          timestamp: now,
        });
      } catch (error) {
        log.monitoring.error('Error refreshing fault cache for health check', {
          error: error.message,
          stack: error.stack,
        });
        return {
          hasFaults: false,
          faultCount: 0,
          severityLevels: [],
          lastCheck: cachedEntry?.data?.timestamp || null,
          error: error.message,
        };
      }
    }

    const summary = generateFaultsSummary(faultData.parsed_faults);

    return {
      hasFaults: summary.totalFaults > 0,
      faultCount: summary.totalFaults,
      severityLevels: summary.severityLevels,
      lastCheck: faultData.timestamp,
      faults: summary.totalFaults > 0 ? faultData.parsed_faults.slice(0, 5) : [], // Top 5 for health summary
    };
  } catch (error) {
    log.monitoring.error('Error getting fault status for health check', {
      error: error.message,
      stack: error.stack,
    });
    return {
      hasFaults: false,
      faultCount: 0,
      severityLevels: [],
      lastCheck: null,
      error: error.message,
    };
  }
};
