import axios from 'axios';
import https from 'https';
import config from '../config/ConfigLoader.js';
import { log } from './Logger.js';

/**
 * @fileoverview Template Registry Utilities
 * @description Shared functions for interacting with Vagrant-compatible template registries (BoxVault)
 */

/**
 * Authenticate with registry to get JWT
 * @param {Object} sourceConfig - Source configuration from config.yaml
 * @param {string} [userToken] - Optional user-scoped token to override global key
 * @returns {Promise<string>} JWT token
 */
export const getRegistryToken = async (sourceConfig, userToken = null) => {
  // 1. Prefer user token if provided and looks like a JWT
  if (userToken && userToken.includes('.') && userToken.split('.').length === 3) {
    return userToken;
  }

  // 2. If config has a JWT-like api_key, use it directly
  if (
    sourceConfig.api_key &&
    sourceConfig.api_key.includes('.') &&
    sourceConfig.api_key.split('.').length === 3
  ) {
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
export const createRegistryClient = (sourceConfig, token) => {
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
export const findSourceConfig = sourceName => {
  const templateConfig = config.getTemplateSources();
  if (!templateConfig?.sources) {
    return null;
  }
  return templateConfig.sources.find(s => s.name === sourceName && s.enabled) || null;
};

/**
 * Query registry to get latest version of a box
 * @param {string} org - Organization name
 * @param {string} boxName - Box name
 * @param {Object} sourceConfig - Source configuration
 * @param {string} [authToken] - Optional auth token
 * @returns {Promise<string>} Latest version number
 */
export const queryLatestBoxVersion = async (org, boxName, sourceConfig, authToken = null) => {
  const token = await getRegistryToken(sourceConfig, authToken);
  const client = createRegistryClient(sourceConfig, token);

  // Vagrant-compatible metadata endpoint
  const response = await client.get(`/${org}/${boxName}`);
  const versions = response.data.versions || [];

  if (versions.length === 0) {
    throw new Error(`No versions available for ${org}/${boxName}`);
  }

  // Sort versions numerically (semver-aware)
  const [latestVersion] = versions
    .map(v => v.version)
    .sort((a, b) => {
      // Compare version strings numerically
      const aParts = a.split('.').map(Number);
      const bParts = b.split('.').map(Number);
      for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
        const diff = (bParts[i] || 0) - (aParts[i] || 0);
        if (diff !== 0) {
          return diff;
        }
      }
      return 0;
    });

  return latestVersion;
};
