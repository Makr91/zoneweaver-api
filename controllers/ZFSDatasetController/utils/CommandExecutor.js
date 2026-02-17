import { exec } from 'child_process';
import util from 'util';

/**
 * @fileoverview Command execution utility for ZFS dataset operations
 */

const execPromise = util.promisify(exec);

/**
 * Execute a command with timeout
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
export const executeCommand = async command => {
  try {
    const { stdout } = await execPromise(command, {
      encoding: 'utf8',
      timeout: 30000,
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
