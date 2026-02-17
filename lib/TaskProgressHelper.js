import Tasks from '../models/TaskModel.js';
import { Op } from 'sequelize';
import { log } from './Logger.js';

/**
 * @fileoverview Shared task progress tracking utilities
 */

/**
 * Find the running task for progress updates
 * @param {string} operation - Task operation name
 * @param {string} searchTerm - Term to search in metadata
 * @returns {Promise<Object|null>} Task record or null
 */
export const findRunningTask = async (operation, searchTerm) => {
  try {
    return await Tasks.findOne({
      where: {
        operation,
        status: 'running',
        metadata: { [Op.like]: `%${searchTerm}%` },
      },
    });
  } catch {
    return null;
  }
};

/**
 * Update task progress
 * @param {Object} task - Task record
 * @param {number} percent - Progress percentage
 * @param {Object} info - Progress info object
 */
export const updateTaskProgress = async (task, percent, info) => {
  if (!task) {
    return;
  }
  try {
    await task.update({
      progress_percent: percent,
      progress_info: info,
    });
  } catch (error) {
    log.task.debug('Progress update failed', { error: error.message });
  }
};
