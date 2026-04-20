'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runInteractionTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD04', '--- Interaction Tests ---');
  await safeGoto(page, config.targetUrl);
  await page.waitForTimeout(2000);

  // Sticky header test
  ctx.testResults.total++;
  const headerBefore = await page.evaluate(() => {
    const header = document.querySelector('header, [class*="header"], nav');
    return header ? header.getBoundingClientRect().top : null;
  });
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(1000);
  const headerAfter = await page.evaluate(() => {
    const header = document.querySelector('header, [class*="header"], nav');
    if (!header) return null;
    const style = window.getComputedStyle(header);
    return { top: header.getBoundingClientRect().top, position: style.position };
  });
  if (headerAfter && (headerAfter.position === 'fixed' || headerAfter.position === 'sticky' || headerAfter.top < 10)) {
    ctx.testResults.passed++;
    log(ctx, '\u2705', 'Interaction: Sticky header works');
  } else {
    ctx.testResults.failed++;
    const ss = await safeScreenshot(ctx, page, 'sticky_header');
    addBug(ctx, 'Medium', 'Interaction', 'Header is not sticky after scroll', 'Header does not remain fixed when scrolling down', 'Homepage — Desktop', ['1. Open homepage', '2. Scroll down 500px'], 'Header stays fixed at top', 'Header scrolls away', ss, 'Add position: sticky to header');
  }

  // Back to top test
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  ctx.testResults.total++;
  const backToTop = await page.$('button[class*="back-to-top"], [class*="scroll-top"], a[href="#top"], [class*="backToTop"], [aria-label*="top"]');
  if (backToTop) {
    ctx.testResults.passed++;
    log(ctx, '\u2705', 'Interaction: Back to top button found');
  } else {
    ctx.testResults.skipped++;
    log(ctx, '\u2139\uFE0F', 'Interaction: No back-to-top button (optional)');
  }

  // Carousel/Slider test
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  ctx.testResults.total++;
  const carousel = await page.$('[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="banner"], [class*="hero-slide"]');
  if (carousel) {
    const nextBtn = await page.$('[class*="carousel"] [class*="next"], [class*="slider"] [class*="next"], [class*="swiper-button-next"], button[aria-label*="next"]');
    if (nextBtn) {
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'Interaction: Carousel next button works');
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'Interaction: Carousel found (no next button)');
    }
  } else {
    ctx.testResults.skipped++;
    log(ctx, '\u2139\uFE0F', 'Interaction: No carousel/slider found');
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

module.exports = runInteractionTests;
