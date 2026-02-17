/**
 * @fileoverview NIC naming and configuration utilities
 */

/**
 * Map NIC type string to single-character code for VNIC naming
 * Matches vagrant-zones convention: e=external, i=internal, c=carp, m=management, h=host
 * @param {string} nicType - NIC type string
 * @returns {string} Single character code
 */
export const nicTypeCode = nicType => {
  const map = { external: 'e', internal: 'i', carp: 'c', management: 'm', host: 'h' };
  return map[nicType] || 'e';
};

/**
 * Map VM type string to single-digit code for VNIC naming
 * Matches vagrant-zones convention: 1=template, 2=development, 3=production, 4=firewall, 5=other
 * @param {string} vmType - VM type string
 * @returns {string} Single digit code
 */
export const vmTypeCode = vmType => {
  const map = { template: '1', development: '2', production: '3', firewall: '4', other: '5' };
  return map[vmType] || '3';
};

/**
 * Generate a VNIC name following the vagrant-zones naming convention
 * Pattern: vnic{nictype}{vmtype}_{server_id}_{nic_index}
 * @param {Object} nic - NIC configuration
 * @param {number} index - NIC index
 * @param {Object} metadata - Zone creation metadata
 * @returns {string} Generated VNIC name
 */
export const generateVnicName = (nic, index, metadata) => {
  const typeChar = nicTypeCode(nic.nic_type);
  const vmChar = vmTypeCode(metadata.vm_type);
  const serverId = (metadata.server_id || '0').padStart(4, '0');
  return `vnic${typeChar}${vmChar}_${serverId}_${index}`;
};
