/**
 * @fileoverview SSH Manager for Zoneweaver API
 * @description Utility functions for SSH, SCP, and rsync operations against zones.
 *              Uses shell commands via executeCommand() — no new npm dependencies.
 *              Tools (ssh, scp, rsync) already installed by ProvisioningController.js.
 */

import { executeCommand } from './CommandManager.js';
import { log } from './Logger.js';
import config from '../config/ConfigLoader.js';

const SSH_OPTS = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR';

/**
 * Get SSH key path from config or default
 * @returns {string}
 */
const getSSHKeyPath = () => {
  const provConfig = config.get('provisioning') || {};
  const sshConfig = provConfig.ssh || {};
  return sshConfig.key_path || '/etc/zoneweaver-api/ssh/provision_key';
};

/**
 * Build SSH authentication flags
 * @param {Object} credentials - { username, password, ssh_key_path }
 * @returns {string}
 */
const buildAuthFlags = credentials => {
  if (credentials.ssh_key_path) {
    return `-i ${credentials.ssh_key_path}`;
  }
  // Fall back to default provisioning key
  return `-i ${getSSHKeyPath()}`;
};

/**
 * Wait for SSH to become available on a zone
 * Polls until SSH responds or timeout is reached
 * @param {string} ip - Zone IP address
 * @param {number} [port=22] - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path } or { password }
 * @param {number} [timeout=300000] - Total timeout in milliseconds
 * @param {number} [interval=10000] - Poll interval in milliseconds
 * @returns {Promise<{success: boolean, elapsed_ms: number, error?: string}>}
 */
/**
 * Poll SSH availability with exponential backoff (intentionally sequential polling)
 * @param {string} ip
 * @param {string} username
 * @param {string} authFlags
 * @param {number} port
 * @param {number} startTime
 * @param {number} deadline
 * @param {number} interval
 * @returns {Promise<{success: boolean, elapsed_ms: number}>}
 */
const pollSSH = (ip, username, authFlags, port, startTime, deadline, interval) => {
  const check = async () => {
    if (Date.now() >= deadline) {
      const elapsed = Date.now() - startTime;
      return { success: false, elapsed_ms: elapsed };
    }

    const result = await executeCommand(
      `ssh ${SSH_OPTS} ${authFlags} -p ${port} -o ConnectTimeout=5 ${username}@${ip} "echo ready"`,
      { timeout: 15000 }
    );

    if (result.success && result.output && result.output.includes('ready')) {
      const elapsed = Date.now() - startTime;
      log.task.info('SSH is available', { ip, port, elapsed_ms: elapsed });
      return { success: true, elapsed_ms: elapsed };
    }

    // Wait before retrying
    await new Promise(resolve => {
      setTimeout(resolve, interval);
    });
    return check();
  };

  return check();
};

export const waitForSSH = async (
  ip,
  username,
  credentials,
  port = 22,
  timeout = 300000,
  interval = 10000
) => {
  const startTime = Date.now();
  const deadline = startTime + timeout;
  const authFlags = buildAuthFlags(credentials);

  log.task.info('Waiting for SSH availability', { ip, port, username, timeout });

  const result = await pollSSH(ip, username, authFlags, port, startTime, deadline, interval);

  if (!result.success) {
    log.task.error('SSH wait timed out', { ip, port, elapsed_ms: result.elapsed_ms });
    return {
      ...result,
      error: `SSH not available after ${Math.round(timeout / 1000)}s`,
    };
  }

  return result;
};

/**
 * Execute a command on a zone via SSH
 * @param {string} ip - Zone IP address
 * @param {number} [port=22] - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path }
 * @param {string} command - Command to execute
 * @param {Object} [options] - { timeout: number }
 * @returns {Promise<{success: boolean, stdout: string, stderr: string, exitCode: number}>}
 */
