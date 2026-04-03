/**
 * Self-Learning QA Engine
 *
 * Persistent knowledge system that learns from every test run.
 * Stores bug patterns, site behaviors, selector alternatives, and coverage gaps.
 * Each run improves the next: prioritizes high-risk areas, avoids repeated failures,
 * and expands test coverage automatically.
 */

const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const FILES = {
  history: path.join(KNOWLEDGE_DIR, 'history.json'),
  bugPatterns: path.join(KNOWLEDGE_DIR, 'bug-patterns.json'),
  siteProfiles: path.join(KNOWLEDGE_DIR, 'site-profiles.json'),
  selectors: path.join(KNOWLEDGE_DIR, 'selectors.json'),
  coverage: path.join(KNOWLEDGE_DIR, 'coverage.json'),
};

// ─────────────────────────────────────────────────────────────
// PERSISTENCE: Read/write JSON knowledge files
// ─────────────────────────────────────────────────────────────

function readJSON(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {}
  return fallback;
}

function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────
// LOAD: Read all knowledge at start of run
// ─────────────────────────────────────────────────────────────

function loadKnowledge() {
  return {
    history: readJSON(FILES.history, []),
    bugPatterns: readJSON(FILES.bugPatterns, {}),
    siteProfiles: readJSON(FILES.siteProfiles, {}),
    selectors: readJSON(FILES.selectors, {}),
    coverage: readJSON(FILES.coverage, {}),
    runCount: (readJSON(FILES.history, []) || []).length,
  };
}

// ─────────────────────────────────────────────────────────────
// BUG CLASSIFICATION: New vs Recurring vs Fixed
// ─────────────────────────────────────────────────────────────

function classifyBugs(currentBugs, knowledge) {
  const patterns = knowledge.bugPatterns;
  const classified = {
    newBugs: [],
    recurringBugs: [],
    fixedBugs: [],
    regressions: [],
  };

  // Normalize bug title for matching (strip site-specific parts)
  function normalizeBugKey(bug) {
    return (bug.title || '')
      .replace(/\(Site [12]\)/g, '')
      .replace(/https?:\/\/[^\s)]+/g, '<URL>')
      .replace(/\d+(\.\d+)?s/g, '<TIME>')
      .replace(/\d+ms/g, '<TIME>')
      .replace(/\d+ /g, '<N> ')
      .trim();
  }

  const currentKeys = new Set();

  for (const bug of currentBugs) {
    const key = normalizeBugKey(bug);
    currentKeys.add(key);

    if (patterns[key]) {
      // Seen before
      bug._learningStatus = 'recurring';
      bug._firstSeen = patterns[key].firstSeen;
      bug._occurrences = (patterns[key].occurrences || 0) + 1;
      bug._lastSeen = new Date().toISOString();
      classified.recurringBugs.push(bug);
    } else {
      // First time
      bug._learningStatus = 'new';
      bug._firstSeen = new Date().toISOString();
      bug._occurrences = 1;
      classified.newBugs.push(bug);
    }
  }

  // Find bugs that existed in previous runs but are now fixed
  for (const [key, pattern] of Object.entries(patterns)) {
    if (!currentKeys.has(key) && pattern.lastSeen) {
      classified.fixedBugs.push({
        title: pattern.sampleTitle || key,
        severity: pattern.severity,
        category: pattern.category,
        fixedSince: new Date().toISOString(),
        wasRecurring: pattern.occurrences > 1,
        previousOccurrences: pattern.occurrences,
      });
    }
  }

  // Find regressions: bugs that were fixed before but came back
  for (const bug of currentBugs) {
    const key = normalizeBugKey(bug);
    if (patterns[key] && patterns[key].wasFixed) {
      bug._learningStatus = 'regression';
      classified.regressions.push(bug);
    }
  }

  return classified;
}

// ─────────────────────────────────────────────────────────────
// TEST PRIORITIES: Focus on high-risk areas
// ─────────────────────────────────────────────────────────────

