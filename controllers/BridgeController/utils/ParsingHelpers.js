/**
 * @fileoverview Bridge data parsing helpers
 */

/**
 * Parse live bridge data from dladm output
 * @param {string} output - Raw output
 * @param {boolean|string} extended - Whether extended info is requested
 * @param {number} limit - Limit results
 * @returns {Array} Parsed bridges
 */
export const parseLiveBridgeData = (output, extended, limit) =>
  output
    ? output
        .split('\n')
        .filter(line => line.trim())
        .map(line => {
          const parts = line.split(':');
          if (extended === 'true' || extended === true) {
            const [
              bridge,
              address,
              priority,
              bmaxage,
              bhellotime,
              bfwddelay,
              forceproto,
              tctime,
              tccount,
              tchange,
              desroot,
              rootcost,
              rootport,
            ] = parts;
            return {
              bridge,
              address,
              priority: parseInt(priority) || null,
              max_age: parseInt(bmaxage) || null,
              hello_time: parseInt(bhellotime) || null,
              forward_delay: parseInt(bfwddelay) || null,
              force_protocol: parseInt(forceproto) || null,
              tc_time: parseInt(tctime) || null,
              tc_count: parseInt(tccount) || null,
              topology_change: tchange === 'yes',
              designated_root: desroot,
              root_cost: parseInt(rootcost) || null,
              root_port: parseInt(rootport) || null,
              source: 'live',
            };
          }
          const [bridge, address, priority, desroot] = parts;
          return {
            bridge,
            address,
            priority: parseInt(priority) || null,
            designated_root: desroot,
            source: 'live',
          };
        })
        .slice(0, parseInt(limit))
    : [];

/**
 * Parse bridge links from dladm output
 * @param {string} output - Raw output
 * @returns {Array} Parsed links
 */
export const parseBridgeLinks = output =>
  output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const [
        link,
        index,
        state,
        uptime,
        opercost,
        operp2p,
        operedge,
        linkDesroot,
        descost,
        desbridge,
        desport,
        tcack,
      ] = line.split(':');
      return {
        link,
        index: parseInt(index) || null,
        state,
        uptime: parseInt(uptime) || null,
        operational_cost: parseInt(opercost) || null,
        point_to_point: operp2p === 'yes',
        edge_port: operedge === 'yes',
        designated_root: linkDesroot,
        designated_cost: parseInt(descost) || null,
        designated_bridge: desbridge,
        designated_port: desport,
        topology_change_ack: tcack === 'yes',
      };
    });

/**
 * Parse bridge forwarding table from dladm output
 * @param {string} output - Raw output
 * @returns {Array} Parsed forwarding table
 */
export const parseBridgeForwarding = output =>
  output
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      const [dest, age, flags, fwdOutput] = line.split(':');
      return {
        destination: dest,
        age: age || null,
        flags: flags || '',
        output: fwdOutput,
      };
    });
