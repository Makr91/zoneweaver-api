/**
 * @fileoverview Services Controller for Zoneweaver API
 * @description Handles API requests for OmniOS service management.
 * @author Mark Gilbert

 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import {
  getServices,
  getServiceDetails,
  enableService,
  disableService,
  restartService,
  refreshService,
  getProperties,
} from '../lib/ServiceManager.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import { log } from '../lib/Logger.js';

/**
 * @swagger
 * tags:
 *   name: Services
 *   description: Manage OmniOS services
 */

/**
 * @swagger
 * /services:
 *   get:
 *     summary: List all services
 *     tags: [Services]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: pattern
 *         schema:
 *           type: string
 *         description: Filter by service name pattern
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone name
 *       - in: query
 *         name: all
 *         schema:
 *           type: boolean
 *         description: Show all services, including disabled ones
 *     responses:
 *       200:
 *         description: A list of services
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   state:
 *                     type: string
 *                   stime:
 *                     type: string
 *                   fmri:
 *                     type: string
 *       500:
 *         description: Failed to retrieve services
 */
export const listServices = async (req, res) => {
  try {
    const { pattern, zone, all } = req.query;
    const options = { pattern, zone, all };
    const services = await getServices(options);
    res.json(services);
  } catch (error) {
    log.api.error('Error listing services', {
      error: error.message,
      stack: error.stack,
      pattern,
      zone,
    });
    res.status(500).json({ error: 'Failed to retrieve services' });
  }
};

/**
 * @swagger
 * /services/{fmri}:
 *   get:
 *     summary: Get service details
 *     tags: [Services]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: fmri
 *         required: true
 *         schema:
 *           type: string
 *         description: The FMRI of the service (URL-encoded)
 *     responses:
 *       200:
 *         description: The service details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       500:
 *         description: Failed to retrieve service details
 */
export const getServiceDetailsController = async (req, res) => {
  try {
    const { fmri } = req.params;
    const decodedFmri = decodeURIComponent(fmri);
    const service = await getServiceDetails(decodedFmri);
    res.json(service);
  } catch (error) {
    log.api.error('Error getting service details', {
      error: error.message,
      stack: error.stack,
      fmri: decodedFmri,
    });
    res.status(500).json({ error: 'Failed to retrieve service details' });
  }
};

/**
 * @swagger
 * /services/action:
 *   post:
 *     summary: Perform an action on a service
 *     tags: [Services]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               action:
 *                 type: string
 *                 enum: [enable, disable, restart, refresh]
 *               fmri:
 *                 type: string
 *               options:
 *                 type: object
 *     responses:
 *       200:
 *         description: The result of the action
 *       500:
 *         description: Failed to perform action
 */
export const serviceAction = async (req, res) => {
  try {
    const { action, fmri, options } = req.body;

    // Decode FMRI for proper storage and execution
    const decodedFmri = decodeURIComponent(fmri);

    const task = await Tasks.create({
      zone_name: decodedFmri,
      operation: `service_${action}`,
      priority: TaskPriority.SERVICE,
      created_by: req.entity.name,
      status: 'pending',
    });

    res.json({
      success: true,
      message: `Task created for action ${action} on service ${decodedFmri}`,
      task_id: task.id,
    });
  } catch (error) {
    log.api.error('Error creating service action task', {
      error: error.message,
      stack: error.stack,
      action: req.body.action,
      fmri: decodedFmri,
      created_by: req.entity?.name,
    });
    res.status(500).json({ error: `Failed to create task for action ${req.body.action}` });
  }
};

/**
 * @swagger
 * /services/{fmri}/properties:
 *   get:
 *     summary: Get service properties
 *     tags: [Services]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: fmri
 *         required: true
 *         schema:
 *           type: string
 *         description: The FMRI of the service (URL-encoded)
 *     responses:
 *       200:
 *         description: The service properties
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       500:
 *         description: Failed to retrieve service properties
 */
export const getPropertiesController = async (req, res) => {
  try {
    const { fmri } = req.params;
    const decodedFmri = decodeURIComponent(fmri);
    const properties = await getProperties(decodedFmri);
    res.json(properties);
  } catch (error) {
    log.api.error('Error getting service properties', {
      error: error.message,
      stack: error.stack,
      fmri: decodedFmri,
    });
    res.status(500).json({ error: 'Failed to retrieve service properties' });
  }
};
