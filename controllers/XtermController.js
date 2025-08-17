import { getPtyProcess } from './TerminalSessionController.js';
import TerminalSessions from '../models/TerminalSessionModel.js';

/**
 * @fileoverview Xterm Terminal WebSocket handler for Zoneweaver API
 * @description Handles the WebSocket connection for an active terminal session.
 */

/**
 * Handles a new WebSocket connection for an existing terminal session.
 * @param {import('ws').WebSocket} ws - The WebSocket connection object.
 * @param {string} sessionId - The ID of the terminal session.
 */
export const handleTerminalConnection = async (ws, sessionId) => {
    const ptyProcess = getPtyProcess(sessionId);

    if (!ptyProcess) {
        ws.send('Terminal session not found.');
        ws.close();
        return;
    }

    // Get session from database for buffer management
    const session = await TerminalSessions.findByPk(sessionId);
    if (!session) {
        ws.send('Terminal session not found in database.');
        ws.close();
        return;
    }

    console.log(`WebSocket connected to terminal session: ${sessionId} (cookie: ${session.terminal_cookie})`);

    // Send existing buffer on connection (for reconnection context)
    if (session.session_buffer) {
        const bufferLines = session.session_buffer.split('\n');
        const contextLines = bufferLines.slice(-50); // Send last 50 lines as context
        if (contextLines.length > 0) {
            ws.send('\r\n=== Session Reconnected - Last 50 lines ===\r\n');
            ws.send(contextLines.join('\r\n'));
            ws.send('\r\n=== Live Terminal ===\r\n');
        }
    }

    // Update last accessed timestamp
    await session.update({ 
        last_accessed: new Date(),
        last_activity: new Date()
    });

    // Pipe data from PTY to WebSocket and capture for buffer
    const onPtyData = async (data) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(data);
        }
        
        // Append to session buffer (keep last 1000 lines)
        try {
            const currentBuffer = session.session_buffer || '';
            const newBuffer = (currentBuffer + data).split('\n').slice(-1000).join('\n');
            
            await session.update({ 
                session_buffer: newBuffer,
                last_activity: new Date() 
            });
        } catch (error) {
            console.error(`Error updating session buffer for ${sessionId}:`, error);
        }
    };
    
    ptyProcess.on('data', onPtyData);

    // Pipe data from WebSocket to PTY and update activity
    ws.on('message', async (command) => {
        ptyProcess.write(command.toString());
        
        // Update activity timestamp on user input
        try {
            await session.update({ last_activity: new Date() });
        } catch (error) {
            console.error(`Error updating activity for ${sessionId}:`, error);
        }
    });

    // Handle WebSocket close
    ws.on('close', () => {
        console.log(`WebSocket closed for terminal session: ${sessionId} (cookie: ${session.terminal_cookie})`);
        ptyProcess.removeListener('data', onPtyData);
    });

    // Handle WebSocket errors
    ws.on('error', (error) => {
        console.error(`WebSocket error for terminal session ${sessionId} (cookie: ${session.terminal_cookie}):`, error);
    });
};
