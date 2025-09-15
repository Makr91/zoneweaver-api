/**
 * @fileoverview Zone Orchestration Manager
 * @description Coordinates existing zone functions for priority-based orchestration
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { executeStopTask } from '../controllers/TaskManager/ZoneManager.js';
import { enableService, disableService, getServiceDetails } from './ServiceManager.js';
import { calculateShutdownOrder, extractZonePriority } from './ZoneOrchestrationUtils.js';
import { executeCommand } from './CommandManager.js';
import { log, createTimer } from './Logger.js';
import yj from 'yieldable-json';

/**
 * Check if zone orchestration is enabled and who controls zones
 * @returns {Promise<{orchestration_enabled: boolean, zones_service_enabled: boolean, controller: string}>}
 */
export const getOrchestrationStatus = async () => {
  try {
    const zonesServiceDetails = await getServiceDetails('svc:/system/zones:default');
    const zonesServiceEnabled = zonesServiceDetails && zonesServiceDetails.state === 'online';

    return {
      orchestration_enabled: !zonesServiceEnabled,
      zones_service_enabled: zonesServiceEnabled,
      controller: zonesServiceEnabled ? 'system/zones' : 'zoneweaver-api',
    };
  } catch (error) {
    log.monitoring.error('Error checking orchestration status', {
      error: error.message,
    });
    return {
      orchestration_enabled: false,
      zones_service_enabled: true,
      controller: 'unknown',
    };
  }
};

/**
 * Enable zone orchestration (take control from zones service)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const enableZoneOrchestration = async () => {
  try {
    const currentStatus = await getOrchestrationStatus();

    if (currentStatus.orchestration_enabled) {
      return {
        success: true,
        message: 'Zone orchestration already enabled',
      };
    }

    // Disable zones service
    const disableResult = await disableService('svc:/system/zones:default');
    if (!disableResult.success) {
      return {
        success: false,
        error: `Failed to disable zones service: ${disableResult.error}`,
      };
    }

    log.monitoring.warn('Zone orchestration enabled - Zoneweaver now controls zone lifecycle', {
      previous_controller: 'system/zones',
      new_controller: 'zoneweaver-api',
    });

    return {
      success: true,
      message: 'Zone orchestration enabled successfully - Zoneweaver now controls zone lifecycle',
    };
  } catch (error) {
    log.monitoring.error('Error enabling zone orchestration', {
      error: error.message,
    });
    return {
      success: false,
      error: `Failed to enable zone orchestration: ${error.message}`,
    };
  }
};

/**
 * Disable zone orchestration (return control to zones service)
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const disableZoneOrchestration = async () => {
  try {
    const currentStatus = await getOrchestrationStatus();

    if (!currentStatus.orchestration_enabled) {
      return {
        success: true,
        message: 'Zone orchestration already disabled',
      };
    }

    // Re-enable zones service
    const enableResult = await enableService('svc:/system/zones:default');
    if (!enableResult.success) {
      return {
        success: false,
        error: `Failed to enable zones service: ${enableResult.error}`,
      };
    }

    log.monitoring.info('Zone orchestration disabled - returning control to zones service', {
      previous_controller: 'zoneweaver-api',
      new_controller: 'system/zones',
    });

    return {
      success: true,
      message: 'Zone orchestration disabled successfully - zones service resumed control',
    };
  } catch (error) {
    log.monitoring.error('Error disabling zone orchestration', {
      error: error.message,
    });
    return {
      success: false,
      error: `Failed to disable zone orchestration: ${error.message}`,
    };
  }
};

/**
 * Get all running zones with their configurations (reuses existing functionality)
 * @returns {Promise<{success: boolean, zones?: Array, error?: string}>}
 */
export const getRunningZonesWithConfig = async () => {
  try {
    // Use existing zadm show command (same as in ZoneManager.js)
    const result = await executeCommand('pfexec zadm show');
    if (!result.success) {
      return { success: false, error: `Failed to get system zones: ${result.error}` };
    }

    const systemZones = await new Promise((resolve, reject) => {
      yj.parseAsync(result.output, (err, parsedResult) => {
        if (err) {
          reject(err);
        } else {
          resolve(parsedResult);
        }
      });
    });

    // Get zone states
    const listResult = await executeCommand('pfexec zoneadm list -cp');
    if (!listResult.success) {
      return { success: false, error: `Failed to get zone states: ${listResult.error}` };
    }

    const zones = [];
    const lines = listResult.output.split('\n').filter(line => line.trim());

    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) {
        const [, zoneName, zoneState] = parts;

        // Skip global zone
        if (zoneName === 'global') {
          continue;
        }

        // Only include running zones for shutdown orchestration
        if (zoneState === 'running') {
          const zoneConfig = systemZones[zoneName] || {};
          const priority = extractZonePriority(zoneConfig);

          zones.push({
            name: zoneName,
            state: zoneState,
            priority,
            configuration: zoneConfig,
          });
        }
      }
    }

    return { success: true, zones };
  } catch (error) {
    log.monitoring.error('Error getting running zones with config', {
      error: error.message,
    });
    return { success: false, error: error.message };
  }
};

