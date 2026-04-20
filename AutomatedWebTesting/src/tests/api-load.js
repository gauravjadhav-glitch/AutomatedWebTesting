'use strict';

const { log, addBug } = require('../utils');

/**
 * API Load Test — sends concurrent requests to discovered endpoints
 * and checks for slow responses, errors, and timeouts.
 */
async function runApiLoadTests(page, discovery, config, ctx) {
  log(ctx, '\u26A1', '--- API Load Tests ---');

  const endpoints = discovery.livePages.slice(0, 10).map(p => p.url || p);
  if (endpoints.length === 0) {
    log(ctx, '\u26A0\uFE0F', 'No endpoints to test');
    return;
  }

  const concurrency = 10;
  const thresholdMs = 5000;

  for (const url of endpoints) {
    if (ctx.isBudgetExceeded()) break;
    ctx.testResults.total++;

    try {
      // Send concurrent requests from the browser context
      const results = await page.evaluate(async ({ url, concurrency, thresholdMs }) => {
        const requests = [];
        for (let i = 0; i < concurrency; i++) {
          requests.push(
            (async () => {
              const start = performance.now();
              try {
                const res = await fetch(url, {
                  method: 'GET',
                  cache: 'no-store',
                  signal: AbortSignal.timeout(thresholdMs * 2),
                });
                const elapsed = Math.round(performance.now() - start);
                return { status: res.status, time: elapsed, ok: res.ok };
              } catch (e) {
                const elapsed = Math.round(performance.now() - start);
                return { status: 0, time: elapsed, ok: false, error: e.message.slice(0, 80) };
              }
            })()
          );
        }
        return Promise.all(requests);
      }, { url, concurrency, thresholdMs });

      const times = results.map(r => r.time);
      const avgTime = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
      const maxTime = Math.max(...times);
      const failCount = results.filter(r => !r.ok).length;
      const errorCodes = [...new Set(results.filter(r => !r.ok && r.status > 0).map(r => r.status))];

      const path = new URL(url).pathname;
      const issues = [];

      if (avgTime > thresholdMs) issues.push(`Avg response: ${avgTime}ms (>${thresholdMs}ms)`);
      if (maxTime > thresholdMs * 2) issues.push(`Max response: ${maxTime}ms (>${thresholdMs * 2}ms)`);
      if (failCount > 0) issues.push(`${failCount}/${concurrency} requests failed (status: ${errorCodes.join(', ') || 'timeout'})`);

      if (issues.length > 0) {
        ctx.testResults.failed++;
        const severity = failCount > concurrency / 2 ? 'High' : 'Medium';
        addBug(ctx, severity, 'Performance',
          `API load issues on ${path}`,
          issues.join('; '),
          `${path} — ${concurrency} concurrent requests`,
          [`1. Send ${concurrency} concurrent GET requests to ${url}`, '2. Measure response times'],
          `All requests respond <${thresholdMs}ms with 200 status`,
          issues.join('; '),
          null,
          'Optimize server response time, check rate limiting'
        );
      } else {
        ctx.testResults.passed++;
        log(ctx, '\u2705', `API Load: ${path} — avg:${avgTime}ms max:${maxTime}ms (${concurrency} reqs, all OK)`);
      }
    } catch (e) {
      ctx.testResults.failed++;
      log(ctx, '\u274C', `API Load test failed for ${url}: ${e.message}`);
    }
  }
}

module.exports = runApiLoadTests;
