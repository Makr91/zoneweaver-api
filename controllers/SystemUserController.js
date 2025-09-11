/**
 * @fileoverview System User Management Controller for Zoneweaver API
 * @description Comprehensive user, group, and role management with RBAC support
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { spawn } from 'child_process';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import os from 'os';
import { log } from '../lib/Logger.js';

/**
 * Execute command safely with advanced error handling and timeout
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string, stderr?: string}>}
 */
const executeCommand = async (command, timeout = 30000) => {
  return new Promise(resolve => {
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
          stderr: stderr,
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
            stderr: stderr.trim(),
          });
        } else {
          resolve({
            success: false,
            error: stderr.trim() || `Command exited with code ${code}`,
            output: stdout.trim(),
            stderr: stderr.trim(),
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
          stderr: stderr,
        });
      }
    });
  });
};

/**
 * Parse system command errors and map to appropriate HTTP status codes
 * @param {string} stderr - Command stderr output
 * @param {number} exitCode - Command exit code
 * @returns {Object} Parsed error information
 */
const parseCommandError = (stderr, exitCode) => {
  if (exitCode === 0) return { success: true };

  const errorLine = stderr.split('\n').find(line => line.includes('ERROR:'));
  const warningLine = stderr.split('\n').find(line => line.includes('WARNING:'));

  // Handle duplicate resource errors
  if (errorLine?.includes('is already in use')) {
    return {
      httpStatus: 409, // Conflict
      message: errorLine.replace(/UX: \w+: ERROR: /, ''),
      type: 'duplicate_resource',
      isError: true,
    };
  }

  // Handle resource not found errors
  if (errorLine?.includes('does not exist')) {
    return {
      httpStatus: 404, // Not Found
      message: errorLine.replace(/UX: \w+: ERROR: /, ''),
      type: 'resource_not_found',
      isError: true,
    };
  }

  // Handle validation errors (bad group, invalid parameters, etc.)
  if (errorLine?.includes('does not exist') || errorLine?.includes('Choose another')) {
    return {
      httpStatus: 400, // Bad Request
      message: errorLine.replace(/UX: \w+: ERROR: /, ''),
      type: 'validation_error',
      isError: true,
    };
  }

  // Handle warnings (like name too long)
  if (warningLine && !errorLine) {
    return {
      httpStatus: 200, // Success with warning
      message: warningLine.replace(/UX: \w+: /, ''),
      type: 'warning',
      isError: false,
    };
  }

  // Generic error
  return {
    httpStatus: 500,
    message: errorLine || stderr,
    type: 'system_error',
    isError: true,
  };
};

/**
 * Validate username format according to OmniOS rules
 * @param {string} username - Username to validate
 * @returns {Object} Validation result
 */
const validateUsername = username => {
  if (!username || typeof username !== 'string') {
    return { valid: false, message: 'Username is required and must be a string' };
  }

  // OmniOS username rules: start with letter or underscore, followed by letters, numbers, underscore, hyphen
  const usernameRegex = /^[a-z_][a-z0-9_-]*$/;
  if (!usernameRegex.test(username)) {
    return {
      valid: false,
      message: 'Username must start with a letter or underscore, and contain only lowercase letters, numbers, underscores, and hyphens',
    };
  }

  return { valid: true };
};

/**
 * Validate UID according to OmniOS ranges
 * @param {number} uid - UID to validate
 * @returns {Object} Validation result
 */
const validateUID = uid => {
  if (uid === undefined || uid === null) {
    return { valid: true }; // Optional parameter
  }

  const uidNum = parseInt(uid);
  if (isNaN(uidNum)) {
    return { valid: false, message: 'UID must be a number' };
  }

  if (uidNum < 0 || uidNum > 2147483647) {
    return { valid: false, message: 'UID must be between 0 and 2147483647' };
  }

  if (uidNum >= 0 && uidNum <= 99) {
    return {
      valid: true,
      warning: `UID ${uidNum} is in the system reserved range (0-99)`,
    };
  }

  return { valid: true };
};

/**
 * Validate group name format
 * @param {string} groupname - Group name to validate
 * @returns {Object} Validation result
 */
const validateGroupName = groupname => {
  if (!groupname || typeof groupname !== 'string') {
    return { valid: false, message: 'Group name is required and must be a string' };
  }

  // Similar rules to username but allow uppercase
  const groupRegex = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
  if (!groupRegex.test(groupname)) {
    return {
      valid: false,
      message: 'Group name must start with a letter or underscore, and contain only letters, numbers, underscores, and hyphens',
    };
  }

  return { valid: true };
};

/**
 * @swagger
 * tags:
 *   name: System Users
 *   description: System user and group management information
 */

/**
 * @swagger
 * /system/user-info:
 *   get:
 *     summary: Get current API user information
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current user information retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 current_user:
 *                   type: string
 *                   description: Current username
 *                   example: "zoneapi"
 *                 uid:
 *                   type: integer
 *                   description: Current user ID
 *                   example: 1001
 *                 gid:
 *                   type: integer
 *                   description: Current group ID
 *                   example: 1001
 *                 home_directory:
 *                   type: string
 *                   description: Home directory path
 *                   example: "/opt/zoneweaver-api"
 *                 shell:
 *                   type: string
 *                   description: Default shell
 *                   example: "/bin/bash"
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: string
 *                   description: Groups the user belongs to
 *                   example: ["zoneapi", "staff", "sys"]
 *       500:
 *         description: Failed to get user information
 */
