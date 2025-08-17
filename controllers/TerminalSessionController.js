import os from 'os';
import pty from 'node-pty';
import { Op } from 'sequelize';
import TerminalSessions from '../models/TerminalSessionModel.js';

/**
 * @fileoverview Terminal Session Controller for Zoneweaver API
 * @description Manages the lifecycle of pseudo-terminal sessions.
 */

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

// Configurable session timeout (default 30 minutes)
const SESSION_TIMEOUT_MINUTES = parseInt(process.env.TERMINAL_SESSION_TIMEOUT) || 30;

/**
 * In-memory store for active pty processes.
 * @type {Map<string, import('node-pty').IPty>}
 */
const activePtyProcesses = new Map();

/**
 * Checks if a session is healthy by verifying the process is still running.
 * @param {string} sessionId - The UUID of the terminal session.
 * @returns {Promise<boolean>} True if session is healthy, false otherwise.
 */
const isSessionHealthy = async (sessionId) => {
    try {
        const ptyProcess = activePtyProcesses.get(sessionId);
        if (!ptyProcess) {
            return false;
        }
        
        // Check if process ID still exists
        try {
            process.kill(ptyProcess.pid, 0); // Signal 0 checks if process exists without killing
            return true;
        } catch (error) {
            // Process doesn't exist
            activePtyProcesses.delete(sessionId);
            return false;
        }
    } catch (error) {
        console.error('Error checking session health:', error);
        return false;
    }
};

/**
 * Creates a terminal session database record immediately.
 * @param {string} zoneName - The zone name for this terminal session.
 * @param {string} terminalCookie - Frontend-generated session identifier.
 * @returns {Promise<import('../models/TerminalSessionModel.js').default>} The session record
 */
const createSessionRecord = async (zoneName = null, terminalCookie) => {
    const session = await TerminalSessions.create({
        terminal_cookie: terminalCookie,
        pid: 0, // Temporary PID, will be updated when PTY spawns
        zone_name: zoneName,
        status: 'connecting' // Session is being created
    });
    
    console.log(`🔄 TERMINAL SESSION: Created database record for cookie ${terminalCookie}, spawning PTY...`);
    return session;
};

/**
 * Spawns a PTY process asynchronously and updates the session record.
 * @param {import('../models/TerminalSessionModel.js').default} session - The session record to update
 * @returns {Promise<void>}
 */
const spawnPtyProcessAsync = async (session) => {
    try {
        // Use simpler configuration matching the working reference
        const ptyProcess = pty.spawn(shell, [], {
            name: 'xterm-color',
            cols: 80,
            rows: 30,
            env: process.env
        });

        // Update session record with actual PID and active status
        await session.update({
            pid: ptyProcess.pid,
            status: 'active'
        });

        activePtyProcesses.set(session.id, ptyProcess);

        console.log(`✅ TERMINAL SESSION: PTY spawned for cookie ${session.terminal_cookie}, PID: ${ptyProcess.pid}`);

        // Use same event handler as working reference
        ptyProcess.on('exit', (code, signal) => {
            console.log(`Terminal session ${session.id} (cookie: ${session.terminal_cookie}) exited with code ${code}, signal ${signal}`);
            activePtyProcesses.delete(session.id);
            session.update({ status: 'closed' });
        });

    } catch (error) {
        console.error(`❌ TERMINAL SESSION: Failed to spawn PTY for cookie ${session.terminal_cookie}:`, error);
        // Mark session as failed
        await session.update({ status: 'failed' });
    }
};

/**
 * Legacy function for backward compatibility - creates session and spawns PTY synchronously.
 * @param {string} zoneName - The zone name for this terminal session.
 * @param {string} terminalCookie - Frontend-generated session identifier.
 * @returns {{session: import('../models/TerminalSessionModel.js').default, ptyProcess: import('node-pty').IPty}}
 * @deprecated Use createSessionRecord + spawnPtyProcessAsync for better performance
 */
