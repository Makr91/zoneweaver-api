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

      return new Promise(resolve => {
        let output = '';

        psProcess.stdout.on('data', data => {
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
                  log.websocket.debug('Found running zlogin process', {
                    zone_name: zoneName,
                    pid,
                  });
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
      log.websocket.error('Error checking for running zlogin processes', {
        error: error.message,
      });
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
      log.websocket.info('Killing zlogin process', { pid });
      const killProcess = spawn('pfexec', ['kill', '-9', pid.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return new Promise(resolve => {
        killProcess.on('exit', code => {
          if (code === 0) {
            log.websocket.info('Successfully killed zlogin process', { pid });
            resolve(true);
          } else {
            log.websocket.error('Failed to kill zlogin process', {
              pid,
              exit_code: code,
            });
            resolve(false);
          }
        });

        killProcess.on('error', error => {
          log.websocket.error('Error killing zlogin process', {
            pid,
            error: error.message,
          });
          resolve(false);
        });
      });
    } catch (error) {
      log.websocket.error('Error killing zlogin process', {
        pid,
        error: error.message,
      });
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
      log.websocket.debug('Cleaning up stale zlogin processes', {
        zone_name: zoneName,
      });

      // Find running processes
      const runningPid = await this.findRunningZloginProcess(zoneName);

      if (runningPid) {
        // Kill the stale process
        await this.killZloginProcess(runningPid);

        // Clean up any database sessions for this zone that are stale
        const staleSessions = await ZloginSessions.findAll({
          where: {
            zone_name: zoneName,
          },
        });

        for (const session of staleSessions) {
          log.websocket.debug('Cleaning up stale database session', {
            session_id: session.id,
          });
          await session.destroy();
        }

        log.websocket.info('Cleanup completed', {
          zone_name: zoneName,
        });
        return true;
      }
      log.websocket.debug('No stale zlogin processes found', {
        zone_name: zoneName,
      });
      return true;
    } catch (error) {
      log.websocket.error('Error during cleanup', {
        zone_name: zoneName,
        error: error.message,
      });
      return false;
    }
  }

  async cleanupStaleSessions() {
    const activeSessions = await ZloginSessions.findAll({
      where: {
        status: ['active', 'connecting'],
      },
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
    log.websocket.info('Zlogin startup cleanup completed', {
      cleaned_count: cleanedCount,
    });
  }
}

const sessionManager = new ZloginSessionManager();

export const getZloginCleanupTask = () => ({
  name: 'zlogin_cleanup',
  description: 'Clean up closed zlogin sessions',
  model: ZloginSessions,
  where: {
    status: 'closed',
  },
});

export const startZloginSessionCleanup = () => {
  sessionManager.cleanupStaleSessions();
  setInterval(
    () => {
      sessionManager.cleanupStaleSessions();
    },
    30 * 60 * 1000
  ); // Reduced from 5 minutes to 30 minutes - less aggressive cleanup
};

/**
 * Test if zlogin session is healthy by checking PTY process and WebSocket connectivity
 * @param {string} sessionId - The zlogin session ID
 * @returns {Promise<boolean>} True if session is healthy
 */
const testZloginSessionHealth = async sessionId => {
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
    log.websocket.error('Error checking zlogin session health', {
      session_id: sessionId,
      error: error.message,
    });
    return false;
  }
};

/**
 * Spawns a new pty process for a zlogin session.
 * @param {string} zoneName - The name of the zone to connect to.
 * @returns {{session: import('../models/ZloginSessionModel.js').default, ptyProcess: import('node-pty').IPty}}
 */
const spawnZloginProcess = async zoneName => {
  log.websocket.info('[ZLOGIN-SPAWN] Starting PTY spawn process', {
    zone_name: zoneName,
  });

  const shell = os.platform() === 'win32' ? 'powershell.exe' : 'bash';
  const command = `pfexec zlogin -C ${zoneName}`;

  log.websocket.debug('[ZLOGIN-SPAWN] Shell and command details', {
    shell,
    command,
    pty_options: 'name=xterm-color, cols=80, rows=30',
  });

  const ptyProcess = pty.spawn(shell, ['-c', command], {
    name: 'xterm-color',
    cols: 80,
    rows: 30,
    env: process.env,
  });

  log.websocket.info('[ZLOGIN-SPAWN] PTY process created', {
    pid: ptyProcess.pid,
    writable: ptyProcess.writable,
  });

  const session = await ZloginSessions.create({
    zone_name: zoneName,
    pid: ptyProcess.pid,
    status: 'active',
  });

  log.websocket.info('[ZLOGIN-SPAWN] Database session created', {
    session_id: session.id,
    pid: session.pid,
    status: session.status,
  });

  activePtyProcesses.set(session.id, ptyProcess);
  log.websocket.debug('[ZLOGIN-SPAWN] PTY process stored in activePtyProcesses map', {
    session_id: session.id,
    total_active_processes: activePtyProcesses.size,
  });

  ptyProcess.on('exit', (code, signal) => {
    log.websocket.info('[ZLOGIN-SPAWN] Zlogin session exited', {
      session_id: session.id,
      zone_name: zoneName,
      exit_code: code,
      signal,
    });
    activePtyProcesses.delete(session.id);
    session.update({ status: 'closed' });
    log.websocket.debug('[ZLOGIN-SPAWN] Cleanup completed', {
      session_id: session.id,
    });
  });

  ptyProcess.on('data', data => {
    log.websocket.debug('[ZLOGIN-SPAWN] Zlogin session data', {
      session_id: session.id,
      zone_name: zoneName,
      data_length: data.length,
      data_preview: data.substring(0, 200) + (data.length > 200 ? '...' : ''),
    });
  });

  ptyProcess.on('error', error => {
    log.websocket.error('[ZLOGIN-SPAWN] PTY process error', {
      session_id: session.id,
      error: error.message,
      stack: error.stack,
    });
  });

  log.websocket.info('[ZLOGIN-SPAWN] PTY process setup completed', {
    session_id: session.id,
  });
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
    log.websocket.info('Starting zlogin session', { zone_name: zoneName });

    const zone = await Zones.findOne({ where: { name: zoneName } });
    if (!zone) {
      log.websocket.warn('Zone not found', { zone_name: zoneName });
      return res.status(404).json({ error: 'Zone not found' });
    }

    log.websocket.debug('Zone found', {
      zone_name: zoneName,
      status: zone.status,
    });
    if (zone.status !== 'running') {
      log.websocket.warn('Zone not running', {
        zone_name: zoneName,
        status: zone.status,
      });
      return res.status(400).json({ error: 'Zone is not running' });
    }

    // CHECK FOR EXISTING HEALTHY SESSION FIRST (PERFORMANCE OPTIMIZATION)
    log.websocket.debug('Checking for existing healthy session', {
      zone_name: zoneName,
    });
    const existingSession = await ZloginSessions.findOne({
      where: {
        zone_name: zoneName,
        status: 'active',
      },
    });

    if (existingSession) {
      log.websocket.debug('Found existing session', {
        zone_name: zoneName,
        session_id: existingSession.id,
        pid: existingSession.pid,
      });

      // Test if the session is healthy before killing it
      log.websocket.debug('Testing zlogin session health', {
        session_id: existingSession.id,
      });
      const isHealthy = await testZloginSessionHealth(existingSession.id);

      if (isHealthy) {
        log.websocket.info('HEALTHY SESSION FOUND: Reusing existing zlogin session', {
          zone_name: zoneName,
        });

        // Update database last_accessed time for healthy session
        try {
          await existingSession.update({
            updated_at: new Date(),
          });
        } catch (dbError) {
          log.websocket.warn('Failed to update database', {
            zone_name: zoneName,
            error: dbError.message,
          });
        }

        // Return existing healthy session immediately - NO SESSION KILLING!
        return res.json({
          ...existingSession.toJSON(),
          reused_session: true,
          message: 'Healthy zlogin session reused - instant access!',
        });
      }
      log.websocket.info('UNHEALTHY SESSION DETECTED: Session exists but not responding', {
        zone_name: zoneName,
      });
    } else {
      log.websocket.debug('No existing session found, will create new one', {
        zone_name: zoneName,
      });
    }

    // ONLY CLEAN UP IF SESSION IS UNHEALTHY OR MISSING
    log.websocket.debug('Cleaning up unhealthy/missing sessions', {
      zone_name: zoneName,
    });
    await sessionManager.cleanupStaleZloginProcesses(zoneName);

    log.websocket.info('Creating new zlogin session', {
      zone_name: zoneName,
    });
    const { session } = await spawnZloginProcess(zoneName);

    log.websocket.info('Session created successfully', {
      session_id: session.id,
      status: session.status,
    });
    res.json(session);
  } catch (error) {
    log.websocket.error('Error starting zlogin session', {
      error: error.message,
      stack: error.stack,
    });
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
    log.websocket.error('Error getting zlogin session info', {
      error: error.message,
      stack: error.stack,
    });
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
    log.websocket.error('Error stopping zlogin session', {
      error: error.message,
      stack: error.stack,
    });
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
      order: [['created_at', 'DESC']],
    });
    res.json(sessions);
  } catch (error) {
    log.websocket.error('Error listing zlogin sessions', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to list zlogin sessions' });
  }
};

/**
 * Retrieves an active pty process by session ID.
 * @param {string} sessionId - The UUID of the zlogin session.
 * @returns {import('node-pty').IPty | undefined} The pty process or undefined if not found.
 */
export const getZloginPtyProcess = sessionId => activePtyProcesses.get(sessionId);

/**
 * Handles a new WebSocket connection for an existing zlogin session.
 * @param {import('ws').WebSocket} ws - The WebSocket connection object.
 * @param {string} sessionId - The ID of the zlogin session.
 */
export const handleZloginConnection = (ws, sessionId) => {
  log.websocket.debug('[ZLOGIN-WS] handleZloginConnection called', {
    session_id: sessionId,
    websocket_state: ws.readyState,
    state_name:
      ws.readyState === ws.OPEN ? 'OPEN' : ws.readyState === ws.CONNECTING ? 'CONNECTING' : 'OTHER',
  });

  const ptyProcess = getZloginPtyProcess(sessionId);
  log.websocket.debug('[ZLOGIN-WS] PTY process lookup', {
    session_id: sessionId,
    found: !!ptyProcess,
  });

  if (ptyProcess) {
    log.websocket.debug('[ZLOGIN-WS] PTY process details', {
      pid: ptyProcess.pid,
      writable: ptyProcess.writable,
      killed: ptyProcess.killed,
    });
  }

  if (!ptyProcess) {
    log.websocket.error('[ZLOGIN-WS] Zlogin session not found', {
      session_id: sessionId,
      available_sessions: Array.from(activePtyProcesses.keys()),
    });
    try {
      ws.send('Zlogin session not found.\r\n');
      ws.close();
    } catch (error) {
      log.websocket.error('[ZLOGIN-WS] Error closing WebSocket', {
        error: error.message,
      });
    }
    return;
  }

  log.websocket.info('[ZLOGIN-WS] WebSocket connected to zlogin session', {
    session_id: sessionId,
  });

  const onPtyData = data => {
    try {
      log.websocket.debug('[ZLOGIN-WS] PTY data received', {
        session_id: sessionId,
        data_length: data.length,
        data_preview: data.substring(0, 100) + (data.length > 100 ? '...' : ''),
      });
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
        log.websocket.debug('[ZLOGIN-WS] Data sent to WebSocket successfully');
      } else {
        log.websocket.warn('[ZLOGIN-WS] Cannot send data - WebSocket not open', {
          websocket_state: ws.readyState,
        });
      }
    } catch (error) {
      log.websocket.error('[ZLOGIN-WS] Error sending data to WebSocket', {
        session_id: sessionId,
        error: error.message,
      });
    }
  };

  log.websocket.debug('[ZLOGIN-WS] Setting up PTY data listener', {
    session_id: sessionId,
  });
  ptyProcess.on('data', onPtyData);

  ws.on('message', command => {
    try {
      log.websocket.debug('[ZLOGIN-WS] WebSocket message received', {
        session_id: sessionId,
        command_length: command.length,
        command_preview: command.toString().substring(0, 100) + (command.length > 100 ? '...' : ''),
      });
      log.websocket.debug('[ZLOGIN-WS] PTY state check', {
        exists: !!ptyProcess,
        pid: ptyProcess?.pid,
        killed: ptyProcess?.killed,
      });

      // Check if PTY exists and has a valid PID (more reliable than writable property)
      if (ptyProcess && ptyProcess.pid && !ptyProcess.killed) {
        ptyProcess.write(command.toString());
        log.websocket.debug('[ZLOGIN-WS] Command written to PTY successfully');
      } else {
        log.websocket.warn('[ZLOGIN-WS] Cannot write to PTY', {
          exists: !!ptyProcess,
          pid: ptyProcess?.pid,
          killed: ptyProcess?.killed,
        });
      }
    } catch (error) {
      log.websocket.error('[ZLOGIN-WS] Error writing to PTY', {
        session_id: sessionId,
        error: error.message,
      });
    }
  });

  ws.on('close', (code, reason) => {
    log.websocket.info('[ZLOGIN-WS] WebSocket closed', {
      session_id: sessionId,
      code,
      reason: reason || 'none',
    });
    if (ptyProcess && onPtyData) {
      ptyProcess.removeListener('data', onPtyData);
      log.websocket.debug('[ZLOGIN-WS] Removed PTY data listener', {
        session_id: sessionId,
      });
    }
  });

  ws.on('error', error => {
    log.websocket.error('[ZLOGIN-WS] WebSocket error', {
      session_id: sessionId,
      error: error.message,
      stack: error.stack,
    });
  });

  log.websocket.debug('[ZLOGIN-WS] WebSocket event handlers set up', {
    session_id: sessionId,
  });
};
