'use strict';

const fs = require('fs');
const path = require('path');
const { parseJSON } = require('../utils');

async function generateTestIntelligence(provider, discovery1, discovery2, knowledge, bugs, isBudgetExceeded) {
  if (isBudgetExceeded()) return null;

  const bugSummary = {};
  for (const b of bugs) {
    const cat = b.category || 'Other';
    bugSummary[cat] = (bugSummary[cat] || 0) + 1;
  }

  const pageBugs = {};
  for (const b of bugs) {
    const loc = b.location || 'unknown';
    pageBugs[loc] = (pageBugs[loc] || 0) + 1;
  }

  const data = {
    pagesDiscovered: discovery1?.pages?.length || 0,
    features: discovery1?.features || {},
    bugsByCategory: bugSummary,
    bugsByPage: pageBugs,
    totalBugs: bugs.length,
    historicalRuns: knowledge?.history?.runs?.length || 0,
  };

  const res = await provider.chat('gpt-4o-mini', [
    { role: 'system', content: 'You are a test strategy AI. Given site discovery data and bug analysis, suggest test improvements. Return JSON: {"prioritizedPages": ["top 5 pages needing more testing"], "focusCategories": ["top 3 bug categories to focus on"], "riskPatterns": ["2-3 emerging risk patterns"], "recommendations": ["3 actionable recommendations for next test run"]}' },
    { role: 'user', content: `Test Intelligence Data:\n${JSON.stringify(data, null, 2)}` },
  ], 500);

  if (!res) return null;

  const intel = parseJSON(res);

  try {
    const knowledgeDir = path.join(__dirname, '..', '..', '..', 'knowledge');
    if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'ai-suggestions.json'), JSON.stringify(intel, null, 2));
  } catch {}

  return intel;
}

module.exports = { generateTestIntelligence };
