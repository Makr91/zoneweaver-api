/**
 * @fileoverview VNIC Management Controller for Zoneweaver API
 * @description Handles VNIC creation, deletion, and management via dladm commands
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
 * /network/vnics:
 *   get:
 *     summary: List VNICs
 *     description: Returns VNIC information from monitoring data or live system query
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: over
 *         schema:
 *           type: string
 *         description: Filter by underlying physical link
 *       - in: query
 *         name: zone
 *         schema:
 *           type: string
 *         description: Filter by zone assignment
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *           enum: [up, down, unknown]
 *         description: Filter by VNIC state
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of VNICs to return
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm instead of database
 *     responses:
 *       200:
 *         description: VNICs retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnics:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkInterface'
 *                 total:
 *                   type: integer
 *                 source:
 *                   type: string
 *                   enum: [database, live]
 *       500:
 *         description: Failed to get VNICs
 */
export const getVNICs = async (req, res) => {
    try {
        const { 
            over, 
            zone, 
            state, 
            limit = 100
        } = req.query;

        // Always get data from database (monitoring data)
        const hostname = os.hostname();
        const whereClause = { 
            host: hostname,
            class: 'vnic'
        };
        
        if (over) whereClause.over = over;
        if (zone) whereClause.zone = zone;
        if (state) whereClause.state = state;

        // Optimize: Remove expensive COUNT query, frontend doesn't need it
        const rows = await NetworkInterfaces.findAll({
            where: whereClause,
            attributes: ['id', 'link', 'class', 'state', 'zone', 'over', 'speed', 'duplex', 'scan_timestamp'], // Selective fetching
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['link', 'ASC']]
        });

        res.json({
            vnics: rows,
            source: 'database',
            returned: rows.length
        });

    } catch (error) {
        console.error('Error getting VNICs:', error);
        res.status(500).json({ 
            error: 'Failed to get VNICs',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vnics/{vnic}:
 *   get:
 *     summary: Get VNIC details
 *     description: Returns detailed information about a specific VNIC
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *       - in: query
 *         name: live
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Get live data directly from dladm
 *     responses:
 *       200:
 *         description: VNIC details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/NetworkInterface'
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC details
 */
export const getVNICDetails = async (req, res) => {
    try {
        const { vnic } = req.params;

        // Always get data from database
        const hostname = os.hostname();
        const vnicData = await NetworkInterfaces.findOne({
            where: {
                host: hostname,
                link: vnic,
                class: 'vnic'
            },
            order: [['scan_timestamp', 'DESC']]
        });

        if (!vnicData) {
            return res.status(404).json({ 
                error: `VNIC ${vnic} not found` 
            });
        }

        res.json(vnicData);

    } catch (error) {
        console.error('Error getting VNIC details:', error);
        res.status(500).json({ 
            error: 'Failed to get VNIC details',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vnics:
 *   post:
 *     summary: Create VNIC
 *     description: Creates a new VNIC using dladm create-vnic
 *     tags: [VNIC Management]
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
 *               - link
 *             properties:
 *               name:
 *                 type: string
 *                 description: VNIC name
 *                 example: "vnic0"
 *               link:
 *                 type: string
 *                 description: Underlying physical link or etherstub
 *                 example: "e1000g0"
 *               mac_address:
 *                 type: string
 *                 enum: [auto, random, factory]
 *                 description: MAC address assignment method or specific MAC
 *                 default: "auto"
 *                 example: "auto"
 *               mac_prefix:
 *                 type: string
 *                 description: MAC prefix for random assignment (requires mac_address=random)
 *                 example: "02:08:20"
 *               slot:
 *                 type: integer
 *                 description: Factory MAC slot number (requires mac_address=factory)
 *                 example: 1
 *               vlan_id:
 *                 type: integer
 *                 description: VLAN ID for tagged traffic
 *                 minimum: 1
 *                 maximum: 4094
 *                 example: 100
 *               temporary:
 *                 type: boolean
 *                 description: Create temporary VNIC (not persistent)
 *                 default: false
 *               properties:
 *                 type: object
 *                 description: Additional link properties to set
 *                 example: {"maxbw": "100M", "priority": "high"}
 *               created_by:
 *                 type: string
 *                 description: User creating this VNIC
 *                 default: "api"
 *     responses:
 *       202:
 *         description: VNIC creation task created successfully
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
 *                 vnic_name:
 *                   type: string
 *       400:
 *         description: Invalid request parameters
 *       500:
 *         description: Failed to create VNIC task
 */
export const createVNIC = async (req, res) => {
    try {
        const { 
            name, 
            link, 
            mac_address = 'auto', 
            mac_prefix, 
            slot, 
            vlan_id, 
            temporary = false, 
            properties = {}, 
            created_by = 'api' 
        } = req.body;

        // Validate required fields
        if (!name || !link) {
            return res.status(400).json({ 
                error: 'name and link are required' 
            });
        }

        // Validate VNIC name format
        const vnicNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*[0-9]+$/;
        if (!vnicNameRegex.test(name)) {
            return res.status(400).json({ 
                error: 'VNIC name must start with letter, contain alphanumeric/underscore, and end with number' 
            });
        }

        // Validate MAC address method
        if (mac_address === 'factory' && slot === undefined) {
            return res.status(400).json({ 
                error: 'slot is required when mac_address is factory' 
            });
        }

        if (mac_address === 'random' && mac_prefix && !/^([0-9a-fA-F]{2}:){2}[0-9a-fA-F]{2}$/.test(mac_prefix)) {
            return res.status(400).json({ 
                error: 'mac_prefix must be in format XX:XX:XX when specified' 
            });
        }

        // Validate VLAN ID
        if (vlan_id !== undefined && (vlan_id < 1 || vlan_id > 4094)) {
            return res.status(400).json({ 
                error: 'vlan_id must be between 1 and 4094' 
            });
        }

        // Check if VNIC already exists
        const existsResult = await executeCommand(`pfexec dladm show-vnic ${name}`);
        if (existsResult.success) {
            return res.status(400).json({ 
                error: `VNIC ${name} already exists` 
            });
        }

        // Prepare metadata object
        const metadataObject = {
            name: name,
            link: link,
            mac_address: mac_address,
            mac_prefix: mac_prefix,
            slot: slot,
            vlan_id: vlan_id,
            temporary: temporary,
            properties: properties
        };

        console.log('🔧 VNIC Controller - Creating task with metadata:');
        console.log('   Raw metadata object:', metadataObject);
        
        const metadataJson = JSON.stringify(metadataObject);
        console.log('   Stringified metadata:', metadataJson);
        console.log('   Metadata JSON length:', metadataJson.length);

        // Create task for VNIC creation
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'create_vnic',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: metadataJson
        });

        console.log('✅ VNIC Controller - Task created successfully:');
        console.log('   Task ID:', task.id);
        console.log('   Task metadata stored:', task.metadata);
        console.log('   Task metadata type:', typeof task.metadata);

        res.status(202).json({
            success: true,
            message: `VNIC creation task created for ${name}`,
            task_id: task.id,
            vnic_name: name,
            underlying_link: link
        });

    } catch (error) {
        console.error('Error creating VNIC:', error);
        res.status(500).json({ 
            error: 'Failed to create VNIC task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vnics/{vnic}:
 *   delete:
 *     summary: Delete VNIC
 *     description: Deletes a VNIC using dladm delete-vnic
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name to delete
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
 *         description: User deleting this VNIC
 *     responses:
 *       202:
 *         description: VNIC deletion task created successfully
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
 *                 vnic_name:
 *                   type: string
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to create VNIC deletion task
 */
export const deleteVNIC = async (req, res) => {
    console.log('🔧 === VNIC DELETION REQUEST STARTING ===');
    console.log('📋 VNIC to delete:', req.params.vnic);
    console.log('📋 Query parameters:', req.query);
    console.log('📋 Request headers:', req.headers);
    
    try {
        const { vnic } = req.params;
        const { temporary = false, created_by = 'api' } = req.query;

        console.log('✅ VNIC deletion - parsed parameters:');
        console.log('   - vnic:', vnic);
        console.log('   - temporary:', temporary);
        console.log('   - created_by:', created_by);

        // Check if VNIC exists
        console.log('🔍 Checking if VNIC exists...');
        const existsResult = await executeCommand(`pfexec dladm show-vnic ${vnic}`);
        console.log('📋 VNIC existence check result:', existsResult.success ? 'EXISTS' : 'NOT FOUND');
        
        if (!existsResult.success) {
            console.log('❌ VNIC not found, returning 404');
            return res.status(404).json({ 
                error: `VNIC ${vnic} not found`,
                details: existsResult.error
            });
        }

        console.log('✅ VNIC exists, creating deletion task...');

        // Create task for VNIC deletion
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'delete_vnic',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                vnic: vnic,
                temporary: temporary === 'true' || temporary === true
            })
        });

        console.log('✅ VNIC deletion task created successfully:');
        console.log('   - Task ID:', task.id);
        console.log('   - VNIC:', vnic);
        console.log('   - Temporary:', temporary);

        res.status(202).json({
            success: true,
            message: `VNIC deletion task created for ${vnic}`,
            task_id: task.id,
            vnic_name: vnic,
            temporary: temporary === 'true' || temporary === true
        });

        console.log('✅ VNIC deletion response sent successfully');

    } catch (error) {
        console.error('❌ Error deleting VNIC:', error);
        console.error('❌ Error stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to create VNIC deletion task',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vnics/{vnic}/stats:
 *   get:
 *     summary: Get VNIC statistics
 *     description: Returns live statistics for a specific VNIC using dladm show-vnic -s
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *       - in: query
 *         name: interval
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Interval between samples (for continuous monitoring)
 *     responses:
 *       200:
 *         description: VNIC statistics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnic:
 *                   type: string
 *                 statistics:
 *                   type: object
 *                   properties:
 *                     ipackets:
 *                       type: integer
 *                     rbytes:
 *                       type: integer
 *                     ierrors:
 *                       type: integer
 *                     opackets:
 *                       type: integer
 *                     obytes:
 *                       type: integer
 *                     oerrors:
 *                       type: integer
 *                 timestamp:
 *                   type: string
 *                   format: date-time
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC statistics
 */
export const getVNICStats = async (req, res) => {
    try {
        const { vnic } = req.params;
        const { interval = 1 } = req.query;

        // Get live statistics from dladm
        const result = await executeCommand(`pfexec dladm show-vnic ${vnic} -s -p -o link,ipackets,rbytes,ierrors,opackets,obytes,oerrors`);
        
        if (!result.success) {
            return res.status(404).json({
                error: `VNIC ${vnic} not found or failed to get statistics`,
                details: result.error
            });
        }

        const [link, ipackets, rbytes, ierrors, opackets, obytes, oerrors] = result.output.split(':');
        
        const statistics = {
            link,
            ipackets: parseInt(ipackets) || 0,
            rbytes: parseInt(rbytes) || 0,
            ierrors: parseInt(ierrors) || 0,
            opackets: parseInt(opackets) || 0,
            obytes: parseInt(obytes) || 0,
            oerrors: parseInt(oerrors) || 0
        };

        res.json({
            vnic: vnic,
            statistics: statistics,
            timestamp: new Date().toISOString(),
            interval: parseInt(interval)
        });

    } catch (error) {
        console.error('Error getting VNIC statistics:', error);
        res.status(500).json({ 
            error: 'Failed to get VNIC statistics',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vnics/{vnic}/properties:
 *   get:
 *     summary: Get VNIC properties
 *     description: Returns link properties for a specific VNIC using dladm show-linkprop
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *       - in: query
 *         name: property
 *         schema:
 *           type: string
 *         description: Specific property to get (omit for all properties)
 *     responses:
 *       200:
 *         description: VNIC properties retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 vnic:
 *                   type: string
 *                 properties:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       property:
 *                         type: string
 *                       value:
 *                         type: string
 *                       default:
 *                         type: string
 *                       possible:
 *                         type: string
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to get VNIC properties
 */
export const getVNICProperties = async (req, res) => {
    try {
        const { vnic } = req.params;
        const { property } = req.query;

        // Build command with optional property filter
        let command = `pfexec dladm show-linkprop ${vnic} -p -o property,value,default,possible`;
        if (property) {
            command += ` -p ${property}`;
        }

        const result = await executeCommand(command);
        
        if (!result.success) {
            return res.status(404).json({
                error: `VNIC ${vnic} not found or failed to get properties`,
                details: result.error
            });
        }

        const properties = result.output.split('\n')
            .filter(line => line.trim())
            .map(line => {
                const [prop, value, defaultVal, possible] = line.split(':');
                return {
                    property: prop,
                    value: value,
                    default: defaultVal,
                    possible: possible
                };
            });

        res.json({
            vnic: vnic,
            properties: properties,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error('Error getting VNIC properties:', error);
        res.status(500).json({ 
            error: 'Failed to get VNIC properties',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /network/vnics/{vnic}/properties:
 *   put:
 *     summary: Set VNIC properties
 *     description: Sets link properties for a specific VNIC using dladm set-linkprop
 *     tags: [VNIC Management]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: vnic
 *         required: true
 *         schema:
 *           type: string
 *         description: VNIC name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - properties
 *             properties:
 *               properties:
 *                 type: object
 *                 description: Properties to set (key-value pairs)
 *                 example: {"maxbw": "100M", "priority": "high"}
 *               temporary:
 *                 type: boolean
 *                 description: Set properties temporarily (not persistent)
 *                 default: false
 *               created_by:
 *                 type: string
 *                 description: User setting these properties
 *                 default: "api"
 *     responses:
 *       202:
 *         description: VNIC property update task created successfully
 *       400:
 *         description: Invalid properties
 *       404:
 *         description: VNIC not found
 *       500:
 *         description: Failed to create property update task
 */
export const setVNICProperties = async (req, res) => {
    try {
        const { vnic } = req.params;
        const { properties, temporary = false, created_by = 'api' } = req.body;

        if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) {
            return res.status(400).json({ 
                error: 'properties object is required and must contain at least one property' 
            });
        }

        // Check if VNIC exists
        const existsResult = await executeCommand(`pfexec dladm show-vnic ${vnic}`);
        if (!existsResult.success) {
            return res.status(404).json({ 
                error: `VNIC ${vnic} not found`,
                details: existsResult.error
            });
        }

        // Create task for VNIC property update
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'set_vnic_properties',
            priority: TaskPriority.NORMAL,
            created_by: created_by,
            status: 'pending',
            metadata: JSON.stringify({
                vnic: vnic,
                properties: properties,
                temporary: temporary
            })
        });

        res.status(202).json({
            success: true,
            message: `VNIC property update task created for ${vnic}`,
            task_id: task.id,
            vnic_name: vnic,
            properties: properties,
            temporary: temporary
        });

    } catch (error) {
        console.error('Error setting VNIC properties:', error);
        res.status(500).json({ 
            error: 'Failed to create VNIC property update task',
            details: error.message 
        });
    }
};
