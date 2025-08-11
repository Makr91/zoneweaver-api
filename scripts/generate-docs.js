#!/usr/bin/env node

/**
 * @fileoverview Generate static API documentation for GitHub Pages
 * @description Extracts OpenAPI spec and generates static Swagger UI documentation
 */

import fs from 'fs';
import path from 'path';
import { specs } from '../config/swagger.js';

/**
 * Generate static API documentation files
 */
async function generateDocs() {
  console.log('🔧 Generating API documentation...');

  // Ensure docs/api directory exists
  const docsDir = path.join(process.cwd(), 'docs', 'api');
  if (!fs.existsSync(docsDir)) {
    fs.mkdirSync(docsDir, { recursive: true });
  }

  try {
    // Generate OpenAPI JSON spec
    console.log('📝 Writing OpenAPI specification...');
    const openApiJson = JSON.stringify(specs, null, 2);
    fs.writeFileSync(path.join(docsDir, 'openapi.json'), openApiJson);
    console.log('✅ Generated docs/api/openapi.json');

    // Generate static Swagger UI HTML (pure HTML, no Jekyll processing)
    console.log('📝 Generating Swagger UI HTML...');
    const swaggerHtml = generateSwaggerUI();
    fs.writeFileSync(path.join(docsDir, 'swagger-ui.html'), swaggerHtml);
    console.log('✅ Generated docs/api/swagger-ui.html');

    // Generate Jekyll redirect page
    console.log('📝 Generating Jekyll redirect page...');
    const redirectPage = generateRedirectPage();
    fs.writeFileSync(path.join(docsDir, 'reference.md'), redirectPage);
    console.log('✅ Generated docs/api/reference.md');

    console.log('🎉 Documentation generation completed successfully!');
    console.log('');
    console.log('Generated files:');
    console.log('  - docs/api/openapi.json - Raw OpenAPI specification');
    console.log('  - docs/api/swagger-ui.html - Pure HTML Swagger UI (no Jekyll processing)');
    console.log('  - docs/api/reference.md - Jekyll page with embedded Swagger UI');
    console.log('');

  } catch (error) {
    console.error('❌ Error generating documentation:', error.message);
    process.exit(1);
  }
}

/**
 * Generate pure HTML Swagger UI page (no Jekyll processing)
 * @returns {string} Pure HTML content for Swagger UI
 */
