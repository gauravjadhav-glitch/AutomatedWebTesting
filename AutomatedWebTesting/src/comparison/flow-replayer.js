'use strict';

const fs = require('fs');
const path = require('path');
const SELECTORS = require('../config/selectors');

/**
 * Replay a flow against a base URL and capture StepResult for each step.
 *
 * @param {object} flow - Flow definition from flow-generator
 * @param {string} baseUrl - Base URL to prepend to relative paths
 * @param {import('playwright').Browser} browser
 * @param {object} config
 * @param {string} label - 'uat' or 'prod'
 * @returns {Promise<object[]>} StepResult[]
 */
async function replayFlow(flow, baseUrl, browser, config, label) {
  const results = [];
  const ssDir = path.join(config.reportDir, 'comparison-screenshots');
  fs.mkdirSync(ssDir, { recursive: true });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  try {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const stepStart = Date.now();
      const result = {
        flowId: flow.id,
        stepIndex: i,
        action: step.action,
        description: step.description,
        status: 'success',
        timestamp: Date.now(),
        duration: 0,
        error: null,
        screenshot: null,
        screenshotBuffer: null,
        data: {},
        domSnapshot: null,
        perfMetrics: null,
        elementFound: null,
        pageUrl: '',
        httpStatus: null,
      };

      try {
        await STEP_HANDLERS[step.action](page, step, result, baseUrl, ssDir, label, flow.id, config);
      } catch (e) {
        result.status = 'failed';
        result.error = e.message;
      }

      result.duration = Date.now() - stepStart;
      result.pageUrl = page.url();
      results.push(result);
    }
  } finally {
    await context.close().catch(() => {});
  }

  return results;
}

const STEP_HANDLERS = {
  async goto(page, step, result, baseUrl) {
    const url = step.path.startsWith('http') ? step.path : `${baseUrl}${step.path}`;
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.httpStatus = resp ? resp.status() : 0;
    await page.waitForTimeout(2000);
  },

  async screenshot(page, step, result, baseUrl, ssDir, label, flowId) {
    const buffer = await page.screenshot({ fullPage: false, timeout: 15000 });
    const fileName = `${label}_${flowId}_${step.name}.png`;
    const filePath = path.join(ssDir, fileName);
    fs.writeFileSync(filePath, buffer);
    result.screenshot = filePath;
    result.screenshotBuffer = buffer;
  },

  async check_element(page, step, result) {
    const el = await page.$(step.selector).catch(() => null);
    result.elementFound = !!el;
    result.data[step.key] = !!el;
  },

  async extract_data(page, step, result) {
    try {
      const text = await page.$eval(step.selector, el => (el.textContent || '').trim());
      result.data[step.key] = text;
    } catch {
      result.data[step.key] = null;
    }
  },

  async extract_dom(page, step, result, baseUrl, ssDir, label, flowId, config) {
    const ignoreSelectors = config.comparison?.ignoreSelectors || [];
    result.domSnapshot = await page.evaluate(({ selector, depth, ignore }) => {
      function extractTree(el, d) {
        if (d <= 0 || !el) return null;
        // Skip ignored elements
        for (const sel of ignore) {
          try { if (el.matches(sel)) return null; } catch {}
        }
        const children = [];
        for (const child of el.children) {
          const c = extractTree(child, d - 1);
          if (c) children.push(c);
        }
        return {
          tag: el.tagName.toLowerCase(),
          classes: Array.from(el.classList).filter(c => !/^[a-f0-9]{6,}$/i.test(c)).sort(),
          childCount: el.children.length,
          children,
        };
      }
      const root = document.querySelector(selector);
      return root ? extractTree(root, depth) : null;
    }, { selector: step.selector, depth: step.depth || 3, ignore: ignoreSelectors });
  },

  async measure_perf(page, step, result) {
    result.perfMetrics = await page.evaluate(() => {
      const perf = performance.getEntriesByType('navigation')[0] || {};
      const paint = performance.getEntriesByType('paint');
      const fcp = paint.find(p => p.name === 'first-contentful-paint');
      return {
        ttfb: perf.responseStart ? Math.round(perf.responseStart - perf.requestStart) : null,
        fcp: fcp ? Math.round(fcp.startTime) : null,
        domSize: document.querySelectorAll('*').length,
        loadTime: Math.round(perf.loadEventEnd - perf.navigationStart) || null,
      };
    });
    result.data[step.key] = result.perfMetrics;
  },

  async click(page, step, result) {
    const el = await page.$(step.selector);
    if (el) {
      await el.click();
      await page.waitForTimeout(2000);
      result.elementFound = true;
    } else {
      result.elementFound = false;
      result.status = 'failed';
      result.error = `Element not found: ${step.selector}`;
    }
  },

  async search(page, step, result) {
    // Find search input
    const input = await page.$(SELECTORS.searchInput);
    if (!input) {
      // Try clicking search trigger first
      const trigger = await page.$(SELECTORS.searchTrigger);
      if (trigger) {
        await trigger.click();
        await page.waitForTimeout(1000);
      }
    }
    const searchInput = await page.$(SELECTORS.searchInput);
    if (searchInput) {
      await searchInput.fill(step.query);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(3000);
      result.data.searchQuery = step.query;
      result.elementFound = true;
    } else {
      result.elementFound = false;
      result.status = 'failed';
      result.error = 'Search input not found';
    }
  },

  async add_to_cart(page, step, result) {
    const btn = await page.$(step.selector || SELECTORS.addToCart);
    if (btn) {
      await btn.click();
      await page.waitForTimeout(3000);
      result.elementFound = true;
    } else {
      result.elementFound = false;
      result.status = 'failed';
      result.error = 'Add-to-cart button not found';
    }
  },

  async scroll(page, step, result) {
    await page.evaluate((y) => window.scrollTo(0, y), step.y || 99999);
    await page.waitForTimeout(1500);
  },
};

module.exports = { replayFlow };
