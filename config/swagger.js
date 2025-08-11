import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Zoneweaver API',
      version: '0.1.6', // x-release-please-version
      description: 'API for managing Bhyve virtual machines on OmniOS',
      license: {
        name: 'GPL-3.0',
        url: 'https://zoneweaver-api.startcloud.com/license/',
      },
      contact: {
        name: 'Zoneweaver API',
        url: 'https://zoneweaver-api.startcloud.com',
      },
    },
    externalDocs: {
      description: 'View on GitHub',
      url: 'https://github.com/Makr91/zoneweaver-api'
    },
    servers: [
      {
        url: '{protocol}://{host}',
        description: 'Current server',
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
    ],
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'API Key',
          description: 'API key authentication using Bearer token format. Use format: Bearer wh_your_api_key_here',
        },
      },
      schemas: {
        ApiKey: {
          type: 'object',
          properties: {
            api_key: {
              type: 'string',
              description: 'Generated API key with wh_ prefix',
              example: 'wh_abc123def456...',
            },
            entity_id: {
              type: 'integer',
              description: 'Unique identifier for the entity',
              example: 1,
            },
            name: {
              type: 'string',
              description: 'Human-readable name for the API key',
              example: 'ZoneWeaver-Production',
            },
            description: {
              type: 'string',
              description: 'Optional description of the API key purpose',
              example: 'API key for ZoneWeaver frontend',
            },
            message: {
              type: 'string',
              description: 'Success message',
              example: 'API key generated successfully',
            },
          },
        },
        Entity: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              description: 'Unique identifier',
              example: 1,
            },
            name: {
              type: 'string',
              description: 'Entity name',
              example: 'ZoneWeaver-Production',
            },
            description: {
              type: 'string',
              description: 'Entity description',
              example: 'API key for ZoneWeaver frontend',
            },
            is_active: {
              type: 'boolean',
              description: 'Whether the API key is active',
              example: true,
            },
            created_at: {
              type: 'string',
              format: 'date-time',
              description: 'Creation timestamp',
              example: '2025-06-08T17:18:00.324Z',
            },
            last_used: {
              type: 'string',
              format: 'date-time',
              description: 'Last usage timestamp',
              example: '2025-06-08T17:19:19.921Z',
            },
          },
        },
        Error: {
          type: 'object',
          properties: {
            msg: {
              type: 'string',
              description: 'Error message',
              example: 'Invalid API key',
            },
          },
        },
        ServerStats: {
          type: 'object',
          properties: {
            hostname: {
              type: 'string',
              description: 'Server hostname',
              example: 'omnios-host-01',
            },
            platform: {
              type: 'string',
              description: 'Operating system platform',
              example: 'sunos',
            },
            arch: {
              type: 'string',
              description: 'System architecture',
              example: 'x64',
            },
            cpus: {
              type: 'array',
              description: 'CPU information',
              items: {
                type: 'object',
              },
            },
            freemem: {
              type: 'integer',
              description: 'Free memory in bytes',
              example: 8589934592,
            },
            totalmem: {
              type: 'integer',
              description: 'Total memory in bytes',
              example: 17179869184,
            },
            uptime: {
              type: 'integer',
              description: 'System uptime in seconds',
              example: 86400,
            },
            allzones: {
              type: 'array',
              description: 'All configured zones',
              items: {
                type: 'string',
              },
              example: ['zone1:configured:/zones/zone1:excl:0:uuid1', 'zone2:running:/zones/zone2:excl:1:uuid2'],
            },
            runningzones: {
              type: 'array',
              description: 'Currently running zones',
              items: {
                type: 'string',
              },
              example: ['zone2'],
            },
          },
        },
      },
    },
    security: [
      {
        ApiKeyAuth: [],
      },
    ],
  },
  apis: ['./controllers/*.js', './routes/*.js', './models/*.js'], // paths to files containing OpenAPI definitions
};

const specs = swaggerJsdoc(options);

export { specs, swaggerUi };
