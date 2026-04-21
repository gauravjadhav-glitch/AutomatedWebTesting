'use strict';

const { loadConfig } = require('../config');
const { orchestrate } = require('../orchestrator');

/**
 * Run tests for a single site with a given config override.
 * Returns run summary data.
 */
async function runSite(siteConfig) {
  const baseConfig = loadConfig(['node', 'run-test.js', siteConfig.url, `--mode=${siteConfig.mode || 'standard'}`]);

  // Merge any overrides from sites.json
  const config = { ...baseConfig, ...siteConfig.overrides };

  const startTime = Date.now();
  try {
    await orchestrate(config);
    return {
      url: siteConfig.url,
      siteName: config.siteName,
      status: 'completed',
      duration: Math.round((Date.now() - startTime) / 1000),
    };
  } catch (e) {
    return {
      url: siteConfig.url,
      siteName: config.siteName,
      status: 'failed',
      error: e.message,
      duration: Math.round((Date.now() - startTime) / 1000),
    };
  }
}

module.exports = { runSite };
