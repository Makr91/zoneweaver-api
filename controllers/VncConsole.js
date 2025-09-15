import { spawn } from 'child_process';
import VncSessions from '../models/VncSessionModel.js';
import Zones from '../models/ZoneModel.js';
import { Op } from 'sequelize';
import net from 'net';
import db from '../config/Database.js';
import fs from 'fs';
import path from 'path';
import yj from 'yieldable-json';
import { log, createTimer } from '../lib/Logger.js';

/**
 * @fileoverview VNC Console controller for Zoneweaver API
 * @description Manages VNC console sessions and proxy connections for zone access using simple PID file approach
 */

/**
 * WebSocket connection tracking for smart cleanup
 */
class VncConnectionTracker {
  constructor() {
    this.connections = new Map(); // zoneName -> Set of connection IDs
  }

  /**
   * Add a client connection for a zone
   * @param {string} zoneName - Zone name
   * @param {string} connectionId - Unique connection ID
   */
  addConnection(zoneName, connectionId) {
    if (!this.connections.has(zoneName)) {
      this.connections.set(zoneName, new Set());
    }
    this.connections.get(zoneName).add(connectionId);
    log.websocket.debug('VNC client connection added', {
      zone_name: zoneName,
      connection_id: connectionId,
      total_connections: this.connections.get(zoneName).size,
    });
  }

  /**
   * Remove a client connection for a zone
   * @param {string} zoneName - Zone name
   * @param {string} connectionId - Unique connection ID
   * @returns {boolean} - True if this was the last connection
   */
  removeConnection(zoneName, connectionId) {
    if (!this.connections.has(zoneName)) {
      return false;
    }

    const zoneConnections = this.connections.get(zoneName);
    zoneConnections.delete(connectionId);

    const remainingConnections = zoneConnections.size;
    log.websocket.debug('VNC client connection removed', {
      zone_name: zoneName,
      connection_id: connectionId,
      remaining_connections: remainingConnections,
    });

    if (remainingConnections === 0) {
      this.connections.delete(zoneName);
      log.websocket.info('Last VNC client disconnected', {
        zone_name: zoneName,
        eligible_for_cleanup: true,
      });
      return true;
    }

    return false;
  }

  /**
   * Get connection count for a zone
   * @param {string} zoneName - Zone name
   * @returns {number} - Number of active connections
   */
  getConnectionCount(zoneName) {
    return this.connections.has(zoneName) ? this.connections.get(zoneName).size : 0;
  }

  /**
   * Get all zones with active connections
   * @returns {Array<string>} - Array of zone names
   */
  getActiveZones() {
    return Array.from(this.connections.keys());
  }
}

/**
 * VNC port range configuration
 * Using 8000-8100 range to avoid browser port restrictions
 */
const VNC_PORT_RANGE = {
  start: 8000,
  end: 8100,
};

/**
 * VNC session timeout (30 minutes)
 */
const VNC_SESSION_TIMEOUT = 30 * 60 * 1000;

