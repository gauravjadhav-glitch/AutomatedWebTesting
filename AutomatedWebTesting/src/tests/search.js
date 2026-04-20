'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');
const SELECTORS = require('../config/selectors');

async function runSearchTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD0D', '--- Search Tests ---');
  const searchTerm = (discovery.searchTerms && discovery.searchTerms[0]) || 'shoes';
  log(ctx, '\uD83D\uDD0D', `Search term: "${searchTerm}" (extracted from site)`);

  await safeGoto(page, config.targetUrl);
  await page.waitForTimeout(2000);

  ctx.testResults.total++;
  // Step 1: Find search trigger using adaptive selectors
  const trigger = await page.$(SELECTORS.searchTrigger);
  if (trigger) {
    await trigger.click().catch(() => {});
    await page.waitForTimeout(1000);
  }

  // Step 2: Find search input using adaptive selectors
  let searchInput = await page.$(SELECTORS.searchInput);
  if (!searchInput) {
    // Some sites reveal input after clicking trigger — try again
    searchInput = await page.$(SELECTORS.searchInput);
  }

  if (searchInput) {
    await searchInput.fill(searchTerm);
    await page.waitForTimeout(2000);
    await safeScreenshot(ctx, page, 'search_suggestions');

    // Check for autocomplete
    const suggestions = await page.$$('[class*="suggestion"], [class*="autocomplete"], [class*="search-result"], [class*="dropdown"] li, [class*="search"] li, [class*="typeahead"]').catch(() => []);
    if (suggestions.length > 0) {
      log(ctx, '\u2705', `Search: ${suggestions.length} autocomplete suggestions`);
    }

    // Submit search
    await searchInput.press('Enter');
    await page.waitForTimeout(3000);
    await safeScreenshot(ctx, page, 'search_results');

    // Check results with adaptive selectors
    const results = await page.$$(SELECTORS.productCard + ', [class*="search-result"]').catch(() => []);
    const noResults = await page.$('text=/no results/i, text=/nothing found/i, text=/no products/i, text=/did not match/i, text=/no items/i').catch(() => null);

    if (results.length > 0) {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `Search: ${results.length} results for "${searchTerm}"`);
    } else if (noResults) {
      ctx.testResults.failed++;
      const ss = await safeScreenshot(ctx, page, 'search_no_results');
      addBug(ctx, 'Medium', 'Search', `Search returns no results for "${searchTerm}"`, `Searching for "${searchTerm}" (extracted from site categories) returns zero results`, 'Search — Desktop', ['1. Click search', `2. Type "${searchTerm}"`, '3. Press Enter'], 'Relevant products shown', 'No results found', ss, 'Check search index and product data');
    } else {
      ctx.testResults.passed++;
    }
  } else {
    ctx.testResults.failed++;
    const ss = await safeScreenshot(ctx, page, 'search_no_input');
    addBug(ctx, 'High', 'Search', 'Search input not accessible', 'Cannot find search input field using multiple selector strategies', 'Homepage — Desktop', ['1. Look for search input/icon'], 'Search input appears', 'No search input found', ss, 'Check search component rendering');
  }
}

module.exports = runSearchTests;
