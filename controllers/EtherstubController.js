/**
 * @fileoverview Etherstub Management Controller for Zoneweaver API
 * @description Handles etherstub creation, deletion, and management via dladm commands
 * @author makr91

 * @license: https://zoneweaver-api.startcloud.com/license/
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
 * /network/etherstubs:
 *   get:
 *     summary: List etherstubs
 *     description: Returns etherstub information from monitoring data or live system query
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by etherstub name
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of etherstubs to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *     responses:
 *       200:
 *         description: Etherstubs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 etherstubs:
 *                   type: array
 *                   items:
 *                     type: object
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get etherstubs
 */
export const getEtherstubs = async (req, res) => {
    try {
        const { 
            name, 
            limit = 100, 
            live = false 
        } = req.query;

        if (live === 'true' || live === true) {
            // Get live data directly from dladm
            let command = 'pfexec dladm show-etherstub -p';
            if (name) {
                command += ` ${name}`;
            }

            const result = await executeCommand(command);
            
            if (!result.success) {
                return res.status(500).json({
                    error: 'Failed to get live etherstub data',
                    details: result.error
                });
            }

            const etherstubs = result.output ? result.output.split('\n')
                .filter(line => line.trim())
                .map(line => {
                    // etherstub output format is just the name
                    return {
                        link: line.trim(),
                        class: 'etherstub',
                        source: 'live'
                    };
                })
                .slice(0, parseInt(limit)) : [];

            return res.json({
                etherstubs,
                total: etherstubs.length,
                source: 'live'
            });
        }

        // Get data from database (monitoring data)
        const hostname = os.hostname();
        const whereClause = { 
            host: hostname,
            class: 'etherstub'
        };
        
        if (name) whereClause.link = name;

        const { count, rows } = await NetworkInterfaces.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['link', 'ASC']]
        });

        res.json({
            etherstubs: rows,
            total: count,
            source: 'database'
        });

    } catch (error) {
        console.error('Error getting etherstubs:', error);
        res.status(500).json({ 
            error: 'Failed to get etherstubs',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/etherstubs/{etherstub}:
 *   get:
 *     summary: Get etherstub details
 *     description: Returns detailed information about a specific etherstub
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: etherstub
 *         required: true
 *         schema:
 *           type: string
 *         description: Etherstub name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *       - in: query
 *         name: show_vnics
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include VNICs created on this etherstub
 *     responses:
 *       200:
 *         description: Etherstub details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *       404:
 *         description: Etherstub not found
 *       500:
 *         description: Failed to get etherstub details
 */
export const getEtherstubDetails = async (req, res) => {
    try {
        const { etherstub } = req.params;
        const { live = false, show_vnics = false } = req.query;

        if (live === 'true' || live === true) {
            // Check if etherstub exists
            const stubResult = await executeCommand(`pfexec dladm show-etherstub ${etherstub}`);
            
            if (!stubResult.success) {
                return res.status(404).json({
                    error: `Etherstub ${etherstub} not found`,
                    details: stubResult.error
                });
            }

            const etherstubDetails = {
                link: etherstub,
                class: 'etherstub',
                source: 'live'
            };

            // Get VNICs on this etherstub if requested
            if (show_vnics === 'true' || show_vnics === true) {
                const vnicResult = await executeCommand(`pfexec dladm show-vnic -l ${etherstub} -p -o link,over,macaddress,vid,zone`);
                
                if (vnicResult.success && vnicResult.output) {
                    const vnics = vnicResult.output.split('\n')
                        .filter(line => line.trim())
                        .map(line => {
                            const [link, over, macaddress, vid, zone] = line.split(':');
                            return {
                                link,
                                over,
                                macaddress,
                                vid: vid || null,
                                zone: zone || null
                            };
                        });
                    
                    etherstubDetails.vnics = vnics;
                }
            }

            return res.json(etherstubDetails);
        }

        // Get data from database
        const hostname = os.hostname();
        const etherstubData = await NetworkInterfaces.findOne({
            where: {
                host: hostname,
                link: etherstub,
                class: 'etherstub'
            },
            order: [['scan_timestamp', 'DESC']]
        });

        if (!etherstubData) {
            return res.status(404).json({ 
                error: `Etherstub ${etherstub} not found` 
            });
        }

        res.json(etherstubData);

    } catch (error) {
        console.error('Error getting etherstub details:', error);
        res.status(500).json({ 
            error: 'Failed to get etherstub details',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/etherstubs:
 *   post:
 *     summary: Create etherstub
 *     description: Creates a new etherstub using dladm create-etherstub
 *     tags: [Etherstubs]
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
 *                 description: Etherstub name
 *                 example: "stub0"
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary etherstub (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User creating this etherstub
 *                 default: "api"
 *     responses:
 *       202:
 *         description: Etherstub creation task created successfully
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
 *                 etherstub_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create etherstub task
 */
export const createEtherstub = async (req, res) => {
    try {
        const { 
            name, 
            temporary = false, 
            created_by = 'api' 
        } = req.body;

        // Validate required fields
        if (!name) {
            return res.status(400).json({ 
                error: 'name is required' 
            });
        }

        // Validate etherstub name format
        const stubNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*$/;
        if (!stubNameRegex.test(name)) {
            return res.status(400).json({ 
                error: 'Etherstub name must start with letter and contain only alphanumeric characters and underscores' 
            });
        }

        // Check if etherstub already exists
        const existsResult = await executeCommand(`pfexec dladm show-etherstub ${name}`);
        if (existsResult.success) {
            return res.status(400).json({ 
                error: `Etherstub ${name} already exists` 
            });
        }

        // Create task for etherstub creation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'create_etherstub',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                name: name,
                temporary: temporary
            })
        });

        res.status(202).json({
            success: true,
            message: `Etherstub creation task created for ${name}`,
            task_id: task.id,
            etherstub_name: name,
            temporary: temporary
        });

    } catch (error) {
        console.error('Error creating etherstub:', error);
        res.status(500).json({ 
            error: 'Failed to create etherstub task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/etherstubs/{etherstub}:
 *   delete:
 *     summary: Delete etherstub
 *     description: Deletes an etherstub using dladm delete-etherstub
 *     tags: [Etherstubs]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: etherstub
 *         required: true
 *         schema:
 *           type: string
 *         description: Etherstub name to delete
 *       - in: query
 *         name: temporary
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Delete only temporary configuration
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force deletion even if VNICs exist on etherstub
 *       - in: query
 *         name: created_by
 *         schema:
 *           type: string
 *           default: "api"
 *         description: User deleting this etherstub
 *     responses:
 *       202:
 *         description: Etherstub deletion task created successfully
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
 *                 etherstub_name:
 *                   type: string
 *       404:
 *         description: Etherstub not found
 *       500:
 *         description: Failed to create etherstub deletion task
 */
export const deleteEtherstub = async (req, res) => {
    console.log('🔧 === ETHERSTUB DELETION REQUEST STARTING ===');
    console.log('📋 Etherstub to delete:', req.params.etherstub);
    console.log('📋 Query parameters:', req.query);
    
    try {
        const { etherstub } = req.params;
        const { temporary = false, force = false, created_by = 'api' } = req.query;

        console.log('✅ Etherstub deletion - parsed parameters:');
        console.log('   - etherstub:', etherstub);
        console.log('   - temporary:', temporary);
        console.log('   - force:', force);
        console.log('   - created_by:', created_by);

        // Check if etherstub exists
        console.log('🔍 Checking if etherstub exists...');
        const existsResult = await executeCommand(`pfexec dladm show-etherstub ${etherstub}`);
        console.log('📋 Etherstub existence check result:', existsResult.success ? 'EXISTS' : 'NOT FOUND');
        
        if (!existsResult.success) {
            console.log('❌ Etherstub not found, returning 404');
            return res.status(404).json({ 
                error: `Etherstub ${etherstub} not found`,
                details: existsResult.error
            });
        }

        // Check for VNICs on this etherstub unless force is specified
        const forceParam = force === 'true' || force === true;
        if (!forceParam) {
            console.log('🔍 Checking for VNICs on etherstub...');
            const vnicResult = await executeCommand(`pfexec dladm show-vnic -l ${etherstub} -p -o link`);
            if (vnicResult.success && vnicResult.output.trim()) {
                const vnics = vnicResult.output.trim().split('\n');
                console.log('❌ VNICs found on etherstub, cannot delete without force');
                return res.status(400).json({ 
                    error: `Cannot delete etherstub ${etherstub}. VNICs still exist on it: ${vnics.join(', ')}`,
                    vnics: vnics,
                    suggestion: 'Delete VNICs first or use force=true'
                });
            }
            console.log('✅ No VNICs found on etherstub');
        } else {
            console.log('⚠️  Force deletion enabled - will remove any VNICs');
        }

        console.log('✅ Etherstub can be deleted, creating deletion task...');

        // Create task for etherstub deletion
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'delete_etherstub',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                etherstub: etherstub,
                temporary: temporary === 'true' || temporary === true,
                force: forceParam
            })
        });

        console.log('✅ Etherstub deletion task created successfully:');
        console.log('   - Task ID:', task.id);
        console.log('   - Etherstub:', etherstub);
        console.log('   - Temporary:', temporary);
        console.log('   - Force:', forceParam);

        res.status(202).json({
            success: true,
            message: `Etherstub deletion task created for ${etherstub}`,
            task_id: task.id,
            etherstub_name: etherstub,
            temporary: temporary === 'true' || temporary === true,
            force: forceParam
        });

        console.log('✅ Etherstub deletion response sent successfully');

    } catch (error) {
        console.error('❌ Error deleting etherstub:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to create etherstub deletion task',
            details: error.message 
        });
    }
};