export const getCurrentUserInfo = async (req, res) => {
  try {
    // Get current user info
    const currentUser = os.userInfo();

    // Get additional user details from system
    const passwdResult = await executeCommand(`getent passwd ${currentUser.username}`);
    let homeDirectory = currentUser.homedir;
    let shell = currentUser.shell || '/bin/bash';

    if (passwdResult.success) {
      const passwdFields = passwdResult.output.split(':');
      if (passwdFields.length >= 7) {
        homeDirectory = passwdFields[5] || homeDirectory;
        shell = passwdFields[6] || shell;
      }
    }

    // Get user groups
    const groupsResult = await executeCommand(`groups ${currentUser.username}`);
    let groups = [];

    if (groupsResult.success) {
      // Parse groups output: "username : group1 group2 group3"
      const groupsLine = groupsResult.output;
      const colonIndex = groupsLine.indexOf(':');
      if (colonIndex !== -1) {
        groups = groupsLine
          .substring(colonIndex + 1)
          .trim()
          .split(/\s+/);
      }
    }

    res.json({
      current_user: currentUser.username,
      uid: currentUser.uid,
      gid: currentUser.gid,
      home_directory: homeDirectory,
      shell,
      groups,
      hostname: os.hostname(),
    });
  } catch (error) {
    log.api.error('Error getting current user info', {
      error: error.message,
      stack: error.stack,
      username: os.userInfo().username,
    });
    res.status(500).json({
      error: 'Failed to get current user information',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/users:
 *   get:
 *     summary: List system users
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: include_system
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include system users (uid < 1000)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of users to return
 *     responses:
 *       200:
 *         description: System users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       username:
 *                         type: string
 *                       uid:
 *                         type: integer
 *                       gid:
 *                         type: integer
 *                       home:
 *                         type: string
 *                       shell:
 *                         type: string
 *                       comment:
 *                         type: string
 *                 total_users:
 *                   type: integer
 *       500:
 *         description: Failed to get users
 */
export const getSystemUsers = async (req, res) => {
  try {
    const { include_system = false, limit = 50 } = req.query;

    // Get all users from passwd database
    const passwdResult = await executeCommand('getent passwd');

    if (!passwdResult.success) {
      throw new Error(`Failed to get passwd database: ${passwdResult.error}`);
    }

    const users = [];
    const lines = passwdResult.output.split('\n');

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const fields = line.split(':');
      if (fields.length < 7) {
        continue;
      }

      const user = {
        username: fields[0],
        uid: parseInt(fields[2]),
        gid: parseInt(fields[3]),
        comment: fields[4] || '',
        home: fields[5] || '',
        shell: fields[6] || '',
      };

      // No filtering by default - return all users unless explicitly excluded
      // Only skip if include_system is explicitly set to false AND it's a very low UID
      if (include_system === 'false' && user.uid < 10) {
        // Only filter out daemon, bin, sys (UIDs 1-9) if explicitly requested
        continue;
      }

      users.push(user);

      // Respect limit
      if (users.length >= parseInt(limit)) {
        break;
      }
    }

    // Sort by username
    users.sort((a, b) => a.username.localeCompare(b.username));

    res.json({
      users,
      total_users: users.length,
      include_system: include_system === 'true' || include_system === true,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting system users', {
      error: error.message,
      stack: error.stack,
      include_system,
      limit,
    });
    res.status(500).json({
      error: 'Failed to get system users',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/groups:
 *   get:
 *     summary: List system groups
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: include_system
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include system groups (gid < 1000)
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of groups to return
 *     responses:
 *       200:
 *         description: System groups retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 groups:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       groupname:
 *                         type: string
 *                       gid:
 *                         type: integer
 *                       members:
 *                         type: array
 *                         items:
 *                           type: string
 *                 total_groups:
 *                   type: integer
 *       500:
 *         description: Failed to get groups
 */
export const getSystemGroups = async (req, res) => {
  try {
    const { include_system = false, limit = 50 } = req.query;

    // Get all groups from group database
    const groupResult = await executeCommand('getent group');

    if (!groupResult.success) {
      throw new Error(`Failed to get group database: ${groupResult.error}`);
    }

    const groups = [];
    const lines = groupResult.output.split('\n');

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      const fields = line.split(':');
      if (fields.length < 4) {
        continue;
      }

      const group = {
        groupname: fields[0],
        gid: parseInt(fields[2]),
        members: fields[3] ? fields[3].split(',').filter(m => m.trim()) : [],
      };

      // No filtering by default - return all groups unless explicitly excluded
      if (include_system === 'false' && group.gid < 10) {
        // Only filter out very low system GIDs if explicitly requested
        continue;
      }

      groups.push(group);

      // Respect limit
      if (groups.length >= parseInt(limit)) {
        break;
      }
    }

    // Sort by group name
    groups.sort((a, b) => a.groupname.localeCompare(b.groupname));

    res.json({
      groups,
      total_groups: groups.length,
      include_system: include_system === 'true' || include_system === true,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting system groups', {
      error: error.message,
      stack: error.stack,
      include_system,
      limit,
    });
    res.status(500).json({
      error: 'Failed to get system groups',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/user-lookup:
 *   get:
 *     summary: Lookup user by UID or username
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: uid
 *         schema:
 *           type: integer
 *         description: User ID to lookup
 *         example: 1000
 *       - in: query
 *         name: username
 *         schema:
 *           type: string
 *         description: Username to lookup
 *         example: "mvcs"
 *     responses:
 *       200:
 *         description: User information retrieved successfully
 *       404:
 *         description: User not found
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to lookup user
 */
export const lookupUser = async (req, res) => {
  try {
    const { uid, username } = req.query;

    if (!uid && !username) {
      return res.status(400).json({
        error: 'Either uid or username parameter is required',
      });
    }

    let command = 'getent passwd';
    if (uid) {
      command += ` ${uid}`;
    } else {
      command += ` ${username}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(404).json({
        error: uid ? `User with UID ${uid} not found` : `User '${username}' not found`,
      });
    }

    const fields = result.output.split(':');
    if (fields.length < 7) {
      throw new Error('Invalid passwd entry format');
    }

    const userInfo = {
      username: fields[0],
      uid: parseInt(fields[2]),
      gid: parseInt(fields[3]),
      comment: fields[4] || '',
      home: fields[5] || '',
      shell: fields[6] || '',
    };

    res.json(userInfo);
  } catch (error) {
    log.api.error('Error looking up user', {
      error: error.message,
      stack: error.stack,
      uid,
      username,
    });
    res.status(500).json({
      error: 'Failed to lookup user',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/group-lookup:
 *   get:
 *     summary: Lookup group by GID or group name
 *     tags: [System Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: gid
 *         schema:
 *           type: integer
 *         description: Group ID to lookup
 *         example: 1000
 *       - in: query
 *         name: groupname
 *         schema:
 *           type: string
 *         description: Group name to lookup
 *         example: "staff"
 *     responses:
 *       200:
 *         description: Group information retrieved successfully
 *       404:
 *         description: Group not found
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to lookup group
 */
export const lookupGroup = async (req, res) => {
  try {
    const { gid, groupname } = req.query;

    if (!gid && !groupname) {
      return res.status(400).json({
        error: 'Either gid or groupname parameter is required',
      });
    }

    let command = 'getent group';
    if (gid) {
      command += ` ${gid}`;
    } else {
      command += ` ${groupname}`;
    }

    const result = await executeCommand(command);

    if (!result.success) {
      return res.status(404).json({
        error: gid ? `Group with GID ${gid} not found` : `Group '${groupname}' not found`,
      });
    }

    const fields = result.output.split(':');
    if (fields.length < 4) {
      throw new Error('Invalid group entry format');
    }

    const groupInfo = {
      groupname: fields[0],
      gid: parseInt(fields[2]),
      members: fields[3] ? fields[3].split(',').filter(m => m.trim()) : [],
    };

    res.json(groupInfo);
  } catch (error) {
    log.api.error('Error looking up group', {
      error: error.message,
      stack: error.stack,
      gid,
      groupname,
    });
    res.status(500).json({
      error: 'Failed to lookup group',
      details: error.message,
    });
  }
};

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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 username:
 *                   type: string
 *                 uid:
 *                   type: integer
 *                 create_personal_group:
 *                   type: boolean
 *       400:
 *         description: Invalid request parameters
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                 details:
 *                   type: string
 *                 validation_errors:
 *                   type: array
 *                   items:
 *                     type: string
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
      return res.status(400).json({
        error: 'username is required',
      });
    }

    // Validate username format
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) {
      return res.status(400).json({
        error: 'Invalid username format',
        details: usernameValidation.message,
      });
    }

    // Validate UID if provided
    const uidValidation = validateUID(uid);
    if (!uidValidation.valid) {
      return res.status(400).json({
        error: 'Invalid UID',
        details: uidValidation.message,
      });
    }

    // Validate that ZFS options are not conflicting
    if (force_zfs && prevent_zfs) {
      return res.status(400).json({
        error: 'Cannot specify both force_zfs and prevent_zfs',
      });
    }

    // Validate groups array format
    if (groups && !Array.isArray(groups)) {
      return res.status(400).json({
        error: 'groups must be an array',
      });
    }

    // Validate RBAC arrays
    for (const [field, value] of [
      ['authorizations', authorizations],
      ['profiles', profiles],
      ['roles', roles],
    ]) {
      if (value && !Array.isArray(value)) {
        return res.status(400).json({
          error: `${field} must be an array`,
        });
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

    // Create task for user creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'user_create',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
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
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('User creation task created', {
      task_id: task.id,
      username,
      uid,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `User creation task created for ${username}`,
      task_id: task.id,
      username,
      uid: uid || null,
      create_personal_group,
      warnings: uidValidation.warning ? [uidValidation.warning] : undefined,
    });
  } catch (error) {
    log.api.error('Error creating user task', {
      error: error.message,
      stack: error.stack,
      username,
      uid,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create user creation task',
      details: error.message,
    });
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
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 username:
 *                   type: string
 *                 remove_home:
 *                   type: boolean
 *                 delete_personal_group:
 *                   type: boolean
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to create user deletion task
 */
export const deleteSystemUser = async (req, res) => {
  try {
    const { username } = req.params;
    const {
      remove_home = false,
      delete_personal_group = false,
      created_by = 'api',
    } = req.query;

    log.api.info('User deletion request received', {
      username,
      remove_home: remove_home === 'true' || remove_home === true,
      delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
      created_by,
    });

    // Create task for user deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'user_delete',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            username,
            remove_home: remove_home === 'true' || remove_home === true,
            delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('User deletion task created', {
      task_id: task.id,
      username,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `User deletion task created for ${username}`,
      task_id: task.id,
      username,
      remove_home: remove_home === 'true' || remove_home === true,
      delete_personal_group: delete_personal_group === 'true' || delete_personal_group === true,
    });
  } catch (error) {
    log.api.error('Error creating user deletion task', {
      error: error.message,
      stack: error.stack,
      username,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create user deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/groups:
 *   post:
 *     summary: Create new system group
 *     description: Creates a new group using the groupadd command
 *     tags: [Group Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - groupname
 *             properties:
 *               groupname:
 *                 type: string
 *                 pattern: '^[a-zA-Z_][a-zA-Z0-9_-]*$'
 *                 description: Group name (must follow OmniOS naming rules)
 *                 example: "webadmins"
 *               gid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: Group ID (100+ recommended for regular groups)
 *                 example: 1001
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this group
 *     responses:
 *       202:
 *         description: Group creation task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 groupname:
 *                   type: string
 *                 gid:
 *                   type: integer
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create group task
 */
export const createSystemGroup = async (req, res) => {
  try {
    const { groupname, gid, created_by = 'api' } = req.body;

    // Validate required parameters
    if (!groupname) {
      return res.status(400).json({
        error: 'groupname is required',
      });
    }

    // Validate group name format
    const groupValidation = validateGroupName(groupname);
    if (!groupValidation.valid) {
      return res.status(400).json({
        error: 'Invalid group name format',
        details: groupValidation.message,
      });
    }

    // Validate GID if provided
    const gidValidation = validateUID(gid); // Same validation as UID
    if (!gidValidation.valid) {
      return res.status(400).json({
        error: 'Invalid GID',
        details: gidValidation.message,
      });
    }

    log.api.info('Group creation request received', {
      groupname,
      gid,
      created_by,
    });

    // Create task for group creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'group_create',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            groupname,
            gid,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Group creation task created', {
      task_id: task.id,
      groupname,
      gid,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Group creation task created for ${groupname}`,
      task_id: task.id,
      groupname,
      gid: gid || null,
      warnings: gidValidation.warning ? [gidValidation.warning] : undefined,
    });
  } catch (error) {
    log.api.error('Error creating group task', {
      error: error.message,
      stack: error.stack,
      groupname,
      gid,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create group creation task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/groups/{groupname}:
 *   delete:
 *     summary: Delete system group
 *     description: Deletes a group using the groupdel command
 *     tags: [Group Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: groupname
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name to delete
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User performing this deletion
 *     responses:
 *       202:
 *         description: Group deletion task created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 task_id:
 *                   type: string
 *                   format: uuid
 *                 groupname:
 *                   type: string
 *       500:
 *         description: Failed to create group deletion task
 */
export const deleteSystemGroup = async (req, res) => {
  try {
    const { groupname } = req.params;
    const { created_by = 'api' } = req.query;

    log.api.info('Group deletion request received', {
      groupname,
      created_by,
    });

    // Create task for group deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'group_delete',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            groupname,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Group deletion task created', {
      task_id: task.id,
      groupname,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Group deletion task created for ${groupname}`,
      task_id: task.id,
      groupname,
    });
  } catch (error) {
    log.api.error('Error creating group deletion task', {
      error: error.message,
      stack: error.stack,
      groupname,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create group deletion task',
      details: error.message,
    });
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
        return res.status(400).json({
          error: 'Invalid new username format',
          details: usernameValidation.message,
        });
      }
    }

    // Validate new UID if provided
    if (new_uid) {
      const uidValidation = validateUID(new_uid);
      if (!uidValidation.valid) {
        return res.status(400).json({
          error: 'Invalid new UID',
          details: uidValidation.message,
        });
      }
    }

    // Validate that ZFS options are not conflicting
    if (force_zfs && prevent_zfs) {
      return res.status(400).json({
        error: 'Cannot specify both force_zfs and prevent_zfs',
      });
    }

    // Validate RBAC arrays
    for (const [field, value] of [
      ['new_authorizations', new_authorizations],
      ['new_profiles', new_profiles],
      ['new_roles', new_roles],
      ['new_groups', new_groups],
    ]) {
      if (value && !Array.isArray(value)) {
        return res.status(400).json({
          error: `${field} must be an array`,
        });
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

    // Create task for user modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'user_modify',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
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
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('User modification task created', {
      task_id: task.id,
      username,
      new_username,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `User modification task created for ${username}`,
      task_id: task.id,
      username,
      new_username: new_username || username,
      modifications: {
        uid_change: !!new_uid,
        username_change: !!new_username,
        home_move: move_home,
        rbac_update: new_authorizations.length > 0 || new_profiles.length > 0 || new_roles.length > 0,
      },
    });
  } catch (error) {
    log.api.error('Error creating user modification task', {
      error: error.message,
      stack: error.stack,
      username,
      new_username,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create user modification task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/groups/{groupname}:
 *   put:
 *     summary: Modify system group
 *     description: Modifies an existing group using the groupmod command
 *     tags: [Group Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: groupname
 *         required: true
 *         schema:
 *           type: string
 *         description: Group name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_groupname:
 *                 type: string
 *                 pattern: '^[a-zA-Z_][a-zA-Z0-9_-]*$'
 *                 description: New group name
 *                 example: "newgroupname"
 *               new_gid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: New Group ID
 *                 example: 1002
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this modification
 *     responses:
 *       202:
 *         description: Group modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create group modification task
 */
export const modifySystemGroup = async (req, res) => {
  try {
    const { groupname } = req.params;
    const { new_groupname, new_gid, created_by = 'api' } = req.body;

    // Validate new group name format if provided
    if (new_groupname) {
      const groupValidation = validateGroupName(new_groupname);
      if (!groupValidation.valid) {
        return res.status(400).json({
          error: 'Invalid new group name format',
          details: groupValidation.message,
        });
      }
    }

    // Validate new GID if provided
    if (new_gid) {
      const gidValidation = validateUID(new_gid);
      if (!gidValidation.valid) {
        return res.status(400).json({
          error: 'Invalid new GID',
          details: gidValidation.message,
        });
      }
    }

    log.api.info('Group modification request received', {
      groupname,
      new_groupname,
      new_gid,
      created_by,
    });

    // Create task for group modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'group_modify',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            groupname,
            new_groupname,
            new_gid,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Group modification task created', {
      task_id: task.id,
      groupname,
      new_groupname,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Group modification task created for ${groupname}`,
      task_id: task.id,
      groupname,
      new_groupname: new_groupname || groupname,
      modifications: {
        gid_change: !!new_gid,
        name_change: !!new_groupname,
      },
    });
  } catch (error) {
    log.api.error('Error creating group modification task', {
      error: error.message,
      stack: error.stack,
      groupname,
      new_groupname,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create group modification task',
      details: error.message,
    });
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
      return res.status(400).json({
        error: 'password is required',
      });
    }

    log.api.info('Password setting request received', {
      username,
      force_change,
      unlock_account,
      created_by,
    });

    // Create task for password setting
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'user_set_password',
      priority: TaskPriority.HIGH, // Password operations are high priority
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            username,
            password,
            force_change,
            unlock_account,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Password setting task created', {
      task_id: task.id,
      username,
      force_change,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Password setting task created for ${username}`,
      task_id: task.id,
      username,
      force_change,
      unlock_account,
    });
  } catch (error) {
    log.api.error('Error creating password setting task', {
      error: error.message,
      stack: error.stack,
      username,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create password setting task',
      details: error.message,
    });
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

    // Create task for account locking
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'user_lock',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            username,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Account locking task created', {
      task_id: task.id,
      username,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Account locking task created for ${username}`,
      task_id: task.id,
      username,
    });
  } catch (error) {
    log.api.error('Error creating account locking task', {
      error: error.message,
      stack: error.stack,
      username,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create account locking task',
      details: error.message,
    });
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

    // Create task for account unlocking
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'user_unlock',
      priority: TaskPriority.HIGH,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            username,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Account unlocking task created', {
      task_id: task.id,
      username,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Account unlocking task created for ${username}`,
      task_id: task.id,
      username,
    });
  } catch (error) {
    log.api.error('Error creating account unlocking task', {
      error: error.message,
      stack: error.stack,
      username,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create account unlocking task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/roles:
 *   get:
 *     summary: List system roles
 *     description: Lists all system roles with their properties and assigned users
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of roles to return
 *     responses:
 *       200:
 *         description: System roles retrieved successfully
 *       500:
 *         description: Failed to get roles
 */
export const getSystemRoles = async (req, res) => {
  try {
    const { limit = 50 } = req.query;

    // Get users with type=role from user_attr
    const userAttrResult = await executeCommand('cat /etc/user_attr');
    if (!userAttrResult.success) {
      throw new Error(`Failed to read user_attr database: ${userAttrResult.error}`);
    }

    const roles = [];
    const lines = userAttrResult.output.split('\n');

    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) {
        continue;
      }

      const fields = line.split(':');
      if (fields.length >= 5) {
        const username = fields[0];
        const attrString = fields[4];

        // Check if this entry has type=role
        if (attrString && attrString.includes('type=role')) {
          // Parse attributes
          const attrs = {};
          const attrPairs = attrString.split(';');
          
          for (const pair of attrPairs) {
            const [key, value] = pair.split('=');
            if (key && value) {
              attrs[key.trim()] = value.trim();
            }
          }

          // Get role info from passwd
          const passwdResult = await executeCommand(`getent passwd ${username}`);
          let roleInfo = { uid: null, gid: null, comment: '', home: '', shell: '' };
          
          if (passwdResult.success) {
            const passwdFields = passwdResult.output.split(':');
            if (passwdFields.length >= 7) {
              roleInfo = {
                uid: parseInt(passwdFields[2]),
                gid: parseInt(passwdFields[3]),
                comment: passwdFields[4] || '',
                home: passwdFields[5] || '',
                shell: passwdFields[6] || '',
              };
            }
          }

          roles.push({
            rolename: username,
            ...roleInfo,
            authorizations: attrs.auths ? attrs.auths.split(',') : [],
            profiles: attrs.profiles ? attrs.profiles.split(',') : [],
            project: attrs.project || null,
          });

          if (roles.length >= parseInt(limit)) {
            break;
          }
        }
      }
    }

    // Sort by role name
    roles.sort((a, b) => a.rolename.localeCompare(b.rolename));

    res.json({
      roles,
      total_roles: roles.length,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting system roles', {
      error: error.message,
      stack: error.stack,
      limit,
    });
    res.status(500).json({
      error: 'Failed to get system roles',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/roles:
 *   post:
 *     summary: Create new system role
 *     description: Creates a new role using the roleadd command with RBAC support
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - rolename
 *             properties:
 *               rolename:
 *                 type: string
 *                 pattern: '^[a-z_][a-z0-9_-]*$'
 *                 description: Role name (must follow OmniOS naming rules)
 *                 example: "backup_admin"
 *               uid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: Role ID (100+ recommended for roles)
 *                 example: 2001
 *               gid:
 *                 type: integer
 *                 description: Primary group ID for role
 *                 example: 100
 *               comment:
 *                 type: string
 *                 description: Role description
 *                 example: "Backup Administration Role"
 *               home_directory:
 *                 type: string
 *                 description: Home directory path for role
 *                 example: "/export/home/backup_admin"
 *               shell:
 *                 type: string
 *                 description: Shell (defaults to /bin/pfsh for roles)
 *                 example: "/bin/pfsh"
 *               create_home:
 *                 type: boolean
 *                 default: false
 *                 description: Create home directory for role
 *               authorizations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: RBAC authorizations for role
 *                 example: ["solaris.admin.dcmgr.*", "solaris.smf.read"]
 *               profiles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: RBAC profiles for role
 *                 example: ["Media Backup", "File System Management"]
 *               project:
 *                 type: string
 *                 description: Associated project name
 *                 example: "backup_services"
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User creating this role
 *     responses:
 *       202:
 *         description: Role creation task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create role task
 */
export const createSystemRole = async (req, res) => {
  try {
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
      created_by = 'api',
    } = req.body;

    // Validate required parameters
    if (!rolename) {
      return res.status(400).json({
        error: 'rolename is required',
      });
    }

    // Validate role name format (same as username)
    const rolenameValidation = validateUsername(rolename);
    if (!rolenameValidation.valid) {
      return res.status(400).json({
        error: 'Invalid role name format',
        details: rolenameValidation.message,
      });
    }

    // Validate UID if provided
    const uidValidation = validateUID(uid);
    if (!uidValidation.valid) {
      return res.status(400).json({
        error: 'Invalid UID',
        details: uidValidation.message,
      });
    }

    // Validate RBAC arrays
    for (const [field, value] of [
      ['authorizations', authorizations],
      ['profiles', profiles],
    ]) {
      if (value && !Array.isArray(value)) {
        return res.status(400).json({
          error: `${field} must be an array`,
        });
      }
    }

    log.api.info('Role creation request received', {
      rolename,
      uid,
      gid,
      created_by,
      has_rbac: authorizations.length > 0 || profiles.length > 0,
    });

    // Create task for role creation
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'role_create',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            rolename,
            uid,
            gid,
            comment,
            home_directory,
            shell,
            create_home,
            authorizations,
            profiles,
            project,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Role creation task created', {
      task_id: task.id,
      rolename,
      uid,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Role creation task created for ${rolename}`,
      task_id: task.id,
      rolename,
      uid: uid || null,
      warnings: uidValidation.warning ? [uidValidation.warning] : undefined,
    });
  } catch (error) {
    log.api.error('Error creating role task', {
      error: error.message,
      stack: error.stack,
      rolename,
      uid,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create role creation task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/roles/{rolename}:
 *   delete:
 *     summary: Delete system role
 *     description: Deletes a role using the roledel command
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: rolename
 *         required: true
 *         schema:
 *           type: string
 *         description: Role name to delete
 *       - in: query
 *         name: remove_home
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Remove role's home directory
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User performing this deletion
 *     responses:
 *       202:
 *         description: Role deletion task created successfully
 *       500:
 *         description: Failed to create role deletion task
 */
export const deleteSystemRole = async (req, res) => {
  try {
    const { rolename } = req.params;
    const { remove_home = false, created_by = 'api' } = req.query;

    log.api.info('Role deletion request received', {
      rolename,
      remove_home: remove_home === 'true' || remove_home === true,
      created_by,
    });

    // Create task for role deletion
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'role_delete',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            rolename,
            remove_home: remove_home === 'true' || remove_home === true,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Role deletion task created', {
      task_id: task.id,
      rolename,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Role deletion task created for ${rolename}`,
      task_id: task.id,
      rolename,
      remove_home: remove_home === 'true' || remove_home === true,
    });
  } catch (error) {
    log.api.error('Error creating role deletion task', {
      error: error.message,
      stack: error.stack,
      rolename,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create role deletion task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/roles/{rolename}:
 *   put:
 *     summary: Modify system role
 *     description: Modifies an existing role using the rolemod command
 *     tags: [Role Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: rolename
 *         required: true
 *         schema:
 *           type: string
 *         description: Role name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               new_rolename:
 *                 type: string
 *                 pattern: '^[a-z_][a-z0-9_-]*$'
 *                 description: New role name
 *                 example: "newrolename"
 *               new_uid:
 *                 type: integer
 *                 minimum: 100
 *                 maximum: 2147483647
 *                 description: New Role ID
 *                 example: 2002
 *               new_gid:
 *                 type: integer
 *                 description: New primary group ID
 *                 example: 100
 *               new_comment:
 *                 type: string
 *                 description: New role description
 *                 example: "Updated Role Description"
 *               new_authorizations:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC authorizations (replaces existing)
 *                 example: ["solaris.admin.dcmgr.*"]
 *               new_profiles:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: New RBAC profiles (replaces existing)
 *                 example: ["System Administrator"]
 *               created_by:
 *                 type: string
 *                 default: "api"
 *                 description: User performing this modification
 *     responses:
 *       202:
 *         description: Role modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create role modification task
 */
export const modifySystemRole = async (req, res) => {
  try {
    const { rolename } = req.params;
    const {
      new_rolename,
      new_uid,
      new_gid,
      new_comment,
      new_authorizations = [],
      new_profiles = [],
      created_by = 'api',
    } = req.body;

    // Validate new role name format if provided
    if (new_rolename) {
      const rolenameValidation = validateUsername(new_rolename);
      if (!rolenameValidation.valid) {
        return res.status(400).json({
          error: 'Invalid new role name format',
          details: rolenameValidation.message,
        });
      }
    }

    // Validate new UID if provided
    if (new_uid) {
      const uidValidation = validateUID(new_uid);
      if (!uidValidation.valid) {
        return res.status(400).json({
          error: 'Invalid new UID',
          details: uidValidation.message,
        });
      }
    }

    // Validate RBAC arrays
    for (const [field, value] of [
      ['new_authorizations', new_authorizations],
      ['new_profiles', new_profiles],
    ]) {
      if (value && !Array.isArray(value)) {
        return res.status(400).json({
          error: `${field} must be an array`,
        });
      }
    }

    log.api.info('Role modification request received', {
      rolename,
      new_rolename,
      new_uid,
      created_by,
      has_rbac: new_authorizations.length > 0 || new_profiles.length > 0,
    });

    // Create task for role modification
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'role_modify',
      priority: TaskPriority.NORMAL,
      created_by,
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            rolename,
            new_rolename,
            new_uid,
            new_gid,
            new_comment,
            new_authorizations,
            new_profiles,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.api.info('Role modification task created', {
      task_id: task.id,
      rolename,
      new_rolename,
      created_by,
    });

    res.status(202).json({
      success: true,
      message: `Role modification task created for ${rolename}`,
      task_id: task.id,
      rolename,
      new_rolename: new_rolename || rolename,
      modifications: {
        uid_change: !!new_uid,
        name_change: !!new_rolename,
        rbac_update: new_authorizations.length > 0 || new_profiles.length > 0,
      },
    });
  } catch (error) {
    log.api.error('Error creating role modification task', {
      error: error.message,
      stack: error.stack,
      rolename,
      new_rolename,
      created_by,
    });
    res.status(500).json({
      error: 'Failed to create role modification task',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/rbac/authorizations:
 *   get:
 *     summary: List available authorizations
 *     description: Lists all available RBAC authorizations from auth_attr database
 *     tags: [RBAC Discovery]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *         description: Filter authorizations by name pattern
 *         example: "solaris.admin"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of authorizations to return
 *     responses:
 *       200:
 *         description: Authorizations retrieved successfully
 *       500:
 *         description: Failed to get authorizations
 */
export const getAvailableAuthorizations = async (req, res) => {
  try {
    const { filter, limit = 100 } = req.query;

    // Get authorizations from auth_attr
    const authAttrResult = await executeCommand('cat /etc/security/auth_attr');
    if (!authAttrResult.success) {
      throw new Error(`Failed to read auth_attr database: ${authAttrResult.error}`);
    }

    const authorizations = [];
    const lines = authAttrResult.output.split('\n');

    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) {
        continue;
      }

      const fields = line.split(':');
      if (fields.length >= 5) {
        const authName = fields[0];
        const shortDesc = fields[3] || '';
        const longDesc = fields[4] || '';

        // Apply filter if provided
        if (filter && !authName.toLowerCase().includes(filter.toLowerCase())) {
          continue;
        }

        // Skip heading entries (those ending with just a dot)
        if (authName.endsWith('.') && !authName.endsWith('..')) {
          continue;
        }

        authorizations.push({
          name: authName,
          short_description: shortDesc,
          long_description: longDesc,
          is_grant: authName.endsWith('.grant'),
          prefix: authName.split('.').slice(0, -1).join('.'),
        });

        if (authorizations.length >= parseInt(limit)) {
          break;
        }
      }
    }

    // Sort by authorization name
    authorizations.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      authorizations,
      total: authorizations.length,
      limit_applied: parseInt(limit),
      filter_applied: filter || null,
    });
  } catch (error) {
    log.api.error('Error getting available authorizations', {
      error: error.message,
      stack: error.stack,
      filter,
      limit,
    });
    res.status(500).json({
      error: 'Failed to get available authorizations',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/rbac/profiles:
 *   get:
 *     summary: List available execution profiles
 *     description: Lists all available RBAC execution profiles from prof_attr database
 *     tags: [RBAC Discovery]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: filter
 *         schema:
 *           type: string
 *         description: Filter profiles by name pattern
 *         example: "admin"
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of profiles to return
 *     responses:
 *       200:
 *         description: Profiles retrieved successfully
 *       500:
 *         description: Failed to get profiles
 */
export const getAvailableProfiles = async (req, res) => {
  try {
    const { filter, limit = 100 } = req.query;

    // Get profiles from prof_attr
    const profAttrResult = await executeCommand('cat /etc/security/prof_attr');
    if (!profAttrResult.success) {
      throw new Error(`Failed to read prof_attr database: ${profAttrResult.error}`);
    }

    const profiles = [];
    const lines = profAttrResult.output.split('\n');

    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) {
        continue;
      }

      const fields = line.split(':');
      if (fields.length >= 5) {
        const profileName = fields[0];
        const description = fields[3] || '';
        const attrString = fields[4] || '';

        // Apply filter if provided
        if (filter && !profileName.toLowerCase().includes(filter.toLowerCase())) {
          continue;
        }

        // Parse profile attributes
        const attrs = {};
        if (attrString) {
          const attrPairs = attrString.split(';');
          for (const pair of attrPairs) {
            const [key, value] = pair.split('=');
            if (key && value) {
              attrs[key.trim()] = value.trim();
            }
          }
        }

        profiles.push({
          name: profileName,
          description,
          help: attrs.help || null,
          nested_profiles: attrs.profiles ? attrs.profiles.split(',') : [],
          authorizations: attrs.auths ? attrs.auths.split(',') : [],
          privileges: attrs.privs ? attrs.privs.split(',') : [],
        });

        if (profiles.length >= parseInt(limit)) {
          break;
        }
      }
    }

    // Sort by profile name
    profiles.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      profiles,
      total: profiles.length,
      limit_applied: parseInt(limit),
      filter_applied: filter || null,
    });
  } catch (error) {
    log.api.error('Error getting available profiles', {
      error: error.message,
      stack: error.stack,
      filter,
      limit,
    });
    res.status(500).json({
      error: 'Failed to get available profiles',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/rbac/roles:
 *   get:
 *     summary: List available roles for assignment
 *     description: Lists roles that can be assigned to users (same as /system/roles but focused on assignment)
 *     tags: [RBAC Discovery]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Available roles retrieved successfully
 *       500:
 *         description: Failed to get available roles
 */
export const getAvailableRoles = async (req, res) => {
  try {
    // Reuse the getSystemRoles logic but return simplified format for assignment
    const { limit = 100 } = req.query;

    const userAttrResult = await executeCommand('cat /etc/user_attr');
    if (!userAttrResult.success) {
      throw new Error(`Failed to read user_attr database: ${userAttrResult.error}`);
    }

    const roles = [];
    const lines = userAttrResult.output.split('\n');

    for (const line of lines) {
      if (!line.trim() || line.startsWith('#')) {
        continue;
      }

      const fields = line.split(':');
      if (fields.length >= 5) {
        const rolename = fields[0];
        const attrString = fields[4];

        if (attrString && attrString.includes('type=role')) {
          // Get role comment from passwd
          const passwdResult = await executeCommand(`getent passwd ${rolename}`);
          let comment = '';
          
          if (passwdResult.success) {
            const passwdFields = passwdResult.output.split(':');
            if (passwdFields.length >= 5) {
              comment = passwdFields[4] || '';
            }
          }

          roles.push({
            name: rolename,
            description: comment,
          });

          if (roles.length >= parseInt(limit)) {
            break;
          }
        }
      }
    }

    // Sort by role name
    roles.sort((a, b) => a.name.localeCompare(b.name));

    res.json({
      roles,
      total: roles.length,
      limit_applied: parseInt(limit),
    });
  } catch (error) {
    log.api.error('Error getting available roles', {
      error: error.message,
      stack: error.stack,
      limit,
    });
    res.status(500).json({
      error: 'Failed to get available roles',
      details: error.message,
    });
  }
};

/**
 * @swagger
 * /system/users/{username}/attributes:
 *   get:
 *     summary: Get user RBAC attributes
 *     description: Get detailed RBAC attributes for a specific user from user_attr database
 *     tags: [User Attributes]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: username
 *         required: true
 *         schema:
 *           type: string
 *         description: Username to get attributes for
 *     responses:
 *       200:
 *         description: User attributes retrieved successfully
 *       404:
 *         description: User not found
 *       500:
 *         description: Failed to get user attributes
 */
export const getUserAttributes = async (req, res) => {
  try {
    const { username } = req.params;

    // Check if user exists first
    const userExists = await executeCommand(`getent passwd ${username}`);
    if (!userExists.success) {
      return res.status(404).json({
        error: `User '${username}' not found`,
      });
    }

    // Get user attributes from user_attr
    const userAttrResult = await executeCommand(`grep "^${username}:" /etc/user_attr`);
    
    let attributes = {
      username,
      type: 'normal',
      authorizations: [],
      profiles: [],
      roles: [],
      project: null,
      default_privileges: null,
      limit_privileges: null,
      lock_after_retries: null,
    };

    if (userAttrResult.success && userAttrResult.output) {
      const fields = userAttrResult.output.split(':');
      if (fields.length >= 5) {
        const attrString = fields[4];
        
        // Parse attributes
        if (attrString) {
          const attrPairs = attrString.split(';');
          for (const pair of attrPairs) {
            const [key, value] = pair.split('=');
            if (key && value) {
              const trimmedKey = key.trim();
              const trimmedValue = value.trim();
              
              switch (trimmedKey) {
                case 'type':
                  attributes.type = trimmedValue;
                  break;
                case 'auths':
                  attributes.authorizations = trimmedValue.split(',').map(a => a.trim());
                  break;
                case 'profiles':
                  attributes.profiles = trimmedValue.split(',').map(p => p.trim());
                  break;
                case 'roles':
                  attributes.roles = trimmedValue.split(',').map(r => r.trim());
                  break;
                case 'project':
                  attributes.project = trimmedValue;
                  break;
                case 'defaultpriv':
                  attributes.default_privileges = trimmedValue.split(',').map(p => p.trim());
                  break;
                case 'limitpriv':
                  attributes.limit_privileges = trimmedValue.split(',').map(p => p.trim());
                  break;
                case 'lock_after_retries':
                  attributes.lock_after_retries = trimmedValue === 'yes';
                  break;
              }
            }
          }
        }
      }
    }

    res.json(attributes);
  } catch (error) {
    log.api.error('Error getting user attributes', {
      error: error.message,
      stack: error.stack,
      username,
    });
    res.status(500).json({
      error: 'Failed to get user attributes',
      details: error.message,
    });
  }
};

export default {
  getCurrentUserInfo,
  getSystemUsers,
  getSystemGroups,
  lookupUser,
  lookupGroup,
  createSystemUser,
  deleteSystemUser,
  modifySystemUser,
  createSystemGroup,
  deleteSystemGroup,
  modifySystemGroup,
  setUserPassword,
  lockUserAccount,
  unlockUserAccount,
  getSystemRoles,
  createSystemRole,
  deleteSystemRole,
  modifySystemRole,
  getAvailableAuthorizations,
  getAvailableProfiles,
  getAvailableRoles,
  getUserAttributes,
};
