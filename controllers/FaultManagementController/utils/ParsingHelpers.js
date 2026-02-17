/**
 * @fileoverview Fault output parsing helpers
 */

/**
 * Helper function to normalize severity levels
 * @param {string} severity - Raw severity from fmadm
 * @returns {string} Normalized severity
 */
export const normalizeSeverity = severity => {
  if (!severity) {
    return severity;
  }

  // Normalize case - capitalize first letter, lowercase rest
  return severity.charAt(0).toUpperCase() + severity.slice(1).toLowerCase();
};

/**
 * Helper function to parse detailed fault information
 * @param {string} section - Detailed fault section
 * @returns {Object|null} Parsed fault object or null
 */
export const parseDetailedFault = section => {
  const fault = { format: 'detailed' };
  const lines = section.split('\n');
  let currentField = null;
  let currentValue = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      // Save current field before skipping
      if (currentField && currentValue) {
        fault[currentField] = currentValue.trim();
        currentField = null;
        currentValue = '';
      }
      continue;
    }

    // Check if this line starts a new field (contains colon not at the start of indented line)
    if (line.match(/^[A-Z]/) && line.includes(':')) {
      // Save previous field
      if (currentField && currentValue) {
        fault[currentField] = currentValue.trim();
      }

      // Parse new field
      const colonIndex = line.indexOf(':');
      const fieldName = line.substring(0, colonIndex).trim();
      const fieldValue = line.substring(colonIndex + 1).trim();

      // Handle special cases
      if (fieldName === 'Host') {
        currentField = 'host';
        currentValue = fieldValue;
      } else if (fieldName === 'Platform') {
        // Handle tab-separated fields on same line
        currentField = 'platform';
        currentValue = fieldValue.split('\t')[0].trim(); // Take only part before tab
      } else if (fieldName === 'Fault class') {
        currentField = 'faultClass';
        currentValue = fieldValue;
      } else if (fieldName === 'Affects') {
        currentField = 'affects';
        currentValue = fieldValue;
      } else if (fieldName === 'Problem in') {
        currentField = 'problemIn';
        currentValue = fieldValue;
      } else if (fieldName === 'Description') {
        currentField = 'description';
        currentValue = fieldValue;
      } else if (fieldName === 'Response') {
        currentField = 'response';
        currentValue = fieldValue;
      } else if (fieldName === 'Impact') {
        currentField = 'impact';
        currentValue = fieldValue;
      } else if (fieldName === 'Action') {
        currentField = 'action';
        currentValue = fieldValue;
      } else {
        // Skip unknown fields like Product_sn, Chassis_id
        currentField = null;
        currentValue = '';
      }
    } else if (currentField && trimmed) {
      // This is a continuation line for the current field
      if (currentValue) {
        currentValue += ` ${trimmed}`;
      } else {
        currentValue = trimmed;
      }
    }
  }

  // Save the last field
  if (currentField && currentValue) {
    fault[currentField] = currentValue.trim();
  }

  return Object.keys(fault).length > 1 ? fault : null;
};

/**
 * Helper function to parse a single fault line from tabular output
 * @param {string} line - Single line from fmadm output
 * @returns {Object|null} Parsed fault object or null
 */
export const parseFaultLine = line => {
  const trimmed = line.trim();

  // Skip empty lines and lines that are clearly not fault data
  if (!trimmed || trimmed.length < 20) {
    return null;
  }

  // Parse the format: "Jan 19 2025     c543b4ad-6cc7-40bc-891a-186100ef16a7  ZFS-8000-CS    Major"
  // Use regex to match the UUID pattern
  const uuidPattern =
    /(?<uuid>[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})/;
  const match = trimmed.match(uuidPattern);

  if (!match) {
    return null;
  }

  const { uuid } = match.groups;
  const beforeUuid = trimmed.substring(0, match.index).trim();
  const afterUuid = trimmed.substring(match.index + uuid.length).trim();

  // Split the part after UUID to get MSG-ID and SEVERITY
  const afterParts = afterUuid.split(/\s+/);
  if (afterParts.length < 2) {
    return null;
  }

  const [msgId, severity] = afterParts;

  return {
    time: beforeUuid,
    uuid,
    msgId,
    severity: normalizeSeverity(severity),
    format: 'summary',
  };
};

/**
 * Helper function to parse fmadm config output
 * @param {string} output - Raw fmadm config output
 * @returns {Array} Parsed module configurations
 */
