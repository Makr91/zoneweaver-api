import { formatBytes } from './ARCStatsHelper.js';

/**
 * @fileoverview ARC configuration validation utilities
 */

/**
 * Helper function to validate ARC settings
 * @param {Object} settings - Settings to validate
 * @param {number} physicalMemoryBytes - Physical memory in bytes
 * @returns {Object} Validation result
 */
export const validateARCSettings = (settings, physicalMemoryBytes) => {
  const errors = [];
  const warnings = [];

  const maxSafeARC = Math.floor(physicalMemoryBytes * 0.85);
  const minRecommendedARC = Math.floor(physicalMemoryBytes * 0.01);

  // Validate ARC max
  if (settings.arc_max_bytes) {
    if (settings.arc_max_bytes > maxSafeARC) {
      errors.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} exceeds safe limit of ${formatBytes(maxSafeARC)} (85% of ${formatBytes(physicalMemoryBytes)} physical memory)`
      );
    }

    if (settings.arc_max_bytes < minRecommendedARC) {
      warnings.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} is below recommended minimum of ${formatBytes(minRecommendedARC)}`
      );
    }
  }

  // Validate ARC min
  if (settings.arc_min_bytes) {
    if (settings.arc_min_bytes < 134217728) {
      // 128MB
      errors.push(
        `ARC min ${formatBytes(settings.arc_min_bytes)} is below absolute minimum of 128MB`
      );
    }

    if (settings.arc_min_bytes > Math.floor(physicalMemoryBytes * 0.1)) {
      warnings.push(`ARC min ${formatBytes(settings.arc_min_bytes)} exceeds 10% of system memory`);
    }
  }

  // Validate relationship between min and max
  if (settings.arc_min_bytes && settings.arc_max_bytes) {
    if (settings.arc_min_bytes >= settings.arc_max_bytes) {
      errors.push(
        `ARC min ${formatBytes(settings.arc_min_bytes)} must be less than ARC max ${formatBytes(settings.arc_max_bytes)}`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
};

/**
 * Validate dynamic ZFS parameters
 * @param {Object} settings - Settings to validate
 * @param {Array} errors - Errors array to populate
 * @param {Array} warnings - Warnings array to populate
 */
export const validateDynamicParameters = (settings, errors, warnings) => {
  if (settings.arc_max_percent !== undefined) {
    if (settings.arc_max_percent < 1 || settings.arc_max_percent > 100) {
      errors.push(`ARC max percent ${settings.arc_max_percent}% must be between 1 and 100`);
    } else if (settings.arc_max_percent > 85) {
      warnings.push(
        `ARC max percent ${settings.arc_max_percent}% exceeds recommended maximum of 85%`
      );
    }
  }

  if (settings.vdev_max_pending !== undefined) {
    if (settings.vdev_max_pending < 1 || settings.vdev_max_pending > 100) {
      errors.push(`Vdev max pending ${settings.vdev_max_pending} must be between 1 and 100`);
    } else if (settings.vdev_max_pending > 50) {
      warnings.push(
        `Vdev max pending ${settings.vdev_max_pending} is quite high - may increase latency for synchronous writes`
      );
    }
  }

  if (settings.user_reserve_hint_pct !== undefined) {
    if (settings.user_reserve_hint_pct < 0 || settings.user_reserve_hint_pct > 99) {
      errors.push(`User reserve hint ${settings.user_reserve_hint_pct}% must be between 0 and 99`);
    } else if (settings.user_reserve_hint_pct > 50) {
      warnings.push(
        `User reserve hint ${settings.user_reserve_hint_pct}% is quite high - may severely limit ARC effectiveness`
      );
    }
  }

  if (settings.prefetch_disable !== undefined && typeof settings.prefetch_disable !== 'boolean') {
    errors.push(`Prefetch disable must be a boolean value (true/false)`);
  }
};

/**
 * Helper function to validate all ZFS settings
 * @param {Object} settings - Settings to validate
 * @param {number} physicalMemoryBytes - Physical memory in bytes
 * @returns {Object} Validation result
 */
export const validateAllZFSSettings = (settings, physicalMemoryBytes) => {
  const errors = [];
  const warnings = [];

  const maxSafeARC = Math.floor(physicalMemoryBytes * 0.85);
  const minRecommendedARC = Math.floor(physicalMemoryBytes * 0.01);

  // Validate ARC max bytes
  if (settings.arc_max_bytes) {
    if (settings.arc_max_bytes > maxSafeARC) {
      errors.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} exceeds safe limit of ${formatBytes(maxSafeARC)} (85% of ${formatBytes(physicalMemoryBytes)} physical memory)`
      );
    }
    if (settings.arc_max_bytes < minRecommendedARC) {
      warnings.push(
        `ARC max ${formatBytes(settings.arc_max_bytes)} is below recommended minimum of ${formatBytes(minRecommendedARC)}`
      );
    }
  }

  // Validate ARC min bytes
  if (settings.arc_min_bytes) {
    if (settings.arc_min_bytes < 134217728) {
      errors.push(
        `ARC min ${formatBytes(settings.arc_min_bytes)} is below absolute minimum of 128MB`
      );
    }
    if (settings.arc_min_bytes > Math.floor(physicalMemoryBytes * 0.1)) {
      warnings.push(`ARC min ${formatBytes(settings.arc_min_bytes)} exceeds 10% of system memory`);
    }
  }

  // Validate dynamic parameters
  validateDynamicParameters(settings, errors, warnings);

  // Validate relationship between min and max
  if (
    settings.arc_min_bytes &&
    settings.arc_max_bytes &&
    settings.arc_min_bytes >= settings.arc_max_bytes
  ) {
    errors.push(
      `ARC min ${formatBytes(settings.arc_min_bytes)} must be less than ARC max ${formatBytes(settings.arc_max_bytes)}`
    );
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
};
