import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';

/**
 * User Manager for User Account Operations
 * Handles user creation, modification, deletion, locking, unlocking, and password setting
 */

/**
 * Execute user creation task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserCreateTask = async metadataJson => {
  log.task.debug('User creation task starting');

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
      username,
      uid,
      gid,
      groups = [],
      comment,
      home_directory,
      shell = '/bin/bash',
      create_home = true,
      skeleton_dir,
      expire_date,
      inactive_days,
      authorizations = [],
      profiles = [],
      roles = [],
      project,
      create_personal_group = true,
      force_zfs = false,
      prevent_zfs = false,
    } = metadata;

    log.task.debug('User creation task parameters', {
      username,
      uid,
      gid,
      create_personal_group,
      has_rbac: authorizations.length > 0 || profiles.length > 0 || roles.length > 0,
    });

    const warnings = [];
    let createdGroup = null;

    // Step 1: Create personal group if requested and no gid specified
    if (create_personal_group && !gid) {
      log.task.debug('Creating personal group', { groupname: username });

      let groupCommand = `pfexec groupadd`;
      if (uid) {
        groupCommand += ` -g ${uid}`;
      }
      groupCommand += ` ${username}`;

      const groupResult = await executeCommand(groupCommand);

      if (groupResult.success) {
        createdGroup = username;
        log.task.info('Personal group created', { groupname: username, gid: uid });
      } else {
        // Check if it's just a warning about name length
        if (groupResult.error && groupResult.error.includes('name too long')) {
          warnings.push(`Group name '${username}' is longer than recommended but was created`);
          createdGroup = username;
        } else {
          log.task.warn('Failed to create personal group, continuing without it', {
            groupname: username,
            error: groupResult.error,
          });
          warnings.push(`Failed to create personal group '${username}': ${groupResult.error}`);
        }
      }
    }

    // Step 2: Build useradd command
    let command = `pfexec useradd`;

    // Add UID
    if (uid) {
      command += ` -u ${uid}`;
    }

    // Add primary group (personal group if created, or specified gid)
    if (createdGroup) {
      command += ` -g ${createdGroup}`;
    } else if (gid) {
      command += ` -g ${gid}`;
    }

    // Add supplementary groups
    if (groups && groups.length > 0) {
      command += ` -G ${groups.join(',')}`;
    }

    // Add comment
    if (comment) {
      command += ` -c "${comment}"`;
    }

    // Add home directory
    if (home_directory) {
      command += ` -d "${home_directory}"`;
    }

    // Add shell
    if (shell && shell !== '/bin/sh') {
      command += ` -s "${shell}"`;
    }

    // Add home directory creation with ZFS options
    if (create_home) {
      if (force_zfs) {
        command += ` -m -z`;
      } else if (prevent_zfs) {
        command += ` -m -Z`;
      } else {
        command += ` -m`; // Let system decide based on MANAGE_ZFS setting
      }

      // Add skeleton directory
      if (skeleton_dir) {
        command += ` -k "${skeleton_dir}"`;
      }
    }

    // Add expiration date
    if (expire_date) {
      command += ` -e "${expire_date}"`;
    }

    // Add inactive days
    if (inactive_days) {
      command += ` -f ${inactive_days}`;
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

    // Add RBAC roles
    if (roles && roles.length > 0) {
      command += ` -R "${roles.join(',')}"`;
    }

    // Add username
    command += ` ${username}`;

    log.task.debug('Executing user creation command', { command });

    // Execute user creation
    const result = await executeCommand(command);

    if (
      result.success ||
      (result.stderr &&
        result.stderr.includes('name too long') &&
        !result.stderr.includes('ERROR:'))
    ) {
      // Handle success or success with warnings
      if (result.stderr && result.stderr.includes('name too long')) {
        warnings.push(`Username '${username}' is longer than traditional 8-character limit`);
      }

      log.task.info('User created successfully', {
        username,
        uid: uid || 'auto-assigned',
        personal_group_created: !!createdGroup,
        warnings: warnings.length,
      });

      const message = `User ${username} created successfully${createdGroup ? ` with personal group '${createdGroup}'` : ''}${warnings.length > 0 ? ' (with warnings)' : ''}`;

      return {
        success: true,
        message,
        warnings: warnings.length > 0 ? warnings : undefined,
        created_group: createdGroup,
        system_output: result.output,
      };
    }
    log.task.error('User creation command failed', {
      username,
      error: result.error,
      created_group: createdGroup,
    });

    // If we created a group but user creation failed, clean up the group
    if (createdGroup) {
      log.task.debug('Cleaning up created group due to user creation failure');
      await executeCommand(`pfexec groupdel ${createdGroup}`);
    }

    return {
      success: false,
      error: `Failed to create user ${username}: ${result.error}`,
      group_cleanup_performed: !!createdGroup,
    };
  } catch (error) {
    log.task.error('User creation task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User creation task failed: ${error.message}` };
  }
};

/**
 * Execute user modification task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserModifyTask = async metadataJson => {
  log.task.debug('User modification task starting');

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
      username,
      new_username,
      new_uid,
      new_gid,
      new_groups = [],
      new_comment,
      new_home_directory,
      move_home = false,
      new_shell,
      new_expire_date,
      new_inactive_days,
      new_authorizations = [],
      new_profiles = [],
      new_roles = [],
      new_project,
      force_zfs = false,
      prevent_zfs = false,
    } = metadata;

    log.task.debug('User modification task parameters', {
      username,
      new_username,
      new_uid,
      move_home,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0 || new_roles.length > 0,
    });

    // Build usermod command
    let command = `pfexec usermod`;

    // Add new UID
    if (new_uid) {
      command += ` -u ${new_uid}`;
    }

    // Add new primary group
    if (new_gid) {
      command += ` -g ${new_gid}`;
    }

    // Add new supplementary groups
    if (new_groups && new_groups.length > 0) {
      command += ` -G ${new_groups.join(',')}`;
    }

    // Add new comment
    if (new_comment !== undefined) {
      command += ` -c "${new_comment}"`;
    }

    // Add new home directory with move option
    if (new_home_directory) {
      command += ` -d "${new_home_directory}"`;

      if (move_home) {
        if (force_zfs) {
          command += ` -m -z`;
        } else if (prevent_zfs) {
          command += ` -m -Z`;
        } else {
          command += ` -m`;
        }
      }
    }

    // Add new shell
    if (new_shell) {
      command += ` -s "${new_shell}"`;
    }

    // Add new expiration date
    if (new_expire_date !== undefined) {
      command += ` -e "${new_expire_date}"`;
    }

    // Add new inactive days
    if (new_inactive_days !== undefined) {
      command += ` -f ${new_inactive_days}`;
    }

    // Add new project
    if (new_project) {
      command += ` -p "${new_project}"`;
    }

    // Add new RBAC authorizations
    if (new_authorizations && new_authorizations.length > 0) {
      command += ` -A "${new_authorizations.join(',')}"`;
    }

    // Add new RBAC profiles
    if (new_profiles && new_profiles.length > 0) {
      command += ` -P "${new_profiles.join(',')}"`;
    }

    // Add new RBAC roles
    if (new_roles && new_roles.length > 0) {
      command += ` -R "${new_roles.join(',')}"`;
    }

    // Add new username (must be last for usermod -l)
    if (new_username) {
      command += ` -l ${new_username}`;
    }

    // Add current username
    command += ` ${username}`;

    log.task.debug('Executing user modification command', { command });

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
          `Username '${new_username || username}' is longer than traditional 8-character limit`
        );
      }

      log.task.info('User modified successfully', {
        username,
        new_username: new_username || username,
        move_home,
        warnings: warnings.length,
      });

      return {
        success: true,
        message: `User ${username}${new_username ? ` renamed to ${new_username}` : ''} modified successfully${warnings.length > 0 ? ' (with warnings)' : ''}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        final_username: new_username || username,
      };
    }
    log.task.error('User modification command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to modify user ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User modification task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User modification task failed: ${error.message}` };
  }
};

/**
 * Execute user deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserDeleteTask = async metadataJson => {
  log.task.debug('User deletion task starting');

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

    const { username, remove_home = false, delete_personal_group = false } = metadata;

    log.task.debug('User deletion task parameters', {
      username,
      remove_home,
      delete_personal_group,
    });

    // Build userdel command
    let command = `pfexec userdel`;

    if (remove_home) {
      command += ` -r`;
    }

    command += ` ${username}`;

    log.task.debug('Executing user deletion command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      let groupDeleted = false;

      // Step 2: Delete personal group if requested and it exists
      if (delete_personal_group) {
        log.task.debug('Attempting to delete personal group', { groupname: username });

        const groupDelResult = await executeCommand(`pfexec groupdel ${username}`);

        if (groupDelResult.success) {
          groupDeleted = true;
          log.task.info('Personal group deleted', { groupname: username });
        } else {
          log.task.debug('Personal group deletion failed (may not exist)', {
            groupname: username,
            error: groupDelResult.error,
          });
        }
      }

      log.task.info('User deleted successfully', {
        username,
        home_removed: remove_home,
        group_deleted: groupDeleted,
      });

      return {
        success: true,
        message: `User ${username} deleted successfully${remove_home ? ' (home directory removed)' : ''}${groupDeleted ? ` (personal group '${username}' also deleted)` : ''}`,
        home_removed: remove_home,
        group_deleted: groupDeleted,
      };
    }
    log.task.error('User deletion command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to delete user ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User deletion task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User deletion task failed: ${error.message}` };
  }
};

/**
 * Execute user password setting task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserSetPasswordTask = async metadataJson => {
  log.task.debug('User password setting task starting');

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

    const { username, password, force_change = false, unlock_account = true } = metadata;

    log.task.debug('User password setting task parameters', {
      username,
      force_change,
      unlock_account,
      password_length: password ? password.length : 0,
    });

    // Set password using passwd command with echo
    const command = `echo "${password}" | pfexec passwd --stdin ${username}`;
    log.task.debug('Executing password setting command', {
      command: command.replace(password, '[REDACTED]'),
    });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('Password set successfully', {
        username,
        force_change,
        unlock_account,
      });

      // Force password change on next login if requested
      if (force_change) {
        const expireResult = await executeCommand(`pfexec passwd -f ${username}`);
        if (!expireResult.success) {
          log.task.warn('Password set but failed to force change on next login', {
            username,
            error: expireResult.error,
          });
        }
      }

      // Unlock account if requested (passwords are typically set for locked accounts)
      if (unlock_account) {
        const unlockResult = await executeCommand(`pfexec passwd -u ${username}`);
        if (!unlockResult.success) {
          log.task.warn('Password set but failed to unlock account', {
            username,
            error: unlockResult.error,
          });
        }
      }

      return {
        success: true,
        message: `Password set successfully for user ${username}${force_change ? ' (must change on next login)' : ''}${unlock_account ? ' (account unlocked)' : ''}`,
        force_change,
        unlock_account,
      };
    }
    log.task.error('Password setting command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to set password for user ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User password setting task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User password setting task failed: ${error.message}` };
  }
};

/**
 * Execute user account lock task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserLockTask = async metadataJson => {
  log.task.debug('User account lock task starting');

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

    const { username } = metadata;

    log.task.debug('User account lock task parameters', {
      username,
    });

    const command = `pfexec passwd -l ${username}`;

    log.task.debug('Executing user account lock command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('User account locked successfully', {
        username,
      });

      return {
        success: true,
        message: `User account ${username} locked successfully`,
      };
    }
    log.task.error('User account lock command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to lock user account ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User account lock task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User account lock task failed: ${error.message}` };
  }
};

/**
 * Execute user account unlock task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserUnlockTask = async metadataJson => {
  log.task.debug('User account unlock task starting');

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

    const { username } = metadata;

    log.task.debug('User account unlock task parameters', {
      username,
    });

    const command = `pfexec passwd -u ${username}`;

    log.task.debug('Executing user account unlock command', { command });

    const result = await executeCommand(command);

    if (result.success) {
      log.task.info('User account unlocked successfully', {
        username,
      });

      return {
        success: true,
        message: `User account ${username} unlocked successfully`,
      };
    }
    log.task.error('User account unlock command failed', {
      username,
      error: result.error,
    });

    return {
      success: false,
      error: `Failed to unlock user account ${username}: ${result.error}`,
    };
  } catch (error) {
    log.task.error('User account unlock task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `User account unlock task failed: ${error.message}` };
  }
};
