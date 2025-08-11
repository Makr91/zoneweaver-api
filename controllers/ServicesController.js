/**
 * @fileoverview Services Controller for Zoneweaver API
 * @description Handles API requests for OmniOS service management.
 * @author Cline
 * @version 0.0.1
 * @license GPL-3.0
 */
// x-release-please-version

import {
    getServices,
    getServiceDetails,
    enableService,
    disableService,
    restartService,
    refreshService,
    getProperties
} from '../lib/ServiceManager.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';

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
        console.error('Error listing services:', error);
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
        console.error('Error getting service details:', error);
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
        
        const task = await Tasks.create({
            zone_name: fmri,
            operation: `service_${action}`,
            priority: TaskPriority.SERVICE,
            created_by: req.entity.name,
            status: 'pending'
        });

        res.json({
            success: true,
            message: `Task created for action ${action} on service ${fmri}`,
            task_id: task.id
        });
    } catch (error) {
        console.error(`Error creating task for action ${req.body.action} on service ${req.body.fmri}:`, error);
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
        console.error('Error getting service properties:', error);
        res.status(500).json({ error: 'Failed to retrieve service properties' });
    }
};
