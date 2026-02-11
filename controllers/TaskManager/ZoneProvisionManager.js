/**
 * @fileoverview Zone Provisioning Task Manager for Zoneweaver API
 * @description Executes provisioning tasks: SSH wait, file sync, and provisioner execution.
 *              Each operation runs as a separate task in the TaskQueue with depends_on chaining.
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import { waitForSSH, executeSSHCommand, syncFiles } from '../../lib/SSHManager.js';
import Zones from '../../models/ZoneModel.js';
import Artifacts from '../../models/ArtifactModel.js';
import config from '../../config/ConfigLoader.js';
import yj from 'yieldable-json';

/**
 * Execute scripts sequentially (scripts must run in order)
 * @param {string} ip
 * @param {string} username
 * @param {Object} credentials
 * @param {number} port
 * @param {string[]} scripts
 * @param {string} envPrefix
 * @param {string} runAs
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const executeScriptsSequentially = (ip, username, credentials, port, scripts, envPrefix, runAs) => {
  const runScript = async index => {
    if (index >= scripts.length) {
      return { success: true };
    }
    const script = scripts[index];
    let cmd = '';

    if (runAs && runAs !== username) {
      cmd = `${envPrefix ? `${envPrefix} ` : ''}sudo -u ${runAs} bash ${script}`;
    } else if (runAs === 'root' && username !== 'root') {
      cmd = `${envPrefix ? `${envPrefix} ` : ''}sudo bash ${script}`;
    } else {
      cmd = `${envPrefix ? `${envPrefix} ` : ''}bash ${script}`;
    }

    const result = await executeSSHCommand(ip, username, credentials, cmd, port, {
      timeout: 600000,
    });

    if (!result.success) {
      return {
        success: false,
        error: `Script ${script} failed: ${result.stderr || result.stdout}`,
      };
    }

    log.task.info('Shell script executed', { script, exitCode: result.exitCode });
    return runScript(index + 1);
  };

  return runScript(0);
};

/**
 * Run shell script provisioner via SSH
 * @param {string} ip
 * @param {number} port
 * @param {Object} credentials
 * @param {Object} provisioner - { scripts: string[], run_as?: string, env?: Object }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const runShellProvisioner = async (ip, port, credentials, provisioner) => {
  const { scripts = [], run_as, env = {} } = provisioner;
  const username = credentials.username || 'root';

  // Build environment variable prefix
  const envPrefix = Object.entries(env)
    .map(([k, v]) => `${k}='${v}'`)
    .join(' ');

  const result = await executeScriptsSequentially(
    ip,
    username,
    credentials,
    port,
    scripts,
    envPrefix,
    run_as
  );

  if (!result.success) {
    return result;
  }

  return { success: true, message: `${scripts.length} shell script(s) executed` };
};

/**
 * Run ansible provisioner from HOST targeting zone
 * @param {string} ip
 * @param {number} port
 * @param {Object} credentials
 * @param {Object} provisioner - { playbook, extra_vars, collections, inventory }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const runAnsibleProvisioner = async (ip, port, credentials, provisioner) => {
  const { playbook, extra_vars = {}, collections = [], inventory } = provisioner;
  const username = credentials.username || 'root';
  const keyPath =
    credentials.ssh_key_path ||
    config.get('provisioning.ssh.key_path') ||
    '/etc/zoneweaver-api/ssh/provision_key';

  if (!playbook) {
    return { success: false, error: 'playbook is required for ansible provisioner' };
  }

  // Install collections if specified (parallel)
  if (collections.length > 0) {
    const collectionInstalls = collections.map(collection =>
      executeCommand(`ansible-galaxy collection install ${collection} --force`, {
        timeout: 300000,
      }).then(result => {
        if (!result.success) {
          log.task.warn('Collection install may have failed', { collection, error: result.error });
        }
        return result;
      })
    );
    await Promise.all(collectionInstalls);
  }

  // Build inventory or use provided
  const inventoryArg = inventory || `${ip},`;

  // Build extra-vars string
  let extraVarsArg = '';
  if (Object.keys(extra_vars).length > 0) {
    const varsJson = JSON.stringify(extra_vars).replace(/'/g, "'\\''");
    extraVarsArg = `--extra-vars '${varsJson}'`;
  }

  const cmd = [
    'ansible-playbook',
    `-i '${inventoryArg}'`,
    playbook,
    `--user=${username}`,
    `--private-key=${keyPath}`,
    `-e 'ansible_port=${port}'`,
    `-e 'ansible_ssh_common_args="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null"'`,
    extraVarsArg,
  ]
    .filter(Boolean)
    .join(' ');

  const result = await executeCommand(cmd, { timeout: 1800000 }); // 30 min timeout

  if (result.success) {
    return { success: true, message: `Ansible playbook completed: ${playbook}` };
  }
  return { success: false, error: `Ansible playbook failed: ${result.error}` };
};

/**
 * Run ansible-local provisioner INSIDE zone via SSH
 * @param {string} ip
 * @param {number} port
 * @param {Object} credentials
 * @param {Object} provisioner - { playbook, extra_vars, collections, install_mode }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
const runAnsibleLocalProvisioner = async (ip, port, credentials, provisioner) => {
  const { playbook, extra_vars = {}, collections = [], install_mode } = provisioner;
  const username = credentials.username || 'root';

  if (!playbook) {
    return { success: false, error: 'playbook is required for ansible_local provisioner' };
  }

  // Install ansible inside zone if install_mode specified
  if (install_mode === 'pip') {
    await executeSSHCommand(
      ip,
      username,
      credentials,
      'pip3 install ansible 2>/dev/null || pip install ansible 2>/dev/null',
      port,
      { timeout: 300000 }
    );
  } else if (install_mode === 'pkg') {
    await executeSSHCommand(
      ip,
      username,
      credentials,
      'pkg install ansible 2>/dev/null || apt-get install -y ansible 2>/dev/null || yum install -y ansible 2>/dev/null',
      port,
      { timeout: 300000 }
    );
  }

  // Install collections inside zone (parallel)
  if (collections.length > 0) {
    const collectionInstalls = collections.map(collection =>
      executeSSHCommand(
        ip,
        username,
        credentials,
        `ansible-galaxy collection install ${collection} --force`,
        port,
        { timeout: 300000 }
      )
    );
    await Promise.all(collectionInstalls);
  }

  // Build extra-vars
  let extraVarsArg = '';
  if (Object.keys(extra_vars).length > 0) {
    const varsJson = JSON.stringify(extra_vars).replace(/'/g, "'\\''");
    extraVarsArg = `--extra-vars '${varsJson}'`;
  }

  const cmd = `ansible-playbook -i 'localhost,' -c local ${playbook} ${extraVarsArg}`;

  const result = await executeSSHCommand(ip, username, credentials, cmd, port, {
    timeout: 1800000,
  });

  if (result.success) {
    return { success: true, message: `Ansible-local playbook completed: ${playbook}` };
  }
  return { success: false, error: `Ansible-local failed: ${result.stderr || result.stdout}` };
};

/**
 * Execute zone SSH wait task
 * Polls until SSH is available on the zone
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneWaitSSHTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {} } = metadata;

    if (!ip) {
      return { success: false, error: 'ip is required in task metadata' };
    }

    const provConfig = config.get('provisioning') || {};
    const sshConfig = provConfig.ssh || {};
    const timeout = (sshConfig.timeout_seconds || 300) * 1000;
    const interval = (sshConfig.poll_interval_seconds || 10) * 1000;

    const result = await waitForSSH(
      ip,
      credentials.username || 'root',
      credentials,
      port,
      timeout,
      interval
    );

    if (result.success) {
      return {
        success: true,
        message: `SSH available on ${zone_name} (${ip}:${port}) after ${Math.round(result.elapsed_ms / 1000)}s`,
      };
    }

    return { success: false, error: result.error };
  } catch (error) {
    log.task.error('Zone SSH wait failed', { zone_name, error: error.message });
    return { success: false, error: `SSH wait failed: ${error.message}` };
  }
};

/**
 * Execute zone file sync task
 * Syncs provisioning files from host to zone via rsync
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneSyncTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {}, sync_folders = [] } = metadata;

    if (!ip) {
      return { success: false, error: 'ip is required in task metadata' };
    }

    if (sync_folders.length === 0) {
      return { success: true, message: 'No sync folders configured, skipping' };
    }

    const errors = [];
    const synced = [];

    // Process sync folders sequentially (dependencies may exist between folders)
    const processSyncFolders = async (index = 0) => {
      if (index >= sync_folders.length) {
        return;
      }
      const folder = sync_folders[index];
      const { source, dest } = folder;

      if (!source || !dest) {
        errors.push(`Invalid sync folder: missing source or dest`);
        await processSyncFolders(index + 1);
        return;
      }

      log.task.info('Syncing folder to zone', { zone_name, source, dest });

      // Ensure destination directory exists
      await executeSSHCommand(
        ip,
        credentials.username || 'root',
        credentials,
        `mkdir -p ${dest}`,
        port
      );

      const result = await syncFiles(
        ip,
        credentials.username || 'root',
        credentials,
        source,
        dest,
        port,
        { exclude: folder.exclude }
      );

      if (result.success) {
        synced.push(`${source} → ${dest}`);
      } else {
        errors.push(`${source} → ${dest}: ${result.error}`);
      }
      await processSyncFolders(index + 1);
    };

    await processSyncFolders();

    if (errors.length > 0) {
      return {
        success: false,
        error: `File sync had ${errors.length} error(s): ${errors.join('; ')}`,
        synced,
      };
    }

    return {
      success: true,
      message: `Synced ${synced.length} folder(s) to ${zone_name}`,
      synced,
    };
  } catch (error) {
    log.task.error('Zone file sync failed', { zone_name, error: error.message });
    return { success: false, error: `File sync failed: ${error.message}` };
  }
};

/**
 * Execute zone provisioner task
 * Runs shell scripts or ansible playbooks against the zone
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneProvisionTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { ip, port = 22, credentials = {}, provisioners = [] } = metadata;

    if (!ip) {
      return { success: false, error: 'ip is required in task metadata' };
    }

    if (provisioners.length === 0) {
      return { success: true, message: 'No provisioners configured, skipping' };
    }

    const results = [];
    const errors = [];

    // Execute provisioners sequentially (order matters, later provisioners may depend on earlier ones)
    const executeProvisionersSequentially = async (index = 0) => {
      if (index >= provisioners.length) {
        return;
      }
      const provisioner = provisioners[index];
      log.task.info('Running provisioner', { zone_name, type: provisioner.type, index });

      let result;
      switch (provisioner.type) {
        case 'shell':
          result = await runShellProvisioner(ip, port, credentials, provisioner);
          break;
        case 'ansible':
          result = await runAnsibleProvisioner(ip, port, credentials, provisioner);
          break;
        case 'ansible_local':
          result = await runAnsibleLocalProvisioner(ip, port, credentials, provisioner);
          break;
        default:
          result = { success: false, error: `Unknown provisioner type: ${provisioner.type}` };
      }

      results.push({ type: provisioner.type, index, ...result });

      if (!result.success) {
        errors.push(`Provisioner ${index} (${provisioner.type}): ${result.error}`);
        return; // Stop on first failure
      }
      await executeProvisionersSequentially(index + 1);
    };

    await executeProvisionersSequentially();

    // Update zone provisioning status
    await Zones.update({ last_seen: new Date() }, { where: { name: zone_name } });

    if (errors.length > 0) {
      return {
        success: false,
        error: errors.join('; '),
        results,
      };
    }

    return {
      success: true,
      message: `All ${provisioners.length} provisioner(s) completed successfully`,
      results,
    };
  } catch (error) {
    log.task.error('Zone provisioning failed', { zone_name, error: error.message });
    return { success: false, error: `Provisioning failed: ${error.message}` };
  }
};

/**
 * Execute zone provisioning extraction task
 * Creates ZFS dataset and extracts artifact
 * @param {Object} task - Task object from TaskQueue
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeZoneProvisioningExtractTask = async task => {
  const { zone_name } = task;

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(task.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { artifact_id, dataset_path } = metadata;

    const artifact = await Artifacts.findByPk(artifact_id);
    if (!artifact) {
      return { success: false, error: `Artifact '${artifact_id}' not found` };
    }

    // Create ZFS dataset
    // dataset_path is like "/rpool/zones/myzone/provisioning" (mountpoint)
    // We need the ZFS dataset name (rpool/zones/myzone/provisioning)
    // Assuming dataset_path is the mountpoint which matches the dataset name with leading slash
    const zfsDataset = dataset_path.replace(/^\/+/, '');

    const createResult = await executeCommand(
      `pfexec zfs create -o mountpoint=${dataset_path} ${zfsDataset}`
    );

    // Check if dataset exists if creation failed (idempotency)
    if (!createResult.success) {
      const checkResult = await executeCommand(`pfexec zfs list ${zfsDataset}`);
      if (!checkResult.success) {
        return {
          success: false,
          error: 'Failed to create provisioning dataset',
          details: createResult.error,
        };
      }
    }

    // Extract artifact
    const extractResult = await executeCommand(
      `pfexec tar -xzf ${artifact.path} -C ${dataset_path}`,
      { timeout: 300000 }
    );

    if (!extractResult.success) {
      return {
        success: false,
        error: 'Failed to extract provisioning artifact',
        details: extractResult.error,
      };
    }

    // Create snapshot
    await executeCommand(`pfexec zfs snapshot ${zfsDataset}@pre-provision`);

    return { success: true, message: 'Provisioning artifact extracted successfully' };
  } catch (error) {
    log.task.error('Artifact extraction failed', { zone_name, error: error.message });
    return { success: false, error: `Extraction failed: ${error.message}` };
  }
};
