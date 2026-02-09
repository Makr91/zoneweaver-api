import crypto from 'crypto';
import fs from 'fs';
import { log } from './Logger.js';

/**
 * Calculate file checksum with non-blocking behavior
 * Yields to the event loop between chunks to keep the API responsive
 * @param {string} filePath - Path to file
 * @param {string} algorithm - Hash algorithm (default: sha256)
 * @param {number} chunkSize - Chunk size in bytes (default: 2MB)
 * @returns {Promise<string>} Hex digest of checksum
 */
export const calculateChecksum = (filePath, algorithm = 'sha256', chunkSize = 2 * 1024 * 1024) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });

    stream.on('data', chunk => {
      // Pause stream to process chunk
      stream.pause();

      // Update hash synchronously
      hash.update(chunk);

      // Yield to event loop before resuming
      // This prevents blocking the main thread on large files
      setImmediate(() => {
        stream.resume();
      });
    });

    stream.on('end', () => {
      const checksum = hash.digest('hex');
      log.task.debug('Checksum calculation completed', {
        file: filePath,
        algorithm,
        checksum: `${checksum.substring(0, 16)}...`,
      });
      resolve(checksum);
    });

    stream.on('error', err => {
      log.task.error('Checksum calculation failed', {
        file: filePath,
        error: err.message,
      });
      reject(err);
    });
  });

/**
 * Calculate checksum with progress callback
 * @param {string} filePath - Path to file
 * @param {string} algorithm - Hash algorithm
 * @param {Function} onProgress - Callback (bytesRead, totalBytes) => void
 * @returns {Promise<string>} Hex digest of checksum
 */
export const calculateChecksumWithProgress = (filePath, algorithm = 'sha256', onProgress = null) =>
  new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const stats = fs.statSync(filePath);
    const totalBytes = stats.size;
    let bytesRead = 0;

    const stream = fs.createReadStream(filePath, { highWaterMark: 2 * 1024 * 1024 });

    stream.on('data', chunk => {
      stream.pause();
      hash.update(chunk);
      bytesRead += chunk.length;

      if (onProgress) {
        onProgress(bytesRead, totalBytes);
      }

      setImmediate(() => stream.resume());
    });

    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
