import yj from 'yieldable-json';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import config from '../../config/ConfigLoader.js';
import ArtifactStorageLocation from '../../models/ArtifactStorageLocationModel.js';
import Artifact from '../../models/ArtifactModel.js';
import Tasks from '../../models/TaskModel.js';
import { Op } from 'sequelize';
import { listDirectory, getMimeType } from '../../lib/FileSystemManager.js';

/**
 * Artifact Manager for Artifact Operations
 * Handles artifact downloads, scans, file operations, and upload processing
 */

/**
 * Process a single download task for race condition protection
 * @param {Object} downloadTask - Download task object
 * @param {Object} location - Storage location object
 * @returns {Promise<string|null>} Target path if task matches location, null otherwise
 */
const processDownloadTask = async (downloadTask, location) => {
  log.artifact.debug('Race condition protection: processing download task', {
    task_id: downloadTask.id,
    operation: downloadTask.operation,
    metadata_length: downloadTask.metadata?.length,
  });

  try {
    const downloadMetadata = await new Promise((resolve, reject) => {
      yj.parseAsync(downloadTask.metadata, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { storage_location_id, filename, url } = downloadMetadata;

    log.artifact.debug('Race condition protection: parsed download metadata', {
      task_id: downloadTask.id,
      download_storage_location_id: storage_location_id,
      scan_location_id: location.id,
      storage_location_match: storage_location_id === location.id,
      filename,
      url: url?.substring(0, 100),
    });

    if (storage_location_id === location.id) {
      let finalFilename = filename;
      if (!finalFilename) {
        const urlPath = new URL(url).pathname;
        finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
      }
      const targetPath = path.join(location.path, finalFilename);

      log.artifact.debug('Race condition protection: added downloading path', {
        task_id: downloadTask.id,
        final_filename: finalFilename,
        target_path: targetPath,
      });

      return targetPath;
    }

    return null;
  } catch (parseError) {
    log.artifact.error('Race condition protection: failed to parse download task metadata', {
      task_id: downloadTask.id,
      error: parseError.message,
      metadata_preview: downloadTask.metadata?.substring(0, 200),
    });
    return null;
  }
};

/**
 * Get downloading paths to avoid race conditions during scanning
 * @param {Object} location - Storage location object
 * @returns {Promise<Set>} Set of paths currently being downloaded
 */
const getDownloadingPaths = async location => {
  const runningDownloadTasks = Array.from(global.runningTasks?.values() || []).filter(
    task => task.operation === 'artifact_download_url'
  );

  log.artifact.debug('Race condition protection: checking running tasks', {
    running_download_tasks: runningDownloadTasks.length,
    location_id: location.id,
    location_path: location.path,
    running_task_ids: runningDownloadTasks.map(t => t.id),
  });

  // Process all download tasks in parallel
  const pathPromises = runningDownloadTasks.map(downloadTask =>
    processDownloadTask(downloadTask, location)
  );
  const targetPaths = await Promise.all(pathPromises);

  const downloadingPaths = new Set(targetPaths.filter(targetPath => targetPath !== null));

  if (downloadingPaths.size > 0) {
    log.artifact.info('Race condition protection: found active downloads to skip during scan', {
      active_downloads: downloadingPaths.size,
      downloading_paths: Array.from(downloadingPaths),
      location_name: location.name,
    });
  } else {
    log.artifact.debug('Race condition protection: no active downloads found for this location', {
      location_name: location.name,
      total_running_downloads: runningDownloadTasks.length,
    });
  }

  return downloadingPaths;
};

/**
 * Process artifact files and update database records
 * @param {Object} location - Storage location object
 * @param {Array} artifactFiles - Array of artifact files
 * @param {Set} downloadingPaths - Set of paths being downloaded
 * @param {Set} existingPaths - Set of existing database paths
 * @returns {Promise<{scanned: number, added: number, skipped: number}>}
 */
const processArtifactFiles = async (location, artifactFiles, downloadingPaths, existingPaths) => {
  const filesToCreate = [];
  const pathsToUpdate = [];
  let skipped = 0;

  // First pass: categorize files (no await needed)
  for (const file of artifactFiles) {
    log.artifact.debug('Race condition protection: checking file against downloading paths', {
      file_path: file.path,
      downloading_paths_count: downloadingPaths.size,
      should_skip: downloadingPaths.has(file.path),
      downloading_paths: Array.from(downloadingPaths),
      file_exists_in_db: existingPaths.has(file.path),
    });

    if (downloadingPaths.has(file.path)) {
      log.artifact.info('Race condition protection: skipping file being downloaded', {
        filename: file.name,
        path: file.path,
        location_name: location.name,
      });
      skipped++;
      continue;
    }

    if (!existingPaths.has(file.path)) {
      const extension = path.extname(file.name).toLowerCase();
      const mimeType = getMimeType(file.path);

      log.artifact.debug('Race condition protection: creating new artifact record', {
        filename: file.name,
        path: file.path,
        size: file.size,
        extension,
        location_name: location.name,
      });

      filesToCreate.push({
        storage_location_id: location.id,
        filename: file.name,
        path: file.path,
        size: file.size || 0,
        file_type: location.type,
        extension,
        mime_type: mimeType,
        checksum: null,
        checksum_algorithm: null,
        source_url: null,
        discovered_at: new Date(),
        last_verified: new Date(),
      });
    } else {
      pathsToUpdate.push(file.path);
    }
  }

  // Second pass: Execute database operations in parallel
  const operations = [];

  if (filesToCreate.length > 0) {
    operations.push(Artifact.bulkCreate(filesToCreate));
  }

  if (pathsToUpdate.length > 0) {
    operations.push(
      Artifact.update(
        { last_verified: new Date() },
        { where: { path: { [Op.in]: pathsToUpdate } } }
      )
    );
  }

  // Execute all database operations in parallel
  await Promise.all(operations);

  const scanned = artifactFiles.length - skipped;
  const added = filesToCreate.length;

  if (added > 0) {
    log.artifact.debug('Bulk created new artifacts', {
      count: added,
      location_name: location.name,
    });
  }

  return { scanned, added, skipped };
};

/**
 * Remove orphaned artifacts from database
 * @param {Array} existingArtifacts - Array of existing artifacts
 * @param {Set} currentPaths - Set of current file paths
 * @returns {Promise<number>} Number of removed artifacts
 */
const removeOrphanedArtifacts = async (existingArtifacts, currentPaths) => {
  // Collect orphaned artifact IDs (no await needed)
  const orphanedIds = existingArtifacts
    .filter(artifact => !currentPaths.has(artifact.path))
    .map(artifact => {
      log.artifact.debug('Removed orphaned artifact', {
        filename: artifact.filename,
        path: artifact.path,
      });
      return artifact.id;
    });

  // Bulk delete all orphaned artifacts in single operation
  if (orphanedIds.length > 0) {
    await Artifact.destroy({
      where: { id: { [Op.in]: orphanedIds } },
    });
  }

  return orphanedIds.length;
};

/**
 * Update storage location statistics
 * @param {Object} location - Storage location object
 * @returns {Promise<{totalFiles: number, totalSize: number}>}
 */
const updateStorageLocationStats = async location => {
  const totalFiles = await Artifact.count({
    where: { storage_location_id: location.id },
  });

  const totalSize =
    (await Artifact.sum('size', {
      where: { storage_location_id: location.id },
    })) || 0;

  await location.update({
    file_count: totalFiles,
    total_size: totalSize,
  });

  return { totalFiles, totalSize };
};

/**
 * Scan a storage location for artifacts
 * @param {Object} location - Storage location object
 * @param {Object} options - Scan options
 * @returns {Promise<{scanned: number, added: number, removed: number}>}
 */
export const scanStorageLocation = async (location, options = {}) => {
  const { verify_checksums = false, remove_orphaned = false } = options;

  log.artifact.debug('Scanning storage location', {
    location_id: location.id,
    location_name: location.name,
    location_path: location.path,
    verify_checksums,
    remove_orphaned,
  });

  try {
    const artifactConfig = config.getArtifactStorage();
    const supportedExtensions =
      artifactConfig?.scanning?.supported_extensions?.[location.type] || [];

    const downloadingPaths = await getDownloadingPaths(location);

    const items = await listDirectory(location.path);
    const files = items.filter(item => !item.isDirectory);
    const artifactFiles = files.filter(file =>
      supportedExtensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))
    );

    log.artifact.debug('Found potential artifacts', {
      total_files: files.length,
      artifact_files: artifactFiles.length,
      supported_extensions: supportedExtensions,
    });

    const existingArtifacts = await Artifact.findAll({
      where: { storage_location_id: location.id },
    });

    const existingPaths = new Set(existingArtifacts.map(a => a.path));
    const currentPaths = new Set(artifactFiles.map(f => f.path));

    const { scanned, added, skipped } = await processArtifactFiles(
      location,
      artifactFiles,
      downloadingPaths,
      existingPaths
    );

    const removed = remove_orphaned
      ? await removeOrphanedArtifacts(existingArtifacts, currentPaths)
      : 0;

    const { totalFiles } = await updateStorageLocationStats(location);

    log.artifact.info('Storage location scan completed', {
      location_name: location.name,
      scanned,
      added,
      removed,
      skipped,
      total_files: totalFiles,
    });

    return { scanned, added, removed };
  } catch (error) {
    log.artifact.error('Storage location scan failed', {
      location_id: location.id,
      location_name: location.name,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
};

/**
 * Setup download file and permissions
 * @param {string} final_path - Final file path
 * @returns {Promise<void>}
 */
const setupDownloadFile = async final_path => {
  log.task.debug('Pre-creating download file with pfexec', { final_path });

  const createResult = await executeCommand(`pfexec touch "${final_path}"`);
  if (!createResult.success) {
    throw new Error(`Failed to pre-create file: ${createResult.error}`);
  }

  const chmodResult = await executeCommand(`pfexec chmod 666 "${final_path}"`);
  if (!chmodResult.success) {
    throw new Error(`Failed to set file permissions: ${chmodResult.error}`);
  }

  log.task.debug('File pre-created successfully with proper permissions');
};

/**
 * Perform the actual download with progress tracking
 * @param {string} url - Download URL
 * @param {string} final_path - Final file path
 * @param {number} downloadTimeout - Download timeout in ms
 * @returns {Promise<{downloadedBytes: number, downloadTime: number}>}
 */
const performDownload = async (url, final_path, downloadTimeout) => {
  const response = await axios({
    method: 'get',
    url,
    responseType: 'stream',
    timeout: downloadTimeout,
  });

  const contentLength = response.headers['content-length'];
  const fileSize = contentLength ? parseInt(contentLength) : null;

  log.task.info('Download response received', {
    status: response.status,
    content_length: fileSize ? `${Math.round(fileSize / 1024 / 1024)}MB` : 'unknown',
    content_type: response.headers['content-type'],
  });

  const fileStream = fs.createWriteStream(final_path);
  const startTime = Date.now();
  let downloadedBytes = 0;
  let lastProgressUpdate = 0;

  const artifactConfig = config.getArtifactStorage();

  response.data.on('data', chunk => {
    downloadedBytes += chunk.length;

    const progressUpdateInterval = (artifactConfig.download?.progress_update_seconds || 10) * 1000;
    const now = Date.now();
    if (fileSize && now - lastProgressUpdate > progressUpdateInterval) {
      lastProgressUpdate = now;

      setImmediate(async () => {
        try {
          const progress = (downloadedBytes / fileSize) * 100;
          const speedMbps = downloadedBytes / 1024 / 1024 / ((now - startTime) / 1000);
          const remainingBytes = fileSize - downloadedBytes;
          const etaSeconds = remainingBytes / (downloadedBytes / ((now - startTime) / 1000));

          const taskToUpdate = await Tasks.findOne({
            where: {
              operation: 'artifact_download_url',
              status: 'running',
              metadata: { [Op.like]: `%${url.substring(0, 50)}%` },
            },
          });

          if (taskToUpdate) {
            await taskToUpdate.update({
              progress_percent: Math.round(progress * 100) / 100,
              progress_info: {
                downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
                total_mb: Math.round(fileSize / 1024 / 1024),
                speed_mbps: Math.round(speedMbps * 100) / 100,
                eta_seconds: isFinite(etaSeconds) ? Math.round(etaSeconds) : null,
                status: 'downloading',
              },
            });
          }
        } catch (progressError) {
          log.task.debug('Progress update failed', { error: progressError.message });
        }
      });
    }
  });

  response.data.pipe(fileStream);

  await new Promise((resolve, reject) => {
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
    response.data.on('error', reject);
  });

  const downloadTime = Date.now() - startTime;

  log.task.info('Download completed - starting post-processing', {
    url,
    downloaded_bytes: downloadedBytes,
    downloaded_mb: Math.round(downloadedBytes / 1024 / 1024),
    duration_ms: downloadTime,
    speed_mbps: Math.round((downloadedBytes / 1024 / 1024 / (downloadTime / 1000)) * 100) / 100,
  });

  return { downloadedBytes, downloadTime };
};

/**
 * Calculate and verify checksum
 * @param {string} final_path - Final file path
 * @param {string} checksum_algorithm - Checksum algorithm
 * @param {string} expectedChecksum - Expected checksum (optional)
 * @returns {Promise<{calculatedChecksum: string, checksumVerified: boolean|null}>}
 */
const calculateAndVerifyChecksum = async (final_path, checksum_algorithm, expectedChecksum) => {
  log.task.debug('Calculating checksum post-download');

  const hash = crypto.createHash(checksum_algorithm);
  const readStream = fs.createReadStream(final_path);

  await new Promise((resolve, reject) => {
    readStream.on('data', chunk => hash.update(chunk));
    readStream.on('end', resolve);
    readStream.on('error', reject);
  });

  const calculatedChecksum = hash.digest('hex');
  let checksumVerified = null;

  if (expectedChecksum) {
    checksumVerified = calculatedChecksum === expectedChecksum;

    if (!checksumVerified) {
      await executeCommand(`pfexec rm -f "${final_path}"`);
      throw new Error(
        `Checksum verification failed. Expected: ${expectedChecksum}, Got: ${calculatedChecksum}`
      );
    }
    log.task.info('Checksum verification passed');
  }

  return { calculatedChecksum, checksumVerified };
};

/**
 * Create artifact database record
 * @param {Object} params - Parameters object
 * @returns {Promise<void>}
 */
const createArtifactRecord = async params => {
  const {
    storageLocation,
    finalFilename,
    final_path,
    downloadedBytes,
    calculatedChecksum,
    checksum_algorithm,
    checksumVerified,
    url,
  } = params;

  const extension = path.extname(finalFilename).toLowerCase();
  const mimeType = getMimeType(final_path);

  if (!extension) {
    throw new Error(`File has no extension - cannot determine artifact type: ${finalFilename}`);
  }

  try {
    const [artifact, created] = await Artifact.findOrCreate({
      where: { path: final_path },
      defaults: {
        storage_location_id: storageLocation.id,
        filename: finalFilename,
        path: final_path,
        size: downloadedBytes,
        file_type: storageLocation.type,
        extension,
        mime_type: mimeType,
        checksum: calculatedChecksum,
        checksum_algorithm,
        checksum_verified: checksumVerified,
        source_url: url,
        discovered_at: new Date(),
        last_verified: new Date(),
      },
    });

    if (!created) {
      log.task.info('Artifact record already exists, updating with download data', {
        filename: finalFilename,
        existing_source: artifact.source_url || 'scan',
        new_source: url,
        checksum_verified: checksumVerified,
      });

      await artifact.update({
        filename: finalFilename,
        size: downloadedBytes,
        checksum: calculatedChecksum,
        checksum_algorithm,
        checksum_verified: checksumVerified,
        source_url: url,
        last_verified: new Date(),
      });
    } else {
      log.task.debug('Created new artifact database record', {
        filename: finalFilename,
        path: final_path,
        checksum_verified: checksumVerified,
      });
    }
  } catch (dbError) {
    log.task.error('Failed to create/update artifact database record', {
      storage_location_id: storageLocation.id,
      filename: finalFilename,
      path: final_path,
      size: downloadedBytes,
      file_type: storageLocation.type,
      extension,
      mime_type: mimeType,
      error: dbError.message,
      validation_errors: dbError.errors || null,
    });

    await executeCommand(`pfexec rm -f "${final_path}"`);
    throw new Error(`Download completed but failed to create database record: ${dbError.message}`);
  }
};

/**
 * Execute artifact download from URL task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactDownloadTask = async metadataJson => {
  log.task.debug('Artifact download task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      url,
      storage_location_id,
      filename,
      checksum,
      checksum_algorithm = 'sha256',
      overwrite_existing = false,
    } = metadata;

    log.task.debug('Artifact download task parameters', {
      url,
      storage_location_id,
      filename,
      has_checksum: !!checksum,
      checksum_algorithm,
      overwrite_existing,
    });

    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);

    if (!storageLocation || !storageLocation.enabled) {
      return {
        success: false,
        error: `Storage location not found or disabled: ${storage_location_id}`,
      };
    }

    let finalFilename = filename;
    if (!finalFilename) {
      const urlPath = new URL(url).pathname;
      finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
    }

    const final_path = path.join(storageLocation.path, finalFilename);

    if (!overwrite_existing && fs.existsSync(final_path)) {
      return {
        success: false,
        error: `File already exists: ${finalFilename}. Use overwrite_existing=true to replace.`,
      };
    }

    log.task.info('Starting download', {
      url,
      destination: final_path,
      storage_location: storageLocation.name,
    });

    await setupDownloadFile(final_path);

    const artifactConfig = config.getArtifactStorage();
    const downloadTimeout = (artifactConfig.download?.timeout_seconds || 60) * 1000;

    const { downloadedBytes, downloadTime } = await performDownload(
      url,
      final_path,
      downloadTimeout
    );

    const { calculatedChecksum, checksumVerified } = await calculateAndVerifyChecksum(
      final_path,
      checksum_algorithm,
      checksum
    );

    await createArtifactRecord({
      storageLocation,
      finalFilename,
      final_path,
      downloadedBytes,
      calculatedChecksum,
      checksum_algorithm,
      checksumVerified,
      url,
    });

    await storageLocation.increment('file_count', { by: 1 });
    await storageLocation.increment('total_size', { by: downloadedBytes });
    await storageLocation.update({ last_scan_at: new Date() });

    return {
      success: true,
      message: `Successfully downloaded ${finalFilename} (${Math.round(downloadedBytes / 1024 / 1024)}MB)${checksumVerified ? ' with verified checksum' : ''}`,
      downloaded_bytes: downloadedBytes,
      checksum_verified: checksumVerified,
      checksum: calculatedChecksum,
      final_path,
      duration_ms: downloadTime,
    };
  } catch (error) {
    log.task.error('Artifact download task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Download failed: ${error.message}` };
  }
};

/**
 * Execute scan all artifact locations task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactScanAllTask = async metadataJson => {
  log.task.debug('Artifact scan all task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { verify_checksums = false, remove_orphaned = false, source = 'manual' } = metadata;

    log.task.debug('Scan all task parameters', {
      verify_checksums,
      remove_orphaned,
      source,
    });

    // Get all enabled storage locations
    const locations = await ArtifactStorageLocation.findAll({
      where: { enabled: true },
    });

    let totalScanned = 0;
    let totalAdded = 0;
    let totalRemoved = 0;
    const errors = [];

    // Process all locations in parallel for better performance
    const scanPromises = locations.map(async location => {
      try {
        const scanResult = await scanStorageLocation(location, {
          verify_checksums,
          remove_orphaned,
        });

        // Update location stats
        await location.update({
          last_scan_at: new Date(),
          scan_errors: 0,
          last_error_message: null,
        });

        return { success: true, scanResult, location };
      } catch (locationError) {
        const errorMsg = `Failed to scan ${location.name}: ${locationError.message}`;

        await location.update({
          scan_errors: location.scan_errors + 1,
          last_error_message: locationError.message,
        });

        log.task.warn('Storage location scan failed', {
          location_id: location.id,
          location_name: location.name,
          error: locationError.message,
        });

        return { success: false, error: errorMsg, location };
      }
    });

    const scanResults = await Promise.all(scanPromises);

    // Aggregate results
    for (const result of scanResults) {
      if (result.success) {
        totalScanned += result.scanResult.scanned;
        totalAdded += result.scanResult.added;
        totalRemoved += result.scanResult.removed;
      } else {
        errors.push(result.error);
      }
    }

    if (errors.length > 0 && errors.length === locations.length) {
      // All locations failed
      return {
        success: false,
        error: `All ${locations.length} storage locations failed to scan`,
        errors,
      };
    }

    const successCount = locations.length - errors.length;
    let message = `Scan completed: ${totalScanned} files scanned, ${totalAdded} added, ${totalRemoved} removed across ${successCount}/${locations.length} locations`;

    if (errors.length > 0) {
      message += ` (${errors.length} locations had errors)`;
    }

    log.task.info('Artifact scan all completed', {
      locations_scanned: successCount,
      locations_failed: errors.length,
      total_scanned: totalScanned,
      total_added: totalAdded,
      total_removed: totalRemoved,
      source,
    });

    return {
      success: true,
      message,
      stats: {
        locations_scanned: successCount,
        locations_failed: errors.length,
        files_scanned: totalScanned,
        files_added: totalAdded,
        files_removed: totalRemoved,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    log.task.error('Artifact scan all task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Scan all task failed: ${error.message}` };
  }
};

/**
 * Execute scan specific location task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactScanLocationTask = async metadataJson => {
  log.task.debug('Artifact scan location task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { storage_location_id, verify_checksums = false, remove_orphaned = false } = metadata;

    log.task.debug('Scan location task parameters', {
      storage_location_id,
      verify_checksums,
      remove_orphaned,
    });

    const location = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!location) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    const scanResult = await scanStorageLocation(location, {
      verify_checksums,
      remove_orphaned,
    });

    // Update location stats and status
    await location.update({
      last_scan_at: new Date(),
      scan_errors: 0,
      last_error_message: null,
    });

    log.task.info('Storage location scan completed', {
      location_id: location.id,
      location_name: location.name,
      files_scanned: scanResult.scanned,
      files_added: scanResult.added,
      files_removed: scanResult.removed,
    });

    return {
      success: true,
      message: `Scan completed for ${location.name}: ${scanResult.scanned} files scanned, ${scanResult.added} added, ${scanResult.removed} removed`,
      stats: scanResult,
      location: {
        id: location.id,
        name: location.name,
        path: location.path,
      },
    };
  } catch (error) {
    log.task.error('Artifact scan location task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Scan location task failed: ${error.message}` };
  }
};

/**
 * Process artifact deletion results and generate summary
 * @param {Array} artifacts - Original artifacts array
 * @param {Array} fileResults - File deletion results
 * @param {Array} artifactIds - Artifact IDs array
 * @returns {Object} Processing summary
 */
const processArtifactDeletionResults = (artifacts, fileResults, artifactIds) => {
  const errors = [];
  let filesDeleted = 0;

  if (fileResults.length > 0) {
    filesDeleted = fileResults.filter(r => r.success).length;
    fileResults
      .filter(r => !r.success)
      .forEach(r => {
        errors.push(r.error);
      });
  }

  const recordsRemoved = artifactIds.length;
  const successCount = artifacts.length - errors.length;

  return { errors, filesDeleted, recordsRemoved, successCount };
};

/**
 * Execute artifact file deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactDeleteFileTask = async metadataJson => {
  log.task.debug('Artifact delete file task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const { artifact_ids, delete_files = true, force = false } = metadata;

    log.task.debug('Delete file task parameters', {
      artifact_count: artifact_ids.length,
      delete_files,
      force,
    });

    const artifacts = await Artifact.findAll({
      where: { id: artifact_ids },
      include: [
        {
          model: ArtifactStorageLocation,
          as: 'storage_location',
        },
      ],
    });

    if (artifacts.length === 0) {
      return {
        success: false,
        error: 'No artifacts found for the provided IDs',
      };
    }

    // Prepare parallel operations
    const fileDeletePromises = [];
    const artifactIds = [];
    const storageLocationUpdates = new Map();

    // First pass: prepare operations (no await)
    for (const artifact of artifacts) {
      // Prepare file deletion if requested
      if (delete_files && fs.existsSync(artifact.path)) {
        const command = force ? `pfexec rm -f "${artifact.path}"` : `pfexec rm "${artifact.path}"`;

        fileDeletePromises.push(
          executeCommand(command)
            .then(result => {
              if (result.success) {
                log.task.debug('Deleted artifact file', {
                  filename: artifact.filename,
                  path: artifact.path,
                });
                return { success: true, filename: artifact.filename };
              }
              throw new Error(`Failed to delete ${artifact.filename}: ${result.error}`);
            })
            .catch(error => {
              log.task.warn('Artifact file deletion failed', {
                artifact_id: artifact.id,
                filename: artifact.filename,
                error: error.message,
              });
              return { success: false, filename: artifact.filename, error: error.message };
            })
        );
      } else if (delete_files) {
        log.task.warn('Artifact file not found on disk', {
          filename: artifact.filename,
          path: artifact.path,
        });
      }

      // Collect artifact IDs for bulk database deletion
      artifactIds.push(artifact.id);

      // Aggregate storage location updates
      if (artifact.storage_location) {
        const locationId = artifact.storage_location.id;
        if (!storageLocationUpdates.has(locationId)) {
          storageLocationUpdates.set(locationId, {
            location: artifact.storage_location,
            file_count: 0,
            total_size: 0,
          });
        }
        const update = storageLocationUpdates.get(locationId);
        update.file_count += 1;
        update.total_size += artifact.size;
      }
    }

    // Second pass: Execute all operations in parallel
    const operations = [];

    // Add file deletion promises
    if (fileDeletePromises.length > 0) {
      operations.push(Promise.all(fileDeletePromises));
    }

    // Add bulk database deletion
    if (artifactIds.length > 0) {
      operations.push(
        Artifact.destroy({
          where: { id: { [Op.in]: artifactIds } },
        })
      );
    }

    // Add storage location updates
    const locationUpdatePromises = Array.from(storageLocationUpdates.values()).map(async update => {
      await update.location.decrement('file_count', { by: update.file_count });
      await update.location.decrement('total_size', { by: update.total_size });
    });
    if (locationUpdatePromises.length > 0) {
      operations.push(Promise.all(locationUpdatePromises));
    }

    // Execute all operations in parallel
    const results = await Promise.all(operations);

    // Process results using helper function
    const fileResults = fileDeletePromises.length > 0 ? results[0] || [] : [];
    const { errors, filesDeleted, recordsRemoved, successCount } = processArtifactDeletionResults(
      artifacts,
      fileResults,
      artifactIds
    );

    if (errors.length > 0 && errors.length === artifacts.length) {
      return {
        success: false,
        error: `Failed to delete all ${artifacts.length} artifacts`,
        errors,
      };
    }

    let message = `Successfully deleted ${successCount}/${artifacts.length} artifacts`;

    if (delete_files) {
      message += ` (${filesDeleted} files removed from disk)`;
    }

    if (errors.length > 0) {
      message += ` (${errors.length} had errors)`;
    }

    log.task.info('Artifact deletion completed', {
      total_artifacts: artifacts.length,
      successful_deletions: successCount,
      files_deleted: filesDeleted,
      records_removed: recordsRemoved,
      errors_count: errors.length,
    });

    return {
      success: true,
      message,
      stats: {
        total_artifacts: artifacts.length,
        successful_deletions: successCount,
        files_deleted: filesDeleted,
        records_removed: recordsRemoved,
      },
      errors: errors.length > 0 ? errors : undefined,
    };
  } catch (error) {
    log.task.error('Artifact delete file task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Delete file task failed: ${error.message}` };
  }
};

/**
 * Execute artifact folder deletion task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactDeleteFolderTask = async metadataJson => {
  log.task.debug('Artifact delete folder task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      storage_location_id,
      recursive = true,
      remove_db_records = true,
      force = false,
    } = metadata;

    log.task.debug('Delete folder task parameters', {
      storage_location_id,
      recursive,
      remove_db_records,
      force,
    });

    const location = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!location) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    log.task.info('Starting folder deletion', {
      location_name: location.name,
      location_path: location.path,
      recursive,
      remove_db_records,
    });

    let removedRecords = 0;

    // Remove database records first if requested
    if (remove_db_records) {
      const artifacts = await Artifact.findAll({
        where: { storage_location_id: location.id },
      });

      removedRecords = artifacts.length;
      if (removedRecords > 0) {
        await Artifact.destroy({
          where: { storage_location_id: location.id },
        });
        log.task.info('Removed artifact database records', {
          count: removedRecords,
        });
      }
    }

    // Delete physical folder and contents
    let command = `pfexec rm`;

    if (recursive && force) {
      command += ` -rf`;
    } else if (recursive) {
      command += ` -r`;
    } else if (force) {
      command += ` -f`;
    }

    command += ` "${location.path}"/*`; // Delete contents, not the folder itself

    const result = await executeCommand(command);

    if (result.success || (force && result.error.includes('No such file'))) {
      // Count as success even if no files were found (empty directory)
      log.task.info('Folder contents deleted successfully');

      // Reset location stats
      await location.update({
        file_count: 0,
        total_size: 0,
        last_scan_at: new Date(),
        scan_errors: 0,
        last_error_message: null,
      });

      return {
        success: true,
        message: `Successfully deleted folder contents for ${location.name}${remove_db_records ? ` (${removedRecords} database records removed)` : ''}`,
        location: {
          name: location.name,
          path: location.path,
        },
        stats: {
          removed_records: removedRecords,
          folder_cleared: true,
        },
      };
    }

    return {
      success: false,
      error: `Failed to delete folder contents: ${result.error}`,
    };
  } catch (error) {
    log.task.error('Artifact delete folder task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Delete folder task failed: ${error.message}` };
  }
};

/**
 * Execute artifact upload processing task
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeArtifactUploadProcessTask = async metadataJson => {
  log.task.debug('Artifact upload process task starting');

  try {
    const metadata = await new Promise((resolve, reject) => {
      yj.parseAsync(metadataJson, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });

    const {
      final_path,
      original_name,
      size,
      storage_location_id,
      checksum,
      checksum_algorithm = 'sha256',
    } = metadata;

    if (!final_path) {
      log.task.error('No final_path provided in metadata', {
        metadata_keys: Object.keys(metadata),
      });
      return {
        success: false,
        error: 'No final_path provided in task metadata - cannot process upload',
      };
    }

    log.task.debug('Upload process task parameters', {
      final_path,
      original_name,
      size,
      storage_location_id,
      has_checksum: !!checksum,
    });

    // Get storage location
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);
    if (!storageLocation) {
      return {
        success: false,
        error: `Storage location not found: ${storage_location_id}`,
      };
    }

    // Calculate checksum with progress tracking
    log.task.debug('Calculating checksum');

    const taskToUpdate = await Tasks.findOne({
      where: {
        operation: 'artifact_upload_process',
        status: 'running',
        metadata: { [Op.like]: `%${original_name}%` },
      },
    });

    const hash = crypto.createHash(checksum_algorithm);
    const fileBuffer = await fs.promises.readFile(final_path);

    // Update progress for checksum calculation
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 50,
        progress_info: {
          status: 'calculating_checksum',
          file_size_mb: Math.round(size / 1024 / 1024),
        },
      });
    }

    hash.update(fileBuffer);
    const calculatedChecksum = hash.digest('hex');

    // Update progress after checksum
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 80,
        progress_info: {
          status: 'checksum_complete',
          checksum: `${calculatedChecksum.substring(0, 16)}...`,
        },
      });
    }

    log.task.debug('Checksum calculated', {
      algorithm: checksum_algorithm,
      checksum: `${calculatedChecksum.substring(0, 16)}...`,
    });

    // Determine checksum verification status
    let checksumVerified = null; // Default: no verification performed

    // Scenario 1: User provided checksum - verify and fail if mismatch
    if (checksum) {
      if (calculatedChecksum !== checksum) {
        return {
          success: false,
          error: `Checksum verification failed. Expected: ${checksum}, Got: ${calculatedChecksum}`,
        };
      }
      checksumVerified = true; // User checksum verified successfully
      log.task.info('Upload checksum verification passed');
    }

    // Scenario 2: Both scenarios - store the calculated checksum as the final value
    const extension = path.extname(original_name).toLowerCase();
    const mimeType = getMimeType(final_path);

    // Create artifact database record with checksum verification status
    await Artifact.create({
      storage_location_id: storageLocation.id,
      filename: original_name,
      path: final_path,
      size,
      file_type: storageLocation.type,
      extension,
      mime_type: mimeType,
      checksum: calculatedChecksum,
      checksum_algorithm,
      checksum_verified: checksumVerified,
      source_url: null,
      discovered_at: new Date(),
      last_verified: new Date(),
    });

    // Update storage location stats
    await storageLocation.increment('file_count', { by: 1 });
    await storageLocation.increment('total_size', { by: size });
    await storageLocation.update({ last_scan_at: new Date() });

    // Final progress update
    if (taskToUpdate) {
      await taskToUpdate.update({
        progress_percent: 100,
        progress_info: {
          status: 'completed',
          final_path,
          checksum_verified: !!checksum,
        },
      });
    }

    log.task.info('Artifact upload processing completed', {
      filename: original_name,
      size_mb: Math.round(size / 1024 / 1024),
      storage_location: storageLocation.name,
      checksum_verified: !!checksum,
    });

    return {
      success: true,
      message: `Successfully processed upload for ${original_name} (${Math.round(size / 1024 / 1024)}MB)${checksum ? ' with verified checksum' : ''}`,
      artifact: {
        filename: original_name,
        size,
        final_path,
        checksum_verified: !!checksum,
        checksum: calculatedChecksum,
      },
    };
  } catch (error) {
    // No cleanup needed - file is already in final location
    log.task.error('Artifact upload process task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Upload processing failed: ${error.message}` };
  }
};
