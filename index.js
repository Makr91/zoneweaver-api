/**
 * @fileoverview Zoneweaver API - Main application entry point
 * @description Express.js server for managing Bhyve virtual machines on OmniOS with API key authentication
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import express from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import WebSocket, { WebSocketServer } from 'ws';
import crypto from 'crypto';
import config from './config/ConfigLoader.js';
import { log } from './lib/Logger.js';
import DatabaseMigrations from './config/DatabaseMigrations.js';
import router from './routes/index.js';
import { specs, swaggerUi } from './config/swagger.js';
import { startTaskProcessor } from './controllers/TaskQueue.js';
import { startVncSessionCleanup } from './controllers/VncConsole.js';
import { handleTerminalConnection } from './controllers/XtermController.js';
import { handleZloginConnection, getZloginCleanupTask } from './controllers/ZloginController.js';
import {
  handleLogStreamUpgrade,
  cleanupLogStreamSessions,
} from './controllers/LogStreamController.js';
import CleanupService from './controllers/CleanupService.js';
import { startHostMonitoring } from './controllers/HostMonitoringService.js';
import { checkAndInstallPackages } from './controllers/ProvisioningController.js';
import ReconciliationService from './controllers/ReconciliationService.js';
import {
  initializeArtifactStorage,
  startArtifactStorage,
} from './controllers/ArtifactStorageService.js';
import { executeDiscoverTask } from './controllers/TaskManager/ZoneManager.js';
import { getAutobootZones } from './lib/ZoneOrchestrationManager.js';
import Tasks, { TaskPriority } from './models/TaskModel.js';
import TerminalSessions from './models/TerminalSessionModel.js';
import ZloginSessions from './models/ZloginSessionModel.js';

/**
 * Express application instance
 * @type {import('express').Application}
 */
const app = express();

/**
 * Configuration objects loaded from config.yaml
 */
const serverConfig = config.getServer();
const sslConfig = config.getSSL();
const corsConfig = config.getCORS();

/**
 * Server port configuration
 */
const httpPort = serverConfig.http_port;
const httpsPort = serverConfig.https_port;

/**
 * CORS configuration options
 * @description Configures Cross-Origin Resource Sharing with whitelist-based origin validation
 */