/**
 * Execute zone shutdown orchestration using existing zone stop functions
 * @param {string} strategy - Orchestration strategy
 * @param {Object} options - Orchestration options
 * @returns {Promise<{success: boolean, zones_stopped?: Array, zones_failed?: Array, error?: string}>}
 */
export const executeZoneShutdownOrchestration = async (
  strategy = 'parallel_by_priority',
  options = {}
) => {
  const orchestrationTimer = createTimer('zone_shutdown_orchestration');

  try {
    log.monitoring.warn('ZONE ORCHESTRATION: Starting shutdown orchestration', {
      strategy,
      options,
    });

    // Get running zones using existing functionality
    const zonesResult = await getRunningZonesWithConfig();
    if (!zonesResult.success) {
      return { success: false, error: zonesResult.error };
    }

    if (zonesResult.zones.length === 0) {
      log.monitoring.info('No running zones found for orchestration');
      return {
        success: true,
        zones_stopped: [],
        zones_failed: [],
        message: 'No running zones to orchestrate',
      };
    }

    // Calculate shutdown order using priority utilities
    const priorityGroups = calculateShutdownOrder(zonesResult.zones);

    const results = {
      zones_stopped: [],
      zones_failed: [],
    };

    // Execute shutdown by priority groups using Promise.all for parallel execution
    const groupPromises = priorityGroups.map(async (group, groupIndex) => {
      log.monitoring.info(`ZONE ORCHESTRATION: Stopping priority group ${group.priority_range}`, {
        zones: group.zones.map(z => z.name),
        strategy,
      });

      // Apply delay before this group (except first group)
      if (groupIndex > 0 && options.priority_delay && options.priority_delay > 0) {
        await new Promise(resolve => {
          setTimeout(resolve, options.priority_delay * 1000);
        });
      }

      if (strategy === 'sequential') {
        // Even for sequential strategy, we can parallelize within the group
        const stopPromises = group.zones.map(async zone => {
          const stopResult = await executeStopTask(zone.name);
          return {
            zone: zone.name,
            priority: zone.priority,
            result: stopResult,
          };
        });
        return Promise.all(stopPromises);
      }
      // Parallel - stop all zones in group simultaneously
      const stopPromises = group.zones.map(async zone => {
        const stopResult = await executeStopTask(zone.name);
        return {
          zone: zone.name,
          priority: zone.priority,
          result: stopResult,
        };
      });
      return Promise.all(stopPromises);
    });

    // Wait for all groups to complete
    const allGroupResults = await Promise.all(groupPromises);

    // Process all results
    allGroupResults.flat().forEach(({ zone, priority, result }) => {
      if (result.success) {
        results.zones_stopped.push(zone);
      } else {
        results.zones_failed.push({
          zone,
          error: result.error,
          priority,
        });
      }
    });

    // Check if we should abort on failures
    if (results.zones_failed.length > 0 && options.failure_action === 'abort') {
      const duration = orchestrationTimer.end();
      return {
        success: false,
        error: `${results.zones_failed.length} zones failed to stop, aborting orchestration`,
        zones_stopped: results.zones_stopped,
        zones_failed: results.zones_failed,
        duration_ms: duration,
      };
    }

    const duration = orchestrationTimer.end();
    const allStopped = results.zones_failed.length === 0;

    log.monitoring.warn('ZONE ORCHESTRATION: Shutdown orchestration completed', {
      success: allStopped,
      zones_stopped: results.zones_stopped.length,
      zones_failed: results.zones_failed.length,
      strategy,
      duration_ms: duration,
    });

    return {
      success: allStopped,
      zones_stopped: results.zones_stopped,
      zones_failed: results.zones_failed,
      duration_ms: duration,
      message: allStopped
        ? `All ${results.zones_stopped.length} zones stopped successfully`
        : `${results.zones_stopped.length} zones stopped, ${results.zones_failed.length} failed`,
    };
  } catch (error) {
    orchestrationTimer.end();
    log.monitoring.error('ZONE ORCHESTRATION: Shutdown orchestration failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `Zone shutdown orchestration failed: ${error.message}`,
    };
  }
};
