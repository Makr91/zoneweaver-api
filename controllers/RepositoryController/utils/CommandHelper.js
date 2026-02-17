/**
 * @fileoverview Repository command execution helper
 */

import { spawn } from 'child_process';

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = (command, timeout = 30000) =>
  new Promise(resolve => {
    const child = spawn('sh', ['-c', command], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        child.kill('SIGTERM');
        resolve({
          success: false,
          error: `Command timed out after ${timeout}ms`,
          output: stdout,
        });
      }
    }, timeout);

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);

        if (code === 0) {
          resolve({
            success: true,
            output: stdout.trim(),
          });
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
          });
        }
      }
    });

    child.on('error', error => {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        resolve({
          success: false,
          error: error.message,
          output: stdout,
        });
      }
    });
  });