const corsOptions = {
  origin(origin, callback) {
    if (!origin || corsConfig.whitelist.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  preflightContinue: true,
};

/**
 * Express middleware configuration
 * @description Sets up cookie parsing, CORS, JSON parsing, and API documentation
 */
app.use(cookieParser());
app.use(cors(corsOptions));
app.options('/*splat', cors(corsOptions));
// Get artifact storage configuration for upload limits
const artifactConfig = config.getArtifactStorage?.() || {};
const maxUploadGB = artifactConfig.security?.max_upload_size_gb || 50;
const maxUploadSize = `${maxUploadGB}gb`;

app.set('trust proxy', 1);
app.use(express.json({ limit: maxUploadSize }));
app.use(express.urlencoded({ limit: maxUploadSize, extended: true }));

/**
 * API routes
 * @description Mounts all API endpoints from routes/index.js
 */
app.use(router);

/**
 * Swagger API Documentation middleware (conditionally enabled)
 * @description Serves interactive API documentation at /api-docs endpoint when enabled in configuration
 */
const apiDocsConfig = config.getApiDocs();
if (apiDocsConfig && apiDocsConfig.enabled) {
  log.app.info('API documentation endpoint enabled', {
    endpoint: '/api-docs',
    enabled: true,
  });

  app.use('/api-docs', swaggerUi.serve, (req, res, next) => {
    // Dynamically set the server URL based on the current request
    const { protocol } = req;
    const host = req.get('host');
    const dynamicSpecs = {
      ...specs,
      servers: [
        {
          url: `${protocol}://${host}`,
          description: 'Current server (auto-detected)',
        },
        {
          url: '{protocol}://{host}',
          description: 'Custom server',
          variables: {
            protocol: {
              enum: ['http', 'https'],
              default: 'https',
              description: 'The protocol used to access the server',
            },
            host: {
              default: 'localhost:5001',
              description: 'The hostname and port of the server',
            },
          },
        },
      ],
    };

    swaggerUi.setup(dynamicSpecs, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Zoneweaver API Documentation',
    })(req, res, next);
  });
} else {
  log.app.info('API documentation endpoint disabled by configuration', {
    enabled: false,
  });
}

/**
 * HTTP server instance
 * @type {import('http').Server}
 */
const httpServer = http.createServer(app);

/**
 * WebSocket server for handling VNC connections
 * @description Uses ws library WebSocket server for proper protocol handling
 */
const wss = new WebSocketServer({ noServer: true });

/**
 * WebSocket upgrade handler
 * @description Handles WebSocket upgrade requests for VNC connections using proper ws library
 */
const handleWebSocketUpgrade = async (request, socket, head) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    log.websocket.debug('WebSocket upgrade request', {
      pathname: url.pathname,
      host: request.headers.host,
    });

    const termMatch = url.pathname.match(/\/term\/([a-fA-F0-9\-]+)/);
    if (termMatch) {
      const sessionId = termMatch[1];
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

    const zloginMatch = url.pathname.match(/\/zlogin\/([a-fA-F0-9\-]+)/);
    if (zloginMatch) {
      const sessionId = zloginMatch[1];
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
    const logStreamMatch = url.pathname.match(/\/logs\/stream\/([a-fA-F0-9\-]+)/);
    if (logStreamMatch) {
      const sessionId = logStreamMatch[1];
      log.websocket.debug('Log stream WebSocket upgrade request', {
        session_id: sessionId,
      });

      // Handle log stream upgrade
      await handleLogStreamUpgrade(request, socket, head, wss);
      return;
    }

    let zoneName;

    // Handle multiple WebSocket path patterns
    let zonePathMatch = url.pathname.match(/\/zones\/([^\/]+)\/vnc\/websockify/);
    if (zonePathMatch) {
      zoneName = decodeURIComponent(zonePathMatch[1]);
      log.websocket.debug('Zone-specific VNC WebSocket request', {
        zone_name: zoneName,
      });
    } else {
      // Try frontend proxy path pattern: /api/servers/host:port/zones/zoneName/vnc/websockify
      zonePathMatch = url.pathname.match(
        /\/api\/servers\/[^\/]+\/zones\/([^\/]+)\/vnc\/websockify/
      );
      if (zonePathMatch) {
        zoneName = decodeURIComponent(zonePathMatch[1]);
        log.websocket.debug('Frontend proxy VNC WebSocket request', {
          zone_name: zoneName,
        });
      } else if (url.pathname === '/websockify') {
        // Extract zone from various headers for root /websockify requests
        const referer = request.headers.referer || request.headers.origin || '';

        // Try to find zone in referer first
        const refererMatch = referer.match(/\/zones\/([^\/]+)\/vnc/);
        if (refererMatch) {
          zoneName = decodeURIComponent(refererMatch[1]);
          log.websocket.debug('Extracted zone from referer', {
            zone_name: zoneName,
            referer,
          });
        } else {
          // If we can't find zone info, check if there's only one active VNC session
          const { sessionManager } = await import('./controllers/VncConsole.js');
          const fs = await import('fs');

          if (fs.existsSync(sessionManager.pidDir)) {
            const pidFiles = fs
              .readdirSync(sessionManager.pidDir)
              .filter(file => file.endsWith('.pid'));
            if (pidFiles.length === 1) {
              zoneName = pidFiles[0].replace('.pid', '');
              log.websocket.info('Using single active VNC session', {
                zone_name: zoneName,
              });
            } else {
              log.websocket.error('Cannot determine zone - multiple active sessions', {
                active_sessions: pidFiles.length,
                sessions: pidFiles,
              });
              socket.destroy();
              return;
            }
          } else {
            log.websocket.error('No active VNC sessions found', {
              pathname: url.pathname,
              referer,
            });
            socket.destroy();
            return;
          }
        }
      } else {
        log.websocket.error('Unrecognized WebSocket path', {
          pathname: url.pathname,
        });
        socket.destroy();
        return;
      }
    }

    // Get session info to find the VNC port and connection tracking
    const { sessionManager, connectionTracker, performSmartCleanup } = await import(
      './controllers/VncConsole.js'
    );
    const sessionInfo = await sessionManager.getSessionInfo(zoneName);

    if (!sessionInfo) {
      log.websocket.error('No active VNC session found for zone', {
        zone_name: zoneName,
        pathname: url.pathname,
      });
      socket.destroy();
      return;
    }

    // Use proper WebSocket server upgrade
    wss.handleUpgrade(request, socket, head, ws => {
      log.websocket.info('VNC WebSocket client connected', {
        zone_name: zoneName,
        vnc_port: sessionInfo.port,
      });

      // Generate unique connection ID for tracking
      const connectionId = crypto.randomUUID();

      // Track this connection
      connectionTracker.addConnection(zoneName, connectionId);

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

        // Handle connection cleanup with smart cleanup logic
        const handleConnectionClose = () => {
          // Remove this connection from tracking
          const isLastClient = connectionTracker.removeConnection(zoneName, connectionId);

          log.websocket.debug('VNC client WebSocket closed', {
            zone_name: zoneName,
            connection_id: connectionId,
            is_last_client: isLastClient,
          });

          // Perform smart cleanup if this was the last client
          performSmartCleanup(zoneName, isLastClient);

          // Close backend connection
          if (backendWs.readyState === WebSocket.OPEN) {
            backendWs.close();
          }
        };

        ws.on('close', (code, reason) => {
          handleConnectionClose();
        });

        ws.on('error', err => {
          log.websocket.error('VNC client WebSocket error', {
            zone_name: zoneName,
            connection_id: connectionId,
            error: err.message,
          });
          handleConnectionClose();
        });

        backendWs.on('close', (code, reason) => {
          log.websocket.debug('VNC server WebSocket closed', {
            zone_name: zoneName,
            close_code: code,
            reason,
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

        // Remove connection tracking on error
        const isLastClient = connectionTracker.removeConnection(zoneName, connectionId);
        performSmartCleanup(zoneName, isLastClient);

        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1002, 'VNC server connection failed');
        }
      });
    });
  } catch (error) {
    log.websocket.error('WebSocket upgrade error', {
      error: error.message,
      stack: error.stack,
      pathname: request?.url,
    });
    socket.destroy();
  }
};

// Add WebSocket upgrade handler to HTTP server
httpServer.on('upgrade', handleWebSocketUpgrade);

/**
 * Generate SSL certificates if they don't exist and generate_ssl is enabled
 */
async function generateSSLCertificatesIfNeeded() {
  if (!sslConfig.generate_ssl) {
    return false; // SSL generation disabled
  }

  const keyPath = sslConfig.key_path;
  const certPath = sslConfig.cert_path;

  // Check if certificates already exist
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    log.app.info('SSL certificates already exist, skipping generation', {
      key_path: keyPath,
      cert_path: certPath,
    });
    return false; // Certificates exist, no need to generate
  }

  try {
    log.app.info('Generating SSL certificates', {
      key_path: keyPath,
      cert_path: certPath,
    });

    // Import child_process for running openssl
    const { execSync } = await import('child_process');
    const path = await import('path');

    // Ensure SSL directory exists
    const sslDir = path.dirname(keyPath);
    if (!fs.existsSync(sslDir)) {
      fs.mkdirSync(sslDir, { recursive: true, mode: 0o700 });
    }

    // Generate SSL certificate using OpenSSL
    const opensslCmd = `openssl req -x509 -nodes -days 365 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -subj "/C=US/ST=State/L=City/O=Zoneweaver/CN=localhost"`;

    execSync(opensslCmd, { stdio: 'pipe' });

    // Set proper permissions (readable by current user only)
    fs.chmodSync(keyPath, 0o600);
    fs.chmodSync(certPath, 0o600);

    log.app.info('SSL certificates generated successfully', {
      key_path: keyPath,
      cert_path: certPath,
      validity_days: 365,
    });

    return true; // Certificates generated successfully
  } catch (error) {
    log.app.error('Failed to generate SSL certificates', {
      error: error.message,
      stack: error.stack,
      fallback: 'HTTP only',
    });
    return false; // Generation failed
  }
}

