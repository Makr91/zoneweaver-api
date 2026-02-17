/**
 * @fileoverview Fault Management Controller barrel export
 * Re-exports all fault management controllers
 */

import { getFaults, getFaultDetails, getFaultManagerConfig } from './FaultQueryController.js';
import { acquitFault, markRepaired, markReplaced } from './FaultActionController.js';
import { getFaultStatusForHealth } from './FaultHealthController.js';

export { getFaults, getFaultDetails, getFaultManagerConfig };
export { acquitFault, markRepaired, markReplaced };
export { getFaultStatusForHealth };

export default {
  getFaults,
  getFaultDetails,
  getFaultManagerConfig,
  acquitFault,
  markRepaired,
  markReplaced,
  getFaultStatusForHealth,
};