const spawnPtyProcess = async (zoneName = null, terminalCookie) => {
    const session = await createSessionRecord(zoneName, terminalCookie);
    
    // Spawn PTY synchronously for backward compatibility
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        env: process.env
    });

    await session.update({
        pid: ptyProcess.pid,
        status: 'active'
    });

    activePtyProcesses.set(session.id, ptyProcess);

    ptyProcess.on('exit', (code, signal) => {
        console.log(`Terminal session ${session.id} (cookie: ${terminalCookie}) exited with code ${code}, signal ${signal}`);
        activePtyProcesses.delete(session.id);
        session.update({ status: 'closed' });
    });

    return { session, ptyProcess };
};

/**
 * Cleans up inactive terminal sessions based on configurable timeout.
 * @returns {Promise<number>} Number of sessions cleaned up.
 */
const cleanupInactiveSessions = async () => {
    const timeoutAgo = new Date(Date.now() - SESSION_TIMEOUT_MINUTES * 60 * 1000);
    
    try {
        const inactiveSessions = await TerminalSessions.findAll({
            where: {
                status: 'active',
                last_activity: { [Op.lt]: timeoutAgo }
            }
        });

        let cleanedCount = 0;
        for (const session of inactiveSessions) {
            const ptyProcess = activePtyProcesses.get(session.id);
            if (ptyProcess) {
                ptyProcess.kill();
                activePtyProcesses.delete(session.id);
            }
            
            await session.update({ status: 'closed' });
            console.log(`🧹 Cleaned up inactive terminal session: ${session.terminal_cookie} (inactive for ${SESSION_TIMEOUT_MINUTES}+ minutes)`);
            cleanedCount++;
        }

        if (cleanedCount > 0) {
            console.log(`🧹 Terminal cleanup completed: ${cleanedCount} sessions cleaned up`);
        }

        return cleanedCount;
    } catch (error) {
        console.error('Error during terminal session cleanup:', error);
        return 0;
    }
};

// Run cleanup every 10 minutes
setInterval(cleanupInactiveSessions, 10 * 60 * 1000);

/**
 * @swagger
 * /terminal/start:
 *   post:
 *     summary: Start or reuse a terminal session
 *     description: Creates a new pseudo-terminal session or reuses an existing healthy session based on terminal_cookie.
 *     tags: [Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - terminal_cookie
 *             properties:
 *               terminal_cookie:
 *                 type: string
 *                 description: Frontend-generated session identifier
 *                 example: "terminal_host1_5001_browser123_1234567890"
 *               zone_name:
 *                 type: string
 *                 description: Zone name for this terminal session
 *                 example: "myzone"
 *     responses:
 *       200:
 *         description: Terminal session started or reused successfully.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Terminal cookie (same as sent)
 *                       example: "terminal_host1_5001_browser123_1234567890"
 *                     websocket_url:
 *                       type: string
 *                       description: WebSocket endpoint for terminal connection
 *                       example: "/term/uuid-session-id"
 *                     reused:
 *                       type: boolean
 *                       description: True if existing session was reused
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *                     buffer:
 *                       type: string
 *                       description: Terminal history for reconnection
 *       400:
 *         description: Missing required terminal_cookie parameter.
 *       500:
 *         description: Failed to start terminal session.
 */
