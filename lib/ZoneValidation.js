/**
 * @fileoverview Zone Validation Utilities
 * @description General-purpose zone validation functions used across the API
 */

/**
 * Validate zone name format
 * @param {string} zoneName - Zone name to validate
 * @returns {boolean} True if valid, false otherwise
 */
export const validateZoneName = zoneName => {
  if (!zoneName || typeof zoneName !== 'string') {
    return false;
  }

  // Zone names must:
  // - Be alphanumeric with hyphens, underscores, or dots
  // - Be between 1 and 64 characters
  // - Not start or end with special characters
  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;

  return validPattern.test(zoneName) && zoneName.length <= 64;
};

/**
 * Validate zone name and return detailed error
 * @param {string} zoneName - Zone name to validate
 * @returns {{valid: boolean, error?: string}} Validation result
 */
export const validateZoneNameDetailed = zoneName => {
  if (!zoneName || typeof zoneName !== 'string') {
    return { valid: false, error: 'Zone name is required and must be a string' };
  }

  if (zoneName.length > 64) {
    return { valid: false, error: 'Zone name must be 64 characters or less' };
  }

  const validPattern = /^[a-zA-Z0-9][a-zA-Z0-9\-_.]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
  if (!validPattern.test(zoneName)) {
    return {
      valid: false,
      error:
        'Zone name must contain only alphanumeric characters, hyphens, underscores, or dots, and cannot start or end with special characters',
    };
  }

  return { valid: true };
};
