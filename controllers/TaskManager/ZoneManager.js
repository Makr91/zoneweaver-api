import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';
import Tasks from '../../models/TaskModel.js';
import Zones from '../../models/ZoneModel.js';
import VncSessions from '../../models/VncSessionModel.js';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkUsage from '../../models/NetworkUsageModel.js';
import IPAddresses from '../../models/IPAddressModel.js';
import { Op } from 'sequelize';
import os from 'os';

/**
 * Zone Manager for Zone Lifecycle Operations
 * Handles zone start, stop, restart, delete, discover operations and VNC session termination
 */

/**
 * Terminate VNC session for a zone
 * @param {string} zoneName - Name of zone
 */
const terminateVncSession = async zoneName => {
  try {
    const session = await VncSessions.findOne({
      where: { zone_name: zoneName, status: 'active' },
    });

    if (session && session.process_id) {
      try {
        process.kill(session.process_id, 'SIGTERM');
      } catch (error) {
        log.task.warn('Failed to kill VNC process', {
          zone_name: zoneName,
          process_id: session.process_id,
          error: error.message,
        });
      }

      await session.update({ status: 'stopped' });
    }
  } catch (error) {
    log.task.warn('Failed to terminate VNC session', {
      zone_name: zoneName,
      error: error.message,
    });
  }
};

/**
 * Execute zone start task
 * @param {string} zoneName - Name of zone to start
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStartTask = async zoneName => {
  const result = await executeCommand(`pfexec zoneadm -z ${zoneName} boot`);

  if (result.success) {
    // Update zone status in database
    await Zones.update(
      {
        status: 'running',
        last_seen: new Date(),
        is_orphaned: false,
      },
      { where: { name: zoneName } }
    );

    return {
      success: true,
      message: `Zone ${zoneName} started successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to start zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone stop task
 * @param {string} zoneName - Name of zone to stop
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeStopTask = async zoneName => {
  // First try graceful shutdown
  let result = await executeCommand(`pfexec zoneadm -z ${zoneName} shutdown`);

  // If graceful shutdown fails, try halt
  if (!result.success) {
    result = await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);
  }

  if (result.success) {
    // Update zone status in database
    await Zones.update(
      {
        status: 'installed',
        last_seen: new Date(),
      },
      { where: { name: zoneName } }
    );

    // Terminate any active VNC sessions for this zone
    await terminateVncSession(zoneName);

    return {
      success: true,
      message: `Zone ${zoneName} stopped successfully`,
    };
  }
  return {
    success: false,
    error: `Failed to stop zone ${zoneName}: ${result.error}`,
  };
};

/**
 * Execute zone restart task
 * @param {string} zoneName - Name of zone to restart
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRestartTask = async zoneName => {
  // Stop first
  const stopResult = await executeStopTask(zoneName);
  if (!stopResult.success) {
    return stopResult;
  }

  // Wait a moment for clean shutdown
  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });

  // Then start
  return executeStartTask(zoneName);
};

/**
 * Execute zone delete task
 * @param {string} zoneName - Name of zone to delete
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteTask = async zoneName => {
  try {
    // Terminate VNC session if active
    await terminateVncSession(zoneName);

    // Stop zone if running
    await executeCommand(`pfexec zoneadm -z ${zoneName} halt`);

    // Uninstall zone
    const uninstallResult = await executeCommand(`pfexec zoneadm -z ${zoneName} uninstall -F`);

    if (!uninstallResult.success) {
      return {
        success: false,
        error: `Failed to uninstall zone ${zoneName}: ${uninstallResult.error}`,
      };
    }

    // Delete zone configuration
    const deleteResult = await executeCommand(`pfexec zonecfg -z ${zoneName} delete -F`);

    if (!deleteResult.success) {
      return {
        success: false,
        error: `Failed to delete zone configuration ${zoneName}: ${deleteResult.error}`,
      };
    }

    // Clean up all database entries in parallel
    await Promise.all([
      // Remove zone from database
      Zones.destroy({ where: { name: zoneName } }),

      // Clean up associated data
      NetworkInterfaces.destroy({ where: { zone: zoneName } }),
      NetworkUsage.destroy({ where: { link: { [Op.like]: `${zoneName}%` } } }),
      IPAddresses.destroy({ where: { interface: { [Op.like]: `${zoneName}%` } } }),

      // Clean up any remaining tasks for this zone
      Tasks.update(
        { status: 'cancelled' },
        {
          where: {
            zone_name: zoneName,
            status: 'pending',
          },
        }
      ),
    ]);

    return {
      success: true,
      message: `Zone ${zoneName} deleted successfully`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to delete zone ${zoneName}: ${error.message}`,
    };
  }
};

/**
 * Execute zone discovery task
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDiscoverTask = async () => {
  try {
    // Get all zones from system using zadm
    const result = await executeCommand('pfexec zadm show');
    if (!result.success) {
      return { success: false, error: `Failed to get system zones: ${result.error}` };
    }

    const systemZones = await new Promise((resolve, reject) => {
      yj.parseAsync(result.output, (err, parseResult) => {
        if (err) {
          reject(err);
        } else {
          resolve(parseResult);
        }
      });
    });
    const systemZoneNames = Object.keys(systemZones);

    // Get all zones from database
    const dbZones = await Zones.findAll();
    const dbZoneNames = dbZones.map(z => z.name);

    let discovered = 0;
    let orphaned = 0;

    // Add new zones found on system but not in database
    const newZonesToCreate = systemZoneNames.filter(zoneName => !dbZoneNames.includes(zoneName));

    const createdZones = await Promise.all(
      newZonesToCreate.map(async zoneName => {
        const zoneConfig = systemZones[zoneName];

        // Get current status
        const statusResult = await executeCommand(`pfexec zoneadm -z ${zoneName} list -p`);
        let status = 'configured';
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || 'configured';
        }

        return Zones.create({
          name: zoneName,
          zone_id: zoneConfig.zonename || zoneName,
          host: os.hostname(),
          status,
          brand: zoneConfig.brand || 'unknown',
          configuration: zoneConfig,
          auto_discovered: true,
          last_seen: new Date(),
        });
      })
    );

    discovered = createdZones.length;

    // Process orphaned and existing zones in parallel
    const orphanedZones = dbZones.filter(dbZone => !systemZoneNames.includes(dbZone.name));
    const existingZones = dbZones.filter(dbZone => systemZoneNames.includes(dbZone.name));

    // Mark zones as orphaned in parallel
    await Promise.all(orphanedZones.map(dbZone => dbZone.update({ is_orphaned: true })));
    orphaned = orphanedZones.length;

    // Update existing zones in parallel
    await Promise.all(
      existingZones.map(async dbZone => {
        const zoneConfig = systemZones[dbZone.name];
        const statusResult = await executeCommand(`pfexec zoneadm -z ${dbZone.name} list -p`);
        let { status } = dbZone;
        if (statusResult.success) {
          const parts = statusResult.output.split(':');
          status = parts[2] || dbZone.status;
        }

        return dbZone.update({
          status,
          brand: zoneConfig.brand || dbZone.brand,
          configuration: zoneConfig,
          last_seen: new Date(),
          is_orphaned: false,
        });
      })
    );

    return {
      success: true,
      message: `Discovery completed: ${discovered} new zones discovered, ${orphaned} zones orphaned`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Zone discovery failed: ${error.message}`,
    };
  }
};
