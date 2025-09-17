/**
 * @fileoverview User Management Controller for System Account Management
 * @description Handles user creation, modification, deletion, password management, and account locking
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { TaskPriority } from '../../models/TaskModel.js';
import {
  createSystemTask,
  taskCreatedResponse,
  errorResponse,
} from '../SystemHostController/utils/ResponseHelpers.js';
import {
  validateUsername,
  validateUID,
  validateRBACArray,
  validateZFSOptions,
} from './utils/UserValidation.js';
import { log } from '../../lib/Logger.js';

/**
 * @swagger
 * /system/users:
 *   post:
 *     summary: Create new system user
 *     description: Creates a new user account using the useradd command with comprehensive options including RBAC support
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - username
 *             properties:
 *               username:
 *                 type: string
 *                 pattern: '^[a-z_][a-z0-9_-]*$'
 *                 description: Username (must follow OmniOS naming rules)
 *                 example: "webadmin"
 *               uid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: User ID (100+ recommended for regular users)
 *                 example: 1001
 *               gid:
 *                 type: integer
 *                 description: Primary group ID (will create personal group if not specified)
 *                 example: 100
 *               groups:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Supplementary groups
 *                 example: ["staff", "sys"]
 *               comment:
 *                 type: string
 *                 description: Full name or description (GECOS field)
 *                 example: "Web Administrator"
 *               home_directory:
 *                 type: string
 *                 description: Home directory path (defaults to /export/home/username)
 *                 example: "/export/home/webadmin"
 *               shell:
 *                 type: string
 *                 description: Login shell (defaults to /bin/bash)
 *                 example: "/bin/bash"
 *               create_home:
 *                 type: boolean
 *                 default: true
 *                 description: Create home directory (with ZFS dataset if available)
 *               skeleton_dir:
 *                 type: string
 *                 description: Skeleton directory for home directory creation
 *                 example: "/etc/skel"
 *               expire_date:
 *                 type: string
 *                 format: date
 *                 description: Account expiration date (YYYY-MM-DD format)
 *                 example: "2024-12-31"
 *               inactive_days:
 *                 type: integer
 *                 description: Days after password expiry before account is disabled
 *                 example: 30
 *               authorizations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: OmniOS RBAC authorizations (supports wildcards)
 *                 example: ["solaris.admin.usermgr.read", "solaris.network.*"]
 *               profiles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: OmniOS RBAC execution profiles
 *                 example: ["Basic Solaris User", "Network Management"]
 *               roles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: OmniOS RBAC roles user can assume
 *                 example: ["operator", "backup_admin"]
 *               project:
 *                 type: string
 *                 description: Associated project name
 *                 example: "webservers"
 *               create_personal_group:
 *                 type: boolean
 *                 default: true
 *                 description: Create a personal group with same name as user
 *               force_zfs:
 *                 type: boolean
 *                 default: false
 *                 description: Force creation of ZFS dataset for home directory
 *               prevent_zfs:
 *                 type: boolean
 *                 default: false
 *                 description: Prevent creation of ZFS dataset for home directory
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this account
 *     responses:
 *       202:
 *         description: User creation task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create user task
 */
