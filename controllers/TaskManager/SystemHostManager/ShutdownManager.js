/**
 * @fileoverview System Host Shutdown Manager
 * @description Executes system shutdown operations for TaskQueue
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import yj from 'yieldable-json';
import { executeCommand } from '../../../lib/CommandManager.js';
import { log, createTimer } from '../../../lib/Logger.js';

/**
 * Execute system host shutdown task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostShutdownTask = async metadataJson => {
  const taskTimer = createTimer('system_host_shutdown');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { grace_period = 60, message = '', target_state = 's' } = metadata;

    log.monitoring.warn('SYSTEM SHUTDOWN: Task execution started', {
      grace_period,
      message,
      target_state,
    });

    let command = `pfexec shutdown -y -i ${target_state} -g ${grace_period}`;
    if (message) {
      command += ` "${message}"`;
    }

    log.monitoring.warn('SYSTEM SHUTDOWN: Executing shutdown command', {
      command: command.substring(0, 100),
      grace_period,
      target_state,
    });

    // Execute the shutdown command
    const result = await executeCommand(command, 300000); // 5 min timeout ## SHOULD NOT BE HARDCODED, ALL LIMITS SHOULD BE CONFIGURATION IN THE CONFIG.YML

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM SHUTDOWN: Command executed successfully', {
        duration_ms: duration,
        grace_period,
        target_state,
      });
      return {
        success: true,
        message: `System shutdown initiated successfully with ${grace_period} second grace period`,
      };
    }
    log.monitoring.error('SYSTEM SHUTDOWN: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System shutdown failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM SHUTDOWN: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System shutdown task failed: ${error.message}`,
    };
  }
};

/**
 * Execute system host poweroff task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostPoweroffTask = async metadataJson => {
  const taskTimer = createTimer('system_host_poweroff');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { grace_period = 60, message = '' } = metadata;

    log.monitoring.warn('SYSTEM POWEROFF: Task execution started', {
      grace_period,
      message,
    });

    let command = `pfexec shutdown -y -i 5 -g ${grace_period}`;
    if (message) {
      command += ` "${message}"`;
    }

    log.monitoring.warn('SYSTEM POWEROFF: Executing poweroff command', {
      command: command.substring(0, 100),
      grace_period,
    });

    // Execute the poweroff command
    const result = await executeCommand(command, 300000); // 5 min timeout

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.warn('SYSTEM POWEROFF: Command executed successfully', {
        duration_ms: duration,
        grace_period,
      });
      return {
        success: true,
        message: `System poweroff initiated successfully with ${grace_period} second grace period`,
      };
    }
    log.monitoring.error('SYSTEM POWEROFF: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System poweroff failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('SYSTEM POWEROFF: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System poweroff task failed: ${error.message}`,
    };
  }
};

/**
 * Execute system host halt task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostHaltTask = async metadataJson => {
  const taskTimer = createTimer('system_host_halt');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { emergency = false } = metadata;

    log.monitoring.error('EMERGENCY SYSTEM HALT: Task execution started', {
      emergency,
    });

    const command = 'pfexec halt';

    log.monitoring.error('EMERGENCY SYSTEM HALT: Executing halt command', {
      command,
      emergency,
    });

    // Execute the halt command
    const result = await executeCommand(command, 30000); // 30 sec timeout for halt

    const duration = taskTimer.end();

    if (result.success) {
      log.monitoring.error('EMERGENCY SYSTEM HALT: Command executed successfully', {
        duration_ms: duration,
        emergency,
      });
      return {
        success: true,
        message: 'System halt initiated successfully',
      };
    }
    log.monitoring.error('EMERGENCY SYSTEM HALT: Command failed', {
      error: result.error,
      duration_ms: duration,
    });
    return {
      success: false,
      error: `System halt failed: ${result.error}`,
    };
  } catch (error) {
    taskTimer.end();
    log.monitoring.error('EMERGENCY SYSTEM HALT: Task execution failed', {
      error: error.message,
      stack: error.stack,
    });
    return {
      success: false,
      error: `System halt task failed: ${error.message}`,
    };
  }
};
