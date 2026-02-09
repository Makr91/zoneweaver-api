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
 * Authenticate with registry to get JWT
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @param {string} [userToken] - Optional user-scoped token to override global key
 * @returns {Promise<string>} JWT token
 */
const getRegistryToken = async (sourceConfig, userToken = null) => {
  // 1. Prefer user token if provided and looks like a JWT
  if (userToken && userToken.includes('.') && userToken.split('.').length === 3) {
    return userToken;
  }

  // 2. If config has a JWT-like api_key, use it directly
  if (sourceConfig.api_key && sourceConfig.api_key.includes('.') && sourceConfig.api_key.split('.').length === 3) {
    return sourceConfig.api_key;
  }

  // 3. If we have username and api_key (password), try to login to get JWT
  if (sourceConfig.username && sourceConfig.api_key) {
    try {
      const client = axios.create({
        baseURL: sourceConfig.url,
        httpsAgent:
          sourceConfig.verify_ssl === false
            ? new https.Agent({ rejectUnauthorized: false })
            : undefined,
        headers: {
          'User-Agent': 'Vagrant/2.2.19 Zoneweaver/1.0.0',
        },
      });

      const response = await client.post('/api/auth/signin', {
        username: sourceConfig.username,
        password: sourceConfig.api_key,
        stayLoggedIn: true,
      });

      if (response.data && response.data.accessToken) {
        return response.data.accessToken;
      }
    } catch (error) {
      log.task.warn('Registry login failed, falling back to raw API key', { error: error.message });
    }
  }

  // 4. Fallback to raw API key
  return userToken || sourceConfig.api_key;
};

/**
 * Create an authenticated axios client for a registry source
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @param {string} token - Valid authentication token (JWT or API Key)
 * @returns {import('axios').AxiosInstance} Configured axios instance
 */
