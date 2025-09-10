import { exec } from 'child_process';
import util from 'util';
import config from '../config/ConfigLoader.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';
import { log } from '../lib/Logger.js';

const execAsync = util.promisify(exec);

const packages = {
  ansible: 'ansible',
  vagrant: 'vagrant',
  'isc-dhcp': 'dhcpd',
  zrepl: 'zrepl',
  dtrace: 'dtrace',
  git: 'git',
  mtr: 'mtr',
  fping: 'fping',
  lsof: 'lsof',
  sysstat: 'sysstat',
  tree: 'tree',
  tmux: 'tmux',
  'ooce/library/libarchive': 'bsdtar', // libarchive provides bsdtar
  htop: 'htop',
  ncdu: 'ncdu',
  smartmontools: 'smartctl',
  zadm: 'zadm',
  rsync: 'rsync',
  nano: 'nano',
};

const checkPackage = async binaryName => {
  try {
    await execAsync(`which ${binaryName}`);
    return true;
  } catch (error) {
    return false;
  }
};

const installPackage = async packageName => {
  try {
    // Create a task for package installation (will be serialized with other package operations)
    const task = await Tasks.create({
      zone_name: 'system',
      operation: 'pkg_install',
      priority: TaskPriority.NORMAL,
      created_by: 'provisioning_service',
      status: 'pending',
      metadata: await new Promise((resolve, reject) => {
        yj.stringifyAsync(
          {
            packages: [packageName],
            accept_licenses: true,
            dry_run: false,
          },
          (err, result) => {
            if (err) {
              reject(err);
            } else {
              resolve(result);
            }
          }
        );
      }),
    });

    log.app.info('Package installation task created', {
      package: packageName,
      task_id: task.id,
    });
    return { success: true, task_id: task.id };
  } catch (error) {
    log.app.error('Failed to create installation task', {
      package: packageName,
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: error.message };
  }
};

export const checkAndInstallPackages = async () => {
  const provisioningConfig = config.get('provisioning');
  if (!provisioningConfig || !provisioningConfig.install_tools) {
    // Silently skip if provisioning is disabled
    return;
  }

  log.app.info('Starting package provisioning check');

  const missingPackages = [];
  for (const [packageName, binaryName] of Object.entries(packages)) {
    const isInstalled = await checkPackage(binaryName);
    if (!isInstalled) {
      missingPackages.push({ package: packageName, binary: binaryName });
      await installPackage(packageName);
    }
  }

  if (missingPackages.length > 0) {
    log.app.info('Package provisioning check complete', {
      missing_packages: missingPackages.length,
      packages: missingPackages,
    });
  }
};

/**
 * @swagger
 * /provisioning/status:
 *   get:
 *     summary: Get the installation status of all provisioning tools
 *     tags: [Provisioning]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: A JSON object with the installation status of each package
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties:
 *                 type: boolean
 *       500:
 *         description: Failed to get provisioning status
 */
export const getProvisioningStatus = async (req, res) => {
  const status = {};
  for (const [packageName, binaryName] of Object.entries(packages)) {
    status[packageName] = await checkPackage(binaryName);
  }
  res.json(status);
};
