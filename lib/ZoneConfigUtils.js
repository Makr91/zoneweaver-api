/**
 * @fileoverview Zone Configuration Utilities
 * @description Shared utilities for fetching and parsing zone configurations from zadm
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { executeCommand } from './CommandManager.js';
import yj from 'yieldable-json';
import { log } from './Logger.js';

/**
 * Get zone configuration from zadm show
 * @description Fetches zone configuration using zadm show and parses the JSON output
 * @param {string} zoneName - Name of the zone
 * @param {Object} options - Configuration options
 * @param {boolean} options.useBlocking - Use blocking JSON.parse instead of non-blocking yj.parseAsync (default: false)
 * @returns {Promise<Object>} Parsed zone configuration object
 * @throws {Error} If command fails or JSON parsing fails
 */
export const getZoneConfig = async (zoneName, options = {}) => {
  const { useBlocking = false } = options;

  log.monitoring.debug('Fetching zone configuration', {
    zone_name: zoneName,
    use_blocking: useBlocking,
  });

  const result = await executeCommand(`pfexec zadm show ${zoneName}`);
  if (!result.success) {
    throw new Error(`Failed to get zone configuration: ${result.error}`);
  }

  // Use non-blocking parse by default (better for large configs)
  if (useBlocking) {
    try {
      return JSON.parse(result.output);
    } catch (error) {
      throw new Error(`Failed to parse zone configuration: ${error.message}`);
    }
  }

  // Non-blocking async parse for large JSON configs
  return new Promise((resolve, reject) => {
    yj.parseAsync(result.output, (err, parsed) => {
      if (err) {
        reject(new Error(`Failed to parse zone configuration: ${err.message}`));
      } else {
        resolve(parsed);
      }
    });
  });
};

/**
 * Get all zone configurations from zadm show
 * @description Fetches all zone configurations at once using zadm show (no zone name)
 * @returns {Promise<Object>} Object mapping zone names to their configurations
 * @throws {Error} If command fails or JSON parsing fails
 */
export const getAllZoneConfigs = async () => {
  log.monitoring.debug('Fetching all zone configurations');

  const result = await executeCommand('pfexec zadm show');
  if (!result.success) {
    throw new Error(`Failed to get all zone configurations: ${result.error}`);
  }

  // Always use non-blocking parse for all zones (large JSON)
  return new Promise((resolve, reject) => {
    yj.parseAsync(result.output, (err, parsed) => {
      if (err) {
        reject(new Error(`Failed to parse zone configurations: ${err.message}`));
      } else {
        resolve(parsed);
      }
    });
  });
};

/**
 * Update zone configuration in database
 * @description Fetches zone config via zadm show and updates the database record
 * @param {Object} Zones - Zones model
 * @param {string} zoneName - Name of the zone
 * @returns {Promise<boolean>} True if update succeeded, false if zone not found in DB
 */
export const updateZoneConfigInDatabase = async (Zones, zoneName) => {
  try {
    log.monitoring.debug('Updating zone configuration in database', {
      zone_name: zoneName,
    });

    // Fetch current zone configuration from system
    const zoneConfig = await getZoneConfig(zoneName);

    // Update database record
    const [updateCount] = await Zones.update(
      { configuration: zoneConfig },
      { where: { name: zoneName } }
    );

    if (updateCount === 0) {
      log.monitoring.warn('Zone not found in database for config update', {
        zone_name: zoneName,
      });
      return false;
    }

    log.monitoring.debug('Zone configuration updated in database', {
      zone_name: zoneName,
      brand: zoneConfig.brand,
    });

    return true;
  } catch (error) {
    log.monitoring.error('Failed to update zone configuration in database', {
      zone_name: zoneName,
      error: error.message,
    });
    throw error;
  }
};
