import express from "express";
import { serverStats } from "../controllers/ServerStats.js";
import { verifyApiKey } from "../middleware/VerifyApiKey.js";
import {
    bootstrapFirstApiKey, 
    generateApiKey, 
    listApiKeys, 
    deleteApiKey,
    revokeApiKey,
    getApiKeyInfo 
} from "../controllers/ApiKeys.js";
import {
    listZones,
    getZoneDetails,
    getZoneConfig,
    startZone,
    stopZone,
    restartZone,
    deleteZone
} from "../controllers/ZoneManagement.js";
import {
    listTasks,
    getTaskDetails,
    cancelTask,
    getTaskStats
} from "../controllers/TaskQueue.js";
import {
    startVncSession,
    getVncSessionInfo,
    stopVncSession,
    listVncSessions,
    serveVncConsole,
    proxyVncContent
} from "../controllers/VncConsole.js";
import {
    getMonitoringStatus,
    getHealthCheck,
    triggerCollection,
    getNetworkInterfaces,
    getNetworkUsage,
    getIPAddresses,
    getRoutes,
    getZFSPools,
    getZFSDatasets,
    getDisks,
    getDiskIOStats,
    getPoolIOStats,
    getARCStats,
    getHostInfo,
    getMonitoringSummary,
    getCPUStats,
    getMemoryStats,
    getSystemLoadMetrics
} from "../controllers/HostMonitoringController.js";
import {
    listDevices,
    listAvailableDevices,
    getDeviceDetails,
    getDeviceCategories,
    getPPTStatus,
    triggerDeviceDiscovery
} from "../controllers/HostDevicesController.js";
import {
    getSettings,
    updateSettings,
    createConfigBackup,
    listBackups,
    restoreBackup,
    deleteBackup,
    restartServer
} from "../controllers/SettingsController.js";
import {
    listSwapAreas,
    getSwapSummary,
    addSwapArea,
    removeSwapArea,
    getHostsWithLowSwap
} from "../controllers/SwapController.js";
import { getRoot } from "../controllers/RootController.js";
import { getProvisioningStatus } from "../controllers/ProvisioningController.js";
import { 
    startTerminalSession,
    stopTerminalSession,
    getTerminalSessionInfo,
    listTerminalSessions,
    checkSessionHealth
} from "../controllers/TerminalSessionController.js";
import {
    startZloginSession,
    stopZloginSession,
    getZloginSessionInfo,
    listZloginSessions
} from "../controllers/ZloginController.js";
import {
    listServices,
    getServiceDetailsController,
    serviceAction,
    getPropertiesController
} from "../controllers/ServicesController.js";
import {
    getHostname,
    setHostname,
    getIPAddresses as getManageableIPAddresses,
    createIPAddress,
    deleteIPAddress,
    enableIPAddress,
    disableIPAddress
} from "../controllers/NetworkController.js";
import {
    getVNICs,
    getVNICDetails,
    createVNIC,
    deleteVNIC,
    getVNICStats,
    getVNICProperties,
    setVNICProperties
} from "../controllers/VnicController.js";
import {
    getAggregates,
    getAggregateDetails,
    createAggregate,
    deleteAggregate,
    modifyAggregateLinks,
    getAggregateStats
} from "../controllers/AggregateController.js";
import {
    getEtherstubs,
    getEtherstubDetails,
    createEtherstub,
    deleteEtherstub
} from "../controllers/EtherstubController.js";
import {
    getVlans,
    getVlanDetails,
    createVlan,
    deleteVlan
} from "../controllers/VlanController.js";
import {
    getBridges,
    getBridgeDetails,
    createBridge,
    deleteBridge,
    modifyBridgeLinks
} from "../controllers/BridgeController.js";
import {
    listPackages,
    searchPackages,
    getPackageInfo,
    installPackages,
    uninstallPackages
} from "../controllers/PackageController.js";
import {
    checkForUpdates,
    installUpdates,
    getUpdateHistory,
    refreshMetadata
} from "../controllers/SystemUpdateController.js";
import {
    listBootEnvironments,
    createBootEnvironment,
    deleteBootEnvironment,
    activateBootEnvironment,
    mountBootEnvironment,
    unmountBootEnvironment
} from "../controllers/BootEnvironmentController.js";
import {
    listRepositories,
    addRepository,
    removeRepository,
    modifyRepository,
    enableRepository,
    disableRepository
} from "../controllers/RepositoryController.js";
import {
    getTimeSyncStatus,
    getTimeSyncConfig,
    updateTimeSyncConfig,
    forceTimeSync,
    getTimezone,
    setTimezone,
    listTimezones,
    getAvailableTimeSyncSystems,
    switchTimeSyncSystem
} from "../controllers/TimeSyncController.js";
import {
    getARCConfig,
    updateARCConfig,
    validateARCConfig,
    resetARCConfig
} from "../controllers/ARCConfigController.js";
import {
    getFaults,
    getFaultDetails,
    getFaultManagerConfig,
    acquitFault,
    markRepaired,
    markReplaced
} from "../controllers/FaultManagementController.js";
import {
    listLogFiles,
    getLogFile,
    getFaultManagerLogs
} from "../controllers/SystemLogsController.js";
import {
    startLogStream,
    listLogStreamSessions,
    stopLogStream,
    getLogStreamInfo
} from "../controllers/LogStreamController.js";
import {
    getSyslogConfig,
    updateSyslogConfig,
    getSyslogFacilities,
    validateSyslogConfig,
    reloadSyslogService,
    switchSyslogService
} from "../controllers/SyslogController.js";
import {
    listProcesses,
    getProcessDetailsController,
    sendSignalToProcess,
    killProcessController,
    getProcessFilesController,
    getProcessStackController,
    getProcessLimitsController,
    findProcessesController,
    batchKillProcesses,
    getProcessStatsController,
    startProcessTrace
} from "../controllers/ProcessController.js";
import {
    browseDirectory,
    createFolder,
    uploadFile,
    downloadFile,
    readFile,
    writeFile,
    moveFileItem,
    copyFileItem,
    renameItem,
    deleteFileItem,
    createArchiveTask,
    extractArchiveTask
} from "../controllers/FileSystemController.js";
import { 
    uploadSingle,
    validateUploadRequest,
    handleUploadError 
} from "../middleware/FileUpload.js";
import config from "../config/ConfigLoader.js";
 
