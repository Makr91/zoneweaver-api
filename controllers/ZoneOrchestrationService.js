/**
 * @fileoverview Zone Orchestration Service for Zoneweaver API
 * @description Handles zone orchestration startup and service management
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';
import { executeDiscoverTask } from './TaskManager/ZoneManager.js';
import { getAutobootZones } from '../lib/ZoneOrchestrationManager.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';

/**
 * Start zone orchestration service
 * @description Checks orchestration configuration and starts autoboot zones if enabled
 * @returns {Promise<void>}
 */
export const startZoneOrchestration = async () => {
  try {
    const orchestrationConfig = config.getZoneOrchestration();
    
    if (!orchestrationConfig.enabled) {
      log.monitoring.debug('Zone orchestration disabled in configuration');
      return;
    }

    log.monitoring.info('Zone orchestration enabled - running discovery first');

    // Force zone discovery to ensure database has fresh configuration data
    const discoveryResult = await executeDiscoverTask();

    if (discoveryResult.success) {
      log.monitoring.info('Zone discovery completed - checking autoboot zones');
    } else {
      log.monitoring.warn('Zone discovery failed during startup', {
        error: discoveryResult.error,
      });
    }

    const autobootZones = await getAutobootZones();

    if (autobootZones.success && autobootZones.zones.length > 0) {
      log.monitoring.info('Zone orchestration startup initiated', {
        autoboot_zones_found: autobootZones.zones.length,
        zones: autobootZones.zones.map(z => ({ name: z.name, priority: z.priority })),
      });

      // Create start tasks for each autoboot zone in priority order (highest first)
      const sortedZones = autobootZones.zones.sort((a, b) => b.priority - a.priority);

      // Create all tasks in parallel for optimal performance
      const taskPromises = sortedZones.map(zone => {
        log.monitoring.debug('Zone start task created for autoboot', {
          zone_name: zone.name,
          priority: zone.priority,
        });

        return Tasks.create({
          zone_name: zone.name,
          operation: 'start',
          priority: TaskPriority.HIGH,
          created_by: 'orchestration_startup',
          status: 'pending',
        });
      });

      await Promise.all(taskPromises);

      log.monitoring.info('Zone orchestration startup tasks created', {
        zones_queued: sortedZones.length,
        startup_action: 'zone_orchestration_startup',
      });
    } else {
      log.monitoring.info('Zone orchestration enabled but no autoboot zones found');
    }
  } catch (error) {
    log.monitoring.error('Error during zone orchestration startup', {
      error: error.message,
      stack: error.stack,
    });
  }
};

/**
 * Get zone orchestration service status
 * @description Returns status of zone orchestration feature
 * @returns {Object} Service status information
 */
export const getZoneOrchestrationServiceStatus = () => {
  const orchestrationConfig = config.getZoneOrchestration();
  
  return {
    name: 'zone_orchestration',
    enabled: orchestrationConfig.enabled,
    type: 'startup_action',
    description: 'Zone orchestration startup service - starts autoboot zones in priority order',
  };
};
