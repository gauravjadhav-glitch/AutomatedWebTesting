'use strict';

const fs = require('fs');
const path = require('path');
const { JobQueue } = require('./queue');
const { runSite } = require('./site-runner');

/**
 * Multi-site orchestrator — runs tests on multiple sites with configurable parallelism.
 *
 * Usage:
 *   node run-test.js url1 url2 --parallel=2
 *   node run-test.js --multi --config=sites.json
 */
async function runMultiSite(sites, parallelism = 2) {
  console.log('\n' + '='.repeat(60));
  console.log(' MULTI-SITE QA RUNNER');
  console.log(` Sites:       ${sites.length}`);
  console.log(` Parallelism: ${parallelism}`);
  console.log('='.repeat(60) + '\n');

  const queue = new JobQueue(parallelism);

  for (const site of sites) {
    queue.add(() => {
      console.log(`\n>>> Starting: ${site.url} (mode: ${site.mode || 'standard'})`);
      return runSite(site);
    });
  }

  const startTime = Date.now();
  const results = await queue.run();
  const totalDuration = Math.round((Date.now() - startTime) / 1000);

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log(' MULTI-SITE SUMMARY');
  console.log('='.repeat(60));

  let completed = 0;
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      const v = r.value;
      const icon = v.status === 'completed' ? '\u2705' : '\u274C';
      console.log(` ${icon} ${v.siteName} — ${v.status} (${v.duration}s)`);
      if (v.status === 'completed') completed++;
      else failed++;
    } else {
      console.log(` \u274C Error: ${r.reason?.message || 'Unknown error'}`);
      failed++;
    }
  }

  console.log(`\n Total: ${results.length} sites — ${completed} completed, ${failed} failed`);
  console.log(` Duration: ${totalDuration}s`);
  console.log('='.repeat(60) + '\n');

  return results;
}

/**
 * Load site configs from a JSON file.
 * Expected format:
 * {
 *   "sites": [
 *     { "url": "https://site1.com", "mode": "standard" },
 *     { "url": "https://site2.com", "mode": "fast" }
 *   ],
 *   "parallelism": 3
 * }
 */
function loadSitesConfig(configPath) {
  const fullPath = path.resolve(configPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Sites config not found: ${fullPath}`);
  }
  const raw = fs.readFileSync(fullPath, 'utf-8');
  const config = JSON.parse(raw);

  if (!config.sites || !Array.isArray(config.sites)) {
    throw new Error('sites.json must have a "sites" array');
  }

  return {
    sites: config.sites.map(s => ({
      url: s.url,
      mode: s.mode || 'standard',
      overrides: s.overrides || {},
    })),
    parallelism: config.parallelism || 2,
  };
}

module.exports = { runMultiSite, loadSitesConfig };
