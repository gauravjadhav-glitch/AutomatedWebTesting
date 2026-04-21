'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runCookieConsentTests(page, discovery, config, ctx) {
  log(ctx, '\uD83C\uDF6A', '--- Cookie Consent Tests ---');
  await safeGoto(page, config.targetUrl);
  await page.waitForTimeout(3000);
  ctx.testResults.total++;

  const cookieBanner = await page.$('[class*="cookie"], [class*="consent"], [class*="Cookie"], [class*="Consent"], [class*="gdpr"], [class*="GDPR"], [id*="cookie"], [id*="consent"], [aria-label*="cookie" i]');

  if (cookieBanner) {
    const isVisible = await cookieBanner.isVisible().catch(() => false);
    if (isVisible) {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'Cookie: Consent banner is displayed');
      await safeScreenshot(ctx, page, 'cookie_consent_banner');

      // Test accept button
      ctx.testResults.total++;
      const acceptBtn = await page.$('[class*="cookie"] button:has-text("Accept"), [class*="consent"] button:has-text("Accept"), [class*="cookie"] button:has-text("OK"), [class*="consent"] button:has-text("Allow"), button:has-text("Accept All"), button:has-text("Accept Cookies")');
      if (acceptBtn) {
        await acceptBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
        const stillVisible = await cookieBanner.isVisible().catch(() => false);
        if (!stillVisible) {
          ctx.testResults.passed++;
          log(ctx, '\u2705', 'Cookie: Banner dismissed after Accept');
        } else {
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, 'cookie_not_dismissed');
          addBug(ctx, 'Medium', 'Cookie Consent', 'Cookie banner not dismissed after Accept', 'Clicking Accept does not hide the cookie consent banner', 'Homepage \u2014 Desktop', ['1. Wait for cookie banner', '2. Click Accept'], 'Banner is hidden', 'Banner still visible', ss, 'Fix dismiss logic on cookie accept handler');
        }
      } else {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, 'cookie_no_accept_btn');
        addBug(ctx, 'Medium', 'Cookie Consent', 'No Accept button on cookie banner', 'Cookie consent banner has no Accept/OK button', 'Homepage \u2014 Desktop', ['1. Check cookie banner'], 'Accept button visible', 'No accept button found', ss, 'Add Accept button to cookie consent component');
      }
    } else {
      ctx.testResults.skipped++;
      log(ctx, '\u2139\uFE0F', 'Cookie: Banner element exists but not visible');
    }
  } else {
    ctx.testResults.skipped++;
    log(ctx, '\u2139\uFE0F', 'Cookie: No consent banner found (may not be required for this region)');
  }
}

module.exports = runCookieConsentTests;
