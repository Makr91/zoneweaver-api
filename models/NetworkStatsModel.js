import { Sequelize } from "sequelize";
import db from "../config/Database.js";
 
const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     NetworkStats:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the interface is located
 *           example: "hv-04"
 *         link:
 *           type: string
 *           description: Link/interface name
 *           example: "ixgbe0"
 *         ipackets:
 *           type: string
 *           description: Input packets count (using string for large numbers)
 *           example: "9141619312"
 *         rbytes:
 *           type: string
 *           description: Received bytes count (using string for large numbers)
 *           example: "315184869199"
 *         ierrors:
 *           type: string
 *           description: Input errors count
 *           example: "0"
 *         opackets:
 *           type: string
 *           description: Output packets count (using string for large numbers)
 *           example: "3086337221"
 *         obytes:
 *           type: string
 *           description: Output bytes count (using string for large numbers)
 *           example: "220396433195"
 *         oerrors:
 *           type: string
 *           description: Output errors count
 *           example: "0"
 *         scan_timestamp:
 *           type: string
 *           format: date-time
 *           description: When this data was collected
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 *         updated_at:
 *           type: string
 *           format: date-time
 *           description: Record last update timestamp
 */
const NetworkStats = db.define('network_stats', {
    host: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Host where the interface is located'
    },
    link: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Link/interface name'
    },
    ipackets: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Input packets count (cumulative since boot)'
    },
    rbytes: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Received bytes count (cumulative since boot)'
    },
    ierrors: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Input errors count (cumulative since boot)'
    },
    opackets: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Output packets count (cumulative since boot)'
    },
    obytes: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Output bytes count (cumulative since boot)'
    },
    oerrors: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Output errors count (cumulative since boot)'
    },
    scan_timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'When this data was collected'
    }
}, {
    freezeTableName: true,
    comment: 'Network interface traffic statistics (collected every 10 seconds)',
    indexes: [
        {
            fields: ['host', 'link', 'scan_timestamp']
        },
        {
            fields: ['host', 'scan_timestamp']
        },
        {
            fields: ['scan_timestamp']
        },
        {
            fields: ['link', 'scan_timestamp']
        }
    ]
});
 
export default NetworkStats;
