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

set -o xtrace

. /lib/svc/share/smf_include.sh

DAEMON="ZoneWeaver API"
DAEMON_HOME="/opt/zoneweaver-api"
DAEMON_USER="zoneweaver-api"
DAEMON_CONF="/etc/zoneweaver-api/config.yaml" 
DAEMON_LOG="/var/log/zoneweaver-api"
DAEMON_PIDFILE="/var/run/zoneweaver-api.pid"

# Directories and permissions are handled during package installation

# Check if configuration file exists
if [[ ! -f ${DAEMON_CONF} ]]; then
    echo "Configuration file ${DAEMON_CONF} not found"
    exit $SMF_EXIT_ERR_CONFIG
fi

# Set up environment
export PATH="/opt/ooce/node-22/bin:/opt/ooce/bin:${PATH}"
export NODE_ENV="production"
export HOME="/var/lib/zoneweaver-api"

# Change to daemon directory
cd ${DAEMON_HOME}

# Check if Node.js is available
if ! which node >/dev/null 2>&1; then
    echo "Node.js not found in PATH: ${PATH}"
    exit $SMF_EXIT_ERR_CONFIG
fi

# Post-installation is handled during package installation via IPS actuator

# Start the daemon
echo "Starting ${DAEMON}"
exec /opt/ooce/node-22/bin/node index.js \
    </dev/null \
    >>${DAEMON_LOG}/zoneweaver-api.log 2>&1 &

# Store PID
echo $! > ${DAEMON_PIDFILE}

exit $SMF_EXIT_OK
