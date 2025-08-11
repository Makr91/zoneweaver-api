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

    // Generate static Swagger UI HTML
    console.log('📝 Generating Swagger UI HTML...');
    const swaggerHtml = generateSwaggerUI();
    fs.writeFileSync(path.join(docsDir, 'reference.html'), swaggerHtml);
    console.log('✅ Generated docs/api/reference.html');

    console.log('🎉 Documentation generation completed successfully!');
    console.log('');
    console.log('Generated files:');
    console.log('  - docs/api/openapi.json - Raw OpenAPI specification');
    console.log('  - docs/api/reference.html - Interactive Swagger UI documentation');
    console.log('');

  } catch (error) {
    console.error('❌ Error generating documentation:', error.message);
    process.exit(1);
  }
}

/**
 * Generate static Swagger UI HTML page
 * @returns {string} HTML content for Swagger UI
 */
function generateSwaggerUI() {
  return `---
title: API Reference
layout: default
nav_order: 3
parent: API Reference
permalink: /docs/api/reference/
---

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ZoneWeaver API Reference</title>
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
        
        /* Dark theme adjustments for Just the Docs integration */
        @media (prefers-color-scheme: dark) {
            body {
                background: #1e1e1e;
            }
            .swagger-ui .scheme-container table td {
                background: #2d2d2d;
                border-color: #444;
                color: #fff;
            }
            .swagger-ui .computed-url code {
                background: #2d2d2d;
                color: #fff;
            }
            .swagger-ui table.model td {
                border-color: #444;
                color: #fff;
            }
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
                url: '../openapi.json',
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

// Run the documentation generation
generateDocs().catch(console.error);
