#!/usr/bin/bash
#
# CDDL HEADER START
#
# The contents of this file are subject to the terms of the
# Common Development and Distribution License, Version 1.0 only
# (the "License").  You may not use this file except in compliance
# with the License.
#
# You can obtain a copy of the license at usr/src/OPENSOLARIS.LICENSE
# or http://www.opensolaris.org/os/licensing.
# See the License for the specific language governing permissions
# and limitations under the License.
#
# When distributing Covered Code, include this CDDL HEADER in each
# file and include the License file at usr/src/OPENSOLARIS.LICENSE.
# If applicable, add the following below this CDDL HEADER, with the
# fields enclosed by brackets "[]" replaced with your own identifying
# information: Portions Copyright [yyyy] [name of copyright owner]
#
# CDDL HEADER END
#
#
# Copyright 2025 Makr91. All rights reserved.
# Use is subject to license terms.
#

#
# Post-installation setup script for ZoneWeaver API
# This script is run during package installation via IPS actuator
#

set -e

DAEMON_USER="zoneweaver-api"
CONFIG_DIR="/etc/zoneweaver-api"
SSL_DIR="${CONFIG_DIR}/ssl"
DATA_DIR="/var/lib/zoneweaver-api"
LOG_DIR="/var/log/zoneweaver-api"

# Logging function
log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

log "Starting ZoneWeaver API post-installation setup"

# Ensure all directories exist with proper ownership
log "Setting up directory structure"
for dir in "${CONFIG_DIR}" "${SSL_DIR}" "${DATA_DIR}" "${LOG_DIR}"; do
    if [[ ! -d "${dir}" ]]; then
        mkdir -p "${dir}"
        log "Created directory: ${dir}"
    fi
done

# Set ownership for service directories (config dir ownership handled by IPS manifest)
chown ${DAEMON_USER}:${DAEMON_USER} "${SSL_DIR}"
chown ${DAEMON_USER}:${DAEMON_USER} "${DATA_DIR}"
chown ${DAEMON_USER}:${DAEMON_USER} "${LOG_DIR}"

# Set proper permissions
chmod 700 "${SSL_DIR}"  # SSL directory should be private
chmod 755 "${DATA_DIR}"
chmod 755 "${LOG_DIR}"

# Generate SSL certificates if they don't exist and openssl is available
SSL_KEY="${SSL_DIR}/server.key"
SSL_CERT="${SSL_DIR}/server.crt"

if [[ ! -f "${SSL_KEY}" || ! -f "${SSL_CERT}" ]]; then
    log "Checking for OpenSSL to generate SSL certificates"
    
    if which openssl >/dev/null 2>&1; then
        log "Generating self-signed SSL certificates"
        
        # Generate private key
        openssl genrsa -out "${SSL_KEY}" 2048 2>/dev/null
        
        # Generate certificate
        openssl req -new -x509 -key "${SSL_KEY}" -out "${SSL_CERT}" -days 365 \
            -subj "/C=US/ST=State/L=City/O=ZoneWeaver/CN=localhost" 2>/dev/null
        
        # Set proper ownership and permissions
        chown ${DAEMON_USER}:${DAEMON_USER} "${SSL_KEY}" "${SSL_CERT}"
        chmod 600 "${SSL_KEY}" "${SSL_CERT}"
        
        log "SSL certificates generated successfully"
    else
        log "OpenSSL not found - SSL certificates will be generated at runtime if needed"
    fi
else
    log "SSL certificates already exist"
fi

# Create database directory
DATABASE_DIR="${DATA_DIR}/database"
if [[ ! -d "${DATABASE_DIR}" ]]; then
    mkdir -p "${DATABASE_DIR}"
    chown ${DAEMON_USER}:${DAEMON_USER} "${DATABASE_DIR}"
    chmod 755 "${DATABASE_DIR}"
    log "Created database directory: ${DATABASE_DIR}"
fi

# Set up log rotation (if logadm exists)
if which logadm >/dev/null 2>&1; then
    log "Setting up log rotation"
    logadm -w zoneweaver-api -s 10m -C 5 -p 1d \
        "${LOG_DIR}/zoneweaver-api.log" \
        -o ${DAEMON_USER} -g ${DAEMON_USER} -m 644 2>/dev/null || true
fi

# Import SMF manifest and enable service
log "Importing SMF manifest"
svccfg import /lib/svc/manifest/system/zoneweaver-api.xml 2>/dev/null || true

log "ZoneWeaver API post-installation setup completed successfully"
log "Service can be enabled with: svcadm enable application/zoneweaver-api"

exit 0
