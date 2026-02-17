import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { executeCommand } from '../../../../lib/CommandManager.js';
import { log } from '../../../../lib/Logger.js';
import { updateTaskProgress } from './ProgressHelper.js';

/**
 * @fileoverview Template extraction and import utilities
 */

/**
 * Helper to extract and import template
 * @param {string} tempBoxPath - Path to .box file
 * @param {string} datasetPath - Target ZFS dataset path
 * @param {Object} task - Task object
 * @returns {Promise<{boxMetadata: Object, tempExtractDir: string}>}
 */
export const extractAndImport = async (tempBoxPath, datasetPath, task) => {
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
