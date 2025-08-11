import { Sequelize } from "sequelize";
import db from "../config/Database.js";
 
const { DataTypes } = Sequelize;

/**
 * @fileoverview VNC Session model for Zoneweaver API console management
 * @description Defines the database model for managing VNC console sessions
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     VncSession:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Unique session identifier
 *           example: 1
 *         zone_name:
 *           type: string
 *           description: Zone name for this VNC session
 *           example: "web-server-01"
 *         web_port:
 *           type: integer
 *           description: noVNC web interface port
 *           example: 6001
 *         host_ip:
 *           type: string
 *           description: Host IP address
 *           example: "127.0.0.1"
 *         process_id:
 *           type: integer
 *           description: Process ID of the zadm webvnc process
 *           example: 12345
 *         status:
 *           type: string
 *           description: Current session status
 *           enum: [starting, active, stopped, error]
 *           example: "active"
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Session creation timestamp
 *         last_accessed:
 *           type: string
 *           format: date-time
 *           description: Last time session was accessed
 */

/**
 * VNC Session model for console management
 * @description Sequelize model representing active VNC console sessions
 * @type {import('sequelize').Model}
 */
const VncSessions = db.define('vnc_sessions', {
    zone_name: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
        comment: 'Zone name - only one VNC session per zone'
    },
    web_port: {
        type: DataTypes.INTEGER,
        allowNull: false,
        comment: 'Port number for noVNC web interface'
    },
    host_ip: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: '127.0.0.1',
        comment: 'Host IP address where VNC server is running'
    },
    process_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Process ID of the zadm webvnc process'
    },
    status: {
        type: DataTypes.STRING,
        defaultValue: 'starting',
        comment: 'Session status (starting, active, stopped, error)'
    },
    created_at: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'Timestamp when session was created'
    },
    last_accessed: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'Timestamp when session was last accessed'
    }
}, {
    freezeTableName: true,
    comment: 'VNC console sessions for zone management'
});
 
export default VncSessions;
