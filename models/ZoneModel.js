import { Sequelize } from 'sequelize';
import db from '../config/Database.js';

const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     Zone:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         name:
 *           type: string
 *           description: Zone name
 *           example: "web-server-01"
 *         zone_id:
 *           type: string
 *           description: OmniOS zone identifier
 *           example: "zone-uuid-12345"
 *         host:
 *           type: string
 *           description: Host where the zone is running
 *           example: "omnios-host-01"
 *         status:
 *           type: string
 *           description: Current zone status
 *           enum: [configured, incomplete, installed, ready, running, shutting_down, down]
 *           example: "running"
 *         brand:
 *           type: string
 *           description: Zone brand (bhyve, kvm, lx, etc.)
 *           example: "bhyve"
 *         vnc_port:
 *           type: integer
 *           description: Assigned VNC port for console access
 *           example: 5901
 *         is_orphaned:
 *           type: boolean
 *           description: Whether zone exists in DB but not on system
 *           example: false
 *         auto_discovered:
 *           type: boolean
 *           description: Whether zone was automatically discovered
 *           example: true
 *         last_seen:
 *           type: string
 *           format: date-time
 *           description: Last time zone was detected on system
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Zone creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Zone last update timestamp
 */
const Zones = db.define(
  'zones',
  {
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Zone name as it appears in the system',
    },
    zone_id: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      comment: 'Unique zone identifier from OmniOS',
    },
    host: {
      type: DataTypes.STRING,
      allowNull: false,
      comment: 'Host where the zone is running',
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'configured',
      comment: 'Current zone status (configured, installed, running, etc.)',
    },
    brand: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Zone brand (bhyve, kvm, lx, illumos, etc.)',
    },
    vnc_port: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Assigned VNC port for console access',
    },
    is_orphaned: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether zone exists in database but not on system',
    },
    auto_discovered: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      comment: 'Whether zone was automatically discovered by system scan',
    },
    last_seen: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
      comment: 'Last time zone was detected during system scan',
    },
  },
  {
    freezeTableName: true,
    comment: 'Zone management and metadata storage',
  }
);

export default Zones;
