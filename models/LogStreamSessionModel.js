/**
 * @fileoverview Log Stream Session Model for Zoneweaver API
 * @description Database model for tracking log streaming sessions
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { DataTypes } from "sequelize";
import sequelize from "../config/Database.js";

const LogStreamSession = sequelize.define('LogStreamSession', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    session_id: {
        type: DataTypes.STRING(50),
        allowNull: false,
        unique: true,
        comment: 'Unique session identifier'
    },
    cookie: {
        type: DataTypes.STRING(100),
        allowNull: false,
        comment: 'Session cookie for tracking'
    },
    logname: {
        type: DataTypes.STRING(255),
        allowNull: false,
        comment: 'Name of the log file being streamed'
    },
    log_path: {
        type: DataTypes.STRING(500),
        allowNull: false,
        comment: 'Full path to the log file'
    },
    follow_lines: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 50,
        comment: 'Number of initial lines to show'
    },
    grep_pattern: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'Grep pattern for filtering lines'
    },
    status: {
        type: DataTypes.ENUM('created', 'active', 'closed', 'error', 'stopped'),
        allowNull: false,
        defaultValue: 'created',
        comment: 'Current status of the streaming session'
    },
    lines_sent: {
        type: DataTypes.INTEGER,
        allowNull: true,
        defaultValue: 0,
        comment: 'Total number of lines sent to client'
    },
    error_message: {
        type: DataTypes.TEXT,
        allowNull: true,
        comment: 'Error message if session failed'
    },
    created_at: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
        comment: 'Session creation timestamp'
    },
    connected_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'WebSocket connection timestamp'
    },
    disconnected_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'WebSocket disconnection timestamp'
    },
    stopped_at: {
        type: DataTypes.DATE,
        allowNull: true,
        comment: 'Session stop timestamp'
    }
}, {
    tableName: 'log_stream_sessions',
    timestamps: false,
    indexes: [
        {
            unique: true,
            fields: ['session_id']
        },
        {
            fields: ['status']
        },
        {
            fields: ['logname']
        },
        {
            fields: ['created_at']
        }
    ],
    comment: 'Tracks log streaming sessions for WebSocket connections'
});

export default LogStreamSession;
