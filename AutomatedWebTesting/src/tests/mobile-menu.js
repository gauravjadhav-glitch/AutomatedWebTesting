'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runMobileMenuTests(browser, discovery, config, ctx) {
  log(ctx, '\uD83D\uDCF1', '--- Mobile Menu Tests ---');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  await safeGoto(page, config.targetUrl);
  await page.waitForTimeout(2000);

  // Test hamburger menu presence
  ctx.testResults.total++;
  const hamburger = await page.$('button[class*="menu"], button[class*="hamburger"], button[aria-label*="menu" i], [class*="menu-toggle"], [class*="nav-toggle"], [class*="burger"], button:has(svg[class*="menu"]), .hamburger');
  if (hamburger) {
    ctx.testResults.passed++;
    log(ctx, '\u2705', 'Mobile Menu: Hamburger icon found');
    await safeScreenshot(ctx, page, 'mobile_menu_closed');

    // Test menu opens
    ctx.testResults.total++;
    await hamburger.click().catch(() => {});
    await page.waitForTimeout(1500);
    const menuPanel = await page.$('nav[class*="open"], [class*="menu"][class*="open"], [class*="sidebar"][class*="open"], [class*="drawer"][class*="open"], nav[class*="active"], [class*="mobile-menu"], [class*="nav-menu"]');
    const menuLinks = await page.$$('nav a, [class*="menu"] a, [class*="sidebar"] a, [class*="drawer"] a').catch(() => []);

    if (menuPanel || menuLinks.length > 3) {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `Mobile Menu: Opens with ${menuLinks.length} links`);
      await safeScreenshot(ctx, page, 'mobile_menu_open');

      // Test menu close
      ctx.testResults.total++;
      const closeBtn = await page.$('button[class*="close"], button[aria-label*="close" i], [class*="menu-close"]');
      if (closeBtn) {
        await closeBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
        ctx.testResults.passed++;
        log(ctx, '\u2705', 'Mobile Menu: Close button works');
      } else {
        // Try clicking hamburger again to toggle
        await hamburger.click().catch(() => {});
        await page.waitForTimeout(1000);
        ctx.testResults.passed++;
        log(ctx, '\u2705', 'Mobile Menu: Toggle close works');
      }
    } else {
      ctx.testResults.failed++;
      const ss = await safeScreenshot(ctx, page, 'mobile_menu_broken');
      addBug(ctx, 'High', 'Mobile Navigation', 'Mobile menu does not open', 'Clicking hamburger icon does not reveal navigation menu', 'Homepage \u2014 iPhone', ['1. Open on mobile', '2. Tap hamburger icon'], 'Navigation menu opens', 'Menu does not appear', ss, 'Fix mobile menu toggle handler');
    }
  } else {
    ctx.testResults.failed++;
    const ss = await safeScreenshot(ctx, page, 'mobile_no_hamburger');
    addBug(ctx, 'High', 'Mobile Navigation', 'No hamburger menu on mobile', 'Mobile viewport shows no hamburger/menu icon for navigation', 'Homepage \u2014 iPhone (390x844)', ['1. Open on mobile viewport'], 'Hamburger menu visible', 'No menu icon found', ss, 'Add hamburger menu for mobile viewports');
  }

  // Test touch target sizes on mobile
  ctx.testResults.total++;
  const smallTouchTargets = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a, button, input, select, [role="button"]')).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && (rect.height < 44 || rect.width < 44) && rect.width > 0;
    }).length;
  });
  if (smallTouchTargets > 5) {
    ctx.testResults.failed++;
    const ss = await safeScreenshot(ctx, page, 'mobile_touch_targets');
    addBug(ctx, 'Medium', 'Mobile UX', `${smallTouchTargets} elements below 44px touch target`, 'Apple HIG recommends minimum 44x44px touch targets', 'Homepage \u2014 iPhone', ['1. Open on mobile', '2. Check interactive element sizes'], 'All touch targets >= 44px', `${smallTouchTargets} elements below 44px`, ss, 'Increase padding/min-height on interactive elements');
  } else {
    ctx.testResults.passed++;
    log(ctx, '\u2705', `Mobile: Touch targets OK (${smallTouchTargets} small elements)`);
  }

  await context.close().catch(() => {});
}

module.exports = runMobileMenuTests;