function generateSwaggerUI() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZoneWeaver API Reference</title>
    <link rel="icon" type="image/x-icon" href="../assets/images/favicon.ico">
    <link rel="apple-touch-icon" sizes="192x192" href="../assets/images/logo192.png">
    <link rel="apple-touch-icon" sizes="512x512" href="../assets/images/logo512.png">
    <link rel="stylesheet" type="text/css" href="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui.css" />
    <style>
        html {
            box-sizing: border-box;
            overflow: -moz-scrollbars-vertical;
            overflow-y: scroll;
        }
        *, *:before, *:after {
            box-sizing: inherit;
        }
        body {
            margin: 0;
            background: #fafafa;
        }
        .swagger-ui .topbar {
            display: none;
        }
        .swagger-ui .scheme-container {
            background: #4f566b;
            box-shadow: 0 1px 2px 0 rgba(0,0,0,.15);
            margin-bottom: 20px;
        }
        
        /* Fix server variables styling conflicts with Just the Docs */
        .swagger-ui .scheme-container table {
            border-collapse: separate;
            border-spacing: 0;
            font-size: 12px;
        }
        .swagger-ui .scheme-container table td {
            padding: 8px 12px;
            border: 1px solid #d3d3d3;
            background: #fff;
        }
        .swagger-ui .scheme-container select,
        .swagger-ui .scheme-container input {
            font-size: 12px;
            padding: 4px 8px;
            border: 1px solid #ccc;
            border-radius: 3px;
        }
        .swagger-ui .computed-url {
            margin: 10px 0;
            font-size: 13px;
        }
        .swagger-ui .computed-url code {
            background: #f0f0f0;
            padding: 2px 6px;
            border-radius: 3px;
            font-family: monospace;
        }
        
        /* Fix model/schema table styling conflicts */
        .swagger-ui .model-box-control {
            background: none;
            border: none;
            padding: 0;
            margin: 0;
            cursor: pointer;
            color: #3b4151;
            font-size: 12px;
        }
        .swagger-ui .model-toggle {
            margin-right: 6px;
        }
        .swagger-ui .model-toggle.collapsed:after {
            content: '▶';
        }
        .swagger-ui .model-toggle:not(.collapsed):after {
            content: '▼';
        }
        .swagger-ui table.model {
            border-collapse: collapse;
            width: 100%;
        }
        .swagger-ui table.model td {
            padding: 6px 10px;
            border-top: 1px solid #ebebeb;
            vertical-align: top;
            font-size: 13px;
        }
        .swagger-ui table.model .property-row:first-child td {
            border-top: none;
        }
        
        /* Dark theme to match Just the Docs */
        body {
            background: #1c1c1e !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
        }
        
        .swagger-ui {
            color: #e6edf3 !important;
        }
        
        .swagger-ui .info .title {
            color: #e6edf3 !important;
        }
        
        .swagger-ui .info .description {
            color: #8b949e !important;
        }
        
        .swagger-ui .scheme-container {
            background: #21262d !important;
            border: 1px solid #30363d !important;
        }
        
        .swagger-ui .scheme-container table td {
            background: #0d1117 !important;
            border-color: #30363d !important;
            color: #e6edf3 !important;
        }
        
        .swagger-ui .computed-url code {
            background: #21262d !important;
            color: #79c0ff !important;
            border: 1px solid #30363d !important;
        }
        
        .swagger-ui table.model td {
            background: #0d1117 !important;
            border-color: #30363d !important;
            color: #e6edf3 !important;
        }
        
        .swagger-ui .opblock {
            background: #0d1117 !important;
            border: 1px solid #30363d !important;
        }
        
        .swagger-ui .opblock .opblock-summary {
            border-color: #30363d !important;
        }
        
        .swagger-ui .opblock.opblock-post {
            background: #0d1117 !important;
            border-color: #238636 !important;
        }
        
        .swagger-ui .opblock.opblock-get {
            background: #0d1117 !important;
            border-color: #1f6feb !important;
        }
        
        .swagger-ui .opblock.opblock-put {
            background: #0d1117 !important;
            border-color: #d2a863 !important;
        }
        
        .swagger-ui .opblock.opblock-delete {
            background: #0d1117 !important;
            border-color: #da3633 !important;
        }
        
        .swagger-ui .opblock .opblock-summary-method {
            text-shadow: none !important;
        }
        
        .swagger-ui .btn.authorize {
            background: #238636 !important;
            border-color: #2ea043 !important;
            color: #ffffff !important;
        }
        
        .swagger-ui .btn.authorize:hover {
            background: #2ea043 !important;
        }
        
        .swagger-ui input[type=text], .swagger-ui input[type=password], .swagger-ui input[type=search], .swagger-ui input[type=email], .swagger-ui textarea, .swagger-ui select {
            background: #21262d !important;
            border: 1px solid #30363d !important;
            color: #e6edf3 !important;
        }
        
        .swagger-ui input[type=text]:focus, .swagger-ui input[type=password]:focus, .swagger-ui input[type=search]:focus, .swagger-ui input[type=email]:focus, .swagger-ui textarea:focus, .swagger-ui select:focus {
            border-color: #1f6feb !important;
            box-shadow: 0 0 0 3px rgba(31, 111, 235, 0.3) !important;
        }
    </style>
</head>
<body>
    <div id="swagger-ui"></div>

    <script src="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-bundle.js"></script>
    <script src="https://unpkg.com/swagger-ui-dist@5.10.5/swagger-ui-standalone-preset.js"></script>
    <script>
        window.onload = function() {
            // Begin Swagger UI call region
            const ui = SwaggerUIBundle({
                url: 'openapi.json',
                dom_id: '#swagger-ui',
                deepLinking: true,
                presets: [
                    SwaggerUIBundle.presets.apis,
                    SwaggerUIStandalonePreset
                ],
                plugins: [
                    SwaggerUIBundle.plugins.DownloadUrl
                ],
                layout: "StandaloneLayout",
                tryItOutEnabled: true,
                requestInterceptor: function(request) {
                    // Add note about CORS for try-it-out functionality
                    if (request.url.startsWith('http')) {
                        console.log('Note: Try-it-out functionality requires CORS configuration on the API server');
                    }
                    return request;
                }
            });
            // End Swagger UI call region
        };
    </script>
</body>
</html>`;
}

/**
 * Generate Jekyll redirect page that includes the pure HTML Swagger UI
 * @returns {string} Jekyll markdown page with iframe to Swagger UI
 */
function generateRedirectPage() {
  return `---
title: API Reference
layout: default
nav_order: 3
parent: API Reference
permalink: /docs/api/reference/
---

# Interactive API Reference

<div style="width: 100%; height: 800px; border: none; margin: 0; padding: 0;">
  <iframe 
    src="swagger-ui.html" 
    style="width: 100%; height: 100%; border: none; background: white;" 
    title="ZoneWeaver API Reference">
    <p>Your browser does not support iframes. 
       <a href="swagger-ui.html">Click here to view the API documentation</a>
    </p>
  </iframe>
</div>

## Alternative Formats

- **[View Full Screen](swagger-ui.html)** - Open Swagger UI in a new page for better experience
- **[Download OpenAPI Spec](openapi.json)** - Raw OpenAPI 3.0 specification file

---

*The interactive API documentation above allows you to explore all available endpoints, view request/response schemas, and test API calls directly from your browser.*
`;
}

// Run the documentation generation
generateDocs().catch(console.error);
