'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runLazyLoadTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDDBC\uFE0F', '--- Lazy Loading Tests ---');
  await safeGoto(page, config.targetUrl);
  await page.waitForTimeout(2000);
  ctx.testResults.total++;

  // Count images above the fold
  const aboveFold = await page.evaluate(() => {
    const viewportH = window.innerHeight;
    const allImgs = Array.from(document.querySelectorAll('img'));
    const above = allImgs.filter(img => img.getBoundingClientRect().top < viewportH);
    const below = allImgs.filter(img => img.getBoundingClientRect().top >= viewportH);
    const lazyBelow = below.filter(img => img.loading === 'lazy' || img.getAttribute('data-src') || img.classList.contains('lazyload'));
    return {
      totalImages: allImgs.length,
      aboveFold: above.length,
      belowFold: below.length,
      lazyLoaded: lazyBelow.length,
      belowWithoutLazy: below.length - lazyBelow.length,
    };
  });

  if (aboveFold.belowFold > 0 && aboveFold.belowWithoutLazy > 5) {
    ctx.testResults.failed++;
    const ss = await safeScreenshot(ctx, page, 'lazy_load_missing');
    addBug(ctx, 'Medium', 'Performance', `${aboveFold.belowWithoutLazy} below-fold images not lazy loaded`, `${aboveFold.belowWithoutLazy} of ${aboveFold.belowFold} below-fold images lack lazy loading \u2014 hurts initial page load`, 'Homepage \u2014 Desktop', ['1. Check images below viewport', '2. Verify loading="lazy" attribute'], 'Below-fold images use lazy loading', `${aboveFold.belowWithoutLazy} images load eagerly`, ss, 'Add loading="lazy" to below-fold images');
  } else {
    ctx.testResults.passed++;
    log(ctx, '\u2705', `Lazy Load: ${aboveFold.lazyLoaded}/${aboveFold.belowFold} below-fold images are lazy loaded`);
  }

  // Scroll and verify images actually load
  ctx.testResults.total++;
  const beforeScroll = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter(i => i.complete && i.naturalWidth > 0).length);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  const afterScroll = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter(i => i.complete && i.naturalWidth > 0).length);

  if (afterScroll >= beforeScroll) {
    ctx.testResults.passed++;
    log(ctx, '\u2705', `Lazy Load: Images loaded after scroll (${beforeScroll} \u2192 ${afterScroll})`);
  } else {
    ctx.testResults.failed++;
    const lazySs = await safeScreenshot(ctx, page, 'lazy_load_fail');
    addBug(ctx, 'Medium', 'Performance', 'Images fail to load on scroll', `Image count dropped from ${beforeScroll} to ${afterScroll} after scrolling`, 'Homepage \u2014 Desktop', ['1. Scroll to bottom'], 'All lazy images load', 'Some images failed to load', lazySs, 'Check lazy loading implementation');
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

module.exports = runLazyLoadTests;
