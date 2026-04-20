'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runSecurityTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD12', '--- Security Tests ---');

  // Check HTTPS
  ctx.testResults.total++;
  if (config.targetUrl.startsWith('https://')) {
    ctx.testResults.passed++;
  } else {
    ctx.testResults.failed++;
    const httpSs = await safeScreenshot(ctx, page, 'security_no_https');
    addBug(ctx, 'Critical', 'Security', 'Site not using HTTPS', 'Site is served over HTTP instead of HTTPS', 'All pages', ['1. Check URL protocol'], 'HTTPS', 'HTTP', httpSs, 'Enable HTTPS/TLS');
  }

  // Check security headers
  ctx.testResults.total++;
  try {
    const resp = await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded' });
    const headers = resp ? resp.headers() : {};
    const missingHeaders = [];
    if (!headers['strict-transport-security']) missingHeaders.push('HSTS');
    if (!headers['x-frame-options'] && !headers['content-security-policy']?.includes('frame-ancestors')) missingHeaders.push('X-Frame-Options');
    if (!headers['x-content-type-options']) missingHeaders.push('X-Content-Type-Options');

    if (missingHeaders.length > 0) {
      ctx.testResults.failed++;
      const headerSs = await safeScreenshot(ctx, page, 'security_missing_headers');
      addBug(ctx, 'Medium', 'Security', `Missing security headers: ${missingHeaders.join(', ')}`, `The following security headers are absent: ${missingHeaders.join(', ')}`, 'All pages', ['1. Check response headers'], 'All security headers present', `Missing: ${missingHeaders.join(', ')}`, headerSs, 'Add missing security headers to server config');
    } else {
      ctx.testResults.passed++;
    }
  } catch (e) { ctx.testResults.skipped++; }

  // XSS test on search
  ctx.testResults.total++;
  if (discovery.features.hasSearch) {
    await safeGoto(page, `${config.targetUrl}/?q=<script>alert('xss')</script>`);
    await page.waitForTimeout(2000);
    const bodyHtml = await page.content();
    if (bodyHtml.includes("<script>alert('xss')</script>")) {
      ctx.testResults.failed++;
      const ss = await safeScreenshot(ctx, page, 'xss_reflected');
      addBug(ctx, 'Critical', 'Security', 'Reflected XSS in search', 'Script tag is reflected in page HTML without sanitization', 'Search — Desktop', ['1. Enter XSS payload in search'], 'Input sanitized', 'Script tag reflected in DOM', ss, 'Sanitize all user input before rendering');
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'Security: No reflected XSS in search');
    }
  } else { ctx.testResults.skipped++; }
}

module.exports = runSecurityTests;
