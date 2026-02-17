/**
 * @fileoverview Bridge parameter validation helpers
 */

/**
 * Validate bridge creation parameters
 * @param {Object} params - Request body parameters
 * @returns {string|null} Error message or null if valid
 */
export const validateBridgeParams = params => {
  const { name, protection, priority, max_age, hello_time, forward_delay } = params;

  if (!name) {
    return 'name is required';
  }

  const bridgeNameRegex = /^[a-zA-Z][a-zA-Z0-9_]*[a-zA-Z]$/;
  if (!bridgeNameRegex.test(name) || name.length > 31) {
    return 'Bridge name must start and end with letter, contain alphanumeric/underscore, and be max 31 characters';
  }

  if (name === 'default' || name.startsWith('SUNW')) {
    return 'Bridge name "default" and names starting with "SUNW" are reserved';
  }

  if (!['stp', 'trill'].includes(protection)) {
    return 'Protection method must be "stp" or "trill"';
  }

  if (priority < 0 || priority > 61440 || priority % 4096 !== 0) {
    return 'Priority must be between 0 and 61440 and divisible by 4096';
  }

  if (max_age < 6 || max_age > 40) {
    return 'Max age must be between 6 and 40 seconds';
  }
  if (hello_time < 1 || hello_time > 10) {
    return 'Hello time must be between 1 and 10 seconds';
  }
  if (forward_delay < 4 || forward_delay > 30) {
    return 'Forward delay must be between 4 and 30 seconds';
  }

  if (2 * (forward_delay - 1) < max_age) {
    return 'STP constraint violation: 2 * (forward-delay - 1) must be >= max-age';
  }
  if (max_age < 2 * (hello_time + 1)) {
    return 'STP constraint violation: max-age must be >= 2 * (hello-time + 1)';
  }

  return null;
};
