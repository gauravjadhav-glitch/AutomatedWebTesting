'use strict';

const fs = require('fs');
const path = require('path');

function log(ctx, icon, msg) {
  console.log(`${icon} [${(ctx.elapsed() / 1000).toFixed(1)}s] ${msg}`);
}

function addBug(ctx, severity, category, title, description, location, steps, expected, actual, screenshotPath, fix) {
  ctx.bugCounter++;
  const id = `BUG-${String(ctx.bugCounter).padStart(3, '0')}`;
  ctx.bugs.push({
    id, severity, category, title, description, location, steps, expected, actual,
    screenshot: screenshotPath, fix, timestamp: new Date().toISOString(),
  });
  log(ctx, severity === 'Critical' ? '\u274C' : severity === 'High' ? '\u26A0\uFE0F' : '\u2139\uFE0F', `${id} [${severity}] ${title}`);
  return id;
}

async function safeScreenshot(ctx, page, name) {
  try {
    const filePath = path.join(ctx.config.screenshotDir, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false, timeout: 15000 });
    ctx.screenshots[name] = filePath;
    return filePath;
  } catch (e) {
    return null;
  }
}

async function safeScreenshotBuffer(page, opts = {}) {
  try {
    return await page.screenshot({ fullPage: false, timeout: 15000, ...opts });
  } catch (e) {
    return null;
  }
}

async function safeGoto(page, url, opts = {}) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, ...opts });
    await page.waitForTimeout(2000);
    return resp;
  } catch (e) {
    return null;
  }
}

async function retry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      const delay = 1000 * Math.pow(2, i); // 1s → 2s → 4s
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function setupPageListeners(ctx, page) {
  page.on('console', msg => {
    if (msg.type() === 'error') {
      ctx.consoleErrors.push({ text: msg.text(), url: page.url(), timestamp: Date.now() });
    }
  });
  page.on('requestfailed', req => {
    ctx.networkErrors.push({ url: req.url(), failure: req.failure()?.errorText, page: page.url(), timestamp: Date.now() });
  });
}

module.exports = { log, addBug, safeScreenshot, safeScreenshotBuffer, safeGoto, retry, setupPageListeners };