export const startTerminalSession = async (req, res) => {
    try {
        const { zone_name, terminal_cookie } = req.body;
        
        if (!terminal_cookie) {
            return res.status(400).json({ 
                success: false, 
                error: 'terminal_cookie is required' 
            });
        }
        
        // Check for existing healthy active session
        const existingSession = await TerminalSessions.findOne({
            where: { 
                terminal_cookie, 
                status: 'active' 
            }
        });
        
        if (existingSession && await isSessionHealthy(existingSession.id)) {
            await existingSession.update({ 
                last_activity: new Date(),
                last_accessed: new Date()
            });
            
            console.log(`⚡ TERMINAL REUSE: Returning existing session for cookie ${terminal_cookie}`);
            
            return res.json({
                success: true,
                data: {
                    id: existingSession.terminal_cookie,
                    websocket_url: `/term/${existingSession.id}`,
                    reused: true,
                    created_at: existingSession.created_at,
                    buffer: existingSession.session_buffer || '',
                    status: 'active'
                }
            });
        }
        
        // Clean up any existing unhealthy session
        if (existingSession) {
            const ptyProcess = activePtyProcesses.get(existingSession.id);
            if (ptyProcess) {
                ptyProcess.kill();
                activePtyProcesses.delete(existingSession.id);
            }
            await existingSession.destroy();
            console.log(`🧹 Cleaned up unhealthy session for cookie ${terminal_cookie}`);
        }
        
        // Create new session with async PTY spawning
        console.log(`🆕 TERMINAL CREATE: Creating new session for cookie ${terminal_cookie}`);
        
        let session;
        
        try {
            session = await createSessionRecord(zone_name, terminal_cookie);
        } catch (error) {
            // Handle race condition if another request created the same cookie
            if (error.name === 'SequelizeUniqueConstraintError') {
                console.log(`🔄 TERMINAL COLLISION: Cookie ${terminal_cookie} exists, finding existing...`);
                session = await TerminalSessions.findOne({ where: { terminal_cookie } });
                if (!session) {
                    throw new Error('Uniqueness error but session not found');
                }
            } else {
                throw error;
            }
        }
        
        // Start PTY asynchronously - DON'T AWAIT (key optimization!)
        spawnPtyProcessAsync(session).catch(error => {
            console.error(`❌ Failed to spawn PTY for session ${session.id}:`, error);
        });
        
        // Return immediately (should be ~100ms)
        console.log(`⚡ TERMINAL FAST: Returning immediate response for cookie ${terminal_cookie}`);
        res.json({
            success: true,
            data: {
                id: session.terminal_cookie,
                websocket_url: `/term/${session.id}`,
                reused: false,
                created_at: session.created_at,
                buffer: '',
                status: 'connecting'
            }
        });
    } catch (error) {
        console.error('Error starting terminal session:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Failed to start terminal session' 
        });
    }
};

/**
 * @swagger
 * /terminal/sessions/{terminal_cookie}/health:
 *   get:
 *     summary: Check terminal session health
 *     description: Validates if a terminal session identified by terminal_cookie is still healthy and active.
 *     tags: [Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: terminal_cookie
 *         required: true
 *         schema:
 *           type: string
 *         description: Frontend-generated session identifier
 *         example: "terminal_host1_5001_browser123_1234567890"
 *     responses:
 *       200:
 *         description: Session health status.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 healthy:
 *                   type: boolean
 *                   description: True if session is healthy and active
 *                 uptime:
 *                   type: integer
 *                   description: Session uptime in seconds
 *                 last_activity:
 *                   type: string
 *                   format: date-time
 *                   description: Last activity timestamp
 *                 reason:
 *                   type: string
 *                   description: Reason for unhealthy status (if healthy=false)
 *       500:
 *         description: Failed to check session health.
 */
export const checkSessionHealth = async (req, res) => {
    try {
        const { terminal_cookie } = req.params;
        
        const session = await TerminalSessions.findOne({
            where: { 
                terminal_cookie, 
                status: ['active', 'connecting'] // Include both statuses
            }
        });
        
        if (!session) {
            return res.json({ 
                healthy: false, 
                reason: 'Session not found' 
            });
        }
        
        // Handle different session statuses
        if (session.status === 'connecting') {
            const uptime = Math.floor((Date.now() - new Date(session.created_at)) / 1000);
            return res.json({ 
                healthy: true, 
                status: 'connecting',
                uptime,
                last_activity: session.last_activity,
                reason: 'PTY process still starting'
            });
        }
        
        const healthy = await isSessionHealthy(session.id);
        const uptime = Math.floor((Date.now() - new Date(session.created_at)) / 1000);
        
        res.json({ 
            healthy, 
            status: session.status,
            uptime,
            last_activity: session.last_activity,
            ...(healthy ? {} : { reason: 'Process not running' })
        });
    } catch (error) {
        console.error('Error checking session health:', error);
        res.status(500).json({ 
            healthy: false, 
            error: 'Failed to check session health' 
        });
    }
};

