import { Sequelize } from "sequelize";
import db from "../config/Database.js";
 
const { DataTypes } = Sequelize;

/**
 * @swagger
 * components:
 *   schemas:
 *     MemoryStats:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Database unique identifier
 *           example: 1
 *         host:
 *           type: string
 *           description: Host where the data was collected
 *           example: "hv-04"
 *         total_memory_bytes:
 *           type: bigint
 *           description: Total physical memory in bytes
 *           example: 17179869184
 *         available_memory_bytes:
 *           type: bigint
 *           description: Available memory in bytes
 *           example: 8589934592
 *         used_memory_bytes:
 *           type: bigint
 *           description: Used memory in bytes
 *           example: 8589934592
 *         free_memory_bytes:
 *           type: bigint
 *           description: Free memory in bytes
 *           example: 4294967296
 *         buffers_bytes:
 *           type: bigint
 *           description: Buffer memory in bytes
 *           example: 1073741824
 *         cached_bytes:
 *           type: bigint
 *           description: Cache memory in bytes
 *           example: 3221225472
 *         memory_utilization_pct:
 *           type: number
 *           format: float
 *           description: Memory utilization percentage
 *           example: 75.5
 *         swap_total_bytes:
 *           type: bigint
 *           description: Total swap space in bytes
 *           example: 8589934592
 *         swap_used_bytes:
 *           type: bigint
 *           description: Used swap space in bytes
 *           example: 1073741824
 *         swap_free_bytes:
 *           type: bigint
 *           description: Free swap space in bytes
 *           example: 7516192768
 *         swap_utilization_pct:
 *           type: number
 *           format: float
 *           description: Swap utilization percentage
 *           example: 12.5
 *         arc_size_bytes:
 *           type: bigint
 *           description: ZFS ARC size in bytes (if available)
 *           example: 2147483648
 *         arc_target_bytes:
 *           type: bigint
 *           description: ZFS ARC target size in bytes (if available)
 *           example: 4294967296
 *         kernel_memory_bytes:
 *           type: bigint
 *           description: Kernel memory usage in bytes
 *           example: 536870912
 *         page_size_bytes:
 *           type: integer
 *           description: System page size in bytes
 *           example: 4096
 *         pages_total:
 *           type: bigint
 *           description: Total memory pages
 *           example: 4194304
 *         pages_free:
 *           type: bigint
 *           description: Free memory pages
 *           example: 1048576
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
const MemoryStats = db.define('memory_stats', {
    host: {
        type: DataTypes.STRING,
        allowNull: false,
        comment: 'Host where the data was collected'
    },
    total_memory_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Total physical memory in bytes'
    },
    available_memory_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Available memory in bytes (free + buffers + cache)'
    },
    used_memory_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Used memory in bytes'
    },
    free_memory_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Free memory in bytes'
    },
    buffers_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Buffer memory in bytes'
    },
    cached_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Cache memory in bytes'
    },
    memory_utilization_pct: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Memory utilization percentage'
    },
    swap_total_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Total swap space in bytes'
    },
    swap_used_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Used swap space in bytes'
    },
    swap_free_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Free swap space in bytes'
    },
    swap_utilization_pct: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
        comment: 'Swap utilization percentage'
    },
    arc_size_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'ZFS ARC current size in bytes (OmniOS/Solaris specific)'
    },
    arc_target_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'ZFS ARC target size in bytes (OmniOS/Solaris specific)'
    },
    kernel_memory_bytes: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Kernel memory usage in bytes'
    },
    page_size_bytes: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'System page size in bytes'
    },
    pages_total: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Total memory pages'
    },
    pages_free: {
        type: DataTypes.BIGINT,
        allowNull: true,
        comment: 'Free memory pages'
    },
    scan_timestamp: {
        type: DataTypes.DATE,
        defaultValue: DataTypes.NOW,
        comment: 'When this data was collected'
    }
}, {
    freezeTableName: true,
    comment: 'Memory usage statistics including RAM, swap, and ZFS ARC',
    indexes: [
        {
            fields: ['host', 'scan_timestamp']
        },
        {
            fields: ['scan_timestamp']
        },
        {
            fields: ['host']
        },
        {
            fields: ['memory_utilization_pct']
        },
        {
            fields: ['swap_utilization_pct']
        }
    ]
});
 
export default MemoryStats;
