/**
 * @fileoverview Repository data parsing helpers
 */

/**
 * Parse pkg publisher output into structured format
 * @param {string} output - Raw pkg publisher output
 * @returns {Array} Array of publisher objects
 */
export const parsePublisherOutput = output => {
  const lines = output.split('\n').filter(line => line.trim());
  const publishers = [];

  // Skip header line if present
  let startIndex = 0;
  if (lines[0] && lines[0].startsWith('PUBLISHER')) {
    startIndex = 1;
  }

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line) {
      // Format: PUBLISHER TYPE STATUS P LOCATION
      // Use regex to properly handle whitespace and capture groups
      const match = line.match(
        /^(?<name>\S+)\s+(?<type>\S+(?:\s+\S+)*?)\s+(?<status>online|offline)\s+(?<proxy>[FT-])\s+(?<location>.+)$/i
      );

      if (match) {
        const { name, type, status, proxy, location } = match.groups;
        publishers.push({
          name,
          type,
          status,
          proxy,
          location,
        });
      } else {
        // Fallback to original parsing if regex doesn't match
        const parts = line.split(/\s+/);
        if (parts.length >= 5) {
          publishers.push({
            name: parts[0],
            type: parts[1],
            status: parts[2],
            proxy: parts[3],
            location: parts.slice(4).join(' '),
          });
        }
      }
    }
  }

  return publishers;
};

/**
 * Parse pkg publisher -F tsv output into structured format
 * @param {string} output - Raw pkg publisher -F tsv output
 * @returns {Array} Array of detailed publisher objects
 */
export const parsePublisherTsvOutput = output => {
  const lines = output.split('\n').filter(line => line.trim());
  const publishers = [];

  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length >= 5) {
      publishers.push({
        name: parts[0],
        sticky: parts[1] === 'true',
        syspub: parts[2] === 'true',
        enabled: parts[3] === 'true',
        type: parts[4],
        status: parts[5],
        location: parts[6],
        proxy: parts[7] || null,
      });
    }
  }

  return publishers;
};
