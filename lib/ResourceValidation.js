/**
 * @fileoverview Resource Over-Provisioning Prevention
 * @description Pre-flight resource validation for zone creation and modification.
 *              Validates storage, memory (with ZFS ARC accounting), and CPU resources.
 *              Two strategies: "committed" (full configured allocations) vs "actual" (current free space).
 */

import os from 'os';
import { executeCommand } from './CommandManager.js';
import { parseUnitToBytes } from '../controllers/StorageController/utils/ParsingUtils.js';
import config from '../config/ConfigLoader.js';
import { log } from './Logger.js';
import Zones from '../models/ZoneModel.js';

// ─── Storage Internals ───────────────────────────────────────────────────────

/**
 * Query ZFS pool space info
 * @param {string} poolName - ZFS pool name (e.g., "rpool", "Array-1")
 * @returns {Promise<{total: number, alloc: number, free: number}|null>} Bytes, or null on failure
 */
const getPoolSpaceInfo = async poolName => {
  const result = await executeCommand(`zpool list -Hp -o size,alloc,free ${poolName}`);
  if (!result.success) {
    log.api.warn('Failed to query pool space', { pool: poolName, error: result.error });
    return null;
  }

  const parts = result.output.trim().split(/\s+/);
  if (parts.length < 3) {
    log.api.warn('Unexpected zpool list output', { pool: poolName, output: result.output });
    return null;
  }

  return {
    total: parseInt(parts[0], 10),
    alloc: parseInt(parts[1], 10),
    free: parseInt(parts[2], 10),
  };
};

/**
 * Sum all zvol volsizes on a pool (committed storage)
 * @param {string} poolName - ZFS pool name
 * @returns {Promise<number>} Total committed volsize in bytes
 */
const getPoolCommittedVolsize = async poolName => {
  const result = await executeCommand(`zfs list -Hpo volsize -t volume -r ${poolName}`);
  if (!result.success) {
    // Pool may have no volumes — that's fine
    return 0;
  }

  const lines = result.output.trim().split('\n').filter(Boolean);
  let total = 0;
  for (const line of lines) {
    const val = parseInt(line.trim(), 10);
    if (!isNaN(val)) {
      total += val;
    }
  }
  return total;
};

/**
 * Parse disk request body into per-pool byte totals
 * @param {Object} disks - Request body disks object
 * @returns {Map<string, number>} Pool name → total requested bytes
 */
const calculateStorageRequest = disks => {
  const perPool = new Map();

  const addToPool = (pool, bytes) => {
    perPool.set(pool, (perPool.get(pool) || 0) + bytes);
  };

  if (!disks) {
    return perPool;
  }

  // Boot disk
  const { boot } = disks;
  if (boot) {
    // Skip existing dataset attachments (no pool/volume_name, just dataset path)
    const isExisting = boot.dataset && !boot.pool && !boot.volume_name;
    if (!isExisting) {
      const hasSource = boot.source?.type === 'template' || boot.source?.type === 'scratch';
      const hasNewVolume = boot.pool || boot.volume_name || boot.size;
      if (hasSource || hasNewVolume) {
        const pool = boot.pool || 'rpool';
        const sizeStr = boot.size || '48G';
        const bytes = parseInt(parseUnitToBytes(sizeStr) || '0', 10);
        if (bytes > 0) {
          addToPool(pool, bytes);
        }
      }
    }
  }

  // Additional disks
  const { additional } = disks;
  if (Array.isArray(additional)) {
    for (const disk of additional) {
      if (disk.create_new) {
        const pool = disk.pool || 'rpool';
        const sizeStr = disk.size || '50G';
        const bytes = parseInt(parseUnitToBytes(sizeStr) || '0', 10);
        if (bytes > 0) {
          addToPool(pool, bytes);
        }
      }
      // existing_dataset disks don't consume new space — skip
    }
  }

  return perPool;
};

/**
 * Format bytes as human-readable string
 * @param {number} bytes - Byte count
 * @returns {string} Human-readable size (e.g., "48.0G")
 */
