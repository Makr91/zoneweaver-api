/**
 * @fileoverview VNC Console Controller Index
 * @description Main entry point for VNC console controllers
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

// Import session management functions
import { startVncSession, getVncSessionInfo, stopVncSession } from './SessionController.js';

// Import proxy functions
import { serveVncConsole, proxyVncContent } from './ProxyController.js';

// Import management functions
import { listVncSessions } from './ManagementController.js';

// Import cleanup service
import { startVncSessionCleanup } from './utils/VncCleanupService.js';

// Import utilities for WebSocket handler
export { sessionManager } from './utils/VncSessionManager.js';

export { connectionTracker } from './utils/VncConnectionTracker.js';

// Export all functions for backward compatibility
export {
  // Session management
  startVncSession,
  getVncSessionInfo,
  stopVncSession,

  // Proxy functions
  serveVncConsole,
  proxyVncContent,

  // Management functions
  listVncSessions,

  // Cleanup service
  startVncSessionCleanup,
};

// Default export
export default {
  startVncSession,
  getVncSessionInfo,
  stopVncSession,
  serveVncConsole,
  proxyVncContent,
  listVncSessions,
  startVncSessionCleanup,
};
