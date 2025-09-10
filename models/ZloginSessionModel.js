import { Sequelize } from 'sequelize';
import db from '../config/Database.js';
import { v4 as uuidv4 } from 'uuid';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     ZloginSession:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique session identifier
 *           example: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
 *         zone_name:
 *           type: string
 *           description: Zone name for this zlogin session
 *           example: "web-server-01"
 *         pid:
 *           type: integer
 *           description: Process ID of the node-pty process (null when connecting)
 *           example: 12345
 *           nullable: true
 *         status:
 *           type: string
 *           description: Current session status
 *           enum: [connecting, active, closed]
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
const ZloginSessions = db.define(
  'zlogin_sessions',
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: () => uuidv4(),
      primaryKey: true,
      comment: 'Unique session identifier',
    },
    zone_name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Zone name for this zlogin session',
    },
    pid: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Process ID of the node-pty process (null when connecting)',
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: 'active',
      comment: 'Session status (connecting, active, closed)',
    },
    created_at: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when session was created',
    },
    last_accessed: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Timestamp when session was last accessed',
    },
  },
  {
    freezeTableName: true,
    comment: 'Zlogin sessions for browser-based terminal access to zones',
  }
);

export default ZloginSessions;
