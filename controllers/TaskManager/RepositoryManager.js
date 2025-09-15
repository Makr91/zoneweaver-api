import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Repository Manager for Package Repository Operations
 * Handles repository addition, removal, modification, enable, and disable operations
 */

/**
 * Execute repository addition task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryAddTask = async metadataJson => {
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
    const {
      name,
      origin,
      mirrors,
      ssl_cert,
      ssl_key,
      enabled,
      sticky,
      search_first,
      search_before,
      search_after,
      properties,
      proxy,
    } = metadata;

    let command = `pfexec pkg set-publisher`;

    // Add SSL credentials
    if (ssl_cert) {
      command += ` -c ${ssl_cert}`;
    }
    if (ssl_key) {
      command += ` -k ${ssl_key}`;
    }

    // Add origin
    command += ` -g ${origin}`;

    // Add mirrors
    if (mirrors && mirrors.length > 0) {
      for (const mirror of mirrors) {
        command += ` -m ${mirror}`;
      }
    }

    // Add search order options
    if (search_first) {
      command += ` --search-first`;
    } else if (search_before) {
      command += ` --search-before ${search_before}`;
    } else if (search_after) {
      command += ` --search-after ${search_after}`;
    }

    // Add sticky/non-sticky
    if (sticky === false) {
      command += ` --non-sticky`;
    }

    // Add properties
    if (properties && Object.keys(properties).length > 0) {
      for (const [key, value] of Object.entries(properties)) {
        command += ` --set-property ${key}=${value}`;
      }
    }

    // Add proxy
    if (proxy) {
      command += ` --proxy ${proxy}`;
    }

    // Add publisher name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      // If enabled is false, disable the publisher
      if (enabled === false) {
        const disableResult = await executeCommand(`pfexec pkg set-publisher --disable ${name}`);
        if (!disableResult.success) {
          log.task.warn('Publisher added but failed to disable', {
            name,
            error: disableResult.error,
          });
        }
      }

      return {
        success: true,
        message: `Repository '${name}' added successfully${enabled === false ? ' (disabled)' : ''}`,
      };
    }
    return {
      success: false,
      error: `Failed to add repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository addition task failed: ${error.message}` };
  }
};

/**
 * Execute repository removal task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryRemoveTask = async metadataJson => {
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
    const { name } = metadata;

    const command = `pfexec pkg unset-publisher ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' removed successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to remove repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository removal task failed: ${error.message}` };
  }
};

/**
 * Execute repository modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryModifyTask = async metadataJson => {
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
    const {
      name,
      origins_to_add,
      origins_to_remove,
      mirrors_to_add,
      mirrors_to_remove,
      ssl_cert,
      ssl_key,
      enabled,
      sticky,
      search_first,
      search_before,
      search_after,
      properties_to_set,
      properties_to_unset,
      proxy,
      reset_uuid,
      refresh,
    } = metadata;

    let command = `pfexec pkg set-publisher`;

    // Add SSL credentials
    if (ssl_cert) {
      command += ` -c ${ssl_cert}`;
    }
    if (ssl_key) {
      command += ` -k ${ssl_key}`;
    }

    // Add origins
    if (origins_to_add && origins_to_add.length > 0) {
      for (const origin of origins_to_add) {
        command += ` -g ${origin}`;
      }
    }
    if (origins_to_remove && origins_to_remove.length > 0) {
      for (const origin of origins_to_remove) {
        command += ` -G ${origin}`;
      }
    }

    // Add mirrors
    if (mirrors_to_add && mirrors_to_add.length > 0) {
      for (const mirror of mirrors_to_add) {
        command += ` -m ${mirror}`;
      }
    }
    if (mirrors_to_remove && mirrors_to_remove.length > 0) {
      for (const mirror of mirrors_to_remove) {
        command += ` -M ${mirror}`;
      }
    }

    // Add enable/disable
    if (enabled === true) {
      command += ` --enable`;
    } else if (enabled === false) {
      command += ` --disable`;
    }

    // Add sticky/non-sticky
    if (sticky === true) {
      command += ` --sticky`;
    } else if (sticky === false) {
      command += ` --non-sticky`;
    }

    // Add search order options
    if (search_first) {
      command += ` --search-first`;
    } else if (search_before) {
      command += ` --search-before ${search_before}`;
    } else if (search_after) {
      command += ` --search-after ${search_after}`;
    }

    // Add properties to set
    if (properties_to_set && Object.keys(properties_to_set).length > 0) {
      for (const [key, value] of Object.entries(properties_to_set)) {
        command += ` --set-property ${key}=${value}`;
      }
    }

    // Add properties to unset
    if (properties_to_unset && properties_to_unset.length > 0) {
      for (const prop of properties_to_unset) {
        command += ` --unset-property ${prop}`;
      }
    }

    // Add proxy
    if (proxy) {
      command += ` --proxy ${proxy}`;
    }

    // Add reset UUID
    if (reset_uuid) {
      command += ` --reset-uuid`;
    }

    // Add refresh
    if (refresh) {
      command += ` --refresh`;
    }

    // Add publisher name
    command += ` ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' modified successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to modify repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository modification task failed: ${error.message}` };
  }
};

/**
 * Execute repository enable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryEnableTask = async metadataJson => {
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
    const { name } = metadata;

    const command = `pfexec pkg set-publisher --enable ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' enabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to enable repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository enable task failed: ${error.message}` };
  }
};

/**
 * Execute repository disable task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRepositoryDisableTask = async metadataJson => {
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
    const { name } = metadata;

    const command = `pfexec pkg set-publisher --disable ${name}`;

    const result = await executeCommand(command);

    if (result.success) {
      return {
        success: true,
        message: `Repository '${name}' disabled successfully`,
      };
    }
    return {
      success: false,
      error: `Failed to disable repository '${name}': ${result.error}`,
    };
  } catch (error) {
    return { success: false, error: `Repository disable task failed: ${error.message}` };
  }
};
