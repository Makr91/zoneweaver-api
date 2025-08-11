import { spawn } from "child_process";
import VncSessions from "../models/VncSessionModel.js";
import Zones from "../models/ZoneModel.js";
import { Op } from "sequelize";
import net from "net";
import db from "../config/Database.js";
import fs from 'fs';
import path from 'path';

/**
 * @fileoverview VNC Console controller for Zoneweaver API
 * @description Manages VNC console sessions and proxy connections for zone access using simple PID file approach
 */

/**
 * VNC port range configuration
 * Using 8000-8100 range to avoid browser port restrictions
 */
const VNC_PORT_RANGE = {
    start: 8000,
    end: 8100
};

/**
 * VNC session timeout (30 minutes)
 */
const VNC_SESSION_TIMEOUT = 30 * 60 * 1000;

/**
 * Simple in-memory cache for VNC static assets
 * @description Caches frequently requested assets like CSS, JS, images to avoid repeated proxy calls
 */
class VncAssetCache {
    constructor() {
        this.cache = new Map();
        this.maxSize = 50; // Cache up to 50 assets
        this.maxAge = 5 * 60 * 1000; // 5 minutes cache
    }
    
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        // Check if expired
        if (Date.now() - item.timestamp > this.maxAge) {
            this.cache.delete(key);
            return null;
        }
        
        return item;
    }
    
    set(key, data, contentType) {
        // If cache is full, remove oldest item
        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }
        
        this.cache.set(key, {
            data,
            contentType,
            timestamp: Date.now()
        });
    }
    
    clear() {
        this.cache.clear();
    }
    
    getStats() {
        return {
            size: this.cache.size,
            maxSize: this.maxSize,
            keys: Array.from(this.cache.keys())
        };
    }
}

/**
 * Global VNC asset cache instance
 */
const vncAssetCache = new VncAssetCache();

/**
 * Common noVNC assets to preload for instant cache hits
 * This list covers the most frequently requested assets
 */
const COMMON_VNC_ASSETS = [
    'app/styles/base.css',
    'app/styles/input.css',
    'app/ui.js',
    'app/error-handler.js',
    'app/localization.js',
    'app/webutil.js',
    'core/util/logging.js',
    'core/util/browser.js',
    'core/util/events.js',
    'core/util/int.js',
    'core/util/strings.js',
    'core/util/element.js',
    'core/util/eventtarget.js',
    'core/util/cursor.js',
    'core/input/keysym.js',
    'core/input/keysymdef.js',
    'core/input/keyboard.js',
    'core/input/util.js',
    'core/input/xtscancodes.js',
    'core/input/gesturehandler.js',
    'core/input/vkeys.js',
    'core/input/fixedkeys.js',
    'core/input/domkeytable.js',
    'core/rfb.js',
    'core/display.js',
    'core/websock.js',
    'core/inflator.js',
    'core/deflator.js',
    'core/encodings.js',
    'core/ra2.js',
    'core/base64.js',
    'core/crypto/crypto.js',
    'core/crypto/aes.js',
    'core/crypto/des.js',
    'core/crypto/rsa.js',
    'core/crypto/dh.js',
    'core/crypto/md5.js',
    'core/crypto/bigint.js',
    'core/decoders/raw.js',
    'core/decoders/copyrect.js',
    'core/decoders/rre.js',
    'core/decoders/hextile.js',
    'core/decoders/tight.js',
    'core/decoders/tightpng.js',
    'core/decoders/zrle.js',
    'core/decoders/jpeg.js',
    'vendor/pako/lib/zlib/inflate.js',
    'vendor/pako/lib/zlib/deflate.js',
    'vendor/pako/lib/zlib/zstream.js',
    'vendor/pako/lib/utils/common.js',
    'vendor/pako/lib/zlib/adler32.js',
    'vendor/pako/lib/zlib/crc32.js',
    'vendor/pako/lib/zlib/inffast.js',
    'vendor/pako/lib/zlib/inftrees.js',
    'vendor/pako/lib/zlib/trees.js',
    'vendor/pako/lib/zlib/messages.js',
    // Common images
    'app/images/connect.svg',
    'app/images/disconnect.svg',
    'app/images/settings.svg',
    'app/images/fullscreen.svg',
    'app/images/clipboard.svg',
    'app/images/keyboard.svg',
    'app/images/power.svg',
    'app/images/ctrl.svg',
    'app/images/alt.svg',
    'app/images/windows.svg',
    'app/images/tab.svg',
    'app/images/esc.svg',
    'app/images/ctrlaltdel.svg',
    'app/images/toggleextrakeys.svg',
    'app/images/expander.svg',
    'app/images/drag.svg',
    'app/images/handle.svg',
    'app/images/handle_bg.svg',
    'app/images/info.svg',
    'app/images/warning.svg',
    'app/images/error.svg'
];

/**
 * Warm the cache by preloading common VNC assets in parallel
 * @param {number} port - VNC server port
 * @returns {Promise<number>} - Number of assets successfully cached
 */
const warmVncAssetCache = async (port) => {
    console.log(`🔥 WARMING VNC CACHE: Preloading ${COMMON_VNC_ASSETS.length} common assets on port ${port}...`);
    
    const startTime = Date.now();
    let cachedCount = 0;
    
    // Create parallel fetch promises for all assets
    const fetchPromises = COMMON_VNC_ASSETS.map(async (assetPath) => {
        try {
            // Skip if already cached
            if (vncAssetCache.get(assetPath)) {
                return false;
            }
            
            const vncUrl = `http://127.0.0.1:${port}/${assetPath}`;
            const response = await fetch(vncUrl);
            
            if (!response.ok) {
                return false; // Asset doesn't exist or failed to load
            }
            
            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            const contentLength = response.headers.get('content-length');
            
            // Only cache if it's a reasonable size (under 1MB)
            if (contentLength && parseInt(contentLength) < 1024 * 1024) {
                const buffer = Buffer.from(await response.arrayBuffer());
                vncAssetCache.set(assetPath, buffer, contentType);
                console.log(`🔥 WARMED: ${assetPath} (${buffer.length} bytes)`);
                return true;
            }
            
            return false;
            
        } catch (error) {
            // Silently ignore errors during cache warming
            return false;
        }
    });
    
    // Wait for all parallel fetches to complete
    const results = await Promise.all(fetchPromises);
    cachedCount = results.filter(success => success).length;
    
    const elapsed = Date.now() - startTime;
    console.log(`🔥 CACHE WARMING COMPLETE: ${cachedCount}/${COMMON_VNC_ASSETS.length} assets cached in ${elapsed}ms`);
    
    return cachedCount;
};