// NOTE: Asset caching system removed - frontend now uses react-vnc with direct websockify calls
// No longer need to cache noVNC HTML assets since they're bypassed entirely

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

    return new Promise(resolve => {
      const ps = spawn('ps', ['-p', pid.toString()], { stdio: ['ignore', 'pipe', 'ignore'] });
      let found = false;

      ps.stdout.on('data', data => {
        const output = data.toString();
        if (output.includes(pid.toString())) {
          found = true;
        }
      });

      ps.on('exit', code => {
        // ps returns 0 if process found, 1 if not found
        if (code === 0 || found) {
          resolve(true);
        } else if (isNewProcess) {
          // For new processes, be more lenient and assume they're still starting
          log.websocket.debug('Process not found in ps output, treating as running (new process)', {
            pid,
          });
          resolve(true);
        } else {
          resolve(false);
        }
      });

      ps.on('error', () => {
        if (isNewProcess) {
          log.websocket.debug('Error checking process, treating as running (new process)', { pid });
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
          log.websocket.debug('Timeout checking process, treating as running (new process)', {
            pid,
          });
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
        log.websocket.debug('Session is recent, using lenient process check', {
          zone_name: zoneName,
          age_seconds: Math.round(sessionAge / 1000),
        });
      }

      // Check if process is actually running (with leniency for new processes)
      const isRunning = await this.isProcessRunning(pidNum, isNewProcess);
      if (!isRunning) {
        log.websocket.debug('PID file exists but process is dead, cleaning up', {
          pid: pidNum,
          zone_name: zoneName,
        });
        fs.unlinkSync(pidFile);
        return null;
      }

      return {
        pid: pidNum,
        command,
        timestamp,
        vmname,
        netport,
        port: parseInt(netport.split(':')[1]),
      };
    } catch (error) {
      log.websocket.warn('Error reading PID file', {
        zone_name: zoneName,
        error: error.message,
      });
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
    log.websocket.debug('Session info written to PID file', {
      pid_file: pidFile,
      zone_name: zoneName,
      pid,
    });
  }

  /**
   * Kill session and clean up PID file
   * @param {string} zoneName - Zone name
   * @returns {Promise<boolean>} - True if session was killed
   */
  async killSession(zoneName) {
    const sessionInfo = await this.getSessionInfo(zoneName);

    if (!sessionInfo) {
      log.websocket.debug('No active session found', { zone_name: zoneName });
      return false;
    }

    try {
      log.websocket.info('Killing VNC session using pfexec', {
        zone_name: zoneName,
        pid: sessionInfo.pid,
      });

      // Use pfexec to kill the process immediately with SIGKILL
      const killProcess = spawn('pfexec', ['kill', '-9', sessionInfo.pid.toString()], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return new Promise(resolve => {
        let stdout = '';
        let stderr = '';

        killProcess.stdout.on('data', data => {
          stdout += data.toString();
        });

        killProcess.stderr.on('data', data => {
          stderr += data.toString();
        });

        killProcess.on('exit', code => {
          if (code === 0) {
            log.websocket.info('Successfully killed VNC session', {
              zone_name: zoneName,
              pid: sessionInfo.pid,
            });

            // Remove PID file
            const pidFile = this.getPidFilePath(zoneName);
            if (fs.existsSync(pidFile)) {
              fs.unlinkSync(pidFile);
              log.websocket.debug('Removed PID file', { zone_name: zoneName });
            }

            resolve(true);
          } else {
            log.websocket.error('Failed to kill VNC session', {
              zone_name: zoneName,
              pid: sessionInfo.pid,
              exit_code: code,
              stdout,
              stderr,
            });
            resolve(false);
          }
        });

        killProcess.on('error', error => {
          log.websocket.error('Error killing session', {
            zone_name: zoneName,
            error: error.message,
          });
          resolve(false);
        });

        // Timeout after 5 seconds
        setTimeout(() => {
          log.websocket.warn('Timeout killing session, assuming success', {
            zone_name: zoneName,
          });
          killProcess.kill();

          // Remove PID file anyway
          const pidFile = this.getPidFilePath(zoneName);
          if (fs.existsSync(pidFile)) {
            fs.unlinkSync(pidFile);
            log.websocket.debug('Removed PID file (timeout cleanup)', {
              zone_name: zoneName,
            });
          }

          resolve(true);
        }, 5000);
      });
    } catch (error) {
      log.websocket.error('Error killing session', {
        zone_name: zoneName,
        error: error.message,
      });
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
        log.websocket.info('Cleaned up stale PID file', { zone_name: zoneName });
      }
    }

    log.websocket.info('VNC startup cleanup completed', {
      cleaned_count: cleanedCount,
    });
  }
}

/**
 * Global session manager and connection tracker instances
 */
const sessionManager = new VncSessionManager();
const connectionTracker = new VncConnectionTracker();

/**
 * Check if zone has VNC enabled at boot (from zadm configuration)
 * @param {string} zoneName - Zone name
 * @returns {Promise<boolean>} - True if VNC is enabled at boot
 */
const isVncEnabledAtBoot = async zoneName => {
  try {
    log.websocket.debug('Checking VNC boot configuration for zone', { zone_name: zoneName });

    // Get zone configuration using zadm show
    const configResult = await new Promise(resolve => {
      const child = spawn('sh', ['-c', `pfexec zadm show ${zoneName}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let completed = false;

      const timeoutId = setTimeout(() => {
        if (!completed) {
          completed = true;
          child.kill('SIGTERM');
          resolve({ success: false, error: 'Timeout' });
        }
      }, 10000);

      child.stdout.on('data', data => {
        stdout += data.toString();
      });

      child.stderr.on('data', data => {
        stderr += data.toString();
      });

      child.on('close', code => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);

          if (code === 0) {
            resolve({ success: true, output: stdout });
          } else {
            resolve({ success: false, error: stderr || `Exit code ${code}` });
          }
        }
      });

      child.on('error', error => {
        if (!completed) {
          completed = true;
          clearTimeout(timeoutId);
          resolve({ success: false, error: error.message });
        }
      });
    });

    if (!configResult.success) {
      log.websocket.warn('Failed to get zone configuration', {
        zone_name: zoneName,
        error: configResult.error,
      });
      return false;
    }

    // Parse the JSON configuration
    const config = await new Promise((resolve, reject) => {
      yj.parseAsync(configResult.output, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    // Check if VNC is enabled: config.vnc.enabled === "on"
    const vncEnabled = config.vnc && config.vnc.enabled === 'on';

    log.websocket.debug('Zone VNC boot setting', {
      zone_name: zoneName,
      vnc_enabled: vncEnabled,
    });
    return vncEnabled;
  } catch (error) {
    log.websocket.warn('Error checking VNC boot configuration', {
      zone_name: zoneName,
      error: error.message,
    });
    return false; // Default to false if we can't determine
  }
};

/**
 * Smart cleanup logic - only cleanup VNC sessions when appropriate
 * @param {string} zoneName - Zone name
 * @param {boolean} isLastClient - Whether this was the last client to disconnect
 */
const performSmartCleanup = async (zoneName, isLastClient) => {
  if (!isLastClient) {
    log.websocket.debug('Other clients still connected - no cleanup needed', {
      zone_name: zoneName,
    });
    return;
  }

  log.websocket.debug('Last client disconnected - checking cleanup eligibility', {
    zone_name: zoneName,
  });

  // Check if zone has VNC enabled at boot
  const vncEnabledAtBoot = await isVncEnabledAtBoot(zoneName);

  if (vncEnabledAtBoot) {
    log.websocket.info('Zone has VNC enabled at boot - keeping session alive', {
      zone_name: zoneName,
    });
    return; // Don't cleanup - keep the session running
  }

  log.websocket.info('Zone does NOT have VNC enabled at boot - performing cleanup after delay', {
    zone_name: zoneName,
  });

  // Wait 10 minutes before cleanup to allow reasonable re-access while still freeing resources
  setTimeout(
    async () => {
      // Double-check that no new clients have connected in the meantime
      const currentConnections = connectionTracker.getConnectionCount(zoneName);

      if (currentConnections === 0) {
        log.websocket.info('Performing smart cleanup - no boot VNC and no active clients', {
          zone_name: zoneName,
        });

        const killed = await sessionManager.killSession(zoneName);

        if (killed) {
          // Update database
          try {
            await VncSessions.update(
              { status: 'stopped' },
              { where: { zone_name: zoneName, status: 'active' } }
            );
            log.websocket.info('Smart cleanup completed', { zone_name: zoneName });
          } catch (dbError) {
            log.websocket.warn('Failed to update database during cleanup', {
              zone_name: zoneName,
              error: dbError.message,
            });
          }
        }
      } else {
        log.websocket.info('New clients connected during cleanup delay - canceling cleanup', {
          zone_name: zoneName,
        });
      }
    },
    10 * 60 * 1000
  ); // 10 minute delay for reasonable re-access
};

/**
 * Export session manager and connection tracker for use in WebSocket upgrade handler
 */
export { sessionManager, connectionTracker, performSmartCleanup };

/**
 * Validate zone name for security
 * @param {string} zoneName - Zone name to validate
 * @returns {boolean} True if valid
 */
const validateZoneName = zoneName => {
  const validPattern = /^[a-zA-Z0-9\-_.]+$/;
  return validPattern.test(zoneName) && zoneName.length <= 64;
};

/**
 * Check if port is available using multiple methods
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} True if port is available
 */
const isPortAvailable = async port => {
  // Method 1: Check for existing zadm processes using this port
  const isPortInUseByZadm = await new Promise(resolve => {
    const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';

    ps.stdout.on('data', data => {
      output += data.toString();
    });

    ps.on('exit', () => {
      const lines = output.split('\n');
      const zadmProcesses = lines.filter(
        line => line.includes('zadm vnc') && line.includes(`-w 0.0.0.0:${port} `)
      );

      if (zadmProcesses.length > 0) {
        log.websocket.debug('Port is not available (zadm process found)', {
          port,
          processes: zadmProcesses.map(proc => proc.trim()),
        });
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
      where: { web_port: port, status: 'active' },
    });

    if (existingSession) {
      log.websocket.debug('Port is not available (active VNC session in database)', { port });
      return false;
    }
  } catch (dbError) {
    log.websocket.warn('Failed to check database for port', {
      port,
      error: dbError.message,
    });
  }

  // Method 3: Try to bind to the port
  const canBind = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.once('close', () => resolve(true));
      server.close();
    });
    server.on('error', () => resolve(false));
  });

  if (!canBind) {
    log.websocket.debug('Port is not available (bind test failed)', { port });
    return false;
  }

  log.websocket.debug('Port is available', { port });
  return true;
};

/**
 * Find an available port in the VNC range
 * @returns {Promise<number>} Available port number
 */
const findAvailablePort = async () => {
  for (let port = VNC_PORT_RANGE.start; port <= VNC_PORT_RANGE.end; port++) {
    if (await isPortAvailable(port)) {
      log.websocket.debug('Found available port', { port });
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
      if (response.status === 200) {
        return true;
      }
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

    log.websocket.info('START VNC REQUEST', { zone_name: zoneName });

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
        current_status: zone.status,
      });
    }

    // CHECK FOR EXISTING HEALTHY SESSION FIRST (PERFORMANCE OPTIMIZATION)
    log.websocket.debug('Checking for existing healthy session', { zone_name: zoneName });
    const existingSessionInfo = await sessionManager.getSessionInfo(zoneName);

    if (existingSessionInfo) {
      log.websocket.debug('Found existing session', {
        zone_name: zoneName,
        pid: existingSessionInfo.pid,
        port: existingSessionInfo.port,
      });

      // Test if the session is healthy before killing it
      log.websocket.debug('Testing VNC connection health', { port: existingSessionInfo.port });
      const isHealthy = await testVncConnection(existingSessionInfo.port, 3); // Quick 3-retry test

      if (isHealthy) {
        log.websocket.info('HEALTHY SESSION FOUND: Reusing existing VNC session', {
          zone_name: zoneName,
        });

        // Update database last_accessed time for healthy session
        try {
          await VncSessions.update(
            { last_accessed: new Date() },
            { where: { zone_name: zoneName, status: 'active' } }
          );
        } catch (dbError) {
          log.websocket.warn('Failed to update database', {
            zone_name: zoneName,
            error: dbError.message,
          });
        }

        // Get the actual host IP for direct VNC access
        const hostIP = req.get('host').split(':')[0];

        // Return existing healthy session immediately - NO SESSION KILLING!
        return res.json({
          success: true,
          zone_name: zoneName,
          console_url: `http://${hostIP}:${existingSessionInfo.port}/`,
          proxy_url: `${req.protocol}://${req.get('host')}/zones/${zoneName}/vnc/console`,
          session_id: existingSessionInfo.pid,
          status: 'active',
          web_port: existingSessionInfo.port,
          message: 'Healthy VNC session reused - instant access!',
          direct_access: true,
          started_at: existingSessionInfo.timestamp,
          reused_session: true,
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

    // ONLY KILL IF SESSION IS UNHEALTHY OR MISSING
    log.websocket.debug('Cleaning up unhealthy/missing sessions', { zone_name: zoneName });
    await new Promise(resolve => {
      const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let output = '';

      ps.stdout.on('data', data => {
        output += data.toString();
      });

      ps.on('exit', () => {
        const lines = output.split('\n');
        // Find ALL VNC processes for this zone (including webvnc, vnc, etc.)
        const existingProcesses = lines.filter(line => line.includes('zadm') && 
                           (line.includes('vnc') || line.includes('webvnc')) &&
                           line.includes(zoneName));

        if (existingProcesses.length > 0) {
          log.websocket.info('Found unhealthy VNC processes - killing', {
            zone_name: zoneName,
            process_count: existingProcesses.length,
          });
          existingProcesses.forEach(proc => {
            const parts = proc.trim().split(/\s+/);
            const pid = parseInt(parts[1]);
            log.websocket.debug('Killing unhealthy process', {
              pid,
              process_info: proc.trim(),
            });
            try {
              // Use pfexec to kill root processes
              const killProcess = spawn('pfexec', ['kill', '-9', pid.toString()], {
                stdio: ['ignore', 'ignore', 'ignore'],
              });
              killProcess.on('exit', code => {
                if (code === 0) {
                  log.websocket.debug('Successfully killed unhealthy VNC process', { pid });
                } else {
                  log.websocket.warn('Failed to kill unhealthy VNC process', {
                    pid,
                    exit_code: code,
                  });
                }
              });
            } catch (error) {
              log.websocket.warn('Failed to kill unhealthy VNC process', {
                pid,
                error: error.message,
              });
            }
          });

          // Wait for unhealthy processes to die completely
          log.websocket.debug('Waiting 5 seconds for unhealthy VNC processes to terminate');
          setTimeout(resolve, 5000);
        } else {
          log.websocket.debug('No unhealthy VNC processes found - safe to start new session', {
            zone_name: zoneName,
          });
          resolve();
        }
      });

      ps.on('error', () => {
        log.websocket.warn('Failed to scan for existing VNC processes');
        resolve();
      });
    });

    // No existing session, create new one
    const webPort = await findAvailablePort();
    const netport = `0.0.0.0:${webPort}`;

    log.websocket.info('Spawning VNC process', {
      command: `pfexec zadm vnc -w ${netport} ${zoneName}`,
      zone_name: zoneName,
      port: webPort,
    });

    // Spawn VNC process (detached like Ruby)
    const vncProcess = spawn('pfexec', ['zadm', 'vnc', '-w', netport, zoneName], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    log.websocket.info('VNC process spawned', {
      pid: vncProcess.pid,
      zone_name: zoneName,
    });

    // Write PID file immediately (Ruby approach)
    sessionManager.writeSessionInfo(zoneName, vncProcess.pid, 'webvnc', netport);

    // Set up output handling
    let stdout = '';
    let stderr = '';

    vncProcess.stdout.on('data', data => {
      stdout += data.toString();
      log.websocket.debug('VNC stdout', { data: data.toString().trim() });
    });

    vncProcess.stderr.on('data', data => {
      stderr += data.toString();
      log.websocket.debug('VNC stderr', { data: data.toString().trim() });
    });

    vncProcess.on('exit', (code, signal) => {
      log.websocket.error('VNC process exited', {
        pid: vncProcess.pid,
        zone_name: zoneName,
        exit_code: code,
        signal,
        stdout,
        stderr,
      });

      // Clean up PID file if process exits
      const pidFile = sessionManager.getPidFilePath(zoneName);
      if (fs.existsSync(pidFile)) {
        fs.unlinkSync(pidFile);
        log.websocket.debug('Cleaned up PID file for exited process', {
          pid: vncProcess.pid,
        });
      }
    });

    // Detach the process (Ruby approach)
    vncProcess.unref();

    // Wait a moment for process to start and check if it's still running
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check if process failed (exited with error)
    if (vncProcess.exitCode !== null && vncProcess.exitCode !== 0) {
      log.websocket.error('VNC process failed', {
        exit_code: vncProcess.exitCode,
        stderr,
      });

      // Clean up PID file
      sessionManager.killSession(zoneName);

      if (vncProcess.exitCode === 125 && stderr.includes('Address already in use')) {
        throw new Error(`Port ${webPort} is already in use by another process`);
      }

      throw new Error(
        `VNC process failed with exit code ${vncProcess.exitCode}: ${stderr || 'Unknown error'}`
      );
    }

    // Test if VNC is responding
    log.websocket.debug('Testing VNC connection', { port: webPort });
    const isReady = await testVncConnection(webPort, 15);

    if (!isReady) {
      log.websocket.error('VNC server not responding', { port: webPort });
      // Clean up
      sessionManager.killSession(zoneName);
      throw new Error(`VNC server failed to start on port ${webPort}`);
    }

    log.websocket.info('VNC session started and verified', {
      zone_name: zoneName,
      port: webPort,
      pid: vncProcess.pid,
    });

    // CRITICAL: Final process validation after successful connection test
    log.websocket.debug('Final validation: Checking if process is still alive', {
      pid: vncProcess.pid,
    });
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 more seconds

    // Double-check if process is still running using system process list
    const isStillRunning = await sessionManager.isProcessRunning(vncProcess.pid);
    if (!isStillRunning) {
      log.websocket.error('PROCESS DIED IMMEDIATELY', {
        pid: vncProcess.pid,
        zone_name: zoneName,
        stdout,
        stderr,
        exit_code: vncProcess.exitCode,
        killed: vncProcess.killed,
        message: 'VNC process died right after successful connection test',
      });

      throw new Error(
        `VNC process died immediately after successful startup - check zadm vnc configuration for zone ${zoneName}`
      );
    }

    log.websocket.info('Final validation passed', {
      pid: vncProcess.pid,
      port: webPort,
    });

    // NOTE: Cache warming removed - frontend now uses react-vnc with direct websockify calls

    // Clean up any existing database entries for this zone first
    try {
      await VncSessions.destroy({
        where: { zone_name: zoneName },
      });
    } catch (cleanupError) {
      log.websocket.warn('Failed to cleanup existing database entries', {
        zone_name: zoneName,
        error: cleanupError.message,
      });
    }

    // Update database with session info
    await VncSessions.create({
      zone_name: zoneName,
      web_port: webPort,
      host_ip: '127.0.0.1',
      process_id: vncProcess.pid,
      status: 'active',
      created_at: new Date(),
      last_accessed: new Date(),
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
      direct_access: true,
    });
  } catch (error) {
    log.websocket.error('VNC START ERROR', {
      zone_name: req.params.zoneName,
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      error: 'Failed to start VNC session',
      details: error.message,
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
      Pragma: 'no-cache',
      Expires: '0',
    });

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Check PID file first (Ruby approach)
    const sessionInfo = await sessionManager.getSessionInfo(zoneName);

    if (!sessionInfo) {
      // Double-check by looking for any running VNC process for this zone
      log.websocket.debug('No PID file found, checking for running VNC processes', {
        zone_name: zoneName,
      });

      const runningVncProcess = await new Promise(resolve => {
        const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';

        ps.stdout.on('data', data => {
          output += data.toString();
        });

        ps.on('exit', () => {
          const lines = output.split('\n');
          const vncProcess = lines.find(
            line =>
              line.includes('zadm vnc') && line.includes('-w 0.0.0.0:') && line.includes(zoneName)
          );

          if (vncProcess) {
            const parts = vncProcess.trim().split(/\s+/);
            const pid = parseInt(parts[1]);
            const portMatch = vncProcess.match(/-w 0\.0\.0\.0:(\d+)\s/);
            const port = portMatch ? parseInt(portMatch[1]) : null;

            if (port) {
              log.websocket.info('Found orphaned VNC process', {
                zone_name: zoneName,
                pid,
                port,
              });
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
        sessionManager.writeSessionInfo(zoneName, runningVncProcess.pid, 'webvnc', netport);

        log.websocket.info('Recreated PID file for orphaned VNC session', {
          zone_name: zoneName,
          pid: runningVncProcess.pid,
          port: runningVncProcess.port,
        });

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
            last_accessed: new Date(),
          });
        } catch (dbError) {
          log.websocket.warn('Failed to update database for orphaned session', {
            error: dbError.message,
          });
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
            direct_access: true,
          },
        });
      }

      return res.status(200).json({
        active_vnc_session: false,
        vnc_session_info: null,
        zone_name: zoneName,
        message: 'No active VNC session found',
      });
    }

    log.websocket.info('VNC session info retrieved', {
      zone_name: zoneName,
      pid: sessionInfo.pid,
      port: sessionInfo.port,
    });

    // Update database last_accessed time
    try {
      await VncSessions.update(
        { last_accessed: new Date() },
        { where: { zone_name: zoneName, status: 'active' } }
      );
    } catch (dbError) {
      log.websocket.warn('Failed to update database', {
        zone_name: zoneName,
        error: dbError.message,
      });
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
        direct_access: true,
      },
    });
  } catch (error) {
    log.websocket.error('Error getting VNC session info', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to retrieve VNC session information',
      details: error.message,
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
      log.websocket.warn('Failed to update database', {
        zone_name: zoneName,
        error: dbError.message,
      });
    }

    log.websocket.info('VNC session stopped successfully', {
      zone_name: zoneName,
    });

    res.json({
      success: true,
      zone_name: zoneName,
      message: 'VNC session stopped successfully',
    });
  } catch (error) {
    log.websocket.error('Error stopping VNC session', {
      error: error.message,
      stack: error.stack,
    });
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
          [Op.lt]: cutoffTime,
        },
      },
    });

    for (const session of staleSessions) {
      try {
        // Kill session using PID file approach
        sessionManager.killSession(session.zone_name);

        // Update session status
        await session.update({ status: 'stopped' });
        cleanedCount++;
        log.websocket.info('Cleaned up stale VNC session', {
          zone_name: session.zone_name,
        });
      } catch (error) {
        log.websocket.error('Error cleaning up VNC session', {
          session_id: session.id,
          error: error.message,
        });
      }
    }

    // Delete all stopped sessions since they can't be reopened
    const stoppedSessions = await VncSessions.findAll({
      where: { status: 'stopped' },
    });

    for (const session of stoppedSessions) {
      try {
        await session.destroy();
        cleanedCount++;
        log.websocket.debug('Deleted stopped VNC session', {
          zone_name: session.zone_name,
        });
      } catch (error) {
        log.websocket.error('Error deleting stopped VNC session', {
          session_id: session.id,
          error: error.message,
        });
      }
    }

    return cleanedCount;
  } catch (error) {
    log.websocket.error('Error during VNC session cleanup', {
      error: error.message,
      stack: error.stack,
    });
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
      Pragma: 'no-cache',
      Expires: '0',
    });

    const { status, zone_name } = req.query;
    const whereClause = {};

    if (status) {
      whereClause.status = status;
    }
    if (zone_name) {
      whereClause.zone_name = zone_name;
    }

    const sessions = await VncSessions.findAll({
      where: whereClause,
      order: [['created_at', 'DESC']],
    });

    const activeCount = await VncSessions.count({
      where: { status: 'active' },
    });

    res.json({
      sessions,
      total: sessions.length,
      active_count: activeCount,
    });
  } catch (error) {
    log.websocket.error('Error listing VNC sessions', {
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({ error: 'Failed to retrieve VNC sessions' });
  }
};

/**
 * Clean up orphaned zadm VNC processes that aren't tracked by backend
 */
const cleanupOrphanedVncProcesses = async () => {
  try {
    log.websocket.debug('Scanning for orphaned VNC processes');

    // Get all running zadm vnc processes using ps auxww for full command lines
    const getAllZadmProcesses = () =>
      new Promise(resolve => {
        const ps = spawn('ps', ['auxww'], { stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '';

        ps.stdout.on('data', data => {
          output += data.toString();
        });

        ps.on('exit', () => {
          const lines = output.split('\n');
          const zadmProcesses = lines
            .filter(line => line.includes('zadm vnc') && line.includes('-w 0.0.0.0:'))
            .map(line => {
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
            })
            .filter(proc => proc !== null);

          resolve(zadmProcesses);
        });

        ps.on('error', () => resolve([]));
      });

    const runningProcesses = await getAllZadmProcesses();
    log.websocket.debug('Found running zadm VNC processes', {
      process_count: runningProcesses.length,
    });

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
        where: { status: 'active' },
      });
      for (const session of activeSessions) {
        trackedZones.add(session.zone_name);
      }
    } catch (dbError) {
      log.websocket.warn('Failed to check database for active sessions', {
        error: dbError.message,
      });
    }

    log.websocket.debug('Tracked zones with VNC sessions', {
      zones: Array.from(trackedZones),
    });

    // Kill orphaned processes - be more aggressive since VM can only have one VNC session
    let killedCount = 0;
    for (const proc of runningProcesses) {
      if (!trackedZones.has(proc.zoneName)) {
        log.websocket.info('Killing orphaned VNC process', {
          zone_name: proc.zoneName,
          pid: proc.pid,
          port: proc.port,
        });
        try {
          // Use pfexec to kill root orphaned VNC processes
          const killProcess = spawn('pfexec', ['kill', '-9', proc.pid.toString()], {
            stdio: ['ignore', 'ignore', 'ignore'],
          });
          killProcess.on('exit', code => {
            if (code === 0) {
              log.websocket.info('Successfully killed orphaned VNC process', {
                pid: proc.pid,
              });
            } else {
              log.websocket.warn('Failed to kill orphaned VNC process', {
                pid: proc.pid,
                exit_code: code,
              });
            }
          });
          killedCount++;
        } catch (error) {
          log.websocket.warn('Failed to kill orphaned VNC process', {
            pid: proc.pid,
            error: error.message,
          });
        }
      } else {
        log.websocket.debug('VNC process is properly tracked', {
          zone_name: proc.zoneName,
          pid: proc.pid,
          port: proc.port,
        });
      }
    }

    log.websocket.info('Orphaned VNC process cleanup complete', {
      killed_count: killedCount,
    });
    return killedCount;
  } catch (error) {
    log.websocket.error('Error cleaning up orphaned VNC processes', {
      error: error.message,
      stack: error.stack,
    });
    return 0;
  }
};

