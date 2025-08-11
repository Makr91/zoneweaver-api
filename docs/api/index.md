---
title: API Reference
layout: default
nav_order: 2
has_children: true
permalink: /docs/api/
---

# API Reference
{: .no_toc }

The ZoneWeaver API provides comprehensive RESTful endpoints for managing Bhyve virtual machines, networking, storage, and system monitoring on OmniOS/illumos systems.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Authentication

All API endpoints require authentication using API keys in the Bearer token format:

```http
Authorization: Bearer wh_your_api_key_here
```

See the [Authentication Guide](../guides/authentication/) for detailed setup instructions.

## Base URL

The API is served from your ZoneWeaver API server:

- **HTTPS (Recommended)**: `https://your-server:5001`
- **HTTP**: `http://your-server:5000`

## OpenAPI Specification

The ZoneWeaver API is fully documented using OpenAPI 3.0 specification.

### Interactive Documentation

- **[Live API Reference](reference/)** - Complete interactive API documentation with examples and testing capabilities
- **[OpenAPI JSON](openapi.json)** - Raw OpenAPI specification for tools and integrations

### API Categories

The ZoneWeaver API is organized into the following categories:

#### Zone Management
- Zone lifecycle management (create, start, stop, delete)
- Zone configuration and properties
- Boot environment management

#### Network Management  
- VLAN configuration and management
- VNIC (Virtual Network Interface) management
- Etherstub management
- Network bridge configuration

#### Storage Management
- ZFS dataset management
- ZFS pool management and monitoring
- Swap area management

#### Console Access
- VNC console sessions
- Terminal/SSH sessions (zlogin)
- WebSocket connections for real-time access

#### System Monitoring
- Host system metrics and statistics
- Network usage and performance monitoring
- Storage I/O and capacity monitoring
- CPU and memory statistics

#### Package Management
- Zone provisioning and package installation
- System update management
- Repository management

#### API Management
- API key generation and management
- Bootstrap configuration
- Entity management

---

## Rate Limiting

The API currently does not implement rate limiting, but this may be added in future versions for production deployments.

## Error Handling

The API uses standard HTTP status codes and returns JSON error responses:

```json
{
  "msg": "Error description"
}
```

Common status codes:
- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized (Invalid API key)
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

## Pagination

Paginated endpoints support the following query parameters:
- `limit` - Number of items per page (default: 50)
- `offset` - Number of items to skip

## WebSocket Endpoints

Real-time features use WebSocket connections:
- `/term/{sessionId}` - Terminal sessions
- `/zlogin/{sessionId}` - Zone login sessions
- `/zones/{zoneName}/vnc/websockify` - VNC console access
