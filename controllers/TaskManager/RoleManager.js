import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * Role Manager for Role Operations
 * Handles role creation, modification, and deletion
 */

/**
 * Execute role creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRoleCreateTask = async metadataJson => {
  log.task.debug('Role creation task starting');

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
      rolename,
      uid,
      gid,
      comment,
      home_directory,
      shell = '/bin/pfsh',
      create_home = false,
      authorizations = [],
      profiles = [],
      project,
    } = metadata;

    log.task.debug('Role creation task parameters', {
      rolename,
      uid,
      gid,
      create_home,
      has_rbac: authorizations.length > 0 || profiles.length > 0,
    });

    // Build roleadd command
    let command = `pfexec roleadd`;

    // Add UID
    if (uid) {
      command += ` -u ${uid}`;
    }

    // Add primary group
    if (gid) {
      command += ` -g ${gid}`;
    }

    // Add comment
    if (comment) {
      command += ` -c "${comment}"`;
    }

    // Add home directory
    if (home_directory) {
      command += ` -d "${home_directory}"`;
    }

    // Add shell (defaults to /bin/pfsh for roles)
    if (shell && shell !== '/bin/pfsh') {
      command += ` -s "${shell}"`;
    }

    // Add home directory creation
    if (create_home) {
      command += ` -m`;
    }

    // Add project
    if (project) {
      command += ` -p "${project}"`;
    }

    // Add RBAC authorizations
    if (authorizations && authorizations.length > 0) {
      command += ` -A "${authorizations.join(',')}"`;
    }

    // Add RBAC profiles
    if (profiles && profiles.length > 0) {
      command += ` -P "${profiles.join(',')}"`;
    }

    // Add role name
    command += ` ${rolename}`;

    log.task.debug('Executing role creation command', { command });

    const result = await executeCommand(command);

    const warnings = [];
    if (
      result.success ||
      (result.stderr &&
        result.stderr.includes('name too long') &&
        !result.stderr.includes('ERROR:'))
    ) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Role name '${rolename}' is longer than traditional 8-character limit`);
      }

      log.task.info('Role created successfully', {
        rolename,
        uid: uid || 'auto-assigned',
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Role ${rolename} created successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }
    log.task.error('Role creation command failed', {
      rolename,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to create role ${rolename}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Role creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role creation task failed: ${error.message}` };
  }
};

/**
 * Execute role modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRoleModifyTask = async metadataJson => {
  log.task.debug('Role modification task starting');

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
      rolename,
      new_rolename,
      new_uid,
      new_gid,
      new_comment,
      new_authorizations = [],
      new_profiles = [],
    } = metadata;

    log.task.debug('Role modification task parameters', {
      rolename,
      new_rolename,
      new_uid,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0,
    });

    // Build rolemod command
    let command = `pfexec rolemod`;

    // Add new UID
    if (new_uid) {
      command += ` -u ${new_uid}`;
    }

    // Add new primary group
    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    // Add new comment
    if (new_comment !== undefined) {
      command += ` -c "${new_comment}"`;
    }

    // Add new RBAC authorizations
    if (new_authorizations && new_authorizations.length > 0) {
      command += ` -A "${new_authorizations.join(',')}"`;
    }

    // Add new RBAC profiles
    if (new_profiles && new_profiles.length > 0) {
      command += ` -P "${new_profiles.join(',')}"`;
    }

    // Add new role name (must be last for rolemod -l)
    if (new_rolename) {
      command += ` -l ${new_rolename}`;
    }

    // Add current role name
    command += ` ${rolename}`;

    log.task.debug('Executing role modification command', { command });

    const result = await executeCommand(command);

    const warnings = [];
    if (
      result.success ||
      (result.stderr &&
        result.stderr.includes('name too long') &&
        !result.stderr.includes('ERROR:'))
    ) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(
          `Role name '${new_rolename || rolename}' is longer than traditional 8-character limit`
        );
      }

      log.task.info('Role modified successfully', {
        rolename,
        new_rolename: new_rolename || rolename,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `Role ${rolename}${new_rolename ? ` renamed to ${new_rolename}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_rolename: new_rolename || rolename,
      };
    }
    log.task.error('Role modification command failed', {
      rolename,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to modify role ${rolename}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Role modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role modification task failed: ${error.message}` };
  }
};

/**
 * Execute role deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeRoleDeleteTask = async metadataJson => {
  log.task.debug('Role deletion task starting');

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

    const { rolename, remove_home = false } = metadata;

    log.task.debug('Role deletion task parameters', {
      rolename,
      remove_home,
    });

    // Build roledel command
    let command = `pfexec roledel`;

    if (remove_home) {
      command += ` -r`;
    }

    command += ` ${rolename}`;

    log.task.debug('Executing role deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Role deleted successfully', {
        rolename,
        home_removed: remove_home,
      });

      return {
        success: true,
        message: `Role ${rolename} deleted successfully${remove_home ? ' (home directory removed)' : ''}`,
        home_removed: remove_home,
      };
    }
    log.task.error('Role deletion command failed', {
      rolename,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to delete role ${rolename}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Role deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Role deletion task failed: ${error.message}` };
  }
};