const formatBytes = bytes => {
  if (bytes >= 1024 ** 4) {
    return `${(bytes / 1024 ** 4).toFixed(1)}T`;
  }
  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(1)}G`;
  }
  if (bytes >= 1024 ** 2) {
    return `${(bytes / 1024 ** 2).toFixed(1)}M`;
  }
  return `${bytes}B`;
};

/**
 * Validate storage space for requested disks
 * @param {Map<string, number>} requestedPerPool - Pool name → requested bytes
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
const validateStorage = async requestedPerPool => {
  const validationConfig = config.getResourceValidation();
  const storageConfig = validationConfig.storage || {};
  const strategy = storageConfig.strategy || 'committed';
  const thresholds = storageConfig.thresholds || {};
  const warningThreshold = thresholds.warning ?? 70;
  const criticalThreshold = thresholds.critical ?? 80;

  const errors = [];
  const warnings = [];

  const poolEntries = [...requestedPerPool.entries()];
  const results = await Promise.all(
    poolEntries.map(async ([poolName, requestedBytes]) => {
      const poolInfo = await getPoolSpaceInfo(poolName);
      if (!poolInfo) {
        return {
          error: {
            resource: 'storage',
            pool: poolName,
            strategy,
            message: `Unable to query pool "${poolName}" — pool may not exist`,
            requested_bytes: requestedBytes,
          },
        };
      }

      let projectedPct;
      let exceeded = false;

      if (strategy === 'committed') {
        const committed = await getPoolCommittedVolsize(poolName);
        const projected = committed + requestedBytes;
        projectedPct = (projected / poolInfo.total) * 100;

        if (projected > poolInfo.total) {
          exceeded = true;
          return {
            error: {
              resource: 'storage',
              pool: poolName,
              strategy,
              message: `Requested ${formatBytes(requestedBytes)} would exceed pool capacity (${formatBytes(committed)} committed + ${formatBytes(requestedBytes)} requested > ${formatBytes(poolInfo.total)} total)`,
              pool_total_bytes: poolInfo.total,
              committed_bytes: committed,
              requested_bytes: requestedBytes,
              projected_percent: Math.round(projectedPct * 100) / 100,
            },
          };
        }
      } else {
        // "actual" strategy
        projectedPct = ((poolInfo.alloc + requestedBytes) / poolInfo.total) * 100;

        if (requestedBytes > poolInfo.free) {
          exceeded = true;
          return {
            error: {
              resource: 'storage',
              pool: poolName,
              strategy,
              message: `Requested ${formatBytes(requestedBytes)} exceeds available pool space (${formatBytes(poolInfo.free)} free)`,
              pool_total_bytes: poolInfo.total,
              pool_free_bytes: poolInfo.free,
              requested_bytes: requestedBytes,
              projected_percent: Math.round(projectedPct * 100) / 100,
            },
          };
        }
      }

      // Threshold warnings (only if not already rejected)
      if (!exceeded) {
        const currentPct = (poolInfo.alloc / poolInfo.total) * 100;
        const roundedProjected = Math.round(projectedPct * 100) / 100;
        const roundedCurrent = Math.round(currentPct * 100) / 100;

        if (projectedPct > criticalThreshold) {
          return {
            warning: {
              resource: 'storage',
              level: 'critical',
              pool: poolName,
              message: `Pool will be ${roundedProjected}% utilized after this operation (critical threshold: ${criticalThreshold}%)`,
              current_percent: roundedCurrent,
              projected_percent: roundedProjected,
            },
          };
        }

        if (projectedPct > warningThreshold) {
          return {
            warning: {
              resource: 'storage',
              level: 'warning',
              pool: poolName,
              message: `Pool will be ${roundedProjected}% utilized after this operation (warning threshold: ${warningThreshold}%)`,
              current_percent: roundedCurrent,
              projected_percent: roundedProjected,
            },
          };
        }
      }

      return null;
    })
  );

  for (const result of results) {
    if (result?.error) {
      errors.push(result.error);
    }
    if (result?.warning) {
      warnings.push(result.warning);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
};

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/**
 * Safely parse zone configuration from DB record
 * @param {Object} zone - Zone model instance
 * @returns {Object|null} Parsed configuration or null
 */
const parseZoneConfig = zone => {
  const cfg = zone.configuration;
  if (!cfg) {
    return null;
  }
  if (typeof cfg === 'string') {
    try {
      return JSON.parse(cfg);
    } catch {
      return null;
    }
  }
  return cfg;
};

// ─── Memory Internals ───────────────────────────────────────────────────────

/**
 * Query ZFS ARC statistics via kstat
 * @returns {Promise<{arcMinSize: number, arcCurrentSize: number}>} ARC sizes in bytes
 */
const getArcStats = async () => {
  const result = await executeCommand('kstat -p zfs:0:arcstats');
  if (!result.success) {
    return { arcMinSize: 0, arcCurrentSize: 0 };
  }

  let arcMinSize = 0;
  let arcCurrentSize = 0;
  const lines = result.output.trim().split('\n');
  for (const line of lines) {
    const match = line.match(/^zfs:0:arcstats:(?<prop>\S+)\s+(?<val>\d+)$/);
    if (match) {
      if (match.groups.prop === 'c_min') {
        arcMinSize = parseInt(match.groups.val, 10);
      } else if (match.groups.prop === 'size') {
        arcCurrentSize = parseInt(match.groups.val, 10);
      }
    }
  }
  return { arcMinSize, arcCurrentSize };
};

/**
 * Sum committed RAM across all zones from DB configuration
 * @param {string|null} excludeZoneName - Zone to exclude (for modifications)
 * @param {boolean} runningOnly - Only count running zones (for "actual" strategy)
 * @returns {Promise<number>} Total committed RAM in bytes
 */
const getZoneCommittedMemory = async (excludeZoneName, runningOnly) => {
  const where = {};
  if (runningOnly) {
    where.status = 'running';
  }
  const zones = await Zones.findAll({
    attributes: ['name', 'configuration'],
    where,
  });

  let total = 0;
  for (const zone of zones) {
    if (excludeZoneName && zone.name === excludeZoneName) {
      continue;
    }
    const cfg = parseZoneConfig(zone);
    if (!cfg?.ram) {
      continue;
    }
    const bytes = parseInt(parseUnitToBytes(cfg.ram) || '0', 10);
    if (bytes > 0) {
      total += bytes;
    }
  }
  return total;
};

/**
 * Extract requested RAM from zone creation body
 * @param {Object} requestBody - Zone creation request body
 * @returns {number} Requested RAM in bytes, or 0
 */
const calculateMemoryRequest = requestBody => {
  const ram = requestBody.settings?.memory;
  if (!ram) {
    return 0;
  }
  return parseInt(parseUnitToBytes(ram) || '0', 10);
};

/**
 * Extract requested RAM from zone modification body
 * @param {Object} requestBody - Zone modification request body
 * @returns {number} Requested RAM in bytes, or 0
 */
const calculateModificationMemoryRequest = requestBody => {
  if (!requestBody.ram) {
    return 0;
  }
  return parseInt(parseUnitToBytes(requestBody.ram) || '0', 10);
};

/**
 * Validate memory availability for a zone operation
 * @param {number} requestedBytes - Requested RAM in bytes
 * @param {string|null} excludeZoneName - Zone to exclude from committed sum (for modifications)
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
const validateMemory = async (requestedBytes, excludeZoneName) => {
  const validationConfig = config.getResourceValidation();
  const memoryConfig = validationConfig.memory || {};
  const strategy = memoryConfig.strategy || 'committed';
  const arcAccounting = memoryConfig.arc_accounting !== false;
  const thresholds = memoryConfig.thresholds || {};
  const warningThreshold = thresholds.warning ?? 80;
  const criticalThreshold = thresholds.critical ?? 90;

  const errors = [];
  const warnings = [];

  const hostTotal = os.totalmem();

  // Get ARC stats for accounting
  let arcMinSize = 0;
  let arcCurrentSize = 0;
  if (arcAccounting) {
    ({ arcMinSize, arcCurrentSize } = await getArcStats());
  }

  let projectedPct;

  if (strategy === 'committed') {
    const effectiveTotal = hostTotal - arcMinSize;
    const committed = await getZoneCommittedMemory(excludeZoneName, false);
    const projected = committed + requestedBytes;
    projectedPct = (projected / effectiveTotal) * 100;

    if (projected > effectiveTotal) {
      errors.push({
        resource: 'memory',
        strategy,
        message: `Requested ${formatBytes(requestedBytes)} would exceed effective host memory (${formatBytes(committed)} committed + ${formatBytes(requestedBytes)} requested > ${formatBytes(effectiveTotal)} effective${arcMinSize > 0 ? `, after ${formatBytes(arcMinSize)} ARC minimum reserved` : ''})`,
        host_total_bytes: hostTotal,
        effective_total_bytes: effectiveTotal,
        committed_bytes: committed,
        requested_bytes: requestedBytes,
        arc_min_bytes: arcMinSize,
        projected_percent: Math.round(projectedPct * 100) / 100,
      });
      return { valid: false, errors, warnings };
    }
  } else {
    // "actual" strategy — use real-time system memory with ARC accounting
    const hostFree = os.freemem();
    const reclaimableArc = Math.max(0, arcCurrentSize - arcMinSize);
    const effectiveFree = hostFree + reclaimableArc;
    projectedPct = ((hostTotal - effectiveFree + requestedBytes) / hostTotal) * 100;

    if (requestedBytes > effectiveFree) {
      errors.push({
        resource: 'memory',
        strategy,
        message: `Requested ${formatBytes(requestedBytes)} exceeds available host memory (${formatBytes(effectiveFree)} effective free${reclaimableArc > 0 ? `, including ${formatBytes(reclaimableArc)} reclaimable ARC` : ''})`,
        host_total_bytes: hostTotal,
        effective_free_bytes: effectiveFree,
        host_free_bytes: hostFree,
        reclaimable_arc_bytes: reclaimableArc,
        requested_bytes: requestedBytes,
        projected_percent: Math.round(projectedPct * 100) / 100,
      });
      return { valid: false, errors, warnings };
    }
  }

  // Threshold warnings
  const roundedProjected = Math.round(projectedPct * 100) / 100;

  if (projectedPct > criticalThreshold) {
    warnings.push({
      resource: 'memory',
      level: 'critical',
      message: `Host memory will be ${roundedProjected}% utilized after this operation (critical threshold: ${criticalThreshold}%)`,
      projected_percent: roundedProjected,
    });
  } else if (projectedPct > warningThreshold) {
    warnings.push({
      resource: 'memory',
      level: 'warning',
      message: `Host memory will be ${roundedProjected}% utilized after this operation (warning threshold: ${warningThreshold}%)`,
      projected_percent: roundedProjected,
    });
  }

  return { valid: true, errors, warnings };
};

// ─── CPU Internals ──────────────────────────────────────────────────────────

/**
 * Parse vCPU count from zadm configuration value
 * Handles simple ("2") and complex topology ("sockets=2,cores=2,threads=1")
 * @param {string|number} vcpuValue - vCPU configuration value
 * @returns {number} Total vCPU count
 */
const parseVcpuCount = vcpuValue => {
  if (!vcpuValue) {
    return 0;
  }
  const str = String(vcpuValue);

  // Simple: just a number
  if (/^\d+$/.test(str)) {
    return parseInt(str, 10);
  }

  // Complex topology: "sockets=N,cores=N,threads=N"
  const socketMatch = str.match(/sockets=(?<n>\d+)/);
  const coreMatch = str.match(/cores=(?<n>\d+)/);
  const threadMatch = str.match(/threads=(?<n>\d+)/);
  if (socketMatch && coreMatch && threadMatch) {
    return (
      parseInt(socketMatch.groups.n, 10) *
      parseInt(coreMatch.groups.n, 10) *
      parseInt(threadMatch.groups.n, 10)
    );
  }

  return 0;
};

/**
 * Sum committed vCPUs across all zones from DB configuration
 * @param {string|null} excludeZoneName - Zone to exclude (for modifications)
 * @param {boolean} runningOnly - Only count running zones (for "actual" strategy)
 * @returns {Promise<number>} Total committed vCPUs
 */
const getZoneCommittedCpus = async (excludeZoneName, runningOnly) => {
  const where = {};
  if (runningOnly) {
    where.status = 'running';
  }
  const zones = await Zones.findAll({
    attributes: ['name', 'configuration'],
    where,
  });

  let total = 0;
  for (const zone of zones) {
    if (excludeZoneName && zone.name === excludeZoneName) {
      continue;
    }
    const cfg = parseZoneConfig(zone);
    if (!cfg?.vcpus) {
      continue;
    }
    const count = parseVcpuCount(cfg.vcpus);
    if (count > 0) {
      total += count;
    }
  }
  return total;
};

/**
 * Extract requested vCPUs from zone creation body
 * @param {Object} requestBody - Zone creation request body
 * @returns {number} Requested vCPU count, or 0
 */
const calculateCpuRequest = requestBody => {
  // Complex CPU topology takes priority
  if (
    requestBody.zones?.cpu_configuration === 'complex' &&
    requestBody.zones?.complex_cpu_conf?.[0]
  ) {
    const [conf] = requestBody.zones.complex_cpu_conf;
    return (conf.sockets || 1) * (conf.cores || 1) * (conf.threads || 1);
  }
  const vcpus = requestBody.settings?.vcpus;
  if (!vcpus) {
    return 0;
  }
  return parseInt(String(vcpus), 10) || 0;
};

/**
 * Extract requested vCPUs from zone modification body
 * @param {Object} requestBody - Zone modification request body
 * @returns {number} Requested vCPU count, or 0
 */
const calculateModificationCpuRequest = requestBody => {
  if (requestBody.cpu_configuration === 'complex' && requestBody.complex_cpu_conf?.[0]) {
    const [conf] = requestBody.complex_cpu_conf;
    return (conf.sockets || 1) * (conf.cores || 1) * (conf.threads || 1);
  }
  const { vcpus } = requestBody;
  if (!vcpus) {
    return 0;
  }
  return parseInt(String(vcpus), 10) || 0;
};

/**
 * Validate CPU availability for a zone operation
 * @param {number} requestedVcpus - Requested vCPU count
 * @param {string|null} excludeZoneName - Zone to exclude from committed sum (for modifications)
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
const validateCpu = async (requestedVcpus, excludeZoneName) => {
  const validationConfig = config.getResourceValidation();
  const cpuConfig = validationConfig.cpu || {};
  const strategy = cpuConfig.strategy || 'committed';
  const hardLimit = cpuConfig.hard_limit ?? 400;
  const thresholds = cpuConfig.thresholds || {};
  const warningThreshold = thresholds.warning ?? 150;
  const criticalThreshold = thresholds.critical ?? 300;

  const errors = [];
  const warnings = [];

  const hostCpus = os.cpus().length;
  const runningOnly = strategy === 'actual';
  const committed = await getZoneCommittedCpus(excludeZoneName, runningOnly);
  const projected = committed + requestedVcpus;
  const projectedPct = (projected / hostCpus) * 100;

  if (projectedPct > hardLimit) {
    errors.push({
      resource: 'cpu',
      strategy,
      message: `Requested ${requestedVcpus} vCPUs would exceed overcommit limit (${committed} allocated + ${requestedVcpus} requested = ${projected} total vCPUs, ${Math.round(projectedPct)}% of ${hostCpus} physical cores, limit: ${hardLimit}%)`,
      host_cpu_count: hostCpus,
      committed_vcpus: committed,
      requested_vcpus: requestedVcpus,
      projected_vcpus: projected,
      projected_percent: Math.round(projectedPct * 100) / 100,
      hard_limit_percent: hardLimit,
    });
    return { valid: false, errors, warnings };
  }

  // Threshold warnings
  const roundedProjected = Math.round(projectedPct * 100) / 100;

  if (projectedPct > criticalThreshold) {
    warnings.push({
      resource: 'cpu',
      level: 'critical',
      message: `Host vCPU allocation will be ${roundedProjected}% after this operation (${hostCpus} physical cores, ${projected} allocated vCPUs) (critical threshold: ${criticalThreshold}%)`,
      projected_percent: roundedProjected,
    });
  } else if (projectedPct > warningThreshold) {
    warnings.push({
      resource: 'cpu',
      level: 'warning',
      message: `Host vCPU allocation will be ${roundedProjected}% after this operation (${hostCpus} physical cores, ${projected} allocated vCPUs) (warning threshold: ${warningThreshold}%)`,
      projected_percent: roundedProjected,
    });
  }

  return { valid: true, errors, warnings };
};

// ─── Exported Validation Functions ───────────────────────────────────────────

/**
 * Validate resources for zone creation
 * Checks all enabled resource types (storage, memory, CPU) in parallel
 * @param {Object} requestBody - Full zone creation request body
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateZoneCreationResources = async requestBody => {
  const validationConfig = config.getResourceValidation();
  if (!validationConfig.enabled) {
    return { valid: true, errors: [], warnings: [] };
  }

  const validators = [];

  // Storage validation
  if (validationConfig.storage) {
    const requestedPerPool = calculateStorageRequest(requestBody.disks);
    if (requestedPerPool.size > 0) {
      validators.push(validateStorage(requestedPerPool));
    }
  }

  // Memory validation
  if (validationConfig.memory) {
    const requestedRam = calculateMemoryRequest(requestBody);
    if (requestedRam > 0) {
      validators.push(validateMemory(requestedRam, null));
    }
  }

  // CPU validation
  if (validationConfig.cpu) {
    const requestedCpus = calculateCpuRequest(requestBody);
    if (requestedCpus > 0) {
      validators.push(validateCpu(requestedCpus, null));
    }
  }

  const results = await Promise.all(validators);
  const allErrors = [];
  const allWarnings = [];
  for (const result of results) {
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  return { valid: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
};

/**
 * Validate resources for zone modification
 * Only checks resources being changed (add_disks → storage, ram → memory, vcpus → CPU)
 * @param {Object} requestBody - Zone modification request body
 * @param {string} zoneName - Zone being modified (excluded from committed sums)
 * @returns {Promise<{valid: boolean, errors: Array, warnings: Array}>}
 */
export const validateZoneModificationResources = async (requestBody, zoneName) => {
  const validationConfig = config.getResourceValidation();
  if (!validationConfig.enabled) {
    return { valid: true, errors: [], warnings: [] };
  }

  const validators = [];

  // Storage validation for add_disks
  if (validationConfig.storage && requestBody.add_disks) {
    const syntheticDisks = { additional: requestBody.add_disks };
    const requestedPerPool = calculateStorageRequest(syntheticDisks);
    if (requestedPerPool.size > 0) {
      validators.push(validateStorage(requestedPerPool));
    }
  }

  // Memory validation for ram changes
  if (validationConfig.memory && requestBody.ram) {
    const requestedRam = calculateModificationMemoryRequest(requestBody);
    if (requestedRam > 0) {
      validators.push(validateMemory(requestedRam, zoneName));
    }
  }

  // CPU validation for vcpus changes
  if (validationConfig.cpu && (requestBody.vcpus || requestBody.cpu_configuration)) {
    const requestedCpus = calculateModificationCpuRequest(requestBody);
    if (requestedCpus > 0) {
      validators.push(validateCpu(requestedCpus, zoneName));
    }
  }

  const results = await Promise.all(validators);
  const allErrors = [];
  const allWarnings = [];
  for (const result of results) {
    allErrors.push(...result.errors);
    allWarnings.push(...result.warnings);
  }

  if (allErrors.length > 0 || allWarnings.length > 0) {
    log.api.info('Resource validation for zone modification', {
      zone_name: zoneName,
      errors: allErrors.length,
      warnings: allWarnings.length,
    });
  }

  return { valid: allErrors.length === 0, errors: allErrors, warnings: allWarnings };
};
