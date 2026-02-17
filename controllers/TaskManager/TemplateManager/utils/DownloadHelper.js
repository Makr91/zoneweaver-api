import fs from 'fs';
import { updateTaskProgress } from './ProgressHelper.js';

/**
 * @fileoverview Template file download utilities
 */

/**
 * Helper to download template file
 * @param {Object} client - Axios client
 * @param {string} downloadPath - API path
 * @param {string} tempBoxPath - Local temp path
 * @param {Object} task - Task object
 * @param {Object} templateConfig - Template configuration
 * @returns {Promise<number>} Downloaded bytes
 */
export const downloadTemplateFile = async (
  client,
  downloadPath,
  tempBoxPath,
  task,
  templateConfig
) => {
  const downloadTimeout = (templateConfig.download?.timeout_seconds || 3600) * 1000;

  const response = await client.get(downloadPath, {
    responseType: 'stream',
    timeout: downloadTimeout,
  });

  const contentLength = response.headers['content-length'];
  const fileSize = contentLength ? parseInt(contentLength) : null;
  let downloadedBytes = 0;
  let lastProgressUpdate = 0;
  const startTime = Date.now();

  const fileStream = fs.createWriteStream(tempBoxPath);

  response.data.on('data', chunk => {
    downloadedBytes += chunk.length;

    const progressInterval = (templateConfig.download?.progress_update_seconds || 10) * 1000;
    const now = Date.now();
    if (fileSize && now - lastProgressUpdate > progressInterval) {
      lastProgressUpdate = now;
      const progress = 10 + (downloadedBytes / fileSize) * 40; // 10-50% range
      const speedMbps = downloadedBytes / 1024 / 1024 / ((now - startTime) / 1000);

      setImmediate(() => {
        updateTaskProgress(task, Math.round(progress), {
          status: 'downloading',
          downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
          total_mb: Math.round(fileSize / 1024 / 1024),
          speed_mbps: Math.round(speedMbps * 100) / 100,
        });
      });
    }
  });

  response.data.pipe(fileStream);

  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    response.data.on('error', reject);
  });

  return downloadedBytes;
};
