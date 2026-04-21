'use strict';

const path = require('path');

const BUDGETS = { fast: 10 * 60 * 1000, standard: 20 * 60 * 1000, deep: 60 * 60 * 1000 };
const CRAWL_LIMITS = { fast: 20, standard: 30, deep: 100 };

function loadConfig(argv = process.argv) {
  const targetUrl = (argv.slice(2).find(a => !a.startsWith('--')) || process.env.UAT_URL || 'https://coachnew.fynd.io').replace(/\/+$/, '');
  const mode = (argv.find(a => a.startsWith('--mode=')) || `--mode=${process.env.TEST_MODE || 'standard'}`).split('=')[1];
  const siteName = new URL(targetUrl).hostname.replace(/\./g, '-');

  return {
    targetUrl,
    mode,
    budgetMs: BUDGETS[mode] || BUDGETS.standard,
    crawlLimit: CRAWL_LIMITS[mode] || 30,
    creds: {
      phone: process.env.TEST_PHONE || '8888888888',
      otp: process.env.TEST_OTP || '5401',
      pincode: process.env.TEST_PINCODE || '400001',
      email: process.env.TEST_EMAIL || '',
      password: process.env.TEST_PASSWORD || '',
    },
    siteName,
    screenshotDir: path.join(__dirname, '..', '..', 'reports', 'screenshots', siteName),
    reportDir: path.join(__dirname, '..', '..', 'reports'),
    rootDir: path.join(__dirname, '..', '..'),
    ai: {
      provider: process.env.AI_PROVIDER || 'openai',
      openaiApiKey: process.env.OPENAI_API_KEY || '',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      budget: parseFloat(process.env.AI_BUDGET_USD || '0.50'),
    },
    comparison: {
      diffThreshold: parseFloat(process.env.COMPARE_DIFF_THRESHOLD || '0.005'),
      perfRegressionThreshold: parseFloat(process.env.COMPARE_PERF_THRESHOLD || '0.3'),
      maxFlows: parseInt(process.env.COMPARE_MAX_FLOWS || '10', 10),
      ignoreSelectors: [
        '[class*="time"]', '[class*="date"]', 'time',
        '[class*="recommend"]', '[class*="similar"]', '[class*="also"]',
        'script', 'iframe', 'noscript',
      ],
    },
    perfThresholds: {
      fcp: parseInt(process.env.PERF_FCP_MS || '3000', 10),
      ttfb: parseInt(process.env.PERF_TTFB_MS || '800', 10),
      domSize: parseInt(process.env.PERF_DOM_SIZE || '3000', 10),
      loadTime: parseInt(process.env.PERF_LOAD_MS || '10000', 10),
      fcpCritical: parseInt(process.env.PERF_FCP_CRITICAL_MS || '4000', 10),
      loadTimeCritical: parseInt(process.env.PERF_LOAD_CRITICAL_MS || '15000', 10),
    },
  };
}

module.exports = { loadConfig, BUDGETS, CRAWL_LIMITS };
