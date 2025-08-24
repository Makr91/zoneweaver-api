/**
 * @fileoverview Network Management Controller for Zoneweaver API
 * @description Handles hostname and IP address management via ipadm and hostname commands
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { execSync } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import IPAddresses from "../models/IPAddressModel.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import { Op } from "sequelize";
import yj from "yieldable-json";
import os from "os";
import fs from "fs";

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async (command) => {
    try {
        const output = execSync(command, { 
            encoding: 'utf8',
            timeout: 30000 // 30 second timeout
        });
        return { success: true, output: output.trim() };
    } catch (error) {
        return { 
            success: false, 
            error: error.message,
            output: error.stdout || ''
        };
    }
};

/**
 * @swagger
 * /network/hostname:
 *   get:
 *     summary: Get system hostname
 *     description: Returns the current system hostname from /etc/nodename and system
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Current hostname information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 hostname:
 *                   type: string
 *                   description: Current system hostname
 *                   example: "hv-04"
 *                 nodename_file:
 *                   type: string
 *                   description: Hostname from /etc/nodename
 *                   example: "hv-04"
 *                 system_hostname:
 *                   type: string
 *                   description: Current running system hostname
 *                   example: "hv-04"
 *                 matches:
 *                   type: boolean
 *                   description: Whether nodename file matches system hostname
 *       500:
 *         description: Failed to get hostname
 */
