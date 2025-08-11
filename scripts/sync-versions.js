#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

/**
 * Synchronize version between root package.json, config files, and release-please manifest
 * This ensures all configuration files always have the same version
 */

const rootPackagePath = './package.json';
const swaggerConfigPath = './config/swagger.js';
const configYamlPath = './config/config.yaml';
const productionConfigPath = './packaging/config/production-config.yaml';
const releasePleaseManifestPath = './.release-please-manifest.json';

try {
  // Read root package.json (single source of truth)
  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, 'utf8'));
  const rootVersion = rootPackage.version;
  
  console.log(`🔄 Synchronizing versions to ${rootVersion}`);
  
  // 1. Update swagger config
  if (fs.existsSync(swaggerConfigPath)) {
    let swaggerConfig = fs.readFileSync(swaggerConfigPath, 'utf8');
    swaggerConfig = swaggerConfig.replace(/version:\s*['"`][^'"`]*['"`]/g, `version: '${rootVersion}'`);
    fs.writeFileSync(swaggerConfigPath, swaggerConfig);
    console.log(`   ✅ Updated swagger config`);
  } else {
    console.log(`   ⚠️  Swagger config not found: ${swaggerConfigPath}`);
  }
  
  // 2. Update config.yaml
  if (fs.existsSync(configYamlPath)) {
    try {
      const configData = yaml.load(fs.readFileSync(configYamlPath, 'utf8'));
      configData.version = rootVersion;
      fs.writeFileSync(configYamlPath, yaml.dump(configData, {
        indent: 2,
        lineWidth: -1,
        noCompatMode: true
      }));
      console.log(`   ✅ Updated config.yaml`);
    } catch (error) {
      console.warn(`   ⚠️  Could not parse config.yaml as YAML, trying text replacement`);
      let configYaml = fs.readFileSync(configYamlPath, 'utf8');
      configYaml = configYaml.replace(/version:\s*[^\n]*/g, `version: "${rootVersion}"`);
      fs.writeFileSync(configYamlPath, configYaml);
      console.log(`   ✅ Updated config.yaml (text replacement)`);
    }
  } else {
    console.log(`   ⚠️  Config YAML not found: ${configYamlPath}`);
  }
  
  // 3. Update production config (if exists)
  if (fs.existsSync(productionConfigPath)) {
    try {
      const configData = yaml.load(fs.readFileSync(productionConfigPath, 'utf8'));
      configData.version = rootVersion;
      fs.writeFileSync(productionConfigPath, yaml.dump(configData, {
        indent: 2,
        lineWidth: -1,
        noCompatMode: true
      }));
      console.log(`   ✅ Updated production config`);
    } catch (error) {
      console.warn(`   ⚠️  Could not parse production config as YAML, trying text replacement`);
      let productionConfig = fs.readFileSync(productionConfigPath, 'utf8');
      productionConfig = productionConfig.replace(/version:\s*[^\n]*/g, `version: "${rootVersion}"`);
      fs.writeFileSync(productionConfigPath, productionConfig);
      console.log(`   ✅ Updated production config (text replacement)`);
    }
  } else {
    console.log(`   ⚠️  Production config not found: ${productionConfigPath}`);
  }
  
  // 4. Update release-please manifest (if exists)
  if (fs.existsSync(releasePleaseManifestPath)) {
    const releasePleaseManifest = JSON.parse(fs.readFileSync(releasePleaseManifestPath, 'utf8'));
    releasePleaseManifest['.'] = rootVersion;
    fs.writeFileSync(releasePleaseManifestPath, JSON.stringify(releasePleaseManifest, null, 2) + '\n');
    console.log(`   ✅ Updated release-please manifest`);
  } else {
    console.log(`   ⚠️  Release-please manifest not found: ${releasePleaseManifestPath}`);
  }
  
  console.log(`✅ Synchronized versions to ${rootVersion}`);
  console.log(`   - Root: ${rootVersion}`);
  console.log(`   - Swagger: ${rootVersion}`);
  console.log(`   - Config: ${rootVersion}`);
  console.log(`   - Production Config: ${rootVersion}`);
  console.log(`   - Release Please Manifest: ${rootVersion}`);
  
} catch (error) {
  console.error('❌ Error synchronizing versions:', error.message);
  console.error('Stack trace:', error.stack);
  process.exit(1);
}
