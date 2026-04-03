#!/usr/bin/env node
/**
 * Dynamic Website Comparison & Bug Report Generator
 *
 * Usage:
 *   node run-test.js <site1-url> <site2-url>
 *
 * Discovers site structure, generates dynamic test plan, executes all tests,
 * and produces a comprehensive HTML report with unlimited bug discovery.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const advanced = require('./tests/advanced-tests');
const fourK = require('./tests/4k-tests');
const learning = require('./learning-engine');

// ===== Parse URLs and Mode from CLI =====
const args = process.argv.slice(2);
const flagArgs = args.filter(a => a.startsWith('--'));
const urlArgs = args.filter(a => !a.startsWith('--'));

if (urlArgs.length < 1) {
  console.error('\n  Usage: node run-test.js <url> [second-url] [--mode=fast|standard|deep]\n');
  console.error('  Example: node run-test.js https://mysite.com --mode=fast\n');
  console.error('  Compare: node run-test.js https://production.com https://staging.com --mode=fast\n');
  process.exit(1);
}

let SITE1 = urlArgs[0].replace(/\/+$/, '');
let SITE2 = urlArgs[1] ? urlArgs[1].replace(/\/+$/, '') : null;
if (!SITE1.startsWith('http')) SITE1 = 'https://' + SITE1;
if (SITE2 && !SITE2.startsWith('http')) SITE2 = 'https://' + SITE2;
const SINGLE_MODE = !SITE2;
if (SINGLE_MODE) SITE2 = SITE1; // use same site so loops work without branching everywhere

// ===== Execution Mode =====
const modeArg = flagArgs.find(a => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.split('=')[1] : 'standard';
const VALID_MODES = ['fast', 'standard', 'deep'];
if (!VALID_MODES.includes(MODE)) {
  console.error(`\n  Invalid mode "${MODE}". Use: fast, standard, or deep\n`);
  process.exit(1);
}

// ===== Runtime Budget Configuration =====
const RUNTIME_BUDGETS = {
  fast: {
    totalMs: 10 * 60 * 1000,       // 10 minutes hard stop
    softStopMs: 8 * 60 * 1000,     // 8 minutes soft stop
    pageTimeoutMs: 15000,
    elementTimeoutMs: 4000,
    maxCrawlPages: 15,
    mobileDevices: ['iPhone 14 Pro'], // only 1 mobile in fast mode (3 total devices: Desktop, iPhone 14 Pro, Pixel 7)
    footerLinkSampleSize: 5,
    screenshotPolicy: 'failures-and-key-checkpoints',
    skipDeepAccessibility: true,
    skipFullFooterCrawl: true,
    skipFullFontCheck: true,
    skipExploratory: true,
    skipWishlist: true,
    skipInventory: true,
    skipSecurity: true,
    performancePages: ['home'],
  },
  standard: {
    totalMs: 20 * 60 * 1000,
    softStopMs: 17 * 60 * 1000,
    pageTimeoutMs: 30000,
    elementTimeoutMs: 10000,
    maxCrawlPages: 30,
    mobileDevices: null, // all devices
    footerLinkSampleSize: null, // all
    screenshotPolicy: 'all',
    skipDeepAccessibility: false,
    skipFullFooterCrawl: false,
    skipFullFontCheck: false,
    skipExploratory: false,
    skipWishlist: false,
    skipInventory: false,
    skipSecurity: false,
    performancePages: null,
  },
  deep: {
    totalMs: 60 * 60 * 1000,
    softStopMs: 55 * 60 * 1000,
    pageTimeoutMs: 30000,
    elementTimeoutMs: 10000,
    maxCrawlPages: 100,
    mobileDevices: null,
    footerLinkSampleSize: null,
    screenshotPolicy: 'all',
    skipDeepAccessibility: false,
    skipFullFooterCrawl: false,
    skipFullFontCheck: false,
    skipExploratory: false,
    skipWishlist: false,
    skipInventory: false,
    skipSecurity: false,
    performancePages: null,
  },
};

const BUDGET = RUNTIME_BUDGETS[MODE];

// ===== Budget Manager =====
function createBudgetManager(budget) {
  const start = Date.now();
  return {
    start,
    elapsedMs() { return Date.now() - start; },
    elapsedSec() { return Math.round((Date.now() - start) / 1000); },
    remainingMs() { return Math.max(0, budget.totalMs - (Date.now() - start)); },
    shouldSoftStop() { return (Date.now() - start) >= budget.softStopMs; },
    shouldHardStop() { return (Date.now() - start) >= budget.totalMs; },
    canRunPhase(estimatedMs = 30000) { return (Date.now() - start + estimatedMs) < budget.softStopMs; },
    tierAllowed() {
      const remaining = budget.totalMs - (Date.now() - start);
      if (remaining > budget.softStopMs * 0.6) return 3; // >60% of soft stop: all tiers
      if (remaining > 2 * 60 * 1000) return 2;           // >2 min: tier 1+2
      return 1;                                           // <2 min: tier 1 only
    },
  };
}

const REPORT_DIR = path.join(__dirname, 'reports');
const SS_DIR = path.join(__dirname, 'screenshots');
fs.mkdirSync(REPORT_DIR, { recursive: true });
fs.mkdirSync(SS_DIR, { recursive: true });

// ===== State =====
const screenshots = {};
const bugs = [];
const pageData = {};

function log(msg) { console.log(msg); }
// Extract readable site name from URL (e.g. "https://brooksbrothers.in" → "brooksbrothers.in")
function siteName(url) { try { return new URL(url).hostname; } catch { return url; } }
const SITE1_NAME = siteName(SITE1);
const SITE2_NAME = SITE2 ? siteName(SITE2) : SITE1_NAME;
// Site iteration helpers
// 1 URL  → test that site
// 2 URLs → Site 1 = Production (reference only), Site 2 = UAT (test target)
//          Discovery runs on BOTH, but tests only run on Site 2
function siteList() { return SINGLE_MODE ? [[SITE1, 'site1']] : [[SITE2, 'site2']]; }
function siteDiscList(d1, d2) { return SINGLE_MODE ? [[SITE1, 'site1', d1]] : [[SITE2, 'site2', d2]]; }
function siteDiscPairs(d1, d2) { return SINGLE_MODE ? [[d1, SITE1_NAME]] : [[d2, SITE2_NAME]]; }
// For discovery/comparison we still need both sites
function bothSiteList() { return SINGLE_MODE ? [[SITE1, 'site1']] : [[SITE1, 'site1'], [SITE2, 'site2']]; }

// ===== Main =====
(async () => {
  let browser;
  try {
  const budget = createBudgetManager(BUDGET);
  const startTime = budget.start;
  const modeLabel = MODE.toUpperCase();
  const budgetMin = Math.round(BUDGET.totalMs / 60000);
  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log(SINGLE_MODE
    ? '  ║   Dynamic Website QA & Bug Reporter              ║'
    : '  ║   Dynamic Website Comparison & Bug Reporter     ║');
  console.log(`  ║   Mode: ${modeLabel.padEnd(8)} | Budget: ${budgetMin} min${' '.repeat(20 - String(budgetMin).length)}║`);
  console.log('  ╚══════════════════════════════════════════════════╝\n');
  if (SINGLE_MODE) {
    console.log(`  Target: ${SITE1}`);
  } else {
    console.log(`  Production (reference): ${SITE1}`);
    console.log(`  UAT (testing):          ${SITE2}`);
    console.log(`  → Only Site 2 (UAT) will be tested. Site 1 is for comparison only.`);
  }
  console.log(`  Mode: ${modeLabel} (${budgetMin} min budget, soft stop at ${Math.round(BUDGET.softStopMs / 60000)} min)`);
  console.log('');

  // Read SKILL.md for testing approach
  const skillPath = path.join(__dirname, '.agent', 'skills', 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    log('  [INIT] Loaded SKILL.md testing reference.');
  }

  // ===== LEARNING ENGINE: Load past knowledge =====
  const knowledge = learning.loadKnowledge();
  const comparison = learning.getRunComparison(knowledge);
  if (comparison.hasHistory) {
    log(`  [BRAIN] Run #${comparison.totalRuns + 1} | Previous: ${comparison.previousRun.bugCount} bugs | Avg: ${comparison.averageBugs} bugs | Trend: ${comparison.bugTrend}`);
    const priorities = learning.getTestPriorities(knowledge, [SITE1, SITE2]);
    if (priorities.highRiskPaths.length > 0) {
      log(`  [BRAIN] High-risk paths: ${priorities.highRiskPaths.slice(0, 5).map(p => p.path).join(', ')}`);
    }
    if (priorities.focusAreas.length > 0) {
      log(`  [BRAIN] Focus areas: ${priorities.focusAreas.slice(0, 3).map(a => `${a.category}(${a.totalBugs})`).join(', ')}`);
    }
  } else {
    log('  [BRAIN] First run — establishing baseline knowledge.');
  }

  const browser = await chromium.launch();

  // ============================================================
  // PHASE 0: LOGIN FIRST — Authenticate before discovery
  // ============================================================
  console.log('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PHASE 0: LOGIN (Authenticated Crawl)');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Login to get authenticated context — pages like /profile, /orders show real data
  const authResult1 = await advanced.loginAndGetContext(browser, SITE1, log);
  const authResult2 = SINGLE_MODE ? authResult1 : await advanced.loginAndGetContext(browser, SITE2, log);
  pageData.auth = {
    site1LoggedIn: authResult1.loggedIn,
    site2LoggedIn: authResult2?.loggedIn || false,
  };

  // ============================================================
  // PHASE 1: DISCOVERY — Deep crawl both sites (now authenticated)
  // ============================================================
  console.log('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PHASE 1: SITE DISCOVERY' + (authResult1.loggedIn ? ' (AUTHENTICATED)' : ''));
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const discoverOpts = { maxPages: BUDGET.maxCrawlPages, pageTimeout: BUDGET.pageTimeoutMs, mode: MODE };
  const discovery1 = await advanced.discoverSite(browser, SITE1, 'site1', log, discoverOpts);
  const discovery2 = SINGLE_MODE ? discovery1 : await advanced.discoverSite(browser, SITE2, 'site2', log, discoverOpts);

  pageData.discovery1 = {
    totalPages: discovery1.pages.length,
    livePages: discovery1.pages.filter(p => p.status === 200).length,
    deadPages: discovery1.pages.filter(p => p.status === 404).length,
    features: discovery1.features,
    productCount: discovery1.productLinks.length,
    formCount: discovery1.forms.length,
    consoleErrors: discovery1.consoleErrors.length,
    networkErrors: discovery1.networkErrors.length,
  };
  pageData.discovery2 = {
    totalPages: discovery2.pages.length,
    livePages: discovery2.pages.filter(p => p.status === 200).length,
    deadPages: discovery2.pages.filter(p => p.status === 404).length,
    features: discovery2.features,
    productCount: discovery2.productLinks.length,
    formCount: discovery2.forms.length,
    consoleErrors: discovery2.consoleErrors.length,
    networkErrors: discovery2.networkErrors.length,
  };

  // ============================================================
  // PHASE 2: GENERATE DYNAMIC TEST PLAN
  // ============================================================
  console.log('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PHASE 2: GENERATING TEST PLAN');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const testPlan = advanced.generateTestPlan(discovery1, discovery2, log);

  // ===== LEARNING ENGINE: Suggest additional tests from past knowledge =====
  const suggestions = learning.suggestNewTests(discovery1, discovery2, knowledge);
  if (suggestions.length > 0) {
    log(`  [BRAIN] ${suggestions.length} test suggestions from learning engine:`);
    let sugId = testPlan.length;
    for (const s of suggestions.filter(s => s.priority === 'high').slice(0, 10)) {
      log(`    + ${s.name} (${s.reason})`);
      if (s.path && !testPlan.some(t => t.path === s.path && t.type === 'sanity')) {
        testPlan.push({ id: ++sugId, type: 'sanity', subtype: 'page_load', name: `[LEARNED] Page Load: ${s.path}`, path: s.path, fromLearning: true });
      }
    }
  }
  pageData.testPlan = testPlan;
  pageData.learningSuggestions = suggestions;

  // Group tests by type
  const testsByType = {};
  for (const t of testPlan) {
    if (!testsByType[t.type]) testsByType[t.type] = [];
    testsByType[t.type].push(t);
  }

  console.log(`\n  ┌──────────────────────────────────────────────────┐`);
  console.log(`  │  TEST PLAN — ${SINGLE_MODE ? siteName(SITE1) : siteName(SITE2) + ' (UAT)'}${' '.repeat(Math.max(0, 35 - (SINGLE_MODE ? siteName(SITE1).length : siteName(SITE2).length + 6)))}│`);
  console.log(`  ├──────────────────────────────────────────────────┤`);
  for (const [type, tests] of Object.entries(testsByType)) {
    const label = `  │  ${type.padEnd(20)} ${String(tests.length).padStart(3)} tests`;
    console.log(`${label}${' '.repeat(Math.max(0, 53 - label.length))}│`);
  }
  const totalLine = `  │  TOTAL${' '.repeat(15)}${String(testPlan.length).padStart(3)} test cases`;
  console.log(`  ├──────────────────────────────────────────────────┤`);
  console.log(`${totalLine}${' '.repeat(Math.max(0, 53 - totalLine.length))}│`);
  if (!SINGLE_MODE) {
    console.log(`  │  Testing: ${siteName(SITE2)} only${' '.repeat(Math.max(0, 41 - siteName(SITE2).length - 5))}│`);
    console.log(`  │  Reference: ${siteName(SITE1)} (prod, no bugs reported)${' '.repeat(Math.max(0, 53 - siteName(SITE1).length - 41))}│`);
  }
  console.log(`  └──────────────────────────────────────────────────┘\n`);

  // ============================================================
  // PHASE 3: EXECUTE ALL TESTS (Budget-Aware)
  // ============================================================
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  PHASE 3: EXECUTING TESTS [${modeLabel} MODE]`);
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  let completed = 0;
  const total = testPlan.length;
  const skippedPhases = [];
  const executedPhases = [];
  const phaseTimings = {};
  function startPhase(name) { phaseTimings[name] = { start: Date.now(), end: null, duration: 0 }; }
  function endPhase(name) { if (phaseTimings[name]) { phaseTimings[name].end = Date.now(); phaseTimings[name].duration = Math.round((phaseTimings[name].end - phaseTimings[name].start) / 1000); } }

  function progress(testName) {
    completed++;
    const pct = Math.round((completed / total) * 100);
    const elapsed = budget.elapsedSec();
    const remaining = Math.round(budget.remainingMs() / 1000);
    process.stdout.write(`\r  [${completed}/${total}] (${pct}%) [${elapsed}s/${remaining}s left] ${testName.substring(0, 50).padEnd(50)}`);
  }

  function skipPhase(name, tests, reason) {
    skippedPhases.push(name);
    if (tests) for (const t of tests) { completed++; }
    if (reason) console.log(`\n  [SKIP] ${name}: ${reason}`);
  }

  function canRun(phaseName, tier, tests) {
    if (budget.shouldHardStop()) {
      skipPhase(phaseName, tests, 'hard budget limit reached');
      return false;
    }
    if (budget.shouldSoftStop() && tier > 1) {
      skipPhase(phaseName, tests, 'soft stop — only Tier 1 allowed');
      return false;
    }
    if (budget.tierAllowed() < tier) {
      skipPhase(phaseName, tests, `Tier ${tier} skipped (budget)${MODE === 'fast' ? ' [fast mode]' : ''}`);
      return false;
    }
    return true;
  }

  // ── TIER 1: SANITY — Page Load Tests (Critical) ──
  const sanityTests = testsByType['sanity'] || [];
  if (sanityTests.length > 0 && canRun('Sanity', 1, sanityTests)) {
    executedPhases.push('sanity');
    startPhase('Sanity');
    console.log(`  Running ${sanityTests.length} sanity tests...`);
    for (const test of sanityTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of bothSiteList()) {
        await advanced.runPageLoadTest(browser, siteUrl, label, test.path, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Sanity');
    console.log('');
  }

  // ── PERFORMANCE (Tier 1 — always run, before visual to ensure budget) ──
  const perfTests = testsByType['performance'] || [];
  if (perfTests.length > 0 && canRun('Performance', 1, perfTests)) {
    executedPhases.push('performance');
    startPhase('Performance');
    console.log(`\n  Running ${perfTests.length} performance tests...`);
    for (const test of perfTests) {
      if (budget.shouldHardStop()) break;
      if (MODE === 'fast' && test.path !== '/') { progress(test.name); continue; }
      for (const [siteUrl, label] of siteList()) {
        await advanced.runPerformanceTest(browser, siteUrl, label, test.path, bugs, pageData);
      }
      progress(test.name);
    }
    endPhase('Performance');
    console.log('');
  }

  // ── ACCESSIBILITY (Tier 1 — always run, before visual to ensure budget) ──
  const a11yTests = testsByType['accessibility'] || [];
  if (a11yTests.length > 0 && canRun('Accessibility', 1, a11yTests)) {
    executedPhases.push('accessibility');
    startPhase('Accessibility');
    console.log(`\n  Running ${a11yTests.length} accessibility tests...`);
    for (const test of a11yTests) {
      if (budget.shouldHardStop()) break;
      if (MODE === 'fast' && test.path !== '/') { progress(test.name); continue; }
      for (const [siteUrl, label] of siteList()) {
        await advanced.runAccessibilityTest(browser, siteUrl, label, test.path, bugs, pageData);
      }
      progress(test.name);
    }
    endPhase('Accessibility');
    console.log('');
  }

  // ── TIER 1/2: VISUAL — Multi-device screenshots ──
  const visualTests = testsByType['visual'] || [];
  const visualTier = MODE === 'fast' ? 4 : 2; // skip entirely in fast mode (Tier 4 = skip by default)
  if (visualTests.length > 0 && canRun('Visual/Multi-device', visualTier, visualTests)) {
    executedPhases.push('visual');
    startPhase('Visual/Multi-device');
    console.log(`\n  Running ${visualTests.length} multi-device visual tests...`);
    for (const test of visualTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of bothSiteList()) {
        await advanced.runMultiDeviceTest(browser, siteUrl, label, test.path, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Visual/Multi-device');
    console.log('');
  }

  // ── TIER 1: E-COMMERCE — PLP/Cart checks (Critical) ──
  const ecomTests = testsByType['ecommerce'] || [];
  if (ecomTests.length > 0 && canRun('E-Commerce', 1, ecomTests)) {
    executedPhases.push('ecommerce');
    startPhase('E-Commerce');
    console.log(`\n  Running ${ecomTests.length} e-commerce tests...`);
    for (const test of ecomTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'plp_products') {
        for (const [disc, sn] of siteDiscPairs(discovery1, discovery2)) {
          const plpPage = disc.pages.find(p => p.path === '/products' && p.status === 200);
          if (plpPage && disc.productLinks.length === 0) {
            bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'E-Commerce', title: `PLP shows zero products (${sn})`, description: 'Product listing page is live but shows no product links', site: sn, fix: 'Publish products to PLP', testType: 'Sanity' });
          }
        }
      }
      if (test.subtype === 'cart_empty') {
        for (const [siteUrl, label] of siteList()) {
          const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
          try {
            const cartPaths = ['/cart/bag', '/cart'];
            for (const cp of cartPaths) {
              const resp = await p.goto(siteUrl + cp, { waitUntil: 'networkidle', timeout: BUDGET.pageTimeoutMs });
              if (resp && resp.status() === 200) {
                await p.waitForTimeout(1500);
                screenshots[`${label}_cart`] = (await p.screenshot()).toString('base64');
                break;
              }
            }
          } catch {}
          await p.close();
        }
      }
      progress(test.name);
    }
    endPhase('E-Commerce');
    console.log('');
  }

  // ── TIER 1: CART & CHECKOUT DEEP ──
  const cartTests = testsByType['cart_checkout'] || [];
  if (cartTests.length > 0 && canRun('Cart & Checkout', 1, cartTests)) {
    executedPhases.push('cart_checkout');
    startPhase('Cart & Checkout');
    console.log(`\n  Running cart & checkout deep tests...`);
    for (const test of cartTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
        await advanced.runCartCheckoutTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Cart & Checkout');
    console.log('');
  }

  // ── TIER 1: AUTH — Login / Protected Pages ──
  const authTests = testsByType['auth'] || [];
  if (authTests.length > 0 && canRun('Auth', 1, authTests)) {
    executedPhases.push('auth');
    startPhase('Auth');
    console.log(`\n  Running ${authTests.length} auth tests...`);
    for (const test of authTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'login_flow') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runLoginTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'login_scroll') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runLoginAndScrollTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'protected_pages') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runRedirectionTest(browser, siteUrl, label, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('Auth');
    console.log('');
  }

  // ── TIER 1: SEARCH DEEP ──
  const searchDeepTests = testsByType['search_deep'] || [];
  if (searchDeepTests.length > 0 && canRun('Search', 1, searchDeepTests)) {
    executedPhases.push('search');
    startPhase('Search');
    console.log(`\n  Running search deep tests...`);
    for (const test of searchDeepTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runSearchDeepTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Search');
    console.log('');
  }

  // ── TIER 1: PDP DEEP ──
  const pdpDeepTests = testsByType['pdp_deep'] || [];
  if (pdpDeepTests.length > 0 && canRun('PDP Deep', 1, pdpDeepTests)) {
    executedPhases.push('pdp_deep');
    startPhase('PDP Deep');
    console.log(`\n  Running PDP deep tests...`);
    for (const test of pdpDeepTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
        await advanced.runPDPDeepTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('PDP Deep');
    console.log('');
  }

  // ── TIER 1: PLP DEEP ──
  const plpDeepTests = testsByType['plp_deep'] || [];
  if (plpDeepTests.length > 0 && canRun('PLP Deep', 1, plpDeepTests)) {
    executedPhases.push('plp_deep');
    startPhase('PLP Deep');
    console.log(`\n  Running PLP deep tests...`);
    for (const test of plpDeepTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runPLPDeepTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('PLP Deep');
    console.log('');
  }

  // ── TIER 2: LINKS — Link Validation ──
  const linkTests = testsByType['links'] || [];
  const linkTier = MODE === 'fast' ? 2 : 1;
  if (linkTests.length > 0 && canRun('Links', linkTier, linkTests)) {
    executedPhases.push('links');
    startPhase('Links');
    console.log(`\n  Running link validation tests...`);
    for (const test of linkTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'footer_links') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          // In fast mode, sample footer links
          const links = BUDGET.footerLinkSampleSize ? disc.footerLinks.slice(0, BUDGET.footerLinkSampleSize) : disc.footerLinks;
          await advanced.runLinkValidation(browser, siteUrl, label, links, 'Footer', bugs, pageData);
        }
      } else if (test.subtype === 'nav_links') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runLinkValidation(browser, siteUrl, label, disc.navLinks, 'Navigation', bugs, pageData);
        }
      } else if (test.subtype === 'all_links') {
        if (MODE !== 'fast') { // Skip full internal link crawl in fast mode
          for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
            const sampleLinks = disc.allInternalLinks.slice(0, 30).map(href => ({ href }));
            await advanced.runLinkValidation(browser, siteUrl, label, sampleLinks, 'Internal', bugs, pageData);
          }
        }
      }
      progress(test.name);
    }
    endPhase('Links');
    console.log('');
  }

  // ── TIER 2: ERRORS — Console & Network (lightweight, always useful) ──
  const errorTests = testsByType['errors'] || [];
  if (errorTests.length > 0 && canRun('Errors', 2, errorTests)) {
    executedPhases.push('errors');
    startPhase('Errors');
    console.log(`\n  Auditing console & network errors...`);
    for (const test of errorTests) {
      if (test.subtype === 'console_errors') {
        for (const [disc, sn] of siteDiscPairs(discovery1, discovery2)) {
          if (disc.consoleErrors.length > 0) {
            const unique = [...new Set(disc.consoleErrors.map(e => e.message))];
            bugs.push({ id: bugs.length + 1, severity: unique.length > 10 ? 'High' : 'Medium', category: 'JavaScript', title: `${unique.length} unique console errors (${sn})`, description: unique.slice(0, 5).join(' | '), site: sn, fix: 'Fix JavaScript errors in console', testType: 'Regression' });
          }
        }
      } else if (test.subtype === 'network_errors') {
        for (const [disc, sn] of siteDiscPairs(discovery1, discovery2)) {
          if (disc.networkErrors.length > 0) {
            bugs.push({ id: bugs.length + 1, severity: disc.networkErrors.length > 5 ? 'High' : 'Medium', category: 'Network', title: `${disc.networkErrors.length} network failures (${sn})`, description: disc.networkErrors.slice(0, 3).map(e => e.url).join(' | '), site: sn, fix: 'Fix failed network requests', testType: 'Regression' });
          }
        }
      }
      progress(test.name);
    }
    endPhase('Errors');
    console.log('');
  }

  // ── TIER 2: COMPARISON (skip in single-URL mode) ──
  const compareTests = testsByType['comparison'] || [];
  if (compareTests.length > 0 && !SINGLE_MODE && canRun('Comparison', 2, compareTests)) {
    executedPhases.push('comparison');
    startPhase('Comparison');
    console.log(`\n  Running content comparison tests...`);
    await advanced.runContentComparison(discovery1, discovery2, bugs, pageData);
    for (const test of compareTests) progress(test.name);
    endPhase('Comparison');
    console.log('');
  } else if (SINGLE_MODE) {
    for (const test of compareTests) progress(test.name);
  }

  // ── TIER 2: REGRESSION (skip in single-URL mode) ──
  const regressionTests = testsByType['regression'] || [];
  if (regressionTests.length > 0 && !SINGLE_MODE && canRun('Regression', 2, regressionTests)) {
    executedPhases.push('regression');
    startPhase('Regression');
    console.log(`\n  Running regression comparisons...`);
    for (const test of regressionTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'status_compare') {
        const allRegPaths = [...new Set([...discovery1.pages.map(p => p.path), ...discovery2.pages.map(p => p.path)])];
        for (const rp of allRegPaths) {
          const p1 = discovery1.pages.find(pg => pg.path === rp);
          const p2 = discovery2.pages.find(pg => pg.path === rp);
          if (p1 && p2 && p1.status !== p2.status) {
            const sev = (p1.status === 200 && p2.status === 404) || (p2.status === 200 && p1.status === 404) ? 'Critical' : 'Medium';
            bugs.push({ id: bugs.length + 1, severity: sev, category: 'Regression', title: `Status mismatch on ${rp}: Site 1=${p1.status}, Site 2=${p2.status}`, description: `Different HTTP status codes for same path`, site: 'Both', fix: 'Align page availability between sites', testType: 'Regression' });
          }
        }
      }
      if (test.subtype === 'title_compare') {
        for (const p1 of discovery1.pages.filter(p => p.status === 200)) {
          const p2 = discovery2.pages.find(pg => pg.path === p1.path && pg.status === 200);
          if (p2 && p1.title && p2.title && p1.title !== p2.title && p1.title.length > 3 && p2.title.length > 3) {
            pageData[`title_diff_${p1.path.replace(/[^a-z0-9]/gi, '_')}`] = { site1: p1.title, site2: p2.title };
            bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'SEO/Meta', title: `Page title differs on ${p1.path}`, description: `Production: "${p1.title}"\nUAT: "${p2.title}"`, site: SITE2_NAME, fix: 'Align page titles between Production and UAT', testType: 'Regression', location: p1.path, steps: `1. Open ${SITE1}${p1.path} — check browser tab title\n2. Open ${SITE2}${p1.path} — check browser tab title\n3. Titles should match`, expected: `Title: "${p1.title}"`, actual: `Title: "${p2.title}"` });
          }
        }
      }
      if (test.subtype === 'structure_compare') {
        const keyPaths = ['/', '/products', '/collections', '/contact-us'].filter(p =>
          discovery1.pages.some(pg => pg.path === p && pg.status === 200) &&
          discovery2.pages.some(pg => pg.path === p && pg.status === 200)
        );
        for (const rp of keyPaths.slice(0, 3)) {
          if (budget.shouldHardStop()) break;
          await advanced.runStructureCompare(browser, SITE1, SITE2, rp, bugs, pageData);
        }
      }
      if (test.subtype === 'meta_compare') {
        const metaPaths = ['/', '/products', '/contact-us'].filter(p =>
          discovery1.pages.some(pg => pg.path === p && pg.status === 200) &&
          discovery2.pages.some(pg => pg.path === p && pg.status === 200)
        );
        for (const rp of metaPaths.slice(0, 3)) {
          if (budget.shouldHardStop()) break;
          await advanced.runMetaCompare(browser, SITE1, SITE2, rp, bugs, pageData);
        }
      }
      if (test.subtype === 'header_footer_compare') {
        await advanced.runHeaderFooterCompare(browser, SITE1, SITE2, bugs, pageData, screenshots);
      }
      if (test.subtype === 'css_compare') {
        const cssPaths = ['/', '/products'].filter(p =>
          discovery1.pages.some(pg => pg.path === p && pg.status === 200) &&
          discovery2.pages.some(pg => pg.path === p && pg.status === 200)
        );
        for (const rp of cssPaths.slice(0, 2)) {
          if (budget.shouldHardStop()) break;
          await advanced.runCSSCompare(browser, SITE1, SITE2, rp, bugs, pageData);
        }
      }
      if (test.subtype === 'responsive_compare') {
        await advanced.runResponsiveCompare(browser, SITE1, SITE2, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Regression');
    console.log('');
  } else if (SINGLE_MODE && regressionTests.length > 0) {
    for (const test of regressionTests) progress(test.name);
  }

  // ── TIER 2: LIGHTHOUSE COMPARISON (Prod vs UAT performance audit) ──
  const lighthouseTests = testsByType['lighthouse_compare'] || [];
  if (lighthouseTests.length > 0 && !SINGLE_MODE && canRun('Lighthouse Compare', 2, lighthouseTests)) {
    executedPhases.push('lighthouse_compare');
    startPhase('Lighthouse Compare');
    console.log(`\n  Running ${lighthouseTests.length} Lighthouse comparison audits (Prod vs UAT)...`);
    for (const test of lighthouseTests) {
      if (budget.shouldHardStop()) break;
      await advanced.runLighthouseCompare(SITE1, SITE2, test.path, bugs, pageData);
      progress(test.name);
    }
    endPhase('Lighthouse Compare');
    console.log('');
  } else if (SINGLE_MODE && lighthouseTests.length > 0) {
    for (const test of lighthouseTests) progress(test.name);
  }

  // ── TIER 2: SECTION VISUAL DIFF (Prod vs UAT per-section comparison) ──
  const sectionDiffTests = testsByType['visual_diff_section'] || [];
  if (sectionDiffTests.length > 0 && !SINGLE_MODE && canRun('Section Visual Diff', 2, sectionDiffTests)) {
    executedPhases.push('section_visual_diff');
    startPhase('Section Visual Diff');
    console.log(`\n  Running ${sectionDiffTests.length} section-level visual diff tests...`);
    for (const test of sectionDiffTests) {
      if (budget.shouldHardStop()) break;
      await advanced.runSectionVisualDiff(browser, SITE1, SITE2, test.path, bugs, pageData, screenshots);
      progress(test.name);
    }
    endPhase('Section Visual Diff');
    console.log('');
  } else if (SINGLE_MODE && sectionDiffTests.length > 0) {
    for (const test of sectionDiffTests) progress(test.name);
  }

  // ── TIER 3: FORMS (fast: skip if budget low) ──
  const formTests = testsByType['forms'] || [];
  if (formTests.length > 0 && canRun('Forms', 3, formTests)) {
    executedPhases.push('forms');
    startPhase('Forms');
    console.log(`\n  Running ${formTests.length} form validation tests...`);
    for (const test of formTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runFormTest(browser, siteUrl, label, test.path, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Forms');
    console.log('');
  }

  // ── TIER 3: CSS & THEME ──
  const cssTests = testsByType['css'] || [];
  const cssTier = BUDGET.skipFullFontCheck ? 3 : 2;
  if (cssTests.length > 0 && canRun('CSS/Theme', cssTier, cssTests)) {
    executedPhases.push('css');
    startPhase('CSS/Theme');
    console.log(`\n  Running ${cssTests.length} CSS/theme tests...`);
    for (const test of cssTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'css_variables') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runCSSTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'font_consistency' && !BUDGET.skipFullFontCheck) {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runFontTest(browser, siteUrl, label, disc.pages, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('CSS/Theme');
    console.log('');
  }

  // Performance and Accessibility phases moved earlier (before Visual) to ensure they always run

  // ── TIER 4: WISHLIST (skip in fast mode) ──
  const wishlistTests = testsByType['wishlist_deep'] || [];
  const wishlistTier = BUDGET.skipWishlist ? 4 : 2;
  if (wishlistTests.length > 0 && canRun('Wishlist', wishlistTier, wishlistTests)) {
    executedPhases.push('wishlist');
    startPhase('Wishlist');
    console.log(`\n  Running wishlist tests...`);
    for (const test of wishlistTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runWishlistTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Wishlist');
    console.log('');
  }

  // ── TIER 4: SECURITY (skip in fast mode) ──
  const securityTests = testsByType['security'] || [];
  const securityTier = BUDGET.skipSecurity ? 4 : 2;
  if (securityTests.length > 0 && canRun('Security', securityTier, securityTests)) {
    executedPhases.push('security');
    startPhase('Security');
    console.log(`\n  Running security basic tests...`);
    for (const test of securityTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runSecurityBasicTest(browser, siteUrl, label, bugs, pageData);
      }
      progress(test.name);
    }
    endPhase('Security');
    console.log('');
  }

  // ── TIER 4: EXPLORATORY (skip in fast mode) ──
  const exploratoryTests = testsByType['exploratory'] || [];
  const exploratoryTier = BUDGET.skipExploratory ? 4 : 2;
  if (exploratoryTests.length > 0 && canRun('Exploratory', exploratoryTier, exploratoryTests)) {
    executedPhases.push('exploratory');
    startPhase('Exploratory');
    console.log(`\n  Running exploratory tests...`);
    for (const test of exploratoryTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
        await advanced.runExploratoryTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Exploratory');
    console.log('');
  }

  // ── TIER 2: 4K UHD TESTING (3840×2160) ──
  if (canRun('4K UHD', 2, [])) {
    executedPhases.push('4k_uhd');
    startPhase('4K UHD');
    console.log(`\n  Running 4K UHD (3840×2160) tests...`);
    for (const [siteUrl, label] of siteList()) {
      await fourK.run4KTests(browser, siteUrl, label, bugs, pageData, screenshots);
    }
    endPhase('4K UHD');
    console.log('');
  }

  // ── TIER 2: SESSION PERSISTENCE ──
  const sessionTests = testsByType['session'] || [];
  if (sessionTests.length > 0 && canRun('Session', 2, sessionTests)) {
    executedPhases.push('session');
    startPhase('Session');
    console.log(`\n  Running session persistence tests...`);
    for (const test of sessionTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runSessionTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Session');
    console.log('');
  }

  // ── TIER 2: PAYMENT METHODS ──
  const paymentTests = testsByType['payment'] || [];
  if (paymentTests.length > 0 && canRun('Payment', 2, paymentTests)) {
    executedPhases.push('payment');
    startPhase('Payment');
    console.log(`\n  Running payment method tests...`);
    for (const test of paymentTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runPaymentTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Payment');
    console.log('');
  }

  // ── TIER 2: ORDER LIFECYCLE ──
  const orderTests = testsByType['order_lifecycle'] || [];
  if (orderTests.length > 0 && canRun('Order Lifecycle', 2, orderTests)) {
    executedPhases.push('order_lifecycle');
    startPhase('Order Lifecycle');
    console.log(`\n  Running order lifecycle tests...`);
    for (const test of orderTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runOrderLifecycleTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Order Lifecycle');
    console.log('');
  }

  // ── TIER 2: PRICING VALIDATION ──
  const pricingTests = testsByType['pricing'] || [];
  if (pricingTests.length > 0 && canRun('Pricing', 2, pricingTests)) {
    executedPhases.push('pricing');
    startPhase('Pricing');
    console.log(`\n  Running pricing validation tests...`);
    for (const test of pricingTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runPricingValidationTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Pricing');
    console.log('');
  }

  // ── TIER 2: RACE CONDITIONS ──
  const raceTests = testsByType['race_condition'] || [];
  if (raceTests.length > 0 && canRun('Race Conditions', 2, raceTests)) {
    executedPhases.push('race_conditions');
    startPhase('Race Conditions');
    console.log(`\n  Running race condition tests...`);
    for (const test of raceTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runRaceConditionTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Race Conditions');
    console.log('');
  }

  // ── TIER 4: INVENTORY (skip in fast mode) ──
  const inventoryTests = testsByType['inventory'] || [];
  const inventoryTier = BUDGET.skipInventory ? 4 : 2;
  if (inventoryTests.length > 0 && canRun('Inventory', inventoryTier, inventoryTests)) {
    executedPhases.push('inventory');
    startPhase('Inventory');
    console.log(`\n  Running inventory tests...`);
    for (const test of inventoryTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
        await advanced.runInventoryTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Inventory');
    console.log('');
  }

  // ── TIER 1: USER JOURNEY FLOWS (end-to-end real user flows) ──
  const journeyTests = testsByType['user_journey'] || [];
  if (journeyTests.length > 0 && canRun('User Journeys', 1, journeyTests)) {
    executedPhases.push('user_journeys');
    startPhase('User Journeys');
    console.log(`\n  Running ${journeyTests.length} user journey flow tests...`);
    for (const test of journeyTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'browse_to_cart') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runUserJourneyBrowseToCart(browser, siteUrl, label, disc, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'login_to_profile') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runUserJourneyLoginToProfile(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'search_to_product') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runUserJourneySearchToProduct(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      }
      progress(test.name);
    }
    endPhase('User Journeys');
    console.log('');
  }

  // ── TIER 2: INTERACTION TESTS (hover, scroll, carousel, tabs) ──
  const interactionTests = testsByType['interaction'] || [];
  if (interactionTests.length > 0 && canRun('Interaction', 2, interactionTests)) {
    executedPhases.push('interaction');
    startPhase('Interaction');
    console.log(`\n  Running interaction tests...`);
    for (const test of interactionTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runInteractionTest(browser, siteUrl, label, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Interaction');
    console.log('');
  }

  // ── TIER 2: API COMPARISON (Prod vs UAT) ──
  const apiTests = testsByType['api_compare'] || [];
  if (apiTests.length > 0 && !SINGLE_MODE && canRun('API Compare', 2, apiTests)) {
    executedPhases.push('api_compare');
    startPhase('API Compare');
    console.log(`\n  Running API comparison (Prod vs UAT)...`);
    await advanced.runAPIComparison(browser, SITE1, SITE2, bugs, pageData);
    for (const test of apiTests) progress(test.name);
    endPhase('API Compare');
    console.log('');
  } else if (SINGLE_MODE && apiTests.length > 0) {
    for (const test of apiTests) progress(test.name);
  }

  // ── TIER 2: FORM VALIDATION (deep input testing) ──
  const formValTests = testsByType['form_validation'] || [];
  if (formValTests.length > 0 && canRun('Form Validation', 2, formValTests)) {
    executedPhases.push('form_validation');
    startPhase('Form Validation');
    console.log(`\n  Running ${formValTests.length} form validation tests...`);
    for (const test of formValTests) {
      if (budget.shouldHardStop()) break;
      for (const [siteUrl, label] of siteList()) {
        await advanced.runFormValidationTest(browser, siteUrl, label, test.path, bugs, pageData, screenshots);
      }
      progress(test.name);
    }
    endPhase('Form Validation');
    console.log('');
  }

  // ── TIER 2: SEO VALIDATION ──
  const seoTests = testsByType['seo'] || [];
  if (seoTests.length > 0 && canRun('SEO', 2, seoTests)) {
    executedPhases.push('seo');
    startPhase('SEO');
    console.log(`\n  Running ${seoTests.length} SEO validation tests...`);
    for (const test of seoTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'robots_sitemap') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runSEORobotsSitemap(browser, siteUrl, label, bugs, pageData);
        }
      } else if (test.subtype === 'structured_data') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runSEOStructuredData(browser, siteUrl, label, test.path, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('SEO');
    console.log('');
  }

  // ── TIER 2: E-COMMERCE ENHANCED ──
  const ecomEnhTests = testsByType['ecommerce_enhanced'] || [];
  if (ecomEnhTests.length > 0 && canRun('E-Commerce Enhanced', 2, ecomEnhTests)) {
    executedPhases.push('ecommerce_enhanced');
    startPhase('E-Commerce Enhanced');
    console.log(`\n  Running ${ecomEnhTests.length} enhanced e-commerce tests...`);
    for (const test of ecomEnhTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'product_gallery_zoom') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runProductGalleryZoom(browser, siteUrl, label, disc, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'out_of_stock') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runOutOfStockTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'price_format') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runPriceFormatTest(browser, siteUrl, label, disc, bugs, pageData);
        }
      } else if (test.subtype === 'related_products') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runRelatedProductsTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'coupon_promo') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runCouponPromoTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'social_sharing') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runSocialSharingTest(browser, siteUrl, label, disc, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('E-Commerce Enhanced');
    console.log('');
  }

  // ── TIER 2: NAVIGATION & UX ──
  const navUxTests = testsByType['navigation_ux'] || [];
  if (navUxTests.length > 0 && canRun('Navigation UX', 2, navUxTests)) {
    executedPhases.push('navigation_ux');
    startPhase('Navigation UX');
    console.log(`\n  Running ${navUxTests.length} navigation & UX tests...`);
    for (const test of navUxTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'breadcrumb') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runBreadcrumbTest(browser, siteUrl, label, disc, bugs, pageData);
        }
      } else if (test.subtype === 'mobile_menu') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runMobileMenuTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'cookie_consent') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runCookieConsentTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      }
      progress(test.name);
    }
    endPhase('Navigation UX');
    console.log('');
  }

  // ── TIER 2: SECURITY ENHANCED ──
  const secEnhTests = testsByType['security_enhanced'] || [];
  if (secEnhTests.length > 0 && canRun('Security Enhanced', 2, secEnhTests)) {
    executedPhases.push('security_enhanced');
    startPhase('Security Enhanced');
    console.log(`\n  Running security headers audit...`);
    for (const test of secEnhTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'http_headers') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runHTTPSecurityHeaders(browser, siteUrl, label, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('Security Enhanced');
    console.log('');
  }

  // ── TIER 2: PERFORMANCE ENHANCED ──
  const perfEnhTests = testsByType['performance_enhanced'] || [];
  if (perfEnhTests.length > 0 && canRun('Performance Enhanced', 2, perfEnhTests)) {
    executedPhases.push('performance_enhanced');
    startPhase('Performance Enhanced');
    console.log(`\n  Running ${perfEnhTests.length} enhanced performance tests...`);
    for (const test of perfEnhTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'image_optimization') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runImageOptimizationTest(browser, siteUrl, label, bugs, pageData);
        }
      } else if (test.subtype === 'scroll_performance') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runScrollPerformanceTest(browser, siteUrl, label, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('Performance Enhanced');
    console.log('');
  }

  // ── TIER 2: CONTENT & POLICY PAGES ──
  const contentPolicyTests = testsByType['content_policy'] || [];
  if (contentPolicyTests.length > 0 && canRun('Content Policy', 2, contentPolicyTests)) {
    executedPhases.push('content_policy');
    startPhase('Content Policy');
    console.log(`\n  Running content & policy page tests...`);
    for (const test of contentPolicyTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'policy_pages') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runPolicyPagesTest(browser, siteUrl, label, bugs, pageData);
        }
      }
      progress(test.name);
    }
    endPhase('Content Policy');
    console.log('');
  }

  // ── TIER 1: SCENARIO TESTS (SKILL.md 39 scenarios) ──
  const scenarioTests = testsByType['scenario'] || [];
  if (scenarioTests.length > 0 && canRun('Scenarios', 1, scenarioTests)) {
    executedPhases.push('scenarios');
    startPhase('Scenarios');
    console.log(`\n  Running ${scenarioTests.length} scenario tests (SKILL.md)...`);
    for (const test of scenarioTests) {
      if (budget.shouldHardStop()) break;
      if (test.subtype === 'auth_negative') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runAuthNegativeTests(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'empty_cart') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runEmptyCartTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'cart_quantity') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runCartQuantityTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'plp_interaction') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runPLPInteractionTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'pdp_edge_cases') {
        for (const [siteUrl, label, disc] of siteDiscList(discovery1, discovery2)) {
          await advanced.runPDPEdgeCaseTest(browser, siteUrl, label, disc, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'homepage_deep') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runHomepageDeepTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'header_nav') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runHeaderNavTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'newsletter') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runNewsletterTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'store_locator') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runStoreLocatorTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'address_crud') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runAddressTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      } else if (test.subtype === 'track_order') {
        for (const [siteUrl, label] of siteList()) {
          await advanced.runTrackOrderTest(browser, siteUrl, label, bugs, pageData, screenshots);
        }
      }
      progress(test.name);
    }
    // Show scenario test results summary
    if (pageData._testResults && pageData._testResults.length > 0) {
      console.log('\n  ── Scenario Test Results ──');
      for (const r of pageData._testResults) {
        const icon = r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗';
        const color = r.status === 'passed' ? '\x1b[32m' : r.status === 'skipped' ? '\x1b[33m' : '\x1b[31m';
        console.log(`  ${color}${icon}\x1b[0m ${r.test}: ${r.reason}`);
      }
    }
    endPhase('Scenarios');
    console.log('');
  }

  // ── Budget Summary ──
  if (skippedPhases.length > 0) {
    console.log(`\n  [BUDGET] Skipped ${skippedPhases.length} phase(s): ${skippedPhases.join(', ')}`);
  }
  console.log(`  [BUDGET] Executed ${executedPhases.length} phase(s) in ${budget.elapsedSec()}s (budget: ${budgetMin}min)`);

  // ── Phase Timing Table ──
  const timingEntries = Object.entries(phaseTimings).filter(([, v]) => v.end);
  if (timingEntries.length > 0) {
    console.log('\n  ┌──────────────────────────┬──────────┐');
    console.log('  │  Module                  │  Time    │');
    console.log('  ├──────────────────────────┼──────────┤');
    let totalPhaseSec = 0;
    for (const [name, t] of timingEntries) {
      totalPhaseSec += t.duration;
      const mins = Math.floor(t.duration / 60);
      const secs = t.duration % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      console.log(`  │  ${name.padEnd(24)}│  ${timeStr.padEnd(8)}│`);
    }
    console.log('  ├──────────────────────────┼──────────┤');
    const totalMins = Math.floor(totalPhaseSec / 60);
    const totalSecs = totalPhaseSec % 60;
    const totalStr = totalMins > 0 ? `${totalMins}m ${totalSecs}s` : `${totalSecs}s`;
    console.log(`  │  TOTAL                   │  ${totalStr.padEnd(8)}│`);
    console.log('  └──────────────────────────┴──────────┘');
  }
  console.log('');

  // ============================================================
  // PHASE 4: REPORT GENERATION
  // ============================================================
  console.log('\n  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PHASE 4: GENERATING REPORT');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Visual Diff: compare Prod vs UAT screenshots (2-URL mode only)
  if (!SINGLE_MODE) {
    console.log('  Running visual diff (pixelmatch) — comparing Production vs UAT screenshots...');
    const { diffCount, diffResults } = advanced.runVisualDiff(screenshots, bugs, SITE1_NAME, SITE2_NAME);
    pageData._diffResults = diffResults;
    console.log(`  Visual diff complete: ${diffCount} significant difference(s) found.\n`);
  }

  // Sort & deduplicate bugs, apply filters
  const bugSet = new Set();
  const uniqueBugs = bugs.filter(b => {
    // Skip 404 status code and page routing errors
    if (b.category === 'Routing') return false;
    if (b.category === 'Server' && /returns \d+ server error/.test(b.title)) return false;
    if (b.category === 'Regression' && /Status mismatch/.test(b.title)) return false;
    // Skip broken images bugs (user wants blur detection, not broken)
    if (b.category === 'Images' && /broken image/i.test(b.title)) return false;
    // Skip generic overlapping elements (only keep image/text overlap)
    if (b.category === 'UI Alignment' && /overlapping elements/i.test(b.title)) return false;
    // Skip console errors and network errors
    if (b.category === 'JavaScript' && /console error/i.test(b.title)) return false;
    if (b.category === 'Network' && /network fail/i.test(b.title)) return false;
    // In 2-URL mode: Site 1 is reference, only show Site 2 (test site) bugs
    if (!SINGLE_MODE && (b.site === 'Site 1' || b.site === SITE1_NAME)) return false;
    const key = `${b.title}|${b.site}`;
    if (bugSet.has(key)) return false;
    bugSet.add(key);
    return true;
  });
  // Merge same bug type + same page across devices into one entry
  // e.g. "Untappable Elements — / on iPhone 14 Pro" + "Untappable Elements — / on Pixel 7" → one bug
  const mergeMap = new Map();
  const mergedBugs = [];
  for (const b of uniqueBugs) {
    // Extract bug type and page path (without device name)
    const typeMatch = b.title.match(/^(.+?) — (.+?) on (.+?) \((.+?)\)$/);
    if (typeMatch && b.testType === 'Responsive') {
      const [, bugType, pagePath, deviceName, siteName] = typeMatch;
      const mergeKey = `${bugType}|${pagePath}|${siteName}`;
      if (mergeMap.has(mergeKey)) {
        const existing = mergeMap.get(mergeKey);
        existing._devices.push(deviceName);
        // Merge description details
        if (b.description && !existing.description.includes(deviceName)) {
          existing.description += `\n\n--- ${deviceName} ---\n${b.description}`;
        }
        // Keep the screenshot from the first device, but store all keys
        if (b.screenshotKey) {
          if (!existing._screenshotKeys) existing._screenshotKeys = [existing.screenshotKey];
          existing._screenshotKeys.push(b.screenshotKey);
        }
      } else {
        b._devices = [deviceName];
        b._screenshotKeys = b.screenshotKey ? [b.screenshotKey] : [];
        mergeMap.set(mergeKey, b);
        mergedBugs.push(b);
      }
    } else {
      mergedBugs.push(b);
    }
  }
  // Update titles and descriptions for merged bugs
  for (const b of mergedBugs) {
    if (b._devices && b._devices.length > 1) {
      const typeMatch = b.title.match(/^(.+?) — (.+?) on .+? \((.+?)\)$/);
      if (typeMatch) {
        const [, bugType, pagePath, siteName] = typeMatch;
        const deviceList = b._devices.join(', ');
        b.title = `${bugType} — ${pagePath} on ${deviceList} (${siteName})`;
        b.location = `${pagePath} on ${deviceList} (${siteName})`;
        b.steps = b.steps.replace(/on \w[\w\s]+\(/, `on ${deviceList} (`);
      }
    }
  }
  // Replace uniqueBugs with merged
  uniqueBugs.length = 0;
  uniqueBugs.push(...mergedBugs);
  uniqueBugs.forEach((b, i) => b.id = i + 1);

  const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  uniqueBugs.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  const counts = {
    total: uniqueBugs.length,
    critical: uniqueBugs.filter(b => b.severity === 'Critical').length,
    high: uniqueBugs.filter(b => b.severity === 'High').length,
    medium: uniqueBugs.filter(b => b.severity === 'Medium').length,
    low: uniqueBugs.filter(b => b.severity === 'Low').length,
    tests: testPlan.length,
  };

  // ===== LEARNING ENGINE: Classify & Analyze =====
  const classified = learning.classifyBugs(uniqueBugs, knowledge);
  const insights = learning.generateInsights(classified, knowledge, counts);
  const endTime = Date.now();

  log('\n  [BRAIN] Learning Analysis:');
  log(`    New bugs: ${classified.newBugs.length} | Recurring: ${classified.recurringBugs.length} | Fixed: ${classified.fixedBugs.length} | Regressions: ${classified.regressions.length}`);
  for (const insight of insights) {
    const icon = insight.severity === 'success' ? '+' : insight.severity === 'critical' ? '!' : insight.severity === 'warning' ? '~' : '*';
    log(`    [${icon}] ${insight.title}`);
  }

  // Save learnings for next run
  const runSummary = learning.saveRunLearning({
    site1: SITE1, site2: SITE2, bugs: uniqueBugs, testPlan,
    discovery1, discovery2, startTime, endTime, counts,
  });
  log(`  [BRAIN] Knowledge saved. Run #${runSummary.runNumber} stored.\n`);

  // Group bugs by category for the report
  const bugsByCategory = {};
  for (const b of uniqueBugs) {
    if (!bugsByCategory[b.category]) bugsByCategory[b.category] = [];
    bugsByCategory[b.category].push(b);
  }

  // Group bugs by test type
  const bugsByTestType = {};
  for (const b of uniqueBugs) {
    const tt = b.testType || 'Other';
    if (!bugsByTestType[tt]) bugsByTestType[tt] = [];
    bugsByTestType[tt].push(b);
  }

  // ===== Generate HTML Report =====
  function imgTag(key, fallback = '') {
    if (screenshots[key]) return `<img class="lazy-img" data-src="screenshots/${key}.png" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200'%3E%3Crect width='400' height='200' fill='%23111827'/%3E%3Ctext x='200' y='105' fill='%234b5563' text-anchor='middle' font-size='13'%3ELoading screenshot...%3C/text%3E%3C/svg%3E" style="width:100%;display:block;" alt="${key}">`;
    return `<div style="padding:40px;text-align:center;color:#6b7280;background:#111827;font-size:13px;">${fallback || 'Not captured'}</div>`;
  }

  // Auto-attach screenshots to bugs that don't have one
  for (const b of uniqueBugs) {
    if (!b.screenshotKey && b.title) {
      // Try to find a matching screenshot by parsing bug title for path and site
      const siteLabel = (b.site === 'Site 1' || b.site === SITE1_NAME) ? 'site1' : (b.site === 'Site 2' || b.site === SITE2_NAME) ? 'site2' : 'site1';
      const pathMatch = b.title.match(/\/([\w\-\/]+)/);
      if (pathMatch) {
        const pathKey = pathMatch[0].replace(/[^a-z0-9]/gi, '_');
        const tryKeys = [
          `${siteLabel}_page_${pathKey}`,
          `${siteLabel}_${pathKey}_desktop`,
          `${siteLabel}_${pathKey}_iphone_14_pro`,
          `${siteLabel}_${pathKey}_pixel_7`,
        ];
        for (const tk of tryKeys) {
          if (screenshots[tk]) { b.screenshotKey = tk; break; }
        }
      }
      // Fallback: try homepage screenshot
      if (!b.screenshotKey) {
        const homeTry = [`${siteLabel}_page__`, `${siteLabel}___desktop`];
        for (const tk of homeTry) {
          if (screenshots[tk]) { b.screenshotKey = tk; break; }
        }
      }
    }
    // Ensure all bugs have location, steps, expected, actual
    if (!b.location) b.location = b.site || 'Site-wide';
    if (!b.steps) b.steps = `1. Navigate to the affected page\n2. Observe the issue described`;
    if (!b.expected) b.expected = 'No issues — page functions correctly';
    if (!b.actual) b.actual = b.description || b.title;
  }

  // Capture screenshots for bugs that still have none (mandatory screenshots)
  const bugsWithoutScreenshots = uniqueBugs.filter(b => !b.screenshotKey || !screenshots[b.screenshotKey]);
  if (bugsWithoutScreenshots.length > 0 && !budget.shouldHardStop()) {
    console.log(`  Capturing ${bugsWithoutScreenshots.length} missing bug screenshots...`);
    const ssPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const capturedPaths = new Set();
    for (const b of bugsWithoutScreenshots) {
      if (budget.shouldHardStop()) break;
      // Extract path from bug title
      const pathMatch = b.title.match(/\/([\w\-\/\?=&]+)/);
      const bugPath = pathMatch ? pathMatch[0] : '/';
      if (capturedPaths.has(bugPath)) {
        // Reuse already captured screenshot
        const reuseKey = `bug_ss_${bugPath.replace(/[^a-z0-9]/gi, '_')}`;
        if (screenshots[reuseKey]) { b.screenshotKey = reuseKey; }
        continue;
      }
      capturedPaths.add(bugPath);
      const siteLabel = (b.site === 'Site 1' || b.site === SITE1_NAME) ? 'site1' : 'site2';
      const siteUrl = siteLabel === 'site1' ? SITE1 : SITE2;
      const ssKey = `bug_ss_${bugPath.replace(/[^a-z0-9]/gi, '_')}`;
      try {
        await ssPage.goto(siteUrl + bugPath, { waitUntil: 'domcontentloaded', timeout: BUDGET.pageTimeoutMs });
        await ssPage.waitForTimeout(800);
        screenshots[ssKey] = (await ssPage.screenshot({ fullPage: true })).toString('base64');
        b.screenshotKey = ssKey;
      } catch {
        // If page fails, try just homepage
        try {
          if (bugPath !== '/') {
            await ssPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: BUDGET.pageTimeoutMs });
            await ssPage.waitForTimeout(500);
            screenshots[ssKey] = (await ssPage.screenshot({ fullPage: true })).toString('base64');
            b.screenshotKey = ssKey;
          }
        } catch {}
      }
    }
    await ssPage.close();
  }

  // Build detailed bug cards (like NM-004 format)
  let bugCards = '';
  for (const b of uniqueBugs) {
    const cls = b.severity.toLowerCase();
    const bugId = `BUG-${String(b.id).padStart(3, '0')}`;
    const statusBadge = b._learningStatus === 'new'
      ? '<span class="badge" style="background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f;">NEW</span>'
      : b._learningStatus === 'regression'
      ? '<span class="badge bg-critical">REGRESSION</span>'
      : b._learningStatus === 'recurring'
      ? `<span class="badge bg-warn">RECURRING x${b._occurrences || '?'}</span>`
      : '';
    const screenshotHtml = b.screenshotKey && screenshots[b.screenshotKey]
      ? `<div class="bug-screenshot"><img class="lazy-img" data-src="screenshots/${b.screenshotKey}.png" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200'%3E%3Crect width='400' height='200' fill='%23111827'/%3E%3Ctext x='200' y='105' fill='%234b5563' text-anchor='middle' font-size='13'%3ELoading screenshot...%3C/text%3E%3C/svg%3E" alt="Screenshot showing ${b.title}"><div class="bug-ss-caption">Screenshot: ${b.location} — ${b.title}</div></div>`
      : '';
    const stepsFormatted = (b.steps || '').split('\n').map(s => s.trim()).filter(Boolean).join('<br>');

    bugCards += `<div class="bug-card bug-${cls}" data-severity="${b.severity}" data-category="${b.category}" data-type="${b.testType || ''}">
      <div class="bug-card-header">
        <h3><span class="badge bg-${cls}">${b.severity}</span> ${bugId} — ${b.title} ${statusBadge}</h3>
      </div>
      <div class="bug-card-body">
        <table class="bug-detail-table">
          <tr><td class="bug-field">Severity</td><td><span class="badge bg-${cls}">${b.severity}</span></td></tr>
          <tr><td class="bug-field">Category</td><td><span class="badge bg-info">${b.category}</span> <span class="badge bg-info">${b.testType || '-'}</span></td></tr>
          <tr><td class="bug-field">Location</td><td>${b.location}</td></tr>
          <tr><td class="bug-field">Description</td><td>${b.description}</td></tr>
          <tr><td class="bug-field">Steps</td><td>${stepsFormatted}</td></tr>
          <tr><td class="bug-field">Expected</td><td class="pass-text">${b.expected}</td></tr>
          <tr><td class="bug-field">Actual</td><td class="fail-text">${b.actual}</td></tr>
          <tr><td class="bug-field">Fix</td><td><code>${b.fix}</code></td></tr>
        </table>
        ${screenshotHtml}
      </div>
    </div>`;
  }

  // Discovery summary table
  const d1 = pageData.discovery1;
  const d2 = pageData.discovery2;
  const discoveryRows = SINGLE_MODE ? `
    <tr><td>Pages Crawled</td><td>${d1.totalPages}</td></tr>
    <tr><td>Live (200)</td><td class="pass">${d1.livePages}</td></tr>
    <tr><td>Products Found</td><td>${d1.productCount}</td></tr>
    <tr><td>Forms Found</td><td>${d1.formCount}</td></tr>
    <tr><td>Console Errors</td><td class="${d1.consoleErrors > 0 ? 'fail' : ''}">${d1.consoleErrors}</td></tr>
    <tr><td>Network Errors</td><td class="${d1.networkErrors > 0 ? 'fail' : ''}">${d1.networkErrors}</td></tr>
    <tr><td>Login</td><td>${d1.features.hasLogin ? 'Yes' : 'No'}</td></tr>
    <tr><td>Cart</td><td>${d1.features.hasCart ? 'Yes' : 'No'}</td></tr>
    <tr><td>Search</td><td>${d1.features.hasSearch ? 'Yes' : 'No'}</td></tr>
    <tr><td>Products</td><td>${d1.features.hasProducts ? 'Yes' : 'No'}</td></tr>
    <tr><td>Contact Form</td><td>${d1.features.hasContactForm ? 'Yes' : 'No'}</td></tr>
  ` : `
    <tr><td>Pages Crawled</td><td>${d1.totalPages}</td><td>${d2.totalPages}</td></tr>
    <tr><td>Live (200)</td><td class="pass">${d1.livePages}</td><td class="pass">${d2.livePages}</td></tr>
    <tr><td>Dead (404)</td><td class="${d1.deadPages > 0 ? 'fail' : ''}">${d1.deadPages}</td><td class="${d2.deadPages > 0 ? 'fail' : ''}">${d2.deadPages}</td></tr>
    <tr><td>Products Found</td><td>${d1.productCount}</td><td>${d2.productCount}</td></tr>
    <tr><td>Forms Found</td><td>${d1.formCount}</td><td>${d2.formCount}</td></tr>
    <tr><td>Console Errors</td><td class="${d1.consoleErrors > 0 ? 'fail' : ''}">${d1.consoleErrors}</td><td class="${d2.consoleErrors > 0 ? 'fail' : ''}">${d2.consoleErrors}</td></tr>
    <tr><td>Network Errors</td><td class="${d1.networkErrors > 0 ? 'fail' : ''}">${d1.networkErrors}</td><td class="${d2.networkErrors > 0 ? 'fail' : ''}">${d2.networkErrors}</td></tr>
    <tr><td>Login</td><td>${d1.features.hasLogin ? 'Yes' : 'No'}</td><td>${d2.features.hasLogin ? 'Yes' : 'No'}</td></tr>
    <tr><td>Cart</td><td>${d1.features.hasCart ? 'Yes' : 'No'}</td><td>${d2.features.hasCart ? 'Yes' : 'No'}</td></tr>
    <tr><td>Search</td><td>${d1.features.hasSearch ? 'Yes' : 'No'}</td><td>${d2.features.hasSearch ? 'Yes' : 'No'}</td></tr>
    <tr><td>Products</td><td>${d1.features.hasProducts ? 'Yes' : 'No'}</td><td>${d2.features.hasProducts ? 'Yes' : 'No'}</td></tr>
    <tr><td>Contact Form</td><td>${d1.features.hasContactForm ? 'Yes' : 'No'}</td><td>${d2.features.hasContactForm ? 'Yes' : 'No'}</td></tr>
  `;

  // Page crawl results
  let crawlRows = '';
  const allPaths = [...new Set([...discovery1.pages.map(p => p.path), ...discovery2.pages.map(p => p.path)])].sort();
  for (const p of allPaths) {
    const p1 = discovery1.pages.find(pg => pg.path === p);
    const s1 = p1 ? p1.status : '-';
    if (SINGLE_MODE) {
      crawlRows += `<tr>
        <td style="font-family:monospace;font-size:12px;">${p}</td>
        <td>${s1 === 200 ? '<span class="badge bg-pass">200</span>' : s1 === 404 ? '<span class="badge bg-fail">404</span>' : `<span class="badge bg-warn">${s1}</span>`}</td>
      </tr>`;
    } else {
      const p2 = discovery2.pages.find(pg => pg.path === p);
      const s2 = p2 ? p2.status : '-';
      const match = s1 === s2;
      crawlRows += `<tr>
        <td style="font-family:monospace;font-size:12px;">${p}</td>
        <td>${s1 === 200 ? '<span class="badge bg-pass">200</span>' : s1 === 404 ? '<span class="badge bg-fail">404</span>' : `<span class="badge bg-warn">${s1}</span>`}</td>
        <td>${s2 === 200 ? '<span class="badge bg-pass">200</span>' : s2 === 404 ? '<span class="badge bg-fail">404</span>' : `<span class="badge bg-warn">${s2}</span>`}</td>
        <td class="${match ? 'pass' : 'fail'}">${match ? 'Match' : 'DIFF'}</td>
      </tr>`;
    }
  }

  // Test plan summary
  let testPlanRows = '';
  for (const [type, tests] of Object.entries(testsByType)) {
    testPlanRows += `<tr><td style="text-transform:capitalize;font-weight:600;">${type}</td><td>${tests.length}</td><td>${tests.map(t => t.name).slice(0, 3).join(', ')}${tests.length > 3 ? ` + ${tests.length - 3} more` : ''}</td></tr>`;
  }

  // Performance data
  const perfHtml = (() => {
    const siteLabels = SINGLE_MODE ? ['site1'] : ['site1', 'site2'];
    const perfKeys = Object.keys(pageData).filter(k => k.match(/^(site[12])_perf_/));
    if (perfKeys.length === 0) return '<div style="padding:20px;text-align:center;color:#6b7280;">No performance data collected. Performance tests run on live pages (HTTP 200) only.</div>';
    let h = '<div class="g2">';
    for (const label of siteLabels) {
      const keys = perfKeys.filter(k => k.startsWith(label + '_perf_'));
      h += `<div><h3 style="margin-bottom:10px;">${label === 'site1' ? SITE1_NAME : SITE2_NAME}</h3>`;
      for (const k of keys) {
        const p = pageData[k];
        if (!p || p.error) continue;
        const loadColor = p.loadTime > 5 ? '#ef4444' : p.loadTime > 3 ? '#f59e0b' : '#22c55e';
        const fcpColor = p.fcp > 2500 ? '#ef4444' : p.fcp > 1800 ? '#f59e0b' : '#22c55e';
        const lcpColor = p.lcp > 4000 ? '#ef4444' : p.lcp > 2500 ? '#f59e0b' : '#22c55e';
        const clsColor = p.cls > 0.25 ? '#ef4444' : p.cls > 0.1 ? '#f59e0b' : '#22c55e';
        h += `<div style="background:#0d1117;border-radius:8px;padding:14px;margin-bottom:10px;border:1px solid #1f2937;">`;
        h += `<div style="font-weight:700;margin-bottom:10px;">${p.page} <span style="color:#6b7280;font-weight:400;">Status: ${p.status}</span></div>`;
        h += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">`;
        h += `<div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${loadColor};">${p.loadTime}s</div><div style="font-size:10px;color:#6b7280;">Load</div></div>`;
        h += `<div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${fcpColor};">${p.fcp}ms</div><div style="font-size:10px;color:#6b7280;">FCP</div></div>`;
        h += `<div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${lcpColor};">${p.lcp}ms</div><div style="font-size:10px;color:#6b7280;">LCP</div></div>`;
        h += `<div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${clsColor};">${p.cls}</div><div style="font-size:10px;color:#6b7280;">CLS</div></div>`;
        h += `</div>`;
        h += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px;">`;
        h += `<div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.ttfb}ms</span><div style="color:#6b7280;font-size:10px;">TTFB</div></div>`;
        h += `<div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.totalRequests}</span><div style="color:#6b7280;font-size:10px;">Requests</div></div>`;
        h += `<div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.totalSize}KB</span><div style="color:#6b7280;font-size:10px;">Size</div></div>`;
        h += `<div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.domElements}</span><div style="color:#6b7280;font-size:10px;">DOM</div></div>`;
        h += `</div></div>`;
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  })();

  // Accessibility data
  const a11yHtml = (() => {
    const siteLabels = SINGLE_MODE ? ['site1'] : ['site1', 'site2'];
    const a11yKeys = Object.keys(pageData).filter(k => k.match(/^(site[12])_a11y_/) && !k.endsWith('_error'));
    if (a11yKeys.length === 0) return '<div style="padding:20px;text-align:center;color:#6b7280;">No accessibility data collected. A11y tests run on live pages (HTTP 200) only.</div>';
    let h = '<div class="g2">';
    for (const label of siteLabels) {
      const keys = a11yKeys.filter(k => k.startsWith(label + '_a11y_'));
      h += `<div><h3 style="margin-bottom:10px;">${label === 'site1' ? SITE1_NAME : SITE2_NAME}</h3>`;
      for (const k of keys) {
        const a = pageData[k];
        if (!a) continue;
        const scoreColor = a.score >= 80 ? '#22c55e' : a.score >= 50 ? '#f59e0b' : '#ef4444';
        const pagePath = k.replace(`${label}_a11y_`, '').replace(/_/g, '/');
        h += `<div style="background:#0d1117;border-radius:8px;padding:14px;margin-bottom:10px;border:1px solid #1f2937;">`;
        h += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">`;
        h += `<span style="font-weight:700;">${pagePath}</span>`;
        h += `<div style="width:50px;height:50px;border-radius:50%;border:3px solid ${scoreColor};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:${scoreColor};">${a.score}</div>`;
        h += `</div>`;
        if (a.issues && a.issues.length > 0) {
          for (const issue of a.issues.slice(0, 5)) {
            const ic = issue.severity === 'high' ? '#ef4444' : issue.severity === 'medium' ? '#f59e0b' : '#22c55e';
            h += `<div style="padding:6px;margin-bottom:3px;background:#020617;border-radius:4px;border-left:3px solid ${ic};font-size:11px;">`;
            h += `<span style="color:${ic};font-weight:600;text-transform:uppercase;font-size:10px;">${issue.severity}</span> ${issue.detail}</div>`;
          }
        }
        h += '</div>';
      }
      h += '</div>';
    }
    h += '</div>';
    return h;
  })();

  // Screenshots section — only show pages that have bugs, with error description
  const screenshotHtml = (() => {
    // Collect all unique page paths from screenshot keys
    const allKeys = Object.keys(screenshots);
    const pagePaths = new Set();
    // Also collect device-specific keys per page
    const deviceKeys = {}; // { pagePath: { site1: [{key, device, viewport}], site2: [...] } }
    const deviceViewports = {
      'desktop': '1440x900', 'desktop_hd': '1920x1080', 'laptop': '1366x768',
      'ipad_pro': '1024x1366', 'ipad_mini': '768x1024',
      'iphone_14_pro': '390x844', 'iphone_se': '375x667',
      'pixel_7': '412x915', 'samsung_galaxy_s21': '360x800'
    };

    for (const key of allKeys) {
      // Match sanity page keys: site1_page__products
      const pageMatch = key.match(/^(site[12])_page_(.+)$/);
      if (pageMatch) {
        const site = pageMatch[1];
        const rawPath = pageMatch[2].replace(/_/g, '/');
        pagePaths.add(rawPath);
        if (!deviceKeys[rawPath]) deviceKeys[rawPath] = { site1: [], site2: [] };
        deviceKeys[rawPath][site].push({ key, device: 'Desktop', viewport: '1440x900' });
      }
      // Match multi-device keys: site1___desktop, site1__products_iphone_14_pro
      const deviceMatch = key.match(/^(site[12])_(.+?)_(desktop|desktop_hd|laptop|ipad_pro|ipad_mini|iphone_14_pro|iphone_se|pixel_7|samsung_galaxy_s21)$/i);
      if (deviceMatch) {
        const site = deviceMatch[1];
        const rawPath = deviceMatch[2].replace(/_/g, '/');
        const deviceSlug = deviceMatch[3].toLowerCase();
        const deviceName = deviceSlug.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const viewport = deviceViewports[deviceSlug] || 'Unknown';
        if (!deviceKeys[rawPath]) deviceKeys[rawPath] = { site1: [], site2: [] };
        deviceKeys[rawPath][site].push({ key, device: deviceName, viewport });
      }
    }
    if (pagePaths.size === 0 && Object.keys(deviceKeys).length === 0) return '<div style="padding:20px;text-align:center;color:#6b7280;">No screenshots to display.</div>';

    // Build bug lookup by screenshot key
    const bugsByScreenshot = {};
    for (const b of uniqueBugs) {
      if (b.screenshotKey && screenshots[b.screenshotKey]) {
        if (!bugsByScreenshot[b.screenshotKey]) bugsByScreenshot[b.screenshotKey] = [];
        bugsByScreenshot[b.screenshotKey].push(b);
      }
    }

    let h = '';
    // Get all unique paths (from both page and device keys)
    const allPagesSet = new Set([...pagePaths, ...Object.keys(deviceKeys)]);

    for (const pagePath of allPagesSet) {
      const displayPath = pagePath === '/' || pagePath === '' ? '/' : '/' + pagePath.replace(/^\/+/, '');
      const site1Url = `${SITE1}${displayPath === '/' ? '' : displayPath}`;
      const site2Url = `${SITE2}${displayPath === '/' ? '' : displayPath}`;

      // Collect all screenshot entries for this page
      const pageDevices = deviceKeys[pagePath] || { site1: [], site2: [] };

      // If we have sanity-level page screenshots, show side-by-side
      const pathKey = pagePath.replace(/[^a-z0-9]/gi, '_');
      const site1PageKey = `site1_page_${pathKey}`;
      const site2PageKey = `site2_page_${pathKey}`;
      const hasSite1Page = screenshots[site1PageKey];
      const hasSite2Page = screenshots[site2PageKey];

      if (!hasSite1Page && !hasSite2Page && pageDevices.site1.length === 0 && pageDevices.site2.length === 0) continue;

      h += `<div class="sb" style="margin-bottom:24px;">`;
      h += `<div class="lb" style="padding:12px 16px;">
        <span style="font-size:13px;font-weight:700;">Page: ${displayPath}</span>
        <div style="font-size:10px;color:var(--text3);margin-top:4px;">
          <span style="color:#22c55e;">PROD:</span> <a href="${site1Url}" target="_blank" style="color:#22c55e;text-decoration:underline;">${site1Url}</a>
          &nbsp;&nbsp;|&nbsp;&nbsp;
          <span style="color:#3b82f6;">UAT:</span> <a href="${site2Url}" target="_blank" style="color:#3b82f6;text-decoration:underline;">${site2Url}</a>
        </div>
      </div>`;

      // Full page side-by-side (Desktop default)
      if (hasSite1Page || hasSite2Page) {
        h += `<div style="padding:6px 12px;background:var(--bg5);font-size:10px;color:var(--text3);border-top:1px solid var(--border);font-weight:700;">Desktop — 1440x900</div>`;
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--border);">`;
        // Production
        h += `<div style="border-right:1px solid var(--border);">`;
        h += `<div style="padding:6px 12px;background:var(--bg4);text-align:center;font-size:11px;font-weight:700;color:#22c55e;border-bottom:1px solid var(--border);">PRODUCTION — ${SITE1_NAME}</div>`;
        h += hasSite1Page ? imgTag(site1PageKey) : `<div style="padding:60px 20px;text-align:center;color:#6b7280;background:#111827;font-size:12px;">Screenshot not captured</div>`;
        h += `</div>`;
        // UAT
        h += `<div>`;
        h += `<div style="padding:6px 12px;background:var(--bg4);text-align:center;font-size:11px;font-weight:700;color:#3b82f6;border-bottom:1px solid var(--border);">UAT — ${SITE2_NAME}</div>`;
        h += hasSite2Page ? imgTag(site2PageKey) : `<div style="padding:60px 20px;text-align:center;color:#6b7280;background:#111827;font-size:12px;">Screenshot not captured</div>`;
        // UAT bugs
        const uatBugs = (bugsByScreenshot[site2PageKey] || []);
        if (uatBugs.length > 0) {
          const errorList = uatBugs.map(b => {
            const sevColor = b.severity === 'Critical' ? '#ef4444' : b.severity === 'High' ? '#f59e0b' : b.severity === 'Medium' ? '#3b82f6' : '#22c55e';
            return `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg5);border-radius:4px;border-left:3px solid ${sevColor};font-size:11px;">
              <span style="color:${sevColor};font-weight:700;">${b.severity}</span> ${b.title}
            </div>`;
          }).join('');
          h += `<div style="padding:10px;background:var(--bg4);border-top:1px solid var(--border);">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">UAT Issues (${uatBugs.length}):</div>
            ${errorList}
          </div>`;
        }
        h += `</div></div>`;

        // Visual diff comparison text for Desktop
        const diffData = (pageData._diffResults || {})[site1PageKey];
        if (diffData && diffData.diffPercent > 0) {
          h += `<div style="padding:10px 14px;background:#1e1b4b;border:1px solid #4338ca;border-radius:6px;margin:8px 12px;font-size:12px;color:#c7d2fe;">`;
          h += `<div style="font-weight:700;color:#818cf8;margin-bottom:6px;">Visual Differences Found (Desktop)</div>`;
          const lines = [];
          if (diffData.heightDiff && diffData.heightDiff > 0) {
            const taller = diffData.uatHeight > diffData.prodHeight ? 'UAT' : 'Prod';
            lines.push(`The ${taller} page is ${diffData.heightDiff} pixels taller than the other version.`);
          }
          if (diffData.regions && diffData.regions.length > 0) {
            for (const r of diffData.regions) {
              const areaName = r.name === 'Header/Top' ? 'header area (top of page)' : r.name === 'Middle/Content' ? 'main content area (middle of page)' : 'footer area (bottom of page)';
              lines.push(`There are visual changes in the ${areaName} — about ${r.percent}% of that section is different.`);
            }
          } else if (diffData.diffPercent > 0) {
            lines.push(`About ${diffData.diffPercent}% of the page pixels are different between Prod and UAT.`);
          }
          if (lines.length === 0) lines.push('Minor pixel-level differences detected, but no significant visual changes.');
          h += lines.map(l => `<div style="margin-bottom:4px;">• ${l}</div>`).join('');
          h += `</div>`;
        } else if (diffData && diffData.diffPercent === 0) {
          h += `<div style="padding:8px 14px;background:#052e16;border:1px solid #166534;border-radius:6px;margin:8px 12px;font-size:12px;color:#86efac;">✓ No visual differences — Prod and UAT look identical on Desktop.</div>`;
        }
      }

      // Multi-device screenshots side-by-side (grouped by device)
      const site2Devices = pageDevices.site2.filter(d => d.device !== 'Desktop');
      const site1Devices = pageDevices.site1.filter(d => d.device !== 'Desktop');
      // Merge device list from both sites
      const allDeviceNames = [...new Set([...site1Devices.map(d => d.device), ...site2Devices.map(d => d.device)])];

      for (const deviceName of allDeviceNames) {
        const s1Entry = site1Devices.find(d => d.device === deviceName);
        const s2Entry = site2Devices.find(d => d.device === deviceName);
        const viewport = (s2Entry || s1Entry).viewport;

        h += `<div style="padding:6px 12px;background:var(--bg5);font-size:10px;color:var(--text3);border-top:1px solid var(--border);font-weight:700;">${deviceName} — ${viewport}</div>`;
        h += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--border);">`;
        // Production
        h += `<div style="border-right:1px solid var(--border);">`;
        h += `<div style="padding:6px 12px;background:var(--bg4);text-align:center;font-size:11px;font-weight:700;color:#22c55e;border-bottom:1px solid var(--border);">PRODUCTION</div>`;
        h += s1Entry ? imgTag(s1Entry.key) : `<div style="padding:60px 20px;text-align:center;color:#6b7280;background:#111827;font-size:12px;">Not captured</div>`;
        h += `</div>`;
        // UAT
        h += `<div>`;
        h += `<div style="padding:6px 12px;background:var(--bg4);text-align:center;font-size:11px;font-weight:700;color:#3b82f6;border-bottom:1px solid var(--border);">UAT</div>`;
        h += s2Entry ? imgTag(s2Entry.key) : `<div style="padding:60px 20px;text-align:center;color:#6b7280;background:#111827;font-size:12px;">Not captured</div>`;
        // Device-specific UAT bugs
        if (s2Entry) {
          const devBugs = (bugsByScreenshot[s2Entry.key] || []);
          if (devBugs.length > 0) {
            const errorList = devBugs.map(b => {
              const sevColor = b.severity === 'Critical' ? '#ef4444' : b.severity === 'High' ? '#f59e0b' : b.severity === 'Medium' ? '#3b82f6' : '#22c55e';
              return `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg5);border-radius:4px;border-left:3px solid ${sevColor};font-size:11px;">
                <span style="color:${sevColor};font-weight:700;">${b.severity}</span> ${b.title}
              </div>`;
            }).join('');
            h += `<div style="padding:10px;background:var(--bg4);border-top:1px solid var(--border);">
              <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">UAT Issues (${devBugs.length}):</div>
              ${errorList}
            </div>`;
          }
        }
        h += `</div></div>`;

        // Visual diff comparison text for this device
        if (s1Entry && s2Entry) {
          const devDiff = (pageData._diffResults || {})[s1Entry.key];
          if (devDiff && devDiff.diffPercent > 0) {
            h += `<div style="padding:10px 14px;background:#1e1b4b;border:1px solid #4338ca;border-radius:6px;margin:8px 12px;font-size:12px;color:#c7d2fe;">`;
            h += `<div style="font-weight:700;color:#818cf8;margin-bottom:6px;">Visual Differences Found (${deviceName})</div>`;
            const lines = [];
            if (devDiff.heightDiff && devDiff.heightDiff > 0) {
              const taller = devDiff.uatHeight > devDiff.prodHeight ? 'UAT' : 'Prod';
              lines.push(`The ${taller} page is ${devDiff.heightDiff} pixels taller on this device.`);
            }
            if (devDiff.regions && devDiff.regions.length > 0) {
              for (const r of devDiff.regions) {
                const areaName = r.name === 'Header/Top' ? 'header area (top of page)' : r.name === 'Middle/Content' ? 'main content area (middle of page)' : 'footer area (bottom of page)';
                lines.push(`Changes in the ${areaName} — about ${r.percent}% of that section looks different.`);
              }
            } else if (devDiff.diffPercent > 0) {
              lines.push(`About ${devDiff.diffPercent}% of the page pixels are different between Prod and UAT.`);
            }
            if (lines.length === 0) lines.push('Minor pixel-level differences detected, but no major visual changes.');
            h += lines.map(l => `<div style="margin-bottom:4px;">• ${l}</div>`).join('');
            h += `</div>`;
          } else if (devDiff && devDiff.diffPercent === 0) {
            h += `<div style="padding:8px 14px;background:#052e16;border:1px solid #166534;border-radius:6px;margin:8px 12px;font-size:12px;color:#86efac;">✓ No visual differences — Prod and UAT look identical on ${deviceName}.</div>`;
          }
        }
      }

      h += `</div>`;
    }
    return h;
  })();

  // Footer links validation results
  const footerHtml = (() => {
    const siteLabels = SINGLE_MODE ? ['site1'] : ['site1', 'site2'];
    let h = '<div class="g2">';
    for (const label of siteLabels) {
      const results = pageData[`${label}_footer_results`] || [];
      h += `<div><h3 style="margin-bottom:8px;">${label === 'site1' ? SITE1_NAME : SITE2_NAME} (${results.length} links)</h3>`;
      if (results.length === 0) { h += '<div style="color:#6b7280;padding:8px;">No footer links tested.</div></div>'; continue; }
      h += '<table><thead><tr><th>Link</th><th>Status</th><th>URL</th></tr></thead><tbody>';
      for (const r of results) {
        h += `<tr><td>${r.text || '-'}</td><td>${r.status === 200 ? '<span class="badge bg-pass">200</span>' : r.status === 404 ? '<span class="badge bg-fail">404</span>' : r.status === 'external' ? '<span class="badge bg-info">Ext</span>' : `<span class="badge bg-warn">${r.status}</span>`}</td><td style="font-size:11px;word-break:break-all;">${r.href || ''}</td></tr>`;
      }
      h += '</tbody></table></div>';
    }
    h += '</div>';
    return h;
  })();

  // Redirection results
  const redirectHtml = (() => {
    const allFailed = [];
    for (const [label, idx] of [['site1', 0], ['site2', 1]]) {
      const redirects = pageData[`${label}_redirections`] || [];
      for (const r of redirects) {
        const isFailed = (r.expectRedirect && !r.redirected && r.status !== 404) || r.status === 404 || r.error;
        if (isFailed) allFailed.push({ ...r, site: 'Site ' + (idx + 1) });
      }
    }
    if (allFailed.length === 0) return '<div style="padding:20px;text-align:center;color:#22c55e;">All redirections working correctly.</div>';
    let h = `<div style="margin-bottom:8px;color:#fca5a5;font-weight:600;">${allFailed.length} redirection failures</div>`;
    h += '<table><thead><tr><th>Site</th><th>Page</th><th>Path</th><th>Status</th><th>Issue</th></tr></thead><tbody>';
    for (const r of allFailed) {
      let issue = r.status === 404 ? 'Page 404' : r.error ? 'Error' : 'Should redirect to login';
      h += `<tr style="background:#1a0000;"><td>${r.site}</td><td>${r.name}</td><td style="font-family:monospace">${r.path}</td><td><span class="badge bg-fail">${r.status || 'ERR'}</span></td><td style="color:#fca5a5;">${issue}</td></tr>`;
    }
    h += '</tbody></table>';
    return h;
  })();

  // Bug summary by category
  let categoryChart = '';
  for (const [cat, catBugs] of Object.entries(bugsByCategory)) {
    const pct = Math.round((catBugs.length / uniqueBugs.length) * 100);
    categoryChart += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span style="width:100px;font-size:12px;">${cat}</span><div style="flex:1;background:#1f2937;border-radius:4px;height:20px;overflow:hidden;"><div style="height:100%;background:var(--accent);width:${pct}%;border-radius:4px;"></div></div><span style="font-size:12px;color:#6b7280;">${catBugs.length}</span></div>`;
  }

  // Pie chart
  const total2 = counts.total || 1;
  const slices = [
    { count: counts.critical, color: '#ef4444' },
    { count: counts.high, color: '#f59e0b' },
    { count: counts.medium, color: '#3b82f6' },
    { count: counts.low, color: '#22c55e' },
  ];
  let cumulativePercent = 0;
  let pieSlices = '';
  for (const slice of slices) {
    if (slice.count === 0) continue;
    const percent = (slice.count / total2) * 100;
    pieSlices += `<circle r="15.9155" cx="50" cy="50" fill="none" stroke="${slice.color}" stroke-width="10" stroke-dasharray="${percent} ${100 - percent}" stroke-dashoffset="${-cumulativePercent}" />`;
    cumulativePercent += percent;
  }

  // Learning insights HTML
  const insightsHtml = (() => {
    if (insights.length === 0) return '<div style="padding:20px;text-align:center;color:#6b7280;">No learning insights yet — run again to see improvements.</div>';
    let h = '';
    for (const ins of insights) {
      const colors = { success: '#22c55e', critical: '#ef4444', warning: '#f59e0b', high: '#f59e0b', info: '#3b82f6' };
      const bgColors = { success: '#052e16', critical: '#450a0a', warning: '#451a03', high: '#451a03', info: '#0c2d57' };
      const icons = { new: 'NEW', warning: 'WARN', success: 'OK', error: 'ERR', up: 'UP', down: 'DOWN', expand: 'EXP', star: 'START' };
      const c = colors[ins.severity] || '#6b7280';
      const bg = bgColors[ins.severity] || '#1f2937';
      h += `<div style="background:${bg};border-left:4px solid ${c};border-radius:8px;padding:14px;margin-bottom:8px;">`;
      h += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">`;
      h += `<span class="badge" style="background:${c};color:#fff;">${icons[ins.icon] || ins.icon}</span>`;
      h += `<span style="font-weight:700;color:${c};">${ins.title}</span>`;
      h += `</div>`;
      h += `<div style="font-size:13px;color:var(--text2);">${ins.description}</div>`;
      h += `</div>`;
    }

    // Bug classification breakdown
    h += `<div style="margin-top:16px;display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">`;
    h += `<div class="stat-item"><div class="val" style="color:#3b82f6">${classified.newBugs.length}</div><div class="lbl">New Bugs</div></div>`;
    h += `<div class="stat-item"><div class="val" style="color:#f59e0b">${classified.recurringBugs.length}</div><div class="lbl">Recurring</div></div>`;
    h += `<div class="stat-item"><div class="val" style="color:#22c55e">${classified.fixedBugs.length}</div><div class="lbl">Fixed</div></div>`;
    h += `<div class="stat-item"><div class="val" style="color:#ef4444">${classified.regressions.length}</div><div class="lbl">Regressions</div></div>`;
    h += `</div>`;


    // Fixed bugs list
    if (classified.fixedBugs.length > 0) {
      h += `<div style="margin-top:16px;"><h4 style="margin-bottom:8px;color:#22c55e;">Bugs Fixed Since Last Run</h4>`;
      for (const fb of classified.fixedBugs.slice(0, 10)) {
        h += `<div style="padding:8px;background:#052e16;border-radius:4px;margin-bottom:4px;font-size:12px;border-left:3px solid #22c55e;">`;
        h += `<span style="color:#86efac;">${fb.title}</span>`;
        if (fb.previousOccurrences > 1) h += ` <span style="color:#6b7280;">(was recurring ${fb.previousOccurrences}x)</span>`;
        h += `</div>`;
      }
      h += `</div>`;
    }

    return h;
  })();

  // Sidebar nav — dynamic based on available sections
  const hasFooter = !footerHtml.includes('No footer');
  const hasRedirect = !redirectHtml.includes('All redirections working') && !redirectHtml.includes('No redirection');
  const hasPerf = !perfHtml.includes('No performance data');
  const hasA11y = !a11yHtml.includes('No accessibility data');
  const sections = [
    { id: 'summary', label: 'Summary' },
    { id: 'discovery', label: 'Discovery' },
    { id: 'test-plan', label: 'Test Plan' },
    { id: 'crawl-results', label: 'Crawl Results' },
    { id: 'screenshots', label: 'Screenshots' },
    ...(hasFooter ? [{ id: 'footer-links', label: 'Footer Links' }] : []),
    ...(hasRedirect ? [{ id: 'redirections', label: 'Redirections' }] : []),
    ...(hasPerf ? [{ id: 'performance', label: 'Performance' }] : []),
    ...(hasA11y ? [{ id: 'accessibility', label: 'Accessibility' }] : []),
    { id: 'all-bugs', label: 'Bug Report' },
    { id: 'bug-categories', label: 'By Category' },
  ];
  const sidebarLinks = sections.map(s => `<a href="#${s.id}" class="nav-link">${s.label}</a>`).join('');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Dynamic QA Report — ${new Date().toISOString().split('T')[0]}</title>
<style>
:root{--bg:#0a0a0f;--bg2:#111827;--bg3:#0d1117;--bg4:#161b22;--bg5:#020617;--border:#1e293b;--text:#e2e8f0;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--radius:12px}
[data-theme="light"]{--bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#e8ecf1;--bg5:#f1f5f9;--border:#d1d5db;--text:#1e293b;--text2:#475569;--text3:#64748b;--accent:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;line-height:1.5}
/* Sidebar */
.sidebar{position:fixed;top:0;left:0;width:230px;height:100vh;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:100;padding:0;transition:transform .3s;display:flex;flex-direction:column}
.sidebar .logo{padding:20px 20px 16px;font-weight:800;font-size:16px;color:var(--accent);border-bottom:1px solid var(--border);letter-spacing:-.3px}
.sidebar .logo small{display:block;font-size:10px;color:var(--text3);font-weight:400;margin-top:4px;letter-spacing:.5px;text-transform:uppercase}
.nav-link{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px;color:var(--text2);text-decoration:none;border-left:3px solid transparent;transition:all .2s}
.nav-link:hover{background:var(--bg4);color:var(--text)}
.nav-link.active{background:var(--bg3);color:var(--accent);border-left-color:var(--accent);font-weight:600}
/* Main */
.main{margin-left:230px;flex:1;min-width:0}
.hdr{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 40%,#2563eb 100%);padding:32px 40px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.hdr h1{font-size:22px;color:#fff;font-weight:700;letter-spacing:-.3px}
.hdr p{color:#93c5fd;font-size:13px;margin-top:6px}
.hdr .site-urls{margin-top:8px;display:flex;gap:20px;flex-wrap:wrap}
.hdr .site-url{font-size:11px;padding:4px 12px;border-radius:6px;display:inline-flex;align-items:center;gap:6px}
.hdr .site-url.prod{background:rgba(34,197,94,.15);color:#86efac;border:1px solid rgba(34,197,94,.3)}
.hdr .site-url.uat{background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.3)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbar input{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;width:200px;backdrop-filter:blur(4px)}
.toolbar input::placeholder{color:rgba(255,255,255,.5)}
.toolbar button,.filter-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;transition:all .2s;font-weight:500}
.toolbar button:hover,.filter-btn:hover,.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);transform:translateY(-1px)}
.ctr{max-width:1400px;margin:0 auto;padding:24px}
/* Summary cards */
.exec-card{background:var(--bg2);border-radius:var(--radius);padding:24px;margin:20px 0;border:1px solid var(--border);display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:center}
.pie-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.pie-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;justify-content:center}
.pie-legend span{display:flex;align-items:center;gap:5px}
.pie-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0}
.stat-item{background:var(--bg3);border-radius:10px;padding:16px 12px;text-align:center;border:1px solid var(--border);transition:transform .2s}
.stat-item:hover{transform:translateY(-2px)}
.stat-item .val{font-size:26px;font-weight:800;line-height:1}
.stat-item .lbl{font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:6px;letter-spacing:.5px}
/* Sections */
.sec{background:var(--bg2);border-radius:var(--radius);margin:20px 0;border:1px solid var(--border);overflow:hidden;transition:box-shadow .2s}
.sec:hover{box-shadow:0 4px 20px rgba(0,0,0,.15)}
.sec-h{padding:16px 24px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.sec-h h2{font-size:16px;font-weight:700;display:flex;align-items:center;gap:10px}
.sec-b{padding:24px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:12px 0}
/* Screenshot cards */
.sb{background:var(--bg);border-radius:10px;overflow:hidden;border:1px solid var(--border);transition:box-shadow .2s}
.sb:hover{box-shadow:0 4px 16px rgba(0,0,0,.2)}
.sb .lb{padding:10px 16px;font-weight:600;font-size:12px;background:var(--bg4);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sb img{width:100%;display:block;cursor:zoom-in;transition:opacity .4s}
/* Badges */
.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.bg-critical{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.bg-high{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-medium{background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f}
.bg-low{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-pass{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-fail{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.bg-warn{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-info{background:#1e1b4b;color:#a5b4fc;border:1px solid #312e81}
/* Tables */
table{width:100%;border-collapse:collapse}
th{background:var(--bg3);padding:10px 14px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px}
tr{transition:background .15s}
tr:hover{background:var(--bg4)}
/* Bug cards */
.bug-card{background:var(--bg3);border-radius:var(--radius);margin:16px 0;border-left:4px solid;overflow:hidden;transition:box-shadow .2s}
.bug-card:hover{box-shadow:0 2px 12px rgba(0,0,0,.15)}
.bug-critical{border-color:#ef4444}.bug-high{border-color:#f59e0b}.bug-medium{border-color:#3b82f6}.bug-low{border-color:#22c55e}
.bug-card-header{padding:16px 20px;background:var(--bg4);border-bottom:1px solid var(--border)}
.bug-card-header h3{font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-weight:600}
.bug-card-body{padding:20px}
.bug-detail-table{width:100%;border-collapse:collapse;font-size:13px}
.bug-detail-table tr{border-bottom:1px solid var(--border)}
.bug-detail-table tr:last-child{border-bottom:none}
.bug-detail-table td{padding:10px 14px;vertical-align:top;line-height:1.6}
.bug-field{font-weight:700;color:var(--text2);white-space:nowrap;width:100px;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.pass-text{color:#22c55e}.fail-text{color:#ef4444}
.bug-detail-table code{display:inline-block;background:var(--bg5);padding:8px 12px;border-radius:6px;font-size:12px;color:#67e8f9;white-space:pre-wrap;font-family:'Fira Code',Consolas,monospace}
.bug-screenshot{margin-top:14px;border-radius:10px;overflow:hidden;border:1px solid var(--border)}
.bug-screenshot img{width:100%;display:block;max-height:400px;object-fit:contain;background:#0a0a0a}
.bug-ss-caption{padding:10px 14px;background:var(--bg5);font-size:11px;color:var(--text2);font-style:italic}
/* Fix cards */
.fix-card{background:var(--bg3);border-radius:10px;padding:16px;margin:8px 0;border-left:3px solid}
.fix-card.c{border-color:#ef4444}.fix-card.h{border-color:#f59e0b}.fix-card.m{border-color:#3b82f6}.fix-card.l{border-color:#22c55e}
.fix-card h4{margin-bottom:5px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fix-card p{color:var(--text2);font-size:13px;margin-bottom:5px}
.fix-card code{display:block;background:var(--bg5);padding:10px;border-radius:6px;font-size:12px;color:#67e8f9;margin-top:5px;white-space:pre-wrap;font-family:monospace}
/* Utility */
.crit{color:#ef4444}.high{color:#f59e0b}.med{color:#3b82f6}.low{color:#22c55e}.pass{color:#22c55e}.fail{color:#ef4444}
.ftr{text-align:center;padding:32px;color:var(--text3);font-size:11px;border-top:1px solid var(--border);margin-top:24px}
.filters{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.hidden{display:none!important}
.zoom-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(4px)}
.zoom-overlay img{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}
/* Scrollbar */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text3)}
/* Print & responsive */
@media print{.sidebar,.toolbar,.filters,.zoom-overlay{display:none!important}.main{margin-left:0!important}.sec{break-inside:avoid}.badge,.sc,.fix-card{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media(max-width:900px){.sidebar{transform:translateX(-100%)}.main{margin-left:0}.sg{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:1fr}.exec-card{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav class="sidebar" id="sidebar">
  <div class="logo">QA Report<small>${new Date().toISOString().split('T')[0]}</small></div>
  ${sidebarLinks}
</nav>
<div class="main">
<div class="hdr">
  <div>
    <h1>Website QA Report <span style="font-size:11px;background:rgba(255,255,255,.2);color:#fff;padding:3px 12px;border-radius:20px;vertical-align:middle;font-weight:500;backdrop-filter:blur(4px);">${modeLabel}</span></h1>
    <p>${new Date().toISOString().split('T')[0]} &middot; ${testPlan.length} tests &middot; ${elapsed}s &middot; Budget: ${budgetMin}min</p>
    <div class="site-urls">
      ${SINGLE_MODE ? `<span class="site-url prod">${SITE1_NAME}</span>` : `<span class="site-url prod">PROD: ${SITE1_NAME}</span><span class="site-url uat">UAT: ${SITE2_NAME}</span>`}
    </div>
  </div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="Search bugs..." onkeyup="filterBugs()">
    <button onclick="toggleTheme()">Theme</button>
    <button onclick="window.print()">Print</button>
  </div>
</div>
<div class="ctr">

<!-- EXECUTIVE SUMMARY -->
<div id="summary" class="exec-card">
  <div class="pie-wrap">
    <svg viewBox="0 0 100 100" width="120" height="120" style="transform:rotate(-90deg)">
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="var(--border)" stroke-width="10"/>
      ${pieSlices}
    </svg>
    <div class="pie-legend">
      <span><span class="dot" style="background:#ef4444"></span>${counts.critical} Critical</span>
      <span><span class="dot" style="background:#f59e0b"></span>${counts.high} High</span>
      <span><span class="dot" style="background:#3b82f6"></span>${counts.medium} Medium</span>
      <span><span class="dot" style="background:#22c55e"></span>${counts.low} Low</span>
    </div>
  </div>
  <div>
    <div class="stat-grid">
      <div class="stat-item"><div class="val" style="color:var(--text)">${counts.total}</div><div class="lbl">Total Bugs</div></div>
      <div class="stat-item"><div class="val crit">${counts.critical}</div><div class="lbl">Critical</div></div>
      <div class="stat-item"><div class="val high">${counts.high}</div><div class="lbl">High</div></div>
      <div class="stat-item"><div class="val med">${counts.medium}</div><div class="lbl">Medium</div></div>
      <div class="stat-item"><div class="val low">${counts.low}</div><div class="lbl">Low</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${testPlan.length}</div><div class="lbl">Tests Run</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${allPaths.length}</div><div class="lbl">Pages Found</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${Object.keys(screenshots).length}</div><div class="lbl">Screenshots</div></div>
    </div>
  </div>
</div>


<!-- DISCOVERY -->
<div id="discovery" class="sec">
  <div class="sec-h"><h2>Site Discovery Results</h2><span class="badge bg-info">${d1.totalPages + d2.totalPages} pages crawled</span></div>
  <div class="sec-b">
    <table>
      <thead><tr><th>Feature</th><th>${SITE1_NAME}</th>${SINGLE_MODE ? '' : `<th>${SITE2_NAME}</th>`}</tr></thead>
      <tbody>${discoveryRows}</tbody>
    </table>
  </div>
</div>

<!-- TEST PLAN -->
<div id="test-plan" class="sec">
  <div class="sec-h"><h2>Dynamic Test Plan</h2><span class="badge bg-info">${testPlan.length} TESTS</span></div>
  <div class="sec-b">
    <table>
      <thead><tr><th>Test Type</th><th>Count</th><th>Examples</th></tr></thead>
      <tbody>${testPlanRows}</tbody>
    </table>
  </div>
</div>

<!-- CRAWL RESULTS -->
<div id="crawl-results" class="sec">
  <div class="sec-h"><h2>All Pages Crawled</h2><span class="badge bg-info">${allPaths.length} PATHS</span></div>
  <div class="sec-b">
    <table>
      <thead><tr><th>Path</th><th>${SINGLE_MODE ? 'Status' : SITE1_NAME}</th>${SINGLE_MODE ? '' : `<th>${SITE2_NAME}</th><th>Match</th>`}</tr></thead>
      <tbody>${crawlRows}</tbody>
    </table>
  </div>
</div>

<!-- SCREENSHOTS -->
<div id="screenshots" class="sec">
  <div class="sec-h"><h2>Screenshots</h2><span class="badge bg-info">${Object.keys(screenshots).length} captured</span></div>
  <div class="sec-b">${screenshotHtml}</div>
</div>

${footerHtml.includes('No footer') ? '' : `<!-- FOOTER LINKS -->
<div id="footer-links" class="sec">
  <div class="sec-h"><h2>Footer Link Validation</h2></div>
  <div class="sec-b">${footerHtml}</div>
</div>`}

${redirectHtml.includes('All redirections working') || redirectHtml.includes('No redirection') ? '' : `<!-- REDIRECTIONS -->
<div id="redirections" class="sec">
  <div class="sec-h"><h2>Redirection Tests</h2></div>
  <div class="sec-b">${redirectHtml}</div>
</div>`}

${perfHtml.includes('No performance data') ? '' : `<!-- PERFORMANCE -->
<div id="performance" class="sec">
  <div class="sec-h"><h2>Performance Metrics</h2><span class="badge bg-info">Core Web Vitals</span></div>
  <div class="sec-b">${perfHtml}</div>
</div>`}

${a11yHtml.includes('No accessibility data') ? '' : `<!-- ACCESSIBILITY -->
<div id="accessibility" class="sec">
  <div class="sec-h"><h2>Accessibility Scorecard</h2><span class="badge bg-info">WCAG</span></div>
  <div class="sec-b">${a11yHtml}</div>
</div>`}

<!-- ALL BUGS -->
<div id="all-bugs" class="sec">
  <div class="sec-h"><h2>Bug Report (${counts.total} Issues Found)</h2></div>
  <div class="sec-b">
    <div class="filters">
      <button class="filter-btn active" onclick="filterSeverity('all')">All (${counts.total})</button>
      <button class="filter-btn" onclick="filterSeverity('Critical')">Critical (${counts.critical})</button>
      <button class="filter-btn" onclick="filterSeverity('High')">High (${counts.high})</button>
      <button class="filter-btn" onclick="filterSeverity('Medium')">Medium (${counts.medium})</button>
      <button class="filter-btn" onclick="filterSeverity('Low')">Low (${counts.low})</button>
    </div>
    ${bugCards}
  </div>
</div>

<!-- BUG CATEGORIES -->
<div id="bug-categories" class="sec">
  <div class="sec-h"><h2>Bugs by Category</h2></div>
  <div class="sec-b">${categoryChart}</div>
</div>

<div class="ftr">
  <p>${counts.total} bugs found &middot; ${testPlan.length} tests &middot; ${Object.keys(screenshots).length} screenshots &middot; ${executedPhases.length} phases &middot; ${elapsed}s</p>
  <p style="margin-top:4px;opacity:.6;">Automated QA Report &middot; ${new Date().toISOString().split('T')[0]}</p>
</div>

</div>
</div>

<div id="img-loader-bar" style="position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#3b82f6,#22c55e);z-index:9999;transition:width .3s;width:0%"></div>
<div id="img-loader-status" style="position:fixed;top:6px;right:16px;z-index:9999;font-size:11px;color:#6b7280;background:var(--bg2);padding:2px 10px;border-radius:8px;border:1px solid var(--border);opacity:1;transition:opacity .5s"></div>

<script>
function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}
function filterSeverity(sev){document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));(window.event||{}).target&&window.event.target.classList.add('active');document.querySelectorAll('#all-bugs .bug-card').forEach(c=>{if(sev==='all'){c.classList.remove('hidden');return}c.classList.toggle('hidden',c.dataset.severity!==sev)})}
function filterBugs(){const q=document.getElementById('searchInput').value.toLowerCase();document.querySelectorAll('#all-bugs .bug-card').forEach(c=>{c.classList.toggle('hidden',q&&!c.textContent.toLowerCase().includes(q))})}
/* Collapsible sections — click header to toggle */
document.querySelectorAll('.sec-h').forEach(h=>{h.addEventListener('click',()=>{const body=h.nextElementSibling;if(body&&body.classList.contains('sec-b')){body.style.display=body.style.display==='none'?'block':'none';h.querySelector('.collapse-icon')&&(h.querySelector('.collapse-icon').textContent=body.style.display==='none'?'+':'-')}})});
/* Image zoom */
document.addEventListener('click',e=>{if(e.target.tagName==='IMG'&&e.target.closest('.sb')){const o=document.createElement('div');o.className='zoom-overlay';const i=document.createElement('img');i.src=e.target.dataset.src||e.target.src;o.appendChild(i);o.onclick=()=>o.remove();document.body.appendChild(o)}});
/* Sidebar active tracking */
const obs=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){document.querySelectorAll('.nav-link').forEach(l=>l.classList.remove('active'));const link=document.querySelector('.nav-link[href="#'+e.target.id+'"]');if(link)link.classList.add('active')}})},{threshold:0.2});
document.querySelectorAll('[id]').forEach(s=>{if(s.classList.contains('sec')||s.classList.contains('exec-card')||s.id==='screenshots')obs.observe(s)});

/* ── Progressive Image Loader — all images in 10s ── */
(function(){
  const imgs=document.querySelectorAll('img.lazy-img[data-src]');
  const total=imgs.length;
  if(!total)return;
  const bar=document.getElementById('img-loader-bar');
  const status=document.getElementById('img-loader-status');
  const BUDGET_MS=10000;
  const batchSize=Math.max(1,Math.ceil(total/20));
  const interval=Math.floor(BUDGET_MS/Math.ceil(total/batchSize));
  let loaded=0;
  let idx=0;
  status.textContent='Loading 0/'+total+' screenshots...';

  /* Load visible images first (above fold) */
  const visibleFirst=[];
  const rest=[];
  imgs.forEach(img=>{
    const rect=img.getBoundingClientRect();
    if(rect.top<window.innerHeight*2)visibleFirst.push(img);
    else rest.push(img);
  });
  const ordered=[...visibleFirst,...rest];

  function loadBatch(){
    const end=Math.min(idx+batchSize,total);
    for(let i=idx;i<end;i++){
      const img=ordered[i];
      if(img.dataset.src){
        img.src=img.dataset.src;
        img.removeAttribute('data-src');
        img.style.opacity='0';
        img.style.transition='opacity .4s';
        img.onload=function(){this.style.opacity='1'};
      }
      loaded++;
    }
    idx=end;
    const pct=Math.round((loaded/total)*100);
    bar.style.width=pct+'%';
    status.textContent='Loading '+loaded+'/'+total+' screenshots... ('+pct+'%)';
    if(idx>=total){
      bar.style.width='100%';
      status.textContent=total+' screenshots loaded';
      setTimeout(()=>{bar.style.opacity='0';status.style.opacity='0'},2000);
      setTimeout(()=>{bar.remove();status.remove()},2500);
    }else{
      setTimeout(loadBatch,interval);
    }
  }
  /* Start after DOM is interactive — slight delay for layout paint */
  setTimeout(loadBatch,100);
})();
</script>
</body></html>`;

  // Save screenshots as separate PNG files for lightweight HTML
  const ssDir = path.join(REPORT_DIR, 'screenshots');
  if (!fs.existsSync(ssDir)) fs.mkdirSync(ssDir, { recursive: true });
  for (const [key, b64Data] of Object.entries(screenshots)) {
    fs.writeFileSync(path.join(ssDir, `${key}.png`), Buffer.from(b64Data, 'base64'));
  }

  const reportPath = path.join(REPORT_DIR, 'full-comparison-report.html');
  fs.writeFileSync(reportPath, html);

  // Save JSON
  fs.writeFileSync(path.join(REPORT_DIR, 'bug-report.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    execution_mode: MODE,
    time_budget_minutes: Math.round(BUDGET.totalMs / 60000),
    elapsed_seconds: budget.elapsedSec(),
    coverage_level: MODE === 'fast' ? 'risk-prioritized' : MODE === 'deep' ? 'exhaustive' : 'balanced',
    executed_phases: executedPhases,
    skipped_phases: skippedPhases,
    site1: SITE1,
    site2: SITE2,
    runNumber: runSummary.runNumber,
    testPlanSize: testPlan.length,
    summary: counts,
    learning: {
      newBugs: classified.newBugs.length,
      recurringBugs: classified.recurringBugs.length,
      fixedBugs: classified.fixedBugs.length,
      regressions: classified.regressions.length,
      insights: insights.map(i => ({ title: i.title, severity: i.severity })),
      runComparison: comparison,
    },
    bugsByCategory,
    bugsByTestType,
    phaseTimings: Object.fromEntries(Object.entries(phaseTimings).filter(([, v]) => v.end).map(([k, v]) => [k, v.duration + 's'])),
    bugs: uniqueBugs,
    discovery: { site1: pageData.discovery1, site2: pageData.discovery2 },
  }, null, 2));

  // Copy as index.html for deployment
  fs.copyFileSync(reportPath, path.join(REPORT_DIR, 'index.html'));

  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║  REPORT COMPLETE — Run #${runSummary.runNumber} — ${counts.total} bugs in ${elapsed}s`);
  console.log(`  ║  Mode: ${modeLabel} | Budget: ${budgetMin}min | Elapsed: ${elapsed}s`);
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Tests: ${testPlan.length} | Pages: ${allPaths.length} | Screenshots: ${Object.keys(screenshots).length}`);
  console.log(`  ║  Critical: ${counts.critical}  High: ${counts.high}  Medium: ${counts.medium}  Low: ${counts.low}`);
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Phases: ${executedPhases.length} run, ${skippedPhases.length} skipped`);
  console.log(`  ║  NEW: ${classified.newBugs.length} | RECURRING: ${classified.recurringBugs.length} | FIXED: ${classified.fixedBugs.length} | REGRESSION: ${classified.regressions.length}`);
  console.log('  ╠══════════════════════════════════════════════════╣');
  console.log(`  ║  Report: reports/full-comparison-report.html`);
  console.log('  ╚══════════════════════════════════════════════════╝\n');

  // Auto-open report
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${cmd} "${reportPath}"`);
  } catch {}

  // Auto-deploy to GitHub Pages (with report history)
  const GH_REPO = 'https://github.com/gauravjadhav-glitch/HTML-file-.git';
  const GH_PAGES_URL = 'https://gauravjadhav-glitch.github.io/HTML-file-/';
  console.log('  Deploying to GitHub Pages...');
  try {
    const deployDir = path.join(REPORT_DIR, 'deploy');

    // Clone existing gh-pages to preserve history, or init fresh
    if (fs.existsSync(deployDir)) fs.rmSync(deployDir, { recursive: true });
    try {
      execSync(`git clone --branch gh-pages --single-branch ${GH_REPO} "${deployDir}" 2>&1`, { encoding: 'utf8', timeout: 60000 });
    } catch {
      fs.mkdirSync(deployDir, { recursive: true });
      execSync('git init && git checkout -B gh-pages', { cwd: deployDir, encoding: 'utf8' });
      execSync(`git remote add origin ${GH_REPO}`, { cwd: deployDir, encoding: 'utf8' });
    }

    // Build unique folder name for this run: run-17_coachnew-fynd-io_2026-04-02
    const siteName = SITE1.replace(/https?:\/\//, '').replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/-$/, '');
    const dateStr = new Date().toISOString().slice(0, 10);
    const timeStr = new Date().toISOString().slice(11, 16).replace(':', '');
    const runFolder = `run-${runSummary.runNumber}_${siteName}_${dateStr}_${timeStr}`;
    const runDir = path.join(deployDir, runFolder);
    fs.mkdirSync(runDir, { recursive: true });

    // Copy report files into run folder
    const filesToCopy = ['full-comparison-report.html', 'bug-report.json'];
    for (const f of filesToCopy) {
      const src = path.join(REPORT_DIR, f);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(runDir, f));
    }
    // Copy index.html into run folder
    const srcIndex = path.join(REPORT_DIR, 'index.html');
    if (fs.existsSync(srcIndex)) fs.copyFileSync(srcIndex, path.join(runDir, 'index.html'));

    // Copy screenshots
    const ssDir = path.join(REPORT_DIR, 'screenshots');
    if (fs.existsSync(ssDir)) {
      execSync(`cp -r "${ssDir}" "${runDir}/screenshots"`, { encoding: 'utf8' });
    }

    // Also copy latest as root index redirect
    if (fs.existsSync(srcIndex)) fs.copyFileSync(srcIndex, path.join(deployDir, 'latest.html'));

    // Build index.html listing all reports
    const reportDirs = fs.readdirSync(deployDir)
      .filter(d => d.startsWith('run-') && fs.statSync(path.join(deployDir, d)).isDirectory())
      .sort().reverse();

    const indexRows = reportDirs.map(d => {
      const parts = d.match(/^run-(\d+)_(.+?)_(\d{4}-\d{2}-\d{2})_(\d{4})$/);
      let bugInfo = '';
      const bjPath = path.join(deployDir, d, 'bug-report.json');
      if (fs.existsSync(bjPath)) {
        try {
          const bj = JSON.parse(fs.readFileSync(bjPath, 'utf8'));
          bugInfo = `${bj.totalBugs || '?'} bugs — C:${bj.summary?.critical||0} H:${bj.summary?.high||0} M:${bj.summary?.medium||0} L:${bj.summary?.low||0}`;
        } catch {}
      }
      const site = parts ? parts[2].replace(/-/g, '.') : '';
      const date = parts ? parts[3] : '';
      const time = parts ? parts[4].slice(0,2) + ':' + parts[4].slice(2) : '';
      const runNum = parts ? parts[1] : '';
      return `<tr>
        <td><strong>#${runNum}</strong></td>
        <td>${site}</td>
        <td>${date} ${time}</td>
        <td>${bugInfo}</td>
        <td><a href="${d}/index.html">View Report</a></td>
      </tr>`;
    }).join('\n');

    const indexHtml = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Test Reports</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; }
  h1 { font-size: 1.8rem; margin-bottom: 0.5rem; color: #38bdf8; }
  p.sub { color: #94a3b8; margin-bottom: 2rem; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #334155; color: #38bdf8; text-align: left; padding: 12px 16px; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
  td { padding: 12px 16px; border-bottom: 1px solid #334155; font-size: 0.95rem; }
  tr:hover { background: #334155; }
  a { color: #38bdf8; text-decoration: none; font-weight: 600; }
  a:hover { text-decoration: underline; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.8rem; font-weight: 600; }
</style>
</head><body>
<h1>QA Test Reports</h1>
<p class="sub">All test runs — click any report to view full details with screenshots</p>
<table>
  <thead><tr><th>Run</th><th>Site</th><th>Date</th><th>Bugs</th><th>Report</th></tr></thead>
  <tbody>
${indexRows}
  </tbody>
</table>
</body></html>`;

    fs.writeFileSync(path.join(deployDir, 'index.html'), indexHtml);

    // Git commit and push
    const gitCmds = [
      `git add -A`,
      `git commit -m "Report #${runSummary.runNumber} — ${siteName} — ${counts.total} bugs — ${dateStr}"`,
      `git push origin gh-pages`,
    ].join(' && ');
    execSync(gitCmds, { cwd: deployDir, encoding: 'utf8', timeout: 120000 });

    const reportUrl = `${GH_PAGES_URL}${runFolder}/index.html`;
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log(`  ║  Report:  ${reportUrl}`);
    console.log(`  ║  All Reports: ${GH_PAGES_URL}`);
    console.log('  ╚══════════════════════════════════════════════════╝\n');
    try { execSync(`${process.platform === 'darwin' ? 'open' : 'xdg-open'} "${GH_PAGES_URL}"`); } catch {}
  } catch (e) {
    console.log(`  GitHub Pages deploy failed: ${e.message}\n`);
  }

  } catch (err) {
    console.error('\n  [FATAL] Test run failed:', err.message);
    console.error(err.stack);
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
})();
