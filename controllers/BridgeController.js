/**
 * @fileoverview Bridge Management Controller for Zoneweaver API
 * @description Handles 802.1D bridge creation, deletion, and management via dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { execSync } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import { Op } from "sequelize";
import yj from "yieldable-json";
import os from "os";
import { log } from "../lib/Logger.js";

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
 * /network/bridges:
 *   get:
 *     summary: List bridges
 *     description: Returns bridge information from monitoring data or live system query
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by bridge name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of bridges to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *       - in: query
 *         name: extended
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include detailed bridge information
 *     responses:
 *       200:
 *         description: Bridges retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bridges:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get bridges
 */
export const getBridges = async (req, res) => {
    try {
        const { 
            name, 
            limit = 100, 
            live = false,
            extended = false 
        } = req.query;

        if (live === 'true' || live === true) {
            // Get live data directly from dladm
            let command = 'pfexec dladm show-bridge -p';
            if (extended === 'true' || extended === true) {
                command += ' -o bridge,address,priority,bmaxage,bhellotime,bfwddelay,forceproto,tctime,tccount,tchange,desroot,rootcost,rootport';
            } else {
                command += ' -o bridge,address,priority,desroot';
            }
            
            if (name) {
                command += ` ${name}`;
            }

            const result = await executeCommand(command);
            
            if (!result.success) {
                return res.status(500).json({
                    error: 'Failed to get live bridge data',
                    details: result.error
                });
            }

            const bridges = result.output ? result.output.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const parts = line.split(':');
                    if (extended === 'true' || extended === true) {
                        const [bridge, address, priority, bmaxage, bhellotime, bfwddelay, forceproto, tctime, tccount, tchange, desroot, rootcost, rootport] = parts;
                        return {
                            bridge,
                            address,
                            priority: parseInt(priority) || null,
                            max_age: parseInt(bmaxage) || null,
                            hello_time: parseInt(bhellotime) || null,
                            forward_delay: parseInt(bfwddelay) || null,
                            force_protocol: parseInt(forceproto) || null,
                            tc_time: parseInt(tctime) || null,
                            tc_count: parseInt(tccount) || null,
                            topology_change: tchange === 'yes',
                            designated_root: desroot,
                            root_cost: parseInt(rootcost) || null,
                            root_port: parseInt(rootport) || null,
                            source: 'live'
                        };
                    } else {
                        const [bridge, address, priority, desroot] = parts;
                        return {
                            bridge,
                            address,
                            priority: parseInt(priority) || null,
                            designated_root: desroot,
                            source: 'live'
                        };
                    }
                })
                .slice(0, parseInt(limit)) : [];

            return res.json({
                bridges,
                total: bridges.length,
                source: 'live',
                extended: extended === 'true' || extended === true
            });
        }

        // Get data from database (monitoring data)
        const hostname = os.hostname();
        const whereClause = { 
            host: hostname,
            class: 'bridge'
        };
        
        if (name) whereClause.link = name;

        const { count, rows } = await NetworkInterfaces.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['link', 'ASC']]
        });

        res.json({
            bridges: rows,
            total: count,
            source: 'database'
        });

    } catch (error) {
        log.api.error('Error getting bridges', {
            error: error.message,
            stack: error.stack,
            live: live,
            name: name
        });
        res.status(500).json({ 
            error: 'Failed to get bridges',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/bridges/{bridge}:
 *   get:
 *     summary: Get bridge details
 *     description: Returns detailed information about a specific bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: bridge
 *         required: true
 *         schema:
 *           type: string
 *         description: Bridge name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *       - in: query
 *         name: show_links
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include attached links information
 *       - in: query
 *         name: show_forwarding
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include forwarding table entries
 *     responses:
 *       200:
 *         description: Bridge details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Bridge not found
 *       500:
 *         description: Failed to get bridge details
 */
export const getBridgeDetails = async (req, res) => {
    try {
        const { bridge } = req.params;
        const { live = false, show_links = false, show_forwarding = false } = req.query;

        if (live === 'true' || live === true) {
            // Get bridge details
            const bridgeResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -p -o bridge,address,priority,bmaxage,bhellotime,bfwddelay,forceproto,tctime,tccount,tchange,desroot,rootcost,rootport`);
            
            if (!bridgeResult.success) {
                return res.status(404).json({
                    error: `Bridge ${bridge} not found`,
                    details: bridgeResult.error
                });
            }

            const [bridgeName, address, priority, bmaxage, bhellotime, bfwddelay, forceproto, tctime, tccount, tchange, desroot, rootcost, rootport] = bridgeResult.output.split(':');
            
            const bridgeDetails = {
                bridge: bridgeName,
                address,
                priority: parseInt(priority) || null,
                max_age: parseInt(bmaxage) || null,
                hello_time: parseInt(bhellotime) || null,
                forward_delay: parseInt(bfwddelay) || null,
                force_protocol: parseInt(forceproto) || null,
                tc_time: parseInt(tctime) || null,
                tc_count: parseInt(tccount) || null,
                topology_change: tchange === 'yes',
                designated_root: desroot,
                root_cost: parseInt(rootcost) || null,
                root_port: parseInt(rootport) || null,
                source: 'live'
            };

            // Get attached links if requested
            if (show_links === 'true' || show_links === true) {
                const linksResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -l -p -o link,index,state,uptime,opercost,operp2p,operedge,desroot,descost,desbridge,desport,tcack`);
                
                if (linksResult.success && linksResult.output) {
                    const links = linksResult.output.split('\n')
                        .filter(line => line.trim())
                        .map(line => {
                            const [link, index, state, uptime, opercost, operp2p, operedge, linkDesroot, descost, desbridge, desport, tcack] = line.split(':');
                            return {
                                link,
                                index: parseInt(index) || null,
                                state,
                                uptime: parseInt(uptime) || null,
                                operational_cost: parseInt(opercost) || null,
                                point_to_point: operp2p === 'yes',
                                edge_port: operedge === 'yes',
                                designated_root: linkDesroot,
                                designated_cost: parseInt(descost) || null,
                                designated_bridge: desbridge,
                                designated_port: desport,
                                topology_change_ack: tcack === 'yes'
                            };
                        });
                    
                    bridgeDetails.links = links;
                }
            }

            // Get forwarding table if requested
            if (show_forwarding === 'true' || show_forwarding === true) {
                const fwdResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -f -p -o dest,age,flags,output`);
                
                if (fwdResult.success && fwdResult.output) {
                    const forwarding = fwdResult.output.split('\n')
                        .filter(line => line.trim())
                        .map(line => {
                            const [dest, age, flags, output] = line.split(':');
                            return {
                                destination: dest,
                                age: age || null,
                                flags: flags || '',
                                output
                            };
                        });
                    
                    bridgeDetails.forwarding_table = forwarding;
                }
            }

            return res.json(bridgeDetails);
        }

        // Get data from database
        const hostname = os.hostname();
        const bridgeData = await NetworkInterfaces.findOne({
            where: {
                host: hostname,
                link: bridge,
                class: 'bridge'
            },
            order: [['scan_timestamp', 'DESC']]
        });

        if (!bridgeData) {
            return res.status(404).json({ 
                error: `Bridge ${bridge} not found` 
            });
        }

        res.json(bridgeData);

    } catch (error) {
        log.api.error('Error getting bridge details', {
            error: error.message,
            stack: error.stack,
            bridge: bridge,
            live: live
        });
        res.status(500).json({ 
            error: 'Failed to get bridge details',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/bridges:
 *   post:
 *     summary: Create bridge
 *     description: Creates a new 802.1D bridge using dladm create-bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *             properties:
 *               name:
 *                 type: string
 *                 description: Bridge name
 *                 example: "bridge0"
 *               protection:
 *                 type: string
 *                 enum: [stp, trill]
 *                 description: Protection method (STP or TRILL)
 *                 default: "stp"
 *               priority:
 *                 type: integer
 *                 minimum: 0
 *                 maximum: 61440
 *                 description: Bridge priority (0-61440, increments of 4096)
 *                 default: 32768
 *               max_age:
 *                 type: integer
 *                 minimum: 6
 *                 maximum: 40
 *                 description: Maximum age for configuration information (6-40 seconds)
 *                 default: 20
 *               hello_time:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 10
 *                 description: Hello time for BPDUs (1-10 seconds)
 *                 default: 2
 *               forward_delay:
 *                 type: integer
 *                 minimum: 4
 *                 maximum: 30
 *                 description: Forward delay timer (4-30 seconds)
 *                 default: 15
 *               force_protocol:
 *                 type: integer
 *                 minimum: 0
 *                 description: Forced maximum supported protocol version
 *                 default: 3
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Links to add to the bridge
 *                 example: ["e1000g0", "e1000g1"]
 *               created_by:
 *                 type: string
 *                 description: User creating this bridge
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Bridge creation task created successfully
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
 *                 bridge_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create bridge task
 */
export const createBridge = async (req, res) => {
    try {
        const { 
            name, 
            protection = 'stp', 
            priority = 32768, 
            max_age = 20, 
            hello_time = 2, 
            forward_delay = 15, 
            force_protocol = 3, 
            links = [], 
            created_by = 'api' 
        } = req.body;

        // Validate required fields
        if (!name) {
            return res.status(400).json({ 
                error: 'name is required' 
            });
        }

        // Validate bridge name format
        const bridgeNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z]$/;
        if (!bridgeNameRegex.test(name) || name.length > 31) {
            return res.status(400).json({ 
                error: 'Bridge name must start and end with letter, contain alphanumeric/underscore, and be max 31 characters' 
            });
        }

        // Validate reserved names
        if (name === 'default' || name.startsWith('SUNW')) {
            return res.status(400).json({ 
                error: 'Bridge name "default" and names starting with "SUNW" are reserved' 
            });
        }

        // Validate protection method
        if (!['stp', 'trill'].includes(protection)) {
            return res.status(400).json({ 
                error: 'Protection method must be "stp" or "trill"' 
            });
        }

        // Validate priority (must be divisible by 4096)
        if (priority < 0 || priority > 61440 || priority % 4096 !== 0) {
            return res.status(400).json({ 
                error: 'Priority must be between 0 and 61440 and divisible by 4096' 
            });
        }

        // Validate timing constraints
        if (max_age < 6 || max_age > 40) {
            return res.status(400).json({ 
                error: 'Max age must be between 6 and 40 seconds' 
            });
        }
        if (hello_time < 1 || hello_time > 10) {
            return res.status(400).json({ 
                error: 'Hello time must be between 1 and 10 seconds' 
            });
        }
        if (forward_delay < 4 || forward_delay > 30) {
            return res.status(400).json({ 
                error: 'Forward delay must be between 4 and 30 seconds' 
            });
        }

        // Validate STP constraints
        if (2 * (forward_delay - 1) < max_age) {
            return res.status(400).json({ 
                error: 'STP constraint violation: 2 * (forward-delay - 1) must be >= max-age' 
            });
        }
        if (max_age < 2 * (hello_time + 1)) {
            return res.status(400).json({ 
                error: 'STP constraint violation: max-age must be >= 2 * (hello-time + 1)' 
            });
        }

        // Check if bridge already exists
        const existsResult = await executeCommand(`pfexec dladm show-bridge ${name}`);
        if (existsResult.success) {
            return res.status(400).json({ 
                error: `Bridge ${name} already exists` 
            });
        }

        // Validate links if provided
        if (links && links.length > 0) {
            for (const link of links) {
                const linkResult = await executeCommand(`pfexec dladm show-link ${link}`);
                if (!linkResult.success) {
                    return res.status(400).json({ 
                        error: `Link ${link} not found or not available` 
                    });
                }
            }
        }

        // Create task for bridge creation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'create_bridge',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    name: name,
                    protection: protection,
                    priority: priority,
                    max_age: max_age,
                    hello_time: hello_time,
                    forward_delay: forward_delay,
                    force_protocol: force_protocol,
                    links: links
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Bridge creation task created for ${name}`,
            task_id: task.id,
            bridge_name: name,
            protection: protection,
            links: links
        });

    } catch (error) {
        log.api.error('Error creating bridge', {
            error: error.message,
            stack: error.stack,
            name: name,
            protection: protection
        });
        res.status(500).json({ 
            error: 'Failed to create bridge task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/bridges/{bridge}:
 *   delete:
 *     summary: Delete bridge
 *     description: Deletes a bridge using dladm delete-bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: bridge
 *         required: true
 *         schema:
 *           type: string
 *         description: Bridge name to delete
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if links are attached
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this bridge
 *     responses:
 *       202:
 *         description: Bridge deletion task created successfully
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
 *                 bridge_name:
 *                   type: string
 *       404:
 *         description: Bridge not found
 *       500:
 *         description: Failed to create bridge deletion task
 */
export const deleteBridge = async (req, res) => {
    try {
        const { bridge } = req.params;
        const { force = false, created_by = 'api' } = req.query;

        // Check if bridge exists
        const existsResult = await executeCommand(`pfexec dladm show-bridge ${bridge}`);
        
        if (!existsResult.success) {
            return res.status(404).json({ 
                error: `Bridge ${bridge} not found`,
                details: existsResult.error
            });
        }

        // Check for attached links unless force is specified
        const forceParam = force === 'true' || force === true;
        if (!forceParam) {
            const linksResult = await executeCommand(`pfexec dladm show-bridge ${bridge} -l -p -o link`);
            if (linksResult.success && linksResult.output.trim()) {
                const attachedLinks = linksResult.output.trim().split('\n');
                return res.status(400).json({ 
                    error: `Cannot delete bridge ${bridge}. Links are still attached: ${attachedLinks.join(', ')}`,
                    attached_links: attachedLinks,
                    suggestion: 'Remove links first or use force=true'
                });
            }
        }

        // Create task for bridge deletion
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'delete_bridge',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    bridge: bridge,
                    force: forceParam
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        log.app.info('Bridge deletion task created', {
            task_id: task.id,
            bridge: bridge,
            force: forceParam,
            created_by: created_by
        });

        res.status(202).json({
            success: true,
            message: `Bridge deletion task created for ${bridge}`,
            task_id: task.id,
            bridge_name: bridge,
            force: forceParam
        });

    } catch (error) {
        log.api.error('Error deleting bridge', {
            error: error.message,
            stack: error.stack,
            bridge: req.params.bridge
        });
        res.status(500).json({ 
            error: 'Failed to create bridge deletion task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/bridges/{bridge}/links:
 *   put:
 *     summary: Modify bridge links
 *     description: Add or remove links from an existing bridge using dladm add-bridge/remove-bridge
 *     tags: [Bridges]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: bridge
 *         required: true
 *         schema:
 *           type: string
 *         description: Bridge name to modify
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - operation
 *               - links
 *             properties:
 *               operation:
 *                 type: string
 *                 enum: [add, remove]
 *                 description: Whether to add or remove links
 *               links:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: Links to add or remove
 *                 example: ["e1000g2", "e1000g3"]
 *               created_by:
 *                 type: string
 *                 description: User making this modification
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Bridge link modification task created successfully
 *       400:
 *         description: Invalid request parameters
 *       404:
 *         description: Bridge not found
 *       500:
 *         description: Failed to create link modification task
 */
export const modifyBridgeLinks = async (req, res) => {
    try {
        const { bridge } = req.params;
        const { operation, links, created_by = 'api' } = req.body;

        // Validate required fields
        if (!operation || !links || !Array.isArray(links) || links.length === 0) {
            return res.status(400).json({ 
                error: 'operation and links array (with at least one link) are required' 
            });
        }

        // Validate operation
        if (!['add', 'remove'].includes(operation)) {
            return res.status(400).json({ 
                error: 'operation must be either "add" or "remove"' 
            });
        }

        // Check if bridge exists
        const existsResult = await executeCommand(`pfexec dladm show-bridge ${bridge}`);
        if (!existsResult.success) {
            return res.status(404).json({ 
                error: `Bridge ${bridge} not found`,
                details: existsResult.error
            });
        }

        // If adding links, validate that they exist
        if (operation === 'add') {
            for (const link of links) {
                const linkResult = await executeCommand(`pfexec dladm show-link ${link}`);
                if (!linkResult.success) {
                    return res.status(400).json({ 
                        error: `Link ${link} not found or not available` 
                    });
                }
            }
        }

        // Create task for bridge link modification
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'modify_bridge_links',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    bridge: bridge,
                    operation: operation,
                    links: links
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        res.status(202).json({
            success: true,
            message: `Bridge link ${operation} task created for ${bridge}`,
            task_id: task.id,
            bridge_name: bridge,
            operation: operation,
            links: links
        });

    } catch (error) {
        log.api.error('Error modifying bridge links', {
            error: error.message,
            stack: error.stack,
            bridge: bridge,
            operation: operation
        });
        res.status(500).json({ 
            error: 'Failed to create bridge link modification task',
            details: error.message 
        });
    }
};
