/**
 * @fileoverview Network Configuration Controller
 * @description Handles network interface configuration collection from various dladm commands
 * @author Mark Gilbert
 * @license: https://zoneweaver-api.startcloud.com/license/
 */

import { exec } from 'child_process';
import util from 'util';
import yj from 'yieldable-json';
import NetworkInterfaces from '../../models/NetworkInterfaceModel.js';
import NetworkParsingController from './NetworkParsingController.js';
import { log } from '../../lib/Logger.js';

const execProm = util.promisify(exec);

/**
 * Network Configuration Controller Class
 * @description Handles collection of network interface configuration data
 */
export class NetworkConfigController {
  constructor(hostMonitoringConfig, hostManager) {
    this.hostMonitoringConfig = hostMonitoringConfig;
    this.hostManager = hostManager;
    this.parser = new NetworkParsingController();
    this.isCollecting = false;
  }

  /**
   * Collect aggregate configuration
   * @description Gathers aggregate configuration from dladm show-aggr
   */
  async collectAggregateConfig() {
    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;

      // Get basic aggregate configuration
      const { stdout: aggrOutput } = await execProm('pfexec dladm show-aggr', { timeout });
      const aggrData = this.parser.parseAggregateOutput(aggrOutput);

      // For each aggregate, get detailed information
      for (const aggr of aggrData) {
        try {
          // Get extended information with port details
          const { stdout: extendedOutput } = await execProm(
            `pfexec dladm show-aggr ${aggr.link} -x -p -o link,port,speed,duplex,state,address,portstate`,
            { timeout }
          );

          let aggregateSpeed = null;
          let aggregateState = 'unknown';
          let aggregateAddress = null;
          const portList = [];
          const ports = [];

          if (extendedOutput.trim()) {
            const portLines = extendedOutput.split('\n').filter(line => line.trim());

            portLines.forEach(line => {
              const [linkName, port, speed, duplex, portState, address, portStateInfo] =
                line.split(':');

              if (!port) {
                // This is the aggregate summary line
                aggregateSpeed = speed ? parseInt(speed.replace('Mb', '')) || null : null;
                aggregateState = portState || 'unknown';
                aggregateAddress = address ? address.replace(/\\/g, '') : null;
              } else {
                // This is a port line
                ports.push({
                  port,
                  speed: speed ? parseInt(speed.replace('Mb', '')) || null : null,
                  duplex,
                  state: portState,
                  address: address ? address.replace(/\\/g, '') : null,
                  port_state: portStateInfo,
                });
                portList.push(port);
              }
            });
          }

          // Get LACP information
          try {
            const { stdout: lacpOutput } = await execProm(
              `pfexec dladm show-aggr ${aggr.link} -L -p -o link,port,aggregatable,sync,coll,dist,defaulted,expired`,
              { timeout }
            );

            const lacpInfo = [];
            if (lacpOutput.trim()) {
              const lacpLines = lacpOutput.split('\n').filter(line => line.trim());

              lacpLines.forEach(line => {
                const [linkName, port, aggregatable, sync, coll, dist, defaulted, expired] =
                  line.split(':');
                lacpInfo.push({
                  port,
                  aggregatable: aggregatable === 'yes',
                  sync: sync === 'yes',
                  collecting: coll === 'yes',
                  distributing: dist === 'yes',
                  defaulted: defaulted === 'yes',
                  expired: expired === 'yes',
                });
              });
            }

            // Store detailed LACP info as JSON
            if (lacpInfo.length > 0) {
              aggr.lacp_detail = await new Promise((resolve, reject) => {
                yj.stringifyAsync(lacpInfo, (err, result) => {
                  if (err) {
                    reject(err);
                  } else {
                    resolve(result);
                  }
                });
              });
            }
          } catch (lacpError) {
            log.monitoring.warn('Failed to get LACP info for aggregate', {
              aggregate: aggr.link,
              error: lacpError.message,
            });
          }

          // Update aggregate record with detailed information
          aggr.speed = aggregateSpeed;
          aggr.state = aggregateState;
          aggr.macaddress = aggregateAddress;
          aggr.over = portList.length > 0 ? portList.join(',') : null;

          // Store port details as JSON
          if (ports.length > 0) {
            aggr.ports_detail = await new Promise((resolve, reject) => {
              yj.stringifyAsync(ports, (err, result) => {
                if (err) {
                  reject(err);
                } else {
                  resolve(result);
                }
              });
            });
          }
        } catch (detailError) {
          log.monitoring.warn('Failed to get detailed info for aggregate', {
            aggregate: aggr.link,
            error: detailError.message,
          });
        }
      }

      return aggrData;
    } catch (error) {
      log.monitoring.warn('Failed to collect aggregate data', {
        error: error.message,
        hostname: this.parser.hostname,
      });
      return [];
    }
  }

  /**
   * Collect network interface configuration
   * @description Gathers interface configuration from various dladm commands
   */
  async collectNetworkConfig() {
    if (this.isCollecting) {
      return;
    }

    this.isCollecting = true;

    try {
      const timeout = this.hostMonitoringConfig.performance.command_timeout * 1000;
      const allInterfaces = [];

      // Collect VNIC information using parseable format for better accuracy
      try {
        const { stdout: vnicOutput } = await execProm(
          'pfexec dladm show-vnic -p -o LINK,OVER,SPEED,MACADDRESS,MACADDRTYPE,VID,ZONE',
          { timeout }
        );
        const vnicData = this.parser.parseVnicParseable(vnicOutput);
        allInterfaces.push(...vnicData);
      } catch (error) {
        log.monitoring.warn(
          'Failed to collect VNIC data with parseable format, trying legacy format',
          {
            error: error.message,
            hostname: this.parser.hostname,
          }
        );
        // Fallback to legacy format
        try {
          const { stdout: vnicOutput } = await execProm('pfexec dladm show-vnic', { timeout });
          const vnicData = this.parser.parseVnicOutput(vnicOutput);
          allInterfaces.push(...vnicData);
        } catch (fallbackError) {
          log.monitoring.warn('Failed to collect VNIC data with legacy format', {
            error: fallbackError.message,
            hostname: this.parser.hostname,
          });
        }
      }

      // Collect Ethernet information
      try {
        const { stdout: etherOutput } = await execProm('pfexec dladm show-ether', { timeout });
        const etherData = this.parser.parseEtherOutput(etherOutput);

        // Merge with existing interfaces or add new ones
        etherData.forEach(etherInterface => {
          const existing = allInterfaces.find(iface => iface.link === etherInterface.link);
          if (existing) {
            Object.assign(existing, etherInterface);
          } else {
            allInterfaces.push(etherInterface);
          }
        });
      } catch (error) {
        log.monitoring.warn('Failed to collect Ethernet data', {
          error: error.message,
          hostname: this.parser.hostname,
        });
      }

      // Collect Physical interface information
      try {
        const { stdout: physOutput } = await execProm('pfexec dladm show-phys', { timeout });
        const physData = this.parser.parsePhysOutput(physOutput);

        // Merge with existing interfaces or add new ones
        physData.forEach(physInterface => {
          const existing = allInterfaces.find(iface => iface.link === physInterface.link);
          if (existing) {
            Object.assign(existing, physInterface);
          } else {
            allInterfaces.push(physInterface);
          }
        });
      } catch (error) {
        log.monitoring.warn('Failed to collect Physical interface data', {
          error: error.message,
          hostname: this.parser.hostname,
        });
      }

      // Collect Link information
      try {
        const { stdout: linkOutput } = await execProm('pfexec dladm show-link', { timeout });
        const linkData = this.parser.parseLinkOutput(linkOutput);

        // Merge with existing interfaces or add new ones - PRESERVE aggregate-specific data
        linkData.forEach(linkInterface => {
          const existing = allInterfaces.find(iface => iface.link === linkInterface.link);
          if (existing) {
            // Only merge non-null values and don't overwrite aggregate-specific fields
            Object.keys(linkInterface).forEach(key => {
              // Skip aggregate-specific fields to prevent overwriting
              if (
                existing.class === 'aggr' &&
                [
                  'policy',
                  'address_policy',
                  'lacp_activity',
                  'lacp_timer',
                  'flags',
                  'ports_detail',
                  'lacp_detail',
                  'speed',
                  'state',
                  'macaddress',
                ].includes(key)
              ) {
                return; // Don't overwrite these fields for aggregates
              }

              // Only assign if the new value is not null/undefined and existing is null/undefined
              if (linkInterface[key] != null && (existing[key] == null || existing[key] === '')) {
                existing[key] = linkInterface[key];
              }
            });
          } else {
            allInterfaces.push(linkInterface);
          }
        });
      } catch (error) {
        log.monitoring.warn('Failed to collect Link data', {
          error: error.message,
          hostname: this.parser.hostname,
        });
      }

      // Collect Aggregate information
      try {
        const aggregateData = await this.collectAggregateConfig();

        if (aggregateData.length > 0) {
          // Remove any existing aggregate entries from allInterfaces to prevent duplicates
          const aggregateLinks = aggregateData.map(aggr => aggr.link);
          const filteredInterfaces = allInterfaces.filter(
            iface => !aggregateLinks.includes(iface.link) || iface.class !== 'aggr'
          );

          // Add comprehensive aggregate data
          filteredInterfaces.push(...aggregateData);
          allInterfaces.length = 0; // Clear array
          allInterfaces.push(...filteredInterfaces); // Repopulate
        }
      } catch (error) {
        log.monitoring.warn('Failed to collect Aggregate data', {
          error: error.message,
          hostname: this.parser.hostname,
        });
      }

      // Remove duplicate etherstubs, VLANs, and other interface types
      const uniqueInterfaces = new Map();

      allInterfaces.forEach(iface => {
        const key = `${iface.host}:${iface.link}:${iface.class}`;
        if (!uniqueInterfaces.has(key)) {
          uniqueInterfaces.set(key, iface);
        } else {
          // If we have a duplicate, merge the data (keep non-null values)
          const existing = uniqueInterfaces.get(key);
          Object.keys(iface).forEach(prop => {
            if (iface[prop] != null && (existing[prop] == null || existing[prop] === '')) {
              existing[prop] = iface[prop];
            }
          });
        }
      });

      // Replace allInterfaces with deduplicated data
      allInterfaces.length = 0;
      allInterfaces.push(...Array.from(uniqueInterfaces.values()));

      // Remove existing records for interfaces we're about to update to prevent duplicates
      if (allInterfaces.length > 0) {
        const interfaceLinks = allInterfaces.map(iface => iface.link);
        await NetworkInterfaces.destroy({
          where: {
            host: this.parser.hostname,
            link: interfaceLinks,
          },
        });
      }

      // Store in database in batches
      const batchSize = this.hostMonitoringConfig.performance.batch_size;
      for (let i = 0; i < allInterfaces.length; i += batchSize) {
        const batch = allInterfaces.slice(i, i + batchSize);
        await NetworkInterfaces.bulkCreate(batch);
      }

      await this.hostManager.updateHostInfo({ last_network_scan: new Date() });
      await this.hostManager.resetErrorCount();

      log.monitoring.debug('Network configuration collected', {
        interface_count: allInterfaces.length,
        hostname: this.parser.hostname,
      });
    } catch (error) {
      const shouldContinue = await this.hostManager.handleError(error, 'Network config collection');
      if (!shouldContinue) {
        this.isCollecting = false;
        return false;
      }
    } finally {
      this.isCollecting = false;
    }

    return true;
  }
}

export default NetworkConfigController;
