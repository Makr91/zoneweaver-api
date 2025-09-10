import os from 'os';
import pty from 'node-pty';
import ZloginSessions from '../models/ZloginSessionModel.js';
import { Op } from 'sequelize';
import Zones from '../models/ZoneModel.js';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { log } from '../lib/Logger.js';

/**
 * @fileoverview Zlogin Session Controller for Zoneweaver API
 * @description Manages the lifecycle of zlogin pseudo-terminal sessions for zones.
 */

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

/**
 * In-memory store for active pty processes.
 * @type {Map<string, import('node-pty').IPty>}
 */
const activePtyProcesses = new Map();

class ZloginSessionManager {
    constructor() {
        this.pidDir = './zlogin_sessions';
        if (!fs.existsSync(this.pidDir)) {
            fs.mkdirSync(this.pidDir, { recursive: true });
        }
    }

    /**
     * Check for running zlogin processes for a specific zone
     * @param {string} zoneName - The zone name to check
     * @returns {Promise<number|null>} The PID if found, null otherwise
     */
    async findRunningZloginProcess(zoneName) {
        try {
            const psProcess = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'pipe'] });
            
            return new Promise((resolve) => {
                let output = '';
                
                psProcess.stdout.on('data', (data) => {
                    output += data.toString();
                });
                
                psProcess.on('exit', () => {
                    const lines = output.split('\n');
                    
                    for (const line of lines) {
                        // Look for "zlogin -C zoneName" processes
                        if (line.includes('zlogin -C') && line.includes(zoneName)) {
                            const parts = line.trim().split(/\s+/);
                            if (parts.length >= 2) {
                                const pid = parseInt(parts[1]);
                                if (!isNaN(pid)) {
                                    console.log(`🔍 Found running zlogin process for ${zoneName}: PID ${pid}`);
                                    resolve(pid);
                                    return;
                                }
                            }
                        }
                    }
                    resolve(null);
                });
                
                psProcess.on('error', () => {
                    resolve(null);
                });
            });
        } catch (error) {
            console.error(`Error checking for running zlogin processes: ${error.message}`);
            return null;
        }
    }

    /**
     * Kill a specific zlogin process by PID
     * @param {number} pid - The process ID to kill
     * @returns {Promise<boolean>} True if successfully killed
     */
    async killZloginProcess(pid) {
        try {
            console.log(`🔪 Killing zlogin process PID ${pid}...`);
            const killProcess = spawn('pfexec', ['kill', '-9', pid.toString()], {
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            return new Promise((resolve) => {
                killProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log(`✅ Successfully killed zlogin process PID ${pid}`);
                        resolve(true);
                    } else {
                        console.log(`❌ Failed to kill zlogin process PID ${pid} (exit code: ${code})`);
                        resolve(false);
                    }
                });
                
                killProcess.on('error', (error) => {
                    console.error(`❌ Error killing zlogin process PID ${pid}: ${error.message}`);
                    resolve(false);
                });
            });
        } catch (error) {
            console.error(`Error killing zlogin process PID ${pid}: ${error.message}`);
            return false;
        }
    }

    /**
     * Clean up stale zlogin processes for a specific zone
     * @param {string} zoneName - The zone name to clean up
     * @returns {Promise<boolean>} True if cleanup was successful
     */
    async cleanupStaleZloginProcesses(zoneName) {
        try {
            console.log(`🧹 Cleaning up stale zlogin processes for zone: ${zoneName}`);
            
            // Find running processes
            const runningPid = await this.findRunningZloginProcess(zoneName);
            
            if (runningPid) {
                // Kill the stale process
                await this.killZloginProcess(runningPid);
                
                // Clean up any database sessions for this zone that are stale
                const staleSessions = await ZloginSessions.findAll({
                    where: {
                        zone_name: zoneName
                    }
                });
                
                for (const session of staleSessions) {
                    console.log(`🗑️  Cleaning up stale database session: ${session.id}`);
                    await session.destroy();
                }
                
                console.log(`✅ Cleanup completed for zone: ${zoneName}`);
                return true;
            } else {
                console.log(`✅ No stale zlogin processes found for zone: ${zoneName}`);
                return true;
            }
        } catch (error) {
            console.error(`❌ Error during cleanup for zone ${zoneName}: ${error.message}`);
            return false;
        }
    }

    async cleanupStaleSessions() {
        const activeSessions = await ZloginSessions.findAll({ 
            where: { 
                status: ['active', 'connecting'] 
            } 
        });
        let cleanedCount = 0;
        for (const session of activeSessions) {
            try {
                // Skip PID check for sessions that don't have a PID yet (connecting state)
                if (session.pid !== null) {
                    process.kill(session.pid, 0);
                }
            } catch (e) {
                await session.update({ status: 'closed' });
                cleanedCount++;
            }
        }
        console.log(`Zlogin startup cleanup: ${cleanedCount} stale sessions cleaned`);
    }
}

