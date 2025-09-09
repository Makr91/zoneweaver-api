/**
 * @fileoverview Host Monitoring API Controller for Zoneweaver API
 * @description Provides API endpoints for accessing collected host monitoring data
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { Op, Sequelize } from "sequelize";
import sequelize from "../config/Database.js";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import NetworkUsage from "../models/NetworkUsageModel.js";
import IPAddresses from "../models/IPAddressModel.js";
import Routes from "../models/RoutingTableModel.js";
import ZFSPools from "../models/ZFSPoolModel.js";
import ZFSDatasets from "../models/ZFSDatasetModel.js";
import Disks from "../models/DiskModel.js";
import DiskIOStats from "../models/DiskIOStatsModel.js";
import ARCStats from "../models/ARCStatsModel.js";
import PoolIOStats from "../models/PoolIOStatsModel.js";
import HostInfo from "../models/HostInfoModel.js";
import CPUStats from "../models/CPUStatsModel.js";
import MemoryStats from "../models/MemoryStatsModel.js";
import yj from "yieldable-json";
import { getHostMonitoringService } from "./HostMonitoringService.js";
import os from "os";

/**
 * @swagger
 * /monitoring/status:
 *   get:
 *     summary: Get monitoring service status
 *     description: Returns the current status of the host monitoring service including configuration and statistics
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Monitoring service status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 isRunning:
 *                   type: boolean
 *                   description: Whether the monitoring service is currently running
 *                 isInitialized:
 *                   type: boolean
 *                   description: Whether the monitoring service has been initialized
 *                 config:
 *                   type: object
 *                   description: Current monitoring configuration
 *                 stats:
 *                   type: object
 *                   description: Collection statistics and performance metrics
 *                 activeIntervals:
 *                   type: object
 *                   description: Status of collection intervals
 *       500:
 *         description: Failed to get monitoring status
 */