const router = express.Router();

// Provisioning Routes
router.get('/provisioning/status', verifyApiKey, getProvisioningStatus);

// Root route to display registered Zoneweaver API instances
router.get('/', getRoot);

// Get configuration for conditional routing
const statsConfig = config.get('stats') || { public_access: true };

// Public routes (no authentication required)
router.post('/api-keys/bootstrap', bootstrapFirstApiKey);  // Bootstrap endpoint for initial setup

// Conditionally public stats endpoint
if (statsConfig.public_access) {
    router.get('/stats', serverStats);  // Public access to server stats
} else {
    router.get('/stats', verifyApiKey, serverStats);  // Protected access to server stats
}

// API Key protected routes (require valid API key)
router.post('/api-keys/generate', verifyApiKey, generateApiKey);  // Generate new API key
router.get('/api-keys', verifyApiKey, listApiKeys);              // List all API keys
router.get('/api-keys/info', verifyApiKey, getApiKeyInfo);       // Get current API key info
router.delete('/api-keys/:id', verifyApiKey, deleteApiKey);      // Delete an API key
router.put('/api-keys/:id/revoke', verifyApiKey, revokeApiKey);  // Revoke an API key

// Zone Management Routes
router.get('/zones', verifyApiKey, listZones);                           // List all zones
router.get('/zones/:zoneName', verifyApiKey, getZoneDetails);            // Get zone details
router.get('/zones/:zoneName/config', verifyApiKey, getZoneConfig);      // Get zone configuration
router.post('/zones/:zoneName/start', verifyApiKey, startZone);          // Start zone
router.post('/zones/:zoneName/stop', verifyApiKey, stopZone);            // Stop zone
router.post('/zones/:zoneName/restart', verifyApiKey, restartZone);      // Restart zone
router.delete('/zones/:zoneName', verifyApiKey, deleteZone);             // Delete zone

// Task Management Routes
router.get('/tasks', verifyApiKey, listTasks);                           // List tasks
router.get('/tasks/stats', verifyApiKey, getTaskStats);                  // Get task statistics
router.get('/tasks/:taskId', verifyApiKey, getTaskDetails);              // Get task details
router.delete('/tasks/:taskId', verifyApiKey, cancelTask);               // Cancel task