const sessionManager = new ZloginSessionManager();

export const getZloginCleanupTask = () => {
    return {
        name: 'zlogin_cleanup',
        description: 'Clean up closed zlogin sessions',
        model: ZloginSessions,
        where: {
            status: 'closed'
        }
    };
};

export const startZloginSessionCleanup = () => {
    sessionManager.cleanupStaleSessions();
    setInterval(() => {
        sessionManager.cleanupStaleSessions();
    }, 30 * 60 * 1000); // Reduced from 5 minutes to 30 minutes - less aggressive cleanup
};

/**
 * Test if zlogin session is healthy by checking PTY process and WebSocket connectivity
 * @param {string} sessionId - The zlogin session ID
 * @returns {Promise<boolean>} True if session is healthy
 */
const testZloginSessionHealth = async (sessionId) => {
    try {
        // Check if PTY process exists in memory
        const ptyProcess = activePtyProcesses.get(sessionId);
        if (!ptyProcess) {
            return false;
        }
        
        // Check if process ID still exists and is not killed
        if (!ptyProcess.pid || ptyProcess.killed) {
            return false;
        }
        
        // Verify process is actually running using system check
        try {
            process.kill(ptyProcess.pid, 0); // Signal 0 checks if process exists
            return true;
        } catch (error) {
            // Process doesn't exist
            activePtyProcesses.delete(sessionId);
            return false;
        }
    } catch (error) {
        console.error(`Error checking zlogin session health ${sessionId}:`, error);
        return false;
    }
};

/**
 * Spawns a new pty process for a zlogin session.
 * @param {string} zoneName - The name of the zone to connect to.
 * @returns {{session: import('../models/ZloginSessionModel.js').default, ptyProcess: import('node-pty').IPty}}
 */
