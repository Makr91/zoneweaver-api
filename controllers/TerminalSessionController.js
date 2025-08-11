import os from 'os';
import pty from 'node-pty';
import TerminalSessions from '../models/TerminalSessionModel.js';

/**
 * @fileoverview Terminal Session Controller for Zoneweaver API
 * @description Manages the lifecycle of pseudo-terminal sessions.
 */

const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';

/**
 * In-memory store for active pty processes.
 * @type {Map<string, import('node-pty').IPty>}
 */
const activePtyProcesses = new Map();

/**
 * Spawns a new pty process and stores it.
 * @returns {{session: import('../models/TerminalSessionModel.js').default, ptyProcess: import('node-pty').IPty}}
 */
const spawnPtyProcess = async () => {
    // Use simpler configuration matching the working reference
    const ptyProcess = pty.spawn(shell, [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        env: process.env
    });

    const session = await TerminalSessions.create({
        pid: ptyProcess.pid,
    });

    activePtyProcesses.set(session.id, ptyProcess);

    // Use same event handler as working reference
    ptyProcess.on('exit', (code, signal) => {
        console.log(`Terminal session ${session.id} exited with code ${code}, signal ${signal}`);
        activePtyProcesses.delete(session.id);
        session.update({ status: 'closed' });
    });

    return { session, ptyProcess };
};

/**
 * @swagger
 * /terminal/start:
 *   post:
 *     summary: Start a new terminal session
 *     description: Creates a new pseudo-terminal session and returns its session ID.
 *     tags: [Terminal]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Terminal session started successfully.
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TerminalSession'
 *       500:
 *         description: Failed to start terminal session.
 */
export const startTerminalSession = async (req, res) => {
    try {
        const { session } = await spawnPtyProcess();
        res.json(session);
    } catch (error) {
        console.error('Error starting terminal session:', error);
        res.status(500).json({ error: 'Failed to start terminal session' });
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
