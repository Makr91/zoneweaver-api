---
title: Getting Started
layout: default
nav_order: 1
parent: Guides
permalink: /docs/guides/getting-started/
---

# Getting Started
{: .no_toc }

This guide will walk you through setting up and configuring the ZoneWeaver API for the first time.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Prerequisites

Before installing the ZoneWeaver API, ensure you have:

- OmniOS r151046 or later
- Node.js 18+ (for development)
- Administrative access to the system
- Network connectivity for package installation

## Installation

### Option 1: OmniOS Package (Recommended)

Install the pre-built package from the repository:

```bash
# Add the ZoneWeaver repository (if not already added)
pkg set-publisher -g https://packages.startcloud.com/omnios Makr91

# Install ZoneWeaver API
pkg install system/virtualization/zoneweaver-api
```

### Option 2: Build from Source

```bash
# Clone the repository
git clone https://github.com/Makr91/zoneweaver-api.git
cd zoneweaver-api

# Install dependencies
npm ci

# Build (optional - can run directly with Node.js)
npm run build
```

## Configuration

### 1. Basic Configuration

The configuration file is located at `/etc/zoneweaver-api/config.yaml`:

```yaml
server:
  http_port: 5000
  https_port: 5001

database:
  dialect: sqlite
  storage: /var/lib/zoneweaver-api/database/zoneweaver.db

api_keys:
  bootstrap_enabled: true
  bootstrap_auto_disable: true
```

### 2. SSL Configuration (Recommended)

For production use, configure SSL certificates:

```yaml
ssl:
  key_path: /etc/zoneweaver-api/ssl/server.key
  cert_path: /etc/zoneweaver-api/ssl/server.crt
```

### 3. CORS Configuration

Configure allowed origins for web frontend access:

```yaml
cors:
  whitelist:
    - "https://your-frontend-domain.com"
    - "https://localhost:3000"  # For development
```

## First Run

### 1. Start the Service

```bash
# Enable and start the service
svcadm enable zoneweaver-api

# Check service status
svcs zoneweaver-api
```

### 2. Generate Bootstrap API Key

On first run, generate an API key using the bootstrap endpoint:

```bash
curl -X POST https://your-server:5001/api-keys/bootstrap \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Initial Setup",
    "description": "Bootstrap API key for initial setup"
  }'
```

This will return an API key that you can use for further configuration.

### 3. Verify Installation

Test the API is working:

```bash
curl -H "Authorization: Bearer wh_your_api_key_here" \
  https://your-server:5001/stats
```

## Next Steps

- [Set up authentication](../authentication/) for secure access
- Configure monitoring and logging
- Set up your frontend application
- Review the [API Reference](../api/) for available endpoints

## Troubleshooting

### Service Won't Start

Check the service logs:
```bash
svcs -xv zoneweaver-api
tail -f /var/log/zoneweaver-api/error.log
```

### Permission Issues

Ensure proper file permissions:
```bash
chown -R zoneweaver:zoneweaver /var/lib/zoneweaver-api
chmod 600 /etc/zoneweaver-api/config.yaml
```

### Network Connectivity

Verify the service is listening on the correct ports:
```bash
netstat -an | grep :5001
