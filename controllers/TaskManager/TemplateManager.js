import yj from 'yieldable-json';
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { executeCommand } from '../../lib/CommandManager.js';
import { log } from '../../lib/Logger.js';
import config from '../../config/ConfigLoader.js';
import Template from '../../models/TemplateModel.js';
import Tasks from '../../models/TaskModel.js';
import { Op } from 'sequelize';

/**
 * Template Manager for Zone Template Operations
 * Handles downloading templates from Vagrant-compatible registries and managing local template storage
 */

/**
 * Create an authenticated axios client for a registry source
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @returns {import('axios').AxiosInstance} Configured axios instance
 */
const createRegistryClient = sourceConfig => {
  const headers = {};
  if (sourceConfig.api_key) {
    headers.Authorization = `Bearer ${sourceConfig.api_key}`;
    // BoxVault API expects x-access-token for API endpoints
    headers['x-access-token'] = sourceConfig.api_key;
  }

  return axios.create({
    baseURL: sourceConfig.url,
    headers,
    httpsAgent:
      sourceConfig.verify_ssl === false
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
  });
};

/**
 * Find a template source configuration by name
 * @param {string} sourceName - Name of the source to find
 * @returns {Object|null} Source configuration or null
 */
const findSourceConfig = sourceName => {
  const templateConfig = config.getTemplateSources();
  if (!templateConfig?.sources) {
    return null;
  }
  return templateConfig.sources.find(s => s.name === sourceName && s.enabled) || null;
};

/**
 * Find the running task for progress updates
 * @param {string} operation - Task operation name
 * @param {string} searchTerm - Term to search in metadata
 * @returns {Promise<Object|null>} Task record or null
 */
const findRunningTask = async (operation, searchTerm) => {
  try {
    return await Tasks.findOne({
      where: {
        operation,
        status: 'running',
        metadata: { [Op.like]: `%${searchTerm}%` },
      },
    });
  } catch {
    return null;
  }
};

/**
 * Update task progress
 * @param {Object} task - Task record
 * @param {number} percent - Progress percentage
 * @param {Object} info - Progress info object
 */
const updateTaskProgress = async (task, percent, info) => {
  if (!task) {
    return;
  }
  try {
    await task.update({
      progress_percent: percent,
      progress_info: info,
    });
  } catch (error) {
    log.task.debug('Progress update failed', { error: error.message });
  }
};

/**
 * Helper to download template file
 * @param {Object} client - Axios client
 * @param {string} downloadPath - API path
 * @param {string} tempBoxPath - Local temp path
 * @param {Object} task - Task object
 * @param {Object} templateConfig - Template configuration
 * @returns {Promise<number>} Downloaded bytes
 */
