/**
 * @fileoverview Zoneweaver API - Main application entry point
 * @description Express.js server for managing Bhyve virtual machines on OmniOS with API key authentication
 * @author makr91
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import express from "express";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import cookieParser from "cookie-parser";
import cors from "cors";
import WebSocket, { WebSocketServer } from "ws";
import crypto from "crypto";
import config from "./config/ConfigLoader.js";
import db from "./config/Database.js";
import DatabaseMigrations from "./config/DatabaseMigrations.js";
import router from "./routes/index.js";
import { specs, swaggerUi } from "./config/swagger.js";
import { startTaskProcessor } from "./controllers/TaskQueue.js";
import { startVncSessionCleanup } from "./controllers/VncConsole.js";
import { handleTerminalConnection } from "./controllers/XtermController.js";
import { handleZloginConnection, getZloginCleanupTask } from "./controllers/ZloginController.js";
import CleanupService from "./controllers/CleanupService.js";
import { startHostMonitoring } from "./controllers/HostMonitoringService.js";
import { checkAndInstallPackages } from "./controllers/ProvisioningController.js";
import ReconciliationService from "./controllers/ReconciliationService.js";
import TerminalSessions from "./models/TerminalSessionModel.js";
import ZloginSessions from "./models/ZloginSessionModel.js";
import yj from "yieldable-json";

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
  origin: function (origin, callback) {
    if (!origin || corsConfig.whitelist.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      callback(new Error("Not allowed by CORS"))
    }
  },
  credentials: true,
  preflightContinue: true,
}
 
/**
 * Express middleware configuration
 * @description Sets up cookie parsing, CORS, JSON parsing, and API documentation
 */
