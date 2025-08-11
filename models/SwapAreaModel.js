import { Sequelize } from "sequelize";
import db from "../config/Database.js";
 
const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     SwapArea:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the swap area exists
 *           example: "hv-04"
 *         path:
 *           type: string
 *           description: Swap area path/device
 *           example: "/dev/zvol/dsk/rpool/swap"
 *         device_info:
 *           type: string
 *           description: Device major/minor numbers
 *           example: "85,1"
 *         swaplow:
 *           type: bigint
 *           description: Offset in 512-byte blocks
 *           example: 16
 *         blocks:
 *           type: bigint
 *           description: Size in 512-byte blocks
 *           example: 16777200
 *         free_blocks:
 *           type: bigint
 *           description: Available blocks
 *           example: 16777200
 *         size_bytes:
 *           type: bigint
 *           description: Total size in bytes
 *           example: 8589926400
 *         free_bytes:
 *           type: bigint
 *           description: Available space in bytes
 *           example: 8589926400
 *         used_bytes:
 *           type: bigint
 *           description: Used space in bytes
 *           example: 0
 *         utilization_pct:
 *           type: number
 *           format: float
 *           description: Utilization percentage
 *           example: 0.0
 *         pool_assignment:
 *           type: string
 *           description: ZFS pool assignment (extracted from path)
 *           example: "rpool"
 *         is_active:
 *           type: boolean
 *           description: Whether the swap area is currently active
 *           example: true
 *         priority:
 *           type: integer
 *           description: Swap priority (if supported)
 *           example: 0
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
const SwapArea = db.define('swap_areas', {
    host: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Host where the swap area exists'
    },
    path: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Swap area path/device (e.g., /dev/zvol/dsk/rpool/swap)'
    },
    device_info: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'Device major/minor numbers from swap -l'
    },
    swaplow: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Offset in 512-byte blocks'
    },
    blocks: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Size in 512-byte blocks'
    },
    free_blocks: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Available blocks'
    },
    size_bytes: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Total size in bytes (blocks * 512)'
    },
    free_bytes: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Available space in bytes (free_blocks * 512)'
    },
    used_bytes: {
        type: DataTypes.BIGINT,
        allowNull: false,
        comment: 'Used space in bytes (calculated)'
    },
    utilization_pct: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: false,
        comment: 'Utilization percentage'
    },
    pool_assignment: {
        type: DataTypes.STRING,
        allowNull: true,
        comment: 'ZFS pool assignment extracted from path'
    },
    is_active: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
        comment: 'Whether the swap area is currently active'
    },
    priority: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'Swap priority (if supported by system)'
    },
    scan_timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'When this data was collected'
    }
}, {
    freezeTableName: true,
    comment: 'Individual swap area tracking from swap -l command',
    indexes: [
        {
            fields: ['host', 'scan_timestamp']
        },
        {
            fields: ['scan_timestamp']
        },
        {
            fields: ['host', 'path']
        },
        {
            fields: ['pool_assignment']
        },
        {
            fields: ['utilization_pct']
        },
        {
            fields: ['is_active']
        },
        {
            unique: false,
            fields: ['host', 'path', 'scan_timestamp'],
            name: 'swap_areas_host_path_time_idx'
        }
    ]
});

export default SwapArea;