const downloadTemplateFile = async (client, downloadPath, tempBoxPath, task, templateConfig) => {
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

/**
 * Helper to extract and import template
 * @param {string} tempBoxPath - Path to .box file
 * @param {string} datasetPath - Target ZFS dataset path
 * @param {Object} task - Task object
 * @returns {Promise<{boxMetadata: Object, tempExtractDir: string}>}
 */
const extractAndImport = async (tempBoxPath, datasetPath, task) => {
  const tempExtractDir = path.join(os.tmpdir(), `template_extract_${crypto.randomUUID()}`);
  await fs.promises.mkdir(tempExtractDir, { recursive: true });

  try {
    await updateTaskProgress(task, 55, { status: 'extracting_box' });

    // .box files are gzipped tars (tar -cvzf)
    const extractResult = await executeCommand(
      `pfexec tar xzf "${tempBoxPath}" -C "${tempExtractDir}"`
    );
    if (!extractResult.success) {
      throw new Error(`Failed to extract .box file: ${extractResult.error}`);
    }

    await updateTaskProgress(task, 60, { status: 'finding_zfs_stream' });

    // Find the ZFS send stream file (box.zss)
    const extractedFiles = await fs.promises.readdir(tempExtractDir);
    const zssFile = extractedFiles.find(f => f.endsWith('.zss'));

    if (!zssFile) {
      throw new Error(
        `No ZFS send stream (.zss) found in .box archive. Files found: ${extractedFiles.join(', ')}`
      );
    }

    const zssPath = path.join(tempExtractDir, zssFile);

    // Read metadata.json if present
    let boxMetadata = null;
    const metadataFile = extractedFiles.find(f => f === 'metadata.json');
    if (metadataFile) {
      try {
        const metadataContent = await fs.promises.readFile(
          path.join(tempExtractDir, metadataFile),
          'utf8'
        );
        boxMetadata = JSON.parse(metadataContent);
      } catch (parseError) {
        log.task.warn('Failed to parse box metadata.json', { error: parseError.message });
      }
    }

    await updateTaskProgress(task, 70, { status: 'creating_zfs_dataset' });

    // Create parent datasets
    const createResult = await executeCommand(`pfexec zfs create -p ${datasetPath}`);
    if (!createResult.success) {
      throw new Error(`Failed to create ZFS dataset ${datasetPath}: ${createResult.error}`);
    }

    await updateTaskProgress(task, 75, { status: 'importing_zfs_stream' });

    // Import ZFS send stream
    const recvResult = await executeCommand(
      `pfexec zfs recv -u -v -F ${datasetPath} < "${zssPath}"`
    );
    if (!recvResult.success) {
      // Clean up the dataset we created
      await executeCommand(`pfexec zfs destroy -r ${datasetPath}`);
      throw new Error(`Failed to import ZFS stream: ${recvResult.error}`);
    }

    await updateTaskProgress(task, 90, { status: 'creating_snapshot' });

    // Create a snapshot for cloning
    const snapResult = await executeCommand(`pfexec zfs snapshot ${datasetPath}@ready`);
    if (!snapResult.success) {
      log.task.warn('Failed to create ready snapshot', { error: snapResult.error });
    }

    return { boxMetadata, tempExtractDir };
  } catch (error) {
    // Clean up temp dir on error
    await executeCommand(`pfexec rm -rf "${tempExtractDir}"`);
    throw error;
  }
};

/**
 * Execute template download task
 * Downloads a .box from a Vagrant-compatible registry, extracts it, and imports via zfs recv
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateDownloadTask = async metadataJson => {
  log.task.debug('Template download task starting');

  let tempBoxPath = null;
  let tempExtractDir = null;

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

    const { source_name, organization, box_name, version, provider, architecture } = metadata;

    log.task.info('Template download task parameters', {
      source_name,
      organization,
      box_name,
      version,
      provider,
      architecture,
    });

    // Find source configuration
    const sourceConfig = findSourceConfig(source_name);
    if (!sourceConfig) {
      return {
        success: false,
        error: `Template source not found or disabled: ${source_name}`,
      };
    }

    // Check if template already exists locally
    const existing = await Template.findOne({
      where: { source_name, organization, box_name, version, provider, architecture },
    });
    if (existing) {
      return {
        success: false,
        error: `Template already exists locally: ${organization}/${box_name} v${version} (${provider}/${architecture})`,
      };
    }

    const task = await findRunningTask('template_download', box_name);
    await updateTaskProgress(task, 5, { status: 'connecting_to_registry' });

    // Build the download URL following Vagrant-compatible API pattern
    const downloadPath = `/api/organization/${encodeURIComponent(organization)}/box/${encodeURIComponent(box_name)}/version/${encodeURIComponent(version)}/provider/${encodeURIComponent(provider)}/architecture/${encodeURIComponent(architecture)}/file/download`;

    const client = createRegistryClient(sourceConfig);
    const downloadUrl = `${sourceConfig.url}${downloadPath}`;

    log.task.info('Starting template download', { url: downloadUrl });
    await updateTaskProgress(task, 10, { status: 'downloading', url: downloadUrl });

    // Stream download to temp file
    const templateConfig = config.getTemplateSources();

    tempBoxPath = path.join(os.tmpdir(), `template_download_${crypto.randomUUID()}.box`);

    const downloadedBytes = await downloadTemplateFile(
      client,
      downloadPath,
      tempBoxPath,
      task,
      templateConfig
    );

    await updateTaskProgress(task, 50, { status: 'calculating_checksum' });

    // Calculate checksum
    const hash = crypto.createHash('sha256');
    const readStream = fs.createReadStream(tempBoxPath);
    await new Promise((resolve, reject) => {
      readStream.on('data', chunk => hash.update(chunk));
      readStream.on('end', resolve);
      readStream.on('error', reject);
    });
    const checksum = hash.digest('hex');

    // Build the ZFS dataset path
    const storagePath = templateConfig.local_storage_path || '/data/templates';
    const datasetBase = storagePath.startsWith('/')
      ? storagePath.substring(1).replace(/\//g, '/')
      : storagePath;
    const datasetPath = `${datasetBase}/${organization}/${box_name}/${version}`;

    const { boxMetadata, tempExtractDir: extractDir } = await extractAndImport(
      tempBoxPath,
      datasetPath,
      task
    );
    tempExtractDir = extractDir;

    await updateTaskProgress(task, 95, { status: 'saving_record' });

    // Create database record
    const template = await Template.create({
      source_name,
      organization,
      box_name,
      version,
      provider,
      architecture,
      dataset_path: datasetPath,
      original_filename: `${box_name}-${version}-${provider}-${architecture}.box`,
      size: downloadedBytes,
      checksum,
      checksum_algorithm: 'sha256',
      source_url: downloadUrl,
      downloaded_at: new Date(),
      last_verified: new Date(),
      metadata: boxMetadata,
    });

    await updateTaskProgress(task, 100, { status: 'completed' });

    log.task.info('Template download and import completed', {
      template_id: template.id,
      dataset_path: datasetPath,
      organization,
      box_name,
      version,
      size_mb: Math.round(downloadedBytes / 1024 / 1024),
    });

    return {
      success: true,
      message: `Template '${organization}/${box_name}' v${version} downloaded and imported to ${datasetPath}`,
      template_id: template.id,
      dataset_path: datasetPath,
    };
  } catch (error) {
    log.task.error('Template download task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template download failed: ${error.message}` };
  } finally {
    // Clean up temp files
    try {
      if (tempBoxPath && fs.existsSync(tempBoxPath)) {
        await fs.promises.unlink(tempBoxPath);
      }
      if (tempExtractDir && fs.existsSync(tempExtractDir)) {
        await executeCommand(`pfexec rm -rf "${tempExtractDir}"`);
      }
    } catch (cleanupError) {
      log.task.warn('Failed to clean up temp files', { error: cleanupError.message });
    }
  }
};

/**
 * Execute template delete task
 * Destroys the ZFS dataset and removes the database record
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateDeleteTask = async metadataJson => {
  log.task.debug('Template delete task starting');

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

    const { template_id } = metadata;

    const template = await Template.findByPk(template_id);
    if (!template) {
      return {
        success: false,
        error: `Template not found: ${template_id}`,
      };
    }

    log.task.info('Deleting template', {
      template_id,
      dataset_path: template.dataset_path,
      box: `${template.organization}/${template.box_name}`,
      version: template.version,
    });

    // Destroy ZFS dataset
    if (template.dataset_path) {
      const destroyResult = await executeCommand(`pfexec zfs destroy -r ${template.dataset_path}`);
      if (!destroyResult.success) {
        log.task.warn('Failed to destroy ZFS dataset, continuing with DB cleanup', {
          dataset_path: template.dataset_path,
          error: destroyResult.error,
        });
      }
    }

    // Remove database record
    const templateInfo = {
      organization: template.organization,
      box_name: template.box_name,
      version: template.version,
    };
    await template.destroy();

    log.task.info('Template deleted successfully', {
      template_id,
      ...templateInfo,
    });

    return {
      success: true,
      message: `Template '${templateInfo.organization}/${templateInfo.box_name}' v${templateInfo.version} deleted successfully`,
    };
  } catch (error) {
    log.task.error('Template delete task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template deletion failed: ${error.message}` };
  }
};
