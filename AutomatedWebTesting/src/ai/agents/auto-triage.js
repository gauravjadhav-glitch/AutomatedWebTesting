'use strict';

const { parseJSON } = require('../utils');

/**
 * Auto-triage agent: classifies bugs by priority/assignee using historical patterns.
 * Uses the cheaper model (gpt-4o-mini / haiku) for bulk classification.
 */
async function triageBugs(provider, currentBugs, historicalBugs, isBudgetExceeded) {
  if (currentBugs.length === 0 || isBudgetExceeded()) return {};

  // Build historical context: which categories/pages had most bugs historically
  const historyContext = buildHistoryContext(historicalBugs);

  // Process in batches of 15
  const results = {};
  for (let i = 0; i < currentBugs.length; i += 15) {
    if (isBudgetExceeded()) break;
    const batch = currentBugs.slice(i, i + 15);

    const bugList = batch.map((b, idx) => (
      `${idx + 1}. [${b.severity}] ${b.title} — Category: ${b.category}, Page: ${b.location || 'N/A'}, Type: ${b.testType || 'N/A'}`
    )).join('\n');

    const res = await provider.chat('gpt-4o-mini', [
      {
        role: 'system',
        content: `You are a QA triage specialist for an e-commerce website. Classify each bug into an action priority and suggested team owner.

Historical bug patterns for this site:
${historyContext}

Return a JSON array. Each item: {"index": 1, "priority": "P0|P1|P2|P3", "team": "frontend|backend|design|devops|content|seo", "action": "fix_now|fix_next_sprint|monitor|wont_fix", "reason": "one sentence"}

Priority guide:
- P0: Site-breaking, revenue impacting (checkout broken, login fails)
- P1: Major UX issues, high-traffic page problems
- P2: Moderate issues, design inconsistencies
- P3: Minor cosmetic, low-traffic page issues`,
      },
      { role: 'user', content: `Triage these ${batch.length} bugs:\n\n${bugList}` },
    ], 1000);

    if (!res) continue;

    const triage = parseJSON(res);
    if (Array.isArray(triage)) {
      for (const t of triage) {
        const bugIdx = (t.index || 1) - 1 + i;
        if (bugIdx < currentBugs.length) {
          const bugId = currentBugs[bugIdx].id || String(bugIdx);
          results[bugId] = {
            priority: t.priority || 'P2',
            team: t.team || 'frontend',
            action: t.action || 'fix_next_sprint',
            reason: t.reason || '',
          };
        }
      }
    }
  }

  return results;
}

function buildHistoryContext(historicalBugs) {
  if (!historicalBugs || historicalBugs.length === 0) return 'No historical data available.';

  const byCat = {};
  const byPage = {};
  for (const b of historicalBugs) {
    byCat[b.category] = (byCat[b.category] || 0) + 1;
    const loc = b.location || 'unknown';
    byPage[loc] = (byPage[loc] || 0) + 1;
  }

  const topCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topPages = Object.entries(byPage).sort((a, b) => b[1] - a[1]).slice(0, 5);

  return `Top bug categories: ${topCats.map(([c, n]) => `${c} (${n})`).join(', ')}
Most affected pages: ${topPages.map(([p, n]) => `${p} (${n})`).join(', ')}
Total historical bugs: ${historicalBugs.length}`;
}

module.exports = { triageBugs };
