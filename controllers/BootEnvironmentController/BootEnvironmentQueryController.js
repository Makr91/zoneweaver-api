/**
 * @fileoverview Boot environment query operations
 */

import { executeCommand } from './utils/CommandHelper.js';
import { parseBeadmListOutput, parseBeadmDetailedOutput } from './utils/ParsingHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/boot-environments:
 *   get:
 *     summary: List boot environments
 *     description: Returns a list of boot environments with their status and metadata
 *     tags: [Boot Environment Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: detailed
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed dataset information
 *       - in: query
 *         name: snapshots
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include snapshot information
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by boot environment name
 *     responses:
 *       200:
 *         description: Boot environment list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 boot_environments:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       active:
 *                         type: string
 *                       mountpoint:
 *                         type: string
 *                       space:
 *                         type: string
 *                       policy:
 *                         type: string
 *                       created:
 *                         type: string
 *                       is_active_now:
 *                         type: boolean
 *                       is_active_on_reboot:
 *                         type: boolean
 *                       is_temporary:
 *                         type: boolean
 *                       datasets:
 *                         type: array
 *                         items:
 *                           type: object
 *                 total:
 *                   type: integer
 *                 active_be:
 *                   type: string
 *       500:
 *         description: Failed to list boot environments
 */
export const listBootEnvironments = async (req, res) => {
  try {
    const { detailed = false, snapshots = false, name } = req.query;

    let command = 'pfexec beadm list';

    if (detailed === 'true' || detailed === true) {
      command += ' -d';
    }

    if (snapshots === 'true' || snapshots === true) {
      command += ' -s';
    }

    if (name) {
      command += ` ${name}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list boot environments',
        details: result.error,
      });
    }

    let bootEnvironments;
    if (detailed === 'true' || detailed === true) {
      bootEnvironments = parseBeadmDetailedOutput(result.output);
    } else {
      bootEnvironments = parseBeadmListOutput(result.output);
    }

    // Find active BE
    const activeBE = bootEnvironments.find(be => be.is_active_now);

    return res.json({
      boot_environments: bootEnvironments,
      total: bootEnvironments.length,
      active_be: activeBE ? activeBE.name : null,
      detailed: detailed === 'true' || detailed === true,
      snapshots: snapshots === 'true' || snapshots === true,
      filter: name || null,
    });
  } catch (error) {
    log.api.error('Error listing boot environments', {
      error: error.message,
      stack: error.stack,
      detailed: req.query.detailed,
      snapshots: req.query.snapshots,
      name: req.query.name,
    });
    return res.status(500).json({
      error: 'Failed to list boot environments',
      details: error.message,
    });
  }
};
