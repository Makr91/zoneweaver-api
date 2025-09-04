# ZoneweaverAPI - OmniOS Package

This directory contains the files needed to build an OmniOS IPS package for the ZoneweaverAPI.

## Package Information

- **Package Name**: `system/virtualization/zoneweaver-api`
- **Service Name**: `system/virtualization/zoneweaver-api`
- **User/Group**: `zoneapi` (UID/GID: 301)
- **Installation Path**: `/opt/zoneweaver-api`
- **Configuration**: `/etc/zoneweaver-api`
- **Data Directory**: `/var/lib/zoneweaver-api` (also user home directory)
- **Log Directory**: `/var/log/zoneweaver-api`

## Package Contents

### Build Files
- `build.sh` - Main build script that creates the IPS package
- `zoneweaver-api.p5m` - IPS package manifest
- `local.mog` - Package transformation rules

### SMF Service Files
- `zoneweaver-api-smf.xml` - SMF service manifest
- `startup.sh` - Service startup script
- `shutdown.sh` - Service shutdown script
- `post-install.sh` - Post-installation setup script

### Configuration
- `../config/production-config.yaml` - Production configuration template

## Dependencies

- **Node.js**: `ooce/runtime/node-22`
- **SQLite**: `database/sqlite-3`
- **OpenSSL**: For SSL certificate generation (optional)

## Installation

### From Package Repository
```bash
pkg install system/virtualization/zoneweaver-api
```

### Manual Installation
```bash
# Install the .p5p package file
pkg install -g zoneweaver-api-x.x.x.p5p system/virtualization/zoneweaver-api
```

### Enable and Start Service
```bash
# Enable the service
svcadm enable system/virtualization/zoneweaver-api

# Check service status
svcs system/virtualization/zoneweaver-api

# View service logs
tail -f /var/log/zoneweaver-api/zoneweaver-api.log
```

## Configuration

The service uses configuration file at `/etc/zoneweaver-api/config.yaml`. This file is preserved during package updates.

### SSL Certificates

SSL certificates are automatically generated during first startup if they don't exist:
- **Private Key**: `/etc/zoneweaver-api/ssl/server.key`
- **Certificate**: `/etc/zoneweaver-api/ssl/server.crt`

### Database

The SQLite database is stored at:
- **Database**: `/var/lib/zoneweaver-api/database/database.sqlite`

### User Account and Shell Environment

The `zoneapi` user is created with the following shell initialization files in its home directory (`/var/lib/zoneweaver-api`):
- **`.profile`** - POSIX shell initialization (copied from `/etc/skel/.profile`)
- **`.bashrc`** - Bash-specific initialization (copied from `/etc/skel/.bashrc`)
- **`.kshrc`** - Korn shell initialization (copied from `/etc/skel/.kshrc`)

These files ensure that interactive shell sessions and shell scripts run as the `zoneapi` user have proper environment setup including PATH configuration for OmniOS/OOCE tools.

## API Access

Once running, the API will be available at:
- **HTTP**: `http://localhost:5000`
- **HTTPS**: `https://localhost:5001`
- **API Documentation**: `https://localhost:5001/api-docs`

## Service Management

### SMF Commands
```bash
# Start service
svcadm enable system/virtualization/zoneweaver-api

# Stop service
svcadm disable system/virtualization/zoneweaver-api

# Restart service
svcadm restart system/virtualization/zoneweaver-api

# Refresh configuration
svcadm refresh system/virtualization/zoneweaver-api

# View service status
svcs -l system/virtualization/zoneweaver-api
```

### Log Files
- **Service Log**: `/var/log/zoneweaver-api/zoneweaver-api.log`
- **SMF Log**: `/var/svc/log/system-virtualization-zoneweaver-api:default.log`

## Build Process

The package is built automatically via GitHub Actions when a new release is created. The build process:

1. Syncs version numbers across all configuration files
2. Installs Node.js dependencies (production only)
3. Copies application files to staging area
4. Creates IPS package with proper permissions and ownership
5. Uploads package to GitHub releases
6. Publishes to package repository

## Troubleshooting

### Service Won't Start
1. Check SMF service status: `svcs -xv system/virtualization/zoneweaver-api`
2. Check service logs: `tail -f /var/svc/log/system-virtualization-zoneweaver-api:default.log`
3. Check application logs: `tail -f /var/log/zoneweaver-api/zoneweaver-api.log`
4. Verify configuration: `/etc/zoneweaver-api/config.yaml`

### SSL Certificate Issues
1. Check certificate files exist: `ls -la /etc/zoneweaver-api/ssl/`
2. Check file ownership: `ls -la /etc/zoneweaver-api/ssl/`
3. Regenerate certificates: `rm /etc/zoneweaver-api/ssl/*.{key,crt}` and restart service

### Database Issues
1. Check database directory exists: `/var/lib/zoneweaver-api/database/`
2. Check file ownership: `chown -R zoneweaver-api:zoneweaver-api /var/lib/zoneweaver-api`
3. Check database file permissions

## Package Updates

Configuration files are preserved during package updates. The service will automatically restart after package installation.

## Uninstallation

```bash
# Stop and disable service
svcadm disable system/virtualization/zoneweaver-api

# Remove package
pkg uninstall system/virtualization/zoneweaver-api

# Optional: Clean up data (WARNING: This removes all data!)
rm -rf /var/lib/zoneweaver-api
rm -rf /var/log/zoneweaver-api
```

## Support

For support and documentation, visit:
- **GitHub**: https://github.com/Makr91/zoneweaver-api
- **Issues**: https://github.com/Makr91/zoneweaver-api/issues