const spawnZloginProcess = async (zoneName) => {
    console.log(`🚀 [ZLOGIN-SPAWN] Starting PTY spawn process for zone: ${zoneName}`);
    
    const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
    const command = `pfexec zlogin -C ${zoneName}`;
    
    console.log(`🚀 [ZLOGIN-SPAWN] Shell: ${shell}, Command: ${command}`);
    console.log(`🚀 [ZLOGIN-SPAWN] PTY options: name=xterm-color, cols=80, rows=30`);
    
    const ptyProcess = pty.spawn(shell, ['-c', command], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        env: process.env
    });

    console.log(`� [ZLOGIN-SPAWN] PTY process created - PID: ${ptyProcess.pid}, writable: ${ptyProcess.writable}`);

    const session = await ZloginSessions.create({
        zone_name: zoneName,
        pid: ptyProcess.pid,
        status: 'active'
    });

    console.log(`🚀 [ZLOGIN-SPAWN] Database session created - ID: ${session.id}, PID: ${session.pid}, status: ${session.status}`);

    activePtyProcesses.set(session.id, ptyProcess);
    console.log(`🚀 [ZLOGIN-SPAWN] PTY process stored in activePtyProcesses map for session: ${session.id}`);
    console.log(`🚀 [ZLOGIN-SPAWN] Total active PTY processes: ${activePtyProcesses.size}`);

    ptyProcess.on('exit', (code, signal) => {
        console.log(`💀 [ZLOGIN-SPAWN] Zlogin session ${session.id} for zone ${zoneName} exited with code ${code}, signal ${signal}`);
        console.log(`💀 [ZLOGIN-SPAWN] Removing session ${session.id} from activePtyProcesses`);
        activePtyProcesses.delete(session.id);
        console.log(`� [ZLOGIN-SPAWN] Updating database session status to closed`);
        session.update({ status: 'closed' });
        console.log(`💀 [ZLOGIN-SPAWN] Cleanup completed for session ${session.id}`);
    });

    ptyProcess.on('data', function (data) {
        console.log(`📊 [ZLOGIN-SPAWN] Zlogin session ${session.id} for zone ${zoneName} data (${data.length} bytes): ${data.substring(0, 200)}${data.length > 200 ? '...' : ''}`);
    });

    ptyProcess.on('error', function (error) {
        console.error(`❌ [ZLOGIN-SPAWN] PTY process error for session ${session.id}:`, error.message);
        console.error(`❌ [ZLOGIN-SPAWN] Error stack:`, error.stack);
    });

    console.log(`✅ [ZLOGIN-SPAWN] PTY process setup completed for session: ${session.id}`);
    return { session, ptyProcess };
};

/**
 * @swagger
 * tags:
 *   name: Zlogin
 *   description: Manage zlogin sessions for zones
 * /zones/{zoneName}/zlogin/start:
 *   post:
 *     summary: Start a new zlogin session
 *     description: Creates a new pseudo-terminal session for the specified zone.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: zoneName
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Zlogin session started successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ZloginSession'
 *       404:
 *         description: Zone not found.
 *       500:
 *         description: Failed to start zlogin session.
 */
export const startZloginSession = async (req, res) => {
    try {
        const { zoneName } = req.params;
        console.log(`🔌 Starting zlogin session for zone: ${zoneName}`);
        
        const zone = await Zones.findOne({ where: { name: zoneName } });
        if (!zone) {
            console.log(`❌ Zone not found: ${zoneName}`);
            return res.status(404).json({ error: 'Zone not found' });
        }

        console.log(`✅ Zone found: ${zoneName}, status: ${zone.status}`);
        if (zone.status !== 'running') {
            console.log(`❌ Zone not running: ${zoneName}, status: ${zone.status}`);
            return res.status(400).json({ error: 'Zone is not running' });
        }

        // CHECK FOR EXISTING HEALTHY SESSION FIRST (PERFORMANCE OPTIMIZATION)
        console.log(`🔍 CHECKING FOR EXISTING HEALTHY SESSION: ${zoneName}`);
        const existingSession = await ZloginSessions.findOne({
            where: {
                zone_name: zoneName,
                status: 'active'
            }
        });

        if (existingSession) {
            console.log(`� Found existing session for ${zoneName} (ID: ${existingSession.id}, PID: ${existingSession.pid})`);
            
            // Test if the session is healthy before killing it
            console.log(`🩺 Testing zlogin session health for session ${existingSession.id}...`);
            const isHealthy = await testZloginSessionHealth(existingSession.id);
            
            if (isHealthy) {
                console.log(`✅ HEALTHY SESSION FOUND: Reusing existing zlogin session for ${zoneName}`);
                
                // Update database last_accessed time for healthy session  
                try {
                    await existingSession.update({ 
                        updated_at: new Date()
                    });
                } catch (dbError) {
                    console.warn(`Failed to update database for ${zoneName}:`, dbError.message);
                }
                
                // Return existing healthy session immediately - NO SESSION KILLING!
                return res.json({
                    ...existingSession.toJSON(),
                    reused_session: true,
                    message: 'Healthy zlogin session reused - instant access!'
                });
            } else {
                console.log(`🔧 UNHEALTHY SESSION DETECTED: Session exists but not responding, will clean up and create new one`);
            }
        } else {
            console.log(`📋 No existing session found for ${zoneName}, will create new one`);
        }

        // ONLY CLEAN UP IF SESSION IS UNHEALTHY OR MISSING
        console.log(`🧹 CLEANING UP UNHEALTHY/MISSING SESSIONS: Cleaning up stale zlogin processes for zone: ${zoneName}`);
        await sessionManager.cleanupStaleZloginProcesses(zoneName);

        console.log(`🔄 Creating new zlogin session for zone: ${zoneName}`);
        const { session } = await spawnZloginProcess(zoneName);
        
        console.log(`✅ Session created with ID: ${session.id}, status: ${session.status}`);
        res.json(session);
    } catch (error) {
        console.error('❌ Error starting zlogin session:', error);
        res.status(500).json({ error: 'Failed to start zlogin session' });
    }
};

