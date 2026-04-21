'use strict';

/**
 * Test Registry — maps test function names to their modules.
 * Each test module exports a function with signature:
 *   (page|browser, discovery, config, ctx) => Promise<void>
 */

const TEST_RUNNERS = {
  runSanityTests: { module: './sanity', needsBrowser: false },
  runVisualTests: { module: './visual', needsBrowser: true },
  runECommerceTests: { module: './ecommerce', needsBrowser: false },
  runSearchTests: { module: './search', needsBrowser: false },
  runAccessibilityTests: { module: './accessibility', needsBrowser: false },
  runPerformanceTests: { module: './performance', needsBrowser: false },
  runUserJourneyTests: { module: './user-journey', needsBrowser: false },
  runInteractionTests: { module: './interaction', needsBrowser: false },
  runLinkValidation: { module: './link-validation', needsBrowser: false },
  run4KTests: { module: './four-k', needsBrowser: true },
  runFormValidationTests: { module: './form-validation', needsBrowser: false },
  runSessionTests: { module: './session', needsBrowser: false },
  runSecurityTests: { module: './security', needsBrowser: false },
  runSEOTests: { module: './seo', needsBrowser: false },
  runCookieConsentTests: { module: './cookie-consent', needsBrowser: false },
  runMobileMenuTests: { module: './mobile-menu', needsBrowser: true },
  runLazyLoadTests: { module: './lazy-load', needsBrowser: false },
  runExploratoryTests: { module: './exploratory', needsBrowser: false },
  runApiLoadTests: { module: './api-load', needsBrowser: false },
  runVisualRegressionTests: { module: './visual-regression', needsBrowser: true },
  runGDPRComplianceTests: { module: './gdpr-compliance', needsBrowser: false },
  runDeepLinkCrawlTests: { module: './deep-link-crawl', needsBrowser: false },
};

function getRunner(fnName) {
  const entry = TEST_RUNNERS[fnName];
  if (!entry) return null;
  return {
    fn: require(entry.module),
    needsBrowser: entry.needsBrowser,
  };
}

module.exports = { TEST_RUNNERS, getRunner };
