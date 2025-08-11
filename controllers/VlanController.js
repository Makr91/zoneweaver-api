/**
 * @fileoverview VLAN Management Controller for Zoneweaver API
 * @description Handles VLAN creation, deletion, and management via dladm commands
 * @author makr91
 * @version 0.0.1
 * @license GPL-3.0
 */

import { execSync } from "child_process";
import Tasks, { TaskPriority } from "../models/TaskModel.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import { Op } from "sequelize";
import os from "os";

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
 * /network/vlans:
 *   get:
 *     summary: List VLANs
 *     description: Returns VLAN information from monitoring data or live system query
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: vid
 *         schema:
 *           type: integer
 *         description: Filter by VLAN ID
 *       - in: query
 *         name: over
 *         schema:
 *           type: string
 *         description: Filter by underlying physical link
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of VLANs to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *     responses:
 *       200:
 *         description: VLANs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vlans:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get VLANs
 */
export const getVlans = async (req, res) => {
    try {
        const { 
            vid, 
            over, 
            limit = 100, 
            live = false 
        } = req.query;

        if (live === 'true' || live === true) {
            // Get live data directly from dladm
            let command = 'pfexec dladm show-vlan -p -o link,vid,over,flags';

            const result = await executeCommand(command);
            
            if (!result.success) {
                return res.status(500).json({
                    error: 'Failed to get live VLAN data',
                    details: result.error
                });
            }

            let vlans = result.output ? result.output.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const [link, vlanId, overLink, flags] = line.split(':');
                    return {
                        link,
                        class: 'vlan',
                        vid: parseInt(vlanId),
                        over: overLink,
                        flags: flags || '',
                        source: 'live'
                    };
                })
                .filter(vlan => {
                    if (vid && vlan.vid !== parseInt(vid)) return false;
                    if (over && vlan.over !== over) return false;
                    return true;
                })
                .slice(0, parseInt(limit)) : [];

            return res.json({
                vlans,
                total: vlans.length,
                source: 'live'
            });
        }

        // Get data from database (monitoring data)
        const hostname = os.hostname();
        const whereClause = { 
            host: hostname,
            class: 'vlan'
        };
        
        if (vid) whereClause.vid = parseInt(vid);
        if (over) whereClause.over = over;

        const { count, rows } = await NetworkInterfaces.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['link', 'ASC']]
        });

        res.json({
            vlans: rows,
            total: count,
            source: 'database'
        });

    } catch (error) {
        console.error('Error getting VLANs:', error);
        res.status(500).json({ 
            error: 'Failed to get VLANs',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vlans/{vlan}:
 *   get:
 *     summary: Get VLAN details
 *     description: Returns detailed information about a specific VLAN
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vlan
 *         required: true
 *         schema:
 *           type: string
 *         description: VLAN link name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *     responses:
 *       200:
 *         description: VLAN details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: VLAN not found
 *       500:
 *         description: Failed to get VLAN details
 */
export const getVlanDetails = async (req, res) => {
    try {
        const { vlan } = req.params;
        const { live = false } = req.query;

        if (live === 'true' || live === true) {
            // Get VLAN details
            const vlanResult = await executeCommand(`pfexec dladm show-vlan ${vlan} -p -o link,vid,over,flags`);
            
            if (!vlanResult.success) {
                return res.status(404).json({
                    error: `VLAN ${vlan} not found`,
                    details: vlanResult.error
                });
            }

            const [link, vid, over, flags] = vlanResult.output.split(':');
            
            const vlanDetails = {
                link,
                class: 'vlan',
                vid: parseInt(vid),
                over,
                flags: flags || '',
                source: 'live'
            };

            // Get additional link information
            const linkResult = await executeCommand(`pfexec dladm show-link ${vlan} -p -o link,class,mtu,state`);
            if (linkResult.success) {
                const [, linkClass, mtu, state] = linkResult.output.split(':');
                vlanDetails.mtu = parseInt(mtu) || null;
                vlanDetails.state = state;
            }

            return res.json(vlanDetails);
        }

        // Get data from database
        const hostname = os.hostname();
        const vlanData = await NetworkInterfaces.findOne({
            where: {
                host: hostname,
                link: vlan,
                class: 'vlan'
            },
            order: [['scan_timestamp', 'DESC']]
        });

        if (!vlanData) {
            return res.status(404).json({ 
                error: `VLAN ${vlan} not found` 
            });
        }

        res.json(vlanData);

    } catch (error) {
        console.error('Error getting VLAN details:', error);
        res.status(500).json({ 
            error: 'Failed to get VLAN details',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vlans:
 *   post:
 *     summary: Create VLAN
 *     description: Creates a new VLAN using dladm create-vlan
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - vid
 *               - link
 *             properties:
 *               vid:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 4094
 *                 description: VLAN ID (1-4094)
 *                 example: 100
 *               link:
 *                 type: string
 *                 description: Physical ethernet link to create VLAN over
 *                 example: "e1000g0"
 *               name:
 *                 type: string
 *                 description: Custom VLAN link name (auto-generated if not provided)
 *                 example: "vlan100"
 *               force:
 *                 type: boolean
 *                 description: Force creation on devices without VLAN header support
 *                 default: false
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary VLAN (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User creating this VLAN
 *                 default: "api"
 *     responses:
 *       202:
 *         description: VLAN creation task created successfully
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
 *                 vlan_name:
 *                   type: string
 *                 vid:
 *                   type: integer
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create VLAN task
 */
export const createVlan = async (req, res) => {
    try {
        const { 
            vid, 
            link, 
            name, 
            force = false, 
            temporary = false, 
            created_by = 'api' 
        } = req.body;

        // Validate required fields
        if (!vid || !link) {
            return res.status(400).json({ 
                error: 'vid and link are required' 
            });
        }

        // Validate VLAN ID range
        if (vid < 1 || vid > 4094) {
            return res.status(400).json({ 
                error: 'VLAN ID must be between 1 and 4094' 
            });
        }

        // Validate that the underlying link exists
        const linkResult = await executeCommand(`pfexec dladm show-link ${link}`);
        if (!linkResult.success) {
            return res.status(400).json({ 
                error: `Underlying link ${link} not found or not available` 
            });
        }

        // Generate VLAN name if not provided
        let vlanName = name;
        if (!vlanName) {
            // Auto-generate name based on dladm convention: <name><1000 * vid + PPA>
            const linkMatch = link.match(/^([a-zA-Z]+)(\d+)$/);
            if (linkMatch) {
                const [, baseName, ppa] = linkMatch;
                vlanName = `${baseName}${1000 * vid + parseInt(ppa)}`;
            } else {
                vlanName = `vlan${vid}`;
            }
        }

        // Check if VLAN already exists
        const existsResult = await executeCommand(`pfexec dladm show-vlan ${vlanName}`);
        if (existsResult.success) {
            return res.status(400).json({ 
                error: `VLAN ${vlanName} already exists` 
            });
        }

        // Create task for VLAN creation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'create_vlan',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                vid: vid,
                link: link,
                name: vlanName,
                force: force,
                temporary: temporary
            })
        });

        res.status(202).json({
            success: true,
            message: `VLAN creation task created for ${vlanName} (VID ${vid}) over ${link}`,
            task_id: task.id,
            vlan_name: vlanName,
            vid: vid,
            over: link,
            temporary: temporary
        });

    } catch (error) {
        console.error('Error creating VLAN:', error);
        res.status(500).json({ 
            error: 'Failed to create VLAN task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vlans/{vlan}:
 *   delete:
 *     summary: Delete VLAN
 *     description: Deletes a VLAN using dladm delete-vlan
 *     tags: [VLANs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vlan
 *         required: true
 *         schema:
 *           type: string
 *         description: VLAN link name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this VLAN
 *     responses:
 *       202:
 *         description: VLAN deletion task created successfully
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
 *                 vlan_name:
 *                   type: string
 *       404:
 *         description: VLAN not found
 *       500:
 *         description: Failed to create VLAN deletion task
 */
export const deleteVlan = async (req, res) => {
    console.log('🔧 === VLAN DELETION REQUEST STARTING ===');
    console.log('📋 VLAN to delete:', req.params.vlan);
    console.log('📋 Query parameters:', req.query);
    
    try {
        const { vlan } = req.params;
        const { temporary = false, created_by = 'api' } = req.query;

        console.log('✅ VLAN deletion - parsed parameters:');
        console.log('   - vlan:', vlan);
        console.log('   - temporary:', temporary);
        console.log('   - created_by:', created_by);

        // Check if VLAN exists
        console.log('🔍 Checking if VLAN exists...');
        const existsResult = await executeCommand(`pfexec dladm show-vlan ${vlan}`);
        console.log('📋 VLAN existence check result:', existsResult.success ? 'EXISTS' : 'NOT FOUND');
        
        if (!existsResult.success) {
            console.log('❌ VLAN not found, returning 404');
            return res.status(404).json({ 
                error: `VLAN ${vlan} not found`,
                details: existsResult.error
            });
        }

        console.log('✅ VLAN exists, creating deletion task...');

        // Create task for VLAN deletion
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'delete_vlan',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                vlan: vlan,
                temporary: temporary === 'true' || temporary === true
            })
        });

        console.log('✅ VLAN deletion task created successfully:');
        console.log('   - Task ID:', task.id);
        console.log('   - VLAN:', vlan);
        console.log('   - Temporary:', temporary);

        res.status(202).json({
            success: true,
            message: `VLAN deletion task created for ${vlan}`,
            task_id: task.id,
            vlan_name: vlan,
            temporary: temporary === 'true' || temporary === true
        });

        console.log('✅ VLAN deletion response sent successfully');

    } catch (error) {
        console.error('❌ Error deleting VLAN:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to create VLAN deletion task',
            details: error.message 
        });
    }
};