/**
 * Simple VNC Session Manager using PID files (similar to Ruby approach)
 * Much simpler and more reliable than complex state machines
 */
class VncSessionManager {
    constructor() {
        this.pidDir = './vnc_sessions';
        // Ensure PID directory exists
        if (!fs.existsSync(this.pidDir)) {
            fs.mkdirSync(this.pidDir, { recursive: true });
        }
    }
    
    /**
     * Get PID file path for a zone
     * @param {string} zoneName - Zone name
     * @returns {string} - PID file path
     */
    getPidFilePath(zoneName) {
        return path.join(this.pidDir, `${zoneName}.pid`);
    }
    
    /**
     * Check if a process is actually running using system process list
     * @param {number} pid - Process ID
     * @param {boolean} isNewProcess - If true, be more lenient for newly spawned processes
     * @returns {Promise<boolean>} - True if process is running
     */
    async isProcessRunning(pid, isNewProcess = false) {
        // For newly spawned processes, add a small delay to let the process settle
        if (isNewProcess) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        return new Promise((resolve) => {
            const ps = spawn('ps', ['-p', pid.toString()], { stdio: ['ignore', 'pipe', 'ignore'] });
            let found = false;
            
            ps.stdout.on('data', (data) => {
                const output = data.toString();
                if (output.includes(pid.toString())) {
                    found = true;
                }
            });
            
            ps.on('exit', (code) => {
                // ps returns 0 if process found, 1 if not found
                if (code === 0 || found) {
                    resolve(true);
                } else if (isNewProcess) {
                    // For new processes, be more lenient and assume they're still starting
                    console.log(`⚠️ Process ${pid} not found in ps output, but treating as running (new process)`);
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
            
            ps.on('error', () => {
                if (isNewProcess) {
                    console.log(`⚠️ Error checking process ${pid}, but treating as running (new process)`);
                    resolve(true);
                } else {
                    resolve(false);
                }
            });
            
            // Timeout after 3 seconds for new processes, 2 for existing
            const timeout = isNewProcess ? 3000 : 2000;
            setTimeout(() => {
                ps.kill();
                if (isNewProcess) {
                    console.log(`⚠️ Timeout checking process ${pid}, but treating as running (new process)`);
                    resolve(true);
                } else {
                    resolve(false);
                }
            }, timeout);
        });
    }
    
    /**
     * Get session info from PID file
     * @param {string} zoneName - Zone name
     * @returns {Promise<Object|null>} - Session info or null if not found/invalid
     */
    async getSessionInfo(zoneName) {
        const pidFile = this.getPidFilePath(zoneName);
        
        if (!fs.existsSync(pidFile)) {
            return null;
        }
        
        try {
            const lines = fs.readFileSync(pidFile, 'utf8').trim().split('\n');
            if (lines.length < 5) {
                // Invalid PID file, clean it up
                fs.unlinkSync(pidFile);
                return null;
            }
            
            const [pid, command, timestamp, vmname, netport] = lines;
            const pidNum = parseInt(pid);
            
            // Check if this is a recently created session (within last 2 minutes)
            const sessionAge = Date.now() - new Date(timestamp).getTime();
            const isNewProcess = sessionAge < 2 * 60 * 1000; // 2 minutes
            
            if (isNewProcess) {
                console.log(`🕒 Session for ${zoneName} is recent (${Math.round(sessionAge / 1000)}s old), using lenient process check`);
            }
            
            // Check if process is actually running (with leniency for new processes)
            const isRunning = await this.isProcessRunning(pidNum, isNewProcess);
            if (!isRunning) {
                console.log(`📁 PID file exists but process ${pidNum} is dead, cleaning up ${zoneName}`);
                fs.unlinkSync(pidFile);
                return null;
            }
            
            return {
                pid: pidNum,
                command,
                timestamp,
                vmname,
                netport,
                port: parseInt(netport.split(':')[1])
            };
        } catch (error) {
            console.warn(`Error reading PID file for ${zoneName}:`, error.message);
            // Clean up corrupted PID file
            try {
                fs.unlinkSync(pidFile);
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
            return null;
        }
    }
    
    /**
     * Write session info to PID file
     * @param {string} zoneName - Zone name
     * @param {number} pid - Process ID
     * @param {string} command - Command used
     * @param {string} netport - Network port (ip:port)
     */
    writeSessionInfo(zoneName, pid, command, netport) {
        const pidFile = this.getPidFilePath(zoneName);
        const timestamp = new Date().toISOString();
        const content = `${pid}\n${command}\n${timestamp}\n${zoneName}\n${netport}`;
        
        fs.writeFileSync(pidFile, content);
        console.log(`📁 Session info written to ${pidFile}`);
    }
    
    /**
     * Kill session and clean up PID file
     * @param {string} zoneName - Zone name
     * @returns {Promise<boolean>} - True if session was killed
     */
    async killSession(zoneName) {
        const sessionInfo = await this.getSessionInfo(zoneName);
        
        if (!sessionInfo) {
            console.log(`No active session found for ${zoneName}`);
            return false;
        }
        
        try {
            console.log(`🔫 Killing VNC session for ${zoneName} (PID: ${sessionInfo.pid}) using pfexec...`);
            
            // Use pfexec to kill the process immediately with SIGKILL
            const killProcess = spawn('pfexec', ['kill', '-9', sessionInfo.pid.toString()], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            return new Promise((resolve) => {
                let stdout = '';
                let stderr = '';
                
                killProcess.stdout.on('data', (data) => {
                    stdout += data.toString();
                });
                
                killProcess.stderr.on('data', (data) => {
                    stderr += data.toString();
                });
                
                killProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`✅ Successfully killed VNC session for ${zoneName} (PID: ${sessionInfo.pid})`);
                        
                        // Remove PID file
                        const pidFile = this.getPidFilePath(zoneName);
                        if (fs.existsSync(pidFile)) {
                            fs.unlinkSync(pidFile);
                            console.log(`📁 Removed PID file for ${zoneName}`);
                        }
                        
                        resolve(true);
                    } else {
                        console.error(`❌ Failed to kill VNC session for ${zoneName} (PID: ${sessionInfo.pid}), exit code: ${code}`);
                        console.error(`   stdout: ${stdout}`);
                        console.error(`   stderr: ${stderr}`);
                        resolve(false);
                    }
                });
                
                killProcess.on('error', (error) => {
                    console.error(`Error killing session for ${zoneName}:`, error.message);
                    resolve(false);
                });
                
                // Timeout after 5 seconds
                setTimeout(() => {
                    console.warn(`Timeout killing session for ${zoneName}, assuming success`);
                    killProcess.kill();
                    
                    // Remove PID file anyway
                    const pidFile = this.getPidFilePath(zoneName);
                    if (fs.existsSync(pidFile)) {
                        fs.unlinkSync(pidFile);
                        console.log(`📁 Removed PID file for ${zoneName} (timeout cleanup)`);
                    }
                    
                    resolve(true);
                }, 5000);
            });
            
        } catch (error) {
            console.error(`Error killing session for ${zoneName}:`, error.message);
            return false;
        }
    }
    
    /**
     * Check if zone has an active session
     * @param {string} zoneName - Zone name
     * @returns {Promise<boolean>} - True if session is active
     */
    async hasActiveSession(zoneName) {
        const sessionInfo = await this.getSessionInfo(zoneName);
        return sessionInfo !== null;
    }
    
    /**
     * Clean up all stale PID files on startup
     */
    async cleanupStaleSessions() {
        if (!fs.existsSync(this.pidDir)) {
            return;
        }
        
        const pidFiles = fs.readdirSync(this.pidDir).filter(file => file.endsWith('.pid'));
        let cleanedCount = 0;
        
        for (const pidFile of pidFiles) {
            const zoneName = pidFile.replace('.pid', '');
            const sessionInfo = await this.getSessionInfo(zoneName);
            
            if (!sessionInfo) {
                cleanedCount++;
                console.log(`Cleaned up stale PID file for ${zoneName}`);
            }
        }
        
        console.log(`VNC startup cleanup: ${cleanedCount} stale sessions cleaned`);
    }
}

/**
 * Global session manager instance
 */
const sessionManager = new VncSessionManager();

/**
 * Export session manager for use in WebSocket upgrade handler
 */
export { sessionManager };

/**
 * Validate zone name for security
 * @param {string} zoneName - Zone name to validate
 * @returns {boolean} True if valid
 */
const validateZoneName = (zoneName) => {
    const validPattern = /^[a-zA-Z0-9\-_.]+$/;
    return validPattern.test(zoneName) && zoneName.length <= 64;
};

/**
 * Check if port is available using multiple methods
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} True if port is available
 */
const isPortAvailable = async (port) => {
    // Method 1: Check for existing zadm processes using this port
    const isPortInUseByZadm = await new Promise((resolve) => {
        const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';
        
        ps.stdout.on('data', (data) => {
            output += data.toString();
        });
        
        ps.on('exit', () => {
            const lines = output.split('\n');
            const zadmProcesses = lines.filter(line => 
                line.includes('zadm vnc') && line.includes(`-w 0.0.0.0:${port} `)
            );
            
            if (zadmProcesses.length > 0) {
                console.log(`Port ${port} is not available (zadm process found):`);
                zadmProcesses.forEach(proc => console.log(`  ${proc.trim()}`));
                resolve(true);
            } else {
                resolve(false);
            }
        });
        
        ps.on('error', () => resolve(false));
    });
    
    if (isPortInUseByZadm) {
        return false;
    }
    
    // Method 2: Check database for existing sessions using this port
    try {
        const existingSession = await VncSessions.findOne({
            where: { web_port: port, status: 'active' }
        });
        
        if (existingSession) {
            console.log(`Port ${port} is not available (active VNC session in database)`);
            return false;
        }
    } catch (dbError) {
        console.warn(`Failed to check database for port ${port}:`, dbError.message);
    }
    
    // Method 3: Try to bind to the port
    const canBind = await new Promise((resolve) => {
        const server = net.createServer();
        server.listen(port, () => {
            server.once('close', () => resolve(true));
            server.close();
        });
        server.on('error', () => resolve(false));
    });
    
    if (!canBind) {
        console.log(`Port ${port} is not available (bind test failed)`);
        return false;
    }
    
    console.log(`Port ${port} is available`);
    return true;
};

/**
 * Find an available port in the VNC range
 * @returns {Promise<number>} Available port number
 */
const findAvailablePort = async () => {
    for (let port = VNC_PORT_RANGE.start; port <= VNC_PORT_RANGE.end; port++) {
        if (await isPortAvailable(port)) {
            console.log(`Found available port ${port}`);
            return port;
        }
    }
    
    throw new Error('No available ports in VNC range');
};

/**
 * Test if VNC web server is responding
 * @param {number} port - Port to test
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<boolean>} True if server is responding
 */
const testVncConnection = async (port, maxRetries = 10) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/`);
            if (response.status === 200) return true;
        } catch (error) {
            // Connection not ready yet
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
};

/**
 * @swagger
 * /zones/{zoneName}/vnc/start:
 *   post:
 *     summary: Start VNC console session
 *     description: Starts a VNC console session for the specified zone
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC session started successfully
 *       400:
 *         description: Invalid zone name or zone not running
 *       404:
 *         description: Zone not found
 *       409:
 *         description: VNC session already active
 *       500:
 *         description: Failed to start VNC session
 */
export const startVncSession = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        console.log(`🚀 START VNC REQUEST: ${zoneName}`);
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Check if zone exists and is running
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            return res.status(404).json({ error: 'Zone not found' });
        }
        
        if (zone.status !== 'running') {
            return res.status(400).json({ 
                error: 'Zone must be running for VNC access',
                current_status: zone.status
            });
        }
        
        // First, clean up any existing dead sessions for this zone
        const existingSessionInfo = await sessionManager.getSessionInfo(zoneName);
        if (existingSessionInfo) {
            console.log(`✅ EXISTING ACTIVE SESSION: ${zoneName} (PID: ${existingSessionInfo.pid}, port: ${existingSessionInfo.port})`);
            
            // Get the actual host IP for direct VNC access
            const hostIP = req.get('host').split(':')[0];
            
            return res.json({
                success: true,
                zone_name: zoneName,
                console_url: `http://${hostIP}:${existingSessionInfo.port}/`,
                proxy_url: `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`,
                session_id: existingSessionInfo.pid, // Use PID as session ID
                status: 'active',
                web_port: existingSessionInfo.port,
                message: 'VNC session already active',
                direct_access: true,
                started_at: existingSessionInfo.timestamp
            });
        }
        
        // CRITICAL: Kill ALL existing VNC processes for this zone (VM can only have one VNC session)
        console.log(`🧹 ENFORCING ONE-VNC-PER-ZONE: Killing ALL existing VNC processes for ${zoneName}...`);
        await new Promise((resolve) => {
            const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
            let output = '';
            
            ps.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            ps.on('exit', () => {
                const lines = output.split('\n');
                // Find ALL VNC processes for this zone (including webvnc, vnc, etc.)
                const existingProcesses = lines.filter(line => {
                    return line.includes('zadm') && 
                           (line.includes('vnc') || line.includes('webvnc')) &&
                           line.includes(zoneName);
                });
                
                if (existingProcesses.length > 0) {
                    console.log(`🔫 FOUND ${existingProcesses.length} EXISTING VNC PROCESSES FOR ${zoneName} - KILLING ALL:`);
                    existingProcesses.forEach(proc => {
                        const parts = proc.trim().split(/\s+/);
                        const pid = parseInt(parts[1]);
                        console.log(`  💀 Killing PID ${pid}: ${proc.trim()}`);
                        try {
                            // Use pfexec to kill root processes
                            const killProcess = spawn('pfexec', ['kill', '-9', pid.toString()], {
                                stdio: ['ignore', 'ignore', 'ignore']
                            });
                            killProcess.on('exit', (code) => {
                                if (code === 0) {
                                    console.log(`✅ Successfully killed VNC process ${pid} using pfexec`);
                                } else {
                                    console.warn(`❌ Failed to kill VNC process ${pid} with pfexec (exit code: ${code})`);
                                }
                            });
                        } catch (error) {
                            console.warn(`Failed to kill VNC process ${pid}:`, error.message);
                        }
                    });
                    
                    // Wait longer for all processes to die completely
                    console.log(`⏳ Waiting 5 seconds for all VNC processes to terminate...`);
                    setTimeout(resolve, 5000);
                } else {
                    console.log(`✅ No existing VNC processes found for ${zoneName} - safe to start new session`);
                    resolve();
                }
            });
            
            ps.on('error', () => {
                console.warn('Failed to scan for existing VNC processes');
                resolve();
            });
        });
        
        // No existing session, create new one
        const webPort = await findAvailablePort();
        const netport = `0.0.0.0:${webPort}`;
        
        console.log(`🚀 SPAWNING VNC PROCESS: pfexec zadm vnc -w ${netport} ${zoneName}`);
        
        // Spawn VNC process (detached like Ruby)
        const vncProcess = spawn('pfexec', ['zadm', 'vnc', '-w', netport, zoneName], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        
        console.log(`📊 VNC PROCESS SPAWNED: PID=${vncProcess.pid}`);
        
        // Write PID file immediately (Ruby approach)
        sessionManager.writeSessionInfo(zoneName, vncProcess.pid, 'webvnc', netport);
        
        // Set up output handling
        let stdout = '';
        let stderr = '';
        
        vncProcess.stdout.on('data', (data) => {
            stdout += data.toString();
            console.log(`VNC stdout: ${data.toString().trim()}`);
        });
        
        vncProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            console.log(`VNC stderr: ${data.toString().trim()}`);
        });
        
        vncProcess.on('exit', (code, signal) => {
            console.log(`❌ VNC process ${vncProcess.pid} for ${zoneName} exited with code ${code}, signal ${signal}`);
            console.log(`   stdout: ${stdout}`);
            console.log(`   stderr: ${stderr}`);
            
            // Clean up PID file if process exits
            const pidFile = sessionManager.getPidFilePath(zoneName);
            if (fs.existsSync(pidFile)) {
                fs.unlinkSync(pidFile);
                console.log(`📁 Cleaned up PID file for exited process ${vncProcess.pid}`);
            }
        });
        
        // Detach the process (Ruby approach)
        vncProcess.unref();
        
        // Wait a moment for process to start and check if it's still running
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Check if process failed (exited with error)
        if (vncProcess.exitCode !== null && vncProcess.exitCode !== 0) {
            console.error(`VNC process failed with exit code ${vncProcess.exitCode}`);
            console.error(`VNC stderr: ${stderr}`);
            
            // Clean up PID file
            sessionManager.killSession(zoneName);
            
            if (vncProcess.exitCode === 125 && stderr.includes('Address already in use')) {
                throw new Error(`Port ${webPort} is already in use by another process`);
            }
            
            throw new Error(`VNC process failed with exit code ${vncProcess.exitCode}: ${stderr || 'Unknown error'}`);
        }
        
        // Test if VNC is responding
        console.log(`Testing VNC connection on port ${webPort}...`);
        const isReady = await testVncConnection(webPort, 15);
        
        if (!isReady) {
            console.error(`VNC server not responding on port ${webPort}`);
            // Clean up
            sessionManager.killSession(zoneName);
            throw new Error(`VNC server failed to start on port ${webPort}`);
        }
        
        console.log(`✅ VNC session started and verified for zone ${zoneName} on port ${webPort} (PID: ${vncProcess.pid})`);
        
        // CRITICAL: Final process validation after successful connection test
        console.log(`🔍 FINAL VALIDATION: Checking if process ${vncProcess.pid} is still alive after connection test...`);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 more seconds
        
        // Double-check if process is still running using system process list
        const isStillRunning = await sessionManager.isProcessRunning(vncProcess.pid);
        if (!isStillRunning) {
            console.error(`❌ PROCESS DIED IMMEDIATELY: VNC process ${vncProcess.pid} died right after successful connection test!`);
            console.error(`   stdout: ${stdout}`);
            console.error(`   stderr: ${stderr}`);
            console.error(`   exit code: ${vncProcess.exitCode}`);
            console.error(`   killed: ${vncProcess.killed}`);
            
            // Check if there are any system logs or additional info
            console.error(`   This suggests the VNC process may be designed to exit quickly or there's a configuration issue`);
            
            throw new Error(`VNC process died immediately after successful startup - check zadm vnc configuration for zone ${zoneName}`);
        }
        
        console.log(`✅ FINAL VALIDATION PASSED: Process ${vncProcess.pid} is still running and serving on port ${webPort}`);
        
        // CACHE WARMING: Preload common assets in parallel for instant loading
        console.log(`🔥 Starting cache warming for instant asset loading...`);
        // Don't await - let cache warming happen in background while we respond to user
        warmVncAssetCache(webPort).catch(error => {
            console.warn(`Cache warming failed but VNC session is still working:`, error.message);
        });
        
        // Clean up any existing database entries for this zone first
        try {
            await VncSessions.destroy({
                where: { zone_name: zoneName }
            });
        } catch (cleanupError) {
            console.warn(`Failed to cleanup existing database entries for ${zoneName}:`, cleanupError.message);
        }
        
        // Update database with session info
        await VncSessions.create({
            zone_name: zoneName,
            web_port: webPort,
            host_ip: '127.0.0.1',
            process_id: vncProcess.pid,
            status: 'active',
            created_at: new Date(),
            last_accessed: new Date()
        });
        
        // Get the actual host IP for direct VNC access
        const hostIP = req.get('host').split(':')[0];
        
        res.json({
            success: true,
            zone_name: zoneName,
            console_url: `http://${hostIP}:${webPort}/`,
            proxy_url: `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`,
            session_id: vncProcess.pid,
            status: 'active',
            web_port: webPort,
            message: 'VNC session started successfully',
            direct_access: true
        });
        
    } catch (error) {
        console.error(`❌ VNC START ERROR: ${req.params.zoneName} - ${error.message}`);
        
        res.status(500).json({ 
            error: 'Failed to start VNC session',
            details: error.message
        });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/vnc/info:
 *   get:
 *     summary: Get VNC session information
 *     description: Retrieves information about the active VNC session for a zone
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC session information retrieved successfully
 *       404:
 *         description: No active VNC session found
 */
export const getVncSessionInfo = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        // Prevent caching for real-time VNC session data
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Check PID file first (Ruby approach)
        const sessionInfo = await sessionManager.getSessionInfo(zoneName);
        
        if (!sessionInfo) {
            // Double-check by looking for any running VNC process for this zone
            console.log(`⚠️  No PID file found for ${zoneName}, checking for running VNC processes...`);
            
            const runningVncProcess = await new Promise((resolve) => {
                const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
                let output = '';
                
                ps.stdout.on('data', (data) => {
                    output += data.toString();
                });
                
                ps.on('exit', () => {
                    const lines = output.split('\n');
                    const vncProcess = lines.find(line => 
                        line.includes('zadm vnc') && 
                        line.includes('-w 0.0.0.0:') && 
                        line.includes(zoneName)
                    );
                    
                    if (vncProcess) {
                        const parts = vncProcess.trim().split(/\s+/);
                        const pid = parseInt(parts[1]);
                        const portMatch = vncProcess.match(/-w 0\.0\.0\.0:(\d+)\s/);
                        const port = portMatch ? parseInt(portMatch[1]) : null;
                        
                        if (port) {
                            console.log(`🔍 Found orphaned VNC process for ${zoneName}: PID=${pid}, port=${port}`);
                            resolve({ pid, port, zoneName });
                        } else {
                            resolve(null);
                        }
                    } else {
                        resolve(null);
                    }
                });
                
                ps.on('error', () => resolve(null));
            });
            
            if (runningVncProcess) {
                // Create PID file for the orphaned process
                const netport = `0.0.0.0:${runningVncProcess.port}`;
                sessionManager.writeSessionInfo(
                    zoneName, 
                    runningVncProcess.pid, 
                    'webvnc', 
                    netport
                );
                
                console.log(`📁 Recreated PID file for orphaned VNC session: ${zoneName} (PID: ${runningVncProcess.pid}, port: ${runningVncProcess.port})`);
                
                // Update database
                try {
                    await VncSessions.destroy({ where: { zone_name: zoneName } });
                    await VncSessions.create({
                        zone_name: zoneName,
                        web_port: runningVncProcess.port,
                        host_ip: '127.0.0.1',
                        process_id: runningVncProcess.pid,
                        status: 'active',
                        created_at: new Date(),
                        last_accessed: new Date()
                    });
                } catch (dbError) {
                    console.warn(`Failed to update database for orphaned session:`, dbError.message);
                }
                
                // Get the actual host IP for direct VNC access
                const hostIP = req.get('host').split(':')[0];
                
                return res.json({
                    active_vnc_session: true,
                    vnc_session_info: {
                        zone_name: zoneName,
                        web_port: runningVncProcess.port,
                        host_ip: '127.0.0.1',
                        process_id: runningVncProcess.pid,
                        status: 'active',
                        created_at: new Date().toISOString(),
                        last_accessed: new Date().toISOString(),
                        console_url: `http://${hostIP}:${runningVncProcess.port}/`,
                        proxy_url: `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`,
                        direct_access: true
                    }
                });
            }
            
            return res.status(200).json({
                active_vnc_session: false,
                vnc_session_info: null,
                zone_name: zoneName,
                message: 'No active VNC session found'
            });
        }
        
        console.log(`✅ VNC INFO: ${zoneName} session active (PID: ${sessionInfo.pid}, port: ${sessionInfo.port})`);
        
        // Update database last_accessed time
        try {
            await VncSessions.update(
                { last_accessed: new Date() }, 
                { where: { zone_name: zoneName, status: 'active' } }
            );
        } catch (dbError) {
            console.warn(`Failed to update database for ${zoneName}:`, dbError.message);
        }
        
        // Get the actual host IP for direct VNC access
        const hostIP = req.get('host').split(':')[0];
        
        res.json({
            active_vnc_session: true,
            vnc_session_info: {
                zone_name: zoneName,
                web_port: sessionInfo.port,
                host_ip: '127.0.0.1',
                process_id: sessionInfo.pid,
                status: 'active',
                created_at: sessionInfo.timestamp,
                last_accessed: new Date().toISOString(),
                console_url: `http://${hostIP}:${sessionInfo.port}/`,
                proxy_url: `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`,
                direct_access: true
            }
        });
        
    } catch (error) {
        console.error('Error getting VNC session info:', error);
        res.status(500).json({ 
            error: 'Failed to retrieve VNC session information',
            details: error.message
        });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/vnc/stop:
 *   delete:
 *     summary: Stop VNC console session
 *     description: Stops the active VNC console session for a zone
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC session stopped successfully
 *       404:
 *         description: No active VNC session found
 *       500:
 *         description: Failed to stop VNC session
 */
export const stopVncSession = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Use PID file approach to kill session (Ruby style)
        const killed = await sessionManager.killSession(zoneName);
        
        if (!killed) {
            return res.status(404).json({ error: 'No active VNC session found' });
        }
        
        // Update database
        try {
            await VncSessions.update(
                { status: 'stopped' },
                { where: { zone_name: zoneName, status: 'active' } }
            );
        } catch (dbError) {
            console.warn(`Failed to update database for ${zoneName}:`, dbError.message);
        }
        
        
        console.log(`✅ VNC session stopped successfully for zone ${zoneName}`);
        
        res.json({
            success: true,
            zone_name: zoneName,
            message: 'VNC session stopped successfully'
        });
        
    } catch (error) {
        console.error('Error stopping VNC session:', error);
        res.status(500).json({ error: 'Failed to stop VNC session' });
    }
};


