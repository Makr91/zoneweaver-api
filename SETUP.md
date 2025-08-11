# Zoneweaver API Setup and Configuration Guide

This guide covers the complete setup and configuration process for Zoneweaver API on OmniOS.

## System Requirements

### OmniOS Host Requirements
- **Operating System**: OmniOS (FreeBSD support planned)
- **Node.js**: Version 16 or higher
- **Build Tools**: GNU Make
- **Hypervisor**: Bhyve with zone management capabilities

### Network Requirements
- HTTP/HTTPS connectivity between ZoneWeaver frontend and Zoneweaver API
- SSL certificates (optional, for HTTPS)

## Installation

### 1. Prepare the OmniOS Host

```bash
# Install required packages
pfexec pkg install node-16 developer/build/gnu-make

# Create ZFS dataset for Zoneweaver API
pfexec zfs create rpool/zoneweaver-api
```

### 2. Clone and Install

```bash
# Clone the repository
pfexec git clone https://github.com/Makr91/zoneweaver-api /rpool/zoneweaver-api

# Navigate to the directory
cd /rpool/zoneweaver-api

# Install dependencies
MAKE=gmake npm install

# Install nodemon globally (optional, for development)
pfexec npm -g install nodemon
```

### 3. Configuration

Edit `config/config.yaml` to configure your server:

```yaml
server:
  http_port: 5000
  https_port: 5001

ssl:
  key_path: "./ssl/server.key"
  cert_path: "./ssl/server.crt"

cors:
  whitelist:
    - "https://your-zoneweaver-frontend.com"
    - "http://localhost:3000"

database:
  dialect: "sqlite"
  storage: "./database.sqlite"
  logging: false

api_keys:
  bootstrap_enabled: true
  bootstrap_auto_disable: true
  key_length: 64
  hash_rounds: 12

stats:
  public_access: true  # Set to false to require API key for /stats
```

### 4. Start the Server

```bash
# Production
npm start

# Development (with auto-restart)
npm run dev
```

## Initial Setup (Bootstrap Process)

### 1. Generate Bootstrap API Key

After starting the server for the first time, generate the initial API key:

```bash
curl -X POST http://your-host:5000/api-keys/bootstrap \
     -H "Content-Type: application/json" \
     -d '{"name": "Initial-Setup"}'
```

**Important**: The bootstrap endpoint automatically disables after first use for security.

### 2. ZoneWeaver Integration

When setting up ZoneWeaver to manage this backend:

1. Use the bootstrap endpoint to generate the initial API key
2. Configure ZoneWeaver with:
   - **Backend URL**: `https://your-host:5001` or `http://your-host:5000`
   - **API Key**: The generated key from bootstrap
3. ZoneWeaver will validate the connection and can generate additional API keys as needed

## Configuration Options

### Database Configuration

#### SQLite (Default)
```yaml
database:
  dialect: "sqlite"
  storage: "./database.sqlite"
  logging: false
```

#### PostgreSQL (For shared/clustered setups)
```yaml
database:
  dialect: "postgres"
  host: "localhost"
  port: 5432
  database: "zoneweaver_api"
  username: "zoneweaver_api_user"
  password: "secure_password"
  logging: false
```

#### MySQL/MariaDB (For shared/clustered setups)
```yaml
database:
  dialect: "mysql"
  host: "localhost"
  port: 3306
  database: "zoneweaver_api"
  username: "zoneweaver_api_user"
  password: "secure_password"
  logging: false
```

### API Key Configuration

```yaml
api_keys:
  bootstrap_enabled: true           # Set to false to permanently disable bootstrap
  bootstrap_auto_disable: true     # Auto-disable bootstrap after first use
  key_length: 64                   # Length of random bytes for API key generation
  hash_rounds: 12                  # bcrypt hash rounds for API key storage
```

### Stats Endpoint Configuration

```yaml
stats:
  public_access: true              # Set to false to require API key for /stats endpoint
```

### CORS Configuration

```yaml
cors:
  whitelist:
    - "https://your-zoneweaver-frontend.com"
    - "http://localhost:3000"
    - "https://localhost:3001"
```

### SSL Configuration

```yaml
ssl:
  key_path: "./ssl/server.key"
  cert_path: "./ssl/server.crt"
```

## Security Configuration

### API Key Security
- API keys are generated with cryptographically secure random bytes
- Keys are stored as bcrypt hashes in the database
- Keys use the `wh_` prefix for identification
- Usage is tracked with timestamps for audit purposes

### Bootstrap Security
- Bootstrap endpoint auto-disables after first use (configurable)
- Can be permanently disabled via configuration
- Only works when no entities exist in the database

### CORS Security
- Whitelist-based origin validation
- Configurable per environment
- Supports both HTTP and HTTPS origins

## Development Configuration

### Development Mode
```bash
npm run dev
```

### Development Configuration
```yaml
database:
  logging: true  # Enable SQL query logging

cors:
  whitelist:
    - "http://localhost:3000"
    - "https://localhost:3001"
```

## Production Configuration

### Production Checklist
- [ ] Set `stats.public_access: false` if stats should be protected
- [ ] Configure proper CORS whitelist for your frontend domains
- [ ] Set up SSL certificates for HTTPS
- [ ] Configure database logging: false
- [ ] Set `api_keys.bootstrap_auto_disable: true`
- [ ] Use strong, unique secrets if using legacy JWT features

### SSL Certificate Setup
```bash
# Create SSL directory
mkdir ssl

# Generate self-signed certificate (for testing)
openssl req -x509 -newkey rsa:4096 -keyout ssl/server.key -out ssl/server.crt -days 365 -nodes

# Or copy your existing certificates
cp /path/to/your/server.key ssl/
cp /path/to/your/server.crt ssl/
```

## Troubleshooting

### CORS Issues
**Problem**: Frontend can't connect due to CORS errors
**Solution**: Add your frontend domain to the CORS whitelist in `config/config.yaml`

### SSL Certificate Issues
**Problem**: HTTPS server won't start
**Solution**: 
1. Check that SSL certificates exist and are readable
2. Verify certificate paths in configuration
3. Check certificate validity

### Database Connection Issues
**Problem**: Database errors on startup
**Solution**:
1. Check database file permissions (SQLite)
2. Verify database server is running (PostgreSQL/MySQL)
3. Confirm connection credentials

### Bootstrap Issues
**Problem**: Bootstrap endpoint returns 403
**Solution**:
1. Check if bootstrap is enabled in configuration
2. Verify no entities already exist (bootstrap auto-disables)
3. Check server logs for specific error messages

### API Key Issues
**Problem**: API key authentication fails
**Solution**:
1. Verify API key format (should start with `wh_`)
2. Check that API key is active in database
3. Ensure proper Authorization header format: `Bearer wh_your_key`

## Monitoring and Maintenance

### Log Monitoring
- Check server startup logs for configuration issues
- Monitor API key usage via last_used timestamps
- Watch for CORS errors in logs

### Database Maintenance
- Regularly backup SQLite database file
- Monitor database size and performance
- Consider cleanup of inactive API keys

### Security Maintenance
- Regularly rotate API keys
- Monitor API key usage patterns
- Review CORS whitelist periodically
- Update SSL certificates before expiration

## API Documentation

Once the server is running, access the interactive API documentation at:
- **HTTP**: `http://your-host:5000/api-docs`
- **HTTPS**: `https://your-host:5001/api-docs`

The Swagger documentation provides complete API reference with examples and testing capabilities.
