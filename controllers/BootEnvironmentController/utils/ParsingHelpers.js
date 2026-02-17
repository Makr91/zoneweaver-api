/**
 * @fileoverview Boot environment data parsing helpers
 */

/**
 * Parse beadm list output into structured format
 * @param {string} output - Raw beadm list output
 * @returns {Array} Array of boot environment objects
 */
export const parseBeadmListOutput = output => {
  const lines = output.split('\n').filter(line => line.trim());
  const bootEnvironments = [];

  // Skip header line if present
  let startIndex = 0;
  if (lines[0] && (lines[0].startsWith('BE') || lines[0].includes('Active'))) {
    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      // Format: BE Active Mountpoint Space Policy Created
      const parts = line.split(/\s+/);
      if (parts.length >= 4) {
        const be = {
          name: parts[0],
          active: parts[1] || '-',
          mountpoint: parts[2] || '-',
          space: parts[3] || '-',
          policy: parts[4] || '-',
          created: parts[5] ? `${parts[5]} ${parts[6] || ''}`.trim() : '-',
          is_active_now: parts[1].includes('N'),
          is_active_on_reboot: parts[1].includes('R'),
          is_temporary: parts[1].includes('T'),
        };
        bootEnvironments.push(be);
      }
    }
  }

  return bootEnvironments;
};

/**
 * Parse beadm list -d output into structured format with datasets
 * @param {string} output - Raw beadm list -d output
 * @returns {Array} Array of boot environment objects with datasets
 */
export const parseBeadmDetailedOutput = output => {
  const lines = output.split('\n').filter(line => line.trim());
  const bootEnvironments = [];
  let currentBE = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    // Skip header
    if (trimmed.startsWith('BE/Dataset') || trimmed.startsWith('--')) {
      continue;
    }

    // Check if this is a new BE (no leading spaces and only one part - the BE name)
    if (!line.startsWith(' ') && !line.startsWith('\t')) {
      // This is a BE name line (format: just the BE name on its own line)
      const parts = trimmed.split(/\s+/);
      if (parts.length === 1) {
        // Create new BE with name only, metadata will come from first dataset
        currentBE = {
          name: parts[0],
          active: '-',
          mountpoint: '-',
          space: '-',
          policy: '-',
          created: '-',
          datasets: [],
          is_active_now: false,
          is_active_on_reboot: false,
          is_temporary: false,
        };
        bootEnvironments.push(currentBE);
      }
    } else if (currentBE && (line.startsWith('   ') || line.startsWith('\t'))) {
      // This is a dataset line - contains the actual metadata
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 4) {
        const datasetInfo = {
          dataset: parts[0],
          active: parts[1] || '-',
          mountpoint: parts[2] || '-',
          space: parts[3] || '-',
          policy: parts[4] || '-',
          created: parts[5] ? `${parts[5]} ${parts[6] || ''}`.trim() : '-',
        };

        currentBE.datasets.push(datasetInfo);

        // Use the first dataset's metadata for the BE's main properties
        if (currentBE.datasets.length === 1) {
          currentBE.active = datasetInfo.active;
          currentBE.mountpoint = datasetInfo.mountpoint;
          currentBE.space = datasetInfo.space;
          currentBE.policy = datasetInfo.policy;
          currentBE.created = datasetInfo.created;
          currentBE.is_active_now = datasetInfo.active.includes('N');
          currentBE.is_active_on_reboot = datasetInfo.active.includes('R');
          currentBE.is_temporary = datasetInfo.active.includes('T');
        }
      }
    }
  }

  return bootEnvironments;
};
