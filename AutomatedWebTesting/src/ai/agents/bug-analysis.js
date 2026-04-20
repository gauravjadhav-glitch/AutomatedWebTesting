'use strict';

const { parseJSON } = require('../utils');

async function analyzeBugsWithAI(provider, bugs, isBudgetExceeded) {
  if (bugs.length === 0 || isBudgetExceeded()) return {};

  const severityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const sorted = [...bugs].sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));
  const top = sorted.slice(0, 20);

  const bugList = top.map((b) => `BUG-${String(b.id).padStart(3, '0')}: [${b.severity}] ${b.title} — ${b.description?.slice(0, 150) || ''} (Category: ${b.category}, Page: ${b.location || 'N/A'})`).join('\n');

  const res = await provider.chat('gpt-4o-mini', [
    { role: 'system', content: 'You are a senior QA lead analyzing bugs from an e-commerce website test run. For each bug, provide a root cause analysis and recommended fix. Return a JSON array where each item has: {"bugId": "BUG-001", "rootCause": "one sentence", "recommendedFix": "one sentence", "impact": "Critical|High|Medium|Low"}' },
    { role: 'user', content: `Analyze these ${top.length} bugs:\n\n${bugList}` },
  ], 1500);

  if (!res) return {};

  const analysis = parseJSON(res);
  const result = {};
  if (Array.isArray(analysis)) {
    for (const a of analysis) {
      if (a.bugId) {
        result[a.bugId] = {
          rootCause: a.rootCause || '',
          recommendedFix: a.recommendedFix || '',
          impact: a.impact || '',
        };
      }
    }
  }

  for (const b of bugs) {
    const bugId = `BUG-${String(b.id).padStart(3, '0')}`;
    if (result[bugId]) b.aiAnalysis = result[bugId];
  }

  return result;
}

module.exports = { analyzeBugsWithAI };