export const createSystemUser = async (req, res) => {
  try {
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
      created_by = 'api',
    } = req.body;

    // Validate required parameters
    if (!username) {
      return errorResponse(res, 400, 'username is required');
    }

    // Validate username format
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return errorResponse(res, 400, 'Invalid username format', usernameValidation.message);
    }

    // Validate UID if provided
    const uidValidation = validateUID(uid);
    if (!uidValidation.valid) {
      return errorResponse(res, 400, 'Invalid UID', uidValidation.message);
    }

    // Validate ZFS options
    const zfsValidation = validateZFSOptions(force_zfs, prevent_zfs);
    if (!zfsValidation.valid) {
      return errorResponse(res, 400, zfsValidation.message);
    }

    // Validate arrays
    const validations = [
      validateRBACArray('groups', groups),
      validateRBACArray('authorizations', authorizations),
      validateRBACArray('profiles', profiles),
      validateRBACArray('roles', roles),
    ];

    for (const validation of validations) {
      if (!validation.valid) {
        return errorResponse(res, 400, validation.message);
      }
    }

    log.api.info('User creation request received', {
      username,
      uid,
      gid,
      create_personal_group,
      created_by,
      has_rbac: authorizations.length > 0 || profiles.length > 0 || roles.length > 0,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'user_create',
      {
        username,
        uid,
        gid,
        groups,
        comment,
        home_directory,
        shell,
        create_home,
        skeleton_dir,
        expire_date,
        inactive_days,
        authorizations,
        profiles,
        roles,
        project,
        create_personal_group,
        force_zfs,
        prevent_zfs,
      },
      created_by,
      TaskPriority.MEDIUM
    );

    log.api.info('User creation task created', {
      task_id: task.id,
      username,
      uid,
      created_by,
    });

    return taskCreatedResponse(res, `User creation task created for ${username}`, task, {
      username,
      uid: uid || null,
      create_personal_group,
      warnings: uidValidation.warning ? [uidValidation.warning] : undefined,
    });
  } catch (error) {
    log.api.error('Error creating user task', {
      error: error.message,
      stack: error.stack,
      username: req.body?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create user creation task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}:
 *   delete:
 *     summary: Delete system user
 *     description: Deletes a user account using the userdel command with optional home directory removal
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to delete
 *       - in: query
 *         name: remove_home
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Remove user's home directory and mail spool
 *       - in: query
 *         name: delete_personal_group
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Also delete personal group if it exists
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User performing this deletion
 *     responses:
 *       202:
 *         description: User deletion task created successfully
 *       500:
 *         description: Failed to create user deletion task
 */
export const deleteSystemUser = async (req, res) => {
  try {
    const { username } = req.params;
    const { remove_home = false, delete_personal_group = false, created_by = 'api' } = req.query;

    log.api.info('User deletion request received', {
      username,
      remove_home: remove_home === 'true' || remove_home === true,
      delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'user_delete',
      {
        username,
        remove_home: remove_home === 'true' || remove_home === true,
        delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
      },
      created_by,
      TaskPriority.CRITICAL // User deletion is critical priority
    );

    log.api.info('User deletion task created', {
      task_id: task.id,
      username,
      created_by,
    });

    return taskCreatedResponse(res, `User deletion task created for ${username}`, task, {
      username,
      remove_home: remove_home === 'true' || remove_home === true,
      delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
    });
  } catch (error) {
    log.api.error('Error creating user deletion task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.query?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create user deletion task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}:
 *   put:
 *     summary: Modify system user
 *     description: Modifies an existing user account using the usermod command with comprehensive options
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_username:
 *                 type: string
 *                 pattern: '^[a-z_][a-z0-9_-]*$'
 *                 description: New username
 *                 example: "newusername"
 *               new_uid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: New User ID
 *                 example: 1002
 *               new_gid:
 *                 type: integer
 *                 description: New primary group ID
 *                 example: 100
 *               new_groups:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New supplementary groups (replaces existing)
 *                 example: ["staff", "admin"]
 *               new_comment:
 *                 type: string
 *                 description: New user description
 *                 example: "Updated User Description"
 *               new_home_directory:
 *                 type: string
 *                 description: New home directory path
 *                 example: "/export/home/newpath"
 *               move_home:
 *                 type: boolean
 *                 default: false
 *                 description: Move existing home directory to new location
 *               new_shell:
 *                 type: string
 *                 description: New login shell
 *                 example: "/bin/zsh"
 *               new_expire_date:
 *                 type: string
 *                 format: date
 *                 description: New account expiration date
 *                 example: "2025-12-31"
 *               new_inactive_days:
 *                 type: integer
 *                 description: New inactive days setting
 *                 example: 45
 *               new_authorizations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC authorizations (replaces existing)
 *                 example: ["solaris.admin.usermgr.*"]
 *               new_profiles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC profiles (replaces existing)
 *                 example: ["System Administrator"]
 *               new_roles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC roles (replaces existing)
 *                 example: ["admin_role"]
 *               new_project:
 *                 type: string
 *                 description: New project association
 *                 example: "admin_project"
 *               force_zfs:
 *                 type: boolean
 *                 default: false
 *                 description: Force ZFS dataset for new home directory
 *               prevent_zfs:
 *                 type: boolean
 *                 default: false
 *                 description: Prevent ZFS dataset for new home directory
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this modification
 *     responses:
 *       202:
 *         description: User modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create user modification task
 */
export const modifySystemUser = async (req, res) => {
  try {
    const { username } = req.params;
    const {
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
      created_by = 'api',
    } = req.body;

    // Validate new username format if provided
    if (new_username) {
      const usernameValidation = validateUsername(new_username);
      if (!usernameValidation.valid) {
        return errorResponse(res, 400, 'Invalid new username format', usernameValidation.message);
      }
    }

    // Validate new UID if provided
    if (new_uid) {
      const uidValidation = validateUID(new_uid);
      if (!uidValidation.valid) {
        return errorResponse(res, 400, 'Invalid new UID', uidValidation.message);
      }
    }

    // Validate ZFS options
    const zfsValidation = validateZFSOptions(force_zfs, prevent_zfs);
    if (!zfsValidation.valid) {
      return errorResponse(res, 400, zfsValidation.message);
    }

    // Validate RBAC arrays
    const validations = [
      validateRBACArray('new_groups', new_groups),
      validateRBACArray('new_authorizations', new_authorizations),
      validateRBACArray('new_profiles', new_profiles),
      validateRBACArray('new_roles', new_roles),
    ];

    for (const validation of validations) {
      if (!validation.valid) {
        return errorResponse(res, 400, validation.message);
      }
    }

    log.api.info('User modification request received', {
      username,
      new_username,
      new_uid,
      move_home,
      created_by,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0 || new_roles.length > 0,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'user_modify',
      {
        username,
        new_username,
        new_uid,
        new_gid,
        new_groups,
        new_comment,
        new_home_directory,
        move_home,
        new_shell,
        new_expire_date,
        new_inactive_days,
        new_authorizations,
        new_profiles,
        new_roles,
        new_project,
        force_zfs,
        prevent_zfs,
      },
      created_by,
      TaskPriority.MEDIUM
    );

    log.api.info('User modification task created', {
      task_id: task.id,
      username,
      new_username,
      created_by,
    });

    return taskCreatedResponse(res, `User modification task created for ${username}`, task, {
      username,
      new_username: new_username || username,
      modifications: {
        uid_change: !!new_uid,
        username_change: !!new_username,
        home_move: move_home,
        rbac_update:
          new_authorizations.length > 0 || new_profiles.length > 0 || new_roles.length > 0,
      },
    });
  } catch (error) {
    log.api.error('Error creating user modification task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      new_username: req.body?.new_username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create user modification task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}/password:
 *   post:
 *     summary: Set user password
 *     description: Sets or changes a user's password using the passwd command
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to set password for
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               password:
 *                 type: string
 *                 minLength: 1
 *                 description: New password for the user
 *               force_change:
 *                 type: boolean
 *                 default: false
 *                 description: Force password change on next login
 *               unlock_account:
 *                 type: boolean
 *                 default: true
 *                 description: Unlock account after setting password
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this operation
 *     responses:
 *       202:
 *         description: Password setting task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create password setting task
 */
export const setUserPassword = async (req, res) => {
  try {
    const { username } = req.params;
    const { password, force_change = false, unlock_account = true, created_by = 'api' } = req.body;

    if (!password) {
      return errorResponse(res, 400, 'password is required');
    }

    log.api.info('Password setting request received', {
      username,
      force_change,
      unlock_account,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask(
      'user_set_password',
      {
        username,
        password,
        force_change,
        unlock_account,
      },
      created_by,
      TaskPriority.HIGH // Password operations are high priority
    );

    log.api.info('Password setting task created', {
      task_id: task.id,
      username,
      force_change,
      created_by,
    });

    return taskCreatedResponse(res, `Password setting task created for ${username}`, task, {
      username,
      force_change,
      unlock_account,
    });
  } catch (error) {
    log.api.error('Error creating password setting task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create password setting task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}/lock:
 *   post:
 *     summary: Lock user account
 *     description: Locks a user account using passwd -l command
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to lock
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this operation
 *     responses:
 *       202:
 *         description: Account locking task created successfully
 *       500:
 *         description: Failed to create account locking task
 */
export const lockUserAccount = async (req, res) => {
  try {
    const { username } = req.params;
    const { created_by = 'api' } = req.body || {};

    log.api.info('Account locking request received', {
      username,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask('user_lock', { username }, created_by, TaskPriority.HIGH);

    log.api.info('Account locking task created', {
      task_id: task.id,
      username,
      created_by,
    });

    return taskCreatedResponse(res, `Account locking task created for ${username}`, task, {
      username,
    });
  } catch (error) {
    log.api.error('Error creating account locking task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create account locking task', error.message);
  }
};

/**
 * @swagger
 * /system/users/{username}/unlock:
 *   post:
 *     summary: Unlock user account
 *     description: Unlocks a user account using passwd -u command
 *     tags: [User Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to unlock
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this operation
 *     responses:
 *       202:
 *         description: Account unlocking task created successfully
 *       500:
 *         description: Failed to create account unlocking task
 */
export const unlockUserAccount = async (req, res) => {
  try {
    const { username } = req.params;
    const { created_by = 'api' } = req.body || {};

    log.api.info('Account unlocking request received', {
      username,
      created_by,
    });

    // Create task using ResponseHelpers
    const task = await createSystemTask('user_unlock', { username }, created_by, TaskPriority.HIGH);

    log.api.info('Account unlocking task created', {
      task_id: task.id,
      username,
      created_by,
    });

    return taskCreatedResponse(res, `Account unlocking task created for ${username}`, task, {
      username,
    });
  } catch (error) {
    log.api.error('Error creating account unlocking task', {
      error: error.message,
      stack: error.stack,
      username: req.params?.username,
      created_by: req.body?.created_by,
    });
    return errorResponse(res, 500, 'Failed to create account unlocking task', error.message);
  }
};