/**
 * @swagger
 * /terminal/sessions/{sessionId}:
 *   get:
 *     summary: Get terminal session information
 *     description: Retrieves information about a specific terminal session.
 *     tags: [Terminal]
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
 *               $ref: '#/components/schemas/TerminalSession'
 *       404:
 *         description: Session not found.
 */
export const getTerminalSessionInfo = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = await TerminalSessions.findByPk(sessionId);

        if (!session) {
            return res.status(404).json({ error: 'Terminal session not found' });
        }

        res.json(session);
    } catch (error) {
        console.error('Error getting terminal session info:', error);
        res.status(500).json({ error: 'Failed to get terminal session info' });
    }
};

/**
 * @swagger
 * /terminal/sessions/{sessionId}/stop:
 *   delete:
 *     summary: Stop a terminal session
 *     description: Terminates a specific terminal session.
 *     tags: [Terminal]
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
export const stopTerminalSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const ptyProcess = activePtyProcesses.get(sessionId);

        if (ptyProcess) {
            ptyProcess.kill();
            activePtyProcesses.delete(sessionId);
        }

        const session = await TerminalSessions.findByPk(sessionId);
        if (session) {
            await session.update({ status: 'closed' });
        }

        res.json({ success: true, message: 'Terminal session stopped.' });
    } catch (error) {
        console.error('Error stopping terminal session:', error);
        res.status(500).json({ error: 'Failed to stop terminal session' });
    }
};

/**
 * Retrieves an active pty process by session ID.
 * @param {string} sessionId - The UUID of the terminal session.
 * @returns {import('node-pty').IPty | undefined} The pty process or undefined if not found.
 */
export const getPtyProcess = (sessionId) => {
    return activePtyProcesses.get(sessionId);
};

/**
 * @swagger
 * /term/{sessionId}:
 *   get:
 *     summary: Establish a WebSocket connection for a terminal session
 *     description: |
 *       This endpoint is used to upgrade a standard HTTP GET request to a WebSocket connection for an interactive terminal session.
 *       It is not a traditional REST endpoint and will not return a standard HTTP response. Instead, it will return a 101 Switching Protocols response if successful.
 *       
 *       **Connection Process:**
 *       1. Start a new terminal session by making a `POST` request to `/terminal/start`.
 *       2. Extract the `sessionId` from the response.
 *       3. Use the `sessionId` to construct the WebSocket URL (e.g., `wss://your-host/term/{sessionId}`).
 *       4. Establish a WebSocket connection to this URL.
 *       
 *       **Note:** Unlike the REST endpoints, authentication for the WebSocket upgrade is not handled via the standard `verifyApiKey` middleware. The session must be created via the authenticated `/terminal/start` endpoint first.
 *     tags: [Terminal]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The ID of the terminal session to connect to.
 *     responses:
 *       101:
 *         description: Switching protocols to WebSocket. This indicates a successful upgrade.
 *       404:
 *         description: Not Found. The requested terminal session does not exist or is not active.
 */

/**
 * @swagger
 * /terminal/sessions:
 *   get:
 *     summary: List all terminal sessions
 *     description: Retrieves a list of all terminal sessions.
 *     tags: [Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A list of terminal sessions.
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/TerminalSession'
 */
export const listTerminalSessions = async (req, res) => {
    try {
        const sessions = await TerminalSessions.findAll({
            order: [['created_at', 'DESC']]
        });
        res.json(sessions);
    } catch (error) {
        console.error('Error listing terminal sessions:', error);
        res.status(500).json({ error: 'Failed to list terminal sessions' });
    }
};