/**
 * Clean up stale VNC sessions
 */
export const cleanupVncSessions = async () => {
    try {
        const cutoffTime = new Date(Date.now() - VNC_SESSION_TIMEOUT);
        let cleanedCount = 0;
        
        // Clean up old active sessions in database
        const staleSessions = await VncSessions.findAll({
            where: {
                status: 'active',
                last_accessed: {
                    [Op.lt]: cutoffTime
                }
            }
        });
        
        for (const session of staleSessions) {
            try {
                // Kill session using PID file approach
                sessionManager.killSession(session.zone_name);
                
                // Update session status
                await session.update({ status: 'stopped' });
                cleanedCount++;
                console.log(`Cleaned up stale VNC session for zone ${session.zone_name}`);
                
            } catch (error) {
                console.error(`Error cleaning up VNC session ${session.id}:`, error);
            }
        }
        
        // Delete all stopped sessions since they can't be reopened
        const stoppedSessions = await VncSessions.findAll({
            where: { status: 'stopped' }
        });
        
        for (const session of stoppedSessions) {
            try {
                await session.destroy();
                cleanedCount++;
                console.log(`Deleted stopped VNC session for zone ${session.zone_name}`);
            } catch (error) {
                console.error(`Error deleting stopped VNC session ${session.id}:`, error);
            }
        }
        
        return cleanedCount;
        
    } catch (error) {
        console.error('Error during VNC session cleanup:', error);
        return 0;
    }
};