// VNC Console Management Routes
router.post('/zones/:zoneName/vnc/start', verifyApiKey, startVncSession);     // Start VNC session
router.get('/zones/:zoneName/vnc/info', verifyApiKey, getVncSessionInfo);     // Get VNC session info
router.delete('/zones/:zoneName/vnc/stop', verifyApiKey, stopVncSession);     // Stop VNC session
router.get('/vnc/sessions', verifyApiKey, listVncSessions);                   // List all VNC sessions

// VNC Console Content Routes (HTTP proxy to VNC server)
router.get('/zones/:zoneName/vnc/console', verifyApiKey, serveVncConsole);    // Serve VNC console HTML
router.all('/zones/:zoneName/vnc/*', verifyApiKey, proxyVncContent);          // Proxy VNC assets (JS, CSS, images)

// Host Monitoring Routes
router.get('/monitoring/status', verifyApiKey, getMonitoringStatus);          // Get monitoring service status
router.get('/monitoring/health', verifyApiKey, getHealthCheck);               // Get monitoring health check
router.get('/monitoring/summary', verifyApiKey, getMonitoringSummary);        // Get monitoring summary
router.post('/monitoring/collect', verifyApiKey, triggerCollection);          // Trigger immediate data collection
router.get('/monitoring/host', verifyApiKey, getHostInfo);                    // Get host information

// Network Monitoring Routes
router.get('/monitoring/network/interfaces', verifyApiKey, getNetworkInterfaces);  // Get network interface data
router.get('/monitoring/network/usage', verifyApiKey, getNetworkUsage);            // Get network usage accounting data
router.get('/monitoring/network/ipaddresses', verifyApiKey, getIPAddresses);       // Get IP address assignments
router.get('/monitoring/network/routes', verifyApiKey, getRoutes);                 // Get routing table information

// Storage Monitoring Routes
router.get('/monitoring/storage/pools', verifyApiKey, getZFSPools);           // Get ZFS pool information
router.get('/monitoring/storage/datasets', verifyApiKey, getZFSDatasets);     // Get ZFS dataset information
router.get('/monitoring/storage/disks', verifyApiKey, getDisks);              // Get physical disk information
router.get('/monitoring/storage/disk-io', verifyApiKey, getDiskIOStats);      // Get disk I/O statistics
router.get('/monitoring/storage/pool-io', verifyApiKey, getPoolIOStats);      // Get pool I/O performance statistics
router.get('/monitoring/storage/arc', verifyApiKey, getARCStats);             // Get ZFS ARC statistics

// System Metrics Monitoring Routes
router.get('/monitoring/system/cpu', verifyApiKey, getCPUStats);              // Get CPU performance statistics
router.get('/monitoring/system/memory', verifyApiKey, getMemoryStats);        // Get memory usage statistics
router.get('/monitoring/system/load', verifyApiKey, getSystemLoadMetrics);    // Get system load and activity metrics

// Swap Management Routes
router.get('/system/swap/areas', verifyApiKey, listSwapAreas);                // Get detailed swap area information
router.get('/system/swap/summary', verifyApiKey, getSwapSummary);             // Get swap configuration summary
router.get('/monitoring/hosts/low-swap', verifyApiKey, getHostsWithLowSwap);  // Get hosts with high swap utilization
router.post('/system/swap/add', verifyApiKey, addSwapArea);                   // Add a new swap area
router.delete('/system/swap/remove', verifyApiKey, removeSwapArea);           // Remove a swap area

// Host Device Monitoring Routes
router.get('/host/devices', verifyApiKey, listDevices);                       // List all PCI devices
router.get('/host/devices/available', verifyApiKey, listAvailableDevices);    // List available devices for passthrough
router.get('/host/devices/categories', verifyApiKey, getDeviceCategories);    // Get device categories summary
router.get('/host/devices/:deviceId', verifyApiKey, getDeviceDetails);        // Get specific device details
router.get('/host/ppt-status', verifyApiKey, getPPTStatus);                   // Get PPT status and assignments
router.post('/host/devices/refresh', verifyApiKey, triggerDeviceDiscovery);   // Trigger device discovery

// Settings Management Routes
router.get('/settings', verifyApiKey, getSettings);                           // Get current application settings
router.put('/settings', verifyApiKey, updateSettings);                        // Update application settings
router.post('/settings/backup', verifyApiKey, createConfigBackup);            // Create a configuration backup
router.get('/settings/backups', verifyApiKey, listBackups);                   // List configuration backups
router.delete('/settings/backups/:filename', verifyApiKey, deleteBackup);     // Delete a specific backup
router.post('/settings/restore/:filename', verifyApiKey, restoreBackup);      // Restore configuration from backup
router.post('/server/restart', verifyApiKey, restartServer);                  // Restart the server (dummy endpoint)

