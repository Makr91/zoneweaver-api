/**
 * @fileoverview NAT and IP Forwarding Task Manager for Zoneweaver API
 * @description Executes NAT rule and IP forwarding tasks via ipnat/ipfilter and routeadm/ipadm
 */

import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import yj from 'yieldable-json';

/**
 * Refresh ipfilter service to apply NAT rule changes
 * @returns {Promise<{success: boolean, error?: string}>}
 */
const refreshIpfilter = async () => {
  // Refresh, then cycle the service to pick up changes
  const refreshResult = await executeCommand('pfexec svcadm refresh network/ipfilter');
  if (!refreshResult.success) {
    // Service might not be running yet, try enabling it
    const enableResult = await executeCommand('pfexec svcadm enable network/ipfilter');
    if (!enableResult.success) {
      return { success: false, error: enableResult.error };
    }
    return { success: true };
  }

  // Cycle the service to apply changes
  const disableResult = await executeCommand('pfexec svcadm disable network/ipfilter');
  if (!disableResult.success) {
    return { success: false, error: `Failed to disable ipfilter: ${disableResult.error}` };
  }

  const enableResult = await executeCommand('pfexec svcadm enable network/ipfilter');
  if (!enableResult.success) {
    return { success: false, error: `Failed to re-enable ipfilter: ${enableResult.error}` };
  }

  return { success: true };
};

/**
 * Execute NAT rule creation task
 * Appends a NAT rule to /etc/ipf/ipnat.conf and refreshes ipfilter
 * @param {string} metadataJson - JSON string with rule parameters
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeCreateNatRuleTask = async metadataJson => {
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

    const { bridge, subnet, target = '0/32', protocol = 'tcp/udp', type = 'portmap' } = metadata;

    if (!bridge || !subnet) {
      return { success: false, error: 'bridge and subnet are required' };
    }

    // Build the NAT rule
    let rule;
    if (type === 'portmap') {
      rule = `map ${bridge} ${subnet} -> ${target} portmap ${protocol} auto`;
    } else if (type === 'bimap') {
      rule = `bimap ${bridge} ${subnet} -> ${target}`;
    } else if (type === 'rdr') {
      rule = `rdr ${bridge} ${subnet} -> ${target}`;
    } else {
      return { success: false, error: `Unsupported NAT type: ${type}` };
    }

    // Ensure /etc/ipf directory exists
    await executeCommand('pfexec mkdir -p /etc/ipf');

    // Check if rule already exists
    const checkResult = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
    if (checkResult.success && checkResult.output && checkResult.output.includes(rule)) {
      return {
        success: true,
        message: `NAT rule already exists: ${rule}`,
      };
    }

    // Append rule to config file
    const appendResult = await executeCommand(
      `pfexec bash -c 'echo "${rule}" >> /etc/ipf/ipnat.conf'`
    );
    if (!appendResult.success) {
      return { success: false, error: `Failed to write NAT rule: ${appendResult.error}` };
    }

    // Refresh ipfilter service
    const refreshResult = await refreshIpfilter();
    if (!refreshResult.success) {
      log.task.warn('NAT rule written but ipfilter refresh failed', {
        rule,
        error: refreshResult.error,
      });
      return {
        success: true,
        message: `NAT rule added but ipfilter refresh failed: ${refreshResult.error}`,
      };
    }

    log.task.info('NAT rule created successfully', { rule, bridge, subnet });
    return {
      success: true,
      message: `NAT rule created: ${rule}`,
    };
  } catch (error) {
    log.task.error('NAT rule creation failed', { error: error.message });
    return { success: false, error: `NAT rule creation failed: ${error.message}` };
  }
};

/**
 * Execute NAT rule deletion task
 * Removes a rule by line index from /etc/ipf/ipnat.conf and refreshes ipfilter
 * @param {string} metadataJson - JSON string with { rule_id }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeDeleteNatRuleTask = async metadataJson => {
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

    const { rule_id } = metadata;

    // Read current config
    const readResult = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
    if (!readResult.success || !readResult.output) {
      return { success: false, error: 'No NAT configuration file found or file is empty' };
    }

    const allLines = readResult.output.split('\n');
    // Filter to non-comment, non-empty lines for indexing
    const ruleLines = [];
    const ruleLineIndices = [];
    allLines.forEach((line, idx) => {
      if (line.trim() && !line.trim().startsWith('#')) {
        ruleLines.push(line);
        ruleLineIndices.push(idx);
      }
    });

    if (rule_id < 0 || rule_id >= ruleLines.length) {
      return {
        success: false,
        error: `Rule index ${rule_id} out of range (0-${ruleLines.length - 1})`,
      };
    }

    const removedRule = ruleLines[rule_id];
    const lineToRemove = ruleLineIndices[rule_id];

    // Remove the line from the file
    const newLines = allLines.filter((_, idx) => idx !== lineToRemove);
    const newContent = newLines.join('\n');

    const writeResult = await executeCommand(
      `pfexec bash -c 'printf "%s" ${JSON.stringify(newContent)} > /etc/ipf/ipnat.conf'`
    );
    if (!writeResult.success) {
      return { success: false, error: `Failed to update NAT config: ${writeResult.error}` };
    }

    // Refresh ipfilter
    const refreshResult = await refreshIpfilter();
    if (!refreshResult.success) {
      log.task.warn('NAT rule removed but ipfilter refresh failed', { error: refreshResult.error });
    }

    log.task.info('NAT rule deleted successfully', { rule_id, rule: removedRule });
    return {
      success: true,
      message: `NAT rule deleted: ${removedRule}`,
    };
  } catch (error) {
    log.task.error('NAT rule deletion failed', { error: error.message });
    return { success: false, error: `NAT rule deletion failed: ${error.message}` };
  }
};

/**
 * Execute IP forwarding configuration task
 * Enables/disables global IPv4 forwarding and per-interface forwarding
 * @param {string} metadataJson - JSON string with { enabled, interfaces }
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeConfigureForwardingTask = async metadataJson => {
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

    const { enabled, interfaces } = metadata;
    const errors = [];

    // Configure global IPv4 forwarding
    if (enabled !== undefined) {
      const action = enabled ? '-e' : '-d';
      const routeResult = await executeCommand(`pfexec routeadm -u ${action} ipv4-forwarding`);
      if (!routeResult.success) {
        errors.push(`Global forwarding: ${routeResult.error}`);
      }
    }

    // Configure per-interface forwarding
    if (interfaces && interfaces.length > 0) {
      const value = enabled !== false ? 'on' : 'off';
      const results = await Promise.all(
        interfaces.map(iface =>
          executeCommand(`pfexec ipadm set-ifprop -p forwarding=${value} -m ipv4 ${iface}`)
        )
      );
      results.forEach((res, idx) => {
        if (!res.success) {
          errors.push(`Interface ${interfaces[idx]}: ${res.error}`);
        }
      });
    }

    if (errors.length > 0) {
      log.task.warn('IP forwarding configuration had errors', { errors });
      return {
        success: errors.length < (interfaces || []).length + (enabled !== undefined ? 1 : 0),
        message: `IP forwarding configured with ${errors.length} error(s)`,
        errors,
      };
    }

    log.task.info('IP forwarding configured successfully', { enabled, interfaces });
    return {
      success: true,
      message: 'IP forwarding configured successfully',
    };
  } catch (error) {
    log.task.error('IP forwarding configuration failed', { error: error.message });
    return { success: false, error: `IP forwarding configuration failed: ${error.message}` };
  }
};
