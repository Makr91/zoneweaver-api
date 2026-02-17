import Zones from '../../models/ZoneModel.js';
import { log } from '../../lib/Logger.js';
import { validateZoneName } from '../../lib/ZoneValidation.js';

/**
 * @fileoverview Zone metadata controllers - notes and tags
 */

/**
 * @swagger
 * /zones/{zoneName}/notes:
 *   get:
 *     summary: Get zone notes
 *     description: Retrieves the user notes/annotations for a specific zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: Zone notes retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zone_name:
 *                   type: string
 *                 notes:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Zone not found
 */
export const getZoneNotes = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    return res.json({
      zone_name: zoneName,
      notes: zone.notes || null,
    });
  } catch (error) {
    log.database.error('Database error getting zone notes', {
      error: error.message,
      zone_name: req.params.zoneName,
    });
    return res.status(500).json({ error: 'Failed to retrieve zone notes' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/notes:
 *   put:
 *     summary: Update zone notes
 *     description: Sets or updates the user notes/annotations for a specific zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - notes
 *             properties:
 *               notes:
 *                 type: string
 *                 nullable: true
 *                 description: Free-form notes text (null or empty string to clear)
 *                 example: "Primary web server - do not stop during business hours"
 *     responses:
 *       200:
 *         description: Zone notes updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 zone_name:
 *                   type: string
 *                 notes:
 *                   type: string
 *                   nullable: true
 *       404:
 *         description: Zone not found
 */
export const updateZoneNotes = async (req, res) => {
  try {
    const { zoneName } = req.params;
    const { notes } = req.body;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    if (notes === undefined) {
      return res.status(400).json({ error: 'notes field is required' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    await zone.update({ notes: notes || null });

    return res.json({
      success: true,
      zone_name: zoneName,
      notes: zone.notes,
    });
  } catch (error) {
    log.database.error('Database error updating zone notes', {
      error: error.message,
      zone_name: req.params.zoneName,
    });
    return res.status(500).json({ error: 'Failed to update zone notes' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/tags:
 *   get:
 *     summary: Get zone tags
 *     description: Retrieves the tags for a specific zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: Zone tags retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 zone_name:
 *                   type: string
 *                 tags:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: string
 *       404:
 *         description: Zone not found
 */
export const getZoneTags = async (req, res) => {
  try {
    const { zoneName } = req.params;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    return res.json({
      zone_name: zoneName,
      tags: zone.tags || [],
    });
  } catch (error) {
    log.database.error('Database error getting zone tags', {
      error: error.message,
      zone_name: req.params.zoneName,
    });
    return res.status(500).json({ error: 'Failed to retrieve zone tags' });
  }
};

/**
 * @swagger
 * /zones/{zoneName}/tags:
 *   put:
 *     summary: Update zone tags
 *     description: Sets or updates the tags for a specific zone
 *     tags: [Zone Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tags
 *             properties:
 *               tags:
 *                 type: array
 *                 nullable: true
 *                 description: Array of tag strings (null or empty array to clear)
 *                 items:
 *                   type: string
 *                 example: ["web", "production", "critical"]
 *     responses:
 *       200:
 *         description: Zone tags updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 zone_name:
 *                   type: string
 *                 tags:
 *                   type: array
 *                   nullable: true
 *                   items:
 *                     type: string
 *       404:
 *         description: Zone not found
 */
export const updateZoneTags = async (req, res) => {
  try {
    const { zoneName } = req.params;
    const { tags } = req.body;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    if (tags === undefined) {
      return res.status(400).json({ error: 'tags field is required' });
    }

    if (tags !== null && !Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array or null' });
    }

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      return res.status(404).json({ error: 'Zone not found' });
    }

    const sanitizedTags = Array.isArray(tags) && tags.length > 0 ? tags : null;
    await zone.update({ tags: sanitizedTags });

    return res.json({
      success: true,
      zone_name: zoneName,
      tags: zone.tags || [],
    });
  } catch (error) {
    log.database.error('Database error updating zone tags', {
      error: error.message,
      zone_name: req.params.zoneName,
    });
    return res.status(500).json({ error: 'Failed to update zone tags' });
  }
};
