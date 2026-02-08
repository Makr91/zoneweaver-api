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
import Zones from '../../models/ZoneModel.js';
import { Op } from 'sequelize';

/**
 * Template Manager for Zone Template Operations
 * Handles downloading templates from Vagrant-compatible registries and managing local template storage
 */

/**
 * Create an authenticated axios client for a registry source
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @param {string} [userToken] - Optional user-scoped token to override global key
 * @returns {import('axios').AxiosInstance} Configured axios instance
 */
const createRegistryClient = (sourceConfig, userToken = null) => {
  const headers = {};
  // Prefer user token if provided (Phase II), otherwise fallback to global config key
  const token = userToken || sourceConfig.api_key;

  if (token) {
    headers.Authorization = `Bearer ${token}`;
    // BoxVault API expects x-access-token for API endpoints
    headers['x-access-token'] = token;
  }

  return axios.create({
    baseURL: sourceConfig.url,
    headers,
    httpsAgent:
      sourceConfig.verify_ssl === false
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
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

    const {
      source_name,
      organization,
      box_name,
      version,
      provider,
      architecture,
      auth_token,
    } = metadata;

    log.task.info('Template download task parameters', {
      source_name,
      organization,
      box_name,
      version,
      provider,
      architecture,
      has_auth_token: !!auth_token,
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

    // Pass auth_token if present (Phase II)
    const client = createRegistryClient(sourceConfig, auth_token);
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

/**
 * Helper to create a box artifact from a zone (Phase III)
 * @param {string} zoneName - Name of the zone to export
 * @param {string} snapshotName - Snapshot to use
 * @param {string} tempDir - Temporary directory for artifact creation
 * @param {Object} task - Task object for progress updates
 * @returns {Promise<{boxPath: string, checksum: string}>}
 */
const createBoxArtifact = async (zoneName, snapshotName, tempDir, task) => {
  await updateTaskProgress(task, 10, { status: 'getting_zone_config' });

  // 1. Get zone configuration to identify dataset
  const configResult = await executeCommand(`pfexec zadm show ${zoneName}`);
  if (!configResult.success) {
    throw new Error(`Failed to get zone config: ${configResult.error}`);
  }

  let zoneConfig;
  try {
    zoneConfig = JSON.parse(configResult.output);
  } catch (e) {
    throw new Error(`Failed to parse zone config: ${e.message}`);
  }

  // Identify the boot dataset based on brand
  let dataset = null;
  if (zoneConfig.brand === 'bhyve') {
    // For bhyve, use the bootdisk object from zadm output
    if (zoneConfig.bootdisk && zoneConfig.bootdisk.path) {
      dataset = zoneConfig.bootdisk.path;
    } else if (zoneConfig.attr?.find(a => a.name === 'bootdisk')) {
      // Fallback for older configs
      dataset = zoneConfig.attr.find(a => a.name === 'bootdisk').value;
    }

    if (!dataset) {
      throw new Error('Could not determine bootdisk for bhyve zone');
    }
  } else {
    // For native zones (ipkg/lipkg), use the zonepath dataset
    const zonepath = zoneConfig.zonepath;
    if (!zonepath) throw new Error('Zone has no zonepath');

    const zfsResult = await executeCommand(`pfexec zfs list -H -o name "${zonepath}"`);
    if (zfsResult.success) {
      dataset = zfsResult.output.trim();
    } else {
      throw new Error(`Failed to resolve dataset for zonepath ${zonepath}`);
    }
  }

  if (!dataset) throw new Error(`Could not determine dataset for zone ${zoneName}`);

  await updateTaskProgress(task, 20, { status: 'creating_snapshot' });

  // 2. Create snapshot if not provided
  let snap = snapshotName;
  if (!snap) {
    snap = `export_${Date.now()}`;
    const snapResult = await executeCommand(`pfexec zfs snapshot ${dataset}@${snap}`);
    if (!snapResult.success) {
      throw new Error(`Failed to create snapshot: ${snapResult.error}`);
    }
  }

  await updateTaskProgress(task, 30, { status: 'exporting_stream' });

  // 3. Send stream to file
  const zssPath = path.join(tempDir, 'box.zss');
  const sendCmd = `pfexec zfs send -c ${dataset}@${snap} > "${zssPath}"`;
  const sendResult = await executeCommand(sendCmd);
  if (!sendResult.success) {
    throw new Error(`Failed to export ZFS stream: ${sendResult.error}`);
  }

  await updateTaskProgress(task, 60, { status: 'creating_metadata' });

  // 4. Create metadata files (matching package.rb logic)
  
  // metadata.json
  const metadata = {
    provider: 'zone',
    format: 'zss',
    brand: zoneConfig.brand || 'ipkg',
    architecture: 'amd64', // Default for now
    created_at: new Date().toISOString(),
  };
  await fs.promises.writeFile(
    path.join(tempDir, 'metadata.json'),
    JSON.stringify(metadata, null, 2)
  );

  // info.json
  const info = {
    boxname: zoneName,
    Author: 'Zoneweaver',
    'Vagrant-Zones': 'This box was built with Zoneweaver API'
  };
  await fs.promises.writeFile(
    path.join(tempDir, 'info.json'),
    JSON.stringify(info, null, 2)
  );

  // Vagrantfile
  const vagrantfileContent = `
Vagrant.configure("2") do |config|
  config.vm.provider :zone do |zone|
    zone.brand = "${zoneConfig.brand || 'ipkg'}"
  end
end
`;
  await fs.promises.writeFile(path.join(tempDir, 'Vagrantfile'), vagrantfileContent);

  await updateTaskProgress(task, 70, { status: 'packaging_box' });

  // 5. Create .box tarball
  const boxPath = path.join(tempDir, 'vagrant.box');
  // Use pfexec tar to ensure we can read the root-owned zss file
  // Use 'E' flag for extended headers to support large files (>8GB) on Solaris
  const tarCmd = `pfexec tar -cvzf "${boxPath}" -C "${tempDir}" metadata.json info.json Vagrantfile box.zss`;
  const tarResult = await executeCommand(tarCmd);
  if (!tarResult.success) {
    throw new Error(`Failed to package box: ${tarResult.error}`);
  }

  await updateTaskProgress(task, 90, { status: 'calculating_checksum' });

  // 6. Calculate checksum
  const hash = crypto.createHash('sha256');
  const readStream = fs.createReadStream(boxPath);
  await new Promise((resolve, reject) => {
    readStream.on('data', chunk => hash.update(chunk));
    readStream.on('end', resolve);
    readStream.on('error', reject);
  });
  const checksum = hash.digest('hex');

  return { boxPath, checksum };
};

/**
 * Execute template publish task (Phase III)
 * Exports a zone to a .box file and uploads it to the registry
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplatePublishTask = async metadataJson => {
  log.task.debug('Template publish task starting');
  let tempDir = null;

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
      zone_name,
      source_name,
      organization,
      box_name,
      version,
      description,
      auth_token,
      snapshot_name,
    } = metadata;

    const task = await findRunningTask('template_upload', zone_name);

    // Find source configuration
    const sourceConfig = findSourceConfig(source_name);
    if (!sourceConfig) {
      return { success: false, error: `Template source not found: ${source_name}` };
    }

    const client = createRegistryClient(sourceConfig, auth_token);

    // Create temp directory
    tempDir = path.join(os.tmpdir(), `template_publish_${crypto.randomUUID()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // 1. Create Box Artifact (Export & Package)
    const { boxPath, checksum } = await createBoxArtifact(
      zone_name,
      snapshot_name,
      tempDir,
      task
    );

    await updateTaskProgress(task, 85, { status: 'uploading_to_registry' });

    // 2. Create Registry Objects (Idempotent-ish)
    // Create Box
    try {
      await client.post(`/api/organization/${organization}/box`, {
        name: box_name,
        description: description || `Exported from zone ${zone_name}`,
        isPublic: false,
      });
    } catch (e) {
      // Ignore if exists (409)
      if (e.response?.status !== 409 && e.response?.status !== 200) throw e;
    }

    // Create Version
    try {
      await client.post(`/api/organization/${organization}/box/${box_name}/version`, {
        versionNumber: version,
        description: description || 'Automated export',
      });
    } catch (e) {
      if (e.response?.status !== 409 && e.response?.status !== 200) throw e;
    }

    // Create Provider
    try {
      await client.post(
        `/api/organization/${organization}/box/${box_name}/version/${version}/provider`,
        {
          name: 'zone',
        }
      );
    } catch (e) {
      if (e.response?.status !== 409 && e.response?.status !== 200) throw e;
    }

    // Create Architecture
    try {
      await client.post(
        `/api/organization/${organization}/box/${box_name}/version/${version}/provider/zone/architecture`,
        {
          name: 'amd64',
          checksum,
          checksumType: 'SHA256',
        }
      );
    } catch (e) {
      if (e.response?.status !== 409 && e.response?.status !== 200) throw e;
    }

    // 3. Upload File
    const fileStream = fs.createReadStream(boxPath);
    const stats = fs.statSync(boxPath);

    await client.post(
      `/api/organization/${organization}/box/${box_name}/version/${version}/provider/zone/architecture/amd64/file/upload`,
      fileStream,
      {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': stats.size,
          'x-file-name': 'vagrant.box',
          'x-checksum': checksum,
          'x-checksum-type': 'SHA256',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      }
    );

    await updateTaskProgress(task, 95, { status: 'releasing_version' });

    // 4. Release Version
    await client.put(`/api/organization/${organization}/box/${box_name}`, {
      name: box_name,
      published: true,
    });

    await updateTaskProgress(task, 100, { status: 'completed' });

    return {
      success: true,
      message: `Successfully exported zone ${zone_name} to ${organization}/${box_name} v${version}`,
    };
  } catch (error) {
    log.task.error('Template publish task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template publish failed: ${error.message}` };
  } finally {
    // Cleanup
    if (tempDir) {
      await executeCommand(`pfexec rm -rf "${tempDir}"`);
    }
  }
};
