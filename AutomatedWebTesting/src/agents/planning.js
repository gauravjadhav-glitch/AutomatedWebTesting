const { log } = require('../utils');

function planningAgent(discovery, config, ctx) {
  log(ctx, '\u{1F4CB}', 'Layer 2: Planning Agent starting...');
  const testPlan = [];
  const tier = (t) => config.mode === 'fast' ? t <= 1 : config.mode === 'standard' ? t <= 2 : t <= 4;

  // T1 — Always
  testPlan.push({ name: 'Sanity', tier: 1, tests: Math.min(discovery.livePages.length, 20), fn: 'runSanityTests' });
  testPlan.push({ name: 'Visual', tier: 1, tests: Math.min(discovery.livePages.length, 10) * 4, fn: 'runVisualTests' });

  if (discovery.features.hasProducts) {
    testPlan.push({ name: 'E-Commerce', tier: 1, tests: 10, fn: 'runECommerceTests' });
  }
  if (discovery.features.hasSearch) {
    testPlan.push({ name: 'Search', tier: 1, tests: 3, fn: 'runSearchTests' });
  }
  testPlan.push({ name: 'UserJourneys', tier: 1, tests: 3, fn: 'runUserJourneyTests' });
  testPlan.push({ name: 'Accessibility', tier: 1, tests: 5, fn: 'runAccessibilityTests' });
  testPlan.push({ name: 'Performance', tier: 1, tests: 5, fn: 'runPerformanceTests' });

  // T2 — Standard / Deep
  if (tier(2)) {
    testPlan.push({ name: 'SEO', tier: 2, tests: Math.min(discovery.livePages.length, 8), fn: 'runSEOTests' });
    testPlan.push({ name: 'Interaction', tier: 2, tests: 5, fn: 'runInteractionTests' });
    testPlan.push({ name: 'LinkValidation', tier: 2, tests: 3, fn: 'runLinkValidation' });
    testPlan.push({ name: '4K-UHD', tier: 2, tests: 18, fn: 'run4KTests' });
    testPlan.push({ name: 'FormValidation', tier: 2, tests: 5, fn: 'runFormValidationTests' });
    testPlan.push({ name: 'Session', tier: 2, tests: 3, fn: 'runSessionTests' });
    testPlan.push({ name: 'CookieConsent', tier: 2, tests: 3, fn: 'runCookieConsentTests' });
    testPlan.push({ name: 'MobileMenu', tier: 2, tests: 5, fn: 'runMobileMenuTests' });
    testPlan.push({ name: 'LazyLoad', tier: 2, tests: 2, fn: 'runLazyLoadTests' });
    testPlan.push({ name: 'Exploratory', tier: 2, tests: 6, fn: 'runExploratoryTests' });
  }

  // T3-4 — Deep
  if (tier(3)) {
    testPlan.push({ name: 'Security', tier: 3, tests: 3, fn: 'runSecurityTests' });
  }

  log(ctx, '\u{1F4CB}', `Test plan: ${testPlan.length} phases, ${testPlan.reduce((s, t) => s + t.tests, 0)} tests (mode=${config.mode})`);
  return testPlan.filter(t => tier(t.tier));
}

module.exports = planningAgent;
