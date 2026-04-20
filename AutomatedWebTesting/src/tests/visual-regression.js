'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');
const { log, addBug, safeScreenshot } = require('../utils');

const BASELINE_DIR = path.join(__dirname, '..', '..', 'data', 'baselines');
const DIFF_THRESHOLD = 0.005; // 0.5% pixel diff threshold

/**
 * Visual Regression Test — compares current screenshots against stored baselines.
 * Use --update-baselines flag to save current screenshots as new baselines.
 */
async function runVisualRegressionTests(browser, discovery, config, ctx) {
  log(ctx, '\uD83D\uDDBC\uFE0F', '--- Visual Regression Tests ---');

  const updateBaselines = process.argv.includes('--update-baselines');
  const siteBaselineDir = path.join(BASELINE_DIR, config.siteName);

  if (updateBaselines) {
    fs.mkdirSync(siteBaselineDir, { recursive: true });
    log(ctx, '\uD83D\uDCBE', 'Update baselines mode — saving current screenshots as new baselines');
  }

  const pagesToTest = discovery.livePages.slice(0, 8);
  const devices = [
    { name: 'desktop', viewport: { width: 1440, height: 900 } },
    { name: 'mobile', viewport: { width: 390, height: 844 } },
  ];

  for (const pg of pagesToTest) {
    for (const device of devices) {
      if (ctx.isBudgetExceeded()) break;
      ctx.testResults.total++;

      const pageName = (pg.path || '/').replace(/\//g, '_').replace(/^_/, '') || 'home';
      const baselineFile = path.join(siteBaselineDir, `${pageName}_${device.name}.png`);

      try {
        const context = await browser.newContext({
          viewport: device.viewport,
          ignoreHTTPSErrors: true,
          userAgent: device.name === 'mobile'
            ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
            : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        });
        const page = await context.newPage();

        await page.goto(pg.url, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1000);

        const screenshotBuffer = await page.screenshot({ fullPage: false });
        await context.close();

        if (updateBaselines) {
          fs.writeFileSync(baselineFile, screenshotBuffer);
          ctx.testResults.passed++;
          log(ctx, '\u2705', `Baseline saved: ${pageName}_${device.name}`);
          continue;
        }

        if (!fs.existsSync(baselineFile)) {
          ctx.testResults.skipped++;
          log(ctx, '\u23ED\uFE0F', `No baseline for ${pageName}_${device.name} — skipping (run with --update-baselines)`);
          continue;
        }

        // Compare with baseline
        const baselinePng = PNG.sync.read(fs.readFileSync(baselineFile));
        const currentPng = PNG.sync.read(screenshotBuffer);

        // Handle size differences
        const width = Math.min(baselinePng.width, currentPng.width);
        const height = Math.min(baselinePng.height, currentPng.height);

        if (baselinePng.width !== currentPng.width || baselinePng.height !== currentPng.height) {
          ctx.testResults.failed++;
          addBug(ctx, 'Medium', 'Visual Regression',
            `Layout size changed on ${pg.path} (${device.name})`,
            `Baseline: ${baselinePng.width}x${baselinePng.height}, Current: ${currentPng.width}x${currentPng.height}`,
            `${pg.path} — ${device.name}`,
            ['1. Load ' + pg.url, `2. Compare with baseline at ${device.name} viewport`],
            `Page dimensions match baseline (${baselinePng.width}x${baselinePng.height})`,
            `Dimensions changed to ${currentPng.width}x${currentPng.height}`,
            null,
            'Investigate layout changes — may be intentional'
          );
          continue;
        }

        const diff = new PNG({ width, height });
        const mismatchedPixels = pixelmatch(
          baselinePng.data, currentPng.data, diff.data,
          width, height,
          { threshold: 0.1 }
        );

        const totalPixels = width * height;
        const diffPercent = mismatchedPixels / totalPixels;

        if (diffPercent > DIFF_THRESHOLD) {
          ctx.testResults.failed++;

          // Save diff image
          const diffPath = path.join(config.screenshotDir, `diff_${pageName}_${device.name}.png`);
          fs.writeFileSync(diffPath, PNG.sync.write(diff));

          const ss = await safeScreenshot(ctx, null, `vr_${pageName}_${device.name}`, screenshotBuffer);
          addBug(ctx, diffPercent > 0.05 ? 'High' : 'Medium', 'Visual Regression',
            `Visual regression on ${pg.path} (${device.name}): ${(diffPercent * 100).toFixed(2)}% diff`,
            `${mismatchedPixels} pixels differ (${(diffPercent * 100).toFixed(2)}% of ${totalPixels} total)`,
            `${pg.path} — ${device.name}`,
            ['1. Load ' + pg.url, `2. Compare current render against baseline`, `3. Diff saved: ${diffPath}`],
            'Page matches baseline within 0.5% tolerance',
            `${(diffPercent * 100).toFixed(2)}% pixel difference detected`,
            ss,
            'Review visual changes — update baseline if intentional'
          );
        } else {
          ctx.testResults.passed++;
          log(ctx, '\u2705', `VR: ${pageName}_${device.name} — ${(diffPercent * 100).toFixed(3)}% diff (OK)`);
        }
      } catch (e) {
        ctx.testResults.failed++;
        log(ctx, '\u274C', `VR failed for ${pg.path} (${device.name}): ${e.message}`);
      }
    }
  }

  if (updateBaselines) {
    log(ctx, '\uD83D\uDCBE', `Baselines saved to ${siteBaselineDir}`);
  }
}

module.exports = runVisualRegressionTests;