function getTestPriorities(knowledge, sites) {
  const priorities = {
    highRiskPaths: [],
    expandedCoverage: [],
    reducedTests: [],
    focusAreas: [],
  };

  const patterns = knowledge.bugPatterns;

  // Paths that frequently have bugs are high-risk
  const pathBugCounts = {};
  for (const [, pattern] of Object.entries(patterns)) {
    if (pattern.relatedPaths) {
      for (const p of pattern.relatedPaths) {
        pathBugCounts[p] = (pathBugCounts[p] || 0) + pattern.occurrences;
      }
    }
  }
  priorities.highRiskPaths = Object.entries(pathBugCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([path, count]) => ({ path, bugFrequency: count }));

  // Categories that have most bugs
  const categoryCounts = {};
  for (const [, pattern] of Object.entries(patterns)) {
    categoryCounts[pattern.category] = (categoryCounts[pattern.category] || 0) + pattern.occurrences;
  }
  priorities.focusAreas = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([category, count]) => ({ category, totalBugs: count }));

  // Coverage gaps: pages/paths that haven't been tested much
  const coverage = knowledge.coverage;
  if (sites) {
    for (const site of sites) {
      const domain = site.replace(/https?:\/\//, '').replace(/\/$/, '');
      const siteProfile = knowledge.siteProfiles[domain];
      if (siteProfile && siteProfile.discoveredPaths) {
        const tested = coverage[domain] || {};
        for (const p of siteProfile.discoveredPaths) {
          if (!tested[p] || tested[p].count < 2) {
            priorities.expandedCoverage.push({ path: p, site: domain, testCount: tested[p]?.count || 0 });
          }
        }
      }
    }
  }

  // Tests that consistently pass can be deprioritized
  if (knowledge.history.length > 2) {
    const alwaysPassPaths = new Set();
    const lastRuns = knowledge.history.slice(-3);
    for (const run of lastRuns) {
      if (run.cleanPaths) {
        for (const p of run.cleanPaths) alwaysPassPaths.add(p);
      }
    }
    priorities.reducedTests = [...alwaysPassPaths].slice(0, 10);
  }

  return priorities;
}

// ─────────────────────────────────────────────────────────────
// SELF-HEALING: Selector alternatives
// ─────────────────────────────────────────────────────────────

function getSelectorAlternatives(elementType) {
  const selectors = readJSON(FILES.selectors, {});
  return selectors[elementType] || [];
}

function recordSelectorSuccess(elementType, selector, context) {
  const selectors = readJSON(FILES.selectors, {});
  if (!selectors[elementType]) selectors[elementType] = [];

  const existing = selectors[elementType].find(s => s.selector === selector);
  if (existing) {
    existing.successCount = (existing.successCount || 0) + 1;
    existing.lastSuccess = new Date().toISOString();
    existing.contexts = [...new Set([...(existing.contexts || []), context])].slice(-5);
  } else {
    selectors[elementType].push({
      selector,
      successCount: 1,
      lastSuccess: new Date().toISOString(),
      contexts: [context],
    });
  }

  // Sort by success count (most reliable first)
  selectors[elementType].sort((a, b) => (b.successCount || 0) - (a.successCount || 0));

  writeJSON(FILES.selectors, selectors);
}

function recordSelectorFailure(elementType, selector) {
  const selectors = readJSON(FILES.selectors, {});
  if (!selectors[elementType]) return;

  const existing = selectors[elementType].find(s => s.selector === selector);
  if (existing) {
    existing.failCount = (existing.failCount || 0) + 1;
    existing.lastFailure = new Date().toISOString();
  }

  writeJSON(FILES.selectors, selectors);
}