/**
 * @swagger
 * /zlogin/sessions/{sessionId}:
 *   get:
 *     summary: Get zlogin session information
 *     description: Retrieves information about a specific zlogin session.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session information retrieved successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ZloginSession'
 *       404:
 *         description: Session not found.
 */
export const getZloginSessionInfo = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await ZloginSessions.findByPk(sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Zlogin session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('Error getting zlogin session info:', error);
        res.status(500).json({ error: 'Failed to get zlogin session info' });
    }
};

/**
 * @swagger
 * /zlogin/sessions/{sessionId}/stop:
 *   delete:
 *     summary: Stop a zlogin session
 *     description: Terminates a specific zlogin session.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Session stopped successfully.
 *       404:
 *         description: Session not found.
 */
export const stopZloginSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const ptyProcess = activePtyProcesses.get(sessionId);

        if (ptyProcess) {
            ptyProcess.kill();
            activePtyProcesses.delete(sessionId);
        }

        const session = await ZloginSessions.findByPk(sessionId);
        if (session) {
            await session.update({ status: 'closed' });
        }

        res.json({ success: true, message: 'Zlogin session stopped.' });
    } catch (error) {
        console.error('Error stopping zlogin session:', error);
        res.status(500).json({ error: 'Failed to stop zlogin session' });
    }
};

/**
 * @swagger
 * /zlogin/sessions:
 *   get:
 *     summary: List all zlogin sessions
 *     description: Retrieves a list of all zlogin sessions.
 *     tags: [Zlogin]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of zlogin sessions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/ZloginSession'
 */
export const listZloginSessions = async (req, res) => {
    try {
        const sessions = await ZloginSessions.findAll({
            order: [['created_at', 'DESC']]
        });
        res.json(sessions);
    } catch (error) {
        console.error('Error listing zlogin sessions:', error);
        res.status(500).json({ error: 'Failed to list zlogin sessions' });
    }
};

/**
 * Retrieves an active pty process by session ID.
 * @param {string} sessionId - The UUID of the zlogin session.
 * @returns {import('node-pty').IPty | undefined} The pty process or undefined if not found.
 */
export const getZloginPtyProcess = (sessionId) => {
    return activePtyProcesses.get(sessionId);
};

/**
 * Handles a new WebSocket connection for an existing zlogin session.
 * @param {import('ws').WebSocket} ws - The WebSocket connection object.
 * @param {string} sessionId - The ID of the zlogin session.
 */
