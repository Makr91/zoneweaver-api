/**
 * @fileoverview Fault action endpoints
 */

import { exec } from 'child_process';
import util from 'util';
import config from '../../config/ConfigLoader.js';
import { log } from '../../lib/Logger.js';
import { faultCache } from './utils/CacheHelper.js';

const execProm = util.promisify(exec);

/**
 * @swagger
 * /system/fault-management/actions/acquit:
 *   post:
 *     summary: Acquit a fault or resource
 *     description: Mark a fault as acquitted (can be ignored safely)
 *     tags: [Fault Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               target:
 *                 type: string
 *                 description: FMRI or UUID to acquit
 *               uuid:
 *                 type: string
 *                 description: Optional specific fault UUID
 *     responses:
 *       200:
 *         description: Fault acquitted successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to acquit fault
 */
export const acquitFault = async (req, res) => {
  try {
    const { target, uuid } = req.body;
    const faultConfig = config.getFaultManagement();

    if (!faultConfig?.enabled) {
      return res.status(503).json({
        error: 'Fault management is disabled in configuration',
      });
    }

    if (!target) {
      return res.status(400).json({
        error: 'Target (FMRI or UUID) is required',
      });
    }

    let command = `pfexec fmadm acquit ${target}`;
    if (uuid) {
      command += ` ${uuid}`;
    }

    const { stdout, stderr } = await execProm(command, {
      timeout: faultConfig.timeout * 1000,
    });

    // Clear all cache entries after administrative action
    faultCache.clear();

    return res.json({
      success: true,
      message: `Successfully acquitted ${target}`,
      target,
      uuid: uuid || null,
      raw_output: stdout,
      stderr: stderr || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error acquitting fault', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to acquit fault',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/fault-management/actions/repaired:
 *   post:
 *     summary: Mark resource as repaired
 *     description: Notify fault manager that a resource has been repaired
 *     tags: [Fault Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fmri:
 *                 type: string
 *                 description: FMRI of the repaired resource
 *     responses:
 *       200:
 *         description: Resource marked as repaired successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to mark resource as repaired
 */
export const markRepaired = async (req, res) => {
  try {
    const { fmri } = req.body;
    const faultConfig = config.getFaultManagement();

    if (!faultConfig?.enabled) {
      return res.status(503).json({
        error: 'Fault management is disabled in configuration',
      });
    }

    if (!fmri) {
      return res.status(400).json({
        error: 'FMRI is required',
      });
    }

    const command = `pfexec fmadm repaired ${fmri}`;
    const { stdout, stderr } = await execProm(command, {
      timeout: faultConfig.timeout * 1000,
    });

    // Clear all cache entries after administrative action
    faultCache.clear();

    return res.json({
      success: true,
      message: `Successfully marked ${fmri} as repaired`,
      fmri,
      raw_output: stdout,
      stderr: stderr || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error marking resource as repaired', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to mark resource as repaired',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/fault-management/actions/replaced:
 *   post:
 *     summary: Mark resource as replaced
 *     description: Notify fault manager that a resource has been replaced
 *     tags: [Fault Management]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               fmri:
 *                 type: string
 *                 description: FMRI of the replaced resource
 *     responses:
 *       200:
 *         description: Resource marked as replaced successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to mark resource as replaced
 */
export const markReplaced = async (req, res) => {
  try {
    const { fmri } = req.body;
    const faultConfig = config.getFaultManagement();

    if (!faultConfig?.enabled) {
      return res.status(503).json({
        error: 'Fault management is disabled in configuration',
      });
    }

    if (!fmri) {
      return res.status(400).json({
        error: 'FMRI is required',
      });
    }

    const command = `pfexec fmadm replaced ${fmri}`;
    const { stdout, stderr } = await execProm(command, {
      timeout: faultConfig.timeout * 1000,
    });

    // Clear all cache entries after administrative action
    faultCache.clear();

    return res.json({
      success: true,
      message: `Successfully marked ${fmri} as replaced`,
      fmri,
      raw_output: stdout,
      stderr: stderr || null,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    log.api.error('Error marking resource as replaced', {
      error: error.message,
      stack: error.stack,
    });
    return res.status(500).json({
      error: 'Failed to mark resource as replaced',
      details: error.message,
    });
  }
};
