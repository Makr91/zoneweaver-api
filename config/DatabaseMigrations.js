/**
 * @fileoverview Database Migration Utilities for Zoneweaver API
 * @description Handles database schema migrations and updates
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import db from "./Database.js";
import CPUStats from "../models/CPUStatsModel.js";
import MemoryStats from "../models/MemoryStatsModel.js";

/**
 * Database Migration Helper Class
 * @description Provides utilities for safely migrating database schemas
 */
class DatabaseMigrations {
    
    /**
     * Check if a column exists in a table
     * @param {string} tableName - Name of the table
     * @param {string} columnName - Name of the column
     * @returns {Promise<boolean>} True if column exists
     */
    async columnExists(tableName, columnName) {
        try {
            const [results] = await db.query(`PRAGMA table_info(${tableName})`);
            return results.some(col => col.name === columnName);
        } catch (error) {
            console.warn(`Failed to check column ${columnName} in table ${tableName}:`, error.message);
            return false;
        }
    }

    /**
     * Add a column to a table if it doesn't exist
     * @param {string} tableName - Name of the table
     * @param {string} columnName - Name of the column
     * @param {string} columnDefinition - SQL column definition
     * @returns {Promise<boolean>} True if column was added or already exists
     */
    async addColumnIfNotExists(tableName, columnName, columnDefinition) {
        try {
            const exists = await this.columnExists(tableName, columnName);
            if (exists) {
                return true;
            }

            await db.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
            return true;

        } catch (error) {
            console.error(`❌ Failed to add column ${tableName}.${columnName}:`, error.message);
            return false;
        }
    }

    /**
     * Migrate network_usage table to new schema
     * @description Adds new columns for enhanced network monitoring
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateNetworkUsageTable() {
        const tableName = 'network_usage';
        const columnsToAdd = [
            // Raw counters from dladm show-link -s
            { name: 'ierrors', definition: 'TEXT' },
            { name: 'oerrors', definition: 'TEXT' },
            
            // Delta values (calculated from previous sample)
            { name: 'ipackets_delta', definition: 'BIGINT' },
            { name: 'rbytes_delta', definition: 'BIGINT' },
            { name: 'ierrors_delta', definition: 'BIGINT' },
            { name: 'opackets_delta', definition: 'BIGINT' },
            { name: 'obytes_delta', definition: 'BIGINT' },
            { name: 'oerrors_delta', definition: 'BIGINT' },
            
            // Calculated bandwidth values
            { name: 'rx_bps', definition: 'BIGINT' },
            { name: 'tx_bps', definition: 'BIGINT' },
            { name: 'rx_mbps', definition: 'DECIMAL(10, 2)' },
            { name: 'tx_mbps', definition: 'DECIMAL(10, 2)' },
            
            // Utilization percentages
            { name: 'rx_utilization_pct', definition: 'DECIMAL(5, 2)' },
            { name: 'tx_utilization_pct', definition: 'DECIMAL(5, 2)' },
            
            // Interface information
            { name: 'interface_speed_mbps', definition: 'INTEGER' },
            { name: 'interface_class', definition: 'TEXT' },
            
            // Metadata
            { name: 'time_delta_seconds', definition: 'DECIMAL(10, 3)' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
            console.warn('⚠️  Network interfaces aggregate fields migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate disk table to remove duplicate records
     * @description Removes duplicate disk records and updates constraints
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateDiskTable() {
        try {
            // First, count existing duplicates
            const [countResult] = await db.query(`
                SELECT COUNT(*) as total_records,
                       COUNT(DISTINCT host || device_name) as unique_records
                FROM disks
            `);
            
            const totalRecords = countResult[0]?.total_records || 0;
            const uniqueRecords = countResult[0]?.unique_records || 0;
            const duplicateCount = totalRecords - uniqueRecords;
            
            if (duplicateCount > 0) {
                // Remove duplicate disk records, keeping the one with most recent scan_timestamp
                const [results] = await db.query(`
                    DELETE FROM disks 
                    WHERE rowid NOT IN (
                        SELECT MAX(rowid) 
                        FROM disks 
                        GROUP BY host, device_name
                    )
                `);
                
            }
            
            return true;
            
        } catch (error) {
            console.error('❌ Failed to migrate disk table:', error.message);
            return false;
        }
    }

    /**
     * Migrate ZFS datasets table to add byte fields
     * @description Adds byte conversion fields for proper size calculations
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateZFSDatasetTable() {
        const tableName = 'zfs_datasets';
        const columnsToAdd = [
            { name: 'used_bytes', definition: 'BIGINT' },
            { name: 'available_bytes', definition: 'BIGINT' },
            { name: 'referenced_bytes', definition: 'BIGINT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
        } else {
            console.warn('⚠️  Tasks table migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Create new system metrics tables
     * @description Creates cpu_stats and memory_stats tables if they don't exist
     * @returns {Promise<boolean>} True if tables created successfully
     */
    async createNewSystemMetricsTables() {
        try {
            // Use Sequelize sync to create the CPU and Memory tables
            // These models already have their schema defined
            await CPUStats.sync({ alter: false });
            await MemoryStats.sync({ alter: false });
            
            return true;
            
        } catch (error) {
            console.error('❌ Failed to create system metrics tables:', error.message);
            return false;
        }
    }

