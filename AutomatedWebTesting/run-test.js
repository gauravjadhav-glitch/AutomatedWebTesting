#!/usr/bin/env node
/**
 * run-test.js — Autonomous E-Commerce QA Agent
 *
 * 5-Layer Architecture:
 *   Layer 0: Login Agent — Authenticate before crawling
 *   Layer 1: Discovery Agent — Map site structure
 *   Layer 2: Planning Agent — Generate test plan
 *   Layer 3: Execution Agent — Run all tests with retry
 *   Layer 4: Reporting Agent — Generate HTML report + deploy
 *
 * Usage:
 *   node run-test.js <url> [--mode=fast|standard|deep]
 *   node run-test.js <url1> <url2> --parallel=2
 *   node run-test.js --multi --config=sites.json
 *   node run-test.js --history [siteName]
 *   node run-test.js --trends [siteName]
 */

require('dotenv').config();
const { loadConfig } = require('./src/config');

const args = process.argv.slice(2);

// CLI: --history [siteName] — Show run history from database
if (args.includes('--history')) {
  const { printHistory } = require('./src/cli/history');
  const site = args.find(a => !a.startsWith('--')) || null;
  printHistory(site);
  process.exit(0);
}

// CLI: --trends [siteName] — Show bug trends from database
if (args.includes('--trends')) {
  const { printTrends } = require('./src/cli/history');
  const site = args.find(a => !a.startsWith('--')) || null;
  printTrends(site);
  process.exit(0);
}

// CLI: --multi --config=sites.json — Multi-site runner
if (args.includes('--multi')) {
  const { runMultiSite, loadSitesConfig } = require('./src/runner');
  const configArg = args.find(a => a.startsWith('--config='));
  const configPath = configArg ? configArg.split('=')[1] : 'sites.json';
  const { sites, parallelism } = loadSitesConfig(configPath);
  runMultiSite(sites, parallelism).catch(e => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
} else {
  // Check for multiple URLs (parallel single-run mode)
  const urls = args.filter(a => !a.startsWith('--') && (a.startsWith('http://') || a.startsWith('https://')));
  const parallelArg = args.find(a => a.startsWith('--parallel='));

  if (urls.length > 1) {
    const { runMultiSite } = require('./src/runner');
    const parallelism = parallelArg ? parseInt(parallelArg.split('=')[1], 10) : 2;
    const modeArg = args.find(a => a.startsWith('--mode='));
    const mode = modeArg ? modeArg.split('=')[1] : 'standard';
    const sites = urls.map(url => ({ url, mode }));
    runMultiSite(sites, parallelism).catch(e => {
      console.error('FATAL:', e.message);
      process.exit(1);
    });
  } else {
    // Single site — standard mode
    const { orchestrate } = require('./src/orchestrator');
    orchestrate(loadConfig()).catch(e => {
      console.error('FATAL:', e.message);
      process.exit(1);
    });
  }
}
