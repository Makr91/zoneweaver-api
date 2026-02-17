import yj from 'yieldable-json';

/**
 * @fileoverview Metadata parsing utilities
 */

/**
 * Parse task metadata JSON asynchronously
 * @param {string} metadataJson - Raw metadata JSON string
 * @returns {Promise<Object>} Parsed metadata
 */
export const parseMetadata = metadataJson =>
  new Promise((resolve, reject) => {
    yj.parseAsync(metadataJson, (err, parsed) => (err ? reject(err) : resolve(parsed)));
  });
