'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

/**
 * GDPR Compliance Test — checks cookie consent, privacy policy,
 * terms of service, and third-party tracker presence.
 */
async function runGDPRComplianceTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD12', '--- GDPR Compliance Tests ---');

  const homeUrl = config.targetUrl;

  // Test 1: Cookie consent banner
  ctx.testResults.total++;
  try {
    await safeGoto(page, homeUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    const consentSelectors = [
      '[class*="cookie"]', '[id*="cookie"]', '[class*="consent"]', '[id*="consent"]',
      '[class*="gdpr"]', '[id*="gdpr"]', '[class*="privacy-banner"]',
      '[class*="cookie-banner"]', '[class*="cookie-notice"]',
      '[aria-label*="cookie"]', '[aria-label*="consent"]',
    ];

    let consentFound = false;
    for (const sel of consentSelectors) {
      const el = await page.$(sel);
      if (el && await el.isVisible()) {
        consentFound = true;
        break;
      }
    }

    if (!consentFound) {
      // Check if cookies are being set without consent
      const cookies = await page.context().cookies();
      const trackingCookies = cookies.filter(c =>
        !['session', 'csrf', 'cart', '_ga'].some(safe => c.name.toLowerCase().includes(safe)) &&
        c.domain !== new URL(homeUrl).hostname
      );

      if (trackingCookies.length > 0) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, 'gdpr_no_consent');
        addBug(ctx, 'High', 'GDPR/Privacy',
          'Third-party cookies set without consent banner',
          `${trackingCookies.length} third-party cookies found without visible consent mechanism: ${trackingCookies.map(c => c.name).slice(0, 5).join(', ')}`,
          `${homeUrl} — Desktop`,
          ['1. Clear cookies', '2. Visit homepage', '3. Check for consent banner', '4. Inspect cookies'],
          'Cookie consent banner should appear before setting tracking cookies',
          'Third-party cookies set without user consent',
          ss,
          'Add a cookie consent banner that blocks non-essential cookies until accepted'
        );
      } else {
        ctx.testResults.passed++;
        log(ctx, '\u2705', 'GDPR: No consent banner needed (no third-party tracking cookies detected)');
      }
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'GDPR: Cookie consent banner present');
    }
  } catch (e) {
    ctx.testResults.failed++;
    log(ctx, '\u274C', `GDPR consent check failed: ${e.message}`);
  }

  // Test 2: Privacy Policy page
  ctx.testResults.total++;
  try {
    const privacyLinks = await page.$$eval('a', links =>
      links
        .filter(a => /privac|datenschutz|gdpr/i.test(a.textContent + ' ' + (a.href || '')))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
    );

    if (privacyLinks.length === 0) {
      ctx.testResults.failed++;
      addBug(ctx, 'High', 'GDPR/Privacy',
        'No privacy policy link found',
        'Could not find any link to a privacy policy page on the homepage or footer',
        `${homeUrl} — footer/links`,
        ['1. Visit homepage', '2. Look for "Privacy Policy" link in footer or nav'],
        'Privacy policy link should be accessible from every page',
        'No privacy policy link found',
        null,
        'Add a privacy policy link to the footer that links to a comprehensive privacy policy page'
      );
    } else {
      // Verify the link actually works
      const ppUrl = privacyLinks[0].href;
      const response = await page.goto(ppUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      if (response && response.ok()) {
        ctx.testResults.passed++;
        log(ctx, '\u2705', `GDPR: Privacy policy found at ${new URL(ppUrl).pathname}`);
      } else {
        ctx.testResults.failed++;
        addBug(ctx, 'High', 'GDPR/Privacy',
          'Privacy policy link is broken',
          `Privacy policy link "${privacyLinks[0].text}" points to ${ppUrl} but returned ${response?.status() || 'timeout'}`,
          ppUrl,
          ['1. Click privacy policy link', '2. Check page loads'],
          'Privacy policy page loads successfully', 'Page returns error or timeout',
          null, 'Fix the privacy policy URL'
        );
      }
    }
  } catch (e) {
    ctx.testResults.failed++;
  }

  // Test 3: Terms of Service
  ctx.testResults.total++;
  try {
    await safeGoto(page, homeUrl, { waitUntil: 'domcontentloaded' });
    const tosLinks = await page.$$eval('a', links =>
      links
        .filter(a => /terms|conditions|tos|agb|nutzung/i.test(a.textContent + ' ' + (a.href || '')))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
    );

    if (tosLinks.length === 0) {
      ctx.testResults.failed++;
      addBug(ctx, 'Medium', 'GDPR/Privacy',
        'No Terms of Service link found',
        'Could not find Terms & Conditions or Terms of Service link',
        `${homeUrl} — footer`,
        ['1. Visit homepage', '2. Search footer for T&C link'],
        'Terms link should be accessible from every page',
        'No terms link found',
        null,
        'Add Terms & Conditions link to footer'
      );
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `GDPR: Terms of Service link found: "${tosLinks[0].text}"`);
    }
  } catch (e) {
    ctx.testResults.failed++;
  }

  // Test 4: Third-party scripts audit
  ctx.testResults.total++;
  try {
    await safeGoto(page, homeUrl, { waitUntil: 'networkidle' });
    const scripts = await page.$$eval('script[src]', els =>
      els.map(s => {
        try { return new URL(s.src).hostname; } catch { return null; }
      }).filter(Boolean)
    );

    const siteDomain = new URL(homeUrl).hostname;
    const thirdParty = scripts.filter(h => !h.includes(siteDomain) && !h.includes('fynd'));
    const trackers = thirdParty.filter(h =>
      /google-analytics|googletagmanager|facebook|fbevents|hotjar|mixpanel|segment|amplitude/i.test(h)
    );

    if (trackers.length > 0) {
      log(ctx, '\u26A0\uFE0F', `GDPR: ${trackers.length} tracking scripts detected: ${trackers.join(', ')}`);
      // Only flag if no consent banner was found
      const cookies = await page.context().cookies();
      const hasConsent = cookies.some(c => /consent|gdpr|cookie/i.test(c.name));
      if (!hasConsent) {
        ctx.testResults.failed++;
        addBug(ctx, 'Medium', 'GDPR/Privacy',
          `${trackers.length} tracking scripts loaded without consent record`,
          `Tracking scripts: ${trackers.join(', ')}. No consent cookie found.`,
          `${homeUrl}`,
          ['1. Visit homepage', '2. Check network for tracking scripts', '3. Check for consent cookie'],
          'Tracking scripts should only load after user consent',
          'Tracking scripts load on page load without consent verification',
          null,
          'Defer tracking script loading until consent is given'
        );
      } else {
        ctx.testResults.passed++;
      }
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `GDPR: No major tracking scripts detected (${thirdParty.length} third-party scripts total)`);
    }
  } catch (e) {
    ctx.testResults.failed++;
  }
}

module.exports = runGDPRComplianceTests;
