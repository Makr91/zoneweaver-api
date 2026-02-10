/**
 * @fileoverview DHCP Task Manager for Zoneweaver API
 * @description Executes DHCP configuration, host entry, and service control tasks
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';

const DHCPD_CONF_PATH = '/etc/dhcpd.conf';
const DHCP_SERVICE = 'dhcp/server:ipv4';

/**
 * Execute DHCP config update task
 * Writes subnet configuration to dhcpd.conf (preserves host entries)
 * @param {string} metadataJson - JSON string with subnet config
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDhcpUpdateConfigTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { subnet, netmask, router, range_start, range_end, dns, listen_interface } = metadata;

    if (!subnet || !netmask || !router || !range_start || !range_end) {
      return {
        success: false,
        error: 'subnet, netmask, router, range_start, and range_end are required',
      };
    }

    // Read existing config to preserve host entries
    const existingResult = await executeCommand(`cat ${DHCPD_CONF_PATH} 2>/dev/null`);
    let hostBlocks = '';
    if (existingResult.success && existingResult.output) {
      // Extract all host blocks
      const hostRegex = /host\s+\S+\s*\{[^}]*}/gs;
      const matches = existingResult.output.match(hostRegex);
      if (matches) {
        hostBlocks = `\n${matches.join('\n')}\n`;
      }
    }

    // Build new config
    let config = `# DHCP server configuration - managed by zoneweaver-api\n`;
    config += `# Last updated: ${new Date().toISOString()}\n\n`;
    config += `subnet ${subnet} netmask ${netmask} {\n`;
    config += `  option routers ${router};\n`;
    config += `  range ${range_start} ${range_end};\n`;
    if (dns) {
      config += `  option domain-name-servers ${dns};\n`;
    }
    config += `}\n`;

    // Append preserved host blocks
    if (hostBlocks) {
      config += hostBlocks;
    }

    // Write config file
    const writeResult = await executeCommand(
      `pfexec bash -c 'cat > ${DHCPD_CONF_PATH} << '"'"'DHCPEOF'"'"'\n${config}DHCPEOF'`
    );
    if (!writeResult.success) {
      return { success: false, error: `Failed to write DHCP config: ${writeResult.error}` };
    }

    // Set listen interface if specified
    if (listen_interface) {
      await executeCommand(
        `pfexec svccfg -s ${DHCP_SERVICE} setprop config/listen_ifnames = astring: ${listen_interface}`
      );
    }

    // Refresh DHCP service
    await executeCommand(`pfexec svcadm refresh ${DHCP_SERVICE}`);

    log.task.info('DHCP configuration updated', {
      subnet,
      netmask,
      router,
      range_start,
      range_end,
    });
    return {
      success: true,
      message: `DHCP configuration updated for subnet ${subnet}/${netmask}`,
    };
  } catch (error) {
    log.task.error('DHCP config update failed', { error: error.message });
    return { success: false, error: `DHCP config update failed: ${error.message}` };
  }
};

/**
 * Execute DHCP host addition task
 * Appends a host block to dhcpd.conf
 * @param {string} metadataJson - JSON string with { hostname, mac, ip }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDhcpAddHostTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { hostname, mac, ip } = metadata;

    if (!hostname || !mac || !ip) {
      return { success: false, error: 'hostname, mac, and ip are required' };
    }

    // Check if host already exists
    const existingResult = await executeCommand(`cat ${DHCPD_CONF_PATH} 2>/dev/null`);
    if (existingResult.success && existingResult.output) {
      const hostPattern = new RegExp(
        `host\\s+${hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`
      );
      if (hostPattern.test(existingResult.output)) {
        return { success: false, error: `Host entry '${hostname}' already exists` };
      }
    }

    // Build host block
    const hostBlock = `\nhost ${hostname} {\n  hardware ethernet ${mac};\n  fixed-address ${ip};\n}\n`;

    // Append to config
    const appendResult = await executeCommand(
      `pfexec bash -c 'cat >> ${DHCPD_CONF_PATH} << '"'"'HOSTEOF'"'"'\n${hostBlock}HOSTEOF'`
    );
    if (!appendResult.success) {
      return { success: false, error: `Failed to add host entry: ${appendResult.error}` };
    }

    // Refresh DHCP service
    await executeCommand(`pfexec svcadm refresh ${DHCP_SERVICE}`);

    log.task.info('DHCP host entry added', { hostname, mac, ip });
    return {
      success: true,
      message: `DHCP host entry added: ${hostname} (${mac} → ${ip})`,
    };
  } catch (error) {
    log.task.error('DHCP host addition failed', { error: error.message });
    return { success: false, error: `DHCP host addition failed: ${error.message}` };
  }
};

/**
 * Execute DHCP host removal task
 * Removes a host block from dhcpd.conf by hostname
 * @param {string} metadataJson - JSON string with { hostname }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDhcpRemoveHostTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { hostname } = metadata;

    if (!hostname) {
      return { success: false, error: 'hostname is required' };
    }

    // Read current config
    const readResult = await executeCommand(`cat ${DHCPD_CONF_PATH} 2>/dev/null`);
    if (!readResult.success || !readResult.output) {
      return { success: false, error: 'No DHCP configuration file found' };
    }

    // Remove the host block using regex
    const escapedHostname = hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hostPattern = new RegExp(`\\n?host\\s+${escapedHostname}\\s*\\{[^}]*}\\n?`, 'gs');
    const newContent = readResult.output.replace(hostPattern, '\n');

    if (newContent === readResult.output) {
      return { success: false, error: `Host entry '${hostname}' not found` };
    }

    // Write updated config
    const writeResult = await executeCommand(
      `pfexec bash -c 'cat > ${DHCPD_CONF_PATH} << '"'"'DHCPEOF'"'"'\n${newContent}DHCPEOF'`
    );
    if (!writeResult.success) {
      return { success: false, error: `Failed to update DHCP config: ${writeResult.error}` };
    }

    // Refresh DHCP service
    await executeCommand(`pfexec svcadm refresh ${DHCP_SERVICE}`);

    log.task.info('DHCP host entry removed', { hostname });
    return {
      success: true,
      message: `DHCP host entry removed: ${hostname}`,
    };
  } catch (error) {
    log.task.error('DHCP host removal failed', { error: error.message });
    return { success: false, error: `DHCP host removal failed: ${error.message}` };
  }
};

/**
 * Execute DHCP service control task
 * @param {string} metadataJson - JSON string with { action }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDhcpServiceControlTask = async metadataJson => {
  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { action } = metadata;
    let result;

    switch (action) {
      case 'start':
        result = await executeCommand(`pfexec svcadm enable ${DHCP_SERVICE}`);
        break;
      case 'stop':
        result = await executeCommand(`pfexec svcadm disable ${DHCP_SERVICE}`);
        break;
      case 'refresh':
        result = await executeCommand(`pfexec svcadm refresh ${DHCP_SERVICE}`);
        break;
      case 'restart':
        await executeCommand(`pfexec svcadm disable ${DHCP_SERVICE}`);
        result = await executeCommand(`pfexec svcadm enable ${DHCP_SERVICE}`);
        break;
      default:
        return { success: false, error: `Unknown DHCP service action: ${action}` };
    }

    if (!result.success) {
      return { success: false, error: `DHCP service ${action} failed: ${result.error}` };
    }

    log.task.info('DHCP service action completed', { action });
    return {
      success: true,
      message: `DHCP service ${action} completed successfully`,
    };
  } catch (error) {
    log.task.error('DHCP service control failed', { error: error.message });
    return { success: false, error: `DHCP service control failed: ${error.message}` };
  }
};
