/**
 * @fileoverview Network Controller exports
 */

import { getHostname, getIPAddresses } from './NetworkQueryController.js';
import {
  setHostname,
  createIPAddress,
  deleteIPAddress,
  enableIPAddress,
  disableIPAddress,
} from './NetworkModificationController.js';

export { getHostname, getIPAddresses };
export { setHostname, createIPAddress, deleteIPAddress, enableIPAddress, disableIPAddress };

export default {
  getHostname,
  getIPAddresses,
  setHostname,
  createIPAddress,
  deleteIPAddress,
  enableIPAddress,
  disableIPAddress,
};
