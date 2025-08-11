---
title: Configuration
layout: default
nav_order: 4
permalink: /docs/configuration/
---

# Configuration Reference
{: .no_toc }

Complete reference for configuring the ZoneWeaver API using the configuration file.

## Table of contents
{: .no_toc .text-delta }

1. TOC
{:toc}

---

## Configuration File Location

The main configuration file is located at:
- **Package Installation**: `/etc/zoneweaver-api/config.yaml`  
- **Development**: `config/config.yaml`

## Configuration Format

The configuration uses YAML format with the following structure:

```yaml
server:
  http_port: 5000
  https_port: 5001

ssl:
  key_path: /path/to/server.key
  cert_path: /path/to/server.crt

cors:
  whitelist:
    - "https://your-frontend.com"

database:
  dialect: sqlite
  storage: /path/to/database.db
  logging: false

api_keys:
  bootstrap_enabled: true
  bootstrap_auto_disable: true
  key_length: 32
  hash_rounds: 12

stats:
  public_access: false

zones:
  default_brand: bhyve
  monitoring_interval: 30

vnc:
  port_range_start: 6001
  port_range_end: 6100
  web_path: /zones/{zoneName}/vnc

host_monitoring:
  enabled: true
  network_scan_interval: 60
  storage_scan_interval: 300
  system_scan_interval: 30
  max_scan_errors: 5
```

## Configuration Sections

### Server Configuration

Controls basic server behavior and port configuration.

```yaml
server:
  http_port: 5000        # HTTP port (set to 0 to disable)
  https_port: 5001       # HTTPS port (set to 0 to disable)
  bind_address: "0.0.0.0"  # Address to bind to (optional)
```

**Options:**
- `http_port` - HTTP server port (default: 5000)
- `https_port` - HTTPS server port (default: 5001)  
- `bind_address` - IP address to bind to (default: "0.0.0.0")

### SSL Configuration

Configures HTTPS/TLS encryption (highly recommended for production).

```yaml
ssl:
  key_path: /etc/zoneweaver-api/ssl/server.key
  cert_path: /etc/zoneweaver-api/ssl/server.crt
  ca_path: /etc/zoneweaver-api/ssl/ca.crt    # Optional
```

**Options:**
- `key_path` - Path to SSL private key file
- `cert_path` - Path to SSL certificate file
- `ca_path` - Path to CA certificate file (optional)

### CORS Configuration  

Controls Cross-Origin Resource Sharing for web frontend access.

```yaml
cors:
  whitelist:
    - "https://your-frontend.com"
    - "https://localhost:3000"
    - "https://zoneweaver.startcloud.com"
```

**Options:**
- `whitelist` - Array of allowed origins for CORS requests

### Database Configuration

Configures the database connection and behavior.

```yaml
database:
  dialect: sqlite                    # Database type
  storage: /var/lib/zoneweaver-api/database/zoneweaver.db
  logging: false                     # Enable SQL query logging
  pool:                             # Connection pooling (optional)
    max: 5
    min: 0
    idle: 10000
```

**Options:**
- `dialect` - Database type (`sqlite` currently supported)
- `storage` - Path to SQLite database file
- `logging` - Enable SQL query logging (boolean)
- `pool` - Connection pool settings (optional)

### API Key Configuration

Controls API key generation and authentication behavior.

```yaml
api_keys:
  bootstrap_enabled: true           # Allow bootstrap key generation
  bootstrap_auto_disable: true     # Auto-disable bootstrap after first use
  key_length: 32                    # Length of generated keys
  hash_rounds: 12                   # Bcrypt hash rounds for key storage
```

**Options:**
- `bootstrap_enabled` - Enable bootstrap endpoint for initial setup
- `bootstrap_auto_disable` - Disable bootstrap after first use
- `key_length` - Length of generated API keys (default: 32)
- `hash_rounds` - Bcrypt rounds for hashing keys (default: 12)

### Stats Configuration

Controls access to the `/stats` endpoint.

```yaml
stats:
  public_access: false              # Allow unauthenticated access to /stats
```

**Options:**
- `public_access` - Allow public access to stats endpoint (boolean)

### Zone Configuration  

Default settings for zone management.

```yaml
zones:
  default_brand: bhyve              # Default zone brand
  monitoring_interval: 30           # Zone status check interval (seconds)
  auto_discovery: true              # Automatically discover existing zones
```

**Options:**
- `default_brand` - Default zone brand for new zones
- `monitoring_interval` - How often to check zone status
- `auto_discovery` - Automatically discover existing zones

### VNC Configuration

Settings for VNC console functionality.

```yaml
vnc:
  port_range_start: 6001           # Starting port for VNC sessions
  port_range_end: 6100             # Ending port for VNC sessions
  web_path: /zones/{zoneName}/vnc  # URL path for VNC web interface
  timeout: 300                     # Session timeout in seconds
```

**Options:**
- `port_range_start` - First port in VNC port range
- `port_range_end` - Last port in VNC port range  
- `web_path` - URL template for VNC web access
- `timeout` - VNC session timeout

### Host Monitoring Configuration

Controls system monitoring and data collection.

```yaml
host_monitoring:
  enabled: true                     # Enable monitoring
  network_scan_interval: 60         # Network scan interval (seconds)
  storage_scan_interval: 300        # Storage scan interval (seconds)
  system_scan_interval: 30          # System metrics interval (seconds)
  max_scan_errors: 5                # Max consecutive errors before disabling
```

**Options:**
- `enabled` - Enable host monitoring
- `network_scan_interval` - How often to scan network interfaces
- `storage_scan_interval` - How often to scan storage systems
- `system_scan_interval` - How often to collect system metrics
- `max_scan_errors` - Maximum consecutive errors before pausing scans

## Environment Variables

Configuration values can be overridden using environment variables:

```bash
# Server configuration
export ZONEWEAVER_HTTP_PORT=5000
export ZONEWEAVER_HTTPS_PORT=5001

# Database configuration  
export ZONEWEAVER_DB_STORAGE=/custom/path/database.db

# SSL configuration
export ZONEWEAVER_SSL_KEY=/path/to/key.pem
export ZONEWEAVER_SSL_CERT=/path/to/cert.pem
```

Environment variables use the format: `ZONEWEAVER_SECTION_OPTION`

## Configuration Validation

The API validates configuration on startup and will log warnings for:
- Missing SSL certificates (when HTTPS is enabled)
- Invalid port numbers or ranges
- Missing database storage directory
- Invalid monitoring intervals

## Production Recommendations

For production deployments:

1. **Enable HTTPS**:
   ```yaml
   server:
     http_port: 0        # Disable HTTP
     https_port: 5001
   
   ssl:
     key_path: /etc/ssl/private/zoneweaver-api.key
     cert_path: /etc/ssl/certs/zoneweaver-api.crt
   ```

2. **Secure Database**:
   ```yaml
   database:
     storage: /var/lib/zoneweaver-api/database/zoneweaver.db
     logging: false      # Disable query logging
   ```

3. **Configure CORS**:
   ```yaml
   cors:
     whitelist:
       - "https://your-production-frontend.com"
   ```

4. **Disable Bootstrap**:
   ```yaml
   api_keys:
     bootstrap_enabled: false
   ```

## Configuration Backup

Create backups of your configuration:

```bash
# Create backup
cp /etc/zoneweaver-api/config.yaml /etc/zoneweaver-api/config.yaml.backup

# Restore from backup
cp /etc/zoneweaver-api/config.yaml.backup /etc/zoneweaver-api/config.yaml
svcadm restart zoneweaver-api
```