// Default self-healing selector chains for common elements
const HEALING_SELECTORS = {
  phoneInput: [
    'input[type="tel"]',
    'input[name="phone"]',
    'input[placeholder*="phone" i]',
    'input[placeholder*="mobile" i]',
    'input[placeholder*="number" i]',
    'input[name*="mobile" i]',
    'input[aria-label*="phone" i]',
    'input[id*="phone" i]',
    'input[data-testid*="phone" i]',
  ],
  otpInput: [
    'input[type="tel"][maxlength="1"]',
    'input[name*="otp" i]',
    'input[placeholder*="otp" i]',
    'input[aria-label*="otp" i]',
    'input[id*="otp" i]',
    'input[data-testid*="otp" i]',
    'input[autocomplete="one-time-code"]',
  ],
  sendOtpButton: [
    'button:has-text("Send")',
    'button:has-text("Continue")',
    'button:has-text("OTP")',
    'button:has-text("Get OTP")',
    'button:has-text("Sign")',
    'button[type="submit"]',
    'button:has-text("Next")',
    'button:has-text("Proceed")',
    'input[type="submit"]',
  ],
  verifyButton: [
    'button:has-text("Verify")',
    'button:has-text("Submit")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'button:has-text("Confirm")',
    'button[type="submit"]',
  ],
  logoutButton: [
    'text=/logout|sign out|log out/i',
    'a[href*="logout"]',
    'button:has-text("Logout")',
    'button:has-text("Sign Out")',
    'a:has-text("Logout")',
    'a:has-text("Sign Out")',
    '[data-testid*="logout" i]',
  ],
  searchInput: [
    'input[type="search"]',
    'input[name*="search" i]',
    'input[placeholder*="search" i]',
    'input[name="q"]',
    'input[aria-label*="search" i]',
    '[class*="search-input"]',
    'input[data-testid*="search" i]',
  ],
  submitButton: [
    'button[type="submit"]',
    'button:has-text("Submit")',
    'button:has-text("Send")',
    'input[type="submit"]',
    'button:has-text("Save")',
    'button:has-text("Apply")',
  ],
  emailInput: [
    'input[type="email"]',
    'input[name*="email" i]',
    'input[placeholder*="email" i]',
    'input[aria-label*="email" i]',
  ],
  nameInput: [
    'input[name*="name" i]',
    'input[placeholder*="name" i]',
    'input[aria-label*="name" i]',
    'input[id*="name" i]',
  ],
  addToCartButton: [
    'button:has-text("Add to Cart")',
    'button:has-text("Add to Bag")',
    'button:has-text("Buy Now")',
    'button:has-text("Add")',
    '[class*="add-to-cart"]',
    '[data-testid*="add-to-cart" i]',
    'button:has-text("ADD TO CART")',
  ],
};

/**
 * Try multiple selectors for an element, return the first visible one.
 * Records success/failure for learning.
 */
async function healAndFind(page, elementType, extraSelectors = []) {
  // Get learned selectors (sorted by reliability)
  const learned = getSelectorAlternatives(elementType);
  const defaults = HEALING_SELECTORS[elementType] || [];

  // Merge: learned first (most reliable), then defaults, then extras
  const allSelectors = [
    ...learned.map(s => s.selector),
    ...defaults,
    ...extraSelectors,
  ];

  // Deduplicate
  const unique = [...new Set(allSelectors)];

  for (const selector of unique) {
    try {
      const el = page.locator(selector).first();
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        recordSelectorSuccess(elementType, selector, page.url());
        return { element: el, selector, healed: selector !== unique[0] };
      }
    } catch {}
  }

  // All failed
  for (const selector of unique.slice(0, 3)) {
    recordSelectorFailure(elementType, selector);
  }

  return { element: null, selector: null, healed: false };
}

// ─────────────────────────────────────────────────────────────
// SITE PROFILES: Learn website-specific behaviors
// ─────────────────────────────────────────────────────────────

