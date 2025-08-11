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
DAEMON_PIDFILE="/var/run/zoneweaver-api.pid"

# Check if PID file exists
if [[ -f ${DAEMON_PIDFILE} ]]; then
    PID=$(cat ${DAEMON_PIDFILE})
    
    # Check if process is actually running
    if kill -0 ${PID} 2>/dev/null; then
        echo "Stopping ${DAEMON} (PID: ${PID})"
        
        # Send SIGTERM first for graceful shutdown
        kill -TERM ${PID}
        
        # Wait up to 30 seconds for graceful shutdown
        for i in {1..30}; do
            if ! kill -0 ${PID} 2>/dev/null; then
                echo "${DAEMON} stopped gracefully"
                rm -f ${DAEMON_PIDFILE}
                exit $SMF_EXIT_OK
            fi
            sleep 1
        done
        
        # Force kill if still running
        echo "Graceful shutdown timeout, force killing ${DAEMON}"
        kill -KILL ${PID} 2>/dev/null
        
        # Wait a bit more
        sleep 2
        
        # Check if it's really dead
        if kill -0 ${PID} 2>/dev/null; then
            echo "Failed to kill ${DAEMON}"
            exit $SMF_EXIT_ERR_OTHER
        fi
        
        echo "${DAEMON} force killed"
    else
        echo "PID ${PID} not running, cleaning up stale PID file"
    fi
    
    rm -f ${DAEMON_PIDFILE}
else
    echo "No PID file found for ${DAEMON}"
fi

exit $SMF_EXIT_OK