export const getMonitoringStatus = async (req, res) => {
    try {
        const service = getHostMonitoringService();
        const status = service.getStatus();
        res.json(status);
    } catch (error) {
        console.error('Error getting monitoring status:', error);
        res.status(500).json({ 
            error: 'Failed to get monitoring status',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/health:
 *   get:
 *     summary: Get monitoring service health check
 *     description: Returns detailed health information about the monitoring service and recent collection activity
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Health check information
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   enum: [healthy, stopped, error]
 *                   description: Overall health status
 *                 lastUpdate:
 *                   type: string
 *                   format: date-time
 *                   description: Last time host info was updated
 *                 networkErrors:
 *                   type: integer
 *                   description: Count of consecutive network scan errors
 *                 storageErrors:
 *                   type: integer
 *                   description: Count of consecutive storage scan errors
 *                 recentActivity:
 *                   type: object
 *                   description: Recent collection activity status
 *                 uptime:
 *                   type: integer
 *                   description: System uptime in seconds
 *       500:
 *         description: Failed to get health check
 */
export const getHealthCheck = async (req, res) => {
    try {
        const service = getHostMonitoringService();
        const health = await service.getHealthCheck();
        res.json(health);
    } catch (error) {
        console.error('Error getting health check:', error);
        res.status(500).json({ 
            error: 'Failed to get health check',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/collect:
 *   post:
 *     summary: Trigger immediate data collection
 *     description: Manually triggers data collection for network, storage, or all types
 *     tags: [Host Monitoring]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               type:
 *                 type: string
 *                 enum: [network, storage, all]
 *                 default: all
 *                 description: Type of collection to trigger
 *     responses:
 *       200:
 *         description: Collection triggered successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 results:
 *                   type: object
 *                   description: Collection results
 *       500:
 *         description: Failed to trigger collection
 */
export const triggerCollection = async (req, res) => {
    try {
        const { type = 'all' } = req.body;
        const service = getHostMonitoringService();
        const results = await service.triggerCollection(type);
        
        res.json({
            success: results.errors.length === 0,
            type: type,
            results: results
        });
    } catch (error) {
        console.error('Error triggering collection:', error);
        res.status(500).json({ 
            error: 'Failed to trigger collection',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/network/interfaces:
 *   get:
 *     summary: Get network interface information
 *     description: Returns network interface configuration and status data
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: host
 *         schema:
 *           type: string
 *         description: Filter by host name
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by interface state (up, down)
 *     responses:
 *       200:
 *         description: Network interface data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 interfaces:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkInterface'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *       500:
 *         description: Failed to get network interfaces
 */
export const getNetworkInterfaces = async (req, res) => {
    try {
        const { limit = 100, offset = 0, state, link } = req.query;
        
        const whereClause = {};
        if (state) whereClause.state = state;
        if (link) whereClause.link = { [Op.like]: `%${link}%` };

        const { count, rows } = await NetworkInterfaces.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['scan_timestamp', 'DESC'], ['link', 'ASC']]
        });

        res.json({
            interfaces: rows,
            totalCount: count,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: count > (parseInt(offset) + parseInt(limit))
            }
        });
        
    } catch (error) {
        console.error('Error getting network interfaces:', error);
        res.status(500).json({ 
            error: 'Failed to get network interfaces',
            details: error.message 
        });
    }
};


/**
 * @swagger
 * /monitoring/network/usage:
 *   get:
 *     summary: Get network usage accounting data
 *     description: Returns network interface usage data from network accounting
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *       - in: query
 *         name: link
 *         schema:
 *           type: string
 *         description: Filter by interface/link name
 *     responses:
 *       200:
 *         description: Network usage data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 usage:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkUsage'
 *                 totalCount:
 *                   type: integer
 *       500:
 *         description: Failed to get network usage
 */
export const getNetworkUsage = async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { limit = 100, since, link, per_interface = 'true' } = req.query;
        const requestedLimit = parseInt(limit);
        
        const selectedAttributes = [
            'link', 'scan_timestamp', 'rx_mbps', 'tx_mbps', 
            'rx_bps', 'tx_bps', 'rbytes', 'obytes', 'interface_speed_mbps', 
            'interface_class', 'time_delta_seconds', 'ipackets_delta', 'opackets_delta', 
            'rbytes_delta', 'obytes_delta', 'ierrors_delta', 'oerrors_delta', 'ipackets'
        ];

        if (per_interface === 'true') {
            
            if (!since) {
                // Path 1: Latest Records - Fast JavaScript deduplication approach
                const baseWhereClause = {};
                if (link) baseWhereClause.link = { [Op.like]: `%${link}%` };

                // Fetch recent records ordered by timestamp DESC - much faster than GROUP BY
                const recentRecords = await NetworkUsage.findAll({
                    attributes: selectedAttributes,
                    where: baseWhereClause,
                    order: [['scan_timestamp', 'DESC']]
                });

                if (recentRecords.length === 0) {
                    return res.json({
                        usage: [],
                        totalCount: 0,
                        returnedCount: 0,
                        queryTime: `${Date.now() - startTime}ms`,
                        sampling: {
                            applied: true,
                            interfaceCount: 0,
                            strategy: "latest-per-interface-fast"
                        }
                    });
                }

                // JavaScript deduplication - pick first (most recent) occurrence of each interface
                const latestPerInterface = {};
                const interfaceOrder = [];
                
                recentRecords.forEach(record => {
                    if (!latestPerInterface[record.link]) {
                        latestPerInterface[record.link] = record;
                        interfaceOrder.push(record.link);
                    }
                });

                // Convert to array and sort by interface name
                const results = interfaceOrder
                    .sort()
                    .map(link => latestPerInterface[link]);

                const interfaceCount = results.length;
                const activeInterfaces = results.filter(row => row.rx_mbps > 0 || row.tx_mbps > 0).length;

                const queryTime = Date.now() - startTime;

                res.json({
                    usage: results,
                    totalCount: results.length,
                    returnedCount: results.length,
                    queryTime: `${queryTime}ms`,
                    sampling: {
                        applied: true,
                        interfaceCount: interfaceCount,
                        samplesPerInterface: 1,
                        strategy: "latest-per-interface-fast"
                    },
                    metadata: {
                        activeInterfacesCount: activeInterfaces,
                        interfaceList: results.map(row => row.link).sort()
                    }
                });

            } else {
                // Path 2: Historical Sampling - Even distribution across time range using JavaScript
                const baseWhereClause = { 
                    scan_timestamp: { [Op.gte]: new Date(since) }
                };
                if (link) baseWhereClause.link = { [Op.like]: `%${link}%` };

                // Fetch all data within time range, grouped by interface
                const allData = await NetworkUsage.findAll({
                    attributes: selectedAttributes,
                    where: baseWhereClause,
                    order: [['link', 'ASC'], ['scan_timestamp', 'ASC']]
                });

                if (allData.length === 0) {
                    return res.json({
                        usage: [],
                        totalCount: 0,
                        returnedCount: 0,
                        queryTime: `${Date.now() - startTime}ms`,
                        sampling: {
                            applied: true,
                            interfaceCount: 0,
                            strategy: "javascript-time-sampling"
                        }
                    });
                }

                // Group data by interface
                const interfaceGroups = {};
                allData.forEach(row => {
                    if (!interfaceGroups[row.link]) {
                        interfaceGroups[row.link] = [];
                    }
                    interfaceGroups[row.link].push(row);
                });

                // Sample evenly from each interface group
                const sampledResults = [];
                const interfaceNames = Object.keys(interfaceGroups);

                interfaceNames.forEach(interfaceName => {
                    const interfaceData = interfaceGroups[interfaceName];
                    const totalRecords = interfaceData.length;
                    
                    if (totalRecords === 0) return;

                    // Calculate sampling interval
                    const interval = Math.max(1, Math.floor(totalRecords / requestedLimit));
                    
                    // Sample evenly across the data
                    for (let i = 0; i < Math.min(requestedLimit, totalRecords); i++) {
                        const index = Math.min(i * interval, totalRecords - 1);
                        sampledResults.push(interfaceData[index]);
                    }
                });

                // Sort results by interface and timestamp
                sampledResults.sort((a, b) => {
                    if (a.link !== b.link) {
                        return a.link.localeCompare(b.link);
                    }
                    return new Date(a.scan_timestamp) - new Date(b.scan_timestamp);
                });

                const interfaceCount = interfaceNames.length;
                const activeInterfaces = sampledResults.filter(row => row.rx_mbps > 0 || row.tx_mbps > 0).length;

                let timeSpan = null;
                if (sampledResults.length > 1) {
                    const timestamps = sampledResults.map(row => new Date(row.scan_timestamp)).sort();
                    const firstRecord = timestamps[0];
                    const lastRecord = timestamps[timestamps.length - 1];
                    timeSpan = {
                        start: firstRecord.toISOString(),
                        end: lastRecord.toISOString(),
                        durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60))
                    };
                }

                const queryTime = Date.now() - startTime;

                res.json({
                    usage: sampledResults,
                    totalCount: sampledResults.length,
                    returnedCount: sampledResults.length,
                    queryTime: `${queryTime}ms`,
                    sampling: {
                        applied: true,
                        interfaceCount: interfaceCount,
                        samplesPerInterface: Math.round(sampledResults.length / interfaceCount),
                        requestedSamplesPerInterface: requestedLimit,
                        strategy: "javascript-time-sampling"
                    },
                    metadata: {
                        timeSpan: timeSpan,
                        activeInterfacesCount: activeInterfaces,
                        interfaceList: interfaceNames.sort()
                    }
                });
            }

        } else {
            // Simple non-per-interface query (latest records across all interfaces)
            const whereClause = {};
            if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
            if (link) whereClause.link = { [Op.like]: `%${link}%` };
            
            const { count, rows } = await NetworkUsage.findAndCountAll({
                where: whereClause,
                attributes: selectedAttributes,
                limit: requestedLimit,
                order: [['scan_timestamp', 'DESC']]
            });

            const queryTime = Date.now() - startTime;

            res.json({
                usage: rows,
                totalCount: count,
                returnedCount: rows.length,
                queryTime: `${queryTime}ms`,
                sampling: {
                    applied: false,
                    strategy: "simple-limit-latest"
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        res.status(500).json({ 
            error: 'Failed to get network usage',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};

/**
 * @swagger
 * /monitoring/storage/pools:
 *   get:
 *     summary: Get ZFS pool information
 *     description: Returns ZFS pool status, I/O statistics, and health information
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of records to return
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: health
 *         schema:
 *           type: string
 *         description: Filter by pool health status
 *     responses:
 *       200:
 *         description: ZFS pool data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pools:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZFSPool'
 *                 totalCount:
 *                   type: integer
 *       500:
 *         description: Failed to get ZFS pools
 */
export const getZFSPools = async (req, res) => {
    try {
        const { limit = 50, pool, health } = req.query;
        
        const whereClause = {};
        if (pool) whereClause.pool = { [Op.like]: `%${pool}%` };
        if (health) whereClause.health = health;

        const { count, rows } = await ZFSPools.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['pool', 'ASC']]
        });

        res.json({
            pools: rows,
            totalCount: count
        });
    } catch (error) {
        console.error('Error getting ZFS pools:', error);
        res.status(500).json({ 
            error: 'Failed to get ZFS pools',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/storage/datasets:
 *   get:
 *     summary: Get ZFS dataset information
 *     description: Returns ZFS dataset properties, usage, and configuration
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by dataset type (filesystem, volume, snapshot)
 *       - in: query
 *         name: name
 *         schema:
 *           type: string
 *         description: Filter by dataset name (partial match)
 *     responses:
 *       200:
 *         description: ZFS dataset data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 datasets:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ZFSDataset'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *       500:
 *         description: Failed to get ZFS datasets
 */
export const getZFSDatasets = async (req, res) => {
    try {
        const { limit = 100, offset = 0, pool, type, name } = req.query;
        
        const whereClause = {};
        if (pool) whereClause.pool = pool;
        if (type) whereClause.type = type;
        if (name) whereClause.name = { [Op.like]: `%${name}%` };

        const { count, rows } = await ZFSDatasets.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['scan_timestamp', 'DESC'], ['name', 'ASC']]
        });

        res.json({
            datasets: rows,
            totalCount: count,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: count > (parseInt(offset) + parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Error getting ZFS datasets:', error);
        res.status(500).json({ 
            error: 'Failed to get ZFS datasets',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/host:
 *   get:
 *     summary: Get host information
 *     description: Returns general host information and monitoring status
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: host
 *         schema:
 *           type: string
 *         description: Specific host to query (defaults to current host)
 *     responses:
 *       200:
 *         description: Host information
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/HostInfo'
 *       404:
 *         description: Host not found
 *       500:
 *         description: Failed to get host information
 */
export const getHostInfo = async (req, res) => {
    try {
        const hostInfo = await HostInfo.findOne({
            order: [['updated_at', 'DESC']]
        });

        if (!hostInfo) {
            return res.status(404).json({ 
                error: 'Host information not found'
            });
        }

        res.json(hostInfo);
    } catch (error) {
        console.error('Error getting host info:', error);
        res.status(500).json({ 
            error: 'Failed to get host information',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/summary:
 *   get:
 *     summary: Get monitoring summary
 *     description: Returns a summary of recent monitoring data including counts and latest timestamps
 *     tags: [Host Monitoring]
 *     responses:
 *       200:
 *         description: Monitoring summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 host:
 *                   type: string
 *                   description: Host name
 *                 summary:
 *                   type: object
 *                   description: Summary statistics
 *                 lastCollected:
 *                   type: object
 *                   description: Timestamps of last data collection
 *                 recordCounts:
 *                   type: object
 *                   description: Count of records in each table
 *       500:
 *         description: Failed to get monitoring summary
 */
/**
 * @swagger
 * /monitoring/storage/disks:
 *   get:
 *     summary: Get physical disk information
 *     description: Returns physical disk inventory including serial numbers, capacities, and pool assignments
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool assignment
 *       - in: query
 *         name: available
 *         schema:
 *           type: boolean
 *         description: Filter by availability status
 *       - in: query
 *         name: type
 *         schema:
 *           type: string
 *         description: Filter by disk type (SSD, HDD)
 *     responses:
 *       200:
 *         description: Physical disk data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 disks:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Disk'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *       500:
 *         description: Failed to get disk information
 */
export const getDisks = async (req, res) => {
    try {
        const { limit = 100, offset = 0, pool, available, type } = req.query;
        
        const whereClause = {};
        if (pool) whereClause.pool_assignment = pool;
        if (available !== undefined) whereClause.is_available = available === 'true';
        if (type) whereClause.disk_type = type;

        const { count, rows } = await Disks.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['scan_timestamp', 'DESC'], ['disk_index', 'ASC']]
        });

        res.json({
            disks: rows,
            totalCount: count,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: count > (parseInt(offset) + parseInt(limit))
            }
        });
    } catch (error) {
        console.error('Error getting disk information:', error);
        res.status(500).json({ 
            error: 'Failed to get disk information',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/network/ipaddresses:
 *   get:
 *     summary: Get IP address assignments
 *     description: Returns IP address assignments from ipadm show-addr
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: interface
 *         schema:
 *           type: string
 *         description: Filter by interface name
 *       - in: query
 *         name: ip_version
 *         schema:
 *           type: string
 *           enum: [v4, v6]
 *         description: Filter by IP version
 *       - in: query
 *         name: state
 *         schema:
 *           type: string
 *         description: Filter by address state
 *     responses:
 *       200:
 *         description: IP address data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 addresses:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/IPAddress'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *       500:
 *         description: Failed to get IP addresses
 */
export const getIPAddresses = async (req, res) => {
    try {
        const { limit = 100, offset = 0, interface: iface, ip_version, state } = req.query;
        
        const whereClause = {};
        if (iface) whereClause.interface = { [Op.like]: `%${iface}%` };
        if (ip_version) whereClause.ip_version = ip_version;
        if (state) whereClause.state = state;

        // Optimize: Remove expensive COUNT query, use only existing database columns
        const rows = await IPAddresses.findAll({
            where: whereClause,
            attributes: [
                'id', 'interface', 'ip_address', 'ip_version', 'state', 'scan_timestamp',
                'addrobj', 'type', 'addr', 'prefix_length'
            ], // Only columns that actually exist in database
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['scan_timestamp', 'DESC'], ['ip_version', 'ASC'], ['interface', 'ASC']]
        });

        res.json({
            addresses: rows,
            returned: rows.length,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
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
 * /monitoring/network/routes:
 *   get:
 *     summary: Get routing table information
 *     description: Returns routing table entries from netstat -rn
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of records to skip
 *       - in: query
 *         name: interface
 *         schema:
 *           type: string
 *         description: Filter by interface name
 *       - in: query
 *         name: ip_version
 *         schema:
 *           type: string
 *           enum: [v4, v6]
 *         description: Filter by IP version
 *       - in: query
 *         name: is_default
 *         schema:
 *           type: boolean
 *         description: Filter by default routes only
 *       - in: query
 *         name: destination
 *         schema:
 *           type: string
 *         description: Filter by destination (partial match)
 *     responses:
 *       200:
 *         description: Routing table data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 routes:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Route'
 *                 totalCount:
 *                   type: integer
 *                 pagination:
 *                   type: object
 *       500:
 *         description: Failed to get routing table
 */
export const getRoutes = async (req, res) => {
    try {
        const { limit = 100, offset = 0, interface: iface, ip_version, is_default, destination } = req.query;
        
        const whereClause = {};
        if (iface) whereClause.interface = { [Op.like]: `%${iface}%` };
        if (ip_version) whereClause.ip_version = ip_version;
        if (is_default !== undefined) whereClause.is_default = is_default === 'true';
        if (destination) whereClause.destination = { [Op.like]: `%${destination}%` };

        // Optimize: Remove expensive COUNT query, use only existing database columns
        const rows = await Routes.findAll({
            where: whereClause,
            attributes: [
                'id', 'destination', 'gateway', 'interface', 'ip_version', 'is_default', 'flags', 'scan_timestamp',
                'ref', 'use', 'destination_mask'
            ], // Only columns that actually exist in database
            limit: parseInt(limit),
            offset: parseInt(offset),
            order: [['scan_timestamp', 'DESC'], ['ip_version', 'ASC'], ['is_default', 'DESC'], ['destination', 'ASC']]
        });

        res.json({
            routes: rows,
            returned: rows.length,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset)
            }
        });
    } catch (error) {
        console.error('Error getting routing table:', error);
        res.status(500).json({ 
            error: 'Failed to get routing table',
            details: error.message 
        });
    }
};

/**
 * @swagger
 * /monitoring/storage/disk-io:
 *   get:
 *     summary: Get disk I/O statistics
 *     description: Returns per-disk I/O performance metrics from zpool iostat -Hv
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: device
 *         schema:
 *           type: string
 *         description: Filter by device name (partial match)
 *     responses:
 *       200:
 *         description: Disk I/O statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 diskio:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/DiskIOStats'
 *                 totalCount:
 *                   type: integer
 *       500:
 *         description: Failed to get disk I/O statistics
 */
export const getDiskIOStats = async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { limit = 100, since, pool, device, per_device = 'true' } = req.query;
        const requestedLimit = parseInt(limit);
        
        const selectedAttributes = [
            'id', 'device_name', 'pool', 'scan_timestamp', 'read_ops', 'write_ops',
            'read_bandwidth', 'write_bandwidth', 'read_bandwidth_bytes', 'write_bandwidth_bytes',
            'read_ops_per_sec', 'write_ops_per_sec', 'alloc', 'free'
        ];

        if (per_device === 'true') {
            
            if (!since) {
                // Path 1: Latest Records - Fast JavaScript deduplication approach
                const baseWhereClause = {};
                if (pool) baseWhereClause.pool = { [Op.like]: `%${pool}%` };
                if (device) baseWhereClause.device_name = { [Op.like]: `%${device}%` };

                // Fetch recent records ordered by timestamp DESC - much faster than GROUP BY
                const recentRecords = await DiskIOStats.findAll({
                    attributes: selectedAttributes,
                    where: baseWhereClause,
                    order: [['scan_timestamp', 'DESC']]
                });

                if (recentRecords.length === 0) {
                    return res.json({
                        diskio: [],
                        totalCount: 0,
                        returnedCount: 0,
                        queryTime: `${Date.now() - startTime}ms`,
                        sampling: {
                            applied: true,
                            deviceCount: 0,
                            strategy: "latest-per-device-fast"
                        }
                    });
                }

                // JavaScript deduplication - pick first (most recent) occurrence of each device
                const latestPerDevice = {};
                const deviceOrder = [];
                
                recentRecords.forEach(record => {
                    if (!latestPerDevice[record.device_name]) {
                        latestPerDevice[record.device_name] = record;
                        deviceOrder.push(record.device_name);
                    }
                });

                // Convert to array and sort by device name
                const results = deviceOrder
                    .sort()
                    .map(deviceName => latestPerDevice[deviceName]);

                const deviceCount = results.length;
                const queryTime = Date.now() - startTime;

                res.json({
                    diskio: results,
                    totalCount: results.length,
                    returnedCount: results.length,
                    queryTime: `${queryTime}ms`,
                    sampling: {
                        applied: true,
                        deviceCount: deviceCount,
                        samplesPerDevice: 1,
                        strategy: "latest-per-device-fast"
                    }
                });

            } else {
                // Path 2: Historical Sampling - Even distribution across time range using JavaScript
                const baseWhereClause = { 
                    scan_timestamp: { [Op.gte]: new Date(since) }
                };
                if (pool) baseWhereClause.pool = { [Op.like]: `%${pool}%` };
                if (device) baseWhereClause.device_name = { [Op.like]: `%${device}%` };

                // Fetch all data within time range, grouped by device
                const allData = await DiskIOStats.findAll({
                    attributes: selectedAttributes,
                    where: baseWhereClause,
                    order: [['device_name', 'ASC'], ['scan_timestamp', 'ASC']]
                });

                if (allData.length === 0) {
                    return res.json({
                        diskio: [],
                        totalCount: 0,
                        returnedCount: 0,
                        queryTime: `${Date.now() - startTime}ms`,
                        sampling: {
                            applied: true,
                            deviceCount: 0,
                            strategy: "javascript-time-sampling"
                        }
                    });
                }

                // Group data by device
                const deviceGroups = {};
                allData.forEach(row => {
                    if (!deviceGroups[row.device_name]) {
                        deviceGroups[row.device_name] = [];
                    }
                    deviceGroups[row.device_name].push(row);
                });

                // Sample evenly from each device group
                const sampledResults = [];
                const deviceNames = Object.keys(deviceGroups);

                deviceNames.forEach(deviceName => {
                    const deviceData = deviceGroups[deviceName];
                    const totalRecords = deviceData.length;
                    
                    if (totalRecords === 0) return;

                    // Calculate sampling interval
                    const interval = Math.max(1, Math.floor(totalRecords / requestedLimit));
                    
                    // Sample evenly across the data
                    for (let i = 0; i < Math.min(requestedLimit, totalRecords); i++) {
                        const index = Math.min(i * interval, totalRecords - 1);
                        sampledResults.push(deviceData[index]);
                    }
                });

                // Sort results by device and timestamp
                sampledResults.sort((a, b) => {
                    if (a.device_name !== b.device_name) {
                        return a.device_name.localeCompare(b.device_name);
                    }
                    return new Date(a.scan_timestamp) - new Date(b.scan_timestamp);
                });

                const deviceCount = deviceNames.length;
                const queryTime = Date.now() - startTime;

                res.json({
                    diskio: sampledResults,
                    totalCount: sampledResults.length,
                    returnedCount: sampledResults.length,
                    queryTime: `${queryTime}ms`,
                    sampling: {
                        applied: true,
                        deviceCount: deviceCount,
                        samplesPerDevice: Math.round(sampledResults.length / deviceCount),
                        requestedSamplesPerDevice: requestedLimit,
                        strategy: "javascript-time-sampling"
                    }
                });
            }

        } else {
            // Simple non-per-device query (latest records across all devices)
            const whereClause = {};
            if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
            if (pool) whereClause.pool = { [Op.like]: `%${pool}%` };
            if (device) whereClause.device_name = { [Op.like]: `%${device}%` };
            
            const { count, rows } = await DiskIOStats.findAndCountAll({
                where: whereClause,
                attributes: selectedAttributes,
                limit: requestedLimit,
                order: [['scan_timestamp', 'DESC']]
            });

            const queryTime = Date.now() - startTime;

            res.json({
                diskio: rows,
                totalCount: count,
                returnedCount: rows.length,
                queryTime: `${queryTime}ms`,
                sampling: {
                    applied: false,
                    strategy: "simple-limit-latest"
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        res.status(500).json({ 
            error: 'Failed to get disk I/O statistics',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};

/**
 * @swagger
 * /monitoring/storage/pool-io:
 *   get:
 *     summary: Get pool I/O performance statistics
 *     description: Returns pool-level I/O performance metrics with latency data from zpool iostat -l -v
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *       - in: query
 *         name: pool
 *         schema:
 *           type: string
 *         description: Filter by pool name
 *       - in: query
 *         name: pool_type
 *         schema:
 *           type: string
 *         description: Filter by pool type (raidz1, raidz2, mirror)
 *     responses:
 *       200:
 *         description: Pool I/O performance data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 poolio:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PoolIOStats'
 *                 totalCount:
 *                   type: integer
 *       500:
 *         description: Failed to get pool I/O statistics
 */
export const getPoolIOStats = async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { limit = 100, since, pool, pool_type, per_pool = 'true' } = req.query;
        const requestedLimit = parseInt(limit);
        
        const selectedAttributes = [
            'id', 'pool', 'pool_type', 'scan_timestamp', 'read_ops', 'write_ops', 
            'read_bandwidth', 'write_bandwidth', 'read_bandwidth_bytes', 'write_bandwidth_bytes',
            'total_wait_read', 'total_wait_write', 'disk_wait_read', 'disk_wait_write',
            'syncq_wait_read', 'syncq_wait_write', 'asyncq_wait_read', 'asyncq_wait_write'
        ];

        if (per_pool === 'true') {
            
            if (!since) {
                // Path 1: Latest Records - Fast JavaScript deduplication approach
                const baseWhereClause = {};
                if (pool) baseWhereClause.pool = { [Op.like]: `%${pool}%` };
                if (pool_type) baseWhereClause.pool_type = pool_type;

                // Fetch recent records ordered by timestamp DESC - much faster than GROUP BY
                const recentRecords = await PoolIOStats.findAll({
                    attributes: selectedAttributes,
                    where: baseWhereClause,
                    order: [['scan_timestamp', 'DESC']]
                });

                if (recentRecords.length === 0) {
                    return res.json({
                        poolio: [],
                        totalCount: 0,
                        returnedCount: 0,
                        queryTime: `${Date.now() - startTime}ms`,
                        sampling: {
                            applied: true,
                            poolCount: 0,
                            strategy: "latest-per-pool-fast"
                        }
                    });
                }

                // JavaScript deduplication - pick first (most recent) occurrence of each pool
                const latestPerPool = {};
                const poolOrder = [];
                
                recentRecords.forEach(record => {
                    if (!latestPerPool[record.pool]) {
                        latestPerPool[record.pool] = record;
                        poolOrder.push(record.pool);
                    }
                });

                // Convert to array and sort by pool name
                const results = poolOrder
                    .sort()
                    .map(poolName => latestPerPool[poolName]);

                const poolCount = results.length;
                const queryTime = Date.now() - startTime;

                res.json({
                    poolio: results,
                    totalCount: results.length,
                    returnedCount: results.length,
                    queryTime: `${queryTime}ms`,
                    sampling: {
                        applied: true,
                        poolCount: poolCount,
                        samplesPerPool: 1,
                        strategy: "latest-per-pool-fast"
                    }
                });

            } else {
                // Path 2: Historical Sampling - Even distribution across time range using JavaScript
                const baseWhereClause = { 
                    scan_timestamp: { [Op.gte]: new Date(since) }
                };
                if (pool) baseWhereClause.pool = { [Op.like]: `%${pool}%` };
                if (pool_type) baseWhereClause.pool_type = pool_type;

                // Fetch all data within time range, grouped by pool
                const allData = await PoolIOStats.findAll({
                    attributes: selectedAttributes,
                    where: baseWhereClause,
                    order: [['pool', 'ASC'], ['scan_timestamp', 'ASC']]
                });

                if (allData.length === 0) {
                    return res.json({
                        poolio: [],
                        totalCount: 0,
                        returnedCount: 0,
                        queryTime: `${Date.now() - startTime}ms`,
                        sampling: {
                            applied: true,
                            poolCount: 0,
                            strategy: "javascript-time-sampling"
                        }
                    });
                }

                // Group data by pool
                const poolGroups = {};
                allData.forEach(row => {
                    if (!poolGroups[row.pool]) {
                        poolGroups[row.pool] = [];
                    }
                    poolGroups[row.pool].push(row);
                });

                // Sample evenly from each pool group
                const sampledResults = [];
                const poolNames = Object.keys(poolGroups);

                poolNames.forEach(poolName => {
                    const poolData = poolGroups[poolName];
                    const totalRecords = poolData.length;
                    
                    if (totalRecords === 0) return;

                    // Calculate sampling interval
                    const interval = Math.max(1, Math.floor(totalRecords / requestedLimit));
                    
                    // Sample evenly across the data
                    for (let i = 0; i < Math.min(requestedLimit, totalRecords); i++) {
                        const index = Math.min(i * interval, totalRecords - 1);
                        sampledResults.push(poolData[index]);
                    }
                });

                // Sort results by pool and timestamp
                sampledResults.sort((a, b) => {
                    if (a.pool !== b.pool) {
                        return a.pool.localeCompare(b.pool);
                    }
                    return new Date(a.scan_timestamp) - new Date(b.scan_timestamp);
                });

                const poolCount = poolNames.length;
                const queryTime = Date.now() - startTime;

                res.json({
                    poolio: sampledResults,
                    totalCount: sampledResults.length,
                    returnedCount: sampledResults.length,
                    queryTime: `${queryTime}ms`,
                    sampling: {
                        applied: true,
                        poolCount: poolCount,
                        samplesPerPool: Math.round(sampledResults.length / poolCount),
                        requestedSamplesPerPool: requestedLimit,
                        strategy: "javascript-time-sampling"
                    }
                });
            }

        } else {
            // Simple non-per-pool query (latest records across all pools)
            const whereClause = {};
            if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
            if (pool) whereClause.pool = { [Op.like]: `%${pool}%` };
            if (pool_type) whereClause.pool_type = pool_type;
            
            const { count, rows } = await PoolIOStats.findAndCountAll({
                where: whereClause,
                attributes: selectedAttributes,
                limit: requestedLimit,
                order: [['scan_timestamp', 'DESC']]
            });

            const queryTime = Date.now() - startTime;

            res.json({
                poolio: rows,
                totalCount: count,
                returnedCount: rows.length,
                queryTime: `${queryTime}ms`,
                sampling: {
                    applied: false,
                    strategy: "simple-limit-latest"
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        res.status(500).json({ 
            error: 'Failed to get pool I/O statistics',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};

/**
 * @swagger
 * /monitoring/storage/arc:
 *   get:
 *     summary: Get ZFS ARC statistics
 *     description: Returns ZFS Adaptive Replacement Cache performance metrics
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *     responses:
 *       200:
 *         description: ARC statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 arc:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/ARCStats'
 *                 totalCount:
 *                   type: integer
 *                 latest:
 *                   $ref: '#/components/schemas/ARCStats'
 *                   description: Most recent ARC statistics
 *       500:
 *         description: Failed to get ARC statistics
 */
export const getARCStats = async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { limit = 100, since } = req.query;
        const requestedLimit = parseInt(limit);
        
        const selectedAttributes = [
            'id', 'scan_timestamp', 'arc_size', 'arc_target_size', 'arc_min_size', 'arc_max_size',
            'arc_meta_used', 'arc_meta_limit', 'mru_size', 'mfu_size', 'data_size', 'metadata_size',
            'hits', 'misses', 'demand_data_hits', 'demand_data_misses', 'hit_ratio', 
            'data_demand_efficiency', 'data_prefetch_efficiency', 'l2_hits', 'l2_misses', 'l2_size'
        ];

        if (!since) {
            // Path 1: Latest Records - Get most recent system-wide ARC stats
            const latestRecord = await ARCStats.findOne({
                attributes: selectedAttributes,
                order: [['scan_timestamp', 'DESC']]
            });

            const results = latestRecord ? [latestRecord] : [];
            const queryTime = Date.now() - startTime;

            res.json({
                arc: results,
                totalCount: results.length,
                returnedCount: results.length,
                queryTime: `${queryTime}ms`,
                latest: latestRecord,
                sampling: {
                    applied: true,
                    strategy: "latest-system-wide"
                }
            });

        } else {
            // Path 2: Historical Sampling - Even distribution across time range
            const baseWhereClause = { 
                scan_timestamp: { [Op.gte]: new Date(since) }
            };

            // Fetch all data within time range
            const allData = await ARCStats.findAll({
                attributes: selectedAttributes,
                where: baseWhereClause,
                order: [['scan_timestamp', 'ASC']]
            });

            if (allData.length === 0) {
                return res.json({
                    arc: [],
                    totalCount: 0,
                    returnedCount: 0,
                    queryTime: `${Date.now() - startTime}ms`,
                    latest: null,
                    sampling: {
                        applied: true,
                        strategy: "javascript-time-sampling"
                    }
                });
            }

            // Sample evenly across the time range
            const totalRecords = allData.length;
            const interval = Math.max(1, Math.floor(totalRecords / requestedLimit));
            const sampledResults = [];

            for (let i = 0; i < Math.min(requestedLimit, totalRecords); i++) {
                const index = Math.min(i * interval, totalRecords - 1);
                sampledResults.push(allData[index]);
            }

            let timeSpan = null;
            if (sampledResults.length > 1) {
                const firstRecord = new Date(sampledResults[0].scan_timestamp);
                const lastRecord = new Date(sampledResults[sampledResults.length - 1].scan_timestamp);
                timeSpan = {
                    start: firstRecord.toISOString(),
                    end: lastRecord.toISOString(),
                    durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60))
                };
            }

            const latest = sampledResults.length > 0 ? sampledResults[sampledResults.length - 1] : null;
            const queryTime = Date.now() - startTime;

            res.json({
                arc: sampledResults,
                totalCount: sampledResults.length,
                returnedCount: sampledResults.length,
                queryTime: `${queryTime}ms`,
                latest: latest,
                sampling: {
                    applied: true,
                    samplesRequested: requestedLimit,
                    samplesReturned: sampledResults.length,
                    strategy: "javascript-time-sampling"
                },
                metadata: {
                    timeSpan: timeSpan
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        res.status(500).json({ 
            error: 'Failed to get ARC statistics',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};

/**
 * @swagger
 * /monitoring/system/cpu:
 *   get:
 *     summary: Get CPU statistics
 *     description: Returns CPU performance statistics including utilization, load averages, and process counts
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *       - in: query
 *         name: include_cores
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include per-core CPU utilization data
 *     responses:
 *       200:
 *         description: CPU statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 cpu:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/CPUStats'
 *                 totalCount:
 *                   type: integer
 *                 latest:
 *                   $ref: '#/components/schemas/CPUStats'
 *                   description: Most recent CPU statistics
 *       500:
 *         description: Failed to get CPU statistics
 */
export const getCPUStats = async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { limit = 100, since, include_cores = false } = req.query;
        const requestedLimit = parseInt(limit);
        
        const selectedAttributes = [
            'id', 'scan_timestamp', 'cpu_utilization_pct', 'load_avg_1min', 'load_avg_5min', 'load_avg_15min',
            'user_pct', 'system_pct', 'idle_pct', 'iowait_pct', 'context_switches', 'interrupts', 
            'system_calls', 'processes_running', 'processes_blocked', 'cpu_count', 'page_faults',
            'page_ins', 'page_outs'
        ];

        // Add per_core_data if requested
        if (include_cores === 'true' || include_cores === true) {
            selectedAttributes.push('per_core_data');
        }

        if (!since) {
            // Path 1: Latest Records - Get most recent system-wide CPU stats
            const latestRecord = await CPUStats.findOne({
                attributes: selectedAttributes,
                order: [['scan_timestamp', 'DESC']]
            });

            // Parse per-core data if requested and available
            if ((include_cores === 'true' || include_cores === true) && latestRecord?.per_core_data) {
                try {
                    latestRecord.dataValues.per_core_parsed = await new Promise((resolve, reject) => {
                        yj.parseAsync(latestRecord.per_core_data, (err, result) => {
                            if (err) reject(err);
                            else resolve(result);
                        });
                    });
                } catch (error) {
                    latestRecord.dataValues.per_core_parsed = null;
                }
            }

            const results = latestRecord ? [latestRecord] : [];
            const queryTime = Date.now() - startTime;

            res.json({
                cpu: results,
                totalCount: results.length,
                returnedCount: results.length,
                queryTime: `${queryTime}ms`,
                latest: latestRecord,
                sampling: {
                    applied: true,
                    strategy: "latest-system-wide"
                }
            });

        } else {
            // Path 2: Historical Sampling - Even distribution across time range
            const baseWhereClause = { 
                scan_timestamp: { [Op.gte]: new Date(since) }
            };

            // Fetch all data within time range
            const allData = await CPUStats.findAll({
                attributes: selectedAttributes,
                where: baseWhereClause,
                order: [['scan_timestamp', 'ASC']]
            });

            if (allData.length === 0) {
                return res.json({
                    cpu: [],
                    totalCount: 0,
                    returnedCount: 0,
                    queryTime: `${Date.now() - startTime}ms`,
                    latest: null,
                    sampling: {
                        applied: true,
                        strategy: "javascript-time-sampling"
                    }
                });
            }

            // Sample evenly across the time range
            const totalRecords = allData.length;
            const interval = Math.max(1, Math.floor(totalRecords / requestedLimit));
            const sampledResults = [];

            for (let i = 0; i < Math.min(requestedLimit, totalRecords); i++) {
                const index = Math.min(i * interval, totalRecords - 1);
                sampledResults.push(allData[index]);
            }

            // Parse per-core data if requested
            if (include_cores === 'true' || include_cores === true) {
                for (const row of sampledResults) {
                    if (row.per_core_data) {
                        try {
                            row.dataValues.per_core_parsed = await new Promise((resolve, reject) => {
                                yj.parseAsync(row.per_core_data, (err, result) => {
                                    if (err) reject(err);
                                    else resolve(result);
                                });
                            });
                        } catch (error) {
                            row.dataValues.per_core_parsed = null;
                        }
                    }
                }
            }

            let timeSpan = null;
            if (sampledResults.length > 1) {
                const firstRecord = new Date(sampledResults[0].scan_timestamp);
                const lastRecord = new Date(sampledResults[sampledResults.length - 1].scan_timestamp);
                timeSpan = {
                    start: firstRecord.toISOString(),
                    end: lastRecord.toISOString(),
                    durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60))
                };
            }

            const latest = sampledResults.length > 0 ? sampledResults[sampledResults.length - 1] : null;
            const queryTime = Date.now() - startTime;

            res.json({
                cpu: sampledResults,
                totalCount: sampledResults.length,
                returnedCount: sampledResults.length,
                queryTime: `${queryTime}ms`,
                latest: latest,
                sampling: {
                    applied: true,
                    samplesRequested: requestedLimit,
                    samplesReturned: sampledResults.length,
                    strategy: "javascript-time-sampling"
                },
                metadata: {
                    timeSpan: timeSpan
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        res.status(500).json({ 
            error: 'Failed to get CPU statistics',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};

/**
 * @swagger
 * /monitoring/system/memory:
 *   get:
 *     summary: Get memory statistics
 *     description: Returns memory usage statistics including RAM, swap, and ZFS ARC information
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *     responses:
 *       200:
 *         description: Memory statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 memory:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/MemoryStats'
 *                 totalCount:
 *                   type: integer
 *                 latest:
 *                   $ref: '#/components/schemas/MemoryStats'
 *                   description: Most recent memory statistics
 *       500:
 *         description: Failed to get memory statistics
 */
export const getMemoryStats = async (req, res) => {
    const startTime = Date.now();
    
    try {
        const { limit = 100, since } = req.query;
        const requestedLimit = parseInt(limit);
        
        const selectedAttributes = [
            'id', 'scan_timestamp', 'total_memory_bytes', 'used_memory_bytes', 'free_memory_bytes', 'available_memory_bytes', 
            'memory_utilization_pct', 'swap_total_bytes', 'swap_used_bytes', 'swap_free_bytes', 'swap_utilization_pct'
        ];

        if (!since) {
            // Path 1: Latest Records - Get most recent system-wide memory stats
            const latestRecord = await MemoryStats.findOne({
                attributes: selectedAttributes,
                order: [['scan_timestamp', 'DESC']]
            });

            const results = latestRecord ? [latestRecord] : [];
            const queryTime = Date.now() - startTime;

            res.json({
                memory: results,
                totalCount: results.length,
                returnedCount: results.length,
                queryTime: `${queryTime}ms`,
                latest: latestRecord,
                sampling: {
                    applied: true,
                    strategy: "latest-system-wide"
                }
            });

        } else {
            // Path 2: Historical Sampling - Even distribution across time range
            const baseWhereClause = { 
                scan_timestamp: { [Op.gte]: new Date(since) }
            };

            // Fetch all data within time range
            const allData = await MemoryStats.findAll({
                attributes: selectedAttributes,
                where: baseWhereClause,
                order: [['scan_timestamp', 'ASC']]
            });

            if (allData.length === 0) {
                return res.json({
                    memory: [],
                    totalCount: 0,
                    returnedCount: 0,
                    queryTime: `${Date.now() - startTime}ms`,
                    latest: null,
                    sampling: {
                        applied: true,
                        strategy: "javascript-time-sampling"
                    }
                });
            }

            // Sample evenly across the time range
            const totalRecords = allData.length;
            const interval = Math.max(1, Math.floor(totalRecords / requestedLimit));
            const sampledResults = [];

            for (let i = 0; i < Math.min(requestedLimit, totalRecords); i++) {
                const index = Math.min(i * interval, totalRecords - 1);
                sampledResults.push(allData[index]);
            }

            let timeSpan = null;
            if (sampledResults.length > 1) {
                const firstRecord = new Date(sampledResults[0].scan_timestamp);
                const lastRecord = new Date(sampledResults[sampledResults.length - 1].scan_timestamp);
                timeSpan = {
                    start: firstRecord.toISOString(),
                    end: lastRecord.toISOString(),
                    durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60))
                };
            }

            const latest = sampledResults.length > 0 ? sampledResults[sampledResults.length - 1] : null;
            const queryTime = Date.now() - startTime;

            res.json({
                memory: sampledResults,
                totalCount: sampledResults.length,
                returnedCount: sampledResults.length,
                queryTime: `${queryTime}ms`,
                latest: latest,
                sampling: {
                    applied: true,
                    samplesRequested: requestedLimit,
                    samplesReturned: sampledResults.length,
                    strategy: "javascript-time-sampling"
                },
                metadata: {
                    timeSpan: timeSpan
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        res.status(500).json({ 
            error: 'Failed to get memory statistics',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};

/**
 * @swagger
 * /monitoring/system/load:
 *   get:
 *     summary: Get system load metrics
 *     description: Returns system load indicators including context switches, interrupts, page faults, and system calls
 *     tags: [Host Monitoring]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of records to return
 *       - in: query
 *         name: since
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Return records since this timestamp
 *     responses:
 *       200:
 *         description: System load metrics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 load:
 *                   type: array
 *                   description: System load metrics time series
 *                   items:
 *                     type: object
 *                     properties:
 *                       timestamp:
 *                         type: string
 *                         format: date-time
 *                       load_averages:
 *                         type: object
 *                       system_activity:
 *                         type: object
 *                       memory_pressure:
 *                         type: object
 *                       process_activity:
 *                         type: object
 *                       cpu_count:
 *                         type: integer
 *                 totalCount:
 *                   type: integer
 *                 latest:
 *                   type: object
 *                   description: Most recent load metrics
 *       500:
 *         description: Failed to get system load metrics
 */
export const getSystemLoadMetrics = async (req, res) => {
    try {
        const { limit = 100, since } = req.query;
        
        const whereClause = {};
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };

        const { count, rows } = await CPUStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC']],
            attributes: [
                'scan_timestamp',
                'load_avg_1min',
                'load_avg_5min', 
                'load_avg_15min',
                'context_switches',
                'interrupts',
                'system_calls',
                'page_faults',
                'page_ins',
                'page_outs',
                'processes_running',
                'processes_blocked',
                'cpu_count'
            ]
        });

        // Transform data for load-specific charting
        const loadMetrics = rows.map(row => ({
            timestamp: row.scan_timestamp,
            load_averages: {
                one_min: row.load_avg_1min,
                five_min: row.load_avg_5min,
                fifteen_min: row.load_avg_15min
            },
            system_activity: {
                context_switches_per_sec: row.context_switches,
                interrupts_per_sec: row.interrupts,
                system_calls_per_sec: row.system_calls,
                page_faults_per_sec: row.page_faults
            },
            memory_pressure: {
                pages_in_per_sec: row.page_ins,
                pages_out_per_sec: row.page_outs
            },
            process_activity: {
                running: row.processes_running,
                blocked: row.processes_blocked
            },
            cpu_count: row.cpu_count
        }));

        // Get the latest load metrics for quick reference
        const latest = loadMetrics.length > 0 ? loadMetrics[0] : null;

        res.json({
            load: loadMetrics,
            totalCount: count,
            latest: latest,
            metadata: {
                description: "System load and activity metrics",
                metrics_included: [
                    "Load averages (1, 5, 15 min)",
                    "Context switches per second",
                    "Interrupts per second", 
                    "System calls per second",
                    "Page faults per second",
                    "Memory paging activity",
                    "Process queue status"
                ]
            }
        });
    } catch (error) {
        console.error('Error getting system load metrics:', error);
        res.status(500).json({ 
            error: 'Failed to get system load metrics',
            details: error.message 
        });
    }
};

export const getMonitoringSummary = async (req, res) => {
    const startTime = Date.now();
    console.log('🚀 Monitoring summary query started');
    
    try {
        const hostname = os.hostname();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        console.log('📊 Using optimized summary query...');
        
        // Step 1: Get host info with selective attributes
        const hostInfoQuery = Date.now();
        const hostInfo = await HostInfo.findOne({
            order: [['updated_at', 'DESC']],
            attributes: [
                'network_acct_enabled', 'network_scan_errors', 'storage_scan_errors', 'platform', 
                'uptime', 'last_network_scan', 'last_network_stats_scan', 'last_network_usage_scan', 
                'last_storage_scan'
            ]
        });
        console.log(`📊 Host info query: ${Date.now() - hostInfoQuery}ms`);

        // Step 2: Parallel count queries for the last 24 hours
        const countQuery = Date.now();
        const [
            interfaceCount,
            usageCount,
            ipAddressCount,
            routeCount,
            poolCount,
            datasetCount,
            diskCount
        ] = await Promise.all([
            NetworkInterfaces.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            NetworkUsage.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            IPAddresses.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            Routes.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            ZFSPools.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            ZFSDatasets.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            Disks.count({
                where: { 
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            })
        ]);
        console.log(`📊 Count queries: ${Date.now() - countQuery}ms`);

        // Step 3: Parallel latest timestamp queries with minimal attributes
        const latestQuery = Date.now();
        const [
            latestInterface,
            latestUsage,
            latestIPAddress,
            latestRoute,
            latestPool,
            latestDataset,
            latestDisk
        ] = await Promise.all([
            NetworkInterfaces.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            NetworkUsage.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            IPAddresses.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            Routes.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            ZFSPools.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            ZFSDatasets.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            Disks.findOne({
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            })
        ]);
        console.log(`📊 Latest timestamp queries: ${Date.now() - latestQuery}ms`);

        const queryTime = Date.now() - startTime;
        console.log(`✅ Summary query completed in ${queryTime}ms`);

        res.json({
            host: hostname,
            summary: {
                networkAccountingEnabled: hostInfo?.network_acct_enabled || false,
                networkErrors: hostInfo?.network_scan_errors || 0,
                storageErrors: hostInfo?.storage_scan_errors || 0,
                platform: hostInfo?.platform,
                uptime: hostInfo?.uptime
            },
            lastCollected: {
                networkInterfaces: hostInfo?.last_network_scan,
                networkUsage: hostInfo?.last_network_usage_scan,
                storage: hostInfo?.last_storage_scan
            },
            recordCounts: {
                networkInterfaces: interfaceCount,
                networkUsage: usageCount,
                ipAddresses: ipAddressCount,
                routes: routeCount,
                zfsPools: poolCount,
                zfsDatasets: datasetCount,
                disks: diskCount
            },
            latestData: {
                networkInterfaces: latestInterface?.scan_timestamp,
                networkUsage: latestUsage?.scan_timestamp,
                ipAddresses: latestIPAddress?.scan_timestamp,
                routes: latestRoute?.scan_timestamp,
                zfsPools: latestPool?.scan_timestamp,
                zfsDatasets: latestDataset?.scan_timestamp,
                disks: latestDisk?.scan_timestamp
            },
            queryTime: `${queryTime}ms`
        });
    } catch (error) {
        const queryTime = Date.now() - startTime;
        console.error(`❌ Summary query failed after ${queryTime}ms:`, error);
        res.status(500).json({ 
            error: 'Failed to get monitoring summary',
            details: error.message,
            queryTime: `${queryTime}ms`
        });
    }
};