// Terminal Routes
router.post('/terminal/start', verifyApiKey, startTerminalSession);
router.get('/terminal/sessions', verifyApiKey, listTerminalSessions);
router.get('/terminal/sessions/:terminal_cookie/health', verifyApiKey, checkSessionHealth);
router.get('/terminal/sessions/:sessionId', verifyApiKey, getTerminalSessionInfo);
router.delete('/terminal/sessions/:sessionId/stop', verifyApiKey, stopTerminalSession);

// Zlogin Routes
router.post('/zones/:zoneName/zlogin/start', verifyApiKey, startZloginSession);
router.get('/zlogin/sessions', verifyApiKey, listZloginSessions);
router.get('/zlogin/sessions/:sessionId', verifyApiKey, getZloginSessionInfo);
router.delete('/zlogin/sessions/:sessionId/stop', verifyApiKey, stopZloginSession);

// Service Management Routes (ordered from most specific to least specific)
router.get('/services', verifyApiKey, listServices);
router.post('/services/action', verifyApiKey, serviceAction);
router.get('/services/:fmri/properties', verifyApiKey, getPropertiesController);
router.get('/services/:fmri', verifyApiKey, getServiceDetailsController);

// Network Management Routes - Hostname
router.get('/network/hostname', verifyApiKey, getHostname);                       // Get current hostname
router.put('/network/hostname', verifyApiKey, setHostname);                       // Set hostname

// Network Management Routes - IP Addresses
router.get('/network/addresses', verifyApiKey, getManageableIPAddresses);         // List IP addresses
router.post('/network/addresses', verifyApiKey, createIPAddress);                 // Create IP address
router.delete('/network/addresses/*', verifyApiKey, deleteIPAddress);             // Delete IP address (captures full addrobj with slashes)
router.put('/network/addresses/*/enable', verifyApiKey, enableIPAddress);         // Enable IP address
router.put('/network/addresses/*/disable', verifyApiKey, disableIPAddress);       // Disable IP address

// VNIC Management Routes
router.get('/network/vnics', verifyApiKey, getVNICs);                            // List VNICs
router.get('/network/vnics/:vnic', verifyApiKey, getVNICDetails);                // Get VNIC details
router.post('/network/vnics', verifyApiKey, createVNIC);                         // Create VNIC
router.delete('/network/vnics/:vnic', verifyApiKey, deleteVNIC);                 // Delete VNIC
router.get('/network/vnics/:vnic/stats', verifyApiKey, getVNICStats);            // Get VNIC statistics
router.get('/network/vnics/:vnic/properties', verifyApiKey, getVNICProperties);  // Get VNIC properties
router.put('/network/vnics/:vnic/properties', verifyApiKey, setVNICProperties);  // Set VNIC properties

// Link Aggregation Management Routes
router.get('/network/aggregates', verifyApiKey, getAggregates);                  // List aggregates
router.get('/network/aggregates/:aggregate', verifyApiKey, getAggregateDetails); // Get aggregate details
router.post('/network/aggregates', verifyApiKey, createAggregate);               // Create aggregate
router.delete('/network/aggregates/:aggregate', verifyApiKey, deleteAggregate);  // Delete aggregate
router.put('/network/aggregates/:aggregate/links', verifyApiKey, modifyAggregateLinks); // Modify aggregate links
router.get('/network/aggregates/:aggregate/stats', verifyApiKey, getAggregateStats);    // Get aggregate statistics

// Etherstub Management Routes
router.get('/network/etherstubs', verifyApiKey, getEtherstubs);                  // List etherstubs
router.get('/network/etherstubs/:etherstub', verifyApiKey, getEtherstubDetails); // Get etherstub details
router.post('/network/etherstubs', verifyApiKey, createEtherstub);               // Create etherstub
router.delete('/network/etherstubs/:etherstub', verifyApiKey, deleteEtherstub);  // Delete etherstub

// VLAN Management Routes
router.get('/network/vlans', verifyApiKey, getVlans);                            // List VLANs
router.get('/network/vlans/:vlan', verifyApiKey, getVlanDetails);                // Get VLAN details
router.post('/network/vlans', verifyApiKey, createVlan);                         // Create VLAN
router.delete('/network/vlans/:vlan', verifyApiKey, deleteVlan);                 // Delete VLAN

