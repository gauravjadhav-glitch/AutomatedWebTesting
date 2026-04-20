'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runPerformanceTests(page, discovery, config, ctx) {
  log(ctx, '\u26A1', '--- Performance Tests ---');
  const pagesToTest = discovery.livePages.slice(0, 5);

  for (const pg of pagesToTest) {
    if (ctx.isBudgetExceeded()) break;
    ctx.testResults.total++;
    try {
      const startNav = Date.now();
      await page.goto(pg.url, { waitUntil: 'load', timeout: 30000 });
      const loadTime = Date.now() - startNav;

      // Measure web vitals via Performance API
      const vitals = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0] || {};
        const paint = performance.getEntriesByType('paint');
        const fcp = paint.find(p => p.name === 'first-contentful-paint');
        return {
          ttfb: perf.responseStart ? Math.round(perf.responseStart - perf.requestStart) : null,
          fcp: fcp ? Math.round(fcp.startTime) : null,
          domSize: document.querySelectorAll('*').length,
          loadTime: Math.round(perf.loadEventEnd - perf.navigationStart) || null,
        };
      });

      // Store metrics for the report's Performance section
      ctx.perfData.push({
        path: pg.path, status: pg.status || 200,
        loadTime, fcp: vitals.fcp, lcp: vitals.fcp, // LCP approximation
        cls: 0, ttfb: vitals.ttfb, requests: null,
        transferSize: null, domNodes: vitals.domSize,
      });

      const issues = [];
      if (vitals.fcp && vitals.fcp > 3000) issues.push(`FCP: ${vitals.fcp}ms (poor, >3000ms)`);
      if (vitals.ttfb && vitals.ttfb > 800) issues.push(`TTFB: ${vitals.ttfb}ms (poor, >800ms)`);
      if (vitals.domSize > 3000) issues.push(`DOM size: ${vitals.domSize} elements (warning, >3000)`);
      if (loadTime > 10000) issues.push(`Total load: ${loadTime}ms (>10s)`);

      if (issues.length > 0) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `perf_${pg.path.replace(/\//g, '_')}`);
        addBug(ctx, vitals.fcp > 4000 || loadTime > 15000 ? 'High' : 'Medium', 'Performance', `Performance issues on ${pg.path}`, issues.join('; '), `${pg.path} — Desktop`, ['1. Load ' + pg.url, '2. Measure Core Web Vitals'], 'FCP <1800ms, TTFB <200ms, DOM <3000', issues.join('; '), ss, 'Optimize loading performance');
      } else {
        ctx.testResults.passed++;
        log(ctx, '\u2705', `Perf: ${pg.path} — FCP:${vitals.fcp || '?'}ms TTFB:${vitals.ttfb || '?'}ms DOM:${vitals.domSize}`);
      }
    } catch (e) {
      ctx.testResults.failed++;
    }
  }
}

module.exports = runPerformanceTests;