    /**
     * Create new storage monitoring tables
     * @description Creates disk_io_stats and arc_stats tables if they don't exist
     * @returns {Promise<boolean>} True if tables created successfully
     */
    async createNewStorageTables() {
        
        try {
            // Create disk_io_stats table
            const diskIOTableExists = await this.tableExists('disk_io_stats');
            if (!diskIOTableExists) {
                console.log('🔧 Creating disk_io_stats table...');
                await db.query(`
                    CREATE TABLE disk_io_stats (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        host TEXT NOT NULL,
                        pool TEXT NOT NULL,
                        device_name TEXT NOT NULL,
                        alloc TEXT,
                        free TEXT,
                        read_ops TEXT,
                        write_ops TEXT,
                        read_bandwidth TEXT,
                        write_bandwidth TEXT,
                        read_ops_per_sec DECIMAL(10, 2),
                        write_ops_per_sec DECIMAL(10, 2),
                        read_bandwidth_bytes BIGINT,
                        write_bandwidth_bytes BIGINT,
                        scan_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Create indexes
                await db.query(`CREATE INDEX idx_disk_io_host_device_timestamp ON disk_io_stats(host, device_name, scan_timestamp)`);
                await db.query(`CREATE INDEX idx_disk_io_host_pool_timestamp ON disk_io_stats(host, pool, scan_timestamp)`);
                await db.query(`CREATE INDEX idx_disk_io_timestamp ON disk_io_stats(scan_timestamp)`);
                
            }

            // Create arc_stats table
            const arcTableExists = await this.tableExists('arc_stats');
            if (!arcTableExists) {
                await db.query(`
                    CREATE TABLE arc_stats (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        host TEXT NOT NULL,
                        arc_size BIGINT,
                        arc_target_size BIGINT,
                        arc_min_size BIGINT,
                        arc_max_size BIGINT,
                        arc_meta_used BIGINT,
                        arc_meta_limit BIGINT,
                        mru_size BIGINT,
                        mfu_size BIGINT,
                        data_size BIGINT,
                        metadata_size BIGINT,
                        hits BIGINT,
                        misses BIGINT,
                        demand_data_hits BIGINT,
                        demand_data_misses BIGINT,
                        demand_metadata_hits BIGINT,
                        demand_metadata_misses BIGINT,
                        prefetch_data_hits BIGINT,
                        prefetch_data_misses BIGINT,
                        mru_hits BIGINT,
                        mfu_hits BIGINT,
                        mru_ghost_hits BIGINT,
                        mfu_ghost_hits BIGINT,
                        hit_ratio DECIMAL(5, 2),
                        data_demand_efficiency DECIMAL(5, 2),
                        data_prefetch_efficiency DECIMAL(5, 2),
                        arc_p BIGINT,
                        compressed_size BIGINT,
                        uncompressed_size BIGINT,
                        l2_size BIGINT,
                        l2_hits BIGINT,
                        l2_misses BIGINT,
                        scan_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Create indexes
                await db.query(`CREATE INDEX idx_arc_host_timestamp ON arc_stats(host, scan_timestamp)`);
                await db.query(`CREATE INDEX idx_arc_timestamp ON arc_stats(scan_timestamp)`);
                await db.query(`CREATE INDEX idx_arc_hit_ratio ON arc_stats(hit_ratio)`);
                
            }

            // Create pool_io_stats table
            const poolIOTableExists = await this.tableExists('pool_io_stats');
            if (!poolIOTableExists) {
                await db.query(`
                    CREATE TABLE pool_io_stats (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        host TEXT NOT NULL,
                        pool TEXT NOT NULL,
                        pool_type TEXT,
                        alloc TEXT,
                        free TEXT,
                        read_ops TEXT,
                        write_ops TEXT,
                        read_bandwidth TEXT,
                        write_bandwidth TEXT,
                        read_bandwidth_bytes TEXT,
                        write_bandwidth_bytes TEXT,
                        total_wait_read TEXT,
                        total_wait_write TEXT,
                        disk_wait_read TEXT,
                        disk_wait_write TEXT,
                        syncq_wait_read TEXT,
                        syncq_wait_write TEXT,
                        asyncq_wait_read TEXT,
                        asyncq_wait_write TEXT,
                        scrub_wait TEXT,
                        trim_wait TEXT,
                        scan_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Create indexes
                await db.query(`CREATE INDEX idx_pool_io_host_pool_timestamp ON pool_io_stats(host, pool, scan_timestamp)`);
                await db.query(`CREATE INDEX idx_pool_io_host_timestamp ON pool_io_stats(host, scan_timestamp)`);
                await db.query(`CREATE INDEX idx_pool_io_timestamp ON pool_io_stats(scan_timestamp)`);
                await db.query(`CREATE INDEX idx_pool_io_pool_timestamp ON pool_io_stats(pool, scan_timestamp)`);
            }

            return true;
            
        } catch (error) {
            console.error('❌ Failed to create new storage tables:', error.message);
            return false;
        }
    }

    /**
     * Check if a table exists
     * @param {string} tableName - Name of the table
     * @returns {Promise<boolean>} True if table exists
     */
    async tableExists(tableName) {
        try {
            const [results] = await db.query(`
                SELECT name FROM sqlite_master 
                WHERE type='table' AND name='${tableName}'
            `);
            return results.length > 0;
        } catch (error) {
            console.warn(`Failed to check if table ${tableName} exists:`, error.message);
            return false;
        }
    }

    /**
     * Migrate PCI devices table to add ppt_capable field
     * @description Adds ppt_capable column for passthrough capability detection
     * @returns {Promise<boolean>} True if migration successful
     */
    async migratePCIDevicesTable() {
        
        const tableName = 'pci_devices';
        const columnsToAdd = [
            { name: 'ppt_capable', definition: 'BOOLEAN DEFAULT 0' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
        } else {
            console.warn('⚠️  Network interfaces aggregate fields migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate CPU stats table to add load metrics and per-core data
     * @description Adds system load metrics and per-core CPU data fields
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateCPUStatsTable() {
        const tableName = 'cpu_stats';
        const columnsToAdd = [
            { name: 'system_calls', definition: 'BIGINT' },
            { name: 'page_faults', definition: 'BIGINT' },
            { name: 'page_ins', definition: 'BIGINT' },
            { name: 'page_outs', definition: 'BIGINT' },
            { name: 'per_core_data', definition: 'TEXT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
        } else {
            console.warn('⚠️  CPU stats table migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate host_info table to add system metrics tracking fields
     * @description Adds fields for tracking last scan times and system specs
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateHostInfoTable() {
        const tableName = 'host_info';
        const columnsToAdd = [
            { name: 'last_cpu_scan', definition: 'DATETIME' },
            { name: 'last_memory_scan', definition: 'DATETIME' },
            { name: 'cpu_count', definition: 'INTEGER' },
            { name: 'total_memory_bytes', definition: 'BIGINT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
        } else {
            console.warn('⚠️  Host info table migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate zlogin_sessions table to make pid field nullable
     * @description Updates zlogin_sessions table to allow null pid values for connecting state
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateZloginSessionsTable() {
        try {
            // Check if table exists
            const tableExists = await this.tableExists('zlogin_sessions');
            if (!tableExists) {
                return true;
            }

            // Check table schema using PRAGMA table_info
            const [tableInfo] = await db.query(`PRAGMA table_info(zlogin_sessions)`);
            const pidColumn = tableInfo.find(col => col.name === 'pid');
            
            if (!pidColumn) {
                return false;
            }

            // Check if pid column allows null (notnull = 0 means nullable, notnull = 1 means NOT NULL)
            if (pidColumn.notnull === 0) {
                return true;
            }

            // SQLite doesn't support ALTER COLUMN, so we need to recreate the table
            // 1. Create backup table with correct schema
            await db.query(`
                CREATE TABLE zlogin_sessions_new (
                    id TEXT PRIMARY KEY,
                    zone_name TEXT NOT NULL,
                    pid INTEGER,
                    status TEXT DEFAULT 'active',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP,
                    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            
            // 2. Copy existing data
            await db.query(`
                INSERT INTO zlogin_sessions_new (id, zone_name, pid, status, created_at, last_accessed, createdAt, updatedAt)
                SELECT id, zone_name, pid, status, created_at, last_accessed, createdAt, updatedAt
                FROM zlogin_sessions
            `);
            
            // 3. Drop old table
            await db.query(`DROP TABLE zlogin_sessions`);
            
            // 4. Rename new table
            await db.query(`ALTER TABLE zlogin_sessions_new RENAME TO zlogin_sessions`);
            
            return true;
            
        } catch (error) {
            console.error('❌ Failed to migrate zlogin_sessions table:', error.message);
            return false;
        }
    }

    /**
     * Clean up network interfaces table from header contamination
     * @description Removes entries that contain column headers from dladm output
     * @returns {Promise<boolean>} True if cleanup successful
     */
    async cleanupNetworkInterfaceHeaders() {
        
        try {
            // Check if table exists
            const tableExists = await this.tableExists('network_interfaces');
            if (!tableExists) {
                return true;
            }

            // Count contaminated records first
            const [countResult] = await db.query(`
                SELECT COUNT(*) as contaminated_count
                FROM network_interfaces 
                WHERE link LIKE '%LINK%' 
                   OR link LIKE '%CLASS%'
                   OR link LIKE '%MTU%'
                   OR link LIKE '%STATE%'
                   OR link LIKE '%Physical%'
                   OR link LIKE '%unknown%'
                   OR link = 'LINK'
                   OR class LIKE '%CLASS%'
                   OR class LIKE '%Physical%'
                   OR state LIKE '%STATE%'
                   OR state LIKE '%unknown%'
            `);
            
            const contaminatedCount = countResult[0]?.contaminated_count || 0;
            
            if (contaminatedCount === 0) {
                return true;
            }

            // Delete contaminated records
            const [deleteResult] = await db.query(`
                DELETE FROM network_interfaces 
                WHERE link LIKE '%LINK%' 
                   OR link LIKE '%CLASS%'
                   OR link LIKE '%MTU%'
                   OR link LIKE '%STATE%'
                   OR link LIKE '%Physical%'
                   OR link LIKE '%unknown%'
                   OR link = 'LINK'
                   OR class LIKE '%CLASS%'
                   OR class LIKE '%Physical%'
                   OR state LIKE '%STATE%'
                   OR state LIKE '%unknown%'
            `);

            return true;
            
        } catch (error) {
            console.error('❌ Failed to clean up network interface headers:', error.message);
            return false;
        }
    }

    /**
     * Migrate tasks table to add metadata field
     * @description Adds metadata column for task execution parameters (networking, etc.)
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateTasksTable() {
        const tableName = 'tasks';
        const columnsToAdd = [
            { name: 'metadata', definition: 'TEXT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
        } else {
            console.warn('⚠️  Tasks table migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate network interfaces table to add aggregate-specific fields
     * @description Adds aggregate configuration columns for comprehensive aggregate data
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateNetworkInterfacesAggregateFields() {
        
        const tableName = 'network_interfaces';
        const columnsToAdd = [
            { name: 'policy', definition: 'TEXT' },
            { name: 'address_policy', definition: 'TEXT' },
            { name: 'lacp_activity', definition: 'TEXT' },
            { name: 'lacp_timer', definition: 'TEXT' },
            { name: 'flags', definition: 'TEXT' },
            { name: 'ports_detail', definition: 'TEXT' },
            { name: 'lacp_detail', definition: 'TEXT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
        } else {
            console.warn('⚠️  Network interfaces aggregate fields migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate swap_areas table to add missing columns
     * @description Adds missing columns that are defined in SwapAreaModel but don't exist in database
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateSwapAreasTable() {
        const tableName = 'swap_areas';
        const columnsToAdd = [
            { name: 'swapfile', definition: 'TEXT' }, // Make nullable to avoid issues with existing data
            { name: 'dev', definition: 'TEXT' },
            { name: 'swaplo', definition: 'BIGINT' },
            { name: 'blocks', definition: 'BIGINT' },
            { name: 'free', definition: 'BIGINT' },
            { name: 'size_bytes', definition: 'BIGINT' },
            { name: 'used_bytes', definition: 'BIGINT' },
            { name: 'free_bytes', definition: 'BIGINT' },
            { name: 'utilization_pct', definition: 'DECIMAL(5, 2)' },
            { name: 'scan_timestamp', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
            { name: 'is_active', definition: 'BOOLEAN DEFAULT 1' },
            { name: 'path', definition: 'TEXT' },
            { name: 'device_info', definition: 'TEXT' },
            { name: 'free_blocks', definition: 'BIGINT' },
            { name: 'pool_assignment', definition: 'TEXT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
            console.log('✅ Swap areas table migration completed successfully');
        } else {
            console.warn('⚠️  Swap areas table migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Migrate memory_stats table to add missing columns  
     * @description Adds missing columns that are defined in MemoryStatsModel but don't exist in database
     * @returns {Promise<boolean>} True if migration successful
     */
    async migrateMemoryStatsTable() {
        const tableName = 'memory_stats';
        const columnsToAdd = [
            { name: 'total_memory', definition: 'BIGINT' },
            { name: 'available_memory', definition: 'BIGINT' },
            { name: 'used_memory', definition: 'BIGINT' },
            { name: 'free_memory', definition: 'BIGINT' },
            { name: 'memory_utilization_pct', definition: 'DECIMAL(5, 2)' },
            { name: 'swap_total', definition: 'BIGINT' },
            { name: 'swap_used', definition: 'BIGINT' },
            { name: 'swap_free', definition: 'BIGINT' },
            { name: 'swap_utilization_pct', definition: 'DECIMAL(5, 2)' },
            { name: 'scan_timestamp', definition: 'DATETIME DEFAULT CURRENT_TIMESTAMP' },
            { name: 'total_memory_bytes', definition: 'BIGINT' },
            { name: 'available_memory_bytes', definition: 'BIGINT' },
            { name: 'used_memory_bytes', definition: 'BIGINT' },
            { name: 'free_memory_bytes', definition: 'BIGINT' },
            { name: 'buffers_bytes', definition: 'BIGINT' },
            { name: 'cached_bytes', definition: 'BIGINT' },
            { name: 'swap_total_bytes', definition: 'BIGINT' },
            { name: 'swap_used_bytes', definition: 'BIGINT' },
            { name: 'swap_free_bytes', definition: 'BIGINT' },
            { name: 'arc_size_bytes', definition: 'BIGINT' },
            { name: 'arc_target_bytes', definition: 'BIGINT' },
            { name: 'kernel_memory_bytes', definition: 'BIGINT' },
            { name: 'page_size_bytes', definition: 'INTEGER' },
            { name: 'pages_total', definition: 'BIGINT' },
            { name: 'pages_free', definition: 'BIGINT' }
        ];

        let allSuccessful = true;
        
        for (const column of columnsToAdd) {
            const success = await this.addColumnIfNotExists(tableName, column.name, column.definition);
            if (!success) {
                allSuccessful = false;
            }
        }

        if (allSuccessful) {
            console.log('✅ Memory stats table migration completed successfully');
        } else {
            console.warn('⚠️  Memory stats table migration completed with some errors');
        }

        return allSuccessful;
    }

    /**
     * Clean up swap_areas table by removing duplicate records and applying unique constraint
     * @description Removes duplicate swap area records and applies unique constraint on (host, swapfile)
     * @returns {Promise<boolean>} True if cleanup successful
     */
    async cleanupSwapAreasTable() {
        try {
            // Check if table exists
            const tableExists = await this.tableExists('swap_areas');
            if (!tableExists) {
                console.log('ℹ️  Swap areas table does not exist, skipping cleanup');
                return true;
            }

            // Count total records and check for duplicates
            const [countResults] = await db.query(`
                SELECT 
                    COUNT(*) as total_records,
                    COUNT(DISTINCT host || '-' || swapfile) as unique_records
                FROM swap_areas
            `);
            
            const totalRecords = countResults[0]?.total_records || 0;
            const uniqueRecords = countResults[0]?.unique_records || 0;
            const duplicateCount = totalRecords - uniqueRecords;
            
            if (duplicateCount > 0) {
                console.log(`🔧 Found ${duplicateCount} duplicate swap area records, cleaning up...`);
                
                // Keep only the most recent record for each (host, swapfile) combination
                const [deleteResults] = await db.query(`
                    DELETE FROM swap_areas 
                    WHERE id NOT IN (
                        SELECT MAX(id) 
                        FROM swap_areas 
                        GROUP BY host, swapfile
                    )
                `);
                
                console.log(`✅ Removed ${duplicateCount} duplicate swap area records`);
            } else {
                console.log('ℹ️  No duplicate swap area records found');
            }

            // Check if unique constraint already exists
            const [indexResults] = await db.query(`
                SELECT name FROM sqlite_master 
                WHERE type='index' AND name='unique_host_swapfile' AND tbl_name='swap_areas'
            `);
            
            if (indexResults.length === 0) {
                console.log('🔧 Adding unique constraint on (host, swapfile)...');
                
                // Add unique constraint
                await db.query(`
                    CREATE UNIQUE INDEX unique_host_swapfile 
                    ON swap_areas(host, swapfile)
                `);
                
                console.log('✅ Unique constraint added successfully');
            } else {
                console.log('ℹ️  Unique constraint already exists');
            }

            // Ensure other indexes exist
            await db.query(`CREATE INDEX IF NOT EXISTS idx_swap_areas_host_timestamp ON swap_areas(host, scan_timestamp)`);
            await db.query(`CREATE INDEX IF NOT EXISTS idx_swap_areas_timestamp ON swap_areas(scan_timestamp)`);
            await db.query(`CREATE INDEX IF NOT EXISTS idx_swap_areas_utilization ON swap_areas(utilization_pct)`);

            console.log('✅ Swap areas table cleanup completed successfully');
            return true;

        } catch (error) {
            console.error('❌ Failed to cleanup swap_areas table:', error.message);
            console.error('❌ Error details:', error.stack);
            return false;
        }
    }

    /**
     * Run all pending migrations
     * @description Executes all necessary database migrations
     * @returns {Promise<boolean>} True if all migrations successful
     */
    async runMigrations() {
        
        try {
            // Create new storage monitoring tables first
            await this.createNewStorageTables();
            
            // Create new system metrics tables
            await this.createNewSystemMetricsTables();
            
            // CRITICAL: Fix missing columns that are causing SQLite errors
            console.log('🔧 Running critical database schema fixes...');
            
            // Fix swap_areas table missing columns (fixes swapfile column error)
            await this.migrateSwapAreasTable();
            
            // Fix memory_stats table missing columns (fixes total_memory column error)
            await this.migrateMemoryStatsTable();
            
            // Network usage table migration
            await this.migrateNetworkUsageTable();
            
            // Clean up network interface header contamination
            await this.cleanupNetworkInterfaceHeaders();
            
            // Disk table migration (remove duplicates)
            await this.migrateDiskTable();
            
            // ZFS datasets table migration (add byte fields)
            await this.migrateZFSDatasetTable();
            
            // PCI devices table migration (add ppt_capable field)
            await this.migratePCIDevicesTable();
            
            // CPU stats table migration (add load metrics and per-core data)
            await this.migrateCPUStatsTable();

            // Host info table migration (add system metrics fields)
            await this.migrateHostInfoTable();

            // Zlogin sessions table migration (make pid nullable)
            await this.migrateZloginSessionsTable();

            // Tasks table migration (add metadata field)
            await this.migrateTasksTable();

            // Network interfaces table migration (add aggregate fields)
            await this.migrateNetworkInterfacesAggregateFields();
            
            // CLEANUP: Remove duplicate columns to avoid data redundancy
            console.log('🧹 Running database cleanup...');
            await this.cleanupSwapAreasTable();
            
            console.log('✅ All database migrations completed successfully');
            return true;
            
        } catch (error) {
            console.error('❌ Database migration failed:', error.message);
            return false;
        }
    }

    /**
     * Initialize database tables if they don't exist
     * @description Creates tables using Sequelize sync for new installations
     * @returns {Promise<boolean>} True if initialization successful
     */
    async initializeTables() {
        try {
            // Sync all models to create tables if they don't exist
            await db.sync({ alter: false }); // Don't alter existing tables, just create missing ones
            
            return true;
            
        } catch (error) {
            console.error('❌ Database table initialization failed:', error.message);
            return false;
        }
    }

    /**
     * Full database setup: initialize tables and run migrations
     * @description Complete database setup process for new and existing installations
     * @returns {Promise<boolean>} True if setup successful
     */
    async setupDatabase() {
        try {
            // First, initialize any missing tables
            await this.initializeTables();
            
            // Then run migrations to update existing tables
            await this.runMigrations();
            
            return true;
            
        } catch (error) {
            console.error('❌ Database setup failed:', error.message);
            return false;
        }
    }
}

export default new DatabaseMigrations();