/**
 * @swagger
 * /vnc/sessions:
 *   get:
 *     summary: List all VNC sessions
 *     description: Retrieves a list of all VNC sessions with optional filtering
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: VNC sessions retrieved successfully
 */
export const listVncSessions = async (req, res) => {
    try {
        // Prevent caching for real-time VNC session data
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        
        const { status, zone_name } = req.query;
        const whereClause = {};
        
        if (status) whereClause.status = status;
        if (zone_name) whereClause.zone_name = zone_name;
        
        const sessions = await VncSessions.findAll({
            where: whereClause,
            order: [['created_at', 'DESC']]
        });
        
        const activeCount = await VncSessions.count({
            where: { status: 'active' }
        });
        
        res.json({
            sessions: sessions,
            total: sessions.length,
            active_count: activeCount
        });
        
    } catch (error) {
        console.error('Error listing VNC sessions:', error);
        res.status(500).json({ error: 'Failed to retrieve VNC sessions' });
    }
};

/**
 * Clean up orphaned zadm VNC processes that aren't tracked by backend
 */
const cleanupOrphanedVncProcesses = async () => {
    try {
        console.log('🧹 Scanning for orphaned VNC processes...');
        
        // Get all running zadm vnc processes using ps auxww for full command lines
        const getAllZadmProcesses = () => new Promise((resolve) => {
            const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
            let output = '';
            
            ps.stdout.on('data', (data) => {
                output += data.toString();
            });
            
            ps.on('exit', () => {
                const lines = output.split('\n');
                const zadmProcesses = lines.filter(line => 
                    line.includes('zadm vnc') && line.includes('-w 0.0.0.0:')
                ).map(line => {
                    const parts = line.trim().split(/\s+/);
                    const pid = parseInt(parts[1]); // PID is in second column
                    
                    // Find the full command starting with /usr/bin/perl
                    const commandStart = line.indexOf('/usr/bin/perl');
                    const fullCommand = commandStart !== -1 ? line.substring(commandStart) : line;
                    
                    // Extract port from command like: zadm vnc -w 0.0.0.0:8000 zonename
                    const portMatch = fullCommand.match(/-w 0\.0\.0\.0:(\d+)\s+(.+)/);
                    if (!portMatch) {
                        return null; // Skip if we can't parse
                    }
                    
                    const port = parseInt(portMatch[1]);
                    const zoneName = portMatch[2].trim();
                    
                    return { pid, port, zoneName, command: fullCommand };
                }).filter(proc => proc !== null);
                
                resolve(zadmProcesses);
            });
            
            ps.on('error', () => resolve([]));
        });
        
        const runningProcesses = await getAllZadmProcesses();
        console.log(`Found ${runningProcesses.length} running zadm VNC processes`);
        
        if (runningProcesses.length === 0) {
            return 0;
        }
        
        // Get all zones that should have VNC sessions
        const trackedZones = new Set();
        
        // Check PID files
        if (fs.existsSync(sessionManager.pidDir)) {
            const pidFiles = fs.readdirSync(sessionManager.pidDir).filter(file => file.endsWith('.pid'));
            for (const pidFile of pidFiles) {
                const zoneName = pidFile.replace('.pid', '');
                const sessionInfo = await sessionManager.getSessionInfo(zoneName);
                if (sessionInfo) {
                    trackedZones.add(zoneName);
                }
            }
        }
        
        // Check database
        try {
            const activeSessions = await VncSessions.findAll({
                where: { status: 'active' }
            });
            for (const session of activeSessions) {
                trackedZones.add(session.zone_name);
            }
        } catch (dbError) {
            console.warn('Failed to check database for active sessions:', dbError.message);
        }
        
        console.log(`Tracked zones with VNC sessions: ${Array.from(trackedZones).join(', ')}`);
        
        // Kill orphaned processes - be more aggressive since VM can only have one VNC session
        let killedCount = 0;
        for (const proc of runningProcesses) {
            if (!trackedZones.has(proc.zoneName)) {
                console.log(`🔫 KILLING ORPHANED VNC PROCESS for zone ${proc.zoneName} (PID: ${proc.pid}, port: ${proc.port})`);
                try {
                    // Use pfexec to kill root orphaned VNC processes
                    const killProcess = spawn('pfexec', ['kill', '-9', proc.pid.toString()], {
                        stdio: ['ignore', 'ignore', 'ignore']
                    });
                    killProcess.on('exit', (code) => {
                        if (code === 0) {
                            console.log(`✅ Successfully killed orphaned VNC process ${proc.pid} using pfexec`);
                        } else {
                            console.warn(`❌ Failed to kill orphaned VNC process ${proc.pid} with pfexec (exit code: ${code})`);
                        }
                    });
                    killedCount++;
                } catch (error) {
                    console.warn(`Failed to kill orphaned VNC process ${proc.pid}:`, error.message);
                }
            } else {
                console.log(`✅ VNC process for zone ${proc.zoneName} is properly tracked (PID: ${proc.pid}, port: ${proc.port})`);
            }
        }
        
        console.log(`Killed ${killedCount} orphaned VNC processes`);
        return killedCount;
        
    } catch (error) {
        console.error('Error cleaning up orphaned VNC processes:', error);
        return 0;
    }
};

