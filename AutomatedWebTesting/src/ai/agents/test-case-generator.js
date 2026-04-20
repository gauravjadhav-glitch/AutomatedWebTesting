'use strict';

const { parseJSON } = require('../utils');

/**
 * Test case generator agent: creates new test scenarios based on
 * discovered pages and bug patterns.
 */
async function generateTestCases(provider, discovery, bugs, isBudgetExceeded) {
  if (isBudgetExceeded()) return [];

  // Summarize discovery data
  const pages = (discovery.livePages || []).slice(0, 15).map(p => p.url || p).join('\n');
  const features = discovery.features || {};

  // Summarize bug patterns
  const bugPatterns = {};
  for (const b of bugs) {
    const key = `${b.category}|${b.location || 'general'}`;
    if (!bugPatterns[key]) bugPatterns[key] = { count: 0, example: b.title };
    bugPatterns[key].count++;
  }
  const topPatterns = Object.entries(bugPatterns)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([key, v]) => `${key}: ${v.count} bugs (e.g., "${v.example}")`)
    .join('\n');

  const res = await provider.chat('gpt-4o-mini', [
    {
      role: 'system',
      content: `You are a senior QA engineer generating test cases for an e-commerce website. Based on the site's discovered pages, features, and bug patterns, generate targeted test cases that would catch the types of bugs being found.

Focus on:
- Pages with most bugs (regression-prone areas)
- Edge cases around detected features (cart, search, auth)
- Cross-device scenarios
- User journey flows that span multiple pages

Return a JSON array of test cases. Each: {"name": "descriptive_test_name", "description": "what to test", "steps": ["step 1", "step 2", ...], "expectedResult": "what should happen", "priority": "P0|P1|P2", "category": "functional|visual|performance|accessibility|security", "pages": ["/path1", "/path2"]}

Generate 8-12 high-value test cases. Prefer actionable, automatable scenarios.`,
    },
    {
      role: 'user',
      content: `Site pages:\n${pages}\n\nDetected features: ${JSON.stringify(features)}\n\nBug patterns:\n${topPatterns}\n\nTotal bugs found: ${bugs.length}`,
    },
  ], 2000);

  if (!res) return [];

  const testCases = parseJSON(res);
  return Array.isArray(testCases) ? testCases : [];
}

module.exports = { generateTestCases };
