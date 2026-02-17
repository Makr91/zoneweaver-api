/**
 * @fileoverview VNIC Controller exports
 */

import { getVNICs, getVNICDetails, getVNICStats, getVNICProperties } from './VnicQueryController.js';
import {
  createVNIC,
  deleteVNIC,
  setVNICProperties,
} from './VnicModificationController.js';

export { getVNICs, getVNICDetails, getVNICStats, getVNICProperties };
export { createVNIC, deleteVNIC, setVNICProperties };

export default {
  getVNICs,
  getVNICDetails,
  getVNICStats,
  getVNICProperties,
  createVNIC,
  deleteVNIC,
  setVNICProperties,
};
