#!/bin/bash
#
# ZoneWeaver API startup script for SMF
#

set -e

# Environment is set by SMF, but ensure we have the basics
export PATH="/opt/ooce/bin:/opt/ooce/node-22/bin:/usr/gnu/bin:/usr/bin:/usr/sbin:/sbin"
export NODE_ENV="${NODE_ENV:-production}"
export CONFIG_PATH="${CONFIG_PATH:-/etc/zoneweaver-api/config.yaml}"
export HOME="${HOME:-/var/lib/zoneweaver-api}"

cd /opt/zoneweaver-api

PIDFILE="/var/lib/zoneweaver-api/zoneweaver-api.pid"

# Create runtime directories following IPS best practices
# These are unpackaged content - preserved across package operations
mkdir -p /var/lib/zoneweaver-api/database
mkdir -p /etc/zoneweaver-api/ssl

# Set proper ownership for runtime directories
chown -R zoneapi:zoneapi /var/lib/zoneweaver-api
chown -R zoneapi:zoneapi /etc/zoneweaver-api/ssl

# Set proper permissions for SSL directory (more restrictive)
chmod 700 /etc/zoneweaver-api/ssl

# Check if Node.js is available
if ! command -v node >/dev/null 2>&1; then
    echo "Error: Node.js not found in PATH" >&2
    exit 1
fi

# Check if main application file exists
if [ ! -f "/opt/zoneweaver-api/index.js" ]; then
    echo "Error: ZoneWeaver API application not found at /opt/zoneweaver-api/index.js" >&2
    exit 1
fi

# Check if configuration file exists
if [ ! -f "$CONFIG_PATH" ]; then
    echo "Error: Configuration file not found at $CONFIG_PATH" >&2
    exit 1
fi

# Remove stale PID file if it exists
if [ -f "$PIDFILE" ]; then
    if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
        echo "Removing stale PID file $PIDFILE"
        rm -f "$PIDFILE"
    else
        echo "Error: ZoneWeaver API appears to be already running (PID $(cat "$PIDFILE"))" >&2
        exit 1
    fi
fi

echo "Starting ZoneWeaver API..."
echo "Node.js version: $(node --version)"
echo "Configuration: $CONFIG_PATH"
echo "Environment: $NODE_ENV"

# Start the Node.js application in the background
# Output goes to log file so we can see SSL generation messages
nohup node index.js </dev/null >>/var/log/zoneweaver-api/zoneweaver-api.log 2>&1 &
NODE_PID=$!

# Save the PID
echo $NODE_PID > "$PIDFILE"

# Give it a moment to start and check if it's still running
sleep 2
if ! kill -0 $NODE_PID 2>/dev/null; then
    echo "Error: ZoneWeaver API failed to start" >&2
    rm -f "$PIDFILE"
    exit 1
fi

echo "ZoneWeaver API started successfully with PID $NODE_PID"
echo "Log output will be available via SMF logging"
echo "Access the API at https://localhost:5001"

exit 0
