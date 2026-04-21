'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');
const TEST_DEVICES = require('../config/devices');

async function runVisualTests(browser, discovery, config, ctx) {
  log(ctx, '\uD83D\uDCF7', '--- Visual Tests ---');
  const pages = discovery.livePages.slice(0, 10);
  const deviceList = [
    { key: 'desktop', config: TEST_DEVICES.desktop },
    { key: '4k', config: TEST_DEVICES['4k'] },
    { key: 'iphone', config: { viewport: TEST_DEVICES.iphone.viewport, userAgent: TEST_DEVICES.iphone.userAgent, isMobile: true, hasTouch: true } },
    { key: 'pixel', config: { viewport: TEST_DEVICES.pixel.viewport, userAgent: TEST_DEVICES.pixel.userAgent, isMobile: true, hasTouch: true } },
  ];

  for (const device of deviceList) {
    if (ctx.isBudgetExceeded()) break;
    let context, page;
    try {
      context = await browser.newContext({ viewport: device.config.viewport, userAgent: device.config.userAgent, isMobile: device.config.isMobile, hasTouch: device.config.hasTouch });
      page = await context.newPage();
    } catch (e) { continue; }

    for (const pg of pages) {
      if (ctx.isBudgetExceeded()) break;
      try {
        await safeGoto(page, pg.url);
        ctx.testResults.total++;
        const ssName = `visual_${device.key}_${pg.path.replace(/\//g, '_') || 'home'}`;
        await safeScreenshot(ctx, page, ssName);

        // Check horizontal overflow
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const viewportWidth = device.config.viewport.width;
        if (scrollWidth > viewportWidth + 10) {
          const ss = await safeScreenshot(ctx, page, `overflow_${device.key}_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug(ctx, 'Critical', 'Responsive', `Horizontal overflow on ${pg.path} (${device.config.name || device.key})`, `Page scrollWidth (${scrollWidth}px) exceeds viewport (${viewportWidth}px) by ${scrollWidth - viewportWidth}px`, `${pg.path} — ${device.config.name || device.key}`, ['1. Open ' + pg.url, `2. View at ${viewportWidth}x${device.config.viewport.height}`], 'No horizontal scrollbar', `Horizontal overflow of ${scrollWidth - viewportWidth}px`, ss, 'Fix CSS overflow — check max-width constraints');
          ctx.testResults.failed++;
        } else {
          ctx.testResults.passed++;
        }

        // Check for broken images
        const brokenImgs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('img')).filter(img => {
            if (img.src.startsWith('data:') || img.src.includes('.svg')) return false;
            return img.complete && img.naturalWidth === 0;
          }).map(img => img.src).slice(0, 5);
        });
        if (brokenImgs.length > 0) {
          ctx.testResults.total++;
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, `broken_img_${device.key}_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug(ctx, 'High', 'Image Quality', `${brokenImgs.length} broken image(s) on ${pg.path} (${device.config.name || device.key})`, `Images failed to load: ${brokenImgs.join(', ')}`, `${pg.path} — ${device.config.name || device.key}`, ['1. Open ' + pg.url], 'All images load', `${brokenImgs.length} images broken`, ss, 'Check image URLs and CDN availability');
        }
      } catch (e) {
        ctx.testResults.total++;
        ctx.testResults.skipped++;
      }
    }
    await context.close().catch(() => {});
  }
}

module.exports = runVisualTests;
