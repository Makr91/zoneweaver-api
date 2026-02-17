/**
 * @fileoverview Syslog configuration parsing helpers
 */

/**
 * Helper function to parse selector and action
 * @param {string} selector - Selector part (e.g., "*.notice;mail.none")
 * @param {string} action - Action part (e.g., "/var/log/messages")
 * @returns {Object} Parsed selector and action
 */
export const parseSelectorAndAction = (selector, action) => {
  const parsed = {
    selectors: [],
    action_type: 'unknown',
    action_target: action,
  };

  // Parse selectors (semicolon separated)
  const selectorParts = selector.split(';');

  for (const part of selectorParts) {
    const trimmed = part.trim();
    if (trimmed.includes('.')) {
      const [facility, level] = trimmed.split('.');
      parsed.selectors.push({
        facility,
        level,
      });
    } else {
      parsed.selectors.push({
        facility: trimmed,
        level: null,
      });
    }
  }

  // Determine action type
  if (action.startsWith('/')) {
    parsed.action_type = 'file';
  } else if (action.startsWith('@')) {
    parsed.action_type = 'remote_host';
    parsed.action_target = action.substring(1);
  } else if (action === '*') {
    parsed.action_type = 'all_users';
  } else if (action.includes(',')) {
    parsed.action_type = 'specific_users';
    parsed.action_target = action.split(',').map(u => u.trim());
  } else {
    parsed.action_type = 'user';
  }

  return parsed;
};

/**
 * Helper function to parse syslog configuration
 * @param {string} configContent - Syslog configuration content
 * @returns {Array} Parsed rules
 */
export const parseSyslogConfig = configContent => {
  const rules = [];

  if (!configContent) {
    return rules;
  }

  const lines = configContent.split('\n');

  for (let lineNum = 0; lineNum < lines.length; lineNum++) {
    const line = lines[lineNum].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Parse selector and action (separated by TAB or multiple spaces)
    const parts = line.split(/\t+|\s{2,}/);
    if (parts.length >= 2) {
      const [selector, ...actionParts] = parts;
      const action = actionParts.join(' ');

      rules.push({
        line_number: lineNum + 1,
        selector,
        action,
        full_line: line,
        parsed: parseSelectorAndAction(selector, action),
      });
    } else {
      rules.push({
        line_number: lineNum + 1,
        full_line: line,
        error: 'Could not parse selector and action',
      });
    }
  }

  return rules;
};
