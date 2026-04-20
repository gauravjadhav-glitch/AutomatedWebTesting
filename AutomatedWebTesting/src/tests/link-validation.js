'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runLinkValidation(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD17', '--- Link Validation ---');
  const allLinks = [...discovery.navLinks, ...discovery.footerLinks];
  const checked = new Set();

  for (const link of allLinks.slice(0, 30)) {
    if (ctx.isBudgetExceeded()) break;
    let href = link.href;
    if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (!href.startsWith('http')) href = `${config.targetUrl}${href.startsWith('/') ? '' : '/'}${href}`;
    if (checked.has(href)) continue;
    checked.add(href);

    // Only check internal links
    try {
      const linkUrl = new URL(href);
      if (linkUrl.hostname !== new URL(config.targetUrl).hostname) continue;
    } catch (e) { continue; }

    ctx.testResults.total++;
    try {
      const resp = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = resp ? resp.status() : 0;
      if (status >= 400) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `link_broken_${link.text.replace(/\W/g, '_').slice(0, 30)}`);
        addBug(ctx, 'High', 'Navigation', `Broken link: "${link.text}" → ${status}`, `Link "${link.text}" (${href}) returns HTTP ${status}`, 'Navigation/Footer — Desktop', ['1. Click "' + link.text + '"'], 'Link loads (200)', `HTTP ${status}`, ss, 'Fix link URL or remove dead link');
      } else {
        ctx.testResults.passed++;
      }
    } catch (e) {
      ctx.testResults.total++;
      ctx.testResults.failed++;
    }
  }
}

module.exports = runLinkValidation;
