import { executeSetHostnameTask } from '../TaskManager/SystemManager.js';
import {
  executeUpdateTimeSyncConfigTask,
  executeForceTimeSyncTask,
  executeSetTimezoneTask,
  executeSwitchTimeSyncSystemTask,
} from '../TaskManager/TimeManager.js';
import {
  executeSystemHostRestartTask,
  executeSystemHostRebootTask,
  executeSystemHostRebootFastTask,
  executeSystemHostShutdownTask,
  executeSystemHostPoweroffTask,
  executeSystemHostHaltTask,
  executeSystemHostRunlevelChangeTask,
} from '../TaskManager/SystemHostManager/index.js';
import {
  executePkgInstallTask,
  executePkgUninstallTask,
  executePkgUpdateTask,
  executePkgRefreshTask,
} from '../TaskManager/PackageManager.js';
import {
  executeBeadmCreateTask,
  executeBeadmDeleteTask,
  executeBeadmActivateTask,
  executeBeadmMountTask,
  executeBeadmUnmountTask,
} from '../TaskManager/BootManager.js';
import {
  executeRepositoryAddTask,
  executeRepositoryRemoveTask,
  executeRepositoryModifyTask,
  executeRepositoryEnableTask,
  executeRepositoryDisableTask,
} from '../TaskManager/RepositoryManager.js';
import {
  executeUserCreateTask,
  executeUserModifyTask,
  executeUserDeleteTask,
  executeUserSetPasswordTask,
  executeUserLockTask,
  executeUserUnlockTask,
} from '../TaskManager/UserManager.js';
import {
  executeGroupCreateTask,
  executeGroupModifyTask,
  executeGroupDeleteTask,
} from '../TaskManager/GroupManager.js';
import {
  executeRoleCreateTask,
  executeRoleModifyTask,
  executeRoleDeleteTask,
} from '../TaskManager/RoleManager.js';
import {
  executeFileMoveTask,
  executeFileCopyTask,
  executeFileArchiveCreateTask,
  executeFileArchiveExtractTask,
} from '../TaskManager/FileManager.js';

/**
 * @fileoverview System, package, user, and file task dispatchers
 */

export { executeProcessTraceTask } from '../TaskManager/ProcessManager.js';

/**
 * Execute system-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemTask = (operation, metadata) => {
  switch (operation) {
    case 'set_hostname':
      return executeSetHostnameTask(metadata);
    case 'update_time_sync_config':
      return executeUpdateTimeSyncConfigTask(metadata);
    case 'force_time_sync':
      return executeForceTimeSyncTask(metadata);
    case 'set_timezone':
      return executeSetTimezoneTask(metadata);
    case 'switch_time_sync_system':
      return executeSwitchTimeSyncSystemTask(metadata);
    default:
      return { success: false, error: `Unknown system operation: ${operation}` };
  }
};

/**
 * Execute system host management tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeSystemHostTask = (operation, metadata) => {
  switch (operation) {
    case 'system_host_restart':
      return executeSystemHostRestartTask(metadata);
    case 'system_host_reboot':
      return executeSystemHostRebootTask(metadata);
    case 'system_host_reboot_fast':
      return executeSystemHostRebootFastTask(metadata);
    case 'system_host_shutdown':
      return executeSystemHostShutdownTask(metadata);
    case 'system_host_poweroff':
      return executeSystemHostPoweroffTask(metadata);
    case 'system_host_halt':
      return executeSystemHostHaltTask(metadata);
    case 'system_host_runlevel_change':
      return executeSystemHostRunlevelChangeTask(metadata);
    default:
      return { success: false, error: `Unknown system host operation: ${operation}` };
  }
};

/**
 * Execute package-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executePackageTask = (operation, metadata) => {
  switch (operation) {
    case 'pkg_install':
      return executePkgInstallTask(metadata);
    case 'pkg_uninstall':
      return executePkgUninstallTask(metadata);
    case 'pkg_update':
      return executePkgUpdateTask(metadata);
    case 'pkg_refresh':
      return executePkgRefreshTask(metadata);
    case 'beadm_create':
      return executeBeadmCreateTask(metadata);
    case 'beadm_delete':
      return executeBeadmDeleteTask(metadata);
    case 'beadm_activate':
      return executeBeadmActivateTask(metadata);
    case 'beadm_mount':
      return executeBeadmMountTask(metadata);
    case 'beadm_unmount':
      return executeBeadmUnmountTask(metadata);
    case 'repository_add':
      return executeRepositoryAddTask(metadata);
    case 'repository_remove':
      return executeRepositoryRemoveTask(metadata);
    case 'repository_modify':
      return executeRepositoryModifyTask(metadata);
    case 'repository_enable':
      return executeRepositoryEnableTask(metadata);
    case 'repository_disable':
      return executeRepositoryDisableTask(metadata);
    default:
      return { success: false, error: `Unknown package operation: ${operation}` };
  }
};

/**
 * Execute user management tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeUserTask = (operation, metadata) => {
  switch (operation) {
    case 'user_create':
      return executeUserCreateTask(metadata);
    case 'user_modify':
      return executeUserModifyTask(metadata);
    case 'user_delete':
      return executeUserDeleteTask(metadata);
    case 'user_set_password':
      return executeUserSetPasswordTask(metadata);
    case 'user_lock':
      return executeUserLockTask(metadata);
    case 'user_unlock':
      return executeUserUnlockTask(metadata);
    case 'group_create':
      return executeGroupCreateTask(metadata);
    case 'group_modify':
      return executeGroupModifyTask(metadata);
    case 'group_delete':
      return executeGroupDeleteTask(metadata);
    case 'role_create':
      return executeRoleCreateTask(metadata);
    case 'role_modify':
      return executeRoleModifyTask(metadata);
    case 'role_delete':
      return executeRoleDeleteTask(metadata);
    default:
      return { success: false, error: `Unknown user operation: ${operation}` };
  }
};

/**
 * Execute file-related tasks
 * @param {string} operation - Operation type
 * @param {string} metadata - Task metadata
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeFileTask = (operation, metadata) => {
  switch (operation) {
    case 'file_move':
      return executeFileMoveTask(metadata);
    case 'file_copy':
      return executeFileCopyTask(metadata);
    case 'file_archive_create':
      return executeFileArchiveCreateTask(metadata);
    case 'file_archive_extract':
      return executeFileArchiveExtractTask(metadata);
    default:
      return { success: false, error: `Unknown file operation: ${operation}` };
  }
};
