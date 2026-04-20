'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runSanityTests(page, discovery, config, ctx) {
  log(ctx, '\uD83E\uDDEA', '--- Sanity Tests ---');
  const pages = discovery.livePages.slice(0, 20);
  for (const pg of pages) {
    if (ctx.isBudgetExceeded()) break;
    try {
      const resp = await safeGoto(page, pg.url);
      const status = resp ? resp.status() : 0;
      ctx.testResults.total++;

      if (status >= 400 || status === 0) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `sanity_${pg.path.replace(/\//g, '_')}`);
        addBug(ctx, status === 404 ? 'Critical' : 'High', 'Routing', `Page returns ${status}: ${pg.path}`, `The page at ${pg.path} returns HTTP ${status}`, `${pg.path} — Desktop`, ['1. Navigate to ' + pg.url], 'Page loads with 200 OK', `HTTP ${status}`, ss, 'Check server routing and ensure page exists');
      } else {
        // Check for soft 404 — strict: only match headings/dedicated error elements
        const isSoft404 = await page.$('h1:has-text("Page Not Found"), h1:has-text("404"), [class*="not-found"], [class*="error-page"], [class*="page-not-found"]').catch(() => null);
        if (isSoft404) {
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, `sanity_soft404_${pg.path.replace(/\//g, '_')}`);
          addBug(ctx, 'High', 'Routing', `Soft 404 on ${pg.path}`, `Page loads but shows "not found" content`, `${pg.path} — Desktop`, ['1. Navigate to ' + pg.url], 'Valid page content', 'Shows not found / 404 message', ss, 'Check routing configuration');
        } else {
          ctx.testResults.passed++;
        }
      }
    } catch (e) {
      ctx.testResults.total++;
      ctx.testResults.failed++;
    }
  }
}

module.exports = runSanityTests;