// Bridge Management Routes
router.get('/network/bridges', verifyApiKey, getBridges);                        // List bridges
router.get('/network/bridges/:bridge', verifyApiKey, getBridgeDetails);          // Get bridge details
router.post('/network/bridges', verifyApiKey, createBridge);                     // Create bridge
router.delete('/network/bridges/:bridge', verifyApiKey, deleteBridge);          // Delete bridge
router.put('/network/bridges/:bridge/links', verifyApiKey, modifyBridgeLinks);   // Modify bridge links

// Package Management Routes
router.get('/system/packages', verifyApiKey, listPackages);                      // List installed packages
router.get('/system/packages/search', verifyApiKey, searchPackages);             // Search for packages
router.get('/system/packages/info', verifyApiKey, getPackageInfo);               // Get package information
router.post('/system/packages/install', verifyApiKey, installPackages);          // Install packages
router.post('/system/packages/uninstall', verifyApiKey, uninstallPackages);      // Uninstall packages

// System Update Management Routes
router.get('/system/updates/check', verifyApiKey, checkForUpdates);              // Check for system updates
router.post('/system/updates/install', verifyApiKey, installUpdates);            // Install system updates
router.get('/system/updates/history', verifyApiKey, getUpdateHistory);           // Get update history
router.post('/system/updates/refresh', verifyApiKey, refreshMetadata);           // Refresh package metadata

// Boot Environment Management Routes
router.get('/system/boot-environments', verifyApiKey, listBootEnvironments);     // List boot environments
router.post('/system/boot-environments', verifyApiKey, createBootEnvironment);   // Create boot environment
router.delete('/system/boot-environments/:name', verifyApiKey, deleteBootEnvironment); // Delete boot environment
router.post('/system/boot-environments/:name/activate', verifyApiKey, activateBootEnvironment); // Activate boot environment
router.post('/system/boot-environments/:name/mount', verifyApiKey, mountBootEnvironment); // Mount boot environment
router.post('/system/boot-environments/:name/unmount', verifyApiKey, unmountBootEnvironment); // Unmount boot environment

// Repository Management Routes
router.get('/system/repositories', verifyApiKey, listRepositories);              // List package repositories
router.post('/system/repositories', verifyApiKey, addRepository);                // Add package repository
router.delete('/system/repositories/:name', verifyApiKey, removeRepository);     // Remove package repository
router.put('/system/repositories/:name', verifyApiKey, modifyRepository);        // Modify package repository
router.post('/system/repositories/:name/enable', verifyApiKey, enableRepository); // Enable package repository
router.post('/system/repositories/:name/disable', verifyApiKey, disableRepository); // Disable package repository

// Time Synchronization Routes
router.get('/system/time-sync/status', verifyApiKey, getTimeSyncStatus);          // Get time sync service status
router.get('/system/time-sync/config', verifyApiKey, getTimeSyncConfig);          // Get time sync configuration
router.put('/system/time-sync/config', verifyApiKey, updateTimeSyncConfig);       // Update time sync configuration
router.post('/system/time-sync/sync', verifyApiKey, forceTimeSync);               // Force immediate time synchronization
router.get('/system/time-sync/available-systems', verifyApiKey, getAvailableTimeSyncSystems); // Get available time sync systems
router.post('/system/time-sync/switch', verifyApiKey, switchTimeSyncSystem);      // Switch between time sync systems

// Timezone Management Routes
router.get('/system/timezone', verifyApiKey, getTimezone);                        // Get current timezone
router.put('/system/timezone', verifyApiKey, setTimezone);                        // Set system timezone
router.get('/system/timezones', verifyApiKey, listTimezones);                     // List available timezones

// ZFS ARC Management Routes
router.get('/system/zfs/arc/config', verifyApiKey, getARCConfig);                 // Get ZFS ARC configuration and tunables
router.put('/system/zfs/arc/config', verifyApiKey, updateARCConfig);              // Update ZFS ARC settings
router.post('/system/zfs/arc/validate', verifyApiKey, validateARCConfig);         // Validate ZFS ARC configuration
router.post('/system/zfs/arc/reset', verifyApiKey, resetARCConfig);               // Reset ZFS ARC to defaults

