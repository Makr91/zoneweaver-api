import { getPtyProcess } from './TerminalSessionController.js';

/**
 * @fileoverview Xterm Terminal WebSocket handler for Zoneweaver API
 * @description Handles the WebSocket connection for an active terminal session.
 */

/**
 * Handles a new WebSocket connection for an existing terminal session.
 * @param {import('ws').WebSocket} ws - The WebSocket connection object.
 * @param {string} sessionId - The ID of the terminal session.
 */
export const handleTerminalConnection = (ws, sessionId) => {
    const ptyProcess = getPtyProcess(sessionId);

    if (!ptyProcess) {
        ws.send('Terminal session not found.');
        ws.close();
        return;
    }

    console.log(`WebSocket connected to terminal session: ${sessionId}`);

    // Pipe data from PTY to WebSocket (using 'data' event like the working reference)
    const onPtyData = (data) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(data);
        }
    };
    
    ptyProcess.on('data', onPtyData);

    // Pipe data from WebSocket to PTY (simplified to match working reference exactly)
    ws.on('message', command => {
        ptyProcess.write(command.toString());
    });

    // Handle WebSocket close
    ws.on('close', () => {
        console.log(`WebSocket closed for terminal session: ${sessionId}`);
        ptyProcess.removeListener('data', onPtyData);
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for terminal session ${sessionId}:`, error);
    });
};
