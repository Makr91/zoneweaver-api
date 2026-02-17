import { exec } from 'child_process';
import util from 'util';
import { setRebootRequired } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * @fileoverview ZFS ARC configuration reset controller
 */

/**
 * Helper function to apply runtime ZFS setting
 * @param {string} parameter - Parameter name
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
