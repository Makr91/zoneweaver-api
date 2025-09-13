import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { setRebootRequired } from '../../lib/RebootManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Execute hostname change task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSetHostnameTask = async metadataJson => {
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
    const { hostname, apply_immediately } = metadata;

    // Write to /etc/nodename
    const writeResult = await executeCommand(`echo "${hostname}" | pfexec tee /etc/nodename`);
    if (!writeResult.success) {
      return {
        success: false,
        error: `Failed to write to /etc/nodename: ${writeResult.error}`,
      };
    }

    // Apply immediately if requested
    if (apply_immediately) {
      const hostnameResult = await executeCommand(`pfexec hostname ${hostname}`);
      if (!hostnameResult.success) {
        return {
          success: false,
          error: `Failed to set hostname immediately: ${hostnameResult.error}`,
        };
      }
    }

    return {
      success: true,
      message: `Hostname set to ${hostname}${apply_immediately ? ' (applied immediately)' : ' (reboot required)'}`,
      requires_reboot: true,
      reboot_reason: apply_immediately
        ? 'Hostname applied immediately but reboot required for full persistence'
        : 'Hostname written to /etc/nodename - reboot required to take effect',
    };
  } catch (error) {
    return { success: false, error: `Hostname task failed: ${error.message}` };
  }
};
