/**
 * @fileoverview Host Monitoring API Controller for Zoneweaver API
 * @description Provides API endpoints for accessing collected host monitoring data
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { Op } from "sequelize";
import NetworkInterfaces from "../models/NetworkInterfaceModel.js";
import NetworkStats from "../models/NetworkStatsModel.js";
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
        const { limit = 100, offset = 0, host, state, link } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
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
 * /monitoring/network/stats:
 *   get:
 *     summary: Get network traffic statistics
 *     description: Returns network interface traffic statistics (packets, bytes, errors)
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
 *         description: Network statistics data
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stats:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/NetworkStats'
 *                 totalCount:
 *                   type: integer
 *       500:
 *         description: Failed to get network statistics
 */
export const getNetworkStats = async (req, res) => {
    try {
        const { limit = 100, since, link, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
        if (link) whereClause.link = { [Op.like]: `%${link}%` };

        const { count, rows } = await NetworkStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['link', 'ASC']]
        });

        res.json({
            stats: rows,
            totalCount: count
        });
    } catch (error) {
        console.error('Error getting network stats:', error);
        res.status(500).json({ 
            error: 'Failed to get network statistics',
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
    console.log('🚀 Network usage query started:', { limit: req.query.limit, per_interface: req.query.per_interface });
    
    try {
        const { limit = 100, since, link, host, per_interface = 'true' } = req.query;
        const hostname = host || os.hostname();
        const requestedLimit = parseInt(limit);
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
        if (link) whereClause.link = { [Op.like]: `%${link}%` };

        // Performance optimization: Use selective attribute fetching (only existing columns)
        const selectedAttributes = [
            'id', 'link', 'scan_timestamp', 'rx_mbps', 'tx_mbps', 
            'rx_bps', 'tx_bps', 'rbytes', 'obytes', 'interface_speed_mbps', 
            'interface_class', 'time_delta_seconds', 'ipackets_delta', 'opackets_delta', 
            'ipackets'
        ];

        if (per_interface === 'true') {
            console.log('📊 Using optimized per-interface sampling...');
            
            // Step 1: Get distinct interfaces efficiently
            const interfaceQuery = Date.now();
            const distinctInterfaces = await NetworkUsage.findAll({
                where: whereClause,
                attributes: ['link'],
                group: ['link'],
                raw: true
            });
            console.log(`📊 Interface discovery: ${Date.now() - interfaceQuery}ms`);

            const interfaceNames = distinctInterfaces.map(row => row.link);
            
            if (interfaceNames.length === 0) {
                return res.json({
                    usage: [],
                    totalCount: 0,
                    returnedCount: 0,
                    queryTime: `${Date.now() - startTime}ms`,
                    optimized: true
                });
            }

            // Step 2: Parallel sampling per interface - PERFORMANCE CRITICAL
            console.log(`📊 Processing ${interfaceNames.length} interfaces in parallel...`);
            const parallelQuery = Date.now();
            
            // Apply Promise.all pattern - parallel instead of sequential
            // Each interface gets UP TO the full requestedLimit (not divided across interfaces)
            const interfaceResults = await Promise.all(
                interfaceNames.map(async (interfaceName) => {
                    const interfaceWhereClause = { ...whereClause, link: interfaceName };
                    
                    // Count records for this specific interface
                    const interfaceCount = await NetworkUsage.count({ where: interfaceWhereClause });
                    
                    if (interfaceCount <= requestedLimit) {
                        // No sampling needed - return all records for this interface
                        return await NetworkUsage.findAll({
                            where: interfaceWhereClause,
                            attributes: selectedAttributes,
                            order: [['scan_timestamp', 'ASC']]
                        });
                    } else {
                        // Apply time-bucket sampling for this interface
                        // Get time range for this interface
                        const [oldestRecord, newestRecord] = await Promise.all([
                            NetworkUsage.findOne({
                                where: interfaceWhereClause,
                                order: [['scan_timestamp', 'ASC']],
                                attributes: ['scan_timestamp']
                            }),
                            NetworkUsage.findOne({
                                where: interfaceWhereClause,
                                order: [['scan_timestamp', 'DESC']],
                                attributes: ['scan_timestamp']
                            })
                        ]);

                        if (!oldestRecord || !newestRecord) {
                            // Fallback for this interface
                            return await NetworkUsage.findAll({
                                where: interfaceWhereClause,
                                attributes: selectedAttributes,
                                order: [['scan_timestamp', 'ASC']],
                                limit: requestedLimit
                            });
                        }

                        // Calculate time buckets for this interface
                        const startTime = new Date(oldestRecord.scan_timestamp);
                        const endTime = new Date(newestRecord.scan_timestamp);
                        const timeSpan = endTime.getTime() - startTime.getTime();
                        const bucketDuration = timeSpan / requestedLimit;
                        
                        // Collect samples from time buckets for this interface
                        const bucketPromises = [];
                        for (let i = 0; i < requestedLimit; i++) {
                            const bucketStart = new Date(startTime.getTime() + (i * bucketDuration));
                            const bucketEnd = new Date(startTime.getTime() + ((i + 1) * bucketDuration));
                            
                            const bucketPromise = NetworkUsage.findOne({
                                where: {
                                    ...interfaceWhereClause,
                                    scan_timestamp: {
                                        [Op.gte]: bucketStart,
                                        [Op.lt]: bucketEnd
                                    }
                                },
                                attributes: selectedAttributes,
                                order: [['scan_timestamp', 'ASC']]
                            });
                            
                            bucketPromises.push(bucketPromise);
                        }
                        
                        const bucketResults = await Promise.all(bucketPromises);
                        
                        // Filter out null results and sort by timestamp
                        let interfaceRows = bucketResults
                            .filter(record => record !== null)
                            .sort((a, b) => new Date(a.scan_timestamp) - new Date(b.scan_timestamp));
                        
                        // Fill gaps if needed for this interface
                        if (interfaceRows.length < requestedLimit * 0.7) {
                            const existingTimestamps = new Set(interfaceRows.map(r => r.scan_timestamp.getTime()));
                            const additionalNeeded = requestedLimit - interfaceRows.length;
                            
                            const additionalRecords = await NetworkUsage.findAll({
                                where: interfaceWhereClause,
                                attributes: selectedAttributes,
                                order: [['scan_timestamp', 'ASC']],
                                limit: additionalNeeded * 2
                            });
                            
                            const additionalFiltered = additionalRecords.filter(record => 
                                !existingTimestamps.has(record.scan_timestamp.getTime())
                            ).slice(0, additionalNeeded);
                            
                            interfaceRows = [...interfaceRows, ...additionalFiltered]
                                .sort((a, b) => new Date(a.scan_timestamp) - new Date(b.scan_timestamp));
                        }
                        
                        return interfaceRows;
                    }
                })
            );
            
            console.log(`📊 Parallel interface queries: ${Date.now() - parallelQuery}ms`);

            // Step 3: Combine and sort results
            const allRows = interfaceResults
                .flat()
                .sort((a, b) => new Date(a.scan_timestamp) - new Date(b.scan_timestamp));

            // Step 4: Get total count efficiently (single query)
            const totalCount = await NetworkUsage.count({ where: whereClause });

            const queryTime = Date.now() - startTime;
            console.log(`✅ Per-interface query completed in ${queryTime}ms: ${allRows.length} records from ${interfaceNames.length} interfaces`);

            // Calculate metadata
            const activeInterfaces = allRows.reduce((acc, row) => {
                if (row.rx_mbps > 0 || row.tx_mbps > 0) {
                    acc.add(row.link);
                }
                return acc;
            }, new Set()).size;

            let timeSpan = null;
            if (allRows.length > 1) {
                const firstRecord = new Date(allRows[0].scan_timestamp);
                const lastRecord = new Date(allRows[allRows.length - 1].scan_timestamp);
                timeSpan = {
                    start: firstRecord.toISOString(),
                    end: lastRecord.toISOString(),
                    durationMinutes: Math.round((lastRecord - firstRecord) / (1000 * 60))
                };
            }

            res.json({
                usage: allRows,
                totalCount: totalCount,
                returnedCount: allRows.length,
                queryTime: `${queryTime}ms`,
                optimized: true,
                sampling: {
                    applied: true,
                    interfaceCount: interfaceNames.length,
                    maxSamplesPerInterface: requestedLimit,
                    strategy: "optimized-parallel-sampling"
                },
                metadata: {
                    timeSpan: timeSpan,
                    activeInterfacesCount: activeInterfaces,
                    interfaceList: interfaceNames
                }
            });

        } else {
            // Simple non-per-interface query for comparison/fallback
            console.log('📊 Using simple query approach...');
            
            const simpleQuery = Date.now();
            const { count, rows } = await NetworkUsage.findAndCountAll({
                where: whereClause,
                attributes: selectedAttributes,
                limit: requestedLimit,
                order: [['scan_timestamp', 'DESC']]
            });
            console.log(`📊 Simple query: ${Date.now() - simpleQuery}ms`);

            const queryTime = Date.now() - startTime;
            console.log(`✅ Simple query completed in ${queryTime}ms: ${rows.length} records`);

            res.json({
                usage: rows,
                totalCount: count,
                returnedCount: rows.length,
                queryTime: `${queryTime}ms`,
                optimized: true,
                sampling: {
                    applied: false,
                    strategy: "simple-limit"
                }
            });
        }
    } catch (error) {
        const queryTime = Date.now() - startTime;
        console.error(`❌ Network usage query failed after ${queryTime}ms:`, error);
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
        const { limit = 50, pool, health, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
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
        const { limit = 100, offset = 0, pool, type, name, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
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
        const { host } = req.query;
        const hostname = host || os.hostname();
        
        const hostInfo = await HostInfo.findOne({
            where: { host: hostname }
        });

        if (!hostInfo) {
            return res.status(404).json({ 
                error: 'Host not found',
                host: hostname 
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
        const { limit = 100, offset = 0, pool, available, type, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
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
        const { limit = 100, offset = 0, interface: iface, ip_version, state, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (iface) whereClause.interface = { [Op.like]: `%${iface}%` };
        if (ip_version) whereClause.ip_version = ip_version;
        if (state) whereClause.state = state;

        // Optimize: Remove expensive COUNT query, include all frontend-required fields
        const rows = await IPAddresses.findAll({
            where: whereClause,
            attributes: [
                'id', 'interface', 'address_object', 'ip_address', 'ip_version', 'state', 'scan_timestamp',
                'prefix_length', 'netmask', 'prefix', 'type', 'family', 'status', 'addrobj', 'address', 'addr', 'name'
            ], // Complete frontend requirements
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
        const { limit = 100, offset = 0, interface: iface, ip_version, is_default, destination, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (iface) whereClause.interface = { [Op.like]: `%${iface}%` };
        if (ip_version) whereClause.ip_version = ip_version;
        if (is_default !== undefined) whereClause.is_default = is_default === 'true';
        if (destination) whereClause.destination = { [Op.like]: `%${destination}%` };

        // Optimize: Remove expensive COUNT query, include all frontend-required fields
        const rows = await Routes.findAll({
            where: whereClause,
            attributes: [
                'id', 'destination', 'gateway', 'interface', 'ip_version', 'is_default', 'flags', 'scan_timestamp',
                'metric', 'type', 'dest', 'gw', 'iface'
            ], // Complete frontend requirements
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
    try {
        const { limit = 100, since, pool, device, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
        if (pool) whereClause.pool = { [Op.like]: `%${pool}%` };
        if (device) whereClause.device_name = { [Op.like]: `%${device}%` };

        const { count, rows } = await DiskIOStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['pool', 'ASC'], ['device_name', 'ASC']]
        });

        res.json({
            diskio: rows,
            totalCount: count
        });
    } catch (error) {
        console.error('Error getting disk I/O statistics:', error);
        res.status(500).json({ 
            error: 'Failed to get disk I/O statistics',
            details: error.message 
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
    try {
        const { limit = 100, since, pool, pool_type, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };
        if (pool) whereClause.pool = { [Op.like]: `%${pool}%` };
        if (pool_type) whereClause.pool_type = pool_type;

        const { count, rows } = await PoolIOStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC'], ['pool', 'ASC']]
        });

        res.json({
            poolio: rows,
            totalCount: count
        });
    } catch (error) {
        console.error('Error getting pool I/O statistics:', error);
        res.status(500).json({ 
            error: 'Failed to get pool I/O statistics',
            details: error.message 
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
    try {
        const { limit = 100, since, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };

        const { count, rows } = await ARCStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC']]
        });

        // Get the latest ARC stats for quick reference
        const latest = rows.length > 0 ? rows[0] : null;

        res.json({
            arc: rows,
            totalCount: count,
            latest: latest
        });
    } catch (error) {
        console.error('Error getting ARC statistics:', error);
        res.status(500).json({ 
            error: 'Failed to get ARC statistics',
            details: error.message 
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
    try {
        const { limit = 100, since, host, include_cores = false } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };

        const { count, rows } = await CPUStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC']]
        });

        // Parse per-core data if requested
        if (include_cores === 'true' || include_cores === true) {
            rows.forEach(row => {
                if (row.per_core_data) {
                    try {
                        row.dataValues.per_core_parsed = JSON.parse(row.per_core_data);
                    } catch (error) {
                        console.warn('Failed to parse per-core data:', error.message);
                        row.dataValues.per_core_parsed = null;
                    }
                }
            });
        }

        // Get the latest CPU stats for quick reference
        const latest = rows.length > 0 ? rows[0] : null;

        res.json({
            cpu: rows,
            totalCount: count,
            latest: latest
        });
    } catch (error) {
        console.error('Error getting CPU statistics:', error);
        res.status(500).json({ 
            error: 'Failed to get CPU statistics',
            details: error.message 
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
    try {
        const { limit = 100, since, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
        if (since) whereClause.scan_timestamp = { [Op.gte]: new Date(since) };

        const { count, rows } = await MemoryStats.findAndCountAll({
            where: whereClause,
            limit: parseInt(limit),
            order: [['scan_timestamp', 'DESC']]
        });

        // Get the latest memory stats for quick reference
        const latest = rows.length > 0 ? rows[0] : null;

        res.json({
            memory: rows,
            totalCount: count,
            latest: latest
        });
    } catch (error) {
        console.error('Error getting memory statistics:', error);
        res.status(500).json({ 
            error: 'Failed to get memory statistics',
            details: error.message 
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
        const { limit = 100, since, host } = req.query;
        const hostname = host || os.hostname();
        
        const whereClause = { host: hostname };
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
    try {
        const hostname = os.hostname();
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Get host info
        const hostInfo = await HostInfo.findOne({
            where: { host: hostname }
        });

        // Get record counts for the last 24 hours
        const [
            interfaceCount,
            statsCount,
            usageCount,
            ipAddressCount,
            routeCount,
            poolCount,
            datasetCount,
            diskCount
        ] = await Promise.all([
            NetworkInterfaces.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            NetworkStats.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            NetworkUsage.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            IPAddresses.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            Routes.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            ZFSPools.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            ZFSDatasets.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            }),
            Disks.count({
                where: { 
                    host: hostname,
                    scan_timestamp: { [Op.gte]: oneDayAgo }
                }
            })
        ]);

        // Get latest timestamps
        const [
            latestInterface,
            latestStats,
            latestUsage,
            latestIPAddress,
            latestRoute,
            latestPool,
            latestDataset,
            latestDisk
        ] = await Promise.all([
            NetworkInterfaces.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            NetworkStats.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            NetworkUsage.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            IPAddresses.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            Routes.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            ZFSPools.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            ZFSDatasets.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            }),
            Disks.findOne({
                where: { host: hostname },
                order: [['scan_timestamp', 'DESC']],
                attributes: ['scan_timestamp']
            })
        ]);

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
                networkStats: hostInfo?.last_network_stats_scan,
                networkUsage: hostInfo?.last_network_usage_scan,
                storage: hostInfo?.last_storage_scan
            },
            recordCounts: {
                networkInterfaces: interfaceCount,
                networkStats: statsCount,
                networkUsage: usageCount,
                ipAddresses: ipAddressCount,
                routes: routeCount,
                zfsPools: poolCount,
                zfsDatasets: datasetCount,
                disks: diskCount
            },
            latestData: {
                networkInterfaces: latestInterface?.scan_timestamp,
                networkStats: latestStats?.scan_timestamp,
                networkUsage: latestUsage?.scan_timestamp,
                ipAddresses: latestIPAddress?.scan_timestamp,
                routes: latestRoute?.scan_timestamp,
                zfsPools: latestPool?.scan_timestamp,
                zfsDatasets: latestDataset?.scan_timestamp,
                disks: latestDisk?.scan_timestamp
            }
        });
    } catch (error) {
        console.error('Error getting monitoring summary:', error);
        res.status(500).json({ 
            error: 'Failed to get monitoring summary',
            details: error.message 
        });
    }
};