function updateSiteProfile(siteUrl, discovery) {
  const profiles = readJSON(FILES.siteProfiles, {});
  const domain = siteUrl.replace(/https?:\/\//, '').replace(/\/$/, '');

  const existing = profiles[domain] || {};
  const livePaths = discovery.pages.filter(p => p.status === 200).map(p => p.path);
  const deadPaths = discovery.pages.filter(p => p.status === 404).map(p => p.path);

  profiles[domain] = {
    lastTested: new Date().toISOString(),
    testCount: (existing.testCount || 0) + 1,
    discoveredPaths: [...new Set([...(existing.discoveredPaths || []), ...livePaths, ...deadPaths])],
    livePaths,
    deadPaths,
    features: discovery.features,
    productCount: discovery.productLinks.length,
    formCount: discovery.forms.length,
    formPages: [...new Set(discovery.forms.map(f => f.foundOn))],
    navLinkCount: discovery.navLinks.length,
    footerLinkCount: discovery.footerLinks.length,
    consoleErrorCount: discovery.consoleErrors.length,
    networkErrorCount: discovery.networkErrors.length,
    // Track changes over time
    history: [
      ...(existing.history || []).slice(-9), // Keep last 10
      {
        date: new Date().toISOString(),
        livePages: livePaths.length,
        deadPages: deadPaths.length,
        products: discovery.productLinks.length,
        forms: discovery.forms.length,
        consoleErrors: discovery.consoleErrors.length,
      },
    ],
  };

  writeJSON(FILES.siteProfiles, profiles);
  return profiles[domain];
}

// ─────────────────────────────────────────────────────────────
// COVERAGE TRACKING: Know what's been tested
// ─────────────────────────────────────────────────────────────

function updateCoverage(siteUrl, testedPaths, testTypes) {
  const coverage = readJSON(FILES.coverage, {});
  const domain = siteUrl.replace(/https?:\/\//, '').replace(/\/$/, '');

  if (!coverage[domain]) coverage[domain] = {};

  for (const p of testedPaths) {
    if (!coverage[domain][p]) {
      coverage[domain][p] = { count: 0, types: [], lastTested: null };
    }
    coverage[domain][p].count++;
    coverage[domain][p].lastTested = new Date().toISOString();
    coverage[domain][p].types = [...new Set([...coverage[domain][p].types, ...testTypes])];
  }

  writeJSON(FILES.coverage, coverage);
}

// ─────────────────────────────────────────────────────────────
// SUGGEST NEW TESTS: Based on patterns and gaps
// ─────────────────────────────────────────────────────────────

function suggestNewTests(discovery1, discovery2, knowledge) {
  const suggestions = [];
  const coverage = knowledge.coverage;
  const patterns = knowledge.bugPatterns;

  // 1. Paths never tested before
  const allDiscovered = [...new Set([
    ...discovery1.pages.filter(p => p.status === 200).map(p => p.path),
    ...discovery2.pages.filter(p => p.status === 200).map(p => p.path),
  ])];

  for (const p of allDiscovered) {
    let tested = false;
    for (const domain of Object.keys(coverage)) {
      if (coverage[domain][p]) { tested = true; break; }
    }
    if (!tested) {
      suggestions.push({
        type: 'coverage_gap',
        name: `New untested path: ${p}`,
        path: p,
        reason: 'Never tested in any previous run',
        priority: 'high',
      });
    }
  }

  // 2. Areas with historically high bug density
  const buggyCategories = Object.entries(patterns)
    .reduce((acc, [, pat]) => {
      acc[pat.category] = (acc[pat.category] || 0) + pat.occurrences;
      return acc;
    }, {});

  const topBuggy = Object.entries(buggyCategories)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  for (const [category, count] of topBuggy) {
    suggestions.push({
      type: 'high_risk',
      name: `Focus: ${category} (${count} historical bugs)`,
      category,
      reason: `Category "${category}" has produced ${count} bugs across past runs`,
      priority: 'high',
    });
  }

  // 3. Edge cases based on discovered features
  if (discovery1.features.hasSearch || discovery2.features.hasSearch) {
    const searchTests = ['search with unicode', 'search with very long query', 'search with SQL injection attempt'];
    for (const st of searchTests) {
      suggestions.push({
        type: 'edge_case',
        name: `Edge Case: ${st}`,
        reason: 'Search feature detected — testing edge cases',
        priority: 'medium',
      });
    }
  }

  if (discovery1.features.hasCart || discovery2.features.hasCart) {
    suggestions.push({
      type: 'edge_case',
      name: 'Edge Case: Cart with large quantity',
      reason: 'Cart feature detected — testing quantity limits',
      priority: 'medium',
    });
  }

  // 4. If forms were found but not all tested
  const allFormPages = [...new Set([
    ...discovery1.forms.map(f => f.foundOn),
    ...discovery2.forms.map(f => f.foundOn),
  ])];
  for (const formPage of allFormPages) {
    let formTested = false;
    for (const domain of Object.keys(coverage)) {
      if (coverage[domain][formPage]?.types?.includes('forms')) { formTested = true; break; }
    }
    if (!formTested) {
      suggestions.push({
        type: 'coverage_gap',
        name: `Untested form on ${formPage}`,
        path: formPage,
        reason: 'Form discovered but never validated',
        priority: 'high',
      });
    }
  }

  return suggestions;
}

// ─────────────────────────────────────────────────────────────
// SAVE RUN: Store complete learning after test execution
// ─────────────────────────────────────────────────────────────

function saveRunLearning(runData) {
  const {
    site1, site2, bugs, testPlan, discovery1, discovery2,
    startTime, endTime, counts,
  } = runData;

  // 1. Update bug patterns
  const patterns = readJSON(FILES.bugPatterns, {});
  function normKey(bug) {
    return (bug.title || '')
      .replace(/\(Site [12]\)/g, '')
      .replace(/https?:\/\/[^\s)]+/g, '<URL>')
      .replace(/\d+(\.\d+)?s/g, '<TIME>')
      .replace(/\d+ms/g, '<TIME>')
      .replace(/\d+ /g, '<N> ')
      .trim();
  }

  const currentKeys = new Set();
  for (const bug of bugs) {
    const key = normKey(bug);
    currentKeys.add(key);

    if (patterns[key]) {
      patterns[key].occurrences = (patterns[key].occurrences || 0) + 1;
      patterns[key].lastSeen = new Date().toISOString();
      patterns[key].wasFixed = false; // It's back (or still present)
      if (bug.testType) patterns[key].testTypes = [...new Set([...(patterns[key].testTypes || []), bug.testType])];
    } else {
      patterns[key] = {
        sampleTitle: bug.title,
        severity: bug.severity,
        category: bug.category,
        testType: bug.testType,
        testTypes: bug.testType ? [bug.testType] : [],
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        occurrences: 1,
        wasFixed: false,
        relatedPaths: [],
      };
    }

    // Track which paths this bug relates to
    const pathMatch = (bug.title || '').match(/\/[\w\-\/?.=]+/);
    if (pathMatch) {
      patterns[key].relatedPaths = [...new Set([
        ...(patterns[key].relatedPaths || []),
        pathMatch[0],
      ])].slice(-10);
    }
  }

  // Mark bugs that were in previous run but not in current as fixed
  for (const [key, pattern] of Object.entries(patterns)) {
    if (!currentKeys.has(key) && !pattern.wasFixed) {
      pattern.wasFixed = true;
      pattern.fixedDate = new Date().toISOString();
    }
  }

  writeJSON(FILES.bugPatterns, patterns);

  // 2. Update history
  const history = readJSON(FILES.history, []);
  const cleanPaths = [];

  // Find paths that had no bugs
  const allTestedPaths = [...new Set([
    ...discovery1.pages.filter(p => p.status === 200).map(p => p.path),
    ...discovery2.pages.filter(p => p.status === 200).map(p => p.path),
  ])];
  const buggyPaths = new Set();
  for (const bug of bugs) {
    const m = (bug.title || '').match(/\/[\w\-\/?.=]+/);
    if (m) buggyPaths.add(m[0]);
  }
  for (const p of allTestedPaths) {
    if (!buggyPaths.has(p)) cleanPaths.push(p);
  }

  // Get previous run for comparison
  const previousRun = history.length > 0 ? history[history.length - 1] : null;

  const runSummary = {
    runNumber: history.length + 1,
    timestamp: new Date().toISOString(),
    duration: endTime - startTime,
    site1,
    site2,
    testCount: testPlan.length,
    bugCount: counts.total,
    critical: counts.critical,
    high: counts.high,
    medium: counts.medium,
    low: counts.low,
    pagesDiscovered: allTestedPaths.length,
    cleanPaths,
    improvement: previousRun ? {
      bugDelta: counts.total - previousRun.bugCount,
      testDelta: testPlan.length - previousRun.testCount,
      newBugsFound: bugs.filter(b => b._learningStatus === 'new').length,
      bugsFixed: bugs.filter(b => false).length, // calculated separately
      coverageChange: allTestedPaths.length - (previousRun.pagesDiscovered || 0),
    } : null,
  };

  history.push(runSummary);

  // Keep last 50 runs
  if (history.length > 50) history.splice(0, history.length - 50);
  writeJSON(FILES.history, history);

  // 3. Update site profiles
  updateSiteProfile(site1, discovery1);
  updateSiteProfile(site2, discovery2);

  // 4. Update coverage
  const testTypes = [...new Set(testPlan.map(t => t.type))];
  updateCoverage(site1, discovery1.pages.filter(p => p.status === 200).map(p => p.path), testTypes);
  updateCoverage(site2, discovery2.pages.filter(p => p.status === 200).map(p => p.path), testTypes);

  return runSummary;
}

// ─────────────────────────────────────────────────────────────
// RUN COMPARISON: Diff current vs previous run
// ─────────────────────────────────────────────────────────────

function getRunComparison(knowledge) {
  const history = knowledge.history;
  if (history.length < 2) {
    return {
      isFirstRun: history.length === 0,
      hasHistory: false,
      previousRun: null,
      trend: null,
    };
  }

  const prev = history[history.length - 1];
  const avgBugs = history.reduce((s, r) => s + r.bugCount, 0) / history.length;
  const avgTests = history.reduce((s, r) => s + r.testCount, 0) / history.length;

  // Trend over last 5 runs
  const recent = history.slice(-5);
  const bugTrend = recent.length > 1
    ? recent[recent.length - 1].bugCount - recent[0].bugCount
    : 0;

  return {
    isFirstRun: false,
    hasHistory: true,
    totalRuns: history.length,
    previousRun: prev,
    averageBugs: Math.round(avgBugs),
    averageTests: Math.round(avgTests),
    bugTrend: bugTrend < 0 ? 'improving' : bugTrend > 0 ? 'degrading' : 'stable',
    bugTrendValue: bugTrend,
    trend: recent.map(r => ({ run: r.runNumber, bugs: r.bugCount, tests: r.testCount, date: r.timestamp })),
  };
}

// ─────────────────────────────────────────────────────────────
// LEARNING INSIGHTS: Generate human-readable insights
// ─────────────────────────────────────────────────────────────

function generateInsights(classified, knowledge, currentCounts) {
  const insights = [];
  const history = knowledge.history;

  // New bug discovery
  if (classified.newBugs.length > 0) {
    insights.push({
      type: 'discovery',
      icon: 'new',
      title: `${classified.newBugs.length} NEW bugs discovered`,
      description: `Bugs never seen in any previous run: ${classified.newBugs.slice(0, 3).map(b => b.title).join(', ')}${classified.newBugs.length > 3 ? '...' : ''}`,
      severity: 'info',
    });
  }

  // Recurring bugs
  if (classified.recurringBugs.length > 0) {
    const chronic = classified.recurringBugs.filter(b => b._occurrences >= 3);
    if (chronic.length > 0) {
      insights.push({
        type: 'chronic',
        icon: 'warning',
        title: `${chronic.length} CHRONIC bugs (3+ occurrences)`,
        description: `These bugs keep recurring and need priority fixing: ${chronic.slice(0, 3).map(b => b.title).join(', ')}`,
        severity: 'high',
      });
    }
  }

  // Fixed bugs
  if (classified.fixedBugs.length > 0) {
    insights.push({
      type: 'fixed',
      icon: 'success',
      title: `${classified.fixedBugs.length} bugs FIXED since last run`,
      description: `Previously found bugs that are no longer present: ${classified.fixedBugs.slice(0, 3).map(b => b.title).join(', ')}`,
      severity: 'success',
    });
  }

  // Regressions
  if (classified.regressions.length > 0) {
    insights.push({
      type: 'regression',
      icon: 'error',
      title: `${classified.regressions.length} REGRESSIONS detected`,
      description: `Previously fixed bugs that have come back: ${classified.regressions.slice(0, 3).map(b => b.title).join(', ')}`,
      severity: 'critical',
    });
  }

  // Improvement trend
  if (history.length >= 2) {
    const prev = history[history.length - 1];
    const delta = currentCounts.total - prev.bugCount;
    if (delta < 0) {
      insights.push({
        type: 'trend',
        icon: 'up',
        title: `Quality IMPROVED: ${Math.abs(delta)} fewer bugs than last run`,
        description: `Previous: ${prev.bugCount} bugs | Current: ${currentCounts.total} bugs`,
        severity: 'success',
      });
    } else if (delta > 0) {
      insights.push({
        type: 'trend',
        icon: 'down',
        title: `Quality DECREASED: ${delta} more bugs than last run`,
        description: `Previous: ${prev.bugCount} bugs | Current: ${currentCounts.total} bugs`,
        severity: 'warning',
      });
    }
  }

  // Coverage improvement
  if (history.length >= 2) {
    const prev = history[history.length - 1];
    if (currentCounts.tests > prev.testCount) {
      insights.push({
        type: 'coverage',
        icon: 'expand',
        title: `Coverage EXPANDED: ${currentCounts.tests - prev.testCount} more tests`,
        description: `Running ${currentCounts.tests} tests vs ${prev.testCount} last time`,
        severity: 'info',
      });
    }
  }

  // First run
  if (history.length === 0) {
    insights.push({
      type: 'first_run',
      icon: 'star',
      title: 'First run — Baseline established',
      description: 'All bugs from this run will be used as baseline for future comparisons. Next run will show improvements.',
      severity: 'info',
    });
  }

  return insights;
}

// ─────────────────────────────────────────────────────────────
// EXPORT
// ─────────────────────────────────────────────────────────────

module.exports = {
  loadKnowledge,
  classifyBugs,
  getTestPriorities,
  getSelectorAlternatives,
  recordSelectorSuccess,
  recordSelectorFailure,
  healAndFind,
  HEALING_SELECTORS,
  updateSiteProfile,
  updateCoverage,
  suggestNewTests,
  saveRunLearning,
  getRunComparison,
  generateInsights,
};