/**
 * Clean up stale sessions on startup (after backend restart)
 */
export const cleanupStaleSessionsOnStartup = async () => {
    try {
        console.log('Cleaning up stale VNC sessions from previous backend instance...');
        
        // Step 1: Clean up orphaned VNC processes first
        const orphanedCount = await cleanupOrphanedVncProcesses();
        
        // Step 2: Clean up PID files from previous instance
        sessionManager.cleanupStaleSessions();
        
        // Step 3: Update database to mark orphaned sessions as stopped
        const activeSessions = await VncSessions.findAll({
            where: { status: 'active' }
        });
        
        let cleanedCount = 0;
        
        for (const session of activeSessions) {
            try {
                // Test if the VNC port is actually responding
                const isPortResponding = await testVncConnection(session.web_port, 4);
                
                if (!isPortResponding) {
                    // Port not responding, mark session as stopped
                    await session.update({ status: 'stopped' });
                    cleanedCount++;
                    console.log(`Cleaned up stale VNC session for zone ${session.zone_name} (port ${session.web_port})`);
                } else {
                    console.log(`VNC session for zone ${session.zone_name} is still active (port ${session.web_port})`);
                }
                
            } catch (error) {
                // If we can't test the connection, assume it's stale and clean it up
                await session.update({ status: 'stopped' });
                cleanedCount++;
                console.log(`Cleaned up stale VNC session for zone ${session.zone_name} (error testing port)`);
            }
        }
        
        console.log(`Startup cleanup completed: ${cleanedCount} stale sessions cleaned, ${orphanedCount} orphaned processes killed`);
        return cleanedCount + orphanedCount;
        
    } catch (error) {
        console.error('Error during startup VNC session cleanup:', error);
        return 0;
    }
};

