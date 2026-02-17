/**
 * @fileoverview Zone Management barrel export
 * Re-exports all zone management controllers for routes/index.js
 */

export {
  getSystemZoneStatus,
  listZones,
  getZoneDetails,
  getZoneConfig,
} from './ZoneQueryController.js';
export { startZone, stopZone, restartZone } from './ZonePowerController.js';
export { createZone } from './ZoneCreationController.js';
export { modifyZone } from './ZoneModificationController.js';
export { deleteZone } from './ZoneDeletionController.js';
export {
  getZoneNotes,
  updateZoneNotes,
  getZoneTags,
  updateZoneTags,
} from './ZoneMetadataController.js';
export { bulkStartZones, bulkStopZones } from './ZoneBulkController.js';
export { cloneZone } from './ZoneCloneController.js';
