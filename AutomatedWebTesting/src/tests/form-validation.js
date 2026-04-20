'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runFormValidationTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDCDD', '--- Form Validation Tests ---');
  // Test contact form
  const contactPage = discovery.livePages.find(p => p.path === '/contact-us' || p.path === '/contact');
  if (contactPage) {
    await safeGoto(page, contactPage.url);
    ctx.testResults.total++;

    const form = await page.$('form');
    if (form) {
      // Try empty submit
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send")');
      if (submitBtn) {
        await submitBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
        const validationErrors = await page.$$('[class*="error"], [class*="invalid"], .error, .invalid, [aria-invalid="true"]').catch(() => []);
        if (validationErrors.length > 0) {
          ctx.testResults.passed++;
          log(ctx, '\u2705', 'Form: Empty submit shows validation errors');
        } else {
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, 'form_no_validation');
          addBug(ctx, 'Medium', 'Form Validation', 'No validation on empty form submit', 'Submitting empty form shows no validation errors', `${contactPage.path} — Desktop`, ['1. Open contact page', '2. Click submit without filling fields'], 'Validation errors shown', 'No validation errors', ss, 'Add required field validation');
        }
      }
      await safeScreenshot(ctx, page, 'form_validation');
    }
  }
}

module.exports = runFormValidationTests;