/**
 * @swagger
 * /zones/{zoneName}/vnc/console:
 *   get:
 *     summary: Serve VNC console HTML content
 *     description: Proxies the main VNC console HTML page from the VNC server
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC console HTML served successfully
 *         content:
 *           text/html:
 *             schema:
 *               type: string
 *       404:
 *         description: No active VNC session found
 *       500:
 *         description: Failed to proxy VNC content
 */
export const serveVncConsole = async (req, res) => {
    try {
        const { zoneName } = req.params;
        
        console.log(`📄 VNC CONSOLE REQUEST: ${zoneName}`);
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Get active VNC session info
        const sessionInfo = await sessionManager.getSessionInfo(zoneName);
        if (!sessionInfo) {
            console.log(`❌ No active VNC session found for zone: ${zoneName}`);
            return res.status(404).json({ 
                error: 'No active VNC session found',
                zone_name: zoneName 
            });
        }
        
        // Proxy to actual VNC server
        const vncUrl = `http://127.0.0.1:${sessionInfo.port}/`;
        console.log(`🔗 Proxying VNC console from: ${vncUrl}`);
        
        try {
            const response = await fetch(vncUrl);
            
            if (!response.ok) {
                console.error(`❌ VNC server responded with status ${response.status}`);
                return res.status(502).json({ 
                    error: 'VNC server not responding',
                    vnc_port: sessionInfo.port,
                    status: response.status
                });
            }
            
            // Add aggressive cache-busting headers (matching frontend expectations)
            res.set({
                'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Content-Type': response.headers.get('content-type') || 'text/html'
            });
            
            // Convert Web ReadableStream to Node.js stream and pipe
            console.log(`✅ VNC console content streaming for ${zoneName}`);
            
            // For Node.js 18+ native fetch, response.body is a Web ReadableStream
            // Convert to Node.js Readable stream using Readable.fromWeb()
            const { Readable } = await import('stream');
            const nodeStream = Readable.fromWeb(response.body);
            nodeStream.pipe(res);
            
        } catch (fetchError) {
            console.error(`❌ Failed to fetch VNC content from ${vncUrl}:`, fetchError.message);
            res.status(502).json({ 
                error: 'Failed to connect to VNC server',
                details: fetchError.message,
                vnc_port: sessionInfo.port
            });
        }
        
    } catch (error) {
        console.error(`❌ VNC CONSOLE ERROR: ${req.params.zoneName} - ${error.message}`);
        res.status(500).json({ 
            error: 'Failed to serve VNC console',
            details: error.message
        });
    }
};