export const handleZloginConnection = (ws, sessionId) => {
    console.log(`🔌 [ZLOGIN-WS] handleZloginConnection called for session: ${sessionId}`);
    console.log(`🔌 [ZLOGIN-WS] WebSocket state: ${ws.readyState} (${ws.readyState === ws.OPEN ? 'OPEN' : ws.readyState === ws.CONNECTING ? 'CONNECTING' : 'OTHER'})`);
    
    const ptyProcess = getZloginPtyProcess(sessionId);
    console.log(`🔌 [ZLOGIN-WS] PTY process lookup result: ${ptyProcess ? 'FOUND' : 'NOT FOUND'}`);
    
    if (ptyProcess) {
        console.log(`🔌 [ZLOGIN-WS] PTY process details - PID: ${ptyProcess.pid}, writable: ${ptyProcess.writable}, killed: ${ptyProcess.killed}`);
    }

    if (!ptyProcess) {
        console.log(`❌ [ZLOGIN-WS] Zlogin session not found in activePtyProcesses: ${sessionId}`);
        console.log(`❌ [ZLOGIN-WS] Available sessions: ${Array.from(activePtyProcesses.keys()).join(', ')}`);
        try {
            ws.send('Zlogin session not found.\r\n');
            ws.close();
        } catch (error) {
            console.error(`❌ [ZLOGIN-WS] Error closing WebSocket: ${error.message}`);
        }
        return;
    }

    console.log(`✅ [ZLOGIN-WS] WebSocket connected to zlogin session: ${sessionId}`);

    const onPtyData = (data) => {
        try {
            console.log(`📤 [ZLOGIN-WS] PTY data received (${data.length} bytes): ${data.substring(0, 100)}${data.length > 100 ? '...' : ''}`);
            if (ws.readyState === ws.OPEN) {
                ws.send(data);
                console.log(`📤 [ZLOGIN-WS] Data sent to WebSocket successfully`);
            } else {
                console.warn(`⚠️ [ZLOGIN-WS] Cannot send data - WebSocket state: ${ws.readyState}`);
            }
        } catch (error) {
            console.error(`❌ [ZLOGIN-WS] Error sending data to WebSocket ${sessionId}:`, error.message);
        }
    };
    
    console.log(`🔗 [ZLOGIN-WS] Setting up PTY data listener for session: ${sessionId}`);
    ptyProcess.on('data', onPtyData);

    ws.on('message', command => {
        try {
            console.log(`📥 [ZLOGIN-WS] WebSocket message received (${command.length} bytes): ${command.toString().substring(0, 100)}${command.length > 100 ? '...' : ''}`);
            console.log(`📥 [ZLOGIN-WS] PTY state check - exists: ${!!ptyProcess}, PID: ${ptyProcess?.pid}, killed: ${ptyProcess?.killed}`);
            
            // Check if PTY exists and has a valid PID (more reliable than writable property)
            if (ptyProcess && ptyProcess.pid && !ptyProcess.killed) {
                ptyProcess.write(command.toString());
                console.log(`📥 [ZLOGIN-WS] Command written to PTY successfully`);
            } else {
                console.warn(`⚠️ [ZLOGIN-WS] Cannot write to PTY - exists: ${!!ptyProcess}, PID: ${ptyProcess?.pid}, killed: ${ptyProcess?.killed}`);
            }
        } catch (error) {
            console.error(`❌ [ZLOGIN-WS] Error writing to PTY ${sessionId}:`, error.message);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`🔌 [ZLOGIN-WS] WebSocket closed for zlogin session: ${sessionId} (code: ${code}, reason: ${reason || 'none'})`);
        if (ptyProcess && onPtyData) {
            ptyProcess.removeListener('data', onPtyData);
            console.log(`🔗 [ZLOGIN-WS] Removed PTY data listener for session: ${sessionId}`);
        }
    });

    ws.on('error', (error) => {
        console.error(`❌ [ZLOGIN-WS] WebSocket error for zlogin session ${sessionId}:`, error.message);
        console.error(`❌ [ZLOGIN-WS] Error stack:`, error.stack);
    });

    console.log(`✅ [ZLOGIN-WS] WebSocket event handlers set up for session: ${sessionId}`);
};
