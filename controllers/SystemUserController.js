/**
 * @fileoverview System User Management Controller for Zoneweaver API
 * @description Provides user and group information for file browser permission management
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command, timeout = 30000) => {
    try {
        const { stdout, stderr } = await execAsync(command, { 
            timeout,
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });
        
        if (stderr && stderr.trim()) {
            console.warn(`Command stderr: ${stderr.trim()}`);
        }
        
        return { 
            success: true, 
            output: stdout.trim(),
            stderr: stderr.trim() 
        };
    } catch (error) {
        return { 
            success: false, 
            error: error.message,
            output: error.stdout || '',
            stderr: error.stderr || ''
        };
    }
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
                groups = groupsLine.substring(colonIndex + 1).trim().split(/\s+/);
            }
        }

        res.json({
            current_user: currentUser.username,
            uid: currentUser.uid,
            gid: currentUser.gid,
            home_directory: homeDirectory,
            shell: shell,
            groups: groups,
            hostname: os.hostname()
        });

    } catch (error) {
        console.error('Error getting current user info:', error);
        res.status(500).json({ 
            error: 'Failed to get current user information',
            details: error.message 
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
            if (!line.trim()) continue;
            
            const fields = line.split(':');
            if (fields.length < 7) continue;
            
            const user = {
                username: fields[0],
                uid: parseInt(fields[2]),
                gid: parseInt(fields[3]),
                comment: fields[4] || '',
                home: fields[5] || '',
                shell: fields[6] || ''
            };
            
            // Filter system users if requested
            if (!include_system && user.uid < 1000) {
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
            users: users,
            total_users: users.length,
            include_system: include_system === 'true' || include_system === true,
            limit_applied: parseInt(limit)
        });

    } catch (error) {
        console.error('Error getting system users:', error);
        res.status(500).json({ 
            error: 'Failed to get system users',
            details: error.message 
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
            if (!line.trim()) continue;
            
            const fields = line.split(':');
            if (fields.length < 4) continue;
            
            const group = {
                groupname: fields[0],
                gid: parseInt(fields[2]),
                members: fields[3] ? fields[3].split(',').filter(m => m.trim()) : []
            };
            
            // Filter system groups if requested
            if (!include_system && group.gid < 1000) {
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
            groups: groups,
            total_groups: groups.length,
            include_system: include_system === 'true' || include_system === true,
            limit_applied: parseInt(limit)
        });

    } catch (error) {
        console.error('Error getting system groups:', error);
        res.status(500).json({ 
            error: 'Failed to get system groups',
            details: error.message 
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
                error: 'Either uid or username parameter is required'
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
                error: uid ? `User with UID ${uid} not found` : `User '${username}' not found`
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
            shell: fields[6] || ''
        };

        res.json(userInfo);

    } catch (error) {
        console.error('Error looking up user:', error);
        res.status(500).json({ 
            error: 'Failed to lookup user',
            details: error.message 
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
                error: 'Either gid or groupname parameter is required'
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
                error: gid ? `Group with GID ${gid} not found` : `Group '${groupname}' not found`
            });
        }

        const fields = result.output.split(':');
        if (fields.length < 4) {
            throw new Error('Invalid group entry format');
        }

        const groupInfo = {
            groupname: fields[0],
            gid: parseInt(fields[2]),
            members: fields[3] ? fields[3].split(',').filter(m => m.trim()) : []
        };

        res.json(groupInfo);

    } catch (error) {
        console.error('Error looking up group:', error);
        res.status(500).json({ 
            error: 'Failed to lookup group',
            details: error.message 
        });
    }
};

export default {
    getCurrentUserInfo,
    getSystemUsers,
    getSystemGroups,
    lookupUser,
    lookupGroup
};