/**
 * @swagger
 * /zones/{zoneName}/vnc/*:
 *   get:
 *     summary: Proxy VNC assets
 *     description: Proxies VNC assets (JavaScript, CSS, images, etc.) from the VNC server
 *     tags: [VNC Console]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *         description: Name of the zone
 *     responses:
 *       200:
 *         description: VNC asset served successfully
 *       404:
 *         description: No active VNC session found or asset not found
 *       500:
 *         description: Failed to proxy VNC asset
 */
export const proxyVncContent = async (req, res) => {
    try {
        const { zoneName } = req.params;
        const assetPath = req.params.assetPath || req.params[0];
        
        if (!validateZoneName(zoneName)) {
            return res.status(400).json({ error: 'Invalid zone name' });
        }
        
        // Check cache first for static assets (ULTIMATE SPEED OPTIMIZATION)
        // Cache hits bypass ALL validation and process checks for maximum speed
        const cacheKey = assetPath;
        const cachedItem = vncAssetCache.get(cacheKey);
        
        if (cachedItem) {
            console.log(`💾 VNC ASSET CACHED: ${zoneName} → ${assetPath} (${cachedItem.data.length} bytes)`);
            
            res.set({
                'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
                'Pragma': 'no-cache',
                'Expires': '0',
                'Content-Type': cachedItem.contentType
            });
            
            return res.send(cachedItem.data);
        }
        
        console.log(`📁 VNC ASSET REQUEST: ${zoneName} → ${assetPath}`);
        
        // SPEED OPTIMIZATION: For asset requests, do lightweight session check
        // Skip expensive process validation that times out - if PID file exists and port is known, use it
        const pidFile = sessionManager.getPidFilePath(zoneName);
        let sessionInfo = null;
        
        if (fs.existsSync(pidFile)) {
            try {
                const lines = fs.readFileSync(pidFile, 'utf8').trim().split('\n');
                if (lines.length >= 5) {
                    const [pid, command, timestamp, vmname, netport] = lines;
                    sessionInfo = {
                        pid: parseInt(pid),
                        command,
                        timestamp,
                        vmname,
                        netport,
                        port: parseInt(netport.split(':')[1])
                    };
                    console.log(`⚡ FAST ASSET LOOKUP: ${zoneName} → port ${sessionInfo.port} (skipped process validation)`);
                }
            } catch (error) {
                console.warn(`Error reading PID file for asset request:`, error.message);
            }
        }
        
        // Fallback to full session check if fast lookup failed
        if (!sessionInfo) {
            sessionInfo = await sessionManager.getSessionInfo(zoneName);
            if (!sessionInfo) {
                console.log(`❌ No active VNC session found for asset request: ${zoneName}`);
                return res.status(404).json({ 
                    error: 'No active VNC session found',
                    zone_name: zoneName,
                    asset_path: assetPath
                });
            }
        }
        
        // Build VNC server asset URL
        const vncUrl = `http://127.0.0.1:${sessionInfo.port}/${assetPath}`;
        console.log(`🔗 Proxying VNC asset from: ${vncUrl}`);
        
        try {
            const response = await fetch(vncUrl);
            
            if (!response.ok) {
                console.warn(`⚠️ VNC asset not found: ${assetPath} (status ${response.status})`);
                return res.status(response.status).json({ 
                    error: 'VNC asset not found',
                    asset_path: assetPath,
                    vnc_port: sessionInfo.port,
                    status: response.status
                });
            }
            
            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            const contentLength = response.headers.get('content-length');
            
            // For cacheable static assets, buffer and cache them
            const isCacheable = contentType.includes('javascript') || 
                               contentType.includes('css') || 
                               contentType.includes('image/') ||
                               contentType.includes('font/') ||
                               assetPath.endsWith('.js') ||
                               assetPath.endsWith('.css') ||
                               assetPath.endsWith('.svg') ||
                               assetPath.endsWith('.png') ||
                               assetPath.endsWith('.jpg') ||
                               assetPath.endsWith('.ico');
            
            if (isCacheable && contentLength && parseInt(contentLength) < 1024 * 1024) { // Cache files under 1MB
                // Buffer the response for caching
                const buffer = Buffer.from(await response.arrayBuffer());
                
                // Cache the asset
                vncAssetCache.set(cacheKey, buffer, contentType);
                
                console.log(`💾 VNC ASSET CACHED: ${assetPath} (${buffer.length} bytes, ${contentType})`);
                
                // Send response
                res.set({
                    'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'Content-Type': contentType
                });
                
                res.send(buffer);
            } else {
                // Stream large or non-cacheable assets directly
                console.log(`🔗 VNC ASSET STREAMING: ${assetPath} (${contentLength || 'unknown size'} bytes, ${contentType})`);
                
                res.set({
                    'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
                    'Pragma': 'no-cache',
                    'Expires': '0',
                    'Content-Type': contentType
                });
                
                // Convert Web ReadableStream to Node.js stream and pipe
                const { Readable } = await import('stream');
                const nodeStream = Readable.fromWeb(response.body);
                nodeStream.pipe(res);
            }
            
        } catch (fetchError) {
            console.error(`❌ Failed to fetch VNC asset from ${vncUrl}:`, fetchError.message);
            res.status(502).json({ 
                error: 'Failed to connect to VNC server for asset',
                details: fetchError.message,
                asset_path: assetPath,
                vnc_port: sessionInfo.port
            });
        }
        
    } catch (error) {
        console.error(`❌ VNC ASSET ERROR: ${req.params.zoneName} - ${error.message}`);
        res.status(500).json({ 
            error: 'Failed to proxy VNC asset',
            details: error.message
        });
    }
};

/**
 * Start VNC session cleanup interval
 */
export const startVncSessionCleanup = () => {
    // Clean up stale sessions from previous backend instance on startup
    cleanupStaleSessionsOnStartup();
    
    // Clean up stale sessions every 5 minutes
    setInterval(cleanupVncSessions, 5 * 60 * 1000);
    console.log('VNC session cleanup started');
};