// Fault Management Routes
router.get('/system/fault-management/faults', verifyApiKey, getFaults);                    // List system faults
router.get('/system/fault-management/faults/:uuid', verifyApiKey, getFaultDetails);        // Get specific fault details
router.get('/system/fault-management/config', verifyApiKey, getFaultManagerConfig);        // Get fault manager configuration
router.post('/system/fault-management/actions/acquit', verifyApiKey, acquitFault);         // Acquit a fault
router.post('/system/fault-management/actions/repaired', verifyApiKey, markRepaired);      // Mark resource as repaired
router.post('/system/fault-management/actions/replaced', verifyApiKey, markReplaced);      // Mark resource as replaced

// System Log Management Routes
router.get('/system/logs/list', verifyApiKey, listLogFiles);                               // List available log files
router.get('/system/logs/:logname', verifyApiKey, getLogFile);                             // Read specific log file
router.get('/system/logs/fault-manager/:type', verifyApiKey, getFaultManagerLogs);         // Read fault manager logs via fmdump

// Log Streaming Routes
router.post('/system/logs/:logname/stream/start', verifyApiKey, startLogStream);           // Start log stream session
router.get('/system/logs/stream/sessions', verifyApiKey, listLogStreamSessions);           // List active log stream sessions  
router.get('/system/logs/stream/:sessionId', verifyApiKey, getLogStreamInfo);              // Get log stream session info
router.delete('/system/logs/stream/:sessionId/stop', verifyApiKey, stopLogStream);         // Stop log stream session

// Syslog Configuration Management Routes
router.get('/system/syslog/config', verifyApiKey, getSyslogConfig);                        // Get syslog configuration
router.put('/system/syslog/config', verifyApiKey, updateSyslogConfig);                     // Update syslog configuration
router.get('/system/syslog/facilities', verifyApiKey, getSyslogFacilities);                // Get available facilities and levels
router.post('/system/syslog/validate', verifyApiKey, validateSyslogConfig);                // Validate syslog configuration
router.post('/system/syslog/reload', verifyApiKey, reloadSyslogService);                   // Reload syslog service
router.post('/system/syslog/switch', verifyApiKey, switchSyslogService);                   // Switch between syslog implementations

// Process Management Routes
router.get('/system/processes', verifyApiKey, listProcesses);                              // List system processes
router.get('/system/processes/find', verifyApiKey, findProcessesController);               // Find processes by pattern
router.get('/system/processes/stats', verifyApiKey, getProcessStatsController);            // Get real-time process statistics
router.post('/system/processes/batch-kill', verifyApiKey, batchKillProcesses);             // Kill multiple processes by pattern
router.post('/system/processes/trace/start', verifyApiKey, startProcessTrace);             // Start process tracing (async task)
router.get('/system/processes/:pid', verifyApiKey, getProcessDetailsController);           // Get detailed process information
router.post('/system/processes/:pid/signal', verifyApiKey, sendSignalToProcess);           // Send signal to process
router.post('/system/processes/:pid/kill', verifyApiKey, killProcessController);           // Kill a process
router.get('/system/processes/:pid/files', verifyApiKey, getProcessFilesController);       // Get open files for process
router.get('/system/processes/:pid/stack', verifyApiKey, getProcessStackController);       // Get process stack trace
router.get('/system/processes/:pid/limits', verifyApiKey, getProcessLimitsController);     // Get process resource limits

// File System Management Routes
router.get('/filesystem', verifyApiKey, browseDirectory);                                  // Browse directory contents
router.post('/filesystem/folder', verifyApiKey, createFolder);                             // Create directory
router.post('/filesystem/upload', validateUploadRequest, uploadSingle('file'), uploadFile, handleUploadError); // Upload file
router.get('/filesystem/download', verifyApiKey, downloadFile);                            // Download file
router.get('/filesystem/content', verifyApiKey, readFile);                                 // Read text file content
router.put('/filesystem/content', verifyApiKey, writeFile);                                // Write text file content
router.put('/filesystem/move', verifyApiKey, moveFileItem);                                // Move/rename item (async task)
router.post('/filesystem/copy', verifyApiKey, copyFileItem);                               // Copy item (async task)
router.patch('/filesystem/rename', verifyApiKey, renameItem);                              // Rename item
router.delete('/filesystem', verifyApiKey, deleteFileItem);                                // Delete item
router.post('/filesystem/archive/create', verifyApiKey, createArchiveTask);                // Create archive (async task)
router.post('/filesystem/archive/extract', verifyApiKey, extractArchiveTask);              // Extract archive (async task)

// NOTE: VNC and Terminal WebSocket traffic is handled by native WebSocket upgrade handler in index.js
 
export default router;
