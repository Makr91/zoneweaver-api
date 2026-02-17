/**
 * @fileoverview Configuration backup helper utilities
 */

import { promises as fs } from 'fs';
import path from 'path';
import { log } from '../../../lib/Logger.js';

// Get config path from environment variable (set by SMF) or fallback to local config
const getConfigPath = () =>
  process.env.CONFIG_PATH || path.join(process.cwd(), 'config', 'config.yaml');
export const configPath = getConfigPath();
export const backupDir = path.join(path.dirname(configPath), 'backups');

/**
 * Create a backup of the config.yaml file
 */
export const createBackup = async () => {
  try {
    await fs.mkdir(backupDir, { recursive: true });
    const timestamp = Date.now();
    const backupPath = path.join(backupDir, `config-${timestamp}.yaml`);
    await fs.copyFile(configPath, backupPath);
    log.app.info('Created config backup', {
      backup_path: backupPath,
      timestamp,
    });
  } catch (error) {
    log.app.error('Failed to create config backup', {
      error: error.message,
      stack: error.stack,
      backup_dir: backupDir,
    });
  }
};