app.use(cookieParser());
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.set('trust proxy', 1);
app.use(express.json());

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
  console.log('API documentation endpoint enabled at /api-docs');
  
  app.use('/api-docs', swaggerUi.serve, (req, res, next) => {
    // Dynamically set the server URL based on the current request
    const protocol = req.protocol;
    const host = req.get('host');
    const dynamicSpecs = {
      ...specs,
      servers: [
        {
          url: `${protocol}://${host}`,
          description: 'Current server (auto-detected)'
        },
        {
          url: '{protocol}://{host}',
          description: 'Custom server',
          variables: {
            protocol: {
              enum: ['http', 'https'],
              default: 'https',
              description: 'The protocol used to access the server'
            },
            host: {
              default: 'localhost:5001',
              description: 'The hostname and port of the server'
            }
          }
        }
      ]
    };
    
    swaggerUi.setup(dynamicSpecs, {
      explorer: true,
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Zoneweaver API Documentation'
    })(req, res, next);
  });
} else {
  console.log('API documentation endpoint disabled by configuration');
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
    console.log(`🔌 WebSocket upgrade request for: ${url.pathname}`);

    const termMatch = url.pathname.match(/\/term\/([a-fA-F0-9\-]+)/);
    if (termMatch) {
        const sessionId = termMatch[1];
        const session = await TerminalSessions.findByPk(sessionId);

        if (!session || session.status !== 'active') {
            socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
            socket.destroy();
            return;
        }

        wss.handleUpgrade(request, socket, head, (ws) => {
            handleTerminalConnection(ws, sessionId);
        });
        return;
    }

    const zloginMatch = url.pathname.match(/\/zlogin\/([a-fA-F0-9\-]+)/);
    if (zloginMatch) {
        const sessionId = zloginMatch[1];
        console.log(`🔌 [ZLOGIN-UPGRADE] Zlogin WebSocket upgrade request for session: ${sessionId}`);
        console.log(`🔌 [ZLOGIN-UPGRADE] Request headers:`, await new Promise((resolve, reject) => {
            yj.stringifyAsync(request.headers, (err, result) => {
                if (err) reject(err);
                else resolve(result);
            });
        }));
        console.log(`🔌 [ZLOGIN-UPGRADE] URL pathname: ${url.pathname}`);
        
        try {
            const session = await ZloginSessions.findByPk(sessionId);
            console.log(`🔌 [ZLOGIN-UPGRADE] Database lookup result: ${session ? 'FOUND' : 'NOT FOUND'}`);

            if (!session) {
                console.log(`❌ [ZLOGIN-UPGRADE] Zlogin session not found in database: ${sessionId}`);
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            console.log(`🔌 [ZLOGIN-UPGRADE] Session details - ID: ${session.id}, zone: ${session.zone_name}, status: ${session.status}, PID: ${session.pid}`);

            if (session.status !== 'active' && session.status !== 'connecting') {
                console.log(`❌ [ZLOGIN-UPGRADE] Zlogin session ${sessionId} has invalid status: ${session.status}`);
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }

            console.log(`✅ [ZLOGIN-UPGRADE] Zlogin WebSocket upgrade approved for session ${sessionId}, status: ${session.status}`);
            console.log(`✅ [ZLOGIN-UPGRADE] Calling wss.handleUpgrade...`);
            
            wss.handleUpgrade(request, socket, head, (ws) => {
                console.log(`✅ [ZLOGIN-UPGRADE] WebSocket upgrade completed, calling handleZloginConnection...`);
                handleZloginConnection(ws, sessionId);
            });
        } catch (error) {
            console.error(`❌ [ZLOGIN-UPGRADE] Error during zlogin WebSocket upgrade:`, error.message);
            console.error(`❌ [ZLOGIN-UPGRADE] Error stack:`, error.stack);
            socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
            socket.destroy();
        }
        return;
    }
    
    let zoneName;
    
    // Handle multiple WebSocket path patterns
    let zonePathMatch = url.pathname.match(/\/zones\/([^\/]+)\/vnc\/websockify/);
    if (zonePathMatch) {
      zoneName = decodeURIComponent(zonePathMatch[1]);
      console.log(`🔌 Zone-specific WebSocket for: ${zoneName}`);
    } else {
      // Try frontend proxy path pattern: /api/servers/host:port/zones/zoneName/vnc/websockify
      zonePathMatch = url.pathname.match(/\/api\/servers\/[^\/]+\/zones\/([^\/]+)\/vnc\/websockify/);
      if (zonePathMatch) {
        zoneName = decodeURIComponent(zonePathMatch[1]);
        console.log(`🔌 Frontend proxy WebSocket for: ${zoneName}`);
      } else if (url.pathname === '/websockify') {
        // Extract zone from various headers for root /websockify requests
        const referer = request.headers.referer || request.headers.origin || '';
        
        console.log(`🔌 Root WebSocket request - referer: ${referer}`);
        
        // Try to find zone in referer first
        let refererMatch = referer.match(/\/zones\/([^\/]+)\/vnc/);
        if (refererMatch) {
          zoneName = decodeURIComponent(refererMatch[1]);
          console.log(`🔌 Extracted zone from referer: ${zoneName}`);
        } else {
          // If we can't find zone info, check if there's only one active VNC session
          console.log(`🔌 Cannot extract zone from referer, checking active sessions...`);
          
          const { sessionManager } = await import('./controllers/VncConsole.js');
          const fs = await import('fs');
          
          if (fs.existsSync(sessionManager.pidDir)) {
            const pidFiles = fs.readdirSync(sessionManager.pidDir).filter(file => file.endsWith('.pid'));
            if (pidFiles.length === 1) {
              zoneName = pidFiles[0].replace('.pid', '');
              console.log(`🔌 Using single active VNC session: ${zoneName}`);
            } else {
              console.error(`❌ Cannot determine zone - found ${pidFiles.length} active sessions: ${pidFiles.join(', ')}`);
              socket.destroy();
              return;
            }
          } else {
            console.error(`❌ No active VNC sessions found`);
            socket.destroy();
            return;
          }
        }
      } else {
        console.error(`❌ Unrecognized WebSocket path: ${url.pathname}`);
        socket.destroy();
        return;
      }
    }
    
    // Get session info to find the VNC port and connection tracking
    const { sessionManager, connectionTracker, performSmartCleanup } = await import('./controllers/VncConsole.js');
    const sessionInfo = await sessionManager.getSessionInfo(zoneName);
    
    if (!sessionInfo) {
      console.error(`❌ No active VNC session found for zone: ${zoneName}`);
      socket.destroy();
      return;
    }
    
    // Use proper WebSocket server upgrade
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`✅ WebSocket client connected for zone: ${zoneName}`);
      
      // Generate unique connection ID for tracking
      const connectionId = crypto.randomUUID();
      
      // Track this connection
      connectionTracker.addConnection(zoneName, connectionId);
      
      // Create connection to VNC server
      const backendUrl = `ws://127.0.0.1:${sessionInfo.port}/websockify`;
      const backendWs = new WebSocket(backendUrl, {
        protocol: 'binary'
      });
      
      backendWs.on('open', () => {
        console.log(`✅ Connected to VNC server on port ${sessionInfo.port} for zone: ${zoneName}`);
        
        // Forward messages between client and VNC server
        ws.on('message', (data) => {
          if (backendWs.readyState === WebSocket.OPEN) {
            backendWs.send(data);
          }
        });
        
        backendWs.on('message', (data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(data);
          }
        });
        
        // Handle connection cleanup with smart cleanup logic
        const handleConnectionClose = () => {
          console.log(`🔌 Client WebSocket closed for zone ${zoneName} (connection: ${connectionId})`);
          
          // Remove this connection from tracking
          const isLastClient = connectionTracker.removeConnection(zoneName, connectionId);
          
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
        
        ws.on('error', (err) => {
          console.error(`❌ Client WebSocket error for zone ${zoneName}:`, err.message);
          handleConnectionClose();
        });
        
        backendWs.on('close', (code, reason) => {
          console.log(`🔌 VNC server WebSocket closed for zone ${zoneName} (code: ${code})`);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        });
        
        backendWs.on('error', (err) => {
          console.error(`❌ VNC server WebSocket error for zone ${zoneName}:`, err.message);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close();
          }
        });
      });
      
      backendWs.on('error', (err) => {
        console.error(`❌ Failed to connect to VNC server for zone ${zoneName}:`, err.message);
        
        // Remove connection tracking on error
        const isLastClient = connectionTracker.removeConnection(zoneName, connectionId);
        performSmartCleanup(zoneName, isLastClient);
        
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1002, 'VNC server connection failed');
        }
      });
    });
    
  } catch (error) {
    console.error('❌ WebSocket upgrade error:', error.message);
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
    console.log('SSL certificates already exist, skipping generation');
    return false; // Certificates exist, no need to generate
  }

  try {
    console.log('Generating SSL certificates...');
    
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
    
    console.log('SSL certificates generated successfully');
    console.log(`Key: ${keyPath}`);
    console.log(`Certificate: ${certPath}`);
    
    return true; // Certificates generated successfully
  } catch (error) {
    console.error('Failed to generate SSL certificates:', error.message);
    console.error('Continuing with HTTP fallback...');
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
      
      let credentials = { key: privateKey, cert: certificate };

      const httpsServer = https.createServer(credentials, app);
      
      // Add WebSocket upgrade handler for HTTPS server
      httpsServer.on('upgrade', handleWebSocketUpgrade);
      
      httpsServer.listen(httpsPort, () => {
        console.log(`HTTPS Server running on port ${httpsPort}`);
        console.log(`API Documentation: https://localhost:${httpsPort}/api-docs`);
      });
      
    } catch (error) {
      console.error('SSL Certificate Error:', error.message);
      console.log('HTTPS server not started due to SSL certificate issues');
      console.log(`To enable HTTPS, ensure SSL certificates are available at:`);
      console.log(`- Key: ${sslConfig.key_path}`);
      console.log(`- Cert: ${sslConfig.cert_path}`);
    }
  } else {
    console.log('SSL disabled in configuration - HTTPS server not started');
  }
})();

