/**
 * @fileoverview Provisioning Network Controller for Zoneweaver API
 * @description Manages the provisioning network backbone (etherstub + VNIC + IP + NAT + DHCP)
 *              for zone provisioning when the host is not on the same VLAN as guests
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import config from '../config/ConfigLoader.js';
import { log } from '../lib/Logger.js';

const execPromise = util.promisify(exec);

/**
 * Execute command safely with proper error handling
 * @param {string} command - Command to execute
 * @returns {Promise<{success: boolean, output?: string, error?: string}>}
 */
const executeCommand = async command => {
  try {
    const { stdout } = await execPromise(command, {
      encoding: 'utf8',
      timeout: 30000,
    });
    return { success: true, output: stdout.trim() };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      output: error.stdout || '',
    };
  }
};

/**
 * Get provisioning network configuration from config.yaml
 * @returns {Object} Provisioning network config with defaults
 */
const getProvNetConfig = () => {
  const provConfig = config.get('provisioning') || {};
  const netConfig = provConfig.network || {};
  return {
    enabled: netConfig.enabled !== false,
    etherstub_name: netConfig.etherstub_name || 'estub_provision',
    host_vnic_name: netConfig.host_vnic_name || 'provision_interconnect0',
    subnet: netConfig.subnet || '10.190.190.0/24',
    host_ip: netConfig.host_ip || '10.190.190.1',
    netmask: netConfig.netmask || '255.255.255.0',
    dhcp_range_start: netConfig.dhcp_range_start || '10.190.190.10',
    dhcp_range_end: netConfig.dhcp_range_end || '10.190.190.254',
  };
};

/**
 * Check if a component exists
 */
const componentExists = async (type, name) => {
  let cmd;
  switch (type) {
    case 'etherstub':
      cmd = `pfexec dladm show-etherstub ${name} 2>/dev/null`;
      break;
    case 'vnic':
      cmd = `pfexec dladm show-vnic ${name} 2>/dev/null`;
      break;
    case 'ip':
      cmd = `pfexec ipadm show-addr ${name} 2>/dev/null`;
      break;
    default:
      return false;
  }
  const result = await executeCommand(cmd);
  return result.success && result.output.length > 0;
};

/**
 * Detect the active external interface for NAT bridge
 * @returns {Promise<string|null>}
 */
const detectActiveInterface = async () => {
  // Try to find the default route interface
  const routeResult = await executeCommand('pfexec route -n get default 2>/dev/null');
  if (routeResult.success) {
    const ifMatch = routeResult.output.match(/interface:\s*(?<iface>\S+)/);
    if (ifMatch) {
      return ifMatch.groups.iface;
    }
  }

  // Fallback: find first UP interface that isn't loopback or our provisioning VNIC
  const netConfig = getProvNetConfig();
  const ifResult = await executeCommand('pfexec dladm show-link -p -o link,state');
  if (ifResult.success) {
    const lines = ifResult.output.split('\n');
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 2 && parts[1] === 'up') {
        const [iface] = parts;
        if (iface !== 'lo0' && iface !== netConfig.host_vnic_name && !iface.startsWith('estub')) {
          return iface;
        }
      }
    }
  }

  return null;
};

/**
 * Setup etherstub
 * @param {Object} netConfig - Network configuration
 * @returns {Promise<{result?: Object, error?: Object}>}
 */
const setupEtherstub = async netConfig => {
  if (await componentExists('etherstub', netConfig.etherstub_name)) {
    return { result: { component: 'etherstub', status: 'already_exists' } };
  }
  const result = await executeCommand(`pfexec dladm create-etherstub ${netConfig.etherstub_name}`);
  if (result.success) {
    return { result: { component: 'etherstub', status: 'created' } };
  }
  return { error: { component: 'etherstub', error: result.error } };
};

/**
 * Setup host VNIC
 * @param {Object} netConfig - Network configuration
 * @returns {Promise<{result?: Object, error?: Object}>}
 */
