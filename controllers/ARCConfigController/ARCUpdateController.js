import { setRebootRequired } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';
import { getPhysicalMemoryBytes } from './utils/ARCStatsHelper.js';
import { validateAllZFSSettings } from './utils/ARCValidationHelper.js';
import {
  categorizeZFSParameters,
  addParameterWarnings,
  applyRuntimeZFSConfiguration,
  applyPersistentZFSSettings,
  addPersistentConfigurationMessages,
  triggerARCStatsCollection,
} from './utils/ARCApplyHelper.js';

/**
 * @fileoverview ZFS ARC configuration update controller
 */

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