export const executeSSHCommand = async (
  ip,
  username,
  credentials,
  command,
  port = 22,
  options = {}
) => {
  const authFlags = buildAuthFlags(credentials);
  const timeout = options.timeout || 60000;

  // Escape the command for shell
  const escapedCmd = command.replace(/"/g, '\\"');

  const result = await executeCommand(
    `ssh ${SSH_OPTS} ${authFlags} -p ${port} ${username}@${ip} "${escapedCmd}"`,
    { timeout }
  );

  return {
    success: result.success,
    stdout: result.output || '',
    stderr: result.error || '',
    exitCode: result.success ? 0 : 1,
  };
};

/**
 * Sync files from host to zone via rsync over SSH
 * @param {string} ip - Zone IP address
 * @param {number} [port=22] - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path }
 * @param {string} localDir - Local directory path (source)
 * @param {string} remoteDir - Remote directory path (destination)
 * @param {Object} [options] - { delete: boolean, exclude: string[] }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const syncFiles = async (
  ip,
  username,
  credentials,
  localDir,
  remoteDir,
  port = 22,
  options = {}
) => {
  const authFlags = buildAuthFlags(credentials);
  const sshCmd = `ssh ${SSH_OPTS} ${authFlags} -p ${port}`;

  let rsyncFlags = '-avz --progress';
  if (options.delete) {
    rsyncFlags += ' --delete';
  }
  if (options.exclude && options.exclude.length > 0) {
    for (const pattern of options.exclude) {
      rsyncFlags += ` --exclude='${pattern}'`;
    }
  }

  // Ensure local path ends with / for rsync content sync
  const source = localDir.endsWith('/') ? localDir : `${localDir}/`;

  log.task.info('Syncing files to zone', { ip, localDir, remoteDir });

  const result = await executeCommand(
    `rsync ${rsyncFlags} -e "${sshCmd}" ${source} ${username}@${ip}:${remoteDir}`,
    { timeout: 600000 } // 10 minute timeout for large syncs
  );

  if (result.success) {
    return { success: true, message: `Files synced to ${ip}:${remoteDir}` };
  }
  return { success: false, error: `rsync failed: ${result.error}` };
};

/**
 * Upload a single file from host to zone via SCP
 * @param {string} ip - Zone IP address
 * @param {number} [port=22] - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path }
 * @param {string} localPath - Local file path
 * @param {string} remotePath - Remote file path
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const uploadFile = async (ip, username, credentials, localPath, remotePath, port = 22) => {
  const authFlags = buildAuthFlags(credentials);

  const result = await executeCommand(
    `scp ${SSH_OPTS} ${authFlags} -P ${port} ${localPath} ${username}@${ip}:${remotePath}`,
    { timeout: 300000 }
  );

  if (result.success) {
    return { success: true, message: `File uploaded to ${ip}:${remotePath}` };
  }
  return { success: false, error: `scp failed: ${result.error}` };
};

/**
 * Download a file from zone to host via SCP
 * @param {string} ip - Zone IP address
 * @param {number} [port=22] - SSH port
 * @param {string} username - SSH username
 * @param {Object} credentials - { ssh_key_path }
 * @param {string} remotePath - Remote file path
 * @param {string} localPath - Local file path
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const downloadFile = async (ip, username, credentials, remotePath, localPath, port = 22) => {
  const authFlags = buildAuthFlags(credentials);

  const result = await executeCommand(
    `scp ${SSH_OPTS} ${authFlags} -P ${port} ${username}@${ip}:${remotePath} ${localPath}`,
    { timeout: 300000 }
  );

  if (result.success) {
    return { success: true, message: `File downloaded from ${ip}:${remotePath}` };
  }
  return { success: false, error: `scp download failed: ${result.error}` };
};

/**
 * Generate an SSH keypair for provisioning
 * @param {string} [keyPath] - Path to store the key (default from config)
 * @returns {Promise<{success: boolean, public_key?: string, key_path?: string, error?: string}>}
 */
export const generateSSHKey = async keyPath => {
  const path = keyPath || getSSHKeyPath();

  // Ensure directory exists
  const dir = path.substring(0, path.lastIndexOf('/'));
  await executeCommand(`pfexec mkdir -p ${dir}`);

  // Check if key already exists
  const checkResult = await executeCommand(`test -f ${path} && echo exists`);
  if (checkResult.success && checkResult.output && checkResult.output.includes('exists')) {
    // Read existing public key
    const pubResult = await executeCommand(`cat ${path}.pub`);
    return {
      success: true,
      public_key: pubResult.output || '',
      key_path: path,
      message: 'SSH key already exists',
    };
  }

  // Generate new keypair
  const genResult = await executeCommand(
    `pfexec ssh-keygen -t ed25519 -f ${path} -N "" -C "zoneweaver-api@provisioning"`
  );

  if (!genResult.success) {
    return { success: false, error: `Failed to generate SSH key: ${genResult.error}` };
  }

  // Read public key
  const pubResult = await executeCommand(`cat ${path}.pub`);

  log.task.info('SSH provisioning key generated', { path });
  return {
    success: true,
    public_key: pubResult.output || '',
    key_path: path,
  };
};