/**
 * Start HTTP server
 * @description Starts the HTTP server and logs startup information
 */
httpServer.listen(httpPort, () => {
  
  // Start background services after server is running
  
  // Initialize database schema and run migrations
  DatabaseMigrations.setupDatabase().then(async success => {
    if (success) {
      // Clear any pending/running tasks from previous server runs
      try {
        const Tasks = (await import('./models/TaskModel.js')).default;
        const clearedTasks = await Tasks.update(
          { status: 'cancelled' },
          { 
            where: { 
              status: ['pending', 'running'] 
            } 
          }
        );
        if (clearedTasks[0] > 0) {
        }
      } catch (error) {
        console.warn('⚠️ Failed to clear tasks on startup:', error.message);
      }
      
      // Check and install required packages
      await checkAndInstallPackages();

      // Start task processor for zone operations
      startTaskProcessor();
      
      // Start VNC session cleanup
      startVncSessionCleanup();
      
      // Register cleanup tasks
      CleanupService.registerTask(getZloginCleanupTask());
      
      // Start cleanup service
      CleanupService.start();
      
      // Start host monitoring service
      startHostMonitoring();

      // Start reconciliation service
      ReconciliationService.start();
      
      console.log('Zoneweaver API fully initialized and ready for zone management!');
    } else {
      console.error('❌ Database setup failed - some features may not work correctly');
    }
  }).catch(error => {
    console.error('❌ Database setup error:', error.message);
  });
});
