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
        max: 10,      // Increase from default 5 for better concurrency
        min: 2,       // Always keep some connections ready
        acquire: 30000, // 30s timeout to acquire connection
        idle: 10000,    // 10s timeout for idle connections
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
         */
        sequelizeOptions.storage = dbConfig.storage;
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
