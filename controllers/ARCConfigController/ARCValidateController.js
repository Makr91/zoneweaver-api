import { log } from '../../lib/Logger.js';
import { getCurrentARCStats, getPhysicalMemoryBytes } from './utils/ARCStatsHelper.js';
import { validateARCSettings } from './utils/ARCValidationHelper.js';

/**
 * @fileoverview ZFS ARC configuration validation controller
 */

/**
 * @swagger
 * /system/zfs/arc/validate:
 *   post:
 *     summary: Validate ZFS ARC configuration
 *     description: Validates proposed ZFS ARC settings without applying them
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
 *                 description: Proposed ARC maximum size in GB
 *               arc_min_gb:
 *                 type: number
 *                 description: Proposed ARC minimum size in GB
 *               arc_max_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: Proposed ARC maximum size in bytes
 *               arc_min_bytes:
 *                 type: integer
 *                 format: int64
 *                 description: Proposed ARC minimum size in bytes
 *     responses:
 *       200:
 *         description: Validation results
 *       500:
 *         description: Failed to validate configuration
 */
export const validateARCConfig = async (req, res) => {
  try {
    const { arc_max_gb, arc_min_gb, arc_max_bytes, arc_min_bytes } = req.body;

    // Convert GB to bytes if provided in GB
    const arcMaxBytes = arc_max_bytes || (arc_max_gb ? arc_max_gb * 1024 ** 3 : null);
    const arcMinBytes = arc_min_bytes || (arc_min_gb ? arc_min_gb * 1024 ** 3 : null);

    // Get current settings for comparison
    const currentConfig = await getCurrentARCStats();
    const physicalMemoryBytes = await getPhysicalMemoryBytes();

    const settingsToValidate = {
      arc_max_bytes: arcMaxBytes || currentConfig.arc_max_bytes,
      arc_min_bytes: arcMinBytes || currentConfig.arc_min_bytes,
    };

    const validationResult = validateARCSettings(settingsToValidate, physicalMemoryBytes);

    res.json({
      valid: validationResult.valid,
      errors: validationResult.errors || [],
      warnings: validationResult.warnings || [],
      proposed_settings: {
        arc_max_bytes: settingsToValidate.arc_max_bytes,
        arc_min_bytes: settingsToValidate.arc_min_bytes,
        arc_max_gb: (settingsToValidate.arc_max_bytes / 1024 ** 3).toFixed(2),
        arc_min_gb: (settingsToValidate.arc_min_bytes / 1024 ** 3).toFixed(2),
      },
      system_constraints: {
        physical_memory_bytes: physicalMemoryBytes,
        max_safe_arc_bytes: Math.floor(physicalMemoryBytes * 0.85),
        min_recommended_arc_bytes: Math.floor(physicalMemoryBytes * 0.01),
      },
    });
  } catch (error) {
    log.api.error('Error validating ZFS ARC configuration', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to validate ZFS ARC configuration',
      details: error.message,
    });
  }
};