const setupVnic = async netConfig => {
  if (await componentExists('vnic', netConfig.host_vnic_name)) {
    return { result: { component: 'vnic', status: 'already_exists' } };
  }
  const result = await executeCommand(
    `pfexec dladm create-vnic -l ${netConfig.etherstub_name} ${netConfig.host_vnic_name}`
  );
  if (result.success) {
    return { result: { component: 'vnic', status: 'created' } };
  }
  return { error: { component: 'vnic', error: result.error } };
};

/**
 * Setup IP address
 * @param {Object} netConfig - Network configuration
 * @returns {Promise<{result?: Object, error?: Object}>}
 */
const setupIp = async netConfig => {
  if (await componentExists('ip', `${netConfig.host_vnic_name}/v4static`)) {
    return { result: { component: 'ip_address', status: 'already_exists' } };
  }
  // Ensure IP interface exists
  await executeCommand(`pfexec ipadm create-if ${netConfig.host_vnic_name} 2>/dev/null`);
  const prefixLen = netConfig.subnet.split('/')[1] || '24';
  const result = await executeCommand(
    `pfexec ipadm create-addr -T static -a ${netConfig.host_ip}/${prefixLen} ${netConfig.host_vnic_name}/v4static`
  );
  if (result.success) {
    return { result: { component: 'ip_address', status: 'created' } };
  }
  return { error: { component: 'ip_address', error: result.error } };
};

/**
 * Setup NAT and Forwarding
 * @param {Object} netConfig - Network configuration
 * @returns {Promise<{result?: Object, error?: Object}>}
 */
const setupNatAndForwarding = async netConfig => {
  const bridge = await detectActiveInterface();
  if (!bridge) {
    return {
      error: { component: 'nat', error: 'Could not detect active external interface for NAT' },
    };
  }

  const subnetBase = netConfig.subnet;
  const natRule = `map ${bridge} ${subnetBase} -> 0/32 portmap tcp/udp auto`;
  let natStatus = 'created';

  const natCheck = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
  if (natCheck.success && natCheck.output.includes(natRule)) {
    natStatus = 'already_exists';
  } else {
    await executeCommand('pfexec mkdir -p /etc/ipf');
    const natResult = await executeCommand(
      `pfexec bash -c 'echo "${natRule}" >> /etc/ipf/ipnat.conf'`
    );
    if (!natResult.success) {
      return { error: { component: 'nat', error: natResult.error } };
    }
    // Refresh ipfilter
    await executeCommand('pfexec svcadm refresh network/ipfilter 2>/dev/null');
    await executeCommand('pfexec svcadm enable network/ipfilter 2>/dev/null');
  }

  // Enable IP forwarding
  await executeCommand('pfexec routeadm -u -e ipv4-forwarding');
  await executeCommand(`pfexec ipadm set-ifprop -p forwarding=on -m ipv4 ${bridge} 2>/dev/null`);
  await executeCommand(
    `pfexec ipadm set-ifprop -p forwarding=on -m ipv4 ${netConfig.host_vnic_name} 2>/dev/null`
  );

  return {
    result: { component: 'nat_forwarding', status: natStatus, bridge, rule: natRule },
  };
};

/**
 * @swagger
 * /provisioning/network/status:
 *   get:
 *     summary: Get provisioning network status
 *     description: |
 *       Checks whether the provisioning network components are configured:
 *       etherstub, host VNIC, IP address, NAT rule, IP forwarding, and DHCP.
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Provisioning network status
 *       500:
 *         description: Failed to check provisioning network status
 */