/**
 * HTTPS server setup with SSL certificate handling
 * @description Attempts to create HTTPS server with SSL certificates, gracefully handles missing certificates
 */
(async () => {
  if (sslConfig.enabled) {
    // Try to generate SSL certificates if needed
    await generateSSLCertificatesIfNeeded();

    try {
      const privateKey = fs.readFileSync(sslConfig.key_path, 'utf8');
      const certificate = fs.readFileSync(sslConfig.cert_path, 'utf8');

      const credentials = { key: privateKey, cert: certificate };

      const httpsServer = https.createServer(credentials, app);

      // Add WebSocket upgrade handler for HTTPS server
      httpsServer.on('upgrade', handleWebSocketUpgrade);

      httpsServer.listen(httpsPort, () => {
        const host = serverConfig.hostname || 'localhost';
        log.app.info('HTTPS server started', {
          port: httpsPort,
          host,
          api_docs_url: `https://${host}:${httpsPort}/api-docs`,
        });
      });
    } catch (error) {
      log.app.error('SSL Certificate Error', {
        error: error.message,
        key_path: sslConfig.key_path,
        cert_path: sslConfig.cert_path,
      });
      log.app.warn('HTTPS server not started due to SSL certificate issues', {
        required_key_path: sslConfig.key_path,
        required_cert_path: sslConfig.cert_path,
        suggestion: 'Ensure SSL certificates are available or enable generate_ssl',
      });
    }
  } else {
    log.app.info('SSL disabled in configuration', {
      https_enabled: false,
      server_mode: 'HTTP only',
    });
  }
})();

