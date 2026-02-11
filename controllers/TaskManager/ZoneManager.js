import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { getAllZoneConfigs, syncZoneToDatabase } from '../../lib/ZoneConfigUtils.js';
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
 * Extract ZFS dataset paths from a zone configuration for cleanup
 * @param {string} zoneName - Name of zone
 * @returns {Promise<{zonepath: string|null, datasets: string[]}>}
 */
const extractZoneDatasets = async zoneName => {
  const datasets = [];
  let zonepath = null;

  try {
    // Get zone configuration from database
    const zone = await Zones.findOne({ where: { name: zoneName } });
    let zoneConfig = zone?.configuration;

    // <DEBUG_LOG_REMOVE_LATER>
    log.task.info('DEBUG: extractZoneDatasets - Initial DB Config', {
      zone_name: zoneName,
      config_type: typeof zoneConfig,
      is_string: typeof zoneConfig === 'string',
      raw_value_preview: typeof zoneConfig === 'string' ? zoneConfig.substring(0, 200) : 'Object',
    });
    // </DEBUG_LOG_REMOVE_LATER>

    // Fix: Explicitly parse JSON if it's a string (SQLite behavior)
    if (typeof zoneConfig === 'string') {
      try {
        zoneConfig = JSON.parse(zoneConfig);
      } catch (parseErr) {
        log.task.error('DEBUG: Failed to parse zone configuration string', {
          error: parseErr.message,
        });
      }
    }

    // Self-healing: If not in DB, check system and create record if found
    if (!zoneConfig) {
      try {
        log.task.info('Zone not found in DB, attempting to sync from system for cleanup', {
          zone_name: zoneName,
        });
        const newZone = await syncZoneToDatabase(zoneName);
        zoneConfig = newZone.configuration;
      } catch (err) {
        // Zone truly doesn't exist on system either
        log.task.warn('Zone not found in database or system', {
          zone_name: zoneName,
          error: err.message,
        });
      }
    }

    // <DEBUG_LOG_REMOVE_LATER>
    log.task.info('DEBUG: extractZoneDatasets - Final Config Object', {
      zone_name: zoneName,
      has_bootdisk: !!zoneConfig?.bootdisk,
      bootdisk_path: zoneConfig?.bootdisk?.path,
    });
    // </DEBUG_LOG_REMOVE_LATER>

    if (!zoneConfig) {
      return { zonepath, datasets };
    }

    // Extract zonepath (e.g., /rpool/zones/myzone/path)
    if (zoneConfig.zonepath) {
      ({ zonepath } = zoneConfig);
      // Zone root dataset is the parent of the zonepath
      // e.g., zonepath=/rpool/zones/myzone/path → root dataset = rpool/zones/myzone
      const pathParts = zonepath.replace(/^\//, '').split('/');
      if (pathParts.length >= 2) {
        // Remove the last segment (usually "path") to get the zone root dataset
        const rootDataset = pathParts.slice(0, -1).join('/');
        datasets.push(rootDataset);
      }
    }

    // Extract bootdisk (top-level property in zadm JSON format)
    if (zoneConfig.bootdisk && zoneConfig.bootdisk.path) {
      datasets.push(zoneConfig.bootdisk.path);
    }

    // Extract additional disk attributes from attr array (disk0, disk1, etc.)
    if (zoneConfig.attr) {
      const attrs = Array.isArray(zoneConfig.attr) ? zoneConfig.attr : [zoneConfig.attr];
      for (const attr of attrs) {
        if (attr.name && /^disk\d+$/.test(attr.name) && attr.value) {
          datasets.push(attr.value);
        }
      }
    }

    // <DEBUG_LOG_REMOVE_LATER>
    log.task.info('DEBUG: extractZoneDatasets - Identified Datasets', {
      zone_name: zoneName,
      datasets,
    });
    // </DEBUG_LOG_REMOVE_LATER>
  } catch (error) {
    log.task.warn('Failed to extract zone datasets', {
      zone_name: zoneName,
      error: error.message,
    });
  }

  return { zonepath, datasets };
};

/**
 * Execute zone delete task
 * @param {string} zoneName - Name of zone to delete
 * @param {string} [metadataJson] - Optional JSON metadata string with cleanup options
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteTask = async (zoneName, metadataJson) => {
  try {
    let cleanupDatasets = false;
    if (metadataJson) {
      try {
        const metadata = await new Promise((resolve, reject) => {
          yj.parseAsync(metadataJson, (err, parseResult) => {
            if (err) {
              reject(err);
            } else {
              resolve(parseResult);
            }
          });
        });
        cleanupDatasets = metadata.cleanup_datasets === true;
      } catch {
        // Ignore metadata parse errors - proceed without cleanup
      }
    }

    // Collect dataset info before deleting the zone config
    let zoneDatasets = { zonepath: null, datasets: [] };
    if (cleanupDatasets) {
      zoneDatasets = await extractZoneDatasets(zoneName);
      log.task.info('Collected ZFS datasets for cleanup', {
        zone_name: zoneName,
        datasets: zoneDatasets.datasets,
      });
    }

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

    // Clean up ZFS datasets if requested
    const datasetErrors = [];
    if (cleanupDatasets && zoneDatasets.datasets.length > 0) {
      // Find the zone root dataset (shortest path, typically the parent of all others)
      const sortedDatasets = [...zoneDatasets.datasets].sort((a, b) => a.length - b.length);
      const [rootDataset] = sortedDatasets;

      // Destroy the root dataset recursively (covers boot volume, zonepath, provisioning datasets)
      const destroyResult = await executeCommand(`pfexec zfs destroy -r ${rootDataset}`);
      if (!destroyResult.success) {
        datasetErrors.push(`Failed to destroy ${rootDataset}: ${destroyResult.error}`);

        // If recursive destroy of root failed, try individual datasets in parallel
        const individualDestroys = sortedDatasets
          .reverse()
          .filter(dataset => dataset !== rootDataset)
          .map(dataset => executeCommand(`pfexec zfs destroy -r ${dataset}`));

        const individualResults = await Promise.all(individualDestroys);
        individualResults.forEach((result, idx) => {
          if (!result.success) {
            const dataset = sortedDatasets.reverse()[idx];
            datasetErrors.push(`Failed to destroy ${dataset}: ${result.error}`);
          }
        });
      }

      // Destroy any external disks that are NOT under the root dataset
      for (const dataset of zoneDatasets.datasets) {
        if (!dataset.startsWith(rootDataset)) {
          log.task.info('Skipping external dataset (not in zone hierarchy)', {
            zone_name: zoneName,
            dataset,
            root_dataset: rootDataset,
          });
        }
      }

      if (datasetErrors.length > 0) {
        log.task.warn('Some ZFS datasets could not be cleaned up', {
          zone_name: zoneName,
          errors: datasetErrors,
        });
      }
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

    let message = `Zone ${zoneName} deleted successfully`;
    if (cleanupDatasets) {
      if (datasetErrors.length === 0) {
        message += ' (ZFS datasets cleaned up)';
      } else {
        message += ` (${datasetErrors.length} ZFS dataset cleanup errors)`;
      }
    }

    return {
      success: true,
      message,
      dataset_errors: datasetErrors.length > 0 ? datasetErrors : undefined,
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
    const systemZones = await getAllZoneConfigs();
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
