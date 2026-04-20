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
  };
}

module.exports = { loadConfig, BUDGETS, CRAWL_LIMITS };