/**
 * Clean up stale sessions on startup (after backend restart)
 */
export const cleanupStaleSessionsOnStartup = async () => {
  try {
    log.websocket.info('Cleaning up stale VNC sessions from previous backend instance');

    // Step 1: Clean up orphaned VNC processes first
    const orphanedCount = await cleanupOrphanedVncProcesses();

    // Step 2: Clean up PID files from previous instance
    sessionManager.cleanupStaleSessions();

    // Step 3: Update database to mark orphaned sessions as stopped
    const activeSessions = await VncSessions.findAll({
      where: { status: 'active' },
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
          log.websocket.info('Cleaned up stale VNC session', {
            zone_name: session.zone_name,
            port: session.web_port,
          });
        } else {
          log.websocket.debug('VNC session is still active', {
            zone_name: session.zone_name,
            port: session.web_port,
          });
        }
      } catch (error) {
        // If we can't test the connection, assume it's stale and clean it up
        await session.update({ status: 'stopped' });
        cleanedCount++;
        log.websocket.info('Cleaned up stale VNC session (error testing port)', {
          zone_name: session.zone_name,
        });
      }
    }

    log.websocket.info('Startup cleanup completed', {
      stale_sessions_cleaned: cleanedCount,
      orphaned_processes_killed: orphanedCount,
    });
    return cleanedCount + orphanedCount;
  } catch (error) {
    log.websocket.error('Error during startup VNC session cleanup', {
      error: error.message,
      stack: error.stack,
    });
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

    log.websocket.debug('VNC console request', { zone_name: zoneName });

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    // Get active VNC session info
    const sessionInfo = await sessionManager.getSessionInfo(zoneName);
    if (!sessionInfo) {
      log.websocket.warn('No active VNC session found for console request', {
        zone_name: zoneName,
      });
      return res.status(404).json({
        error: 'No active VNC session found',
        zone_name: zoneName,
      });
    }

    // Proxy to actual VNC server
    const vncUrl = `http://127.0.0.1:${sessionInfo.port}/`;
    log.websocket.debug('Proxying VNC console', { vnc_url: vncUrl });

    try {
      const response = await fetch(vncUrl);

      if (!response.ok) {
        log.websocket.error('VNC server responded with error', {
          status: response.status,
          vnc_port: sessionInfo.port,
        });
        return res.status(502).json({
          error: 'VNC server not responding',
          vnc_port: sessionInfo.port,
          status: response.status,
        });
      }

      // Add aggressive cache-busting headers (matching frontend expectations)
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Content-Type': response.headers.get('content-type') || 'text/html',
      });

      // Convert Web ReadableStream to Node.js stream and pipe
      log.websocket.debug('VNC console content streaming', { zone_name: zoneName });

      // For Node.js 18+ native fetch, response.body is a Web ReadableStream
      // Convert to Node.js Readable stream using Readable.fromWeb()
      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(response.body);
      nodeStream.pipe(res);
    } catch (fetchError) {
      log.websocket.error('Failed to fetch VNC content', {
        vnc_url: vncUrl,
        error: fetchError.message,
      });
      res.status(502).json({
        error: 'Failed to connect to VNC server',
        details: fetchError.message,
        vnc_port: sessionInfo.port,
      });
    }
  } catch (error) {
    log.websocket.error('VNC console error', {
      zone_name: req.params.zoneName,
      error: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      error: 'Failed to serve VNC console',
      details: error.message,
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
    const assetPath = req.params.splat;

    if (!validateZoneName(zoneName)) {
      return res.status(400).json({ error: 'Invalid zone name' });
    }

    log.websocket.debug('VNC asset request', {
      zone_name: zoneName,
      asset_path: assetPath,
    });

    // NOTE: Simplified asset proxy - no caching since react-vnc bypasses most asset requests
    // Get active VNC session info
    const sessionInfo = await sessionManager.getSessionInfo(zoneName);
    if (!sessionInfo) {
      log.websocket.warn('No active VNC session found for asset request', {
        zone_name: zoneName,
        asset_path: assetPath,
      });
      return res.status(404).json({
        error: 'No active VNC session found',
        zone_name: zoneName,
        asset_path: assetPath,
      });
    }

    // Build VNC server asset URL and proxy directly
    const vncUrl = `http://127.0.0.1:${sessionInfo.port}/${assetPath}`;
    log.websocket.debug('Proxying VNC asset', { vnc_url: vncUrl });

    try {
      const response = await fetch(vncUrl);

      if (!response.ok) {
        log.websocket.warn('VNC asset not found', {
          asset_path: assetPath,
          status: response.status,
          vnc_port: sessionInfo.port,
        });
        return res.status(response.status).json({
          error: 'VNC asset not found',
          asset_path: assetPath,
          vnc_port: sessionInfo.port,
          status: response.status,
        });
      }

      const contentType = response.headers.get('content-type') || 'application/octet-stream';

      // Stream asset directly without caching
      res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        Pragma: 'no-cache',
        Expires: '0',
        'Content-Type': contentType,
      });

      // Convert Web ReadableStream to Node.js stream and pipe
      const { Readable } = await import('stream');
      const nodeStream = Readable.fromWeb(response.body);
      nodeStream.pipe(res);
    } catch (fetchError) {
      log.websocket.error('Failed to fetch VNC asset', {
        vnc_url: vncUrl,
        error: fetchError.message,
        asset_path: assetPath,
      });
      res.status(502).json({
        error: 'Failed to connect to VNC server for asset',
        details: fetchError.message,
        asset_path: assetPath,
        vnc_port: sessionInfo.port,
      });
    }
  } catch (error) {
    log.websocket.error('VNC asset error', {
      zone_name: req.params.zoneName,
      error: error.message,
      stack: error.stack,
      asset_path: assetPath,
    });
    res.status(500).json({
      error: 'Failed to proxy VNC asset',
      details: error.message,
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
  log.websocket.info('VNC session cleanup started');
};