const createRegistryClient = (sourceConfig, token) => {
  const headers = {};

  // Set User-Agent to satisfy BoxVault service account expectations
  headers['User-Agent'] = 'Vagrant/2.2.19 Zoneweaver/1.0.0';

  if (token) {
    headers.Authorization = `Bearer ${token}`;
    // BoxVault API expects x-access-token for API endpoints
    // Only set x-access-token if it looks like a JWT to avoid "jwt malformed" errors
    if (token.includes('.') && token.split('.').length === 3) {
      headers['x-access-token'] = token;
    }
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

    // Get valid token (login if necessary)
    const token = await getRegistryToken(sourceConfig, auth_token);
    const client = createRegistryClient(sourceConfig, token);
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
 * Helper to identify boot dataset from zone config
 * @param {Object} zoneConfig - Zone configuration object
 * @param {string} zoneName - Zone name
 * @returns {Promise<string>} Boot dataset path
 */
const getZoneBootDataset = async zoneConfig => {
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
  return dataset;
};

/**
 * Helper to generate metadata files for box artifact
 * @param {string} tempDir - Temporary directory
 * @param {Object} zoneConfig - Zone configuration
 * @param {string} zoneName - Zone name
 */
const generateBoxMetadata = async (tempDir, zoneConfig, zoneName) => {
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
    'Vagrant-Zones': 'This box was built with Zoneweaver API',
  };
  await fs.promises.writeFile(path.join(tempDir, 'info.json'), JSON.stringify(info, null, 2));

  // Vagrantfile
  const vagrantfileContent = `
Vagrant.configure("2") do |config|
  config.vm.provider :zone do |zone|
    zone.brand = "${zoneConfig.brand || 'ipkg'}"
  end
end
`;
  await fs.promises.writeFile(path.join(tempDir, 'Vagrantfile'), vagrantfileContent);
};

/**
 * Helper to ensure registry structure exists (Box, Version, Provider)
 * @param {Object} client - Axios client
 * @param {string} organization - Organization name
 * @param {string} box_name - Box name
 * @param {string} version - Version
 * @param {string} description - Description
 * @param {string} zone_name - Zone name (for description fallback)
 */
const ensureRegistryStructure = async (
  client,
  organization,
  box_name,
  version,
  description,
  zone_name
) => {
  const ignoreConflict = e => {
    if (e.response?.status !== 409 && e.response?.status !== 200) throw e;
  };

  await client
    .post(`/api/organization/${organization}/box`, {
      name: box_name,
      description: description || `Exported from ${zone_name || 'file'}`,
      isPublic: false,
    })
    .catch(ignoreConflict);

  await client
    .post(`/api/organization/${organization}/box/${box_name}/version`, {
      versionNumber: version,
      description: description || 'Automated export',
    })
    .catch(ignoreConflict);

  await client
    .post(`/api/organization/${organization}/box/${box_name}/version/${version}/provider`, {
      name: 'zone',
    })
    .catch(ignoreConflict);
};

/**
 * Helper to upload artifact to registry
 * @param {Object} client - Axios client
 * @param {Object} sourceConfig - Source configuration
 * @param {string} token - Auth token
 * @param {string} organization - Organization name
 * @param {string} box_name - Box name
 * @param {string} version - Version
 * @param {string} checksum - File checksum
 * @param {string} uploadFilePath - Path to file to upload
 */
const uploadRegistryArtifact = async (
  client,
  sourceConfig,
  token,
  organization,
  box_name,
  version,
  checksum,
  uploadFilePath
) => {
  const ignoreConflict = e => {
    if (e.response?.status !== 409 && e.response?.status !== 200) throw e;
  };

  await client
    .post(
      `/api/organization/${organization}/box/${box_name}/version/${version}/provider/zone/architecture`,
      {
        name: 'amd64',
        checksum,
        checksumType: 'SHA256',
      }
    )
    .catch(ignoreConflict);

  const fileStream = fs.createReadStream(uploadFilePath);
  const stats = fs.statSync(uploadFilePath);

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

  const dataset = await getZoneBootDataset(zoneConfig);
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
  // Increase timeout for large streams (1 hour)
  const sendResult = await executeCommand(sendCmd, 3600 * 1000);
  if (!sendResult.success) {
    throw new Error(`Failed to export ZFS stream: ${sendResult.error}`);
  }

  await updateTaskProgress(task, 60, { status: 'creating_metadata' });

  // 4. Create metadata files
  await generateBoxMetadata(tempDir, zoneConfig, zoneName);

  await updateTaskProgress(task, 70, { status: 'packaging_box' });

  // 5. Create .box tarball
  const boxPath = path.join(tempDir, 'vagrant.box');
  // Use pfexec tar to ensure we can read the root-owned zss file
  // Use standard tar flags (GNU tar on OmniOS usually doesn't need -E for large files)
  const tarCmd = `pfexec tar -cvzf "${boxPath}" -C "${tempDir}" metadata.json info.json Vagrantfile box.zss`;
  // Increase timeout for large archives (1 hour)
  const tarResult = await executeCommand(tarCmd, 3600 * 1000);
  if (!tarResult.success) {
    throw new Error(`Failed to package box: ${tarResult.error}`);
  }

  await updateTaskProgress(task, 90, { status: 'calculating_checksum' });

  // 6. Calculate checksum
  const checksum = await calculateChecksumNonBlocking(boxPath, 'sha256');

  return { boxPath, checksum };
};

/**
 * Execute template export task (Phase III - Part 1)
 * Exports a zone to a local .box file
 * @param {string} metadataJson - Task metadata as JSON string
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
export const executeTemplateExportTask = async metadataJson => {
  log.task.debug('Template export task starting');
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

    const { zone_name, snapshot_name, filename } = metadata;

    const task = await findRunningTask('template_export', zone_name);

    // Create temp directory
    tempDir = path.join(os.tmpdir(), `template_export_${crypto.randomUUID()}`);
    await fs.promises.mkdir(tempDir, { recursive: true });

    // 1. Create Box Artifact
    const { boxPath, checksum } = await createBoxArtifact(
      zone_name,
      snapshot_name,
      tempDir,
      task
    );

    await updateTaskProgress(task, 90, { status: 'moving_to_storage' });

    // 2. Move to destination
    // Default to /var/tmp for now, or use a configured exports directory if available
    const destPath = '/var/tmp';
    const finalFilename = filename || `${zone_name}-${Date.now()}.box`;
    const finalPath = path.join(destPath, finalFilename);

    // Use pfexec to move if needed (cross-device or permission issues)
    const moveResult = await executeCommand(`pfexec mv "${boxPath}" "${finalPath}"`, 3600 * 1000);
    if (!moveResult.success) {
      // Fallback to copy if move fails (e.g. cross-device)
      const copyResult = await executeCommand(`pfexec cp "${boxPath}" "${finalPath}"`, 3600 * 1000);
      if (!copyResult.success) {
        throw new Error(
          `Failed to move artifact to storage: ${moveResult.error} / ${copyResult.error}`
        );
      }
    }

    // Ensure permissions are correct (readable by api user)
    await executeCommand(`pfexec chmod 644 "${finalPath}"`);

    await updateTaskProgress(task, 100, { status: 'completed' });

    return {
      success: true,
      message: `Successfully exported zone ${zone_name} to ${finalFilename}`,
      file_path: finalPath,
      checksum,
    };
  } catch (error) {
    log.task.error('Template export task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template export failed: ${error.message}` };
  } finally {
    // Cleanup
    if (tempDir) {
      await executeCommand(`pfexec rm -rf "${tempDir}"`);
    }
  }
};

/**
 * Execute template publish task (Phase III - Part 2 or Combined)
 * Uploads a .box file (from zone export or existing file) to the registry
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
      box_path, // New: Option to upload existing file
      source_name,
      organization,
      box_name,
      version,
      description,
      auth_token,
      snapshot_name,
    } = metadata;

    const task = await findRunningTask('template_upload', zone_name || box_name);

    // Find source configuration
    const sourceConfig = findSourceConfig(source_name);
    if (!sourceConfig) {
      return { success: false, error: `Template source not found: ${source_name}` };
    }

    const token = await getRegistryToken(sourceConfig, auth_token);
    const client = createRegistryClient(sourceConfig, token);

    let uploadFilePath;
    let uploadChecksum;

    if (box_path) {
      // Path 1: Upload existing file
      log.task.info('Publishing existing box file', { box_path });
      uploadFilePath = box_path;

      if (!fs.existsSync(uploadFilePath)) {
        return { success: false, error: `Box file not found: ${uploadFilePath}` };
      }

      await updateTaskProgress(task, 10, { status: 'calculating_checksum' });

      // Calculate checksum for existing file
      uploadChecksum = await calculateChecksumNonBlocking(uploadFilePath, 'sha256');
    } else if (zone_name) {
      // Path 2: Export from zone then upload (Combined)
      // Create temp directory
      tempDir = path.join(os.tmpdir(), `template_publish_${crypto.randomUUID()}`);
      await fs.promises.mkdir(tempDir, { recursive: true });

      // Create Box Artifact
      const artifact = await createBoxArtifact(zone_name, snapshot_name, tempDir, task);
      uploadFilePath = artifact.boxPath;
      uploadChecksum = artifact.checksum;
    } else {
      return { success: false, error: 'Either zone_name or box_path must be provided' };
    }

    await updateTaskProgress(task, 85, { status: 'uploading_to_registry' });

    // 2. Create Registry Objects
    await ensureRegistryStructure(
      client,
      organization,
      box_name,
      version,
      description,
      zone_name
    );

    // 3. Upload File
    await uploadRegistryArtifact(
      client,
      sourceConfig,
      token,
      organization,
      box_name,
      version,
      uploadChecksum,
      uploadFilePath
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
      message: `Successfully published ${zone_name || 'file'} to ${organization}/${box_name} v${version}`,
    };
  } catch (error) {
    log.task.error('Template publish task exception', {
      error: error.message,
      stack: error.stack,
    });
    return { success: false, error: `Template publish failed: ${error.message}` };
  } finally {
    // Cleanup only if we created a temp directory (i.e., exported from zone)
    if (tempDir) {
      await executeCommand(`pfexec rm -rf "${tempDir}"`);
    }
  }
};
