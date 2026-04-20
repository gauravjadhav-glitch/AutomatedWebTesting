'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runUserJourneyTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDEB6', '--- User Journey Tests ---');

  // Journey 1: Browse → PLP → PDP
  ctx.testResults.total++;
  try {
    await safeGoto(page, config.targetUrl);
    await safeScreenshot(ctx, page, 'journey1_home');

    // Navigate to products
    const plp = discovery.livePages.find(p => p.path === '/products' || p.path === '/collections');
    if (plp) {
      await safeGoto(page, plp.url);
      await safeScreenshot(ctx, page, 'journey1_plp');

      // Click first product
      const productLink = await page.$('a[href*="/product/"], [class*="product-card"] a, [class*="product-item"] a');
      if (productLink) {
        await productLink.click();
        await page.waitForTimeout(3000);
        await safeScreenshot(ctx, page, 'journey1_pdp');
        ctx.testResults.passed++;
        log(ctx, '\u2705', 'Journey 1: Browse \u2192 PLP \u2192 PDP successful');
      } else {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, 'journey1_no_product');
        addBug(ctx, 'High', 'User Journey', 'Cannot navigate from PLP to PDP', 'No clickable product links on PLP', 'Products \u2014 Desktop', ['1. Open PLP', '2. Click product'], 'PDP opens', 'No product links found', ss, 'Add product links to PLP cards');
      }
    } else {
      ctx.testResults.skipped++;
    }
  } catch (e) {
    ctx.testResults.failed++;
  }

  // Journey 2: Homepage deep scroll
  ctx.testResults.total++;
  try {
    await safeGoto(page, config.targetUrl);

    // Scroll test
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(1000);

    // Check for lazy loaded images
    const allImgs = await page.$$eval('img', imgs => imgs.filter(i => i.offsetWidth > 0).length);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await safeScreenshot(ctx, page, 'journey2_bottom');

    // Check for JS errors during scroll
    const recentErrors = ctx.consoleErrors.filter(e => Date.now() - e.timestamp < 10000);
    if (recentErrors.length > 3) {
      ctx.testResults.failed++;
      addBug(ctx, 'Medium', 'UI Functionality', 'Console errors during scroll', `${recentErrors.length} JS errors occurred while scrolling`, 'Homepage \u2014 Desktop', ['1. Open homepage', '2. Scroll to bottom'], 'No JS errors', `${recentErrors.length} errors`, ctx.screenshots['journey2_bottom'], 'Fix JS errors triggered by scroll events');
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'Journey 2: Deep scroll \u2014 no issues');
    }
  } catch (e) {
    ctx.testResults.failed++;
  }

  // Journey 3: Search → Product (if search works)
  if (discovery.features.hasSearch) {
    ctx.testResults.total++;
    try {
      await safeGoto(page, config.targetUrl);
      const searchIcon = await page.$('input[type="search"], [class*="search"] input, [placeholder*="search" i], button[aria-label*="search" i], [class*="search-icon"], [class*="search"]');
      if (searchIcon) {
        await searchIcon.click();
        await page.waitForTimeout(1000);
        const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], [class*="search"] input, input[name="q"]');
        if (searchInput) {
          await searchInput.fill('bag');
          await searchInput.press('Enter');
          await page.waitForTimeout(3000);
          await safeScreenshot(ctx, page, 'journey3_search_results');

          const resultLink = await page.$('a[href*="/product/"]');
          if (resultLink) {
            await resultLink.click();
            await page.waitForTimeout(3000);
            await safeScreenshot(ctx, page, 'journey3_pdp');
            ctx.testResults.passed++;
            log(ctx, '\u2705', 'Journey 3: Search \u2192 PDP successful');
          } else {
            ctx.testResults.passed++; // Search worked, just no product links
          }
        } else {
          ctx.testResults.skipped++;
        }
      } else {
        ctx.testResults.skipped++;
      }
    } catch (e) {
      ctx.testResults.failed++;
    }
  }
}

module.exports = runUserJourneyTests;
