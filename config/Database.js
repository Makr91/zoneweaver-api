import { Sequelize } from "sequelize";
import config from "./ConfigLoader.js";

/**
 * @fileoverview Database connection configuration for Zoneweaver API
 * @description Configures and establishes database connection using Sequelize ORM with support for multiple database types
 */

const dbConfig = config.getDatabase();

/**
 * Sequelize connection options
 * @type {Object}
 */
let sequelizeOptions = {
    dialect: dbConfig.dialect,
    logging: dbConfig.logging ? (sql, timing) => {
        // Log slow queries for performance monitoring
        if (timing && timing > 100) {
            console.warn(`⚠️  Slow query (${timing}ms): ${sql.substring(0, 100)}...`);
        } else if (!timing && dbConfig.logging) {
            console.log(sql);
        }
    } : false,
    benchmark: true, // Enable query timing
    pool: {
        max: 25,      // Support 5+ concurrent users without saturation
        min: 5,       // Keep more connections ready
        acquire: 30000, // 30s timeout to acquire connection
        idle: 10000,    // 10s timeout for idle connections
        evict: 1000,    // Check for idle connections every 1s
    }
};

/**
 * Configure database connection based on dialect
 * @description Sets up connection parameters for different database types (SQLite, PostgreSQL, MySQL/MariaDB)
 */
switch (dbConfig.dialect) {
    case 'sqlite':
        /**
         * SQLite configuration
         * @description File-based database, ideal for development and single-host deployments
         * Optimized with WAL mode for concurrent reads during writes
         */
        sequelizeOptions.storage = dbConfig.storage;
        
        // Optimize connection pool for SQLite with WAL mode
        sequelizeOptions.pool = {
            max: 10,       // Multiple readers allowed with WAL mode
            min: 2,        // Keep some connections ready
            acquire: 60000, // 60s timeout for busy database
            idle: 30000,   // 30s idle timeout
            evict: 5000,   // Check for idle connections every 5s
        };
        
        // Enable WAL mode and performance optimizations
        sequelizeOptions.dialectOptions = {
            pragma: {
                journal_mode: 'WAL',           // Enable Write-Ahead Logging for concurrent reads
                synchronous: 'NORMAL',         // Faster than FULL, safer than OFF
                cache_size: -128000,           // 128MB cache (negative = KB)
                temp_store: 'MEMORY',          // Keep temp tables in RAM
                mmap_size: 536870912,          // 512MB memory-mapped I/O (doubled)
                busy_timeout: 30000,           // 30s timeout for locked database
                wal_autocheckpoint: 1000,      // Checkpoint WAL after 1000 pages
                optimize: true,                // Run PRAGMA optimize on connection
            }
        };
        
        // Retry configuration for busy database
        sequelizeOptions.retry = {
            match: [/SQLITE_BUSY/, /SQLITE_LOCKED/],
            max: 5,                            // Retry up to 5 times
            backoffBase: 100,                  // Start with 100ms delay
            backoffExponent: 1.5               // Exponential backoff
        };
        
        console.log('🚀 SQLite configured with WAL mode and performance optimizations');
        break;
    
    case 'postgres':
    case 'mysql':
    case 'mariadb':
        /**
         * Network database configuration
         * @description Remote database connection for production and multi-host deployments
         */
        sequelizeOptions.host = dbConfig.host;
        sequelizeOptions.port = dbConfig.port;
        sequelizeOptions.database = dbConfig.database;
        sequelizeOptions.username = dbConfig.username;
        sequelizeOptions.password = dbConfig.password;
        
        // Optional SSL configuration for remote databases
        if (dbConfig.ssl) {
            sequelizeOptions.dialectOptions = {
                ssl: dbConfig.ssl
            };
        }
        break;
    
    default:
        throw new Error(`Unsupported database dialect: ${dbConfig.dialect}`);
}

/**
 * Sequelize database instance
 * @description Main database connection instance used throughout the application
 * @type {import('sequelize').Sequelize}
 * 
 * @example
 * // Import and use in models
 * import db from './config/Database.js';
 * const MyModel = db.define('my_model', { ... });
 */
const db = new Sequelize(sequelizeOptions);

/**
 * Test database connection on startup
 * @description Verifies database connectivity and logs connection status
 */
(async () => {
    try {
        await db.authenticate();
        console.log(`Database connection established successfully (${dbConfig.dialect})`);
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
})();
 
export default db;
