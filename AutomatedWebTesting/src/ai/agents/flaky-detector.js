'use strict';

const { parseJSON } = require('../utils');
const dbBugs = require('../../db/bugs');

/**
 * Flaky detector agent: analyzes bugs that oscillate between present/absent
 * across runs and uses AI to determine root causes.
 */
async function analyzeFlaky(provider, flakyFingerprints, siteName, isBudgetExceeded) {
  if (flakyFingerprints.length === 0 || isBudgetExceeded()) return [];

  // Fetch full bug details for each flaky fingerprint
  const flakyBugs = [];
  for (const fp of flakyFingerprints.slice(0, 10)) {
    const bug = dbBugs.getBugByFingerprint(fp);
    if (bug) {
      flakyBugs.push({
        fingerprint: fp,
        title: bug.title,
        severity: bug.severity,
        category: bug.category,
        location: bug.location,
        testType: bug.test_type,
      });
    }
  }

  if (flakyBugs.length === 0) return [];

  const bugList = flakyBugs.map((b, i) =>
    `${i + 1}. [${b.severity}] "${b.title}" — Category: ${b.category}, Page: ${b.location}, Test: ${b.testType}`
  ).join('\n');

  const res = await provider.chat('gpt-4o-mini', [
    {
      role: 'system',
      content: `You are a QA stability analyst. These bugs are FLAKY — they appear and disappear across test runs on the same e-commerce site. Analyze each and determine the most likely root cause of the flakiness.

Common flaky causes in e-commerce:
- Dynamic content (A/B tests, personalization, randomized product grids)
- Timing issues (lazy loading, async API responses)
- Intermittent third-party services (payment gateways, analytics)
- Session state (login status, cart state)
- Rate limiting or bot detection
- CDN caching inconsistencies

Return a JSON array. Each item: {"index": 1, "rootCause": "one sentence", "confidence": "high|medium|low", "recommendation": "how to stabilize the test or fix the bug", "isTrueBug": true/false}

isTrueBug = true if this is a real bug that intermittently appears (e.g., race condition).
isTrueBug = false if this is a test instability issue (e.g., dynamic content, timing).`,
    },
    { role: 'user', content: `Analyze these ${flakyBugs.length} flaky bugs on "${siteName}":\n\n${bugList}` },
  ], 1000);

  if (!res) return flakyBugs.map(b => ({ ...b, analysis: null }));

  const analysis = parseJSON(res);
  if (Array.isArray(analysis)) {
    for (const a of analysis) {
      const idx = (a.index || 1) - 1;
      if (idx >= 0 && idx < flakyBugs.length) {
        flakyBugs[idx].analysis = {
          rootCause: a.rootCause || '',
          confidence: a.confidence || 'low',
          recommendation: a.recommendation || '',
          isTrueBug: a.isTrueBug !== false,
        };
      }
    }
  }

  return flakyBugs;
}

module.exports = { analyzeFlaky };
