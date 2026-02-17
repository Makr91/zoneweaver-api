/**
 * @fileoverview Repository query operations
 */

import { executeCommand } from './utils/CommandHelper.js';
import { parsePublisherOutput, parsePublisherTsvOutput } from './utils/ParsingHelpers.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/repositories:
 *   get:
 *     summary: List package repositories
 *     description: Returns a list of configured package repositories (publishers)
 *     tags: [Repository Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [default, tsv, detailed]
 *           default: default
 *         description: Output format
 *       - in: query
 *         name: enabled_only
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Show only enabled publishers
 *       - in: query
 *         name: publisher
 *         schema:
 *           type: string
 *         description: Filter by specific publisher name
 *     responses:
 *       200:
 *         description: Repository list retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 publishers:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       name:
 *                         type: string
 *                       type:
 *                         type: string
 *                       status:
 *                         type: string
 *                       proxy:
 *                         type: string
 *                       location:
 *                         type: string
 *                       sticky:
 *                         type: boolean
 *                       enabled:
 *                         type: boolean
 *                 total:
 *                   type: integer
 *                 format:
 *                   type: string
 *       500:
 *         description: Failed to list repositories
 */
export const listRepositories = async (req, res) => {
  const { format = 'default', enabled_only = false, publisher } = req.query;

  try {
    let command = 'pfexec pkg publisher';

    if (enabled_only === 'true' || enabled_only === true) {
      command += ' -n';
    }

    if (format === 'tsv' || format === 'detailed') {
      command += ' -F tsv';
    }

    if (publisher) {
      command += ` ${publisher}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(500).json({
        error: 'Failed to list repositories',
        details: result.error,
      });
    }

    let publishers;
    if (format === 'tsv' || format === 'detailed') {
      publishers = parsePublisherTsvOutput(result.output);
    } else {
      publishers = parsePublisherOutput(result.output);
    }

    return res.json({
      publishers,
      total: publishers.length,
      format,
      enabled_only: enabled_only === 'true' || enabled_only === true,
      filter: publisher || null,
    });
  } catch (error) {
    log.api.error('Error listing repositories', {
      error: error.message,
      stack: error.stack,
      format,
      enabled_only,
      publisher,
    });
    return res.status(500).json({
      error: 'Failed to list repositories',
      details: error.message,
    });
  }
};
