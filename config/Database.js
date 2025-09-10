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
         * Optimized with configurable performance parameters
         */
        sequelizeOptions.storage = dbConfig.storage;
        
        // Get SQLite-specific options from configuration (with defaults)
        const sqliteOpts = dbConfig.sqlite_options || {};
        const poolOpts = sqliteOpts.pool || {};
        const retryOpts = sqliteOpts.retry || {};
        
        // Configure connection pool for SQLite
        sequelizeOptions.pool = {
            max: poolOpts.max || 10,
            min: poolOpts.min || 2,
            acquire: poolOpts.acquire_timeout_ms || 60000,
            idle: poolOpts.idle_timeout_ms || 30000,
            evict: poolOpts.evict_interval_ms || 5000,
        };
        
        // Enable configurable SQLite optimizations
        sequelizeOptions.dialectOptions = {
            pragma: {
                journal_mode: sqliteOpts.journal_mode || 'WAL',
                synchronous: sqliteOpts.synchronous || 'NORMAL',
                cache_size: -(sqliteOpts.cache_size_mb || 128) * 1024,  // Convert MB to negative KB
                temp_store: sqliteOpts.temp_store || 'MEMORY',
                mmap_size: (sqliteOpts.mmap_size_mb || 512) * 1024 * 1024,  // Convert MB to bytes
                busy_timeout: sqliteOpts.busy_timeout_ms || 30000,
                wal_autocheckpoint: sqliteOpts.wal_autocheckpoint || 1000,
                optimize: sqliteOpts.optimize !== false,  // Default to true unless explicitly false
            }
        };
        
        // Configurable retry configuration for busy database
        sequelizeOptions.retry = {
            match: [/SQLITE_BUSY/, /SQLITE_LOCKED/],
            max: retryOpts.max_retries || 5,
            backoffBase: retryOpts.backoff_base_ms || 100,
            backoffExponent: retryOpts.backoff_exponent || 1.5
        };
        
        console.log(`🚀 SQLite configured with performance optimizations:`);
        console.log(`   - Journal mode: ${sqliteOpts.journal_mode || 'WAL'}`);
        console.log(`   - Cache size: ${sqliteOpts.cache_size_mb || 128}MB`);
        console.log(`   - Memory mapping: ${sqliteOpts.mmap_size_mb || 512}MB`);
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
