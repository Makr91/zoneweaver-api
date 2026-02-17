/**
 * @fileoverview Provisioning request validation helper
 */

import Recipes from '../../../models/RecipeModel.js';
import { validateZoneName } from '../../../lib/ZoneValidation.js';
import { log } from '../../../lib/Logger.js';

/**
 * Validate provisioning request and zone state
 * Supports both old structure (provisioning) and new Hosts.yml structure (provisioner + settings/networks)
 * @param {string} zoneName - Zone name
 * @param {Object} zone - Zone database record
 * @param {boolean} skipRecipe - Whether to skip recipe
 * @returns {Promise<{valid: boolean, error?: string, provisioning?: Object, recipeId?: string, zoneIP?: string, credentials?: Object}>}
 */
export const validateProvisioningRequest = async (zoneName, zone, skipRecipe) => {
  if (!validateZoneName(zoneName)) {
    return { valid: false, error: 'Invalid zone name' };
  }

  if (!zone) {
    return { valid: false, error: `Zone '${zoneName}' not found` };
  }

  let zoneConfig = zone.configuration;
  if (typeof zoneConfig === 'string') {
    try {
      zoneConfig = JSON.parse(zoneConfig);
    } catch (e) {
      log.api.warn('Failed to parse zone configuration', { error: e.message });
      zoneConfig = {};
    }
  }

  // NEW STRUCTURE: Read provisioner instead of provisioning
  const provisioner = zoneConfig?.provisioner;
  const provisioning = zoneConfig?.provisioning; // Fallback for old structure

  const config = provisioner || provisioning;
  if (!config) {
    return {
      valid: false,
      error:
        'No provisioner configuration found. Set provisioner config via PUT /zones/:name first.',
    };
  }

  // NEW STRUCTURE: Extract credentials from settings
  const { extractCredentialsFromSettings, extractControlIP } =
    await import('../../../lib/ProvisionerConfigBuilder.js');

  let credentials;
  let zoneIP;

  if (zoneConfig.settings) {
    // New Hosts.yml structure
    credentials = extractCredentialsFromSettings(zoneConfig.settings);
    if (!credentials.username) {
      return {
        valid: false,
        error: 'Credentials missing: settings.vagrant_user is required',
      };
    }

    // Extract IP from networks array
    zoneIP = extractControlIP(zoneConfig.networks);
    if (!zoneIP) {
      return {
        valid: false,
        error: 'Zone IP address not found in networks array (set is_control: true on one network)',
      };
    }
  } else {
    // OLD STRUCTURE: Fallback to provisioning.credentials and provisioning.ip
    const { credentials: configCredentials, ip: configIP, variables } = config;
    credentials = configCredentials;
    if (!credentials || !credentials.username) {
      return {
        valid: false,
        error: 'Provisioning credentials are required (at minimum: username)',
      };
    }

    zoneIP = configIP || variables?.ip;
    if (!zoneIP) {
      return { valid: false, error: 'Zone IP address not configured in provisioning metadata' };
    }
  }

  // Validate recipe if specified
  const recipeId = config.recipe_id;
  if (recipeId && !skipRecipe) {
    const recipe = await Recipes.findByPk(recipeId);
    if (!recipe) {
      return { valid: false, error: `Recipe '${recipeId}' not found` };
    }
  }

  return {
    valid: true,
    provisioning: config,
    recipeId,
    zoneIP,
    credentials,
  };
};
