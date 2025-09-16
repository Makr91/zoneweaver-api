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
import { WebSocketServer } from 'ws';

import config from './config/ConfigLoader.js';
import { log } from './lib/Logger.js';
import DatabaseMigrations from './config/DatabaseMigrations.js';
import router from './routes/index.js';
import { specs, swaggerUi } from './config/swagger.js';
import { startTaskProcessor } from './controllers/TaskQueue.js';
import { startVncSessionCleanup } from './controllers/VncConsole.js';
import { getZloginCleanupTask } from './controllers/ZloginController.js';
import { cleanupLogStreamSessions } from './controllers/LogStreamController.js';
import CleanupService from './controllers/CleanupService.js';
import { startHostMonitoring } from './controllers/HostMonitoringService.js';
import { checkAndInstallPackages } from './controllers/ProvisioningController.js';
import ReconciliationService from './controllers/ReconciliationService.js';
import {
  initializeArtifactStorage,
  startArtifactStorage,
} from './controllers/ArtifactStorageService.js';
import { handleWebSocketUpgrade } from './lib/WebSocketHandler.js';
import { setupHTTPSServer } from './lib/SSLManager.js';
import { setupSwaggerDocs } from './lib/SwaggerManager.js';
import { startZoneOrchestration } from './controllers/ZoneOrchestrationService.js';
import Tasks from './models/TaskModel.js';

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
 * Setup Swagger API Documentation
 */
setupSwaggerDocs(app, config.getApiDocs(), specs, swaggerUi);

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

// Add WebSocket upgrade handler to HTTP server
httpServer.on('upgrade', (request, socket, head) => {
  handleWebSocketUpgrade(request, socket, head, wss);
});

/**
 * Setup HTTPS server
 */
setupHTTPSServer(app, sslConfig, httpsPort, serverConfig, handleWebSocketUpgrade);

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

        // Start zone orchestration service
        await startZoneOrchestration();

        log.app.info('Zoneweaver API fully initialized and ready for zone management', {
          services_started: [
            'task_processor',
            'vnc_session_cleanup',
            'cleanup_service',
            'host_monitoring',
            'reconciliation_service',
            'artifact_storage_service',
          ],
          startup_actions_completed: [
            config.getZoneOrchestration().enabled ? 'zone_orchestration_startup' : null,
          ].filter(Boolean),
          zone_orchestration_enabled: config.getZoneOrchestration().enabled,
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
