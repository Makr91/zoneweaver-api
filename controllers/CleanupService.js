import config from '../config/ConfigLoader.js';
import { Op } from 'sequelize';
import { log, createTimer } from '../lib/Logger.js';

class CleanupService {
  constructor() {
    this.cleanupConfig = config.get('cleanup') || { interval: 300, retention_days: 7 };
    this.tasks = [];
    this.isRunning = false; // Mutex protection
    this.stats = {
      totalRuns: 0,
      lastRunTime: null,
      lastRunDuration: null,
      totalTasksProcessed: 0,
      totalErrors: 0,
      lastError: null,
    };
  }

  /**
   * Register a cleanup task
   * @param {Object} task - Task configuration
   * @param {string} task.name - Task name for logging
   * @param {Function|Object} task.handler - Function to execute or {model, where} for model-based cleanup
   * @param {string} [task.description] - Optional task description
   */
  registerTask(task) {
    if (!task.name) {
      throw new Error('Task must have a name');
    }

    if (!task.handler && !task.model) {
      throw new Error('Task must have either a handler function or model');
    }

    this.tasks.push({
      name: task.name,
      handler: task.handler,
      model: task.model,
      where: task.where,
      description: task.description || task.name,
      runs: 0,
      errors: 0,
      lastSuccess: null,
      lastError: null,
    });

    log.monitoring.debug('Cleanup task registered', {
      task_name: task.name,
      description: task.description || task.name,
    });
  }

  /**
   * Run all registered cleanup tasks with mutex protection
   */
  async run() {
    if (this.isRunning) {
      log.monitoring.warn('Cleanup already in progress, skipping cycle', {
        cycle_number: this.stats.totalRuns + 1,
      });
      return;
    }

    this.isRunning = true;
    const timer = createTimer('cleanup_cycle');

    try {
      this.stats.totalRuns++;
      log.monitoring.info('Starting cleanup cycle', {
        cycle_number: this.stats.totalRuns,
        task_count: this.tasks.length,
        interval_seconds: this.cleanupConfig.interval,
      });

      let tasksCompleted = 0;
      let tasksWithErrors = 0;
      let totalRecordsDeleted = 0;

      for (const task of this.tasks) {
        const taskTimer = createTimer(`cleanup_task_${task.name}`);
        try {
          task.runs++;

          let result = null;

          if (typeof task.handler === 'function') {
            // Function-based task
            result = await task.handler();
          } else if (task.model && task.where) {
            // Model-based task (original format)
            result = await task.model.destroy({ where: task.where });
            if (result > 0) {
              totalRecordsDeleted += result;
              log.database.info('Database cleanup completed', {
                task_name: task.name,
                model_name: task.model.name,
                records_deleted: result,
                duration_ms: taskTimer.end(),
              });
            }
          } else {
            throw new Error('Invalid task configuration');
          }

          task.lastSuccess = new Date();
          tasksCompleted++;
        } catch (error) {
          task.errors++;
          task.lastError = error.message;
          tasksWithErrors++;
          this.stats.totalErrors++;
          this.stats.lastError = `${task.name}: ${error.message}`;

          log.database.error('Cleanup task failed', {
            task_name: task.name,
            error: error.message,
            duration_ms: taskTimer.end(),
          });
        }
      }

      const duration = timer.end();
      this.stats.lastRunTime = new Date();
      this.stats.lastRunDuration = duration;
      this.stats.totalTasksProcessed += tasksCompleted;

      if (tasksWithErrors > 0) {
        log.monitoring.warn('Cleanup cycle completed with errors', {
          cycle_number: this.stats.totalRuns,
          tasks_completed: tasksCompleted,
          tasks_with_errors: tasksWithErrors,
          total_tasks: this.tasks.length,
          total_records_deleted: totalRecordsDeleted,
          duration_ms: duration,
        });
      } else {
        log.monitoring.info('Cleanup cycle completed successfully', {
          cycle_number: this.stats.totalRuns,
          tasks_completed: tasksCompleted,
          total_tasks: this.tasks.length,
          total_records_deleted: totalRecordsDeleted,
          duration_ms: duration,
        });
      }
    } catch (error) {
      this.stats.totalErrors++;
      this.stats.lastError = error.message;
      const duration = timer.end();
      log.monitoring.error('Cleanup cycle failed', {
        cycle_number: this.stats.totalRuns,
        error: error.message,
        stack: error.stack,
        duration_ms: duration,
      });
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Start the cleanup service with interval scheduling
   */
  start() {
    log.monitoring.info('Starting cleanup service', {
      interval_seconds: this.cleanupConfig.interval,
      retention_days: this.cleanupConfig.retention_days,
      registered_tasks: this.tasks.length,
    });

    // Run immediately on startup
    this.run();

    // Schedule recurring runs
    setInterval(() => {
      this.run();
    }, this.cleanupConfig.interval * 1000);
  }

  /**
   * Get cleanup service status
   * @returns {Object} Status information
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      config: this.cleanupConfig,
      stats: { ...this.stats },
      tasks: this.tasks.map(task => ({
        name: task.name,
        description: task.description,
        runs: task.runs,
        errors: task.errors,
        lastSuccess: task.lastSuccess,
        lastError: task.lastError,
      })),
    };
  }

  /**
   * Trigger immediate cleanup run (for testing/debugging)
   * @returns {Object} Run results
   */
  async triggerImmediate() {
    await this.run();
    return this.getStatus();
  }
}

export default new CleanupService();