/**
 * Start HTTP server
 * @description Starts the HTTP server and logs startup information
 */
httpServer.listen(httpPort, () => {
  // Start background services after server is running

  // Initialize database schema and run migrations
  DatabaseMigrations.setupDatabase()
    .then(async success => {
      if (success) {
        // Clear any pending/running tasks from previous server runs
        try {
          const clearedTasks = await Tasks.update(
            { status: 'cancelled' },
            {
              where: {
                status: ['pending', 'running'],
              },
            }
          );
          if (clearedTasks[0] > 0) {
            log.app.info('Cleared pending tasks from previous startup', {
              cleared_count: clearedTasks[0],
            });
          }
        } catch (error) {
          log.app.warn('Failed to clear tasks on startup', {
            error: error.message,
          });
        }

        // Check and install required packages
        await checkAndInstallPackages();

        // Start task processor for zone operations
        startTaskProcessor();

        // Start VNC session cleanup
        startVncSessionCleanup();

        // Register cleanup tasks
        CleanupService.registerTask(getZloginCleanupTask());
        CleanupService.registerTask({
          name: 'log_stream_cleanup',
          description: 'Clean up old log streaming session records',
          handler: cleanupLogStreamSessions,
        });

        // Start cleanup service
        CleanupService.start();

        // Start host monitoring service
        startHostMonitoring();

        // Start reconciliation service
        ReconciliationService.start();

        // Initialize and start artifact storage service
        await initializeArtifactStorage();
        await startArtifactStorage();

        // Check zone orchestration startup
        const orchestrationConfig = config.getZoneOrchestration();
        if (orchestrationConfig.enabled) {
          log.monitoring.info('Zone orchestration enabled - running discovery first');

          try {
            // Force zone discovery to ensure database has fresh configuration data
            const discoveryResult = await executeDiscoverTask();

            if (discoveryResult.success) {
              log.monitoring.info('Zone discovery completed - checking autoboot zones');
            } else {
              log.monitoring.warn('Zone discovery failed during startup', {
                error: discoveryResult.error,
              });
            }

            const autobootZones = await getAutobootZones();

            if (autobootZones.success && autobootZones.zones.length > 0) {
              log.monitoring.info('Zone orchestration startup initiated', {
                autoboot_zones_found: autobootZones.zones.length,
                zones: autobootZones.zones.map(z => ({ name: z.name, priority: z.priority })),
              });

              // Create start tasks for each autoboot zone in priority order (highest first)
              const sortedZones = autobootZones.zones.sort((a, b) => b.priority - a.priority);
              
              // Create all tasks in parallel for 10x performance improvement
              const taskPromises = sortedZones.map(zone => {
                log.monitoring.debug('Zone start task created for autoboot', {
                  zone_name: zone.name,
                  priority: zone.priority,
                });
                
                return Tasks.create({
                  zone_name: zone.name,
                  operation: 'start',
                  priority: TaskPriority.HIGH,
                  created_by: 'orchestration_startup',
                  status: 'pending',
                });
              });
              
              await Promise.all(taskPromises);

              log.monitoring.info('Zone orchestration startup tasks created', {
                zones_queued: sortedZones.length,
              });
            } else {
              log.monitoring.info('Zone orchestration enabled but no autoboot zones found');
            }
          } catch (error) {
            log.monitoring.error('Error during zone orchestration startup', {
              error: error.message,
            });
          }
        }

        log.app.info('Zoneweaver API fully initialized and ready for zone management', {
          services_started: [
            'task_processor',
            'vnc_session_cleanup',
            'cleanup_service',
            'host_monitoring',
            'reconciliation_service',
            'artifact_storage_service',
            orchestrationConfig.enabled ? 'zone_orchestration' : null,
          ].filter(Boolean),
          zone_orchestration_enabled: orchestrationConfig.enabled,
          ready: true,
        });
      } else {
        log.app.error('Database setup failed - some features may not work correctly');
      }
    })
    .catch(error => {
      log.app.error('Database setup error', {
        error: error.message,
        stack: error.stack,
      });
    });
});
