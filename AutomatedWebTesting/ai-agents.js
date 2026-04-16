/**
 * AI Agents for Enhanced QA Testing
 *
 * 4 agents powered by OpenAI GPT-4o / GPT-4o-mini:
 *   1. Visual Bug Detection — GPT-4o Vision analyzes screenshots for UI issues
 *   2. Smart Bug Analysis — AI root cause + fix suggestions for each bug
 *   3. Executive Summary — AI-generated stakeholder summary
 *   4. Test Intelligence — AI-driven test prioritization for next run
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

let client = null;
let totalTokens = { input: 0, output: 0 };
const BUDGET_USD = parseFloat(process.env.AI_BUDGET_USD || '0.50');

// Cost per 1M tokens (approximate)
const COST_MAP = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

function initClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}

function trackUsage(model, usage) {
  if (!usage) return;
  totalTokens.input += usage.prompt_tokens || 0;
  totalTokens.output += usage.completion_tokens || 0;
}

function getUsageCost() {
  // Estimate cost using gpt-4o rates (conservative)
  const rates = COST_MAP['gpt-4o'];
  return (totalTokens.input / 1_000_000 * rates.input) + (totalTokens.output / 1_000_000 * rates.output);
}

function isBudgetExceeded() {
  return getUsageCost() >= BUDGET_USD;
}

function parseJSON(text) {
  // Strip markdown code fences if present
  let clean = text.trim();
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(clean); } catch {}
  // Try extracting JSON array or object from text
  const match = clean.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
  if (match) { try { return JSON.parse(match[1]); } catch {} }
  return null;
}

async function callGPT(model, messages, maxTokens = 500) {
  const api = initClient();
  if (!api || isBudgetExceeded()) return null;
  try {
    const res = await api.chat.completions.create({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.3,
    });
    trackUsage(model, res.usage);
    return res.choices[0]?.message?.content || '';
  } catch (e) {
    console.log(`  [AI] API error: ${e.message.slice(0, 100)}`);
    return null;
  }
}

// ========== AGENT 1: Visual Bug Detection (GPT-4o Vision) ==========

async function analyzeScreenshotsForBugs(screenshots, siteContext) {
  const api = initClient();
  if (!api) return [];

  // Select key screenshots to analyze (max 20, prioritize important pages)
  const priorityKeys = ['page__', '_products', '_cart', '_auth_login', '_contact', '_about', '_collections', '_categories', '_wishlist', '_profile'];
  const allKeys = Object.keys(screenshots);

  const selected = [];
  // First pass: get priority screenshots
  for (const pk of priorityKeys) {
    for (const key of allKeys) {
      if (key.includes(pk) && selected.length < 20) {
        if (!selected.includes(key)) selected.push(key);
      }
    }
  }
  // Fill remaining slots
  for (const key of allKeys) {
    if (selected.length >= 20) break;
    if (!selected.includes(key)) selected.push(key);
  }

  if (selected.length === 0) return [];

  const allBugs = [];
  // Process in batches of 5
  for (let i = 0; i < selected.length; i += 5) {
    if (isBudgetExceeded()) break;
    const batch = selected.slice(i, i + 5);

    const imageContent = batch.map(key => ({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${screenshots[key]}`,
        detail: 'low',
      },
    }));

    const deviceInfo = batch.map(key => {
      const dm = key.match(/(iphone_14_pro|pixel_7|desktop|ipad|4k)/i);
      const pm = key.match(/page_(.+)$/) || key.match(/site\d_(.+?)_(desktop|iphone|pixel)/);
      return `${key}: ${dm ? dm[1] : 'unknown device'}, page: ${pm ? pm[1].replace(/_/g, '/') : 'unknown'}`;
    }).join('\n');

    const content = [
      { type: 'text', text: `You are a senior QA engineer reviewing e-commerce website screenshots from ${siteContext.site1 || 'the site'}.\n\nScreenshot details:\n${deviceInfo}\n\nAnalyze each screenshot for visual/UI bugs:\n- Misaligned or overlapping elements\n- Broken layouts, content overflow\n- Missing images or broken image placeholders\n- Text truncation or overflow\n- Poor mobile responsive design\n- Empty sections that should have content\n- Broken navigation or footer\n- Color/contrast issues\n\nReturn a JSON array of bugs found. Each bug: {"title": "...", "severity": "High|Medium", "category": "UI Alignment|Layout|Responsive|Content|Image Quality", "description": "...", "page": "/path", "device": "device name", "fix": "suggested fix"}\n\nIf no bugs found, return []. Be strict — only report real visual issues, not design preferences.` },
      ...imageContent,
    ];

    const res = await callGPT('gpt-4o', [{ role: 'user', content }], 1000);
    if (!res) continue;

    const bugs = parseJSON(res);
    if (Array.isArray(bugs)) {
      for (const b of bugs) {
        allBugs.push({
          severity: b.severity || 'Medium',
          category: b.category || 'UI Alignment',
          title: `[AI] ${b.title}`,
          description: b.description || '',
          site: siteContext.site1 || '',
          location: b.page || '',
          device: b.device || '',
          steps: `AI Visual Analysis detected this issue on ${b.device || 'the page'}`,
          expected: 'Clean, properly aligned UI without visual defects',
          actual: b.description || b.title,
          fix: b.fix || '',
          testType: 'AI-Visual',
          source: 'gpt-4o-vision',
        });
      }
    }
  }

  return allBugs;
}

// ========== AGENT 2: Smart Bug Analysis (GPT-4o-mini) ==========

async function analyzeBugsWithAI(bugs) {
  if (!initClient() || bugs.length === 0) return {};

  // Take top 20 bugs by severity
  const severityOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  const sorted = [...bugs].sort((a, b) => (severityOrder[a.severity] || 3) - (severityOrder[b.severity] || 3));
  const top = sorted.slice(0, 20);

  const bugList = top.map((b, i) => `BUG-${String(b.id).padStart(3, '0')}: [${b.severity}] ${b.title} — ${b.description?.slice(0, 150) || ''} (Category: ${b.category}, Page: ${b.location || 'N/A'})`).join('\n');

  const res = await callGPT('gpt-4o-mini', [
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

  // Merge back into bugs
  for (const b of bugs) {
    const bugId = `BUG-${String(b.id).padStart(3, '0')}`;
    if (result[bugId]) b.aiAnalysis = result[bugId];
  }

  return result;
}

// ========== AGENT 3: Executive Summary (GPT-4o-mini) ==========

async function generateExecutiveSummary(counts, classified, siteNames, healthScore) {
  if (!initClient()) return '';

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

  const res = await callGPT('gpt-4o-mini', [
    { role: 'system', content: 'You are a QA director writing an executive summary for stakeholders. Write exactly 3 short paragraphs: (1) Overall quality assessment with key numbers, (2) Critical risk areas and regressions, (3) Recommended immediate actions. Be concise, professional, and data-driven. Use plain text, no markdown headers. Max 150 words total.' },
    { role: 'user', content: `QA Test Run Summary:\n${JSON.stringify(data, null, 2)}` },
  ], 400);

  return res || '';
}

// ========== AGENT 4: Test Intelligence (GPT-4o-mini) ==========

async function generateTestIntelligence(discovery1, discovery2, knowledge, bugs) {
  if (!initClient()) return null;

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

  const res = await callGPT('gpt-4o-mini', [
    { role: 'system', content: 'You are a test strategy AI. Given site discovery data and bug analysis, suggest test improvements. Return JSON: {"prioritizedPages": ["top 5 pages needing more testing"], "focusCategories": ["top 3 bug categories to focus on"], "riskPatterns": ["2-3 emerging risk patterns"], "recommendations": ["3 actionable recommendations for next test run"]}' },
    { role: 'user', content: `Test Intelligence Data:\n${JSON.stringify(data, null, 2)}` },
  ], 500);

  if (!res) return null;

  const intel = parseJSON(res);

  // Save to knowledge
  try {
    const knowledgeDir = path.join(__dirname, 'knowledge');
    if (!fs.existsSync(knowledgeDir)) fs.mkdirSync(knowledgeDir, { recursive: true });
    fs.writeFileSync(path.join(knowledgeDir, 'ai-suggestions.json'), JSON.stringify(intel, null, 2));
  } catch {}

  return intel;
}

module.exports = {
  analyzeScreenshotsForBugs,
  analyzeBugsWithAI,
  generateExecutiveSummary,
  generateTestIntelligence,
  getUsageCost,
  isAvailable: () => !!process.env.OPENAI_API_KEY,
};
