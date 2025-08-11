import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';

/**
 * @fileoverview Configuration loader for Zoneweaver API
 * @description Loads and provides access to YAML configuration settings
 */

/**
 * Configuration loader class for managing application settings
 * @description Singleton class that loads YAML configuration and provides typed access methods
 */
class ConfigLoader {
  /**
   * Creates a new ConfigLoader instance
   * @description Automatically loads configuration on instantiation
   */
  constructor() {
    this.config = null;
    this.load();
  }

  /**
   * Loads configuration from config.yaml file
   * @description Reads and parses the YAML configuration file from config/config.yaml
   * @throws {Error} If configuration file cannot be loaded or parsed
   */
  load() {
    try {
      const configPath = path.join(process.cwd(), 'config', 'config.yaml');
      const fileContents = fs.readFileSync(configPath, 'utf8');
      const fullConfig = yaml.load(fileContents);
      this.config = fullConfig.zoneweaver_api_backend || fullConfig;
    } catch (error) {
      console.error('Error loading config file:', error);
      throw new Error('Failed to load configuration');
    }
  }

  /**
   * Gets a configuration value by dot-notation key
   * @description Retrieves nested configuration values using dot notation (e.g., 'api_keys.bootstrap_enabled')
   * @param {string} key - Dot-notation key path to the configuration value
   * @returns {any} The configuration value or undefined if not found
   * 
   * @example
   * const bootstrapEnabled = config.get('api_keys.bootstrap_enabled');
   * const httpPort = config.get('server.http_port');
   */
  get(key) {
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined;
      }
    }
    
    return value;
  }

  /**
   * Gets all configuration settings
   * @description Returns the entire configuration object
   * @returns {Object} The full configuration object
   */
  getAll() {
    return this.config;
  }

  /**
   * Gets server configuration
   * @description Returns server-related configuration including ports
   * @returns {Object} Server configuration object
   * @returns {number} returns.http_port - HTTP server port
   * @returns {number} returns.https_port - HTTPS server port
   */
  getServer() {
    return this.config.server;
  }

  /**
   * Gets SSL configuration
   * @description Returns SSL certificate configuration
   * @returns {Object} SSL configuration object
   * @returns {boolean} returns.enabled - Whether SSL is enabled
   * @returns {boolean} returns.generate_ssl - Whether to auto-generate SSL certificates
   * @returns {string} returns.key_path - Path to SSL private key
   * @returns {string} returns.cert_path - Path to SSL certificate
   */
  getSSL() {
    return this.config.ssl;
  }

  /**
   * Gets CORS configuration
   * @description Returns Cross-Origin Resource Sharing configuration
   * @returns {Object} CORS configuration object
   * @returns {string[]} returns.whitelist - Array of allowed origins
   */
  getCORS() {
    return this.config.cors;
  }

  /**
   * Gets database configuration
   * @description Returns database connection configuration
   * @returns {Object} Database configuration object
   * @returns {string} returns.dialect - Database dialect (sqlite, postgres, mysql, mariadb)
   * @returns {string} [returns.storage] - SQLite database file path
   * @returns {string} [returns.host] - Database host (for non-SQLite)
   * @returns {number} [returns.port] - Database port (for non-SQLite)
   * @returns {string} [returns.database] - Database name (for non-SQLite)
   * @returns {string} [returns.username] - Database username (for non-SQLite)
   * @returns {string} [returns.password] - Database password (for non-SQLite)
   * @returns {boolean} returns.logging - Whether to enable SQL query logging
   */
  getDatabase() {
    return this.config.database;
  }

  /**
   * Gets API keys configuration
   * @description Returns API key authentication configuration
   * @returns {Object} API keys configuration object
   * @returns {boolean} returns.bootstrap_enabled - Whether bootstrap key generation is enabled
   * @returns {boolean} returns.bootstrap_auto_disable - Whether to disable bootstrap after first use
   * @returns {number} returns.key_length - Length of random bytes for API key generation
   * @returns {number} returns.hash_rounds - bcrypt hash rounds for API key storage
   */
  getApiKeys() {
    return this.config.api_keys;
  }

  /**
   * Gets stats endpoint configuration
   * @description Returns stats endpoint access configuration
   * @returns {Object} Stats configuration object
   * @returns {boolean} returns.public_access - Whether stats endpoint requires API key
   */
  getStats() {
    return this.config.stats;
  }

  /**
   * Gets zones configuration
   * @description Returns zone management configuration
   * @returns {Object} Zones configuration object
   * @returns {number} returns.discovery_interval - Seconds between automatic zone discovery scans
   * @returns {boolean} returns.auto_discovery - Whether to enable automatic zone discovery
   * @returns {number} returns.max_concurrent_tasks - Maximum concurrent zone operations
   * @returns {number} returns.task_timeout - Task execution timeout in seconds
   * @returns {number} returns.orphan_retention - Days to keep orphaned zones
   * @returns {number} returns.default_pagination_limit - Default number of items for paginated responses
   */
  getZones() {
    return this.config.zones;
  }

  /**
   * Gets VNC configuration
   * @description Returns VNC console configuration
   * @returns {Object} VNC configuration object
   * @returns {number} returns.web_port_range_start - Starting port for noVNC web interfaces
   * @returns {number} returns.web_port_range_end - Ending port for noVNC web interfaces
   * @returns {number} returns.session_timeout - VNC session timeout in seconds
   * @returns {number} returns.cleanup_interval - VNC session cleanup interval in seconds
   * @returns {string} returns.bind_address - Bind address for VNC servers
   * @returns {number} returns.max_concurrent_sessions - Maximum concurrent VNC sessions
   */
  getVnc() {
    return this.config.vnc;
  }

  /**
   * Gets host monitoring configuration
   * @description Returns host information collection configuration
   * @returns {Object} Host monitoring configuration object
   * @returns {boolean} returns.enabled - Whether host monitoring is enabled
   * @returns {boolean} returns.auto_enable_network_accounting - Auto-enable network accounting
   * @returns {string} returns.network_accounting_file - Network accounting log file path
   * @returns {Object} returns.intervals - Collection intervals in seconds
   * @returns {Object} returns.retention - Data retention settings in days
   * @returns {Object} returns.error_handling - Error handling configuration
   * @returns {Object} returns.performance - Performance settings
   */
  getHostMonitoring() {
    return this.config.host_monitoring;
  }
}

// Export singleton instance
const config = new ConfigLoader();
export default config;
