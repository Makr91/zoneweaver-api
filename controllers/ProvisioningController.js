import { exec } from 'child_process';
import util from 'util';
import config from '../config/ConfigLoader.js';
import Tasks, { TaskPriority } from '../models/TaskModel.js';
import yj from 'yieldable-json';

const execAsync = util.promisify(exec);

const packages = {
    'ansible': 'ansible',
    'vagrant': 'vagrant',
    'isc-dhcp': 'dhcpd',
    'zrepl': 'zrepl',
    'dtrace': 'dtrace',
    'git': 'git',
    'mtr': 'mtr',
    'fping': 'fping',
    'lsof': 'lsof',
    'sysstat': 'sysstat',
    'tree': 'tree',
    'tmux': 'tmux',
    'ooce/library/libarchive': 'bsdtar', // libarchive provides bsdtar
    'htop': 'htop',
    'ncdu': 'ncdu',
    'smartmontools': 'smartctl',
    'zadm': 'zadm',
    'rsync': 'rsync',
    'nano': 'nano'
};

const checkPackage = async (binaryName) => {
    try {
        await execAsync(`which ${binaryName}`);
        return true;
    } catch (error) {
        return false;
    }
};

const installPackage = async (packageName) => {
    try {
        console.log(`Creating task to install ${packageName}...`);
        
        // Create a task for package installation (will be serialized with other package operations)
        const task = await Tasks.create({
            zone_name: 'system',
            operation: 'pkg_install',
            priority: TaskPriority.NORMAL,
            created_by: 'provisioning_service',
            status: 'pending',
            metadata: await new Promise((resolve, reject) => {
                yj.stringifyAsync({
                    packages: [packageName],
                    accept_licenses: true,
                    dry_run: false
                }, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            })
        });

        console.log(`Package installation task created for ${packageName} (Task ID: ${task.id})`);
        return { success: true, task_id: task.id };
    } catch (error) {
        console.error(`Failed to create installation task for ${packageName}: ${error.message}`);
        return { success: false, error: error.message };
    }
};

export const checkAndInstallPackages = async () => {
    const provisioningConfig = config.get('provisioning');
    if (!provisioningConfig || !provisioningConfig.install_tools) {
        console.log('Tool provisioning is disabled in the configuration.');
        return;
    }

    console.log('Starting package provisioning check...');

    for (const [packageName, binaryName] of Object.entries(packages)) {
        const isInstalled = await checkPackage(binaryName);
        if (isInstalled) {
            console.log(`${packageName} (${binaryName}) is already installed.`);
        } else {
            console.log(`${packageName} (${binaryName}) not found. Attempting to install...`);
            await installPackage(packageName);
        }
    }

    console.log('Package provisioning check complete.');
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
