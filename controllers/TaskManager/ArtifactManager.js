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
import {
  listDirectory,
  getMimeType,
} from '../../lib/FileSystemManager.js';

/**
 * Artifact Manager for Artifact Operations
 * Handles artifact downloads, scans, file operations, and upload processing
 */

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

    // Get storage location
    const storageLocation = await ArtifactStorageLocation.findByPk(storage_location_id);

    if (!storageLocation || !storageLocation.enabled) {
      return {
        success: false,
        error: `Storage location not found or disabled: ${storage_location_id}`,
      };
    }

    // Determine filename from URL if not provided
    let finalFilename = filename;
    if (!finalFilename) {
      const urlPath = new URL(url).pathname;
      finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
    }

    const final_path = path.join(storageLocation.path, finalFilename);

    // Check if file already exists
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

    try {
      // Pre-create file with pfexec and set writable permissions (same pattern as uploads)
      log.task.debug('Pre-creating download file with pfexec', {
        final_path,
      });

      const createResult = await executeCommand(`pfexec touch "${final_path}"`);
      if (!createResult.success) {
        throw new Error(`Failed to pre-create file: ${createResult.error}`);
      }

      // Set permissions so service user can write to the file
      const chmodResult = await executeCommand(`pfexec chmod 666 "${final_path}"`);
      if (!chmodResult.success) {
        throw new Error(`Failed to set file permissions: ${chmodResult.error}`);
      }

      log.task.debug('File pre-created successfully with proper permissions');

      // Get artifact configuration for timeouts
      const artifactConfig = config.getArtifactStorage();
      const downloadTimeout = (artifactConfig.download?.timeout_seconds || 60) * 1000;

      // Use axios for native streaming performance (like browser downloads)
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

      // Create file stream and track progress
      const fileStream = fs.createWriteStream(final_path);
      const startTime = Date.now();
      let downloadedBytes = 0;
      let lastProgressUpdate = 0;

      log.task.debug('Starting optimized axios stream download with progress tracking');

      // Track download progress via stream events (no checksum calculation)
      response.data.on('data', chunk => {
        downloadedBytes += chunk.length;

        // Update database at configurable interval
        const progressUpdateInterval =
          (artifactConfig.download?.progress_update_seconds || 10) * 1000;
        const now = Date.now();
        if (fileSize && now - lastProgressUpdate > progressUpdateInterval) {
          lastProgressUpdate = now;

          // Async database update - don't block the download stream
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
              // Don't let progress updates block the download
              log.task.debug('Progress update failed', { error: progressError.message });
            }
          });
        }
      });

      // Pure native streaming - maximum performance
      response.data.pipe(fileStream);

      // Wait for completion
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

      // ALWAYS calculate checksum after download (but not during)
      log.task.debug('Calculating checksum post-download');

      const hash = crypto.createHash(checksum_algorithm);
      const readStream = fs.createReadStream(final_path); // Pure streaming - let Node.js optimize

      await new Promise((resolve, reject) => {
        readStream.on('data', chunk => hash.update(chunk));
        readStream.on('end', resolve);
        readStream.on('error', reject);
      });

      const calculatedChecksum = hash.digest('hex');
      let checksumVerified = false;

      // Verify checksum if provided
      if (checksum) {
        checksumVerified = calculatedChecksum === checksum;

        if (!checksumVerified) {
          // Delete the invalid file
          await executeCommand(`pfexec rm -f "${final_path}"`);
          return {
            success: false,
            error: `Checksum verification failed. Expected: ${checksum}, Got: ${calculatedChecksum}`,
            expected_checksum: checksum,
            calculated_checksum: calculatedChecksum,
          };
        }
        log.task.info('Checksum verification passed');
      }

      // Create artifact database record
      const extension = path.extname(finalFilename).toLowerCase();
      const mimeType = getMimeType(final_path);

      // Validate extension is not empty (required field)
      if (!extension) {
        return {
          success: false,
          error: `File has no extension - cannot determine artifact type: ${finalFilename}`,
        };
      }

      try {
        // Use findOrCreate to handle race condition with scan tasks
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
            source_url: url,
            discovered_at: new Date(),
            last_verified: new Date(),
          },
        });

        if (!created) {
          // Record already exists (likely created by scan), update it with complete download data
          log.task.info('Artifact record already exists, updating with download data', {
            filename: finalFilename,
            existing_source: artifact.source_url || 'scan',
            new_source: url,
          });

          await artifact.update({
            filename: finalFilename,
            size: downloadedBytes,
            checksum: calculatedChecksum,
            checksum_algorithm,
            source_url: url,
            last_verified: new Date(),
          });
        } else {
          log.task.debug('Created new artifact database record', {
            filename: finalFilename,
            path: final_path,
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

        // Clean up downloaded file since database record failed
        await executeCommand(`pfexec rm -f "${final_path}"`);

        return {
          success: false,
          error: `Download completed but failed to create database record: ${dbError.message}`,
        };
      }

      // Update storage location stats
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
    } catch (downloadError) {
      throw downloadError;
    }
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

    for (const location of locations) {
      try {
        const scanResult = await scanStorageLocation(location, {
          verify_checksums,
          remove_orphaned,
        });

        totalScanned += scanResult.scanned;
        totalAdded += scanResult.added;
        totalRemoved += scanResult.removed;

        // Update location stats
        await location.update({
          last_scan_at: new Date(),
          scan_errors: 0,
          last_error_message: null,
        });
      } catch (locationError) {
        const errorMsg = `Failed to scan ${location.name}: ${locationError.message}`;
        errors.push(errorMsg);

        await location.update({
          scan_errors: location.scan_errors + 1,
          last_error_message: locationError.message,
        });

        log.task.warn('Storage location scan failed', {
          location_id: location.id,
          location_name: location.name,
          error: locationError.message,
        });
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

    let filesDeleted = 0;
    let recordsRemoved = 0;
    const errors = [];

    for (const artifact of artifacts) {
      try {
        // Delete physical file if requested
        if (delete_files) {
          if (fs.existsSync(artifact.path)) {
            if (force) {
              await executeCommand(`pfexec rm -f "${artifact.path}"`);
            } else {
              await executeCommand(`pfexec rm "${artifact.path}"`);
            }
            filesDeleted++;
            log.task.debug('Deleted artifact file', {
              filename: artifact.filename,
              path: artifact.path,
            });
          } else {
            log.task.warn('Artifact file not found on disk', {
              filename: artifact.filename,
              path: artifact.path,
            });
          }
        }

        // Remove database record
        await artifact.destroy();
        recordsRemoved++;

        // Update storage location stats
        if (artifact.storage_location) {
          await artifact.storage_location.decrement('file_count', { by: 1 });
          await artifact.storage_location.decrement('total_size', { by: artifact.size });
        }
      } catch (deleteError) {
        const errorMsg = `Failed to delete ${artifact.filename}: ${deleteError.message}`;
        errors.push(errorMsg);
        log.task.warn('Artifact deletion failed', {
          artifact_id: artifact.id,
          filename: artifact.filename,
          error: deleteError.message,
        });
      }
    }

    if (errors.length > 0 && errors.length === artifacts.length) {
      return {
        success: false,
        error: `Failed to delete all ${artifacts.length} artifacts`,
        errors,
      };
    }

    const successCount = artifacts.length - errors.length;
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

    const removedFiles = 0;
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

    // Scenario 1: User provided checksum - verify and fail if mismatch
    if (checksum) {
      if (calculatedChecksum !== checksum) {
        return {
          success: false,
          error: `Checksum verification failed. Expected: ${checksum}, Got: ${calculatedChecksum}`,
        };
      }
      log.task.info('Upload checksum verification passed');
    }

    // Scenario 2: Both scenarios - store the calculated checksum as the final value
    const extension = path.extname(original_name).toLowerCase();
    const mimeType = getMimeType(final_path);

    // Create artifact database record with single checksum field
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
    // Get supported extensions for this location type
    const artifactConfig = config.getArtifactStorage();
    const supportedExtensions =
      artifactConfig?.scanning?.supported_extensions?.[location.type] || [];

    // Get running download tasks to avoid race conditions
    const runningDownloadTasks = Array.from(global.runningTasks?.values() || []).filter(
      task => task.operation === 'artifact_download_url'
    );

    log.artifact.debug('Race condition protection: checking running tasks', {
      running_download_tasks: runningDownloadTasks.length,
      location_id: location.id,
      location_path: location.path,
      running_task_ids: runningDownloadTasks.map(t => t.id),
    });

    const downloadingPaths = new Set();
    for (const downloadTask of runningDownloadTasks) {
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

        // If download targets this storage location
        if (storage_location_id === location.id) {
          // Calculate target path same way download does
          let finalFilename = filename;
          if (!finalFilename) {
            const urlPath = new URL(url).pathname;
            finalFilename = path.basename(urlPath) || `download_${Date.now()}`;
          }
          const targetPath = path.join(location.path, finalFilename);
          downloadingPaths.add(targetPath);

          log.artifact.debug('Race condition protection: added downloading path', {
            task_id: downloadTask.id,
            final_filename: finalFilename,
            target_path: targetPath,
            total_downloading_paths: downloadingPaths.size,
          });
        }
      } catch (parseError) {
        // Skip if can't parse metadata
        log.artifact.error('Race condition protection: failed to parse download task metadata', {
          task_id: downloadTask.id,
          error: parseError.message,
          metadata_preview: downloadTask.metadata?.substring(0, 200),
        });
        continue;
      }
    }

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

    // List directory contents
    const items = await listDirectory(location.path);
    const files = items.filter(item => !item.isDirectory);

    // Filter files by supported extensions
    const artifactFiles = files.filter(file =>
      supportedExtensions.some(ext => file.name.toLowerCase().endsWith(ext.toLowerCase()))
    );

    log.artifact.debug('Found potential artifacts', {
      total_files: files.length,
      artifact_files: artifactFiles.length,
      supported_extensions: supportedExtensions,
    });

    // Get existing database records for this location
    const existingArtifacts = await Artifact.findAll({
      where: { storage_location_id: location.id },
    });

    const existingPaths = new Set(existingArtifacts.map(a => a.path));
    const currentPaths = new Set(artifactFiles.map(f => f.path));

    let scanned = 0;
    let added = 0;
    let removed = 0;
    let skipped = 0;

    // Add new artifacts (skip files being downloaded)
    for (const file of artifactFiles) {
      log.artifact.debug('Race condition protection: checking file against downloading paths', {
        file_path: file.path,
        downloading_paths_count: downloadingPaths.size,
        should_skip: downloadingPaths.has(file.path),
        downloading_paths: Array.from(downloadingPaths),
        file_exists_in_db: existingPaths.has(file.path),
      });

      // Skip files that are currently being downloaded to prevent race condition
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
        // New artifact found
        const extension = path.extname(file.name).toLowerCase();
        const mimeType = getMimeType(file.path);

        log.artifact.debug('Race condition protection: creating new artifact record', {
          filename: file.name,
          path: file.path,
          size: file.size,
          extension,
          location_name: location.name,
        });

        await Artifact.create({
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

        added++;
        log.artifact.debug('Added new artifact', {
          filename: file.name,
          path: file.path,
          size: file.size,
        });
      } else {
        // Update last_verified for existing artifacts
        await Artifact.update({ last_verified: new Date() }, { where: { path: file.path } });
      }
      scanned++;
    }

    // Remove orphaned artifacts if requested
    if (remove_orphaned) {
      for (const existingArtifact of existingArtifacts) {
        if (!currentPaths.has(existingArtifact.path)) {
          await existingArtifact.destroy();
          removed++;
          log.artifact.debug('Removed orphaned artifact', {
            filename: existingArtifact.filename,
            path: existingArtifact.path,
          });
        }
      }
    }

    // Update storage location stats
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
