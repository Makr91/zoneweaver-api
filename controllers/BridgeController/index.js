/**
 * @fileoverview Bridge Controller barrel export
 * Re-exports all bridge management controllers
 */

import { getBridges, getBridgeDetails } from './BridgeQueryController.js';
import { createBridge, deleteBridge, modifyBridgeLinks } from './BridgeModificationController.js';

export { getBridges, getBridgeDetails };
export { createBridge, deleteBridge, modifyBridgeLinks };
