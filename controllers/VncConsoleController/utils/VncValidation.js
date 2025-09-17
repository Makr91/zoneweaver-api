/**
 * @fileoverview VNC Validation Utilities
 * @description Zone validation, port management, and VNC configuration validation with performance optimizations
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import net from 'net';
import VncSessions from '../../../models/VncSessionModel.js';
import { findProcesses } from '../../../lib/ProcessManager.js';
import { log } from '../../../lib/Logger.js';

/**
 * VNC port range configuration
 * Using 8000-8100 range to avoid browser port restrictions
 */
export const VNC_PORT_RANGE = {
  start: 8000,
  end: 8100,
};

/**
 * VNC session timeout (30 minutes)
 */
export const VNC_SESSION_TIMEOUT = 30 * 60 * 1000;

/**
 * Validate zone name for security
 * @param {string} zoneName - Zone name to validate
 * @returns {boolean} True if valid
 */
export const validateZoneName = zoneName => {
  const validPattern = /^[a-zA-Z0-9\-_.]+$/;
  return validPattern.test(zoneName) && zoneName.length <= 64;
};

/**
 * Check if port is available using multiple methods
 * @param {number} port - Port to check
 * @returns {Promise<boolean>} True if port is available
 */
export const isPortAvailable = async port => {
  // Method 1: Check for existing zadm processes using this port (with full command line matching)
  try {
    const zadmProcesses = await findProcesses(`zadm vnc.*:${port}`, { fullCommandLine: true });
    log.websocket.debug('Process check result', {
      port,
      pattern: `zadm vnc.*:${port}`,
      processes_found: zadmProcesses.length,
    });
    if (zadmProcesses.length > 0) {
      log.websocket.debug('Port is not available (zadm process found)', {
        port,
        process_count: zadmProcesses.length,
      });
      return false;
    }
  } catch (error) {
    log.websocket.error('Process check failed', {
      port,
      pattern: `zadm vnc.*:${port}`,
      error: error.message,
      stack: error.stack,
    });
    // Don't assume port is available if check failed - fail safe
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
  return new Promise(resolve => {
    const server = net.createServer();

    const handleSuccess = () => {
      server.once('close', () => {
        log.websocket.debug('Port is available', { port });
        resolve(true);
      });
      server.close();
    };

    const handleError = () => {
      log.websocket.debug('Port is not available (bind test failed)', { port });
      resolve(false);
    };

    server.listen(port, handleSuccess);
    server.on('error', handleError);
  });
};

/**
 * Find an available port in the VNC range (optimized to avoid await-in-loop)
 * @returns {Promise<number>} Available port number
 */
export const findAvailablePort = () =>
  // Use recursive approach to avoid await-in-loop performance issues
  new Promise((resolve, reject) => {
    let currentPort = VNC_PORT_RANGE.start;

    const checkNextPort = async () => {
      if (currentPort > VNC_PORT_RANGE.end) {
        reject(new Error('No available ports in VNC range'));
        return;
      }

      try {
        const available = await isPortAvailable(currentPort);
        if (available) {
          log.websocket.debug('Found available port', { port: currentPort });
          resolve(currentPort);
          return;
        }

        currentPort++;
        // Use setImmediate to avoid blocking the event loop
        setImmediate(checkNextPort);
      } catch (error) {
        reject(error);
      }
    };

    // Start checking from the first port
    checkNextPort();
  });

/**
 * Test if VNC web server is responding using Promise-based approach (optimized for performance)
 * @param {number} port - Port to test
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<boolean>} True if server is responding
 */
export const testVncConnection = (port, maxRetries = 10) =>
  // Create a single promise that handles all retry logic internally to avoid await-in-loop
  new Promise(resolve => {
    let attempt = 0;

    const tryConnection = async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.status === 200) {
          log.websocket.debug('VNC connection test successful', { port, attempt });
          resolve(true);
          return;
        }
      } catch {
        // Connection not ready yet, continue to next attempt
      }

      attempt++;
      if (attempt >= maxRetries) {
        log.websocket.debug('VNC connection test failed after all retries', { port, maxRetries });
        resolve(false);
        return;
      }

      // Schedule next attempt with setTimeout (no await needed)
      setTimeout(tryConnection, 500);
    };

    // Start the first attempt
    tryConnection();
  });