export const parseFaultManagerConfig = output => {
  const modules = [];
  const lines = output.trim().split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('MODULE')) {
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 3) {
        modules.push({
          module: parts[0],
          version: parts[1],
          description: parts.slice(2).join(' '),
        });
      }
    }
  }

  return modules;
};

/**
 * Helper function to generate faults summary
 * @param {Array} faults - Array of parsed faults
 * @returns {Object} Summary statistics
 */
export const generateFaultsSummary = faults => {
  const summary = {
    totalFaults: faults.length,
    severityLevels: [],
    faultClasses: [],
    affectedResources: [],
  };

  const severityCount = {};
  const classCount = {};

  for (const fault of faults) {
    // Count severities
    if (fault.severity) {
      severityCount[fault.severity] = (severityCount[fault.severity] || 0) + 1;
    }

    // Count fault classes from details if available, otherwise from fault object
    const faultClass = fault.details?.faultClass || fault.faultClass;
    if (faultClass) {
      classCount[faultClass] = (classCount[faultClass] || 0) + 1;
    }

    // Track affected resources from details if available
    const affects = fault.details?.affects || fault.affects;
    if (affects && !summary.affectedResources.includes(affects)) {
      summary.affectedResources.push(affects);
    }
  }

  summary.severityLevels = Object.keys(severityCount);
  summary.faultClasses = Object.keys(classCount);
  summary.severityBreakdown = severityCount;
  summary.classBreakdown = classCount;

  return summary;
};

/**
 * Helper to save current fault with details
 * @param {Array} faults - Faults array
 * @param {Object} currentFault - Current fault being processed
 * @param {boolean} collectingDetails - Whether collecting details
 * @param {Array} detailLines - Detail lines collected
 */
export const saveFaultWithDetails = (faults, currentFault, collectingDetails, detailLines) => {
  if (!currentFault) {
    return;
  }

  if (collectingDetails && detailLines.length > 0) {
    const detailedInfo = parseDetailedFault(detailLines.join('\n'));
    if (detailedInfo) {
      currentFault.details = {
        host: detailedInfo.host,
        platform: detailedInfo.platform,
        faultClass: detailedInfo.faultClass,
        affects: detailedInfo.affects,
        problemIn: detailedInfo.problemIn,
        description: detailedInfo.description,
        response: detailedInfo.response,
        impact: detailedInfo.impact,
        action: detailedInfo.action,
      };
    }
  }
  faults.push(currentFault);
};

/**
 * Helper to check if line should skip processing
 * @param {string} line - Line to check
 * @returns {boolean} True if should skip
 */
export const shouldSkipLine = line => {
  if (line.match(/^-{15,}/)) {
    return true;
  }
  if (
    line.includes('TIME') &&
    line.includes('EVENT-ID') &&
    line.includes('MSG-ID') &&
    line.includes('SEVERITY')
  ) {
    return true;
  }
  return false;
};

/**
 * Helper to check if line starts detail collection
 * @param {string} line - Line to check
 * @returns {boolean} True if starts detail collection
 */
export const startsDetailCollection = line => {
  if (line.includes('Host') && line.includes(':')) {
    return true;
  }
  return (
    line.match(/^[A-Z][^:]*\s*:/) &&
    (line.includes('Platform') ||
      line.includes('Fault class') ||
      line.includes('Affects') ||
      line.includes('Description') ||
      line.includes('Response') ||
      line.includes('Impact') ||
      line.includes('Action'))
  );
};

/**
 * Helper function to parse fmadm faulty output
 * @param {string} output - Raw fmadm output
 * @returns {Array} Parsed fault objects
 */
export const parseFaultOutput = output => {
  const faults = [];

  if (!output || !output.trim()) {
    return faults;
  }

  const lines = output.trim().split('\n');
  let currentFault = null;
  let collectingDetails = false;
  let detailLines = [];

  for (const line of lines) {
    if (shouldSkipLine(line)) {
      continue;
    }

    if (!line.trim()) {
      if (collectingDetails) {
        detailLines.push(line);
      }
      continue;
    }

    const possibleFault = parseFaultLine(line);
    if (possibleFault) {
      saveFaultWithDetails(faults, currentFault, collectingDetails, detailLines);
      currentFault = possibleFault;
      collectingDetails = false;
      detailLines = [];
      continue;
    }

    if (startsDetailCollection(line)) {
      collectingDetails = true;
      detailLines = [line];
      continue;
    }

    if (collectingDetails) {
      detailLines.push(line);
    }
  }

  saveFaultWithDetails(faults, currentFault, collectingDetails, detailLines);
  return faults;
};
