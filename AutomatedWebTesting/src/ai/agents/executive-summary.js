'use strict';

async function generateExecutiveSummary(provider, counts, classified, siteNames, healthScore, isBudgetExceeded) {
  if (isBudgetExceeded()) return '';

  const data = {
    totalBugs: counts.total,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    newBugs: classified.newBugs?.length || 0,
    recurring: classified.recurringBugs?.length || 0,
    fixed: classified.fixedBugs?.length || 0,
    regressions: classified.regressions?.length || 0,
    sites: siteNames,
    healthScore: healthScore || 'N/A',
  };

  const res = await provider.chat('gpt-4o-mini', [
    { role: 'system', content: 'You are a QA director writing an executive summary for stakeholders. Write exactly 3 short paragraphs: (1) Overall quality assessment with key numbers, (2) Critical risk areas and regressions, (3) Recommended immediate actions. Be concise, professional, and data-driven. Use plain text, no markdown headers. Max 150 words total.' },
    { role: 'user', content: `QA Test Run Summary:\n${JSON.stringify(data, null, 2)}` },
  ], 400);

  return res || '';
}

module.exports = { generateExecutiveSummary };
