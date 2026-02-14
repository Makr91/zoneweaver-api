/**
 * @fileoverview Zone Setup Task Manager for Zoneweaver API
 * @description Executes zlogin automation recipes against zones for early-boot configuration.
 *              Runs as a task in the TaskQueue system.
 */

import { log } from '../../lib/Logger.js';
import ZloginAutomation from '../../lib/ZloginAutomation.js';
import Recipes from '../../models/RecipeModel.js';
import Zones from '../../models/ZoneModel.js';
import yj from 'yieldable-json';
import { getZoneConfig } from '../../lib/ZoneConfigUtils.js';

/**
 * Execute zone setup task (zlogin recipe execution)
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSetupTask = async task => {
  const { zone_name } = task;
  let automation = null;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { recipe_id, variables = {} } = metadata;

    if (!recipe_id) {
      return { success: false, error: 'recipe_id is required in task metadata' };
    }

    // Load recipe
    const recipe = await Recipes.findByPk(recipe_id);
    if (!recipe) {
      return { success: false, error: `Recipe '${recipe_id}' not found` };
    }

    // Fetch zone to get partition_id and vm_type for vnic naming
    const zone = await Zones.findOne({ where: { name: zone_name } });
    if (!zone) {
      return { success: false, error: `Zone '${zone_name}' not found` };
    }

    // Generate vnic_name if not provided in variables
    if (!variables.vnic_name && zone.partition_id) {
      const zoneConfig = await getZoneConfig(zone_name);
      const nics = zoneConfig?.net || [];

      // Use first provisioning NIC (the one with MAC matching provisioning config)
      const provisioningNic = nics.find(
        nic => nic.mac?.toLowerCase() === variables.mac?.toLowerCase()
      );
      const nicIndex = provisioningNic ? nics.indexOf(provisioningNic) : 0;

      // Generate vnic name: vnic{nictype}{vmtype}_{partition_id}_{nic_index}
      const nicTypeMap = { external: 'e', internal: 'i', carp: 'c', management: 'm', host: 'h' };
      const vmTypeMap = {
        template: '1',
        development: '2',
        production: '3',
        firewall: '4',
        other: '5',
      };
      const nicType = nicTypeMap[variables.nic_type] || 'e';
      const vmType = vmTypeMap[zone.vm_type] || '3';
      const partitionId = zone.partition_id.padStart(4, '0');

      variables.vnic_name = `vnic${nicType}${vmType}_${partitionId}_${nicIndex}`;

      log.task.info('Generated vnic_name for provisioning', {
        zone_name,
        vnic_name: variables.vnic_name,
        partition_id: zone.partition_id,
        vm_type: zone.vm_type,
        nic_index: nicIndex,
      });
    }

    log.task.info('Starting zlogin automation', {
      zone_name,
      recipe_name: recipe.name,
      recipe_id,
    });

    // Create and execute automation
    automation = new ZloginAutomation(zone_name, {
      globalTimeout: (recipe.timeout_seconds || 300) * 1000,
    });

    const result = await automation.execute(recipe, variables);

    if (result.success) {
      log.task.info('Zlogin automation completed successfully', {
        zone_name,
        recipe_name: recipe.name,
        steps_executed: result.log?.length || 0,
      });
      return {
        success: true,
        message: `Zone setup completed using recipe '${recipe.name}'`,
        output: result.output,
      };
    }

    log.task.error('Zlogin automation failed', {
      zone_name,
      recipe_name: recipe.name,
      errors: result.errors,
    });
    return {
      success: false,
      error: `Zone setup failed: ${result.errors.join('; ')}`,
      output: result.output,
      log: result.log,
    };
  } catch (error) {
    log.task.error('Zone setup task failed', {
      zone_name,
      error: error.message,
    });
    return { success: false, error: `Zone setup failed: ${error.message}` };
  } finally {
    if (automation) {
      automation.destroy();
    }
  }
};
