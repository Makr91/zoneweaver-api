import { spawn } from 'child_process';
import { log, createTimer } from './Logger.js';

/**
 * Task timeout in milliseconds (5 minutes)
 */
export const TASK_TIMEOUT = 5 * 60 * 1000; // # SHOULD NOT BE HARDCODED SHOULD USE CONFIG.YAML REMOVE COMMENT AFTER FIXING

/**
 * Execute a zone command asynchronously
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = (command, timeout = TASK_TIMEOUT) => {
  const timer = createTimer(`executeCommand: ${command.substring(0, 50)}`);

  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    // Set up timeout
    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        child.kill('SIGTERM');
        log.task.error('Command execution timeout', {
          command: command.substring(0, 100),
          timeout_ms: timeout,
          stdout_preview: stdout.substring(0, 200),
        });
        timer.end();
        resolve({
          success: false,
          error: `Command timed out after ${timeout}ms`,
          output: stdout,
        });
      }
    }, timeout);

    // Collect output
    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    // Handle completion
    child.on('close', code => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        const duration = timer.end();

        if (code === 0) {
          // Log performance info if command took >1000ms
          if (duration > 1000) {
            log.performance.info('Slow command execution', {
              command: command.substring(0, 100),
              duration_ms: duration,
              stdout_size: stdout.length,
            });
          }
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          log.task.error('Command execution failed', {
            command: command.substring(0, 100),
            exit_code: code,
            stderr: stderr.trim().substring(0, 200),
            duration_ms: duration,
          });
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
          });
        }
      }
    });

    // Handle errors
    child.on('error', error => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        const duration = timer.end();
        log.task.error('Command execution error', {
          command: command.substring(0, 100),
          error: error.message,
          duration_ms: duration,
        });
        resolve({
          success: false,
          error: error.message,
          output: stdout,
        });
      }
    });
  });
};
