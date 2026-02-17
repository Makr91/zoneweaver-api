/**
 * @fileoverview VNIC command execution helper
 */

import { exec } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = async command => {
  try {
    const { stdout } = await execPromise(command, {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
    };
  }
};
