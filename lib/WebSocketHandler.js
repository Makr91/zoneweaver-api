/**
 * @fileoverview WebSocket Handler for Zoneweaver API
 * @description Handles WebSocket upgrade requests for VNC, terminal, and log streaming
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import fs from 'fs';
import { log } from './Logger.js';
import TerminalSessions from '../models/TerminalSessionModel.js';
import ZloginSessions from '../models/ZloginSessionModel.js';
import { handleTerminalConnection } from '../controllers/XtermController.js';
import { handleZloginConnection } from '../controllers/ZloginController.js';
import { handleLogStreamUpgrade } from '../controllers/LogStreamController.js';
import {
  sessionManager,
  connectionTracker,
  performSmartCleanup,
} from '../controllers/VncConsole.js';

/**
 * Setup VNC WebSocket connection
 */
const setupVncWebSocket = (ws, zoneName, sessionInfo, connTracker, smartCleanup) => {
  log.websocket.info('VNC WebSocket client connected', {
    zone_name: zoneName,
    vnc_port: sessionInfo.port,
  });

  // Generate unique connection ID for tracking
  const connectionId = crypto.randomUUID();

  // Track this connection
  connTracker.addConnection(zoneName, connectionId);

  // Create connection to VNC server
  const backendUrl = `ws://127.0.0.1:${sessionInfo.port}/websockify`;
  const backendWs = new WebSocket(backendUrl, {
    protocol: 'binary',
  });

  backendWs.on('open', () => {
    log.websocket.debug('Connected to VNC server', {
      zone_name: zoneName,
      vnc_port: sessionInfo.port,
      connection_id: connectionId,
    });

    // Forward messages between client and VNC server
    ws.on('message', data => {
      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.send(data);
      }
    });

    backendWs.on('message', data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    // Handle connection cleanup
    const handleConnectionClose = () => {
      const isLastClient = connTracker.removeConnection(zoneName, connectionId);

      log.websocket.debug('VNC client WebSocket closed', {
        zone_name: zoneName,
        connection_id: connectionId,
        is_last_client: isLastClient,
      });

      smartCleanup(zoneName, isLastClient);

      if (backendWs.readyState === WebSocket.OPEN) {
        backendWs.close();
      }
    };

    ws.on('close', handleConnectionClose);

    ws.on('error', err => {
      log.websocket.error('VNC client WebSocket error', {
        zone_name: zoneName,
        connection_id: connectionId,
        error: err.message,
      });
      handleConnectionClose();
    });

    backendWs.on('close', () => {
      log.websocket.debug('VNC server WebSocket closed', {
        zone_name: zoneName,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });

    backendWs.on('error', err => {
      log.websocket.error('VNC server WebSocket error', {
        zone_name: zoneName,
        vnc_port: sessionInfo.port,
        error: err.message,
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    });
  });

  backendWs.on('error', err => {
    log.websocket.error('Failed to connect to VNC server', {
      zone_name: zoneName,
      vnc_port: sessionInfo.port,
      backend_url: backendUrl,
      error: err.message,
    });

    const isLastClient = connTracker.removeConnection(zoneName, connectionId);
    smartCleanup(zoneName, isLastClient);

    if (ws.readyState === WebSocket.OPEN) {
      ws.close(1002, 'VNC server connection failed');
    }
  });
};

/**
 * Setup VNC connection
 */
const setupVncConnection = async (zoneName, request, socket, head, wss) => {
  try {
    // Get session info using static imports
    const sessionInfo = await sessionManager.getSessionInfo(zoneName);

    if (!sessionInfo) {
      log.websocket.error('No active VNC session found for zone', {
        zone_name: zoneName,
        pathname: request.url,
      });
      socket.destroy();
      return;
    }

    // Use proper WebSocket server upgrade
    wss.handleUpgrade(request, socket, head, ws => {
      setupVncWebSocket(ws, zoneName, sessionInfo, connectionTracker, performSmartCleanup);
    });
  } catch (error) {
    log.websocket.error('Error setting up VNC connection', {
      zone_name: zoneName,
      error: error.message,
    });
    socket.destroy();
  }
};

/**
 * Extract zone name from request headers
 */
const extractZoneFromHeaders = request => {
  const referer = request.headers.referer || request.headers.origin || '';

  // Try to find zone in referer first
  const refererMatch = referer.match(/\/zones\/(?<zoneName>[^/]+)\/vnc/);
  if (refererMatch) {
    const zoneName = decodeURIComponent(refererMatch.groups.zoneName);
    log.websocket.debug('Extracted zone from referer', {
      zone_name: zoneName,
      referer,
    });
    return zoneName;
  }

  // Check for single active VNC session
  try {
    if (fs.existsSync(sessionManager.pidDir)) {
      const pidFiles = fs.readdirSync(sessionManager.pidDir).filter(file => file.endsWith('.pid'));
      if (pidFiles.length === 1) {
        const zoneName = pidFiles[0].replace('.pid', '');
        log.websocket.info('Using single active VNC session', {
          zone_name: zoneName,
        });
        return zoneName;
      }
      log.websocket.error('Cannot determine zone - multiple active sessions', {
        active_sessions: pidFiles.length,
        sessions: pidFiles,
      });
    } else {
      log.websocket.error('No active VNC sessions found', {
        pathname: request.url,
        referer,
      });
    }
  } catch (error) {
    log.websocket.error('Error extracting zone from headers', {
      error: error.message,
    });
  }

  return null;
};

/**
 * Handle VNC WebSocket upgrade requests
 */
const handleVncWebSocketUpgrade = async (url, request, socket, head, wss) => {
  let zoneName;

  // Handle multiple WebSocket path patterns
  let zonePathMatch = url.pathname.match(/\/zones\/(?<zoneName>[^/]+)\/vnc\/websockify/);
  if (zonePathMatch) {
    zoneName = decodeURIComponent(zonePathMatch.groups.zoneName);
    log.websocket.debug('Zone-specific VNC WebSocket request', {
      zone_name: zoneName,
    });
  } else {
    // Try frontend proxy path pattern
    zonePathMatch = url.pathname.match(
      /\/api\/servers\/[^/]+\/zones\/(?<zoneName>[^/]+)\/vnc\/websockify/
    );
    if (zonePathMatch) {
      zoneName = decodeURIComponent(zonePathMatch.groups.zoneName);
      log.websocket.debug('Frontend proxy VNC WebSocket request', {
        zone_name: zoneName,
      });
    } else if (url.pathname === '/websockify') {
      zoneName = extractZoneFromHeaders(request);
      if (!zoneName) {
        socket.destroy();
        return;
      }
    } else {
      log.websocket.error('Unrecognized WebSocket path', {
        pathname: url.pathname,
      });
      socket.destroy();
      return;
    }
  }

  // Get session info and handle VNC connection
  await setupVncConnection(zoneName, request, socket, head, wss);
};

/**
 * WebSocket upgrade handler
 * @description Handles WebSocket upgrade requests for VNC connections using proper ws library
 */
export const handleWebSocketUpgrade = async (request, socket, head, wss) => {
  try {
    // Debug logging to check if wss is properly passed
    if (!wss) {
      log.websocket.error('WebSocket server instance is undefined', {
        pathname: request?.url,
        wss_type: typeof wss,
      });
      socket.destroy();
      return;
    }
    const url = new URL(request.url, `http://${request.headers.host}`);
    log.websocket.debug('WebSocket upgrade request', {
      pathname: url.pathname,
      host: request.headers.host,
    });

    const termMatch = url.pathname.match(/\/term\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (termMatch) {
      const { sessionId } = termMatch.groups;
      const session = await TerminalSessions.findByPk(sessionId);

      if (!session || session.status !== 'active') {
        log.websocket.warn('Terminal WebSocket upgrade failed - session not found or inactive', {
          session_id: sessionId,
          session_status: session?.status,
        });
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, ws => {
        handleTerminalConnection(ws, sessionId);
      });
      return;
    }

    const zloginMatch = url.pathname.match(/\/zlogin\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (zloginMatch) {
      const { sessionId } = zloginMatch.groups;
      log.websocket.debug('Zlogin WebSocket upgrade request', {
        session_id: sessionId,
        pathname: url.pathname,
      });

      try {
        const session = await ZloginSessions.findByPk(sessionId);

        if (!session) {
          log.websocket.warn('Zlogin session not found for WebSocket upgrade', {
            session_id: sessionId,
          });
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        if (session.status !== 'active' && session.status !== 'connecting') {
          log.websocket.warn('Zlogin WebSocket upgrade failed - invalid session status', {
            session_id: sessionId,
            status: session.status,
          });
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
          socket.destroy();
          return;
        }

        log.websocket.info('Zlogin WebSocket upgrade approved', {
          session_id: sessionId,
          zone_name: session.zone_name,
          status: session.status,
        });

        wss.handleUpgrade(request, socket, head, ws => {
          handleZloginConnection(ws, sessionId);
        });
      } catch (error) {
        log.websocket.error('Error during zlogin WebSocket upgrade', {
          session_id: sessionId,
          error: error.message,
          stack: error.stack,
        });
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
      return;
    }

    // Check for log stream WebSocket requests
    const logStreamMatch = url.pathname.match(/\/logs\/stream\/(?<sessionId>[a-fA-F0-9-]+)/);
    if (logStreamMatch) {
      const { sessionId } = logStreamMatch.groups;
      log.websocket.debug('Log stream WebSocket upgrade request', {
        session_id: sessionId,
      });

      // Handle log stream upgrade
      await handleLogStreamUpgrade(request, socket, head, wss);
      return;
    }

    // Handle VNC WebSocket requests
    await handleVncWebSocketUpgrade(url, request, socket, head, wss);
  } catch (error) {
    log.websocket.error('WebSocket upgrade error', {
      error: error.message,
      stack: error.stack,
      pathname: request?.url,
    });
    socket.destroy();
  }
};