export const getProvisioningNetworkStatus = async (req, res) => {
  try {
    const netConfig = getProvNetConfig();

    if (!netConfig.enabled) {
      return res.json({
        enabled: false,
        message: 'Provisioning network is disabled in configuration',
      });
    }

    // Check each component
    const etherstubExists = await componentExists('etherstub', netConfig.etherstub_name);
    const vnicExists = await componentExists('vnic', netConfig.host_vnic_name);
    const ipExists = await componentExists('ip', `${netConfig.host_vnic_name}/v4static`);

    // Check NAT rule
    const natResult = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
    const [subnetBase] = netConfig.subnet.split('/');
    const natConfigured = natResult.success && natResult.output.includes(subnetBase);

    // Check IP forwarding
    const fwdResult = await executeCommand('pfexec routeadm -p 2>/dev/null');
    const forwardingEnabled =
      fwdResult.success &&
      fwdResult.output.includes('ipv4-forwarding') &&
      fwdResult.output.includes('current=enabled');

    // Check DHCP
    const dhcpResult = await executeCommand(
      'svcs -H -o state dhcp/server:ipv4 2>/dev/null || svcs -H -o state dhcp:ipv4 2>/dev/null'
    );
    const dhcpRunning = dhcpResult.success && dhcpResult.output.trim() === 'online';

    const allReady =
      etherstubExists &&
      vnicExists &&
      ipExists &&
      natConfigured &&
      forwardingEnabled &&
      dhcpRunning;

    return res.json({
      enabled: true,
      ready: allReady,
      components: {
        etherstub: { name: netConfig.etherstub_name, exists: etherstubExists },
        vnic: { name: netConfig.host_vnic_name, exists: vnicExists },
        ip_address: { address: `${netConfig.host_ip}/24`, configured: ipExists },
        nat: { configured: natConfigured },
        ip_forwarding: { enabled: forwardingEnabled },
        dhcp: { running: dhcpRunning },
      },
      config: netConfig,
    });
  } catch (error) {
    log.api.error('Failed to check provisioning network status', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Failed to check provisioning network status', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/network/setup:
 *   post:
 *     summary: Setup provisioning network
 *     description: |
 *       Idempotent setup of the provisioning network backbone.
 *       Creates etherstub, host VNIC, assigns IP, configures NAT, enables IP forwarding, and configures DHCP.
 *       Each component is checked before creation — safe to call multiple times.
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Provisioning network setup completed
 *       500:
 *         description: Provisioning network setup failed
 */
export const setupProvisioningNetwork = async (req, res) => {
  try {
    const netConfig = getProvNetConfig();
    const results = [];
    const errors = [];

    const handleStep = stepResult => {
      if (stepResult.result) {
        results.push(stepResult.result);
      }
      if (stepResult.error) {
        errors.push(stepResult.error);
      }
    };

    // 1. Create etherstub
    handleStep(await setupEtherstub(netConfig));

    // 2. Create host VNIC on etherstub
    handleStep(await setupVnic(netConfig));

    // 3. Assign IP address
    handleStep(await setupIp(netConfig));

    // 4 & 5. NAT and Forwarding
    handleStep(await setupNatAndForwarding(netConfig));

    // 6. Configure DHCP
    const [subnetBase] = netConfig.subnet.split('/');
    const dhcpConfig = [
      `# Provisioning network DHCP - managed by zoneweaver-api`,
      `subnet ${subnetBase} netmask ${netConfig.netmask} {`,
      `  option routers ${netConfig.host_ip};`,
      `  range ${netConfig.dhcp_range_start} ${netConfig.dhcp_range_end};`,
      `}`,
    ].join('\n');

    // Check if DHCP is already configured for this subnet
    const dhcpCheck = await executeCommand('cat /etc/dhcpd.conf 2>/dev/null');
    if (dhcpCheck.success && dhcpCheck.output.includes(subnetBase)) {
      results.push({ component: 'dhcp', status: 'already_configured' });
    } else {
      const dhcpResult = await executeCommand(
        `pfexec bash -c 'cat > /etc/dhcpd.conf << '"'"'DHCPEOF'"'"'\n${dhcpConfig}\nDHCPEOF'`
      );
      if (dhcpResult.success) {
        // Set listen interface and enable DHCP
        await executeCommand(
          `pfexec svccfg -s dhcp/server:ipv4 setprop config/listen_ifnames = astring: ${netConfig.host_vnic_name} 2>/dev/null`
        );
        await executeCommand('pfexec svcadm refresh dhcp/server:ipv4 2>/dev/null');
        await executeCommand('pfexec svcadm enable dhcp/server:ipv4 2>/dev/null');
        results.push({ component: 'dhcp', status: 'configured' });
      } else {
        errors.push({ component: 'dhcp', error: dhcpResult.error });
      }
    }

    const allSuccess = errors.length === 0;

    return res.json({
      success: allSuccess,
      message: allSuccess
        ? 'Provisioning network setup completed successfully'
        : `Provisioning network setup completed with ${errors.length} error(s)`,
      results,
      errors: errors.length > 0 ? errors : undefined,
      config: netConfig,
    });
  } catch (error) {
    log.api.error('Provisioning network setup failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Provisioning network setup failed', details: error.message });
  }
};

/**
 * @swagger
 * /provisioning/network/teardown:
 *   delete:
 *     summary: Teardown provisioning network
 *     description: |
 *       Removes all provisioning network components in reverse order:
 *       DHCP, NAT rule, IP address, VNIC, etherstub.
 *     tags: [Provisioning Network]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Provisioning network teardown completed
 *       500:
 *         description: Provisioning network teardown failed
 */
export const teardownProvisioningNetwork = async (req, res) => {
  try {
    const netConfig = getProvNetConfig();
    const results = [];
    const errors = [];

    // 1. Disable DHCP
    const dhcpResult = await executeCommand('pfexec svcadm disable dhcp/server:ipv4 2>/dev/null');
    results.push({ component: 'dhcp', status: dhcpResult.success ? 'disabled' : 'not_running' });

    // 2. Remove NAT rules for our subnet
    const [subnetBase] = netConfig.subnet.split('/');
    const natCheck = await executeCommand('cat /etc/ipf/ipnat.conf 2>/dev/null');
    if (natCheck.success && natCheck.output) {
      const newContent = natCheck.output
        .split('\n')
        .filter(line => !line.includes(subnetBase))
        .join('\n');
      await executeCommand(
        `pfexec bash -c 'printf "%s" ${JSON.stringify(newContent)} > /etc/ipf/ipnat.conf'`
      );
      await executeCommand('pfexec svcadm refresh network/ipfilter 2>/dev/null');
      results.push({ component: 'nat', status: 'removed' });
    } else {
      results.push({ component: 'nat', status: 'not_found' });
    }

    // 3. Remove IP address
    const ipResult = await executeCommand(
      `pfexec ipadm delete-addr ${netConfig.host_vnic_name}/v4static 2>/dev/null`
    );
    results.push({ component: 'ip_address', status: ipResult.success ? 'removed' : 'not_found' });

    // Remove IP interface
    await executeCommand(`pfexec ipadm delete-if ${netConfig.host_vnic_name} 2>/dev/null`);

    // 4. Remove VNIC
    const vnicResult = await executeCommand(
      `pfexec dladm delete-vnic ${netConfig.host_vnic_name} 2>/dev/null`
    );
    results.push({ component: 'vnic', status: vnicResult.success ? 'removed' : 'not_found' });

    // 5. Remove etherstub
    const ethResult = await executeCommand(
      `pfexec dladm delete-etherstub ${netConfig.etherstub_name} 2>/dev/null`
    );
    results.push({ component: 'etherstub', status: ethResult.success ? 'removed' : 'not_found' });

    return res.json({
      success: true,
      message: 'Provisioning network teardown completed',
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    log.api.error('Provisioning network teardown failed', { error: error.message });
    return res
      .status(500)
      .json({ error: 'Provisioning network teardown failed', details: error.message });
  }
};