export const getHostname = async (req, res) => {
    try {
        let nodenameMismatch = false;
        let nodenameFile = null;
        let systemHostname = os.hostname();

        // Read /etc/nodename if it exists
        try {
            if (fs.existsSync('/etc/nodename')) {
                nodenameFile = fs.readFileSync('/etc/nodename', 'utf8').trim();
            }
        } catch (error) {
            console.warn('Could not read /etc/nodename:', error.message);
        }

        // Check for mismatch
        if (nodenameFile && nodenameFile !== systemHostname) {
            nodenameMismatch = true;
        }

        res.json({
            hostname: systemHostname,
            nodename_file: nodenameFile,
            system_hostname: systemHostname,
            matches: !nodenameMismatch,
            warning: nodenameMismatch ? 'Hostname in /etc/nodename does not match system hostname' : null
        });

    } catch (error) {
        console.error('Error getting hostname:', error);
        res.status(500).json({ 
            error: 'Failed to get hostname',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/hostname:
 *   put:
 *     summary: Set system hostname
 *     description: Sets the system hostname by updating /etc/nodename and optionally applying immediately
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - hostname
 *             properties:
 *               hostname:
 *                 type: string
 *                 description: New hostname to set
 *                 example: "new-hostname"
 *               apply_immediately:
 *                 type: boolean
 *                 description: Whether to apply hostname change immediately (requires reboot for permanent effect)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User or system creating this task
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Hostname change task created successfully
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
 *                 hostname:
 *                   type: string
 *                 apply_immediately:
 *                   type: boolean
 *                   description: Whether hostname is applied immediately
 *                 requires_reboot:
 *                   type: boolean
 *                   description: Whether a reboot is required for full effect
 *                   example: true
 *                 reboot_reason:
 *                   type: string
 *                   description: Explanation of why reboot is needed
 *                   example: "Hostname written to /etc/nodename - reboot required to take effect"
 *                 note:
 *                   type: string
 *                   description: Additional information about the hostname change
 *       400:
 *         description: Invalid hostname
 *       500:
 *         description: Failed to create hostname change task
 */
export const setHostname = async (req, res) => {
    try {
        const { hostname, apply_immediately = false, created_by = 'api' } = req.body;

        if (!hostname || typeof hostname !== 'string') {
            return res.status(400).json({ 
                error: 'hostname is required and must be a string' 
            });
        }

        // Validate hostname format (basic validation)
        const hostnameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$/;
        if (!hostnameRegex.test(hostname)) {
            return res.status(400).json({ 
                error: 'Invalid hostname format. Must be alphanumeric with hyphens, 1-63 characters' 
            });
        }

        // Create task for hostname change
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'set_hostname',
            priority: TaskPriority.HIGH,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    hostname: hostname,
                    apply_immediately: apply_immediately
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Hostname change task created for: ${hostname}`,
            task_id: task.id,
            hostname: hostname,
            apply_immediately: apply_immediately,
            requires_reboot: true,
            reboot_reason: apply_immediately ? 'Hostname applied immediately but reboot required for full persistence' : 'Hostname written to /etc/nodename - reboot required to take effect',
            note: apply_immediately ? 'Hostname will be applied immediately but reboot required for persistence' : 'Hostname will be set in /etc/nodename only'
        });

    } catch (error) {
        console.error('Error setting hostname:', error);
        res.status(500).json({ 
            error: 'Failed to create hostname change task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/addresses:
 *   get:
 *     summary: List IP addresses
 *     description: Returns IP address assignments from monitoring data with optional filtering
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: interface
 *         schema:
 *           type: string
 *         description: Filter by interface name (partial match)
 *       - in: query
 *         name: ip_version
 *         schema:
 *           type: string
 *           enum: [v4, v6]
 *         description: Filter by IP version
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *           enum: [static, dhcp, addrconf]
 *         description: Filter by address type
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by address state
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of addresses to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from ipadm instead of database
 *     responses:
 *       200:
 *         description: IP addresses retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 addresses:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/IPAddress'
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get IP addresses
 */
export const getIPAddresses = async (req, res) => {
    try {
        const { 
            interface: iface, 
            ip_version, 
            type, 
            state, 
            limit = 100, 
            live = false 
        } = req.query;

        if (live === 'true' || live === true) {
            // Get live data directly from ipadm
            const result = await executeCommand('pfexec ipadm show-addr -p -o addrobj,type,state,addr');
            
            if (!result.success) {
                return res.status(500).json({
                    error: 'Failed to get live IP address data',
                    details: result.error
                });
            }

            const addresses = result.output.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const [addrobj, addrType, addrState, addr] = line.split(':');
                    const [interfaceName] = addrobj.split('/');
                    const ipVersion = addr.includes(':') ? 'v6' : 'v4';
                    
                    return {
                        addrobj,
                        interface: interfaceName,
                        type: addrType,
                        state: addrState,
                        addr,
                        ip_version: ipVersion,
                        source: 'live'
                    };
                })
                .filter(addr => {
                    if (iface && !addr.interface.includes(iface)) return false;
                    if (ip_version && addr.ip_version !== ip_version) return false;
                    if (type && addr.type !== type) return false;
                    if (state && addr.state !== state) return false;
                    return true;
                })
                .slice(0, parseInt(limit));

            return res.json({
                addresses,
                total: addresses.length,
                source: 'live'
            });
        }

        // Get data from database (monitoring data)
        const hostname = os.hostname();
        const whereClause = { host: hostname };
        
        if (iface) whereClause.interface = { [Op.like]: `%${iface}%` };
        if (ip_version) whereClause.ip_version = ip_version;
        if (type) whereClause.type = type;
        if (state) whereClause.state = state;

        const { count, rows } = await IPAddresses.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['ip_version', 'ASC'], ['interface', 'ASC']]
        });

        res.json({
            addresses: rows,
            total: count,
            source: 'database'
        });

    } catch (error) {
        console.error('Error getting IP addresses:', error);
        res.status(500).json({ 
            error: 'Failed to get IP addresses',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/addresses:
 *   post:
 *     summary: Create IP address
 *     description: Creates a new IP address assignment using ipadm create-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - interface
 *               - type
 *               - addrobj
 *             properties:
 *               interface:
 *                 type: string
 *                 description: Network interface name
 *                 example: "vnic0"
 *               type:
 *                 type: string
 *                 enum: [static, dhcp, addrconf]
 *                 description: Type of IP address to create
 *               addrobj:
 *                 type: string
 *                 description: Address object name (e.g., vnic0/v4static)
 *                 example: "vnic0/v4static"
 *               address:
 *                 type: string
 *                 description: IP address with prefix (required for static type)
 *                 example: "192.168.1.100/24"
 *               primary:
 *                 type: boolean
 *                 description: Set as primary interface (DHCP only)
 *                 default: false
 *               wait:
 *                 type: integer
 *                 description: Wait time in seconds for DHCP (DHCP only)
 *                 default: 30
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary address (not persistent)
 *                 default: false
 *               down:
 *                 type: boolean
 *                 description: Create address in down state
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User creating this address
 *                 default: "api"
 *     responses:
 *       202:
 *         description: IP address creation task created successfully
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
 *                 addrobj:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create IP address task
 */
export const createIPAddress = async (req, res) => {
    try {
        const { 
            interface: iface, 
            type, 
            addrobj, 
            address, 
            primary = false, 
            wait = 30, 
            temporary = false, 
            down = false, 
            created_by = 'api' 
        } = req.body;

        // Validate required fields
        if (!iface || !type || !addrobj) {
            return res.status(400).json({ 
                error: 'interface, type, and addrobj are required' 
            });
        }

        // Validate type-specific requirements
        if (type === 'static' && !address) {
            return res.status(400).json({ 
                error: 'address is required for static type' 
            });
        }

        if (!['static', 'dhcp', 'addrconf'].includes(type)) {
            return res.status(400).json({ 
                error: 'type must be one of: static, dhcp, addrconf' 
            });
        }

        // Create task for IP address creation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'create_ip_address',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    interface: iface,
                    type: type,
                    addrobj: addrobj,
                    address: address,
                    primary: primary,
                    wait: wait,
                    temporary: temporary,
                    down: down
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `IP address creation task created for ${addrobj}`,
            task_id: task.id,
            addrobj: addrobj,
            type: type,
            interface: iface
        });

    } catch (error) {
        console.error('Error creating IP address:', error);
        res.status(500).json({ 
            error: 'Failed to create IP address task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/addresses/{addrobj}:
 *   delete:
 *     summary: Delete IP address
 *     description: Deletes an IP address assignment using ipadm delete-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: addrobj
 *         required: true
 *         schema:
 *           type: string
 *         description: Address object name to delete (e.g., vnic0/v4static)
 *       - in: query
 *         name: release
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Release DHCP lease before deletion
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this address
 *     responses:
 *       202:
 *         description: IP address deletion task created successfully
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
 *                 addrobj:
 *                   type: string
 *       404:
 *         description: Address object not found
 *       500:
 *         description: Failed to create IP address deletion task
 */
export const deleteIPAddress = async (req, res) => {
    console.log('🔧 === IP ADDRESS DELETION REQUEST STARTING ===');
    console.log('📋 Raw req.params:', req.params);
    console.log('📋 Query parameters:', req.query);
    
    try {
        // With wildcard route (*), the addrobj is in req.params[0]
        const addrobj = req.params[0];
        const { release = false, created_by = 'api' } = req.query;

        console.log('✅ IP address deletion - parsed parameters:');
        console.log('   - addrobj (from wildcard):', addrobj);
        console.log('   - release:', release);
        console.log('   - created_by:', created_by);

        // Check if address object exists in current system
        console.log('🔍 Checking if address object exists...');
        const result = await executeCommand(`pfexec ipadm show-addr ${addrobj}`);
        console.log('📋 Address existence check result:', result.success ? 'EXISTS' : 'NOT FOUND');
        
        if (!result.success) {
            console.log('❌ Address object not found, returning 404');
            return res.status(404).json({ 
                error: `Address object ${addrobj} not found`,
                details: result.error
            });
        }

        console.log('✅ Address object exists, creating deletion task...');

        // Create task for IP address deletion
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'delete_ip_address',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    addrobj: addrobj,
                    release: release === 'true' || release === true
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        console.log('✅ IP address deletion task created successfully:');
        console.log('   - Task ID:', task.id);
        console.log('   - Address object:', addrobj);
        console.log('   - Release DHCP:', release);

        res.status(202).json({
            success: true,
            message: `IP address deletion task created for ${addrobj}`,
            task_id: task.id,
            addrobj: addrobj,
            release: release === 'true' || release === true
        });

        console.log('✅ IP address deletion response sent successfully');

    } catch (error) {
        console.error('❌ Error deleting IP address:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to create IP address deletion task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/addresses/{addrobj}/enable:
 *   put:
 *     summary: Enable IP address
 *     description: Enables a disabled IP address using ipadm enable-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: addrobj
 *         required: true
 *         schema:
 *           type: string
 *         description: Address object name to enable
 *     responses:
 *       202:
 *         description: IP address enable task created successfully
 *       404:
 *         description: Address object not found
 *       500:
 *         description: Failed to create enable task
 */
export const enableIPAddress = async (req, res) => {
    try {
        // With wildcard route (*), the addrobj is in req.params[0]
        const addrobj = req.params[0];
        const { created_by = 'api' } = req.body || {};

        // Create task for enabling IP address
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'enable_ip_address',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    addrobj: addrobj
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `IP address enable task created for ${addrobj}`,
            task_id: task.id,
            addrobj: addrobj
        });

    } catch (error) {
        console.error('Error enabling IP address:', error);
        res.status(500).json({ 
            error: 'Failed to create IP address enable task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/addresses/{addrobj}/disable:
 *   put:
 *     summary: Disable IP address
 *     description: Disables an IP address using ipadm disable-addr
 *     tags: [Network Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: addrobj
 *         required: true
 *         schema:
 *           type: string
 *         description: Address object name to disable
 *     responses:
 *       202:
 *         description: IP address disable task created successfully
 *       500:
 *         description: Failed to create disable task
 */
export const disableIPAddress = async (req, res) => {
    try {
        // With wildcard route (*), the addrobj is in req.params[0]
        const addrobj = req.params[0];
        const { created_by = 'api' } = req.body || {};

        // Create task for disabling IP address
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'disable_ip_address',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    addrobj: addrobj
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `IP address disable task created for ${addrobj}`,
            task_id: task.id,
            addrobj: addrobj
        });

    } catch (error) {
        console.error('Error disabling IP address:', error);
        res.status(500).json({ 
            error: 'Failed to create IP address disable task',
            details: error.message 
        });
    }
};
