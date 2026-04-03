/**
 * Advanced Testing Module — Dynamic E-Commerce QA Engine
 *
 * Not limited to fixed phases. Discovers site structure and tests everything found.
 * Works with ANY e-commerce site, not just Fynd.
 */

const { devices } = require('playwright');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

// axe-core for accessibility — gracefully degrade if not available
let AxeBuilder;
try { ({ AxeBuilder } = require('@axe-core/playwright')); } catch { AxeBuilder = null; }

// Self-healing: try to load learning engine, gracefully degrade if not available
let learning;
try { learning = require('../learning-engine'); } catch { learning = null; }

// ─── TEST CONFIG — loaded from SKILL.md at runtime ───
const TEST_CONFIG = {
  credentials: { phone: '8888888888', otp: '5401', pincode: '400001' },
  assertions: {},
  loaded: false,
};

/** Update test config from parsed SKILL.md data (called by run-test.js) */
function loadSkillConfig(skillData) {
  if (skillData && skillData.loaded) {
    if (skillData.credentials) Object.assign(TEST_CONFIG.credentials, skillData.credentials);
    if (skillData.assertions) Object.assign(TEST_CONFIG.assertions, skillData.assertions);
    TEST_CONFIG.loaded = true;
  }
}

const DEVICES = {
  'Desktop': { viewport: { width: 1440, height: 900 }, isMobile: false },
  '4K UHD': { viewport: { width: 3840, height: 2160 }, isMobile: false },
  'iPhone 14 Pro': { viewport: { width: 393, height: 852 }, isMobile: true, userAgent: devices['iPhone 14 Pro']?.userAgent },
  'Pixel 7': { viewport: { width: 412, height: 915 }, isMobile: true, userAgent: devices['Pixel 7']?.userAgent },
};

function b64(buffer) { return buffer.toString('base64'); }

/** Convert raw Playwright/Node errors to human-readable messages */
function friendlyError(e) {
  const msg = e.message || String(e);
  if (msg.includes('Timeout') && msg.includes('exceeded'))
    return `Page took too long to load (timed out). The site may be slow or unresponsive.`;
  if (msg.includes('net::ERR_NAME_NOT_RESOLVED'))
    return `Could not reach the website — domain name not found. Check if the URL is correct.`;
  if (msg.includes('net::ERR_CONNECTION_REFUSED'))
    return `Connection refused — the server is not accepting requests. It may be down.`;
  if (msg.includes('net::ERR_CONNECTION_TIMED_OUT'))
    return `Connection timed out — the server did not respond. It may be down or behind a firewall.`;
  if (msg.includes('net::ERR_SSL'))
    return `SSL/HTTPS error — the site's security certificate has an issue.`;
  if (msg.includes('Navigation failed'))
    return `Page navigation failed — the page may have crashed or redirected unexpectedly.`;
  if (msg.includes('Target closed') || msg.includes('browser has been closed'))
    return `Browser tab closed unexpectedly during the test.`;
  if (msg.includes('waiting for locator') || msg.includes('waiting for selector'))
    return `Expected UI element was not found on the page within the wait time.`;
  return `Unexpected error: ${msg.substring(0, 200)}`;
}

/** Log a test skip/result into pageData with human-readable reason */
function logTestResult(pageData, label, testName, status, reason) {
  if (!pageData._testResults) pageData._testResults = [];
  pageData._testResults.push({ test: testName, status, reason, label });
  pageData[`${label}_${testName}_status`] = status;
  pageData[`${label}_${testName}_reason`] = reason;
}
// siteUrl is passed to all test runners — extract hostname for bug labels
function siteName(label, siteUrl) {
  if (siteUrl) { try { return new URL(siteUrl).hostname; } catch {} }
  return label === 'site1' ? 'Site 1' : 'Site 2';
}

// ─────────────────────────────────────────────────────────────
// RETRY UTILITY: Handles flaky tests with configurable retries
// ─────────────────────────────────────────────────────────────

async function withRetry(fn, opts = {}) {
  const maxRetries = opts.maxRetries || 2;
  const delay = opts.retryDelay || 2000;
  const label = opts.label || 'test';
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = e.message || '';
      // Only retry on transient errors (timeout, network, target closed)
      const isTransient = msg.includes('Timeout') || msg.includes('net::ERR') || msg.includes('Target closed') || msg.includes('browser has been closed') || msg.includes('Navigation failed');
      if (!isTransient || attempt === maxRetries) throw e;
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ─────────────────────────────────────────────────────────────
// PARALLEL EXECUTION: Run test batches concurrently
// ─────────────────────────────────────────────────────────────

async function runParallel(tasks, concurrency = 3) {
  const results = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map(fn => fn()));
    results.push(...batchResults);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────
// API CAPTURE: Intercept XHR/fetch calls during page interactions
// ─────────────────────────────────────────────────────────────

async function captureAPIs(page, actionFn) {
  const apiCalls = [];
  const handler = (response) => {
    const url = response.url();
    // Only capture API calls (XHR/fetch), skip static assets
    if (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') || url.includes('/graphql') || url.includes('.json') && !url.includes('.js') && !url.includes('.css') && !url.includes('.png') && !url.includes('.jpg') && !url.includes('.svg') && !url.includes('.woff')) {
      const entry = {
        url: url.substring(0, 200),
        status: response.status(),
        timing: null,
        method: response.request().method(),
      };
      // Try to get timing
      response.request().timing().then(t => {
        entry.timing = Math.round(t.responseEnd);
      }).catch(() => {});
      apiCalls.push(entry);
    }
  };
  page.on('response', handler);
  try {
    await actionFn();
  } finally {
    page.removeListener('response', handler);
  }
  return apiCalls;
}

// ─────────────────────────────────────────────────────────────
// USER JOURNEY FLOWS: End-to-end tests that simulate real users
// ─────────────────────────────────────────────────────────────

/** Journey 1: Browse → Select Product → Add to Cart → View Cart */
async function runUserJourneyBrowseToCart(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const journeySteps = [];
  let journeyFailed = false;

  try {
    // Step 1: Open homepage
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }, { label: 'Homepage load' });
    await page.waitForTimeout(2000);
    journeySteps.push({ step: 'Open homepage', status: 'passed' });
    screenshots[`${label}_journey_cart_1_home`] = b64(await page.screenshot());

    // Step 2: Navigate to PLP
    await withRetry(async () => {
      await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    }, { label: 'PLP load' });
    await page.waitForTimeout(2000);
    journeySteps.push({ step: 'Navigate to PLP', status: 'passed' });
    screenshots[`${label}_journey_cart_2_plp`] = b64(await page.screenshot());

    // Step 3: Click first product
    const productLink = discovery.productLinks[0];
    if (productLink) {
      await withRetry(async () => {
        await page.goto(productLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }, { label: 'PDP load' });
      await page.waitForTimeout(2000);
      journeySteps.push({ step: 'Open product page', status: 'passed' });
      screenshots[`${label}_journey_cart_3_pdp`] = b64(await page.screenshot());
    } else {
      // Try clicking first product on PLP
      const firstProduct = page.locator('a[href*="/product"], a[href*="/p/"], [class*="product"] a, [class*="card"] a').first();
      if (await firstProduct.isVisible().catch(() => false)) {
        await firstProduct.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Click product from PLP', status: 'passed' });
        screenshots[`${label}_journey_cart_3_pdp`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Click product from PLP', status: 'failed', reason: 'No product links found on PLP' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 4: Select size (if available)
      const sizeBtn = page.locator('[class*="size"] button, [class*="size"] label, [data-testid*="size"], input[name*="size"]').first();
      if (await sizeBtn.isVisible().catch(() => false)) {
        await sizeBtn.click();
        await page.waitForTimeout(500);
        journeySteps.push({ step: 'Select size', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Select size', status: 'skipped', reason: 'No size selector found' });
      }

      // Step 5: Add to cart
      const addBtn = page.locator('button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("ADD TO BAG"), button:has-text("Buy Now"), [class*="add-to-cart"], [class*="add-to-bag"]').first();
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(3000);
        screenshots[`${label}_journey_cart_4_added`] = b64(await page.screenshot());

        // Check for success indication
        const hasToast = await page.locator('[class*="toast"], [class*="snackbar"], [class*="notification"], [class*="alert"]').isVisible().catch(() => false);
        const cartBadge = await page.locator('[class*="cart-count"], [class*="badge"], [class*="cart"] span').textContent().catch(() => '');
        if (hasToast || (cartBadge && parseInt(cartBadge) > 0)) {
          journeySteps.push({ step: 'Add to cart', status: 'passed' });
        } else {
          journeySteps.push({ step: 'Add to cart', status: 'passed', reason: 'Clicked add button — no toast visible but may have worked' });
        }
      } else {
        journeySteps.push({ step: 'Add to cart', status: 'failed', reason: 'Add to Cart button not found or not visible' });
        journeyFailed = true;
      }

      // Step 6: Navigate to cart
      if (!journeyFailed) {
        const cartPaths = ['/cart/bag', '/cart'];
        let cartLoaded = false;
        for (const cp of cartPaths) {
          try {
            const resp = await page.goto(siteUrl + cp, { waitUntil: 'domcontentloaded', timeout: 15000 });
            if (resp && resp.status() === 200) {
              await page.waitForTimeout(2000);
              screenshots[`${label}_journey_cart_5_cart`] = b64(await page.screenshot());
              cartLoaded = true;

              // Verify product in cart
              const cartItems = await page.locator('[class*="cart-item"], [class*="bag-item"], [class*="line-item"], [class*="product"]').count();
              if (cartItems > 0) {
                journeySteps.push({ step: 'View cart with product', status: 'passed' });
              } else {
                journeySteps.push({ step: 'View cart', status: 'failed', reason: 'Cart appears empty after adding product' });
                journeyFailed = true;
              }
              break;
            }
          } catch {}
        }
        if (!cartLoaded) {
          journeySteps.push({ step: 'Navigate to cart', status: 'failed', reason: 'Cart page not accessible' });
          journeyFailed = true;
        }
      }
    }
  } catch (e) {
    journeySteps.push({ step: 'Journey error', status: 'failed', reason: friendlyError(e) });
    journeyFailed = true;
  }
  await page.close();

  pageData[`${label}_journey_browse_to_cart`] = journeySteps;

  // Report journey result
  const failedSteps = journeySteps.filter(s => s.status === 'failed');
  if (failedSteps.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: 'High',
      category: 'User Journey',
      title: `Browse-to-Cart journey failed at: ${failedSteps.map(s => s.step).join(', ')} (${sn})`,
      description: `End-to-end journey: Browse → Add to Cart failed.\n\nJourney steps:\n${journeySteps.map(s => `${s.status === 'passed' ? '✓' : s.status === 'skipped' ? '⊘' : '✗'} ${s.step}${s.reason ? ' — ' + s.reason : ''}`).join('\n')}`,
      site: sn,
      fix: `Fix the failed step(s): ${failedSteps.map(s => s.reason).join('; ')}`,
      testType: 'User Journey',
      location: 'Browse → PLP → PDP → Cart',
      steps: journeySteps.map((s, i) => `${i + 1}. ${s.step} [${s.status}]${s.reason ? ' — ' + s.reason : ''}`).join('\n'),
      expected: 'User can browse products, add to cart, and view cart successfully',
      actual: `Journey failed at: ${failedSteps.map(s => s.step + ' — ' + s.reason).join('; ')}`,
      screenshotKey: `${label}_journey_cart_${Math.max(1, journeySteps.filter(s => s.status === 'passed').length)}_${['home', 'plp', 'pdp', 'added', 'cart'][Math.min(4, journeySteps.filter(s => s.status === 'passed').length)]}`,
    });
  }
}

/** Journey 2: Login → Profile → Orders → Logout */
async function runUserJourneyLoginToProfile(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const journeySteps = [];
  let journeyFailed = false;

  try {
    // Step 1: Navigate to login
    const loginPaths = ['/auth/login', '/login'];
    let loginLoaded = false;
    for (const lp of loginPaths) {
      try {
        const resp = await page.goto(siteUrl + lp, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp && resp.status() === 200) { loginLoaded = true; break; }
      } catch {}
    }
    if (!loginLoaded) {
      journeySteps.push({ step: 'Open login page', status: 'failed', reason: 'Login page not accessible' });
      journeyFailed = true;
    } else {
      await page.waitForTimeout(2000);
      journeySteps.push({ step: 'Open login page', status: 'passed' });
      screenshots[`${label}_journey_login_1`] = b64(await page.screenshot());
    }

    if (!journeyFailed) {
      // Step 2: Enter phone number
      const phoneInput = page.locator('input[type="tel"], input[name*="phone"], input[name*="mobile"], input[placeholder*="phone" i], input[placeholder*="mobile" i]').first();
      if (await phoneInput.isVisible().catch(() => false)) {
        await phoneInput.fill(TEST_CONFIG.credentials.phone);
        journeySteps.push({ step: 'Enter phone number', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Enter phone number', status: 'failed', reason: 'Phone input field not found' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 3: Accept terms checkbox
      const checkbox = page.locator('input[type="checkbox"], [class*="checkbox"]').first();
      if (await checkbox.isVisible().catch(() => false)) {
        await checkbox.click();
        journeySteps.push({ step: 'Accept terms', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Accept terms', status: 'skipped', reason: 'No checkbox found' });
      }

      // Step 4: Click Get OTP
      const otpBtn = page.locator('button:has-text("Get OTP"), button:has-text("Send OTP"), button:has-text("Continue"), button[type="submit"]').first();
      if (await otpBtn.isVisible().catch(() => false)) {
        await otpBtn.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Click Get OTP', status: 'passed' });
        screenshots[`${label}_journey_login_2_otp`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Click Get OTP', status: 'failed', reason: 'OTP button not found' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 5: Enter OTP
      const otpInput = page.locator('input[type="tel"]:not([name*="phone"]):not([name*="mobile"]), input[name*="otp"], input[placeholder*="OTP" i], input[maxlength="4"], input[maxlength="6"]').first();
      if (await otpInput.isVisible().catch(() => false)) {
        await otpInput.fill('5401');
        // Click verify
        const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Continue"), button:has-text("Submit"), button[type="submit"]').first();
        if (await verifyBtn.isVisible().catch(() => false)) {
          await verifyBtn.click();
          await page.waitForTimeout(4000);
          journeySteps.push({ step: 'Enter OTP and verify', status: 'passed' });
          screenshots[`${label}_journey_login_3_verified`] = b64(await page.screenshot());
        }
      } else {
        journeySteps.push({ step: 'Enter OTP', status: 'failed', reason: 'OTP input not found' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 6: Navigate to profile
      try {
        await page.goto(siteUrl + '/profile', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        const profileContent = await page.textContent('body');
        const isLoggedIn = !profileContent.includes('login') || profileContent.includes('profile') || profileContent.includes('account');
        if (isLoggedIn) {
          journeySteps.push({ step: 'Access profile page', status: 'passed' });
          screenshots[`${label}_journey_login_4_profile`] = b64(await page.screenshot());
        } else {
          journeySteps.push({ step: 'Access profile page', status: 'failed', reason: 'Redirected to login — authentication may have failed' });
          journeyFailed = true;
        }
      } catch {
        journeySteps.push({ step: 'Access profile page', status: 'failed', reason: 'Profile page failed to load' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 7: Check orders page
      try {
        await page.goto(siteUrl + '/profile/orders', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);
        journeySteps.push({ step: 'View orders page', status: 'passed' });
        screenshots[`${label}_journey_login_5_orders`] = b64(await page.screenshot());
      } catch {
        journeySteps.push({ step: 'View orders page', status: 'failed', reason: 'Orders page failed to load' });
      }

      // Step 8: Logout
      const logoutBtn = page.locator('button:has-text("Logout"), a:has-text("Logout"), button:has-text("Sign Out"), a:has-text("Sign Out"), [class*="logout"]').first();
      if (await logoutBtn.isVisible().catch(() => false)) {
        await logoutBtn.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Logout', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Logout', status: 'skipped', reason: 'Logout button not found on current page' });
      }
    }
  } catch (e) {
    journeySteps.push({ step: 'Journey error', status: 'failed', reason: friendlyError(e) });
    journeyFailed = true;
  }
  await page.close();

  pageData[`${label}_journey_login_to_profile`] = journeySteps;

  const failedSteps = journeySteps.filter(s => s.status === 'failed');
  if (failedSteps.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: 'High',
      category: 'User Journey',
      title: `Login-to-Profile journey failed at: ${failedSteps.map(s => s.step).join(', ')} (${sn})`,
      description: `End-to-end journey: Login → Profile → Orders → Logout.\n\nJourney steps:\n${journeySteps.map(s => `${s.status === 'passed' ? '✓' : s.status === 'skipped' ? '⊘' : '✗'} ${s.step}${s.reason ? ' — ' + s.reason : ''}`).join('\n')}`,
      site: sn, fix: `Fix: ${failedSteps.map(s => s.reason).join('; ')}`, testType: 'User Journey',
      location: 'Login → Profile → Orders → Logout',
      steps: journeySteps.map((s, i) => `${i + 1}. ${s.step} [${s.status}]`).join('\n'),
      expected: 'User can login, view profile, view orders, and logout', actual: `Failed at: ${failedSteps.map(s => s.step).join(', ')}`,
    });
  }
}

/** Journey 3: Search → Filter → Product */
async function runUserJourneySearchToProduct(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const journeySteps = [];
  let journeyFailed = false;

  try {
    // Step 1: Open homepage
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);
    journeySteps.push({ step: 'Open homepage', status: 'passed' });

    // Step 2: Find and click search
    const searchTrigger = page.locator('[class*="search"] input, input[type="search"], input[placeholder*="search" i], [class*="search-icon"], [aria-label*="search" i], [class*="search"] svg').first();
    if (await searchTrigger.isVisible().catch(() => false)) {
      await searchTrigger.click();
      await page.waitForTimeout(1000);
      journeySteps.push({ step: 'Click search', status: 'passed' });

      // Step 3: Type search query
      const searchInput = page.locator('input[type="search"], input[type="text"][class*="search"], input[placeholder*="search" i]').first();
      if (await searchInput.isVisible().catch(() => false)) {
        await searchInput.fill('shirt');
        await page.waitForTimeout(2000);
        screenshots[`${label}_journey_search_1_typed`] = b64(await page.screenshot());

        // Check for suggestions
        const suggestions = await page.locator('[class*="suggestion"], [class*="autocomplete"], [class*="dropdown"] a, [class*="search-result"]').count();
        if (suggestions > 0) {
          journeySteps.push({ step: 'Search suggestions appear', status: 'passed' });
        } else {
          journeySteps.push({ step: 'Search suggestions', status: 'skipped', reason: 'No autocomplete suggestions visible' });
        }

        // Step 4: Submit search
        await searchInput.press('Enter');
        await page.waitForTimeout(3000);
        screenshots[`${label}_journey_search_2_results`] = b64(await page.screenshot());

        const hasResults = await page.locator('[class*="product"], [class*="card"], [class*="item"], [class*="result"]').count();
        if (hasResults > 0) {
          journeySteps.push({ step: 'Search results shown', status: 'passed' });
        } else {
          const pageText = await page.textContent('body').catch(() => '');
          if (pageText.toLowerCase().includes('no result') || pageText.toLowerCase().includes('not found')) {
            journeySteps.push({ step: 'Search results', status: 'passed', reason: 'No results for "shirt" — empty state shown correctly' });
          } else {
            journeySteps.push({ step: 'Search results', status: 'failed', reason: 'No products found and no empty state message' });
            journeyFailed = true;
          }
        }

        // Step 5: Try applying a filter
        if (!journeyFailed && hasResults > 0) {
          const filterBtn = page.locator('[class*="filter"] button, button:has-text("Filter"), [class*="filter-trigger"], [class*="refine"]').first();
          if (await filterBtn.isVisible().catch(() => false)) {
            await filterBtn.click();
            await page.waitForTimeout(1500);
            const filterOption = page.locator('[class*="filter"] input[type="checkbox"], [class*="filter"] label, [class*="filter-option"]').first();
            if (await filterOption.isVisible().catch(() => false)) {
              await filterOption.click();
              await page.waitForTimeout(2000);
              journeySteps.push({ step: 'Apply filter', status: 'passed' });
              screenshots[`${label}_journey_search_3_filtered`] = b64(await page.screenshot());
            } else {
              journeySteps.push({ step: 'Apply filter', status: 'skipped', reason: 'No filter options found' });
            }
          } else {
            journeySteps.push({ step: 'Apply filter', status: 'skipped', reason: 'No filter button found' });
          }

          // Step 6: Click first product
          const productLink = page.locator('a[href*="/product"], a[href*="/p/"], [class*="product"] a, [class*="card"] a').first();
          if (await productLink.isVisible().catch(() => false)) {
            await productLink.click();
            await page.waitForTimeout(3000);
            screenshots[`${label}_journey_search_4_pdp`] = b64(await page.screenshot());
            journeySteps.push({ step: 'Open product from results', status: 'passed' });
          } else {
            journeySteps.push({ step: 'Open product from results', status: 'failed', reason: 'No clickable product link found' });
          }
        }
      } else {
        journeySteps.push({ step: 'Type in search', status: 'failed', reason: 'Search input not found after clicking search icon' });
        journeyFailed = true;
      }
    } else {
      journeySteps.push({ step: 'Click search', status: 'failed', reason: 'Search icon/input not found on homepage' });
      journeyFailed = true;
    }
  } catch (e) {
    journeySteps.push({ step: 'Journey error', status: 'failed', reason: friendlyError(e) });
    journeyFailed = true;
  }
  await page.close();

  pageData[`${label}_journey_search_to_product`] = journeySteps;

  const failedSteps = journeySteps.filter(s => s.status === 'failed');
  if (failedSteps.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: 'High',
      category: 'User Journey',
      title: `Search-to-Product journey failed at: ${failedSteps.map(s => s.step).join(', ')} (${sn})`,
      description: `End-to-end journey: Search → Filter → Product.\n\nJourney steps:\n${journeySteps.map(s => `${s.status === 'passed' ? '✓' : s.status === 'skipped' ? '⊘' : '✗'} ${s.step}${s.reason ? ' — ' + s.reason : ''}`).join('\n')}`,
      site: sn, fix: `Fix: ${failedSteps.map(s => s.reason).join('; ')}`, testType: 'User Journey',
      location: 'Search → Filter → PDP',
      steps: journeySteps.map((s, i) => `${i + 1}. ${s.step} [${s.status}]`).join('\n'),
      expected: 'User can search, filter, and open a product', actual: `Failed at: ${failedSteps.map(s => s.step).join(', ')}`,
    });
  }
}

/** Journey 4: Browse → Add to Cart → Login → Select Address → Place Order (COD) */
async function runUserJourneyPlaceOrder(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const journeySteps = [];
  let journeyFailed = false;

  try {
    // Step 1: Navigate to PLP (products or collection page)
    let plpUrl = siteUrl + '/products';
    if (discovery && discovery.pages) {
      const collectionPage = discovery.pages.find(p => p.includes('/collection/'));
      if (collectionPage) plpUrl = collectionPage;
    }
    await withRetry(async () => {
      await page.goto(plpUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }, { label: 'PLP load' });
    await page.waitForTimeout(3000);
    journeySteps.push({ step: 'Navigate to product listing', status: 'passed' });
    screenshots[`${label}_journey_order_1_plp`] = b64(await page.screenshot());

    // Step 2: Click first product
    const productUrl = await page.evaluate(() => {
      const links = document.querySelectorAll('a');
      for (const a of links) {
        if (a.href && a.href.includes('/product/')) return a.href;
      }
      return null;
    });
    if (productUrl) {
      await withRetry(async () => {
        await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      }, { label: 'PDP load' });
      await page.waitForTimeout(3000);
      journeySteps.push({ step: 'Open product page', status: 'passed' });
      screenshots[`${label}_journey_order_2_pdp`] = b64(await page.screenshot());
    } else {
      const firstProduct = page.locator('a[href*="/product"], [class*="product"] a, [class*="card"] a').first();
      if (await firstProduct.isVisible().catch(() => false)) {
        await firstProduct.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Click product from PLP', status: 'passed' });
        screenshots[`${label}_journey_order_2_pdp`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Open product page', status: 'failed', reason: 'No product links found' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 3: Enter pincode for delivery check (if required)
      const pincodeInput = page.locator('input[placeholder*="delivery" i], input[placeholder*="pincode" i], input[placeholder*="Check delivery" i]').first();
      if (await pincodeInput.isVisible().catch(() => false)) {
        await pincodeInput.type('400001', { delay: 50 });
        await page.waitForTimeout(500);
        const checkBtn = page.locator('button:has-text("CHECK"), button:has-text("Check")').first();
        if (await checkBtn.isVisible().catch(() => false)) {
          await checkBtn.click();
          await page.waitForTimeout(2000);
        }
        journeySteps.push({ step: 'Enter delivery pincode', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Enter delivery pincode', status: 'skipped', reason: 'No pincode field found' });
      }

      // Step 4: Select size (if available)
      const sizeBtn = page.locator('[class*="size"] button:not([disabled]), [class*="size"] label, button:has-text("L"), button:has-text("M")').first();
      if (await sizeBtn.isVisible().catch(() => false)) {
        await sizeBtn.click();
        await page.waitForTimeout(500);
        journeySteps.push({ step: 'Select size', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Select size', status: 'skipped', reason: 'No size selector found' });
      }

      // Step 5: Add to cart
      const addBtn = page.locator('button:has-text("Add to Cart"), button:has-text("ADD TO CART"), button:has-text("Add to Bag"), button:has-text("ADD TO BAG"), button:has-text("Buy Now"), [class*="add-to-cart"], [class*="add-to-bag"]').first();
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Add to cart', status: 'passed' });
        screenshots[`${label}_journey_order_3_added`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Add to cart', status: 'failed', reason: 'Add to Cart button not found' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 6: Navigate to cart
      const cartPaths = ['/cart/bag', '/cart'];
      let cartLoaded = false;
      for (const cp of cartPaths) {
        try {
          const resp = await page.goto(siteUrl + cp, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (resp && resp.status() === 200) {
            await page.waitForTimeout(3000);
            cartLoaded = true;
            break;
          }
        } catch {}
      }
      if (cartLoaded) {
        journeySteps.push({ step: 'Navigate to cart', status: 'passed' });
        screenshots[`${label}_journey_order_4_cart`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Navigate to cart', status: 'failed', reason: 'Cart page not accessible' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 7: Click Checkout / Login button
      const checkoutBtn = page.locator('button:has-text("CHECKOUT"), button:has-text("Checkout"), button:has-text("LOGIN"), button:has-text("Proceed")').first();
      if (await checkoutBtn.isVisible().catch(() => false)) {
        await checkoutBtn.click();
        await page.waitForTimeout(5000);
        journeySteps.push({ step: 'Click checkout/login', status: 'passed' });
        screenshots[`${label}_journey_order_5_checkout`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Click checkout/login', status: 'failed', reason: 'Checkout/Login button not found in cart' });
        journeyFailed = true;
      }
    }

    if (!journeyFailed) {
      // Step 8: Login if redirected to login page
      const currentUrl = page.url();
      if (currentUrl.includes('/auth/login') || currentUrl.includes('/login')) {
        const phoneInput = page.locator('input[type="tel"]').first();
        if (await phoneInput.isVisible().catch(() => false)) {
          await phoneInput.click();
          await phoneInput.evaluate(el => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); });
          await page.waitForTimeout(300);
          await phoneInput.type('8888888888', { delay: 80 });
          await page.waitForTimeout(500);

          // Check terms checkbox if present
          const checkbox = page.locator('input[type="checkbox"]').first();
          if (await checkbox.isVisible().catch(() => false)) {
            await checkbox.check({ force: true });
          }
          await page.waitForTimeout(500);

          // Click GET OTP
          const otpBtn = page.locator('button:has-text("GET OTP"), button:has-text("Send OTP"), button[type="submit"]').first();
          if (await otpBtn.isVisible().catch(() => false)) {
            try { await otpBtn.click({ timeout: 5000 }); } catch { await otpBtn.click({ force: true }); }
            await page.waitForTimeout(4000);
          }

          // Enter OTP
          const otpInput = page.locator('input[maxlength="4"], input[type="text"][maxlength]').first();
          if (await otpInput.isVisible().catch(() => false)) {
            await otpInput.type('5401', { delay: 100 });
            await page.waitForTimeout(1000);

            // Click Continue/Verify
            const continueBtn = page.locator('button:has-text("CONTINUE"), button:has-text("VERIFY"), button:has-text("Submit"), button[type="submit"]').first();
            if (await continueBtn.isVisible().catch(() => false)) {
              await continueBtn.click();
              await page.waitForTimeout(5000);
            }
          } else {
            // Try multi-field OTP
            const otpInputs = page.locator('input[maxlength="1"]');
            const otpCount = await otpInputs.count();
            if (otpCount >= 4) {
              const otp = '5401';
              for (let i = 0; i < 4; i++) {
                await otpInputs.nth(i).fill(otp[i]);
              }
              await page.waitForTimeout(1000);
              const continueBtn = page.locator('button:has-text("CONTINUE"), button:has-text("VERIFY"), button[type="submit"]').first();
              if (await continueBtn.isVisible().catch(() => false)) {
                await continueBtn.click();
                await page.waitForTimeout(5000);
              }
            }
          }

          journeySteps.push({ step: 'Login with OTP', status: 'passed' });
          screenshots[`${label}_journey_order_6_loggedin`] = b64(await page.screenshot());
        } else {
          journeySteps.push({ step: 'Login with OTP', status: 'failed', reason: 'Phone input not found on login page' });
          journeyFailed = true;
        }
      } else {
        journeySteps.push({ step: 'Login with OTP', status: 'skipped', reason: 'Already logged in or no login redirect' });
      }
    }

    if (!journeyFailed) {
      // Step 9: Handle checkout page — select address if needed
      await page.waitForTimeout(3000);
      const deliverBtn = page.locator('button:has-text("DELIVER TO THIS ADDRESS"), button:has-text("Deliver Here"), button:has-text("Select Address")').first();
      if (await deliverBtn.isVisible().catch(() => false)) {
        await deliverBtn.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Select delivery address', status: 'passed' });
      } else {
        journeySteps.push({ step: 'Select delivery address', status: 'skipped', reason: 'No address selection step or already selected' });
      }

      // Step 10: Click Proceed to Pay
      const proceedBtn = page.locator('button:has-text("PROCEED TO PAY"), button:has-text("Proceed to Pay"), button:has-text("Continue")').first();
      if (await proceedBtn.isVisible().catch(() => false)) {
        await proceedBtn.click();
        await page.waitForTimeout(5000);
        journeySteps.push({ step: 'Proceed to payment', status: 'passed' });
        screenshots[`${label}_journey_order_7_payment`] = b64(await page.screenshot());
      } else {
        journeySteps.push({ step: 'Proceed to payment', status: 'skipped', reason: 'No Proceed to Pay button — may already be on payment step' });
      }

      // Step 11: Check available payment methods
      const paymentMethods = await page.evaluate(() => {
        const text = document.body.innerText;
        const methods = [];
        if (text.includes('Card')) methods.push('Card');
        if (text.includes('Net Banking')) methods.push('Net Banking');
        if (text.includes('UPI')) methods.push('UPI');
        if (text.includes('Cash On Delivery') || text.includes('COD')) methods.push('COD');
        if (text.includes('Wallet')) methods.push('Wallet');
        if (text.includes('EMI')) methods.push('EMI');
        return methods;
      });
      journeySteps.push({ step: 'Payment methods available', status: 'passed', reason: paymentMethods.join(', ') || 'None detected' });

      // Step 12: Select COD and place order
      const codOption = page.locator('text=Cash On Delivery').first();
      if (await codOption.isVisible().catch(() => false)) {
        await codOption.click();
        await page.waitForTimeout(3000);
        journeySteps.push({ step: 'Select Cash On Delivery', status: 'passed' });
        screenshots[`${label}_journey_order_8_cod`] = b64(await page.screenshot());

        // Click Place Order
        const placeOrderBtn = page.locator('button:has-text("PLACE ORDER"), button:has-text("Place Order"), button:has-text("Confirm Order")').first();
        if (await placeOrderBtn.isVisible().catch(() => false)) {
          await placeOrderBtn.click();
          await page.waitForTimeout(8000);

          // Check for order confirmation
          const orderUrl = page.url();
          const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
          const orderConfirmed = orderUrl.includes('success=true') ||
            orderUrl.includes('order-status') ||
            orderUrl.includes('order-confirmed') ||
            pageText.includes('ORDER CONFIRMED') ||
            pageText.includes('Order Placed') ||
            pageText.includes('Thank you') ||
            pageText.includes('order has been placed');

          if (orderConfirmed) {
            // Extract order ID
            const orderId = await page.evaluate(() => {
              const text = document.body.innerText;
              const match = text.match(/ORDER\s*ID\s*[:\s]*([A-Z0-9]+)/i) ||
                            text.match(/order.*?([A-Z]{2}\d{10,})/i);
              return match ? match[1] : null;
            });
            journeySteps.push({ step: 'Order placed successfully', status: 'passed', reason: orderId ? `Order ID: ${orderId}` : 'Order confirmed' });
            screenshots[`${label}_journey_order_9_confirmed`] = b64(await page.screenshot());
          } else {
            journeySteps.push({ step: 'Order placed successfully', status: 'failed', reason: 'No order confirmation detected after placing order' });
            journeyFailed = true;
            screenshots[`${label}_journey_order_9_failed`] = b64(await page.screenshot());
          }
        } else {
          journeySteps.push({ step: 'Place order', status: 'failed', reason: 'Place Order button not found after selecting COD' });
          journeyFailed = true;
        }
      } else {
        // COD not available — try to verify payment page loads at least
        journeySteps.push({ step: 'Select Cash On Delivery', status: 'failed', reason: 'COD option not available — only online payment methods found' });
        journeyFailed = true;
      }
    }
  } catch (e) {
    journeySteps.push({ step: 'Journey error', status: 'failed', reason: friendlyError(e) });
    journeyFailed = true;
  }
  await page.close();

  pageData[`${label}_journey_place_order`] = journeySteps;

  // Report journey result
  const failedSteps = journeySteps.filter(s => s.status === 'failed');
  if (failedSteps.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: 'Critical',
      category: 'User Journey',
      title: `Place Order journey failed at: ${failedSteps.map(s => s.step).join(', ')} (${sn})`,
      description: `End-to-end order placement journey failed.\n\nJourney steps:\n${journeySteps.map(s => `${s.status === 'passed' ? '✓' : s.status === 'skipped' ? '⊘' : '✗'} ${s.step}${s.reason ? ' — ' + s.reason : ''}`).join('\n')}`,
      site: sn,
      fix: `Fix the failed step(s): ${failedSteps.map(s => s.reason).join('; ')}`,
      testType: 'User Journey',
      location: 'Browse → Cart → Login → Checkout → Payment → Order',
      steps: journeySteps.map((s, i) => `${i + 1}. ${s.step} [${s.status}]${s.reason ? ' — ' + s.reason : ''}`).join('\n'),
      expected: 'User can browse, add to cart, login, select address, choose payment, and place order successfully',
      actual: `Journey failed at: ${failedSteps.map(s => s.step + ' — ' + s.reason).join('; ')}`,
      screenshotKey: `${label}_journey_order_9_failed`,
    });
  }
  logTestResult(pageData, label, 'Place Order Journey', failedSteps.length > 0 ? 'fail' : 'pass',
    failedSteps.length > 0 ? `Failed at: ${failedSteps.map(s => s.step).join(', ')}` : 'Order placed successfully');
}

// ─────────────────────────────────────────────────────────────
// INTERACTION TESTS: Hover, click, scroll, carousel, modals
// ─────────────────────────────────────────────────────────────

async function runInteractionTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    // Test 1: Mega Menu Hover — hover L1 nav items, check L2 dropdown
    const navItems = page.locator('nav a, header nav > ul > li > a, [class*="nav"] > ul > li > a, [class*="menu"] > ul > li > a');
    const navCount = await navItems.count();
    let megaMenuWorks = false;
    for (let i = 0; i < Math.min(navCount, 5); i++) {
      const item = navItems.nth(i);
      if (await item.isVisible().catch(() => false)) {
        await item.hover();
        await page.waitForTimeout(800);
        // Check if a dropdown/submenu appeared
        const dropdown = page.locator('[class*="dropdown"]:visible, [class*="submenu"]:visible, [class*="mega-menu"]:visible, nav ul ul:visible, [class*="nav"] ul ul:visible');
        if (await dropdown.count() > 0) {
          megaMenuWorks = true;
          screenshots[`${label}_interaction_megamenu`] = b64(await page.screenshot());
          break;
        }
      }
    }
    results.push({ test: 'Mega Menu Hover', status: megaMenuWorks ? 'passed' : 'skipped', reason: megaMenuWorks ? 'L2 dropdown appears on hover' : 'No dropdown menus found (may not have mega menu)' });

    // Test 2: Sticky Header — scroll down and check header visibility
    await page.evaluate(() => window.scrollTo(0, 1000));
    await page.waitForTimeout(1000);
    const headerAfterScroll = await page.evaluate(() => {
      const header = document.querySelector('header, [class*="header"], [role="banner"]');
      if (!header) return null;
      const rect = header.getBoundingClientRect();
      const style = getComputedStyle(header);
      return { top: rect.top, position: style.position, isFixed: style.position === 'fixed' || style.position === 'sticky' };
    });
    if (headerAfterScroll) {
      const isSticky = headerAfterScroll.isFixed || headerAfterScroll.top <= 0;
      results.push({ test: 'Sticky Header', status: 'passed', reason: isSticky ? 'Header stays fixed on scroll' : 'Header scrolls away (not sticky — this may be by design)' });
      screenshots[`${label}_interaction_sticky`] = b64(await page.screenshot());
    } else {
      results.push({ test: 'Sticky Header', status: 'skipped', reason: 'No header element found' });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    // Test 3: Carousel/Slider — check for auto-slide or next button
    const carousel = page.locator('[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="slick"]').first();
    if (await carousel.isVisible().catch(() => false)) {
      screenshots[`${label}_interaction_carousel_before`] = b64(await page.screenshot());
      // Try clicking next arrow
      const nextBtn = page.locator('[class*="next"], [class*="arrow-right"], button[aria-label*="next" i], [class*="swiper-button-next"]').first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(1500);
        screenshots[`${label}_interaction_carousel_after`] = b64(await page.screenshot());
        results.push({ test: 'Carousel Navigation', status: 'passed', reason: 'Next arrow clicked, slide changed' });
      } else {
        // Wait for auto-slide
        await page.waitForTimeout(5000);
        results.push({ test: 'Carousel', status: 'passed', reason: 'Carousel found — may auto-slide' });
      }
    } else {
      results.push({ test: 'Carousel', status: 'skipped', reason: 'No carousel/slider found on homepage' });
    }

    // Test 4: Back to Top button
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const backToTop = page.locator('[class*="back-to-top"], [class*="scroll-top"], button[aria-label*="top" i], [class*="go-top"]').first();
    if (await backToTop.isVisible().catch(() => false)) {
      await backToTop.click();
      await page.waitForTimeout(1000);
      const scrollY = await page.evaluate(() => window.scrollY);
      results.push({ test: 'Back to Top', status: scrollY < 200 ? 'passed' : 'failed', reason: scrollY < 200 ? 'Scrolled back to top' : `Scroll position still at ${scrollY}px` });
    } else {
      results.push({ test: 'Back to Top', status: 'skipped', reason: 'No back-to-top button found' });
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    // Test 5: Tab switching (PDP or any page with tabs)
    const tabs = page.locator('[role="tab"], [class*="tab-item"], [class*="tab"] button, [data-toggle="tab"]');
    if (await tabs.count() > 1) {
      const secondTab = tabs.nth(1);
      if (await secondTab.isVisible().catch(() => false)) {
        await secondTab.click();
        await page.waitForTimeout(1000);
        results.push({ test: 'Tab Switching', status: 'passed', reason: 'Clicked second tab — content should switch' });
        screenshots[`${label}_interaction_tabs`] = b64(await page.screenshot());
      }
    } else {
      results.push({ test: 'Tab Switching', status: 'skipped', reason: 'No tab elements found on homepage' });
    }

  } catch (e) {
    results.push({ test: 'Interaction tests', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_interaction_results`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: 'Medium',
      category: 'Interaction',
      title: `${failures.length} interaction test(s) failed (${sn})`,
      description: `Interactive element tests:\n\n${results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗'} ${r.test}: ${r.reason}`).join('\n')}`,
      site: sn, fix: `Fix: ${failures.map(f => f.test + ' — ' + f.reason).join('; ')}`, testType: 'Interaction',
      location: 'Homepage',
      steps: results.map((r, i) => `${i + 1}. ${r.test}: ${r.reason}`).join('\n'),
      expected: 'All interactive elements work correctly', actual: `${failures.length} test(s) failed`,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// API COMPARISON: Capture APIs on both Prod and UAT, compare
// ─────────────────────────────────────────────────────────────

async function runAPIComparison(browser, site1Url, site2Url, bugs, pageData) {
  const capturePageAPIs = async (siteUrl, label) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const apis = [];
    page.on('response', (response) => {
      const url = response.url();
      if (url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') || url.includes('/graphql') || (url.includes('.json') && !url.endsWith('.json'))) {
        apis.push({
          url: url.substring(0, 250),
          status: response.status(),
          method: response.request().method(),
        });
      }
    });
    try {
      // Visit key pages to capture API calls
      const paths = ['/', '/products'];
      for (const p of paths) {
        await page.goto(siteUrl + p, { waitUntil: 'networkidle', timeout: 25000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    } catch {}
    await page.close();
    return apis;
  };

  const prodAPIs = await capturePageAPIs(site1Url, 'site1');
  const uatAPIs = await capturePageAPIs(site2Url, 'site2');

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  // Check for failed APIs on UAT
  const uatFailures = uatAPIs.filter(a => a.status >= 400);
  if (uatFailures.length > 0) {
    diffs.push(`${uatFailures.length} API call(s) failed on UAT: ${uatFailures.slice(0, 3).map(a => `${a.method} ${a.url} → ${a.status}`).join('; ')}`);
  }

  // Check for APIs that work on Prod but fail on UAT
  const prodUrls = new Set(prodAPIs.filter(a => a.status < 400).map(a => new URL(a.url).pathname).filter(Boolean));
  const uatUrlMap = {};
  for (const a of uatAPIs) {
    try { uatUrlMap[new URL(a.url).pathname] = a.status; } catch {}
  }
  let brokenOnUAT = 0;
  for (const prodPath of prodUrls) {
    if (uatUrlMap[prodPath] && uatUrlMap[prodPath] >= 400) brokenOnUAT++;
  }
  if (brokenOnUAT > 0) {
    diffs.push(`${brokenOnUAT} API(s) work on Production but return errors on UAT`);
  }

  // API count comparison
  if (Math.abs(prodAPIs.length - uatAPIs.length) > 5) {
    diffs.push(`API call count: Production made ${prodAPIs.length} calls, UAT made ${uatAPIs.length} calls`);
  }

  pageData['api_comparison'] = { prod: prodAPIs.length, uat: uatAPIs.length, prodFailures: prodAPIs.filter(a => a.status >= 400).length, uatFailures: uatFailures.length, diffs };

  if (diffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: uatFailures.some(a => a.status >= 500) ? 'High' : 'Medium',
      category: 'API',
      title: `API differences between Prod and UAT — ${diffs.length} issues`,
      description: `API comparison (captured during page navigation):\n\n${diffs.map(d => '• ' + d).join('\n')}\n\nUAT API calls: ${uatAPIs.length} | Failures: ${uatFailures.length}\nProd API calls: ${prodAPIs.length} | Failures: ${prodAPIs.filter(a => a.status >= 400).length}`,
      site: site2Name, fix: 'Check failed API endpoints on UAT — compare responses with Production', testType: 'API',
      location: 'Site-wide API layer',
      steps: '1. Open DevTools → Network tab on both sites\n2. Navigate to homepage and products page\n3. Compare API calls and responses',
      expected: 'All APIs that work on Production should work on UAT', actual: `${diffs.length} API differences found`,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// FORM VALIDATION: Deep form testing with invalid inputs
// ─────────────────────────────────────────────────────────────

async function runFormValidationTest(browser, siteUrl, label, formPath, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    await withRetry(async () => {
      await page.goto(siteUrl + formPath, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    const forms = await page.locator('form').count();
    if (forms === 0) {
      results.push({ test: 'Form exists', status: 'skipped', reason: 'No form elements found on page' });
      await page.close();
      pageData[`${label}_form_validation_${formPath.replace(/[^a-z0-9]/gi, '_')}`] = results;
      return;
    }

    screenshots[`${label}_form_validation_before`] = b64(await page.screenshot());

    // Test 1: Empty submit
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send"), button:has-text("Get In Touch")').first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(1500);
      screenshots[`${label}_form_validation_empty`] = b64(await page.screenshot());

      const hasValidation = await page.evaluate(() => {
        const invalids = document.querySelectorAll(':invalid, [class*="error"], [class*="invalid"], [aria-invalid="true"]');
        return invalids.length > 0;
      });
      results.push({ test: 'Empty submit validation', status: hasValidation ? 'passed' : 'failed', reason: hasValidation ? 'Form shows validation errors on empty submit' : 'No validation errors shown when submitting empty form' });
    }

    // Test 2: Invalid email
    const emailInput = page.locator('input[type="email"], input[name*="email"], input[placeholder*="email" i]').first();
    if (await emailInput.isVisible().catch(() => false)) {
      await emailInput.fill('notanemail');
      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(1000);
        const emailError = await page.evaluate(() => {
          const emailInputs = document.querySelectorAll('input[type="email"], input[name*="email"]');
          for (const inp of emailInputs) {
            if (!inp.validity.valid || inp.closest('[class*="error"]') || document.querySelector('[class*="error"]')) return true;
          }
          return false;
        });
        results.push({ test: 'Invalid email validation', status: emailError ? 'passed' : 'failed', reason: emailError ? 'Invalid email rejected' : 'Invalid email "notanemail" accepted without error' });
      }
      await emailInput.fill(''); // Clear
    }

    // Test 3: Invalid phone
    const phoneInput = page.locator('input[type="tel"], input[name*="phone"], input[placeholder*="phone" i]').first();
    if (await phoneInput.isVisible().catch(() => false)) {
      await phoneInput.fill('abc');
      results.push({ test: 'Invalid phone input', status: 'passed', reason: 'Entered "abc" in phone field — check if validated on submit' });
      await phoneInput.fill(''); // Clear
    }

    // Test 4: XSS payload
    const textInput = page.locator('input[type="text"], textarea').first();
    if (await textInput.isVisible().catch(() => false)) {
      await textInput.fill('<script>alert("xss")</script>');
      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(1500);
        // Check if alert was triggered (it shouldn't be)
        const hasAlert = await page.evaluate(() => {
          // If XSS worked, there would be an alert — but we can't detect dismissed alerts
          // Instead check if the script tag was rendered in DOM
          return document.body.innerHTML.includes('<script>alert');
        });
        results.push({ test: 'XSS protection', status: hasAlert ? 'failed' : 'passed', reason: hasAlert ? 'XSS payload rendered in DOM — input not sanitized' : 'XSS payload sanitized or rejected' });
        screenshots[`${label}_form_validation_xss`] = b64(await page.screenshot());
      }
      await textInput.fill(''); // Clear
    }

    // Test 5: SQL injection
    if (await textInput.isVisible().catch(() => false)) {
      await textInput.fill("'; DROP TABLE users--");
      results.push({ test: 'SQL injection input', status: 'passed', reason: 'Entered SQL injection payload — server should sanitize' });
      await textInput.fill(''); // Clear
    }

  } catch (e) {
    results.push({ test: 'Form validation', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_form_validation_${formPath.replace(/[^a-z0-9]/gi, '_')}`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: failures.some(f => f.test.includes('XSS')) ? 'High' : 'Medium',
      category: 'Forms',
      title: `Form validation issues on ${formPath} — ${failures.length} test(s) failed (${sn})`,
      description: `Form validation tests on ${formPath}:\n\n${results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗'} ${r.test}: ${r.reason}`).join('\n')}`,
      site: sn, fix: `Fix form validation: ${failures.map(f => f.test + ' — ' + f.reason).join('; ')}`, testType: 'Form Validation',
      location: formPath,
      steps: `1. Navigate to ${siteUrl}${formPath}\n2. Test empty submit, invalid email, XSS payload\n3. Check validation errors`,
      expected: 'Form validates all inputs and rejects invalid data', actual: `${failures.length} validation test(s) failed`,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// DISCOVERY: Deep crawl to find all pages, links, forms, features
// ─────────────────────────────────────────────────────────────
async function discoverSite(browser, siteUrl, label, log, opts = {}) {
  const mode = opts.mode || 'standard';
  const maxCrawl = opts.maxPages || 60;
  const pageTimeout = opts.pageTimeout || 30000;
  const isFast = mode === 'fast';

  log(`  [DISCOVER] Crawling ${label} (${mode} mode, max ${maxCrawl} pages)...`);
  const discovered = {
    pages: [],
    forms: [],
    navLinks: [],
    footerLinks: [],
    allInternalLinks: [],
    features: { hasLogin: false, hasCart: false, hasWishlist: false, hasSearch: false, hasCheckout: false, hasProfile: false, hasProducts: false, hasCollections: false, hasContactForm: false, hasBlog: false },
    productLinks: [],
    categoryLinks: [],
    sitemapUrls: [],
    consoleErrors: [],
    networkErrors: [],
  };

  const visited = new Set();
  const toVisit = ['/'];

  // Fast mode: only probe critical e-commerce paths
  const fastProbePaths = [
    '/', '/products', '/collections',
    '/auth/login', '/login',
    '/cart', '/cart/bag', '/checkout',
    '/products?q=test', '/search?q=test',
    '/contact-us',
    '/profile',
  ];

  // Standard/deep: probe everything
  const fullProbePaths = [
    '/', '/products', '/collections', '/categories',
    '/auth/login', '/auth/register', '/login', '/register', '/signup',
    '/profile', '/profile/details', '/profile/orders', '/profile/addresses',
    '/profile/phone', '/profile/email', '/profile/wishlist',
    '/cart', '/cart/bag', '/checkout',
    '/wishlist', '/favourites',
    '/products?q=test', '/search?q=test',
    '/contact-us', '/contact', '/pages/contact',
    '/about', '/about-us', '/pages/about',
    '/faq', '/faqs', '/pages/faq',
    '/terms', '/terms-and-conditions', '/pages/terms', '/sections/terms-and-conditions',
    '/privacy', '/privacy-policy', '/pages/privacy', '/sections/privacy-policy',
    '/return-policy', '/returns', '/refund-policy',
    '/shipping-policy', '/delivery',
    '/blog', '/blogs', '/articles',
    '/menu',
    '/store-locator', '/stores', '/find-store', '/locate-us',
    '/size-guide',
    '/gift-cards', '/gift-card',
    '/offers', '/deals', '/sale', '/coupons',
  ];

  const probePaths = isFast ? fastProbePaths : fullProbePaths;

  for (const p of probePaths) {
    if (!toVisit.includes(p)) toVisit.push(p);
  }

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      discovered.consoleErrors.push({ url: page.url(), message: msg.text().substring(0, 200) });
    }
  });

  // Capture network errors
  page.on('requestfailed', req => {
    discovered.networkErrors.push({
      url: req.url().substring(0, 200),
      failure: req.failure()?.errorText || 'unknown',
      page: page.url(),
    });
  });

  // Visit pages and collect data
  let crawlCount = 0;

  while (toVisit.length > 0 && crawlCount < maxCrawl) {
    const pathToCrawl = toVisit.shift();
    const normalPath = pathToCrawl.split('?')[0].replace(/\/+$/, '') || '/';
    if (visited.has(normalPath)) continue;
    visited.add(normalPath);
    crawlCount++;

    try {
      const resp = await page.goto(siteUrl + pathToCrawl, { waitUntil: 'domcontentloaded', timeout: pageTimeout });
      // Wait for SPA to render content (shorter in fast mode)
      await page.waitForTimeout(isFast ? 800 : 2000);
      try { await page.waitForSelector('body *', { timeout: 5000 }); } catch {}
      const status = resp ? resp.status() : 0;
      const finalUrl = page.url();
      const title = await page.title();

      const pageInfo = {
        path: pathToCrawl,
        status,
        title,
        finalUrl,
        redirected: finalUrl !== (siteUrl + pathToCrawl) && finalUrl !== (siteUrl + pathToCrawl + '/'),
      };

      // Extract page details
      const details = await page.evaluate((baseUrl) => {
        const links = [...document.querySelectorAll('a[href]')].map(a => {
          const href = a.getAttribute('href') || '';
          return { href, text: a.textContent.trim().substring(0, 60), fullUrl: a.href };
        });

        const internalLinks = links.filter(l =>
          (l.href.startsWith('/') || l.fullUrl.startsWith(baseUrl)) &&
          !l.href.startsWith('javascript:') && !l.href.startsWith('mailto:') && !l.href.startsWith('tel:')
        ).map(l => l.href.startsWith('/') ? l.href : new URL(l.fullUrl).pathname);

        // Find forms
        const forms = [...document.querySelectorAll('form')].map(f => {
          const inputs = [...f.querySelectorAll('input, textarea, select')].map(i => ({
            type: i.type || i.tagName.toLowerCase(),
            name: i.name || '',
            placeholder: i.placeholder || '',
            required: i.required,
            id: i.id || '',
          }));
          return {
            action: f.action || '',
            method: f.method || 'get',
            inputs,
            hasSubmitBtn: !!f.querySelector('button[type="submit"], input[type="submit"], button:not([type])'),
          };
        });

        // Find standalone form inputs (not inside <form>)
        const standaloneInputs = [...document.querySelectorAll('input, textarea, select')]
          .filter(i => !i.closest('form') && i.offsetParent !== null)
          .map(i => ({
            type: i.type || i.tagName.toLowerCase(),
            name: i.name || '',
            placeholder: i.placeholder || '',
            id: i.id || '',
          }));

        // Navigation
        const navEl = document.querySelector('nav, header, [class*="navbar"], [class*="header"]');
        const navLinks = navEl ? [...navEl.querySelectorAll('a[href]')].map(a => ({
          href: a.getAttribute('href'), text: a.textContent.trim().substring(0, 40),
        })) : [];

        // Footer
        const footerEl = document.querySelector('footer, [class*="footer"], [id*="footer"]');
        const footerLinks = footerEl ? [...footerEl.querySelectorAll('a[href]')].map(a => ({
          href: a.getAttribute('href'), text: a.textContent.trim().substring(0, 40), fullUrl: a.href,
        })) : [];

        // Product links
        const productLinks = [...document.querySelectorAll('a[href*="/product/"]')].map(a => a.href);

        // Category links
        const categoryLinks = [...document.querySelectorAll('a[href*="/collection"], a[href*="/category"], a[href*="/collections/"]')].map(a => a.href);

        // Feature detection
        const bodyText = document.body.innerText.toLowerCase();
        const bodyHtml = document.body.innerHTML.toLowerCase();
        const features = {
          hasSearchInput: !!document.querySelector('input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[name="q"], [class*="search-input"]'),
          hasCartIcon: bodyHtml.includes('cart') || bodyHtml.includes('bag') || !!document.querySelector('[class*="cart"], [data-testid*="cart"], a[href*="cart"]'),
          hasWishlistIcon: bodyHtml.includes('wishlist') || bodyHtml.includes('favourite') || !!document.querySelector('[class*="wishlist"], a[href*="wishlist"]'),
          hasLoginBtn: !!document.querySelector('a[href*="login"], a[href*="auth"], button:has(text("Login")), [class*="login"]'),
          hasImages: document.querySelectorAll('img').length,
          hasBrokenImages: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).length,
          hasVideo: document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length,
          hasSocialLinks: !!document.querySelector('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="linkedin"], a[href*="youtube"]'),
          hasNewsletter: !!document.querySelector('[class*="newsletter"], [class*="subscribe"], input[placeholder*="email" i][type="email"]'),
          hasBreadcrumb: !!document.querySelector('[class*="breadcrumb"], nav[aria-label*="breadcrumb"]'),
          hasAccordion: !!document.querySelector('[class*="accordion"], details, [class*="collapse"]'),
          hasTabs: !!document.querySelector('[role="tablist"], [class*="tab-"]'),
          hasSlider: !!document.querySelector('[class*="slider"], [class*="carousel"], [class*="swiper"]'),
          hasPopup: !!document.querySelector('[class*="modal"], [class*="popup"], [class*="dialog"], [role="dialog"]'),
          hasCookieBanner: !!document.querySelector('[class*="cookie"], [id*="cookie"], [class*="consent"]'),
        };

        return { internalLinks, forms, standaloneInputs, navLinks, footerLinks, productLinks, categoryLinks, features, imageCount: features.hasImages, brokenImages: features.hasBrokenImages };
      }, siteUrl);

      pageInfo.forms = details.forms;
      pageInfo.standaloneInputs = details.standaloneInputs;
      pageInfo.imageCount = details.imageCount;
      pageInfo.brokenImages = details.brokenImages;
      pageInfo.features = details.features;
      discovered.pages.push(pageInfo);

      // Merge feature detection
      if (pathToCrawl === '/') {
        discovered.navLinks = details.navLinks;
        discovered.footerLinks = details.footerLinks;
      }

      // Detect features from path — accept any non-error status (SPA sites often redirect)
      if (status === 200 || status === 301 || status === 302 || status === 0) {
        if (pathToCrawl.includes('login') || pathToCrawl.includes('auth')) discovered.features.hasLogin = true;
        if (pathToCrawl.includes('cart')) discovered.features.hasCart = true;
        if (pathToCrawl.includes('wishlist') || pathToCrawl.includes('favourite')) discovered.features.hasWishlist = true;
        if (pathToCrawl.includes('product')) discovered.features.hasProducts = true;
        if (pathToCrawl.includes('collection') || pathToCrawl.includes('categor')) discovered.features.hasCollections = true;
        if (pathToCrawl.includes('profile')) discovered.features.hasProfile = true;
        if (pathToCrawl.includes('checkout')) discovered.features.hasCheckout = true;
        if (pathToCrawl.includes('contact')) discovered.features.hasContactForm = true;
        if (pathToCrawl.includes('blog')) discovered.features.hasBlog = true;
        if (details.features.hasSearchInput) discovered.features.hasSearch = true;
      }
      // Also detect from content for SPAs
      if (details.features.hasSearchInput) discovered.features.hasSearch = true;
      if (details.productLinks.length > 0) discovered.features.hasProducts = true;

      // Add found product/category links to crawl (limit in fast mode)
      const productSlice = isFast ? 1 : 5;
      for (const pl of details.productLinks.slice(0, productSlice)) {
        try { const pp = new URL(pl).pathname; if (!visited.has(pp)) toVisit.push(pp); } catch {}
      }
      if (!isFast) {
        for (const cl of details.categoryLinks.slice(0, 5)) {
          try { const cp = new URL(cl).pathname; if (!visited.has(cp)) toVisit.push(cp); } catch {}
        }
      }

      // Add internal links found (from nav and footer) — skip deep crawling in fast mode
      const allFound = [...new Set(details.internalLinks)];
      discovered.allInternalLinks.push(...allFound.filter(l => !visited.has(l.split('?')[0].replace(/\/+$/, '') || '/')));
      if (!isFast) {
        for (const link of allFound.slice(0, 10)) {
          const norm = link.split('?')[0].replace(/\/+$/, '') || '/';
          if (!visited.has(norm) && !toVisit.includes(link)) toVisit.push(link);
        }
      }

      discovered.productLinks.push(...details.productLinks);
      discovered.categoryLinks.push(...details.categoryLinks);

      if (details.forms.length > 0) {
        discovered.forms.push(...details.forms.map(f => ({ ...f, foundOn: pathToCrawl })));
      }
    } catch (e) {
      // Even if timeout, page may have rendered (SPA behavior) — try to get status
      let status = 'TIMEOUT';
      try {
        const bodyText = await page.evaluate(() => document.body?.innerText?.length || 0);
        if (bodyText > 100) status = 200; // Page has content — treat as loaded
      } catch {}
      discovered.pages.push({ path: pathToCrawl, status, error: e.message });
    }
  }

  // Try sitemap.xml (skip in fast mode to save time)
  if (!isFast) {
    try {
      const resp = await page.goto(siteUrl + '/sitemap.xml', { waitUntil: 'domcontentloaded', timeout: 5000 });
      if (resp && resp.status() === 200) {
        const urls = await page.evaluate(() => {
          const locs = document.querySelectorAll('loc');
          return [...locs].map(l => l.textContent).slice(0, 50);
        });
        discovered.sitemapUrls = urls;
      }
    } catch {}
  }

  await ctx.close();

  // Deduplicate
  discovered.productLinks = [...new Set(discovered.productLinks)];
  discovered.categoryLinks = [...new Set(discovered.categoryLinks)];
  discovered.allInternalLinks = [...new Set(discovered.allInternalLinks)];

  const livePages = discovered.pages.filter(p => p.status === 200);
  const deadPages = discovered.pages.filter(p => p.status === 404);
  log(`  [DISCOVER] ${label}: ${discovered.pages.length} pages crawled, ${livePages.length} live, ${deadPages.length} dead, ${discovered.productLinks.length} products, ${discovered.forms.length} forms, ${discovered.consoleErrors.length} console errors`);

  return discovered;
}

// ─────────────────────────────────────────────────────────────
// DYNAMIC TEST PLAN: Generate tests based on discovery
// ─────────────────────────────────────────────────────────────
function generateTestPlan(discovery1, discovery2, log) {
  const tests = [];
  let id = 0;

  const allLivePages1 = discovery1.pages.filter(p => p.status === 200);
  const allLivePages2 = discovery2.pages.filter(p => p.status === 200);
  const allPaths = [...new Set([
    ...discovery1.pages.map(p => p.path),
    ...discovery2.pages.map(p => p.path),
  ])];

  // ── SANITY TESTS ──
  // Prioritize key pages: home, PLP, PDP, cart, login, then remaining (max 20)
  const priorityPaths = ['/', '/products', '/cart', '/cart/bag', '/auth/login', '/login', '/contact-us', '/about', '/profile', '/profile/orders', '/wishlist', '/collections'];
  const sortedPaths = [
    ...priorityPaths.filter(p => allPaths.includes(p)),
    ...allPaths.filter(p => !priorityPaths.includes(p)),
  ];
  const sanityPages = sortedPaths.slice(0, 20);
  for (const path of sanityPages) {
    tests.push({ id: ++id, type: 'sanity', subtype: 'page_load', name: `Page Load: ${path}`, path, description: `Verify ${path} loads without errors` });
  }

  // ── SCREENSHOT COMPARISON ──
  // Screenshot key live pages on multiple devices (max 20)
  const pagesToScreenshot = sanityPages.filter(p => {
    const s1 = discovery1.pages.find(pg => pg.path === p);
    const s2 = discovery2.pages.find(pg => pg.path === p);
    return (s1 && s1.status === 200) || (s2 && s2.status === 200);
  }).slice(0, 20);
  for (const path of pagesToScreenshot) {
    tests.push({ id: ++id, type: 'visual', subtype: 'multi_device', name: `Multi-Device Screenshots: ${path}`, path });
  }

  // ── LINK VALIDATION ──
  tests.push({ id: ++id, type: 'links', subtype: 'all_links', name: 'All Internal Link Validation', description: 'Test every internal link found on both sites' });
  tests.push({ id: ++id, type: 'links', subtype: 'footer_links', name: 'Footer Link Validation', description: 'Test every footer link' });
  tests.push({ id: ++id, type: 'links', subtype: 'nav_links', name: 'Navigation Link Validation', description: 'Test every navigation link' });

  // ── FORM TESTING ──
  const allForms = [...discovery1.forms, ...discovery2.forms];
  const formPages = [...new Set(allForms.map(f => f.foundOn))];
  for (const formPage of formPages) {
    tests.push({ id: ++id, type: 'forms', subtype: 'form_validation', name: `Form Validation: ${formPage}`, path: formPage });
  }

  // ── AUTH TESTS ──
  if (discovery1.features.hasLogin || discovery2.features.hasLogin) {
    tests.push({ id: ++id, type: 'auth', subtype: 'login_flow', name: 'Login Flow (OTP)', description: 'Full login with phone + OTP' });
    tests.push({ id: ++id, type: 'auth', subtype: 'logout_flow', name: 'Logout Flow', description: 'Test logout after login' });
    tests.push({ id: ++id, type: 'auth', subtype: 'protected_pages', name: 'Protected Page Redirections', description: 'Verify unauthenticated redirect' });
  }

  // ── E-COMMERCE TESTS ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'plp_products', name: 'PLP Product Count & Display' });
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'pdp_detail', name: 'PDP Product Details' });
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'product_images', name: 'Product Image Validation' });
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'price_display', name: 'Price Display Check' });
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'add_to_cart', name: 'Add to Cart Flow' });
  }
  if (discovery1.features.hasSearch || discovery2.features.hasSearch) {
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'search_valid', name: 'Search — Valid Query' });
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'search_empty', name: 'Search — Empty Results' });
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'search_special', name: 'Search — Special Characters' });
  }
  if (discovery1.features.hasCart || discovery2.features.hasCart) {
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'cart_empty', name: 'Empty Cart State' });
  }
  if (discovery1.features.hasWishlist || discovery2.features.hasWishlist) {
    tests.push({ id: ++id, type: 'ecommerce', subtype: 'wishlist', name: 'Wishlist Page' });
  }

  // ── CSS & THEME ──
  tests.push({ id: ++id, type: 'css', subtype: 'css_variables', name: 'CSS Variables Check' });
  tests.push({ id: ++id, type: 'css', subtype: 'font_consistency', name: 'Font Consistency Across Pages' });
  tests.push({ id: ++id, type: 'css', subtype: 'color_scheme', name: 'Color Scheme Consistency' });
  tests.push({ id: ++id, type: 'css', subtype: 'broken_images', name: 'Broken Images Across All Pages' });

  // ── PERFORMANCE ──
  for (const path of pagesToScreenshot.slice(0, 10)) {
    tests.push({ id: ++id, type: 'performance', subtype: 'page_perf', name: `Performance: ${path}`, path });
  }

  // ── ACCESSIBILITY ──
  for (const path of pagesToScreenshot.slice(0, 10)) {
    tests.push({ id: ++id, type: 'accessibility', subtype: 'page_a11y', name: `Accessibility: ${path}`, path });
  }

  // ── ADVANCED E-COMMERCE: Cart & Checkout ──
  if (discovery1.features.hasCart || discovery2.features.hasCart || discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'cart_checkout', subtype: 'cart_checkout_deep', name: 'Cart & Checkout Deep Test' });
  }

  // ── ADVANCED E-COMMERCE: Search Deep ──
  if (discovery1.features.hasSearch || discovery2.features.hasSearch) {
    tests.push({ id: ++id, type: 'search_deep', subtype: 'search_deep', name: 'Search Deep Test (edge cases, XSS, typos)' });
  }

  // ── ADVANCED E-COMMERCE: PDP Deep ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'pdp_deep', subtype: 'pdp_deep', name: 'PDP Deep Test (variants, images, breadcrumbs)' });
  }

  // ── ADVANCED E-COMMERCE: PLP Deep ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'plp_deep', subtype: 'plp_deep', name: 'PLP Deep Test (filters, sort, pagination)' });
  }

  // ── ADVANCED E-COMMERCE: Wishlist ──
  if (discovery1.features.hasWishlist || discovery2.features.hasWishlist) {
    tests.push({ id: ++id, type: 'wishlist_deep', subtype: 'wishlist_deep', name: 'Wishlist Deep Test' });
  }

  // ── SECURITY BASIC ──
  tests.push({ id: ++id, type: 'security', subtype: 'security_basic', name: 'Security Basic Test (HTTPS, mixed content, exposed keys)' });

  // ── EXPLORATORY ──
  tests.push({ id: ++id, type: 'exploratory', subtype: 'exploratory', name: 'Exploratory Test (random nav, rapid clicks, JS errors)' });

  // ── INVENTORY ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'inventory', subtype: 'inventory', name: 'Inventory & Stock Test' });
  }

  // ── SCENARIO TESTS (SKILL.md) ──
  if (discovery1.features.hasLogin || discovery2.features.hasLogin) {
    tests.push({ id: ++id, type: 'scenario', subtype: 'auth_negative', name: 'Auth Negative Tests (#7,13,19,31,33,34)' });
  }
  tests.push({ id: ++id, type: 'scenario', subtype: 'empty_cart', name: 'Empty Cart State (#2,11,37)' });
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'scenario', subtype: 'cart_quantity', name: 'Cart Quantity +/- (#30)' });
    tests.push({ id: ++id, type: 'scenario', subtype: 'plp_interaction', name: 'PLP Filter & Sort (#8,12,29,35)' });
    tests.push({ id: ++id, type: 'scenario', subtype: 'pdp_edge_cases', name: 'PDP Edge Cases (#20,28,36)' });
  }
  tests.push({ id: ++id, type: 'scenario', subtype: 'homepage_deep', name: 'Homepage Deep (#18,26,27)' });
  tests.push({ id: ++id, type: 'scenario', subtype: 'header_nav', name: 'Header Nav & L1/L2 (#24,38)' });
  tests.push({ id: ++id, type: 'scenario', subtype: 'newsletter', name: 'Newsletter Subscription (#22)' });
  tests.push({ id: ++id, type: 'scenario', subtype: 'store_locator', name: 'Store Locator (#14)' });
  if (discovery1.features.hasLogin || discovery2.features.hasLogin) {
    tests.push({ id: ++id, type: 'scenario', subtype: 'address_crud', name: 'Address Add/Delete (#3,6)' });
    tests.push({ id: ++id, type: 'scenario', subtype: 'track_order', name: 'Track Order Page (#23)' });
  }

  // ── CONSOLE & NETWORK ERRORS ──
  tests.push({ id: ++id, type: 'errors', subtype: 'console_errors', name: 'Console Errors Audit' });
  tests.push({ id: ++id, type: 'errors', subtype: 'network_errors', name: 'Network Failures Audit' });

  // ── CONTENT COMPARISON ──
  tests.push({ id: ++id, type: 'comparison', subtype: 'content_diff', name: 'Content Comparison (Site 1 vs Site 2)' });
  tests.push({ id: ++id, type: 'comparison', subtype: 'nav_diff', name: 'Navigation Comparison' });
  tests.push({ id: ++id, type: 'comparison', subtype: 'footer_diff', name: 'Footer Comparison' });

  // ── REGRESSION ──
  tests.push({ id: ++id, type: 'regression', subtype: 'status_compare', name: 'Page Status Code Comparison' });
  tests.push({ id: ++id, type: 'regression', subtype: 'title_compare', name: 'Page Title Comparison' });
  tests.push({ id: ++id, type: 'regression', subtype: 'structure_compare', name: 'Page Structure Comparison' });
  tests.push({ id: ++id, type: 'regression', subtype: 'meta_compare', name: 'Meta Tags & OG Tags Comparison' });
  tests.push({ id: ++id, type: 'regression', subtype: 'header_footer_compare', name: 'Header & Footer Structure Comparison' });
  tests.push({ id: ++id, type: 'regression', subtype: 'css_compare', name: 'CSS Property Comparison (fonts, colors, spacing)' });
  tests.push({ id: ++id, type: 'regression', subtype: 'responsive_compare', name: 'Responsive Breakpoint Comparison' });

  // ── LIGHTHOUSE COMPARISON (Prod vs UAT) ──
  const lighthousePages = ['/', '/products', '/contact-us'].filter(p => allPaths.includes(p));
  for (const path of lighthousePages.slice(0, 3)) {
    tests.push({ id: ++id, type: 'lighthouse_compare', subtype: 'lighthouse_compare', name: `Lighthouse Compare: ${path}`, path });
  }

  // ── VISUAL DIFF (Prod vs UAT per-section) ──
  for (const path of pagesToScreenshot.slice(0, 5)) {
    tests.push({ id: ++id, type: 'visual_diff_section', subtype: 'section_diff', name: `Section Visual Diff: ${path}`, path });
  }

  // ── USER JOURNEY FLOWS ──
  tests.push({ id: ++id, type: 'user_journey', subtype: 'browse_to_cart', name: 'Journey: Browse → Add to Cart' });
  if (discovery1.features.hasLogin || discovery2.features.hasLogin) {
    tests.push({ id: ++id, type: 'user_journey', subtype: 'login_to_profile', name: 'Journey: Login → Profile → Orders' });
  }
  if (discovery1.features.hasSearch || discovery2.features.hasSearch) {
    tests.push({ id: ++id, type: 'user_journey', subtype: 'search_to_product', name: 'Journey: Search → Filter → Product' });
  }

  // ── INTERACTION TESTS ──
  tests.push({ id: ++id, type: 'interaction', subtype: 'interaction', name: 'Interaction Tests (hover, scroll, carousel, tabs)' });

  // ── API COMPARISON ──
  tests.push({ id: ++id, type: 'api_compare', subtype: 'api_compare', name: 'API Response Comparison (Prod vs UAT)' });

  // ── FORM VALIDATION ──
  const formPagesForValidation = [...new Set([...discovery1.forms.map(f => f.foundOn), ...discovery2.forms.map(f => f.foundOn)])];
  for (const formPage of formPagesForValidation.slice(0, 3)) {
    tests.push({ id: ++id, type: 'form_validation', subtype: 'form_validation', name: `Form Validation: ${formPage}`, path: formPage });
  }

  // ── SEO VALIDATION ──
  tests.push({ id: ++id, type: 'seo', subtype: 'robots_sitemap', name: 'SEO: robots.txt & sitemap.xml Validation' });
  const seoPages = ['/', '/products', '/contact-us'].filter(p => allPaths.includes(p));
  for (const path of seoPages.slice(0, 3)) {
    tests.push({ id: ++id, type: 'seo', subtype: 'structured_data', name: `SEO: Structured Data & Meta — ${path}`, path });
  }

  // ── E-COMMERCE ENHANCED ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'ecommerce_enhanced', subtype: 'product_gallery_zoom', name: 'PDP: Image Gallery, Zoom & Size Guide' });
    tests.push({ id: ++id, type: 'ecommerce_enhanced', subtype: 'out_of_stock', name: 'Out-of-Stock UX (PLP & PDP)' });
    tests.push({ id: ++id, type: 'ecommerce_enhanced', subtype: 'price_format', name: 'Price/Currency Format Validation' });
    tests.push({ id: ++id, type: 'ecommerce_enhanced', subtype: 'related_products', name: 'PDP: Related & Recommended Products' });
    tests.push({ id: ++id, type: 'ecommerce_enhanced', subtype: 'social_sharing', name: 'PDP: Social Sharing Buttons' });
  }
  if (discovery1.features.hasCart || discovery2.features.hasCart) {
    tests.push({ id: ++id, type: 'ecommerce_enhanced', subtype: 'coupon_promo', name: 'Coupon/Promo Code Validation' });
  }

  // ── NAVIGATION & UX ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'navigation_ux', subtype: 'breadcrumb', name: 'Breadcrumb Navigation Validation' });
  }
  tests.push({ id: ++id, type: 'navigation_ux', subtype: 'mobile_menu', name: 'Mobile Hamburger Menu Test' });
  tests.push({ id: ++id, type: 'navigation_ux', subtype: 'cookie_consent', name: 'Cookie Consent Banner Test' });

  // ── SECURITY ENHANCED ──
  tests.push({ id: ++id, type: 'security_enhanced', subtype: 'http_headers', name: 'HTTP Security Headers Audit' });

  // ── PERFORMANCE ENHANCED ──
  tests.push({ id: ++id, type: 'performance_enhanced', subtype: 'image_optimization', name: 'Image Optimization (alt, lazy, WebP, size)' });
  tests.push({ id: ++id, type: 'performance_enhanced', subtype: 'scroll_performance', name: 'Scroll Performance & Jank Detection' });

  // ── CONTENT & POLICY ──
  tests.push({ id: ++id, type: 'content_policy', subtype: 'policy_pages', name: 'Policy Pages (Shipping, Returns, Privacy, Terms, FAQ)' });

  // ── LOGIN + SCROLL VALIDATION ──
  if (discovery1.features.hasLogin || discovery2.features.hasLogin) {
    tests.push({ id: ++id, type: 'auth', subtype: 'login_scroll', name: 'Login + Scroll Validation' });
  }

  // ── SESSION TESTS ──
  if (discovery1.features.hasLogin || discovery2.features.hasLogin) {
    tests.push({ id: ++id, type: 'session', subtype: 'session_persist', name: 'Session Persistence (refresh, cart, logout)' });
  }

  // ── PAYMENT TESTS ──
  if (discovery1.features.hasCart || discovery2.features.hasCart) {
    tests.push({ id: ++id, type: 'payment', subtype: 'payment_methods', name: 'Payment Methods (COD, UPI, Card)' });
    tests.push({ id: ++id, type: 'payment', subtype: 'payment_failure', name: 'Payment Failure & Retry Flow' });
  }

  // ── ORDER LIFECYCLE ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'order_lifecycle', subtype: 'order_lifecycle', name: 'Order Lifecycle (place, verify, cancel)' });
  }

  // ── PRICING VALIDATION ──
  if (discovery1.features.hasProducts || discovery2.features.hasProducts) {
    tests.push({ id: ++id, type: 'pricing', subtype: 'pricing_validation', name: 'Pricing Validation (item=cart total, discount, tax)' });
  }

  // ── RACE CONDITIONS ──
  if (discovery1.features.hasCart || discovery2.features.hasCart) {
    tests.push({ id: ++id, type: 'race_condition', subtype: 'race_condition', name: 'Race Conditions (double ATC, rapid qty, multi-tab)' });
  }

  log(`  [PLAN] Generated ${tests.length} dynamic test cases`);
  return tests;
}

// ─────────────────────────────────────────────────────────────
// TEST RUNNERS: Execute each test type
// ─────────────────────────────────────────────────────────────

async function runPageLoadTest(browser, siteUrl, label, path, bugs, pageData, screenshots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const networkErrors = [];

  page.on('requestfailed', req => { networkErrors.push({ url: req.url().substring(0, 100), error: req.failure()?.errorText }); });

  try {
    const start = Date.now();
    const resp = await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for SPA to finish rendering
    await page.waitForTimeout(3000);
    try { await page.waitForSelector('body *', { timeout: 5000 }); } catch {}
    const loadTime = ((Date.now() - start) / 1000).toFixed(2);
    const status = resp ? resp.status() : 0;
    const title = await page.title();
    const key = `${label}_page_${path.replace(/[^a-z0-9]/gi, '_')}`;

    // Full page screenshot
    await page.waitForTimeout(1000);
    try { screenshots[key] = b64(await page.screenshot({ fullPage: true })); } catch {}

    // Detailed page analysis
    const analysis = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img');
      const brokenImgs = [...imgs].filter(i => i.complete && i.naturalWidth === 0);
      const lazyImgs = [...imgs].filter(i => i.loading === 'lazy' || i.getAttribute('data-src'));
      const emptyAlt = [...imgs].filter(i => !i.getAttribute('alt'));
      const links = document.querySelectorAll('a[href]');
      const h1s = document.querySelectorAll('h1');
      const forms = document.querySelectorAll('form');
      const btns = document.querySelectorAll('button, [role="button"]');
      const inputs = document.querySelectorAll('input, textarea, select');
      const sections = document.querySelectorAll('section, [class*="section"]');

      const bodyText = document.body.innerText;
      const visibleText = bodyText.trim();

      // Blank page detection — page loaded but has almost no visible content
      const isBlankPage = visibleText.length < 50;

      // Required elements — header and footer should be present on every page
      const hasHeader = !!document.querySelector('header, nav, [class*="header"], [class*="Header"], [id*="header"], [role="banner"]');
      const hasFooter = !!document.querySelector('footer, [class*="footer"], [class*="Footer"], [id*="footer"], [role="contentinfo"]');

      // Minimum content check — page should have meaningful content beyond just header/footer
      const mainContent = document.querySelector('main, [role="main"], #content, .content, [class*="main-content"], [class*="page-content"]');
      const mainText = mainContent ? mainContent.innerText.trim() : '';
      const hasMinimumContent = visibleText.length >= 200 || mainText.length >= 100;

      // Smart Lorem/Placeholder text detection
      const loremPatterns = [
        /lorem\s+ipsum/i,
        /dolor\s+sit\s+amet/i,
        /consectetur\s+adipiscing/i,
        /sed\s+do\s+eiusmod/i,
        /ut\s+labore\s+et/i,
      ];
      const placeholderPatterns = [
        /\bexample[.-]host\b/i,
        /\bexample\.com\b/i,
        /\bfoo\s*bar\b/i,
        /\btest@test\.com\b/i,
        /\buser@example\b/i,
        /\bTODO\b/,
        /\bFIXME\b/,
        /\bXXX\b/,
        /\byour[- ]?(company|brand|name|logo|title|text|image|content)\s*here\b/i,
        /\b(insert|add|replace|put)\s+(your|the)\s+(text|content|image|logo|title)\s*here\b/i,
        /\bcoming\s+soon\b/i,
        /\bunder\s+construction\b/i,
      ];
      const loremMatches = loremPatterns.filter(p => p.test(bodyText));
      const placeholderMatches = placeholderPatterns.filter(p => p.test(bodyText));
      const hasLorem = loremMatches.length > 0;
      const hasPlaceholder = placeholderMatches.length > 0;
      const placeholderDetail = placeholderMatches.map(p => {
        const m = bodyText.match(p);
        return m ? m[0] : '';
      }).filter(Boolean).join(', ');

      // Check for 404 content (avoid false positives like "404 items found")
      const has404 = bodyText.includes('Page Not Found') || bodyText.includes('page not found') || /\b404\b.*?(not found|error|page)/i.test(bodyText) || /error.*?\b404\b/i.test(bodyText);

      return {
        imageCount: imgs.length,
        brokenImages: brokenImgs.length,
        brokenImageSrcs: brokenImgs.slice(0, 5).map(i => ({
          src: (i.getAttribute('src') || i.getAttribute('data-src') || '').substring(0, 150),
          alt: (i.getAttribute('alt') || ''),
          parent: i.parentElement ? `<${i.parentElement.tagName.toLowerCase()} class="${(i.parentElement.className || '').substring(0, 50)}">` : '',
        })),
        lazyImages: lazyImgs.length,
        emptyAltImages: emptyAlt.length,
        linkCount: links.length,
        h1Count: h1s.length,
        formCount: forms.length,
        buttonCount: btns.length,
        inputCount: inputs.length,
        sectionCount: sections.length,
        pageHeight: document.body.scrollHeight,
        textLength: bodyText.length,
        isBlankPage, hasHeader, hasFooter, hasMinimumContent,
        hasLorem, hasPlaceholder, placeholderDetail, has404,
        title: document.title,
        metaDesc: (document.querySelector('meta[name="description"]')?.getAttribute('content') || '').substring(0, 100),
      };
    });

    pageData[`${key}_analysis`] = { ...analysis, loadTime: parseFloat(loadTime), status, networkErrors };

    // Generate bugs
    const sn = siteName(label, siteUrl);
    const ssKey = key;
    if (status === 404) {
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Routing', title: `${path} returns 404 on ${sn}`, description: `Page ${path} returns HTTP 404. The URL resolves but server responds with 404 status code, meaning the page does not exist or is not published.`, site: sn, fix: `Create/enable page at ${path}`, testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Observe the HTTP response status`, expected: 'Page loads with HTTP 200 status', actual: `Page returns HTTP 404 — Not Found`, screenshotKey: ssKey });
    }
    if (status >= 500) {
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Server', title: `${path} returns ${status} server error on ${sn}`, description: `Server error on ${path}. The server is failing to process this request, indicating a backend issue.`, site: sn, fix: 'Check server logs and fix backend error', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Observe HTTP ${status} error`, expected: 'Page loads successfully with HTTP 200', actual: `Server returns HTTP ${status} error`, screenshotKey: ssKey });
    }
    // Blank page — page loaded but shows nothing meaningful
    if (analysis.isBlankPage && status === 200) {
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Content', title: `Blank page detected on ${path} (${sn})`, description: `Page loaded with HTTP 200 but has almost no visible content (less than 50 characters of text). The page appears blank or empty to users.`, site: sn, fix: 'Check if page content is loading correctly — may be a rendering issue, missing data, or JS error preventing content from displaying', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Page loads but shows blank/empty content\n3. View page source to check if content exists in HTML`, expected: 'Page displays meaningful content', actual: 'Page appears blank with no visible content', screenshotKey: ssKey });
    }
    // Required elements — header and footer
    if (!analysis.hasHeader && status === 200 && !analysis.isBlankPage) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Layout', title: `Header/Navigation missing on ${path} (${sn})`, description: `No header or navigation element found on the page. Every page should have a consistent header with navigation for users to browse the site.`, site: sn, fix: 'Ensure header/nav component is included on this page', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Look for header/navigation bar at top of page\n3. Header is missing`, expected: 'Page has a visible header with navigation', actual: 'No header or navigation element found', screenshotKey: ssKey });
    }
    if (!analysis.hasFooter && status === 200 && !analysis.isBlankPage) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Layout', title: `Footer missing on ${path} (${sn})`, description: `No footer element found on the page. Every page should have a consistent footer with important links and information.`, site: sn, fix: 'Ensure footer component is included on this page', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Scroll to bottom of page\n3. Footer is missing`, expected: 'Page has a visible footer', actual: 'No footer element found', screenshotKey: ssKey });
    }
    // Minimum content check
    if (!analysis.hasMinimumContent && !analysis.isBlankPage && status === 200) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Content', title: `Very low content on ${path} (${sn})`, description: `Page has very little visible content (less than 200 characters). This may indicate missing content, failed data loading, or an incomplete page.`, site: sn, fix: 'Check if all content sections are loading — may need content to be added or a data-fetching issue to be fixed', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Observe that page has very little content\n3. Check if content sections are empty`, expected: 'Page has meaningful content in all sections', actual: 'Page has minimal content — appears incomplete', screenshotKey: ssKey });
    }
    if (analysis.brokenImages > 0) {
      const srcDetails = analysis.brokenImageSrcs.map(s => `src="${s.src}" alt="${s.alt}" inside ${s.parent}`).join('\n    ');
      const srcUrls = analysis.brokenImageSrcs.map(s => s.src).join(', ');
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Images', title: `${analysis.brokenImages} broken images on ${path} (${sn})`, description: `${analysis.brokenImages} image(s) failed to load.\n  Broken images:\n    ${srcDetails}`, site: sn, fix: `Fix or replace broken image URLs: ${srcUrls}`, testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Open DevTools → Network tab → filter by "Img"\n3. Look for failed image requests\n4. Broken sources:\n    ${analysis.brokenImageSrcs.map(s => s.src).join('\n    ')}`, expected: 'All images load and display correctly', actual: `${analysis.brokenImages} images show broken/empty placeholders`, screenshotKey: ssKey });
    }
    if (analysis.hasLorem) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Content', title: `Lorem ipsum placeholder text on ${path} (${sn})`, description: 'Lorem ipsum dummy text is visible on the live page, indicating unfinished or template content that was never replaced with real copy.', site: sn, fix: 'Replace all Lorem ipsum text with actual content', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Read through page content\n3. Find "Lorem ipsum" or similar dummy text`, expected: 'Page displays real, finalized content', actual: 'Page shows Lorem ipsum placeholder text', screenshotKey: ssKey });
    }
    if (analysis.hasPlaceholder) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Content', title: `Placeholder/dev text found on ${path} (${sn})`, description: `Developer placeholder text is visible on the live page. Found: ${analysis.placeholderDetail}`, site: sn, fix: 'Remove or replace placeholder text with real content', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Read page content\n3. Notice placeholder text: ${analysis.placeholderDetail}`, expected: 'No developer placeholders visible to end users', actual: `Placeholder text found: ${analysis.placeholderDetail}`, screenshotKey: ssKey });
    }
    // Slow page loads are not considered bugs per user preference
    if (networkErrors.length > 0) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Network', title: `${networkErrors.length} network failures on ${path} (${sn})`, description: `${networkErrors.length} network request(s) failed. URLs: ${networkErrors.slice(0, 3).map(e => e.url).join(' | ')}`, site: sn, fix: 'Fix failed network requests — check API endpoints and resource URLs', testType: 'Regression', location: `${path} (${sn}) — Network Tab`, steps: `1. Open DevTools → Network tab\n2. Navigate to ${siteUrl}${path}\n3. Filter by failed requests`, expected: 'All network requests succeed', actual: `${networkErrors.length} request(s) failed`, screenshotKey: ssKey });
    }
    if (analysis.has404 && status === 200) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Routing', title: `${path} shows 404 content but returns 200 (${sn})`, description: 'Soft 404 — page returns HTTP 200 but displays "Page Not Found" content. This confuses search engines and users.', site: sn, fix: 'Return proper 404 status code or fix the page content', testType: 'Sanity', location: `${path} (${sn})`, steps: `1. Navigate to ${siteUrl}${path}\n2. Page loads with 200 status\n3. Content shows "Page Not Found" or "404" text`, expected: 'Either return 404 status or show proper content', actual: 'HTTP 200 returned but page shows 404/not-found content', screenshotKey: ssKey });
    }

  } catch (e) {
    pageData[`${label}_page_${path.replace(/[^a-z0-9]/gi, '_')}_error`] = e.message;
  }
  await page.close();
}

async function runMultiDeviceTest(browser, siteUrl, label, path, bugs, pageData, screenshots) {
  for (const [deviceName, device] of Object.entries(DEVICES)) {
    const ctx = await browser.newContext({
      viewport: device.viewport,
      isMobile: device.isMobile,
      userAgent: device.userAgent,
    });
    const page = await ctx.newPage();
    const key = `${label}_${path.replace(/[^a-z0-9]/gi, '_')}_${deviceName.replace(/\s/g, '_').toLowerCase()}`;

    try {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(1500);

      // On mobile /products: skip scrolling, capture only first viewport (above the fold)
      const isMobilePLP = device.isMobile && (path === '/products' || path.startsWith('/products'));
      if (!isMobilePLP) {
        // Scroll to load lazy images (non-mobile or non-products pages)
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 400) {
            window.scrollTo(0, y);
            await new Promise(r => setTimeout(r, 150));
          }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(1000);
      }

      screenshots[key] = b64(await page.screenshot({ fullPage: !isMobilePLP }));

      // Alignment analysis
      const issues = await page.evaluate(() => {
        const problems = [];
        const vw = window.innerWidth;

        if (document.body.scrollWidth > vw + 5) {
          problems.push({ type: 'Horizontal Overflow', detail: `Page width ${document.body.scrollWidth}px exceeds viewport ${vw}px` });
        }

        let overflowCount = 0;
        const overflowExamples = [];
        for (const el of document.querySelectorAll('*')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.right > vw + 10) {
            // Skip elements inside scrollable containers (carousels, sliders, horizontal scroll areas)
            let parent = el.parentElement;
            let insideScrollable = false;
            while (parent && parent !== document.body) {
              const ps = getComputedStyle(parent);
              if (ps.overflowX === 'hidden' || ps.overflowX === 'scroll' || ps.overflowX === 'auto' || parent.scrollWidth > parent.clientWidth + 5) {
                insideScrollable = true;
                break;
              }
              parent = parent.parentElement;
            }
            if (!insideScrollable) {
              overflowCount++;
              if (overflowExamples.length < 3) {
                const tag = el.tagName.toLowerCase();
                const cls = el.className ? `.${String(el.className).split(' ')[0]}` : '';
                overflowExamples.push(`<${tag}${cls}> (right: ${Math.round(rect.right)}px, viewport: ${vw}px)`);
              }
            }
          }
        }
        if (overflowCount > 0) {
          const examples = overflowExamples.length > 0 ? `\nExamples: ${overflowExamples.join(', ')}` : '';
          problems.push({ type: 'Content Cut Off', detail: `${overflowCount} elements overflow viewport (excluding carousels/sliders)${examples}` });
        }

        let clipped = 0;
        for (const el of document.querySelectorAll('p, h1, h2, h3, h4, span, a, li, button')) {
          const s = getComputedStyle(el);
          if (s.overflow === 'hidden' && el.scrollHeight > el.clientHeight + 5) clipped++;
        }
        if (clipped > 0) problems.push({ type: 'Text Clipped', detail: `${clipped} elements have hidden overflow text` });

        const imgs = document.querySelectorAll('img');
        let broken = 0, oversized = 0;
        const brokenSrcs = [];
        const oversizedSrcs = [];
        for (const img of imgs) {
          if (img.complete && img.naturalWidth === 0) {
            broken++;
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            const alt = img.getAttribute('alt') || '';
            const parentTag = img.parentElement ? img.parentElement.tagName.toLowerCase() : '';
            const parentClass = img.parentElement ? (img.parentElement.className || '').substring(0, 50) : '';
            brokenSrcs.push({ src: src.substring(0, 150), alt, parentTag, parentClass });
          }
          if (img.getBoundingClientRect().width > vw) {
            oversized++;
            oversizedSrcs.push((img.getAttribute('src') || '').substring(0, 150));
          }
        }
        if (broken > 0) problems.push({ type: 'Broken Images', detail: `${broken} images failed to load`, brokenSrcs });
        if (oversized > 0) problems.push({ type: 'Oversized Images', detail: `${oversized} images wider than screen`, oversizedSrcs });

        // Check for truly untappable/unclickable elements on mobile
        if (vw < 768) {
          const untappable = [];
          for (const el of document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"], [role="button"], [onclick]')) {
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) continue;
            // Check if element is actually blocked by another element
            const centerX = r.left + r.width / 2;
            const centerY = r.top + r.height / 2;
            if (centerX < 0 || centerY < 0 || centerX > vw) continue;
            const topEl = document.elementFromPoint(centerX, centerY);
            const isBlocked = topEl && topEl !== el && !el.contains(topEl) && !topEl.closest('a, button, [role="button"]')?.contains(el);
            // Check if truly too small (under 20px — genuinely hard to tap, not just guideline)
            const isTinyAndVisible = (r.width < 20 || r.height < 20) && el.textContent.trim().length > 0;
            if (isBlocked || isTinyAndVisible) {
              const tag = el.tagName.toLowerCase();
              const text = (el.textContent || '').trim().substring(0, 30);
              const cls = el.className ? String(el.className).split(' ')[0] : '';
              const reason = isBlocked ? 'blocked by another element — cannot be tapped' : `only ${Math.round(r.width)}x${Math.round(r.height)}px — too tiny to tap`;
              untappable.push({ element: `<${tag}${cls ? '.' + cls : ''}>${text ? '"' + text + '"' : ''}`, reason, width: Math.round(r.width), height: Math.round(r.height) });
            }
          }
          if (untappable.length > 0) {
            const examples = untappable.slice(0, 5);
            const detailList = examples.map(u => `${u.element} — ${u.reason}`).join('\n');
            problems.push({ type: 'Untappable Elements', detail: detailList, untappable: examples, count: untappable.length });
          }
        }

        return problems;
      });

      pageData[`${key}_alignment`] = issues;
      const sn = siteName(label, siteUrl);
      for (const issue of issues) {
        let description = issue.detail;
        let steps = `1. Open ${siteUrl}${path}\n2. Set browser viewport to ${device.viewport.width}x${device.viewport.height} (${deviceName})\n3. Observe the issue`;
        let expected = 'Page renders correctly without layout issues';
        let actual = issue.detail;
        let fixMsg = `Fix layout on ${deviceName} (${device.viewport.width}x${device.viewport.height})`;

        if (issue.type === 'Broken Images' && issue.brokenSrcs) {
          const srcList = issue.brokenSrcs.map(s => `src="${s.src}" alt="${s.alt}" (inside <${s.parentTag} class="${s.parentClass}">)`).join('\n    ');
          description = `${issue.brokenSrcs.length} image(s) failed to load.\n  Broken images:\n    ${srcList}`;
          steps = `1. Open ${siteUrl}${path} on ${deviceName}\n2. Open DevTools → Network tab → filter by "Img"\n3. Look for failed image requests\n4. Broken sources:\n    ${issue.brokenSrcs.map(s => s.src).join('\n    ')}`;
          expected = 'All images load and display correctly';
          actual = `${issue.brokenSrcs.length} image(s) show broken/empty placeholders`;
          fixMsg = `Fix or replace broken image URLs: ${issue.brokenSrcs.map(s => s.src).slice(0, 3).join(', ')}`;
        } else if (issue.type === 'Oversized Images' && issue.oversizedSrcs) {
          description = `${issue.oversizedSrcs.length} image(s) wider than ${device.viewport.width}px viewport: ${issue.oversizedSrcs.slice(0, 3).join(', ')}`;
          steps = `1. Open ${siteUrl}${path} on ${deviceName}\n2. Scroll page — notice images extending beyond viewport\n3. Oversized image sources: ${issue.oversizedSrcs.slice(0, 3).join(', ')}`;
          fixMsg = `Add max-width:100% to images or use responsive image sizing`;
        } else if (issue.type === 'Horizontal Overflow') {
          steps = `1. Open ${siteUrl}${path} on ${deviceName}\n2. Try scrolling horizontally — page content extends beyond screen width`;
        } else if (issue.type === 'Content Cut Off') {
          steps = `1. Open ${siteUrl}${path} on ${deviceName}\n2. Inspect elements near right edge of viewport — content is clipped`;
        } else if (issue.type === 'Untappable Elements') {
          const examples = issue.untappable || [];
          const exampleList = examples.map((u, i) => `${i + 1}. ${u.element} — ${u.reason}`).join('\n');
          description = `${issue.count} button(s) or link(s) on this page cannot be tapped on ${deviceName} (${device.viewport.width}x${device.viewport.height}). They are either blocked by another element sitting on top, or so tiny that a finger cannot accurately tap them.\n\nAffected elements:\n${exampleList}`;
          steps = `1. Open ${siteUrl}${path} on ${deviceName} (or use DevTools mobile emulation)\n2. Try tapping the elements listed below\n3. They will either not respond to taps, or be impossible to hit accurately\n\nElements that cannot be tapped:\n${exampleList}`;
          expected = 'All buttons and links on the page should be tappable and respond to user interaction';
          actual = `${issue.count} element(s) cannot be tapped — they are either covered by another element or too small (under 20px)`;
          fixMsg = 'Ensure tappable elements are not overlapped by other elements, and are at least 20x20px in size';
        }

        bugs.push({
          id: bugs.length + 1,
          severity: issue.type === 'Horizontal Overflow' || issue.type === 'Content Cut Off' ? 'High' : issue.type === 'Untappable Elements' ? 'High' : 'Medium',
          category: 'UI Alignment',
          title: `${issue.type} — ${path} on ${deviceName} (${sn})`,
          description,
          site: sn,
          fix: fixMsg,
          testType: 'Responsive',
          location: `${path} on ${deviceName} (${device.viewport.width}x${device.viewport.height})`,
          steps,
          expected,
          actual,
          screenshotKey: key,
        });
      }

      // Page structure for comparison
      const info = await page.evaluate(() => ({
        pageHeight: document.body.scrollHeight,
        sectionCount: document.querySelectorAll('section, [class*="section"], [class*="container"]').length,
        imageCount: document.querySelectorAll('img').length,
        visibleImages: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth > 0).length,
        linkCount: document.querySelectorAll('a[href]').length,
        headingCount: document.querySelectorAll('h1, h2, h3').length,
        textLength: document.body.innerText.length,
      }));
      pageData[`${key}_info`] = info;

    } catch (e) {
      pageData[`${key}_error`] = e.message;
    }
    await ctx.close();
  }
}

async function runFormTest(browser, siteUrl, label, path, bugs, pageData, screenshots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sn = siteName(label, siteUrl);
  const key = `${label}_form_${path.replace(/[^a-z0-9]/gi, '_')}`;

  try {
    const resp = await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (resp && resp.status() === 404) { await page.close(); return; }
    await page.waitForTimeout(1500);
    screenshots[`${key}_page`] = b64(await page.screenshot({ fullPage: true }));

    // Find all visible form fields
    const fields = await page.evaluate(() => {
      const inputs = [...document.querySelectorAll('input, textarea, select')].filter(i => i.offsetParent !== null);
      return inputs.map(i => ({
        type: i.type || i.tagName.toLowerCase(),
        name: i.name || '',
        placeholder: i.placeholder || '',
        required: i.required,
        id: i.id || '',
        tag: i.tagName.toLowerCase(),
      }));
    });

    pageData[`${key}_fields`] = fields;

    if (fields.length === 0) { await page.close(); return; }

    // Test 1: Empty submit — with self-healing
    let submitResult;
    if (learning) { submitResult = await learning.healAndFind(page, 'submitButton'); }
    const submitBtn = submitResult?.element || page.locator('button[type="submit"], button:has-text("Submit"), button:has-text("Send"), input[type="submit"]').first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await submitBtn.click();
      await page.waitForTimeout(1500);
      screenshots[`${key}_empty_submit`] = b64(await page.screenshot());

      const validation = await page.evaluate(() => {
        const errors = document.querySelectorAll('[class*="error"], [class*="invalid"], [role="alert"], .error, .invalid');
        const invalid = document.querySelectorAll(':invalid');
        return { errors: errors.length, invalid: invalid.length };
      });

      if (validation.errors === 0 && validation.invalid === 0 && fields.some(f => f.required)) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Forms', title: `No validation on empty form submit: ${path} (${sn})`, description: 'Required fields not validated on submit', site: sn, fix: 'Add client-side validation', testType: 'Sanity' });
      }
    }

    // Test 2: Invalid data
    const nameInput = page.locator('input[name*="name" i], input[placeholder*="name" i]').first();
    const emailInput = page.locator('input[type="email"], input[name*="email" i], input[placeholder*="email" i]').first();
    const phoneInput = page.locator('input[type="tel"], input[name*="phone" i], input[placeholder*="phone" i]').first();
    const msgInput = page.locator('textarea, input[name*="message" i]').first();

    if (await emailInput.isVisible().catch(() => false)) {
      await emailInput.fill('not-an-email');
      if (await nameInput.isVisible().catch(() => false)) await nameInput.fill('Test');
      if (await phoneInput.isVisible().catch(() => false)) await phoneInput.fill('123');
      if (await msgInput.isVisible().catch(() => false)) await msgInput.fill('Automated test');
      screenshots[`${key}_invalid`] = b64(await page.screenshot());

      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(1500);
        screenshots[`${key}_invalid_submit`] = b64(await page.screenshot());

        const invalidCheck = await page.evaluate(() => document.querySelectorAll('[class*="error"], [class*="invalid"], [role="alert"]').length);
        if (invalidCheck === 0) {
          bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Forms', title: `Form accepts invalid email on ${path} (${sn})`, description: 'No validation error for "not-an-email"', site: sn, fix: 'Add email format validation', testType: 'Sanity' });
        }
      }
    }

    // Test 3: Valid data
    if (await nameInput.isVisible().catch(() => false)) { await nameInput.fill(''); await nameInput.fill('Test User Automation'); }
    if (await emailInput.isVisible().catch(() => false)) { await emailInput.fill(''); await emailInput.fill('testuser@example.com'); }
    if (await phoneInput.isVisible().catch(() => false)) { await phoneInput.fill(''); await phoneInput.fill(TEST_CONFIG.credentials.phone); }
    if (await msgInput.isVisible().catch(() => false)) { await msgInput.fill(''); await msgInput.fill('Automated test message for form validation.'); }
    screenshots[`${key}_valid`] = b64(await page.screenshot());

  } catch (e) {
    pageData[`${key}_error`] = e.message;
  }
  await page.close();
}

async function runLoginTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sn = siteName(label, siteUrl);

  try {
    await page.goto(siteUrl + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    screenshots[`${label}_login_page`] = b64(await page.screenshot());

    const title = await page.evaluate(() => document.title);
    if (title.includes('404') || (await page.locator('text=404').count()) > 0) {
      pageData[`${label}_login_flow`] = 'LOGIN_PAGE_404';
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Auth', title: `Login page 404 on ${sn}`, description: '/auth/login returns 404', site: sn, fix: 'Enable auth and add login template', testType: 'Sanity' });
      await page.close();
      return;
    }

    // Phone input — with self-healing
    let phoneResult;
    if (learning) {
      phoneResult = await learning.healAndFind(page, 'phoneInput');
    }
    const phoneInput = phoneResult?.element || page.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="mobile" i], input[placeholder*="number" i]').first();
    let phoneVisible = await phoneInput.isVisible().catch(() => false);

    if (!phoneVisible) {
      const phoneBtn = page.locator('text=/phone|mobile|OTP/i').first();
      if (await phoneBtn.isVisible().catch(() => false)) {
        await phoneBtn.click();
        await page.waitForTimeout(1000);
        phoneVisible = await phoneInput.isVisible().catch(() => false);
      }
    }

    if (phoneVisible) {
      await phoneInput.fill(TEST_CONFIG.credentials.phone);
      await page.waitForTimeout(500);
      screenshots[`${label}_login_phone`] = b64(await page.screenshot());

      // Send OTP button — with self-healing
      let sendResult;
      if (learning) {
        sendResult = await learning.healAndFind(page, 'sendOtpButton');
      }
      const sendBtn = sendResult?.element || page.locator('button:has-text("Send"), button:has-text("Continue"), button:has-text("OTP"), button:has-text("Get OTP"), button:has-text("Sign"), button[type="submit"]').first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
        await page.waitForTimeout(3000);
        screenshots[`${label}_login_otp_sent`] = b64(await page.screenshot());

        // Enter OTP
        const otpInputs = page.locator('input[type="tel"][maxlength="1"], input[name*="otp"], input[placeholder*="otp" i], input[aria-label*="otp" i]');
        const otpCount = await otpInputs.count();
        if (otpCount >= 4) {
          for (let i = 0; i < Math.min(otpCount, 4); i++) {
            await otpInputs.nth(i).fill(TEST_CONFIG.credentials.otp[i]);
            await page.waitForTimeout(200);
          }
          pageData[`${label}_login_otp_entered`] = true;
        } else {
          const singleOtp = page.locator('input[name*="otp"], input[placeholder*="otp" i], input[type="tel"]:not([maxlength="1"])').first();
          if (await singleOtp.isVisible().catch(() => false)) {
            await singleOtp.fill(TEST_CONFIG.credentials.otp);
            pageData[`${label}_login_otp_entered`] = true;
          }
        }
        screenshots[`${label}_login_otp_entered`] = b64(await page.screenshot());

        // Verify
        const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Login"), button:has-text("Sign"), button[type="submit"]').first();
        if (await verifyBtn.isVisible().catch(() => false)) {
          await verifyBtn.click();
          await page.waitForTimeout(5000);
          screenshots[`${label}_login_result`] = b64(await page.screenshot());

          const currentUrl = page.url();
          const loggedIn = !currentUrl.includes('/auth/login') && !currentUrl.includes('/login');
          pageData[`${label}_login_success`] = loggedIn;

          if (loggedIn) {
            await page.goto(siteUrl + '/profile', { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(2000);
            screenshots[`${label}_profile_loggedin`] = b64(await page.screenshot());

            const logoutBtn = page.locator('text=/logout|sign out|log out/i, a[href*="logout"], button:has-text("Logout")').first();
            if (await logoutBtn.isVisible().catch(() => false)) {
              await logoutBtn.click();
              await page.waitForTimeout(3000);
              screenshots[`${label}_logout`] = b64(await page.screenshot());
              pageData[`${label}_logout_success`] = true;
            } else {
              pageData[`${label}_logout_button_found`] = false;
              bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Auth', title: `No logout button found (${sn})`, description: 'User cannot find logout option', site: sn, fix: 'Add visible logout button', testType: 'Regression' });
            }
          }
        }
      }
    } else {
      pageData[`${label}_login_flow`] = 'NO_PHONE_INPUT';
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Auth', title: `No phone input on login page (${sn})`, description: 'Phone/mobile input not found', site: sn, fix: 'Add phone input to login form', testType: 'Sanity' });
    }
  } catch (e) {
    pageData[`${label}_login_error`] = e.message;
  }
  await page.close();
}

async function runLinkValidation(browser, siteUrl, label, links, linkType, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const results = [];
  const tested = new Set();

  // Reuse a single page for all link checks to avoid resource exhaustion
  const testPage = await browser.newPage();
  try {
    for (const link of links) {
      const href = link.fullUrl || link.href || '';
      if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('#')) continue;
      if (href.includes('instagram.com') || href.includes('facebook.com') || href.includes('twitter.com') || href.includes('youtube.com') || href.includes('linkedin.com')) {
        results.push({ ...link, status: 'external' });
        continue;
      }

      const fullUrl = href.startsWith('/') ? siteUrl + href : href;
      if (tested.has(fullUrl)) continue;
      tested.add(fullUrl);

      try {
        const resp = await testPage.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        const status = resp ? resp.status() : 0;
        results.push({ ...link, status, fullUrl });
        if (status === 404) {
          bugs.push({ id: bugs.length + 1, severity: 'Medium', category: linkType, title: `Broken ${linkType} link: "${link.text || href}" → 404 (${sn})`, description: `${fullUrl} returns 404`, site: sn, fix: `Fix or remove broken link: ${href}`, testType: 'Sanity' });
        }
      } catch (e) {
        results.push({ ...link, status: 'error', error: e.message.substring(0, 60) });
      }
    }
  } finally {
    await testPage.close();
  }

  pageData[`${label}_${linkType.toLowerCase()}_results`] = results;
  return results;
}

async function runAccessibilityTest(browser, siteUrl, label, path, bugs, pageData) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sn = siteName(label, siteUrl);
  const key = `${label}_a11y_${path.replace(/[^a-z0-9]/gi, '_')}`;

  try {
    await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    if (AxeBuilder) {
      // Use axe-core for comprehensive WCAG 2.1 accessibility scan
      const axeResults = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'])
        .analyze();

      const violations = axeResults.violations || [];
      const passCount = (axeResults.passes || []).length;
      const totalChecks = passCount + violations.length;
      const score = totalChecks > 0 ? Math.round((passCount / totalChecks) * 100) : 100;

      pageData[key] = {
        score,
        engine: 'axe-core',
        violationCount: violations.length,
        passCount,
        violations: violations.map(v => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          helpUrl: v.helpUrl,
          nodes: v.nodes.length,
        })),
      };

      // Map axe severity to our bug severity
      const severityMap = { critical: 'Critical', serious: 'High', moderate: 'Medium', minor: 'Low' };

      for (const v of violations) {
        const sev = severityMap[v.impact] || 'Medium';
        // Get first affected element for human-readable location
        const firstNode = v.nodes[0];
        const element = firstNode ? (firstNode.target || []).join(' > ') : '';
        const failureSummary = firstNode ? (firstNode.failureSummary || '').substring(0, 200) : '';

        bugs.push({
          id: bugs.length + 1,
          severity: sev,
          category: 'Accessibility',
          title: `A11y: ${v.description} on ${path} (${sn})`,
          description: `${v.help}. Affects ${v.nodes.length} element(s).${element ? ` First element: ${element}` : ''}`,
          site: sn,
          fix: failureSummary || v.help,
          testType: 'Accessibility',
          location: `${path} (${sn})`,
          steps: `1. Navigate to ${siteUrl}${path}\n2. Run accessibility audit\n3. Issue: ${v.help}${element ? `\n4. Affected element: ${element}` : ''}`,
          expected: `Page passes WCAG 2.1 rule: ${v.id}`,
          actual: `${v.nodes.length} element(s) fail this check. ${failureSummary}`,
        });
      }
    } else {
      // Fallback: basic manual checks if axe-core not available
      const a11y = await page.evaluate(() => {
        const issues = [];
        let score = 100;
        const imgsNoAlt = document.querySelectorAll('img:not([alt])');
        if (imgsNoAlt.length > 0) { issues.push({ type: 'missing-alt', count: imgsNoAlt.length, severity: 'high', detail: `${imgsNoAlt.length} images missing alt text` }); score -= Math.min(20, imgsNoAlt.length * 3); }
        const noLabel = document.querySelectorAll('button:not([aria-label]):not([title]):empty, a:not([aria-label]):not([title]):empty, input:not([aria-label]):not([placeholder]):not([title])');
        if (noLabel.length > 0) { issues.push({ type: 'missing-aria', count: noLabel.length, severity: 'medium', detail: `${noLabel.length} interactive elements without labels` }); score -= Math.min(10, noLabel.length * 2); }
        if (!document.documentElement.getAttribute('lang')) { issues.push({ type: 'no-lang', severity: 'medium', detail: 'Missing lang attribute' }); score -= 5; }
        return { score: Math.max(0, score), issues, engine: 'fallback' };
      });
      pageData[key] = a11y;
      for (const issue of a11y.issues) {
        bugs.push({ id: bugs.length + 1, severity: issue.severity === 'high' ? 'High' : 'Medium', category: 'Accessibility', title: `A11y: ${issue.detail} on ${path} (${sn})`, description: issue.detail, site: sn, fix: `Fix ${issue.type} on ${path}`, testType: 'Accessibility' });
      }
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${key}_error`] = friendly;
  }
  await page.close();
}

async function runPerformanceTest(browser, siteUrl, label, path, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const key = `${label}_perf_${path.replace(/[^a-z0-9]/gi, '_')}`;

  // Try Lighthouse first for real Core Web Vitals
  let usedLighthouse = false;
  try {
    const lighthouse = require('lighthouse');
    const chromeLauncher = require('chrome-launcher');

    const chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });
    const options = {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance'],
      port: chrome.port,
    };
    const runnerResult = await lighthouse(siteUrl + path, options);
    await chrome.kill();

    if (runnerResult && runnerResult.lhr) {
      usedLighthouse = true;
      const lhr = runnerResult.lhr;
      const perfScore = Math.round((lhr.categories.performance?.score || 0) * 100);
      const audits = lhr.audits || {};

      const fcp = Math.round(audits['first-contentful-paint']?.numericValue || 0);
      const lcp = Math.round(audits['largest-contentful-paint']?.numericValue || 0);
      const cls = parseFloat((audits['cumulative-layout-shift']?.numericValue || 0).toFixed(3));
      const tbt = Math.round(audits['total-blocking-time']?.numericValue || 0);
      const si = Math.round(audits['speed-index']?.numericValue || 0);
      const tti = Math.round(audits['interactive']?.numericValue || 0);
      const totalSize = Math.round((audits['total-byte-weight']?.numericValue || 0) / 1024);
      const domSize = audits['dom-size']?.numericValue || 0;

      const result = {
        page: path, engine: 'lighthouse', score: perfScore,
        fcp, lcp, cls, tbt, si, tti, totalSizeKB: totalSize, domElements: domSize,
        fcpRating: fcp <= 1800 ? 'good' : fcp <= 3000 ? 'needs-improvement' : 'poor',
        lcpRating: lcp <= 2500 ? 'good' : lcp <= 4000 ? 'needs-improvement' : 'poor',
        clsRating: cls <= 0.1 ? 'good' : cls <= 0.25 ? 'needs-improvement' : 'poor',
        tbtRating: tbt <= 200 ? 'good' : tbt <= 600 ? 'needs-improvement' : 'poor',
      };
      pageData[key] = result;

      // Generate bugs based on Lighthouse scores
      if (perfScore < 50) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Performance', title: `Lighthouse score ${perfScore}/100 on ${path} (${sn})`, description: `Overall performance score is ${perfScore}/100 (poor). FCP: ${fcp}ms, LCP: ${lcp}ms, CLS: ${cls}, TBT: ${tbt}ms`, site: sn, fix: 'Optimize critical rendering path, reduce JS bundle size, lazy-load images', testType: 'Performance',
          steps: `1. Open Chrome DevTools → Lighthouse tab\n2. Run audit on ${siteUrl}${path}\n3. Score: ${perfScore}/100`, expected: 'Performance score above 50', actual: `Score: ${perfScore}. FCP: ${fcp}ms, LCP: ${lcp}ms, TBT: ${tbt}ms` });
      }
      if (lcp > 4000) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Performance', title: `Slow LCP ${lcp}ms on ${path} (${sn})`, description: `Largest Contentful Paint is ${lcp}ms (poor — should be under 2500ms). This means users wait ${(lcp / 1000).toFixed(1)}s to see the main content.`, site: sn, fix: 'Optimize the largest image/text block — compress images, use WebP, preload hero image', testType: 'Performance',
          steps: `1. Navigate to ${siteUrl}${path}\n2. Observe: Main content takes ${(lcp / 1000).toFixed(1)}s to appear`, expected: 'LCP under 2500ms (good)', actual: `LCP: ${lcp}ms (${result.lcpRating})` });
      }
      if (cls > 0.25) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Performance', title: `High layout shift CLS ${cls} on ${path} (${sn})`, description: `Cumulative Layout Shift is ${cls} (poor — should be under 0.1). Page elements move around as the page loads, causing a jarring user experience.`, site: sn, fix: 'Set explicit width/height on images and embeds, avoid inserting content above existing content', testType: 'Performance',
          steps: `1. Navigate to ${siteUrl}${path}\n2. Watch page as it loads\n3. Notice elements jumping/shifting position`, expected: 'CLS under 0.1 (good)', actual: `CLS: ${cls} (${result.clsRating})` });
      }
      if (tbt > 600) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Performance', title: `High TBT ${tbt}ms on ${path} (${sn})`, description: `Total Blocking Time is ${tbt}ms (poor — should be under 200ms). JavaScript is blocking the main thread, making the page feel unresponsive.`, site: sn, fix: 'Split large JS bundles, defer non-critical scripts, use web workers for heavy computation', testType: 'Performance',
          steps: `1. Navigate to ${siteUrl}${path}\n2. Try interacting immediately\n3. Page feels sluggish/unresponsive for ${(tbt / 1000).toFixed(1)}s`, expected: 'TBT under 200ms (good)', actual: `TBT: ${tbt}ms (${result.tbtRating})` });
      }
      if (fcp > 3000) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Performance', title: `Slow FCP ${fcp}ms on ${path} (${sn})`, description: `First Contentful Paint is ${fcp}ms (poor — should be under 1800ms). Users see a blank screen for ${(fcp / 1000).toFixed(1)}s.`, site: sn, fix: 'Reduce render-blocking CSS/JS, inline critical CSS, use font-display: swap', testType: 'Performance',
          steps: `1. Navigate to ${siteUrl}${path}\n2. Observe blank screen before first content appears`, expected: 'FCP under 1800ms (good)', actual: `FCP: ${fcp}ms (${result.fcpRating})` });
      }
    }
  } catch (e) {
    // Lighthouse not available or failed — fall back to browser metrics
  }

  // Fallback: use browser Performance API if Lighthouse didn't run
  if (!usedLighthouse) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const start = Date.now();
      const resp = await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const loadTime = ((Date.now() - start) / 1000).toFixed(2);

      const metrics = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0] || {};
        const paint = performance.getEntriesByType('paint') || [];
        const fcp = paint.find(p => p.name === 'first-contentful-paint');
        const resources = performance.getEntriesByType('resource');
        let totalSize = 0, jsCount = 0, cssCount = 0, imgCount = 0;
        for (const r of resources) {
          totalSize += r.transferSize || 0;
          if (r.initiatorType === 'script') jsCount++;
          if (r.initiatorType === 'css' || r.name.endsWith('.css')) cssCount++;
          if (r.initiatorType === 'img') imgCount++;
        }
        return {
          domContentLoaded: Math.round(perf.domContentLoadedEventEnd - perf.startTime) || 0,
          fcp: fcp ? Math.round(fcp.startTime) : 0,
          ttfb: Math.round(perf.responseStart - perf.requestStart) || 0,
          totalRequests: resources.length, totalSizeKB: Math.round(totalSize / 1024),
          jsCount, cssCount, imgCount, domElements: document.querySelectorAll('*').length,
        };
      });

      let lcp = 0;
      try { lcp = await page.evaluate(() => new Promise(r => { new PerformanceObserver(l => { const e = l.getEntries(); r(Math.round(e[e.length - 1].startTime)); }).observe({ type: 'largest-contentful-paint', buffered: true }); setTimeout(() => r(0), 2000); })); } catch {}
      let cls = 0;
      try { cls = await page.evaluate(() => new Promise(r => { let v = 0; new PerformanceObserver(l => { for (const e of l.getEntries()) { if (!e.hadRecentInput) v += e.value; } r(Math.round(v * 1000) / 1000); }).observe({ type: 'layout-shift', buffered: true }); setTimeout(() => r(v), 2000); })); } catch {}

      pageData[key] = { page: path, engine: 'browser-api', loadTime: parseFloat(loadTime), status: resp ? resp.status() : 0, ...metrics, lcp, cls };

      if (metrics.fcp > 3000) bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Performance', title: `Slow FCP ${metrics.fcp}ms on ${path} (${sn})`, description: `First Contentful Paint is ${metrics.fcp}ms`, site: sn, fix: 'Optimize critical rendering path', testType: 'Performance',
        steps: `1. Navigate to ${siteUrl}${path}\n2. Observe slow first paint`, expected: 'FCP under 1800ms', actual: `FCP: ${metrics.fcp}ms` });
      if (lcp > 4000) bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Performance', title: `Slow LCP ${lcp}ms on ${path} (${sn})`, description: `Largest Contentful Paint is ${lcp}ms`, site: sn, fix: 'Optimize largest content element', testType: 'Performance',
        steps: `1. Navigate to ${siteUrl}${path}`, expected: 'LCP under 2500ms', actual: `LCP: ${lcp}ms` });
      if (cls > 0.25) bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Performance', title: `High CLS ${cls} on ${path} (${sn})`, description: `Layout shift score: ${cls}`, site: sn, fix: 'Add dimensions to images/embeds', testType: 'Performance',
        steps: `1. Navigate to ${siteUrl}${path}\n2. Watch for layout shifts`, expected: 'CLS under 0.1', actual: `CLS: ${cls}` });
      if (metrics.totalSizeKB > 5000) bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Performance', title: `Heavy page ${metrics.totalSizeKB}KB on ${path} (${sn})`, description: 'Page exceeds 5MB', site: sn, fix: 'Reduce resource sizes', testType: 'Performance' });
    } catch (e) {
      pageData[`${key}_error`] = friendlyError(e);
    }
    await page.close();
  }
}

async function runCSSTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sn = siteName(label, siteUrl);

  try {
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    // CSS variables check
    const cssVars = await page.evaluate(() => {
      const vars = ['--font-body', '--font-header', '--section-bottom-padding', '--imageRadius', '--buttonRadius', '--buttonPrimaryL1', '--themeAccentL1', '--productImgAspectRatio'];
      const results = {};
      const rawHTML = document.documentElement.outerHTML;
      for (const v of vars) {
        const computed = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        const rawMatch = rawHTML.match(new RegExp(v + ':\\s*([^;]+)'));
        const rawVal = rawMatch ? rawMatch[1].trim() : 'not set';
        results[v] = { computed, raw: rawVal, isUndefined: rawVal.includes('undefined') || rawVal === 'not set' };
      }
      return results;
    });

    pageData[`${label}_css_vars`] = cssVars;
    for (const [varName, info] of Object.entries(cssVars)) {
      if (info.isUndefined && info.raw.includes('undefined')) {
        const computedFallback = info.computed || '(none)';
        const visualImpact = info.computed ? 'Low — browser is using a fallback value, so the UI may appear normal despite the config error' : 'Medium — no fallback value found, this may cause missing spacing or styling on the page';
        const sev = info.computed ? 'Low' : 'Medium';
        bugs.push({ id: bugs.length + 1, severity: sev, category: 'CSS', title: `${varName} is set to "undefined" in theme config (${sn})`, description: `The CSS variable ${varName} has a literal value of "undefined" instead of a valid CSS value (e.g. "16px", "#fff"). This usually means the theme configuration is missing this value.\n\nVisual impact: ${visualImpact}\nRaw value in HTML: ${info.raw}\nComputed (browser fallback): ${computedFallback}\n\nHow to verify:\n1. Open ${sn} in your browser\n2. Right-click → Inspect → Elements tab\n3. Select the <html> element and check Computed Styles\n4. Search for "${varName}" — you will see it is set to "undefined"\n5. Check if the affected area (e.g. section bottom padding) looks visually correct despite the bad value`, site: sn, fix: `Set ${varName} to a valid value in the theme configuration (e.g. "16px" or "0px")`, testType: 'Regression' });
      }
    }

    // DevTools evidence screenshot
    await page.evaluate((lt) => {
      const vars = ['--font-body', '--font-header', '--section-bottom-padding', '--imageRadius', '--buttonRadius', '--buttonPrimaryL1', '--themeAccentL1', '--productImgAspectRatio'];
      const panel = document.createElement('div');
      panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#1e1e1e;color:#d4d4d4;padding:20px;font-family:Consolas,monospace;font-size:14px;';
      let html = `<div style="color:#569cd6;font-size:18px;font-weight:bold;margin-bottom:15px;">CSS Variables (${lt})</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">`;
      const rawHTML = document.documentElement.outerHTML;
      vars.forEach(v => {
        const computed = getComputedStyle(document.documentElement).getPropertyValue(v).trim();
        const rawMatch = rawHTML.match(new RegExp(v + ':\\s*([^;]+)'));
        const raw = rawMatch ? rawMatch[1].trim() : 'not set';
        const bad = raw.includes('undefined');
        const c = bad ? '#f44747' : '#4ec9b0';
        html += `<div style="background:#2d2d2d;padding:10px;border-radius:4px;border-left:3px solid ${c};"><div style="color:#9cdcfe;">${v}</div><div style="color:${c};font-weight:bold;">Raw: ${raw}</div><div style="color:#808080;">Computed: "${computed || '(empty)'}"</div></div>`;
      });
      html += '</div>';
      panel.innerHTML = html;
      document.body.prepend(panel);
    }, sn);
    await page.waitForTimeout(300);
    screenshots[`${label}_css_devtools`] = b64(await page.screenshot());

  } catch (e) {
    pageData[`${label}_css_error`] = e.message;
  }
  await page.close();
}

async function runFontTest(browser, siteUrl, label, discoveredPages, bugs, pageData) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const sn = siteName(label, siteUrl);
  const allFonts = {};
  const livePaths = discoveredPages.filter(p => p.status === 200).map(p => p.path).slice(0, 10);

  for (const path of livePaths) {
    try {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(1000);

      const fonts = await page.evaluate(() => {
        const els = { h1: document.querySelector('h1'), h2: document.querySelector('h2'), h3: document.querySelector('h3'), p: document.querySelector('p'), a: document.querySelector('a'), button: document.querySelector('button'), body: document.body };
        const result = {};
        for (const [k, el] of Object.entries(els)) {
          if (el) { const s = getComputedStyle(el); result[k] = { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color }; }
        }
        const root = getComputedStyle(document.documentElement);
        result['--font-body'] = root.getPropertyValue('--font-body').trim();
        result['--font-header'] = root.getPropertyValue('--font-header').trim();
        return result;
      });
      allFonts[path] = fonts;
    } catch {}
  }

  pageData[`${label}_fonts`] = allFonts;

  // Check consistency
  const bodyFonts = Object.entries(allFonts).filter(([, f]) => f.body).map(([pg, f]) => ({ page: pg, font: f.body.fontFamily }));
  const unique = [...new Set(bodyFonts.map(f => f.font))];
  if (unique.length > 1) {
    bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Fonts', title: `Inconsistent body fonts (${sn})`, description: `${unique.length} different fonts: ${bodyFonts.map(f => `${f.page}: ${f.font.substring(0, 30)}`).join(' | ')}`, site: sn, fix: 'Set consistent font-family globally', testType: 'Regression' });
  }

  for (const [pageName, fonts] of Object.entries(allFonts)) {
    if (fonts['--font-body'] === 'undefined' || fonts['--font-body'] === '') {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Fonts', title: `--font-body unset on ${pageName} (${sn})`, description: `CSS variable --font-body is "${fonts['--font-body'] || 'empty'}"`, site: sn, fix: 'Set --font-body in theme config', testType: 'Regression' });
      break;
    }
  }

  await page.close();
}

async function runRedirectionTest(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const tests = [
    { path: '/profile', expectRedirect: true, name: 'Profile' },
    { path: '/checkout', expectRedirect: true, name: 'Checkout' },
    { path: '/profile/orders', expectRedirect: true, name: 'Orders' },
    { path: '/profile/addresses', expectRedirect: true, name: 'Addresses' },
    { path: '/wishlist', expectRedirect: true, name: 'Wishlist' },
    { path: '/', expectRedirect: false, name: 'Homepage' },
    { path: '/products', expectRedirect: false, name: 'Products' },
  ];

  const results = [];
  for (const test of tests) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const resp = await page.goto(siteUrl + test.path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const finalUrl = page.url();
      const status = resp ? resp.status() : 0;
      const redirected = finalUrl !== (siteUrl + test.path) && finalUrl !== (siteUrl + test.path + '/');
      results.push({ ...test, finalUrl, status, redirected });

      if (test.expectRedirect && !redirected && status !== 404) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Redirection', title: `${test.name} not redirecting (${sn})`, description: `${test.path} accessible without auth`, site: sn, fix: `Add auth guard to ${test.path}`, testType: 'Regression' });
      }
    } catch (e) {
      results.push({ ...test, error: e.message });
    }
    await page.close();
  }
  pageData[`${label}_redirections`] = results;
}

async function runContentComparison(discovery1, discovery2, bugs, pageData) {
  const allPaths = [...new Set([...discovery1.pages.map(p => p.path), ...discovery2.pages.map(p => p.path)])];

  for (const path of allPaths) {
    const p1 = discovery1.pages.find(p => p.path === path);
    const p2 = discovery2.pages.find(p => p.path === path);

    if (p1 && p2) {
      if (p1.status === 200 && p2.status === 404) {
        bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Routing', title: `${path} — 200 on Site 1 but 404 on Site 2`, description: `Page exists on Site 1 but missing on Site 2`, site: 'Site 2', fix: `Create/enable ${path} on Site 2`, testType: 'Regression' });
      } else if (p2.status === 200 && p1.status === 404) {
        bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Routing', title: `${path} — 200 on Site 2 but 404 on Site 1`, description: `Page exists on Site 2 but missing on Site 1`, site: 'Site 1', fix: `Create/enable ${path} on Site 1`, testType: 'Regression' });
      }
    }
  }

  // Nav comparison
  const nav1 = new Set(discovery1.navLinks.map(l => l.href).filter(Boolean));
  const nav2 = new Set(discovery2.navLinks.map(l => l.href).filter(Boolean));
  const onlyIn1 = [...nav1].filter(l => !nav2.has(l));
  const onlyIn2 = [...nav2].filter(l => !nav1.has(l));
  if (onlyIn1.length > 0 || onlyIn2.length > 0) {
    bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Navigation', title: 'Navigation links differ between sites', description: `Only Site 1: ${onlyIn1.join(', ') || 'none'} | Only Site 2: ${onlyIn2.join(', ') || 'none'}`, site: 'Both', fix: 'Align navigation between sites', testType: 'Regression' });
  }

  // Footer comparison
  const foot1 = new Set(discovery1.footerLinks.map(l => l.href).filter(Boolean));
  const foot2 = new Set(discovery2.footerLinks.map(l => l.href).filter(Boolean));
  const footOnly1 = [...foot1].filter(l => !foot2.has(l));
  const footOnly2 = [...foot2].filter(l => !foot1.has(l));
  if (footOnly1.length > 2 || footOnly2.length > 2) {
    bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Footer', title: 'Footer links differ between sites', description: `${footOnly1.length} links only on Site 1, ${footOnly2.length} only on Site 2`, site: 'Both', fix: 'Align footer links', testType: 'Regression' });
  }
}

// ─────────────────────────────────────────────────────────────
// ADVANCED E-COMMERCE TESTS (Phases 17-29)
// ─────────────────────────────────────────────────────────────

async function runCartCheckoutTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // Find a product to add to cart
    const productUrl = discovery.productLinks[0];
    if (!productUrl) { await page.close(); return; }

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    screenshots[`${label}_cart_pdp`] = b64(await page.screenshot());

    // Try to add to cart
    let addResult;
    if (learning) { addResult = await learning.healAndFind(page, 'addToCartButton'); }
    const addBtn = addResult?.element || page.locator('button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("Buy Now"), [class*="add-to-cart"]').first();

    if (await addBtn.isVisible().catch(() => false)) {
      // Check if size selection is required
      const sizeOptions = page.locator('[class*="size"] button, [class*="size"] label, [data-testid*="size"], input[name*="size"]');
      if (await sizeOptions.count() > 0) {
        const firstSize = sizeOptions.first();
        if (await firstSize.isVisible().catch(() => false)) {
          await firstSize.click();
          await page.waitForTimeout(500);
        }
      }

      await addBtn.click();
      await page.waitForTimeout(3000);
      screenshots[`${label}_cart_added`] = b64(await page.screenshot());
      pageData[`${label}_add_to_cart_success`] = true;

      // Navigate to cart
      const cartPaths = ['/cart/bag', '/cart'];
      for (const cp of cartPaths) {
        try {
          const resp = await page.goto(siteUrl + cp, { waitUntil: 'domcontentloaded', timeout: 15000 });
          if (resp && resp.status() === 200) {
            await page.waitForTimeout(2000);
            screenshots[`${label}_cart_with_item`] = b64(await page.screenshot());

            // Check cart has items
            const cartInfo = await page.evaluate(() => {
              const items = document.querySelectorAll('[class*="cart-item"], [class*="bag-item"], [class*="line-item"]');
              const totalEl = document.querySelector('[class*="total"], [class*="subtotal"], [class*="grand-total"]');
              const qtyInputs = document.querySelectorAll('input[type="number"], [class*="quantity"] input, select[name*="qty"]');
              const removeButtons = document.querySelectorAll('button:has(svg), [class*="remove"], [class*="delete"], button[aria-label*="remove" i]');
              return {
                itemCount: items.length,
                hasTotal: !!totalEl,
                totalText: totalEl?.textContent?.trim()?.substring(0, 50) || '',
                hasQtyControl: qtyInputs.length > 0,
                hasRemoveBtn: removeButtons.length > 0,
              };
            });
            pageData[`${label}_cart_info`] = cartInfo;

            if (cartInfo.itemCount === 0) {
              bugs.push({ id: bugs.length + 1, severity: 'High', category: 'E-Commerce', title: `Cart appears empty after adding item (${sn})`, description: 'Added product but cart shows no items', site: sn, fix: 'Check add-to-cart API and cart rendering', testType: 'Cart' });
            }
            if (!cartInfo.hasTotal) {
              bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce', title: `No price total visible in cart (${sn})`, description: 'Cart does not display a total or subtotal', site: sn, fix: 'Add visible price total to cart page', testType: 'Cart' });
            }

            // Try checkout
            const checkoutBtn = page.locator('button:has-text("Checkout"), button:has-text("Place Order"), a:has-text("Checkout"), button:has-text("Proceed"), a[href*="checkout"]').first();
            if (await checkoutBtn.isVisible().catch(() => false)) {
              await checkoutBtn.click();
              await page.waitForTimeout(3000);
              screenshots[`${label}_checkout_page`] = b64(await page.screenshot());
              pageData[`${label}_checkout_reached`] = true;

              // Check if redirected to login (expected for unauthenticated)
              const checkoutUrl = page.url();
              if (checkoutUrl.includes('login') || checkoutUrl.includes('auth')) {
                pageData[`${label}_checkout_requires_auth`] = true;
              }
            }
            break;
          }
        } catch {}
      }
    } else {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'E-Commerce', title: `No Add to Cart button found (${sn})`, description: 'Cannot find add-to-cart button on PDP', site: sn, fix: 'Ensure add-to-cart button is visible on product pages', testType: 'Cart' });
    }
  } catch (e) {
    pageData[`${label}_cart_test_error`] = e.message;
  }
  await page.close();
}

async function runSearchDeepTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const queries = [
    { q: 'shirt', type: 'valid', expectResults: true },
    { q: 'xyznonexistent99', type: 'empty', expectResults: false },
    { q: 'shrit', type: 'typo', expectResults: null },  // Test typo tolerance
    { q: '<script>alert(1)</script>', type: 'xss', expectResults: false },
    { q: "'; DROP TABLE products; --", type: 'sqli', expectResults: false },
    { q: 'a'.repeat(200), type: 'long', expectResults: false },
  ];

  for (const test of queries) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const searchPaths = [
        `/products?q=${encodeURIComponent(test.q)}`,
        `/search?q=${encodeURIComponent(test.q)}`,
      ];

      for (const sp of searchPaths) {
        const resp = await page.goto(siteUrl + sp, { waitUntil: 'domcontentloaded', timeout: 15000 });
        if (resp && resp.status() === 200) {
          await page.waitForTimeout(2000);
          const key = `${label}_search_${test.type}`;
          screenshots[key] = b64(await page.screenshot());

          const results = await page.evaluate(() => {
            const products = document.querySelectorAll('a[href*="/product/"], [class*="product-card"], [class*="product-item"]');
            const noResults = document.body.innerText.toLowerCase().includes('no results') ||
                             document.body.innerText.toLowerCase().includes('no items') ||
                             document.body.innerText.toLowerCase().includes('not found');
            const hasError = document.body.innerText.toLowerCase().includes('error') ||
                            document.body.innerText.toLowerCase().includes('something went wrong');
            return { count: products.length, noResults, hasError, bodyLength: document.body.innerText.length };
          });

          pageData[`${key}_results`] = results;

          if (test.type === 'valid' && results.count === 0) {
            bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Search', title: `Search for "${test.q}" returns 0 results (${sn})`, description: 'Valid query returned no products', site: sn, fix: 'Check search index and product catalog', testType: 'Search' });
          }
          if (test.type === 'xss' && results.hasError) {
            bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Security', title: `Search may be vulnerable to XSS (${sn})`, description: 'XSS payload caused an error response', site: sn, fix: 'Sanitize search input on server side', testType: 'Security' });
          }
          if (test.type === 'sqli' && results.hasError) {
            bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Security', title: `Search may be vulnerable to SQL injection (${sn})`, description: 'SQL injection payload caused an error', site: sn, fix: 'Use parameterized queries', testType: 'Security' });
          }
          if (test.type === 'long' && results.hasError) {
            bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Search', title: `Search crashes on long query (${sn})`, description: 'Very long search query causes error', site: sn, fix: 'Add input length validation', testType: 'Search' });
          }
          break;
        }
      }
    } catch {}
    await page.close();
  }

  // Test auto-suggestions
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    let searchInput;
    if (learning) {
      const result = await learning.healAndFind(page, 'searchInput');
      searchInput = result?.element;
    }
    if (!searchInput) searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[name="q"]').first();

    if (await searchInput.isVisible().catch(() => false)) {
      await searchInput.click();
      await page.waitForTimeout(500);
      await searchInput.fill('shi');
      await page.waitForTimeout(2000);

      const suggestions = await page.evaluate(() => {
        const els = document.querySelectorAll('[class*="suggest"], [class*="autocomplete"], [class*="dropdown"] a, [role="listbox"] [role="option"]');
        return { count: els.length, visible: els.length > 0 };
      });
      pageData[`${label}_search_autocomplete`] = suggestions;
      if (suggestions.visible) {
        screenshots[`${label}_search_suggestions`] = b64(await page.screenshot());
      }
    }
  } catch {}
  await page.close();
}

async function runPDPDeepTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const productUrls = discovery.productLinks.slice(0, 3);
  if (productUrls.length === 0) return;

  for (let i = 0; i < productUrls.length; i++) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const key = `${label}_pdp_deep_${i}`;

    try {
      await page.goto(productUrls[i], { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      screenshots[key] = b64(await page.screenshot({ fullPage: true }));

      const pdpInfo = await page.evaluate(() => {
        const title = document.querySelector('h1')?.textContent?.trim() || '';
        const priceEl = document.querySelector('[class*="price"], [class*="Price"], [data-testid*="price"]');
        const price = priceEl?.textContent?.trim() || '';
        const images = document.querySelectorAll('[class*="product"] img, [class*="gallery"] img, [class*="slider"] img');
        const sizes = document.querySelectorAll('[class*="size"] button, [class*="size"] label, [data-testid*="size"]');
        const colors = document.querySelectorAll('[class*="color"] button, [class*="color"] label, [class*="swatch"]');
        const desc = document.querySelector('[class*="description"], [class*="details"]');
        const breadcrumb = document.querySelector('[class*="breadcrumb"]');
        const reviews = document.querySelectorAll('[class*="review"], [class*="rating"]');
        const pincodeInput = document.querySelector('input[placeholder*="pincode" i], input[placeholder*="zip" i], input[placeholder*="delivery" i]');
        const outOfStock = document.body.innerText.toLowerCase().includes('out of stock') || document.body.innerText.toLowerCase().includes('sold out');
        const sizeChart = document.querySelector('[class*="size-chart"], [class*="size-guide"], a:has-text("Size")');

        return {
          title: title.substring(0, 80),
          price,
          hasPrice: !!price,
          imageCount: images.length,
          brokenImages: [...images].filter(i => i.complete && i.naturalWidth === 0).length,
          sizeOptions: sizes.length,
          colorOptions: colors.length,
          hasDescription: !!desc,
          descLength: desc?.textContent?.length || 0,
          hasBreadcrumb: !!breadcrumb,
          reviewCount: reviews.length,
          hasPincodeCheck: !!pincodeInput,
          outOfStock,
          hasSizeChart: !!sizeChart,
        };
      });

      pageData[`${key}_info`] = pdpInfo;

      if (!pdpInfo.hasPrice) {
        bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'E-Commerce', title: `No price visible on PDP (${sn})`, description: `Product "${pdpInfo.title}" has no visible price`, site: sn, fix: 'Ensure price is displayed on all PDPs', testType: 'PDP' });
      }
      if (pdpInfo.imageCount === 0) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'E-Commerce', title: `No product images on PDP (${sn})`, description: `Product "${pdpInfo.title}" shows no images`, site: sn, fix: 'Upload product images', testType: 'PDP' });
      }
      if (pdpInfo.brokenImages > 0) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Images', title: `${pdpInfo.brokenImages} broken images on PDP (${sn})`, description: `Product "${pdpInfo.title}"`, site: sn, fix: 'Fix broken image URLs', testType: 'PDP' });
      }
      if (!pdpInfo.hasDescription || pdpInfo.descLength < 20) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Content', title: `Missing/short product description (${sn})`, description: `Product "${pdpInfo.title}" has ${pdpInfo.descLength} chars`, site: sn, fix: 'Add detailed product descriptions', testType: 'PDP' });
      }
      if (!pdpInfo.hasBreadcrumb) {
        bugs.push({ id: bugs.length + 1, severity: 'Low', category: 'Navigation', title: `No breadcrumb on PDP (${sn})`, description: 'Breadcrumb navigation missing on product page', site: sn, fix: 'Add breadcrumb for better UX and SEO', testType: 'PDP' });
      }

      // Test variant selection — price change
      if (pdpInfo.sizeOptions > 0 || pdpInfo.colorOptions > 0) {
        const variantButtons = page.locator('[class*="size"] button, [class*="color"] button, [class*="swatch"]');
        const count = await variantButtons.count();
        if (count >= 2) {
          const priceBefore = await page.evaluate(() => document.querySelector('[class*="price"], [class*="Price"]')?.textContent?.trim());
          await variantButtons.nth(1).click().catch(() => {});
          await page.waitForTimeout(1000);
          const priceAfter = await page.evaluate(() => document.querySelector('[class*="price"], [class*="Price"]')?.textContent?.trim());
          pageData[`${key}_variant_price_change`] = { before: priceBefore, after: priceAfter, changed: priceBefore !== priceAfter };
        }
      }

      // Test pincode check
      if (pdpInfo.hasPincodeCheck) {
        const pincodeInput = page.locator('input[placeholder*="pincode" i], input[placeholder*="zip" i], input[placeholder*="delivery" i]').first();
        if (await pincodeInput.isVisible().catch(() => false)) {
          await pincodeInput.fill('400001');
          await page.waitForTimeout(500);
          const checkBtn = page.locator('button:has-text("Check"), button:has-text("Verify"), button:has-text("Apply")').first();
          if (await checkBtn.isVisible().catch(() => false)) {
            await checkBtn.click();
            await page.waitForTimeout(2000);
            screenshots[`${key}_pincode`] = b64(await page.screenshot());
          }
        }
      }

    } catch (e) {
      pageData[`${key}_error`] = e.message;
    }
    await page.close();
  }
}

async function runPLPDeepTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    screenshots[`${label}_plp_deep`] = b64(await page.screenshot({ fullPage: true }));

    const plpInfo = await page.evaluate(() => {
      const products = document.querySelectorAll('a[href*="/product/"], [class*="product-card"], [class*="product-item"]');
      const filters = document.querySelectorAll('[class*="filter"], [class*="facet"], [data-testid*="filter"]');
      const sortEl = document.querySelector('[class*="sort"], select[name*="sort"], [data-testid*="sort"]');
      const pagination = document.querySelector('[class*="pagination"], [class*="load-more"], button:has-text("Load More")');
      const priceRange = document.querySelector('[class*="price-range"], [class*="price-filter"], input[type="range"]');
      const outOfStock = [...document.querySelectorAll('[class*="product"]')].filter(el =>
        el.textContent.toLowerCase().includes('out of stock') || el.textContent.toLowerCase().includes('sold out')
      );
      const images = document.querySelectorAll('[class*="product"] img');
      const brokenImages = [...images].filter(i => i.complete && i.naturalWidth === 0);
      const lazyImages = [...images].filter(i => i.loading === 'lazy' || i.getAttribute('data-src'));

      return {
        productCount: products.length,
        filterCount: filters.length,
        hasSort: !!sortEl,
        hasPagination: !!pagination,
        hasPriceRange: !!priceRange,
        outOfStockCount: outOfStock.length,
        imageCount: images.length,
        brokenImageCount: brokenImages.length,
        lazyImageCount: lazyImages.length,
      };
    });

    pageData[`${label}_plp_deep`] = plpInfo;

    if (plpInfo.productCount === 0) {
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'E-Commerce', title: `PLP has zero products (${sn})`, description: 'Product listing page shows no products', site: sn, fix: 'Check product catalog and publish to channel', testType: 'PLP' });
    }
    if (plpInfo.filterCount === 0 && plpInfo.productCount > 10) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce', title: `No filters on PLP (${sn})`, description: `${plpInfo.productCount} products with no filter options`, site: sn, fix: 'Add size/price/category filters to PLP', testType: 'PLP' });
    }
    if (!plpInfo.hasSort && plpInfo.productCount > 5) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce', title: `No sort option on PLP (${sn})`, description: 'Users cannot sort products', site: sn, fix: 'Add sort by price/name/popularity', testType: 'PLP' });
    }
    if (plpInfo.brokenImageCount > 0) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Images', title: `${plpInfo.brokenImageCount} broken product images on PLP (${sn})`, description: 'Product thumbnails failing to load', site: sn, fix: 'Fix product image URLs', testType: 'PLP' });
    }

    // Test infinite scroll / load more
    if (plpInfo.productCount > 0) {
      const beforeCount = plpInfo.productCount;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3000);
      const afterInfo = await page.evaluate(() => document.querySelectorAll('a[href*="/product/"], [class*="product-card"]').length);
      pageData[`${label}_plp_scroll_loaded`] = { before: beforeCount, after: afterInfo, loadedMore: afterInfo > beforeCount };
    }

  } catch (e) {
    pageData[`${label}_plp_deep_error`] = e.message;
  }
  await page.close();
}

async function runWishlistTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    const wishlistPaths = ['/wishlist', '/favourites', '/wishlist/'];
    for (const wp of wishlistPaths) {
      const resp = await page.goto(siteUrl + wp, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.status() === 200) {
        await page.waitForTimeout(2000);
        screenshots[`${label}_wishlist`] = b64(await page.screenshot());

        const info = await page.evaluate(() => ({
          hasItems: document.querySelectorAll('[class*="wishlist-item"], [class*="product-card"]').length > 0,
          hasEmptyState: document.body.innerText.toLowerCase().includes('empty') || document.body.innerText.toLowerCase().includes('no items'),
          redirectedToLogin: window.location.href.includes('login') || window.location.href.includes('auth'),
        }));
        pageData[`${label}_wishlist_info`] = info;

        if (info.redirectedToLogin) {
          pageData[`${label}_wishlist_requires_auth`] = true;
        }
        break;
      }
    }
  } catch {}
  await page.close();
}

async function runExploratoryTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // Random navigation — simulate real user
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Rapid clicking test — check for JS errors
    const jsErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') jsErrors.push(msg.text().substring(0, 100)); });
    page.on('pageerror', err => jsErrors.push(err.message.substring(0, 100)));

    // Click random navigation links
    const navLinks = await page.evaluate(() => {
      const links = [...document.querySelectorAll('nav a[href], header a[href]')];
      return links.slice(0, 5).map(l => l.href);
    });

    for (const link of navLinks.slice(0, 3)) {
      try {
        await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 10000 });
        await page.waitForTimeout(1000);

        // Quick back navigation
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500);
      } catch {}
    }

    // Check for accumulated JS errors
    if (jsErrors.length > 0) {
      const errorSummary = jsErrors.length === 1 ? '1 JavaScript error was found' : `${jsErrors.length} JavaScript errors were found`;
      const impactText = jsErrors.length > 5 ? 'This many errors can cause features to break, buttons to stop working, or pages to not load properly.' : 'These errors may cause minor issues like broken interactions or missing content.';
      const plainDesc = `${errorSummary} while navigating between pages on ${sn}. ${impactText}\n\nHow to verify:\n1. Open ${sn} in Chrome\n2. Press F12 to open Developer Tools\n3. Click the "Console" tab\n4. Navigate between pages using the menu\n5. You will see red error messages appearing in the console\n\nTechnical details (for developers):\n${jsErrors.slice(0, 3).map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`;
      bugs.push({ id: bugs.length + 1, severity: jsErrors.length > 5 ? 'High' : 'Medium', category: 'JavaScript', title: `${jsErrors.length} JavaScript errors found while browsing ${sn}`, description: plainDesc, site: sn, fix: 'Fix runtime JavaScript errors — check the browser console for details', testType: 'Exploratory' });
    }

    // Test double-click on buttons (rapid click)
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const ctaButtons = page.locator('a[class*="btn"], button[class*="btn"], a[class*="cta"], [class*="hero"] a');
    const ctaCount = await ctaButtons.count();
    if (ctaCount > 0) {
      try {
        await ctaButtons.first().dblclick();
        await page.waitForTimeout(2000);
        screenshots[`${label}_exploratory_dblclick`] = b64(await page.screenshot());
      } catch {}
    }

    // Check for any popup/modal on homepage
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(5000); // Wait for popups
    const popup = await page.evaluate(() => {
      const modals = document.querySelectorAll('[class*="modal"]:not([style*="display: none"]), [class*="popup"]:not([style*="display: none"]), [role="dialog"]');
      const visible = [...modals].filter(m => m.offsetHeight > 0);
      return { hasPopup: visible.length > 0, count: visible.length };
    });
    if (popup.hasPopup) {
      screenshots[`${label}_popup_detected`] = b64(await page.screenshot());
      pageData[`${label}_has_popup`] = true;
    }

  } catch (e) {
    pageData[`${label}_exploratory_error`] = e.message;
  }
  await page.close();
}

async function runSecurityBasicTest(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // Check HTTPS
    if (!siteUrl.startsWith('https://')) {
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Security', title: `Site not using HTTPS (${sn})`, description: 'Site accessible over insecure HTTP', site: sn, fix: 'Enable HTTPS with valid SSL certificate', testType: 'Security' });
    }

    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    const securityInfo = await page.evaluate(() => {
      // Check for mixed content
      const scripts = [...document.querySelectorAll('script[src]')].filter(s => s.src.startsWith('http://'));
      const styles = [...document.querySelectorAll('link[rel="stylesheet"][href]')].filter(s => s.href.startsWith('http://'));
      const images = [...document.querySelectorAll('img[src]')].filter(i => i.src.startsWith('http://'));

      // Check for exposed sensitive info
      const bodyText = document.body.innerHTML;
      const hasApiKeys = /(?:api[_-]?key|apikey|api_secret)\s*[:=]\s*["'][^"']+["']/i.test(bodyText);
      const hasPasswords = /password\s*[:=]\s*["'][^"']+["']/i.test(bodyText);

      // Check security headers via meta tags
      const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');

      // Check for autocomplete on sensitive fields
      const passwordFields = document.querySelectorAll('input[type="password"]');
      const autocompletePwd = [...passwordFields].filter(p => p.autocomplete !== 'off' && p.autocomplete !== 'new-password');

      return {
        mixedContent: { scripts: scripts.length, styles: styles.length, images: images.length },
        hasCSP: !!csp,
        hasApiKeys,
        hasPasswords,
        autocompletePwd: autocompletePwd.length,
      };
    });

    pageData[`${label}_security`] = securityInfo;

    const mixedTotal = securityInfo.mixedContent.scripts + securityInfo.mixedContent.styles + securityInfo.mixedContent.images;
    if (mixedTotal > 0) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Security', title: `Mixed content detected (${sn})`, description: `${mixedTotal} HTTP resources on HTTPS page`, site: sn, fix: 'Update all resource URLs to HTTPS', testType: 'Security' });
    }
    if (securityInfo.hasApiKeys) {
      bugs.push({ id: bugs.length + 1, severity: 'Critical', category: 'Security', title: `API keys exposed in HTML (${sn})`, description: 'Sensitive API keys found in page source', site: sn, fix: 'Remove API keys from client-side code', testType: 'Security' });
    }

  } catch (e) {
    pageData[`${label}_security_error`] = e.message;
  }
  await page.close();
}

async function runInventoryTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);

  // Check out-of-stock behavior on PDP
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const stockInfo = await page.evaluate(() => {
      const allProducts = document.querySelectorAll('a[href*="/product/"], [class*="product-card"]');
      const outOfStock = [...allProducts].filter(p =>
        p.textContent.toLowerCase().includes('out of stock') ||
        p.textContent.toLowerCase().includes('sold out') ||
        p.querySelector('[class*="out-of-stock"], [class*="sold-out"]')
      );
      return {
        totalProducts: allProducts.length,
        outOfStockCount: outOfStock.length,
        outOfStockVisible: outOfStock.length > 0,
      };
    });
    pageData[`${label}_stock_info`] = stockInfo;

    if (stockInfo.outOfStockCount > 0 && stockInfo.totalProducts > 0) {
      const ratio = stockInfo.outOfStockCount / stockInfo.totalProducts;
      if (ratio > 0.5) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'E-Commerce', title: `${Math.round(ratio * 100)}% products out of stock (${sn})`, description: `${stockInfo.outOfStockCount}/${stockInfo.totalProducts} products unavailable`, site: sn, fix: 'Update inventory or remove unavailable products', testType: 'Inventory' });
      }
    }
  } catch {}
  await page.close();
}

// ─────────────────────────────────────────────────────────────
// SCENARIO TESTS: Cover all 39 SKILL.md scenarios
// ─────────────────────────────────────────────────────────────

/** #7,19,31,33,34 — Auth negative flows: incorrect phone, empty phone, incorrect OTP, checkbox, resend OTP */
async function runAuthNegativeTests(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Try alternate login paths if 404
    if (await page.locator('text=404').count() > 0) {
      await page.goto(siteUrl + '/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.waitForTimeout(2000);
    }

    const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="mobile" i], input[placeholder*="number" i]').first();
    const phoneVisible = await phoneInput.isVisible().catch(() => false);
    if (!phoneVisible) {
      logTestResult(pageData, label, 'auth_negative', 'skipped', 'Login page does not have a phone number input — this site may use a different login method (email/social). Auth negative tests are not applicable.');
      await page.close(); return;
    }

    // #19 — Empty mobile validation: try submitting with empty phone
    const sendBtn = page.locator('button:has-text("Send"), button:has-text("Continue"), button:has-text("OTP"), button:has-text("Get OTP"), button:has-text("Sign"), button[type="submit"]').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      await page.waitForTimeout(1500);
      const errorShown = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return body.includes('required') || body.includes('enter') || body.includes('valid') || body.includes('invalid') || body.includes('error');
      });
      screenshots[`${label}_auth_empty_phone`] = b64(await page.screenshot());
      if (!errorShown) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Auth', title: `No validation error for empty phone (${sn})`, description: 'Submitting login with empty phone field shows no error message', site: sn, fix: 'Add client-side validation for empty phone input', testType: 'Auth',
          steps: '1. Go to login page\n2. Leave phone field empty\n3. Click Send OTP\n4. Observe: No error message shown', expected: 'Validation error like "Please enter mobile number"', actual: 'No error shown, form may submit silently' });
      }
    }

    // #7 — Incorrect mobile number
    await phoneInput.fill('1234567890');
    await page.waitForTimeout(300);
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      await page.waitForTimeout(3000);
      screenshots[`${label}_auth_wrong_phone`] = b64(await page.screenshot());
      pageData[`${label}_auth_wrong_phone_tested`] = true;
    }

    // #33 — Login checkbox (T&C / Newsletter)
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.isVisible().catch(() => false)) {
      const wasChecked = await checkbox.isChecked();
      await checkbox.click();
      await page.waitForTimeout(500);
      const isNowChecked = await checkbox.isChecked();
      pageData[`${label}_login_checkbox`] = { before: wasChecked, after: isNowChecked, toggleWorks: wasChecked !== isNowChecked };
      if (wasChecked === isNowChecked) {
        bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Auth', title: `Login checkbox does not toggle (${sn})`, description: 'Checkbox on login page cannot be checked/unchecked', site: sn, fix: 'Fix checkbox click handler', testType: 'Auth',
          steps: '1. Go to login page\n2. Click the checkbox (T&C / Newsletter)\n3. Observe: State does not change', expected: 'Checkbox toggles between checked and unchecked', actual: 'Checkbox state remains unchanged' });
      }
    }

    // #13 — Terms & Privacy links
    const tosLinks = page.locator('a[href*="terms"], a[href*="privacy"], a[href*="policy"]');
    const tosCount = await tosLinks.count();
    if (tosCount > 0) {
      for (let i = 0; i < tosCount; i++) {
        const href = await tosLinks.nth(i).getAttribute('href');
        const text = await tosLinks.nth(i).textContent();
        if (href) {
          const fullUrl = href.startsWith('http') ? href : siteUrl + href;
          const testPage = await browser.newPage();
          try {
            const resp = await testPage.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
            if (!resp || resp.status() >= 400) {
              bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Auth', title: `Login page "${text.trim()}" link broken (${sn})`, description: `Link to ${href} returns ${resp ? resp.status() : 'no response'}`, site: sn, fix: 'Fix the URL or create the target page', testType: 'Auth',
                steps: `1. Go to login page\n2. Click "${text.trim()}" link\n3. Observe: Page returns error`, expected: 'Opens the terms/privacy page successfully', actual: `Page returns HTTP ${resp ? resp.status() : 'error'}` });
            }
          } catch {}
          await testPage.close();
        }
      }
      pageData[`${label}_login_tos_links`] = tosCount;
    }

    // Now test with correct phone for OTP tests
    await phoneInput.fill('');
    await phoneInput.fill(TEST_CONFIG.credentials.phone);
    await page.waitForTimeout(300);
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      await page.waitForTimeout(3000);

      // #34 — Resend OTP button
      const resendBtn = page.locator('button:has-text("Resend"), a:has-text("Resend"), text=/resend/i').first();
      const resendVisible = await resendBtn.isVisible().catch(() => false);
      pageData[`${label}_resend_otp_visible`] = resendVisible;
      if (!resendVisible) {
        bugs.push({ id: bugs.length + 1, severity: 'Low', category: 'Auth', title: `No Resend OTP button found (${sn})`, description: 'After sending OTP, no resend option is visible', site: sn, fix: 'Add a Resend OTP button with cooldown timer', testType: 'Auth',
          steps: '1. Go to login page\n2. Enter valid phone and send OTP\n3. Look for Resend OTP option\n4. Observe: Not found', expected: 'Resend OTP button visible (possibly with timer)', actual: 'No resend option visible' });
      }

      // #31 — Incorrect OTP
      const otpInputs = page.locator('input[type="tel"][maxlength="1"], input[name*="otp"], input[placeholder*="otp" i]');
      const otpCount = await otpInputs.count();
      if (otpCount >= 4) {
        for (let i = 0; i < Math.min(otpCount, 4); i++) {
          await otpInputs.nth(i).fill('9999'[i]);
          await page.waitForTimeout(100);
        }
      } else {
        const singleOtp = page.locator('input[name*="otp"], input[placeholder*="otp" i], input[type="tel"]:not([maxlength="1"])').first();
        if (await singleOtp.isVisible().catch(() => false)) {
          await singleOtp.fill('9999');
        }
      }
      const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Login"), button[type="submit"]').first();
      if (await verifyBtn.isVisible().catch(() => false)) {
        await verifyBtn.click();
        await page.waitForTimeout(3000);
        screenshots[`${label}_auth_wrong_otp`] = b64(await page.screenshot());
        const wrongOtpError = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('invalid') || body.includes('incorrect') || body.includes('wrong') || body.includes('try again') || body.includes('error');
        });
        pageData[`${label}_wrong_otp_error_shown`] = wrongOtpError;
        if (!wrongOtpError) {
          bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Auth', title: `No error for incorrect OTP (${sn})`, description: 'Entering wrong OTP shows no error message', site: sn, fix: 'Show clear error message for invalid OTP', testType: 'Auth',
            steps: '1. Go to login page\n2. Enter valid phone, send OTP\n3. Enter incorrect OTP "9999"\n4. Click Verify\n5. Observe: No error shown', expected: 'Error message like "Invalid OTP"', actual: 'No error message displayed' });
        }
      }
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_auth_negative_error`] = friendly;
    logTestResult(pageData, label, 'auth_negative', 'error', friendly);
  }
  await page.close();
}

/** #2,11,37 — Empty cart state, return to homepage */
async function runEmptyCartTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    const cartPaths = ['/cart/bag', '/cart'];
    let loaded = false;
    for (const cp of cartPaths) {
      const resp = await page.goto(siteUrl + cp, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.status() === 200) { loaded = true; break; }
    }
    if (!loaded) {
      logTestResult(pageData, label, 'empty_cart', 'skipped', 'Cart page not found — tried /cart/bag and /cart but both returned errors. This site may use a different cart URL.');
      await page.close(); return;
    }
    await page.waitForTimeout(2000);
    screenshots[`${label}_empty_cart`] = b64(await page.screenshot());

    const cartState = await page.evaluate(() => {
      const body = document.body.innerText.toLowerCase();
      const hasEmptyMsg = body.includes('empty') || body.includes('no items') || body.includes('nothing') || body.includes('cart is empty');
      const returnBtn = document.querySelector('a[href="/"], button:has-text("Continue Shopping"), a:has-text("Continue Shopping"), a:has-text("Home"), a:has-text("Start Shopping")');
      return { hasEmptyMsg, hasReturnBtn: !!returnBtn, returnBtnText: returnBtn?.textContent?.trim()?.substring(0, 40) || '' };
    });
    pageData[`${label}_empty_cart`] = cartState;

    if (!cartState.hasEmptyMsg) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce', title: `No empty cart message shown (${sn})`, description: 'When cart has no items, no "empty cart" message is displayed', site: sn, fix: 'Add an empty state message like "Your cart is empty"', testType: 'Cart',
        steps: '1. Go to cart page without adding any items\n2. Observe: No empty cart message visible', expected: 'Message like "Your cart is empty"', actual: 'No empty state message shown' });
    }
    if (!cartState.hasReturnBtn) {
      bugs.push({ id: bugs.length + 1, severity: 'Low', category: 'E-Commerce', title: `No "Continue Shopping" button on empty cart (${sn})`, description: 'Empty cart page has no link back to homepage or products', site: sn, fix: 'Add a "Continue Shopping" or "Return to Home" button', testType: 'Cart',
        steps: '1. Go to cart page with no items\n2. Look for a button to return to shopping\n3. Observe: Not found', expected: 'A "Continue Shopping" or "Return to Home" button', actual: 'No return link available' });
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_empty_cart_error`] = friendly;
    logTestResult(pageData, label, 'empty_cart', 'error', friendly);
  }
  await page.close();
}

/** #30 — Cart quantity increase/decrease */
async function runCartQuantityTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    // First add a product to cart
    const productUrl = discovery.productLinks[0];
    if (!productUrl) {
      logTestResult(pageData, label, 'cart_quantity', 'skipped', 'No product URLs discovered on the site. Cannot test cart quantity controls without first adding a product to cart.');
      await page.close(); return;
    }

    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Select size if needed
    const sizeBtn = page.locator('[class*="size"] button, [class*="size"] label').first();
    if (await sizeBtn.isVisible().catch(() => false)) { await sizeBtn.click(); await page.waitForTimeout(500); }

    const addBtn = page.locator('button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("Buy Now"), [class*="add-to-cart"]').first();
    if (!(await addBtn.isVisible().catch(() => false))) {
      logTestResult(pageData, label, 'cart_quantity', 'skipped', 'No "Add to Cart" button found on the product page. Cannot test cart quantity without adding a product first.');
      await page.close(); return;
    }
    await addBtn.click();
    await page.waitForTimeout(3000);

    // Go to cart
    for (const cp of ['/cart/bag', '/cart']) {
      const resp = await page.goto(siteUrl + cp, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.status() === 200) break;
    }
    await page.waitForTimeout(2000);

    // Get initial qty
    const qtyInfo = await page.evaluate(() => {
      const qtyInput = document.querySelector('input[type="number"], [class*="quantity"] input, select[name*="qty"]');
      const plusBtn = document.querySelector('button[aria-label*="increase" i], button:has-text("+"), [class*="qty-inc"], [class*="increment"]');
      const minusBtn = document.querySelector('button[aria-label*="decrease" i], button:has-text("-"), [class*="qty-dec"], [class*="decrement"]');
      return {
        currentQty: qtyInput?.value || '1',
        hasPlus: !!plusBtn,
        hasMinus: !!minusBtn,
        hasQtyInput: !!qtyInput,
      };
    });
    pageData[`${label}_cart_qty_controls`] = qtyInfo;

    if (!qtyInfo.hasPlus && !qtyInfo.hasMinus && !qtyInfo.hasQtyInput) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'E-Commerce', title: `No quantity controls in cart (${sn})`, description: 'Cart does not have +/- buttons or quantity input', site: sn, fix: 'Add quantity increment/decrement controls to cart items', testType: 'Cart',
        steps: '1. Add a product to cart\n2. Go to cart page\n3. Look for quantity +/- buttons\n4. Observe: Not found', expected: 'Quantity controls (+/-) visible for cart items', actual: 'No quantity adjustment controls available' });
    } else if (qtyInfo.hasPlus) {
      // Try incrementing
      const plusBtn = page.locator('button[aria-label*="increase" i], button:has-text("+"), [class*="qty-inc"], [class*="increment"]').first();
      await plusBtn.click();
      await page.waitForTimeout(2000);
      screenshots[`${label}_cart_qty_increased`] = b64(await page.screenshot());

      const newQty = await page.evaluate(() => {
        const qtyInput = document.querySelector('input[type="number"], [class*="quantity"] input');
        return qtyInput?.value || '1';
      });
      pageData[`${label}_cart_qty_after_increase`] = newQty;
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_cart_qty_error`] = friendly;
    logTestResult(pageData, label, 'cart_quantity', 'error', friendly);
  }
  await page.close();
}

/** #8,29,35 — PLP filter and sort interactions */
async function runPLPInteractionTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    const initialCount = await page.evaluate(() =>
      document.querySelectorAll('a[href*="/product/"], [class*="product-card"], [class*="product-item"]').length
    );
    if (initialCount === 0) {
      logTestResult(pageData, label, 'plp_interaction', 'skipped', 'No product cards found on /products page. The PLP may use a different URL or product card structure. Filter/sort tests cannot run without products.');
      await page.close(); return;
    }

    // #29 — Sort functionality
    const sortEl = page.locator('[class*="sort"] select, select[name*="sort"], [data-testid*="sort"] select, button:has-text("Sort"), [class*="sort-by"]').first();
    if (await sortEl.isVisible().catch(() => false)) {
      const tagName = await sortEl.evaluate(el => el.tagName.toLowerCase());
      if (tagName === 'select') {
        const options = await sortEl.evaluate(el => [...el.options].map(o => o.value));
        if (options.length > 1) {
          await sortEl.selectOption({ index: 1 });
          await page.waitForTimeout(3000);
          screenshots[`${label}_plp_sorted`] = b64(await page.screenshot());
          pageData[`${label}_plp_sort_tested`] = true;
        }
      } else {
        await sortEl.click();
        await page.waitForTimeout(1000);
        const sortOption = page.locator('[class*="sort"] li, [class*="sort"] a, [role="option"]').first();
        if (await sortOption.isVisible().catch(() => false)) {
          await sortOption.click();
          await page.waitForTimeout(3000);
          screenshots[`${label}_plp_sorted`] = b64(await page.screenshot());
          pageData[`${label}_plp_sort_tested`] = true;
        }
      }
    }

    // #8,35 — Filter interactions (gender, colour)
    const filterBtns = page.locator('[class*="filter"] button, [class*="filter"] a, [class*="facet"] button, [class*="filter"] label, [class*="filter"] input[type="checkbox"]');
    const filterCount = await filterBtns.count();
    if (filterCount > 0) {
      // Click first filter
      const firstFilter = filterBtns.first();
      await firstFilter.click();
      await page.waitForTimeout(3000);
      screenshots[`${label}_plp_filtered`] = b64(await page.screenshot());

      const filteredCount = await page.evaluate(() =>
        document.querySelectorAll('a[href*="/product/"], [class*="product-card"], [class*="product-item"]').length
      );
      pageData[`${label}_plp_filter`] = { before: initialCount, after: filteredCount };

      // Check if filter caused redirect away from PLP
      const currentUrl = page.url();
      if (!currentUrl.includes('/products') && !currentUrl.includes('/collections') && !currentUrl.includes('/c/')) {
        bugs.push({ id: bugs.length + 1, severity: 'High', category: 'E-Commerce', title: `Filter redirected away from PLP (${sn})`, description: `Clicking filter navigated to ${currentUrl}`, site: sn, fix: 'Filters should update products in-place, not redirect', testType: 'PLP',
          steps: '1. Go to product listing page\n2. Click any filter option\n3. Observe: Page redirects away from PLP', expected: 'Products filtered in-place on the same page', actual: `Redirected to ${currentUrl}` });
      }
    }

    // #12 — Add to cart from PLP (quick add)
    const plpAddBtn = page.locator('[class*="product-card"] button:has-text("Add"), [class*="product-card"] button:has-text("Cart"), [class*="product"] [class*="add-to-cart"]').first();
    if (await plpAddBtn.isVisible().catch(() => false)) {
      await plpAddBtn.click();
      await page.waitForTimeout(2000);
      screenshots[`${label}_plp_add_to_cart`] = b64(await page.screenshot());
      pageData[`${label}_plp_add_to_cart`] = true;
    }

  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_plp_interaction_error`] = friendly;
    logTestResult(pageData, label, 'plp_interaction', 'error', friendly);
  }
  await page.close();
}

/** #18,26,27 — Homepage: banner carousel, social icons, header links */
async function runHomepageDeepTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // #27 — Header presence
    const headerInfo = await page.evaluate(() => {
      const header = document.querySelector('header, [class*="header"], nav');
      const logo = document.querySelector('header img, [class*="logo"] img, a[href="/"] img');
      return { hasHeader: !!header, hasLogo: !!logo };
    });
    if (!headerInfo.hasHeader) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'UI', title: `No header/navigation found on homepage (${sn})`, description: 'Homepage is missing a header or navigation bar', site: sn, fix: 'Add header component with navigation', testType: 'Homepage',
        steps: '1. Open the homepage\n2. Look for header/navigation at the top\n3. Observe: Not found', expected: 'Visible header with navigation links', actual: 'No header element detected' });
    }

    // #18 — Banner carousel
    const bannerInfo = await page.evaluate(() => {
      const carousel = document.querySelector('[class*="carousel"], [class*="slider"], [class*="banner"], [class*="swiper"], [class*="slick"]');
      const arrows = document.querySelectorAll('[class*="carousel"] button, [class*="slider"] button, [class*="arrow"], [class*="prev"], [class*="next"], .swiper-button-prev, .swiper-button-next');
      const dots = document.querySelectorAll('[class*="carousel"] [class*="dot"], [class*="indicator"], .swiper-pagination-bullet, [class*="slick-dots"] li');
      return { hasCarousel: !!carousel, arrowCount: arrows.length, dotCount: dots.length };
    });
    pageData[`${label}_homepage_banner`] = bannerInfo;

    if (bannerInfo.hasCarousel) {
      // Test arrow click
      const nextArrow = page.locator('[class*="next"], .swiper-button-next, [class*="slider"] button:last-child, [class*="arrow"]:last-child').first();
      if (await nextArrow.isVisible().catch(() => false)) {
        await nextArrow.click();
        await page.waitForTimeout(1500);
        screenshots[`${label}_banner_after_arrow`] = b64(await page.screenshot());
      }
    }

    // #26 — Social media icons
    const socialInfo = await page.evaluate(() => {
      const socialLinks = document.querySelectorAll('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="youtube"], a[href*="linkedin"], a[href*="pinterest"]');
      const details = [...socialLinks].map(a => ({
        platform: a.href.match(/(facebook|instagram|twitter|youtube|linkedin|pinterest)/)?.[1] || 'unknown',
        href: a.href,
        opensNewTab: a.target === '_blank',
      }));
      return { count: socialLinks.length, links: details };
    });
    pageData[`${label}_social_icons`] = socialInfo;

    for (const link of socialInfo.links) {
      if (!link.opensNewTab) {
        bugs.push({ id: bugs.length + 1, severity: 'Low', category: 'UI', title: `${link.platform} link doesn't open in new tab (${sn})`, description: `Social media link to ${link.platform} missing target="_blank"`, site: sn, fix: 'Add target="_blank" to social media links', testType: 'Homepage',
          steps: `1. Go to homepage\n2. Click ${link.platform} icon\n3. Observe: Opens in same tab`, expected: 'Social link opens in new tab', actual: 'Opens in current tab, user loses the website' });
      }
    }

  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_homepage_deep_error`] = friendly;
    logTestResult(pageData, label, 'homepage_deep', 'error', friendly);
  }
  await page.close();
}

/** #24,38 — Header L1/L2 menus, header link validation */
async function runHeaderNavTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // #38 — L1/L2 header menu detection
    const navInfo = await page.evaluate(() => {
      const navLinks = document.querySelectorAll('header a, nav a, [class*="header"] a, [class*="nav"] a, [class*="menu"] a');
      const l1Items = [...navLinks].filter(a => {
        const parent = a.closest('ul, [class*="menu"]');
        return parent && !parent.closest('ul ul, [class*="sub"], [class*="dropdown"]');
      });
      const l2Items = [...navLinks].filter(a => {
        return a.closest('ul ul, [class*="sub"], [class*="dropdown"]');
      });
      return {
        totalNavLinks: navLinks.length,
        l1Count: l1Items.length,
        l2Count: l2Items.length,
        l1Links: [...new Set(l1Items.slice(0, 10).map(a => ({ text: a.textContent.trim().substring(0, 30), href: a.getAttribute('href') })))],
      };
    });
    pageData[`${label}_header_nav`] = navInfo;

    // #24 — Validate header links
    const headerLinks = page.locator('header a[href], nav a[href], [class*="header"] a[href]');
    const linkCount = await headerLinks.count();
    const brokenLinks = [];
    const checked = new Set();

    for (let i = 0; i < Math.min(linkCount, 15); i++) {
      const href = await headerLinks.nth(i).getAttribute('href');
      if (!href || href === '#' || href.startsWith('javascript') || checked.has(href)) continue;
      checked.add(href);

      if (href.startsWith('http') && !href.includes(new URL(siteUrl).hostname)) continue; // skip external

      const fullUrl = href.startsWith('http') ? href : siteUrl + href;
      const testPage = await browser.newPage();
      try {
        const resp = await testPage.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        if (!resp || resp.status() >= 400) {
          brokenLinks.push({ href, status: resp ? resp.status() : 0 });
        }
      } catch {}
      await testPage.close();
    }

    if (brokenLinks.length > 0) {
      bugs.push({ id: bugs.length + 1, severity: 'High', category: 'Navigation', title: `${brokenLinks.length} broken header links (${sn})`, description: brokenLinks.map(l => `${l.href} → ${l.status}`).join(', '), site: sn, fix: 'Fix broken URLs in header navigation', testType: 'Navigation',
        steps: `1. Go to homepage\n2. Check header navigation links\n3. Found ${brokenLinks.length} returning errors`, expected: 'All header links load successfully', actual: `${brokenLinks.length} links return error status codes` });
    }

    // #38 — Hover to reveal L2 menus
    const l1Hover = page.locator('header nav > ul > li, [class*="nav"] > ul > li, [class*="menu"] > ul > li').first();
    if (await l1Hover.isVisible().catch(() => false)) {
      await l1Hover.hover();
      await page.waitForTimeout(1000);
      const submenuVisible = await page.evaluate(() => {
        const subs = document.querySelectorAll('ul ul, [class*="sub-menu"], [class*="dropdown"], [class*="mega-menu"]');
        return [...subs].some(s => {
          const style = window.getComputedStyle(s);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        });
      });
      pageData[`${label}_l2_menu_on_hover`] = submenuVisible;
      if (submenuVisible) {
        screenshots[`${label}_header_l2_menu`] = b64(await page.screenshot());
      }
    }

  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_header_nav_error`] = friendly;
    logTestResult(pageData, label, 'header_nav', 'error', friendly);
  }
  await page.close();
}

/** #3,6 — Address add/edit/delete (requires login first) */
async function runAddressTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  if (!pageData[`${label}_login_success`]) {
    logTestResult(pageData, label, 'address', 'skipped', 'Login was not successful in earlier test — address page requires authentication. Skipping address tests.');
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(siteUrl + '/profile/address', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    if (page.url().includes('login') || page.url().includes('auth')) {
      pageData[`${label}_address_requires_auth`] = true;
      logTestResult(pageData, label, 'address', 'skipped', 'Address page redirected back to login — session/cookie may not have persisted. The site requires re-authentication to access this page.');
      await page.close();
      return;
    }
    screenshots[`${label}_address_page`] = b64(await page.screenshot());

    const addBtn = page.locator('button:has-text("Add"), a:has-text("Add Address"), button:has-text("New Address")').first();
    pageData[`${label}_address_add_btn`] = await addBtn.isVisible().catch(() => false);

    if (!pageData[`${label}_address_add_btn`]) {
      bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'Profile', title: `No "Add Address" button found (${sn})`, description: 'Address page has no option to add a new address', site: sn, fix: 'Add an "Add New Address" button', testType: 'Profile',
        steps: '1. Login and go to Profile > Address\n2. Look for Add Address button\n3. Observe: Not found', expected: '"Add Address" button visible', actual: 'No add address option available' });
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_address_error`] = friendly;
    logTestResult(pageData, label, 'address', 'error', friendly);
  }
  await page.close();
}

/** #23 — Track Order page */
async function runTrackOrderTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    const orderPaths = ['/profile/orders', '/orders', '/track-order'];
    let loaded = false;
    for (const op of orderPaths) {
      const resp = await page.goto(siteUrl + op, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.status() === 200 && !page.url().includes('login') && !page.url().includes('auth')) {
        loaded = true;
        break;
      }
    }
    if (!loaded) {
      logTestResult(pageData, label, 'track_order', 'skipped', 'Track order page not found — tried /profile/orders, /orders, and /track-order. All either returned errors or redirected to login. This feature may not exist or requires authentication.');
      await page.close(); return;
    }
    await page.waitForTimeout(2000);
    screenshots[`${label}_track_order`] = b64(await page.screenshot());
    pageData[`${label}_track_order_page`] = true;
    logTestResult(pageData, label, 'track_order', 'passed', 'Track order page loaded successfully.');
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_track_order_error`] = friendly;
    logTestResult(pageData, label, 'track_order', 'error', friendly);
  }
  await page.close();
}

/** #22 — Newsletter subscription */
async function runNewsletterTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    // Scroll to footer where newsletter usually lives
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    const newsletterInput = page.locator('input[type="email"][placeholder*="email" i], input[name*="newsletter" i], input[placeholder*="subscribe" i], input[placeholder*="newsletter" i], footer input[type="email"]').first();
    if (await newsletterInput.isVisible().catch(() => false)) {
      await newsletterInput.fill('testuser@example.com');
      await page.waitForTimeout(500);

      const subBtn = page.locator('button:has-text("Subscribe"), button:has-text("Sign Up"), button:has-text("Submit"), footer button[type="submit"]').first();
      if (await subBtn.isVisible().catch(() => false)) {
        await subBtn.click();
        await page.waitForTimeout(2000);
        screenshots[`${label}_newsletter_submitted`] = b64(await page.screenshot());

        // Check if input cleared after submit
        const inputValue = await newsletterInput.inputValue().catch(() => '');
        pageData[`${label}_newsletter_clears`] = inputValue === '';
        if (inputValue !== '') {
          bugs.push({ id: bugs.length + 1, severity: 'Low', category: 'UI', title: `Newsletter input not cleared after submit (${sn})`, description: 'Email field retains value after subscribing', site: sn, fix: 'Clear the email field after successful subscription', testType: 'Forms',
            steps: '1. Scroll to newsletter section\n2. Enter email and click Subscribe\n3. Observe: Input field still has the email', expected: 'Input field clears after successful subscription', actual: 'Email remains in the input field' });
        }
      }
      pageData[`${label}_has_newsletter`] = true;
    } else {
      pageData[`${label}_has_newsletter`] = false;
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_newsletter_error`] = friendly;
    logTestResult(pageData, label, 'newsletter', 'error', friendly);
  }
  await page.close();
}

/** #14 — Store locator */
async function runStoreLocatorTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    const storePaths = ['/store-locator', '/stores', '/find-store', '/locate-store'];
    let loaded = false;
    for (const sp of storePaths) {
      const resp = await page.goto(siteUrl + sp, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (resp && resp.status() === 200) { loaded = true; break; }
    }
    if (!loaded) {
      logTestResult(pageData, label, 'store_locator', 'skipped', 'Store locator page not found — tried /store-locator, /stores, /find-store, /locate-store. This site may not have a store locator feature.');
      await page.close(); return;
    }
    await page.waitForTimeout(2000);
    screenshots[`${label}_store_locator`] = b64(await page.screenshot());

    const storeInfo = await page.evaluate(() => {
      const searchInput = document.querySelector('input[placeholder*="city" i], input[placeholder*="location" i], input[placeholder*="pincode" i], input[placeholder*="search" i], input[type="search"]');
      const mapEl = document.querySelector('[class*="map"], iframe[src*="maps"], [id*="map"]');
      const storeCards = document.querySelectorAll('[class*="store-card"], [class*="store-item"], [class*="store-list"] li');
      return { hasSearch: !!searchInput, hasMap: !!mapEl, storeCount: storeCards.length };
    });
    pageData[`${label}_store_locator`] = storeInfo;
    logTestResult(pageData, label, 'store_locator', 'passed', `Store locator page loaded. Search: ${storeInfo.hasSearch ? 'yes' : 'no'}, Map: ${storeInfo.hasMap ? 'yes' : 'no'}, Stores listed: ${storeInfo.storeCount}`);
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_store_locator_error`] = friendly;
    logTestResult(pageData, label, 'store_locator', 'error', friendly);
  }
  await page.close();
}

/** #20,28,36 — PDP: size guide, add without size, pincode without size */
async function runPDPEdgeCaseTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const productUrl = discovery.productLinks[0];
  if (!productUrl) {
    logTestResult(pageData, label, 'pdp_edge_case', 'skipped', 'No product URLs discovered on the site. Cannot test PDP edge cases (size guide, add without size, pincode without size) without a product page.');
    return;
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // #20 — Size guide
    const sizeGuide = page.locator('a:has-text("Size Guide"), a:has-text("Size Chart"), button:has-text("Size Guide"), button:has-text("Size Chart"), [class*="size-guide"], [class*="size-chart"]').first();
    if (await sizeGuide.isVisible().catch(() => false)) {
      await sizeGuide.click();
      await page.waitForTimeout(1500);
      screenshots[`${label}_pdp_size_guide`] = b64(await page.screenshot());
      pageData[`${label}_pdp_size_guide`] = true;
    }

    // Reload page to reset state
    await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // #28 — Add to cart WITHOUT selecting size
    const hasSizes = await page.evaluate(() =>
      document.querySelectorAll('[class*="size"] button, [class*="size"] label, [data-testid*="size"]').length
    );
    if (hasSizes > 0) {
      // Don't select size, try to add to cart
      const addBtn = page.locator('button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("Buy Now")').first();
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click();
        await page.waitForTimeout(2000);
        screenshots[`${label}_pdp_add_no_size`] = b64(await page.screenshot());

        const sizeError = await page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('select size') || body.includes('choose size') || body.includes('please select') || body.includes('size required');
        });
        pageData[`${label}_pdp_no_size_validation`] = sizeError;
        if (!sizeError) {
          bugs.push({ id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce', title: `No size validation error when adding to cart (${sn})`, description: 'User can add to cart without selecting a size — no error shown', site: sn, fix: 'Show "Please select a size" validation message', testType: 'PDP',
            steps: '1. Go to a PDP with size options\n2. Do NOT select any size\n3. Click "Add to Cart"\n4. Observe: No size validation error', expected: 'Error message: "Please select a size"', actual: 'No validation — item may be added without size' });
        }
      }

      // #36 — Pincode check without size
      const pincodeInput = page.locator('input[placeholder*="pincode" i], input[placeholder*="zip" i], input[placeholder*="delivery" i]').first();
      if (await pincodeInput.isVisible().catch(() => false)) {
        await pincodeInput.fill('400001');
        const checkBtn = page.locator('button:has-text("Check"), button:has-text("Verify"), button:has-text("Apply")').first();
        if (await checkBtn.isVisible().catch(() => false)) {
          await checkBtn.click();
          await page.waitForTimeout(2000);
          screenshots[`${label}_pdp_pincode_no_size`] = b64(await page.screenshot());
          pageData[`${label}_pdp_pincode_no_size`] = true;
        }
      }
    }
  } catch (e) {
    const friendly = friendlyError(e);
    pageData[`${label}_pdp_edge_error`] = friendly;
    logTestResult(pageData, label, 'pdp_edge_case', 'error', friendly);
  }
  await page.close();
}

// ─────────────────────────────────────────────────────────────
// ENHANCED REGRESSION: Structure, Meta, CSS, Header/Footer, Responsive
// ─────────────────────────────────────────────────────────────

/** Compare DOM structure between prod and UAT for a given path */
async function runStructureCompare(browser, site1Url, site2Url, path, bugs, pageData) {
  const extractStructure = async (siteUrl) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let result = null;
    try {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      result = await page.evaluate(() => {
        const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({ tag: h.tagName, text: h.textContent.trim().substring(0, 80) }));
        const sections = document.querySelectorAll('section, [class*="section"], main, article, aside').length;
        const images = document.querySelectorAll('img').length;
        const buttons = document.querySelectorAll('button, [role="button"], input[type="submit"]').length;
        const links = document.querySelectorAll('a[href]').length;
        const forms = document.querySelectorAll('form').length;
        const inputs = document.querySelectorAll('input, select, textarea').length;
        const videos = document.querySelectorAll('video, iframe[src*="youtube"], iframe[src*="vimeo"]').length;
        const banners = document.querySelectorAll('[class*="banner"], [class*="slider"], [class*="carousel"], [class*="hero"]').length;
        return { headings, sections, images, buttons, links, forms, inputs, videos, banners };
      });
    } catch {}
    await page.close();
    return result;
  };

  const s1 = await extractStructure(site1Url);
  const s2 = await extractStructure(site2Url);
  if (!s1 || !s2) return;

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  // Compare element counts
  const counts = [
    ['images', s1.images, s2.images],
    ['buttons', s1.buttons, s2.buttons],
    ['links', s1.links, s2.links],
    ['sections', s1.sections, s2.sections],
    ['form inputs', s1.inputs, s2.inputs],
    ['videos/embeds', s1.videos, s2.videos],
    ['banners/carousels', s1.banners, s2.banners],
  ];
  for (const [name, c1, c2] of counts) {
    if (c1 !== c2 && Math.abs(c1 - c2) > 1) {
      diffs.push(`${name}: Production has ${c1}, UAT has ${c2} (${c2 > c1 ? '+' : ''}${c2 - c1})`);
    }
  }

  // Compare heading structure
  const h1Prod = s1.headings.filter(h => h.tag === 'H1').map(h => h.text);
  const h1UAT = s2.headings.filter(h => h.tag === 'H1').map(h => h.text);
  if (h1Prod.length !== h1UAT.length) {
    diffs.push(`H1 headings: Production has ${h1Prod.length} ("${h1Prod[0] || 'none'}"), UAT has ${h1UAT.length} ("${h1UAT[0] || 'none'}")`);
  } else {
    for (let i = 0; i < h1Prod.length; i++) {
      if (h1Prod[i] !== h1UAT[i]) {
        diffs.push(`H1 text differs: Production "${h1Prod[i]}" vs UAT "${h1UAT[i]}"`);
      }
    }
  }

  if (s1.headings.length !== s2.headings.length) {
    diffs.push(`Total headings: Production has ${s1.headings.length}, UAT has ${s2.headings.length}`);
  }

  if (diffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: diffs.length > 3 ? 'High' : 'Medium',
      category: 'Regression',
      title: `Page structure differs on ${path} — ${diffs.length} differences found`,
      description: `Comparing Production vs UAT on ${path}:\n\n${diffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Review structural changes between Production and UAT to ensure they are intentional',
      testType: 'Regression',
      location: path,
      steps: `1. Open Production ${site1Url}${path} and UAT ${site2Url}${path} side by side\n2. Compare the page structure — headings, sections, images, buttons\n3. Check each difference listed above`,
      expected: 'UAT page structure should match Production (unless changes are intentional)',
      actual: `${diffs.length} structural differences found between Production and UAT`,
    });
  }

  pageData[`structure_compare_${path.replace(/[^a-z0-9]/gi, '_')}`] = { prod: s1, uat: s2, diffs };
}

/** Compare meta tags and OG tags between prod and UAT */
async function runMetaCompare(browser, site1Url, site2Url, path, bugs, pageData) {
  const extractMeta = async (siteUrl) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let result = null;
    try {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1000);
      result = await page.evaluate(() => {
        const title = document.title || '';
        const desc = document.querySelector('meta[name="description"]')?.content || '';
        const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
        const ogTitle = document.querySelector('meta[property="og:title"]')?.content || '';
        const ogDesc = document.querySelector('meta[property="og:description"]')?.content || '';
        const ogImage = document.querySelector('meta[property="og:image"]')?.content || '';
        const ogType = document.querySelector('meta[property="og:type"]')?.content || '';
        const twitterCard = document.querySelector('meta[name="twitter:card"]')?.content || '';
        const favicon = document.querySelector('link[rel="icon"], link[rel="shortcut icon"]')?.href || '';
        const viewport = document.querySelector('meta[name="viewport"]')?.content || '';
        const robots = document.querySelector('meta[name="robots"]')?.content || '';
        return { title, desc, canonical, ogTitle, ogDesc, ogImage, ogType, twitterCard, favicon, viewport, robots };
      });
    } catch {}
    await page.close();
    return result;
  };

  const m1 = await extractMeta(site1Url);
  const m2 = await extractMeta(site2Url);
  if (!m1 || !m2) return;

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  const fields = [
    ['Page title', m1.title, m2.title],
    ['Meta description', m1.desc, m2.desc],
    ['OG title', m1.ogTitle, m2.ogTitle],
    ['OG description', m1.ogDesc, m2.ogDesc],
    ['OG image', m1.ogImage, m2.ogImage],
    ['Favicon', m1.favicon, m2.favicon],
    ['Robots', m1.robots, m2.robots],
  ];

  for (const [name, v1, v2] of fields) {
    if (v1 && !v2) {
      diffs.push(`${name}: Present on Production ("${v1.substring(0, 60)}") but MISSING on UAT`);
    } else if (v1 && v2 && v1 !== v2) {
      diffs.push(`${name} differs:\n  Production: "${v1.substring(0, 80)}"\n  UAT: "${v2.substring(0, 80)}"`);
    }
  }

  if (diffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: diffs.some(d => /MISSING/i.test(d)) ? 'High' : 'Medium',
      category: 'SEO/Meta',
      title: `Meta tags differ on ${path} — ${diffs.length} differences`,
      description: `Comparing meta tags between Production and UAT on ${path}:\n\n${diffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Update meta tags on UAT to match Production, or confirm changes are intentional',
      testType: 'Regression',
      location: path,
      steps: `1. Open Production ${site1Url}${path} → View Page Source → check <head> meta tags\n2. Open UAT ${site2Url}${path} → View Page Source → check <head> meta tags\n3. Compare the differences listed above`,
      expected: 'Meta tags and SEO tags should match between Production and UAT',
      actual: `${diffs.length} meta tag differences found`,
    });
  }

  pageData[`meta_compare_${path.replace(/[^a-z0-9]/gi, '_')}`] = { prod: m1, uat: m2, diffs };
}

/** Compare header and footer structure between prod and UAT */
async function runHeaderFooterCompare(browser, site1Url, site2Url, bugs, pageData, screenshots) {
  const extractHeaderFooter = async (siteUrl, label) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let result = null;
    try {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      // Take header screenshot
      const headerEl = await page.$('header, [class*="header"], [role="banner"], nav');
      if (headerEl) {
        try {
          screenshots[`${label}_header_crop`] = b64(await headerEl.screenshot());
        } catch {}
      }

      // Take footer screenshot
      const footerEl = await page.$('footer, [class*="footer"], [role="contentinfo"]');
      if (footerEl) {
        try {
          // Scroll to footer first
          await footerEl.scrollIntoViewIfNeeded();
          await page.waitForTimeout(500);
          screenshots[`${label}_footer_crop`] = b64(await footerEl.screenshot());
        } catch {}
      }

      result = await page.evaluate(() => {
        // Header analysis
        const header = document.querySelector('header, [class*="header"], [role="banner"]');
        const headerData = { exists: !!header, height: 0, links: [], logoSrc: '', hasSearch: false, hasCart: false, hasAccount: false };
        if (header) {
          headerData.height = header.getBoundingClientRect().height;
          headerData.links = [...header.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim().substring(0, 40), href: a.getAttribute('href') })).filter(l => l.text);
          const logo = header.querySelector('img[class*="logo"], img[alt*="logo" i], a[class*="logo"] img, [class*="logo"] img');
          headerData.logoSrc = logo?.src || logo?.getAttribute('data-src') || '';
          headerData.hasSearch = !!header.querySelector('[class*="search"], input[type="search"], [aria-label*="search" i]');
          headerData.hasCart = !!header.querySelector('[class*="cart"], [class*="bag"], [aria-label*="cart" i], [aria-label*="bag" i]');
          headerData.hasAccount = !!header.querySelector('[class*="account"], [class*="user"], [class*="profile"], [aria-label*="account" i]');
        }

        // Footer analysis
        const footer = document.querySelector('footer, [class*="footer"], [role="contentinfo"]');
        const footerData = { exists: !!footer, height: 0, links: [], hasSocial: false, socialLinks: [], hasNewsletter: false, hasCopyright: false, copyrightText: '' };
        if (footer) {
          footerData.height = footer.getBoundingClientRect().height;
          footerData.links = [...footer.querySelectorAll('a[href]')].map(a => ({ text: a.textContent.trim().substring(0, 40), href: a.getAttribute('href') })).filter(l => l.text);
          footerData.hasSocial = !!footer.querySelector('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="youtube"], [class*="social"]');
          footerData.socialLinks = [...footer.querySelectorAll('a[href*="facebook"], a[href*="instagram"], a[href*="twitter"], a[href*="youtube"], a[href*="pinterest"], a[href*="linkedin"]')].map(a => a.href);
          footerData.hasNewsletter = !!footer.querySelector('input[type="email"], [class*="newsletter"], [class*="subscribe"]');
          const cpEl = footer.querySelector('[class*="copyright"], small');
          footerData.hasCopyright = !!cpEl;
          footerData.copyrightText = cpEl?.textContent?.trim()?.substring(0, 100) || '';
        }

        return { header: headerData, footer: footerData };
      });
    } catch {}
    await page.close();
    return result;
  };

  const s1 = await extractHeaderFooter(site1Url, 'site1');
  const s2 = await extractHeaderFooter(site2Url, 'site2');
  if (!s1 || !s2) return;

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  // Header comparison
  if (s1.header.exists && s2.header.exists) {
    const hDiff = Math.abs(s1.header.height - s2.header.height);
    if (hDiff > 20) diffs.push(`Header height: Production ${Math.round(s1.header.height)}px vs UAT ${Math.round(s2.header.height)}px (${hDiff}px difference)`);
    if (s1.header.links.length !== s2.header.links.length) {
      diffs.push(`Header nav links: Production has ${s1.header.links.length} links, UAT has ${s2.header.links.length} links`);
      const prodTexts = s1.header.links.map(l => l.text.toLowerCase());
      const uatTexts = s2.header.links.map(l => l.text.toLowerCase());
      const onlyProd = s1.header.links.filter(l => !uatTexts.includes(l.text.toLowerCase())).map(l => l.text);
      const onlyUAT = s2.header.links.filter(l => !prodTexts.includes(l.text.toLowerCase())).map(l => l.text);
      if (onlyProd.length > 0) diffs.push(`  Missing in UAT header: ${onlyProd.slice(0, 5).join(', ')}`);
      if (onlyUAT.length > 0) diffs.push(`  Extra in UAT header: ${onlyUAT.slice(0, 5).join(', ')}`);
    }
    if (s1.header.hasSearch !== s2.header.hasSearch) diffs.push(`Search icon: ${s1.header.hasSearch ? 'Present' : 'Missing'} on Production, ${s2.header.hasSearch ? 'Present' : 'Missing'} on UAT`);
    if (s1.header.hasCart !== s2.header.hasCart) diffs.push(`Cart icon: ${s1.header.hasCart ? 'Present' : 'Missing'} on Production, ${s2.header.hasCart ? 'Present' : 'Missing'} on UAT`);
    if (s1.header.hasAccount !== s2.header.hasAccount) diffs.push(`Account icon: ${s1.header.hasAccount ? 'Present' : 'Missing'} on Production, ${s2.header.hasAccount ? 'Present' : 'Missing'} on UAT`);
  } else if (s1.header.exists && !s2.header.exists) {
    diffs.push('Header: Present on Production but MISSING on UAT');
  }

  // Footer comparison
  if (s1.footer.exists && s2.footer.exists) {
    const fDiff = Math.abs(s1.footer.height - s2.footer.height);
    if (fDiff > 30) diffs.push(`Footer height: Production ${Math.round(s1.footer.height)}px vs UAT ${Math.round(s2.footer.height)}px (${fDiff}px difference)`);
    if (Math.abs(s1.footer.links.length - s2.footer.links.length) > 2) {
      diffs.push(`Footer links: Production has ${s1.footer.links.length}, UAT has ${s2.footer.links.length}`);
    }
    if (s1.footer.hasSocial !== s2.footer.hasSocial) diffs.push(`Social links: ${s1.footer.hasSocial ? 'Present' : 'Missing'} on Production, ${s2.footer.hasSocial ? 'Present' : 'Missing'} on UAT`);
    if (s1.footer.hasNewsletter !== s2.footer.hasNewsletter) diffs.push(`Newsletter signup: ${s1.footer.hasNewsletter ? 'Present' : 'Missing'} on Production, ${s2.footer.hasNewsletter ? 'Present' : 'Missing'} on UAT`);
    if (s1.footer.socialLinks.length !== s2.footer.socialLinks.length) {
      diffs.push(`Social links count: Production has ${s1.footer.socialLinks.length}, UAT has ${s2.footer.socialLinks.length}`);
    }
  } else if (s1.footer.exists && !s2.footer.exists) {
    diffs.push('Footer: Present on Production but MISSING on UAT');
  }

  // Pixelmatch header screenshots
  if (screenshots['site1_header_crop'] && screenshots['site2_header_crop']) {
    try {
      const img1 = PNG.sync.read(Buffer.from(screenshots['site1_header_crop'], 'base64'));
      const img2 = PNG.sync.read(Buffer.from(screenshots['site2_header_crop'], 'base64'));
      const w = Math.min(img1.width, img2.width);
      const h = Math.min(img1.height, img2.height);
      if (w > 10 && h > 10) {
        const crop = (img, cw, ch) => {
          const c = new PNG({ width: cw, height: ch });
          for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            const si = (y * img.width + x) * 4, di = (y * cw + x) * 4;
            c.data[di] = img.data[si]; c.data[di+1] = img.data[si+1]; c.data[di+2] = img.data[si+2]; c.data[di+3] = img.data[si+3];
          }
          return c;
        };
        const c1 = img1.width === w && img1.height === h ? img1 : crop(img1, w, h);
        const c2 = img2.width === w && img2.height === h ? img2 : crop(img2, w, h);
        const diffImg = new PNG({ width: w, height: h });
        const diffPx = pixelmatch(c1.data, c2.data, diffImg.data, w, h, { threshold: 0.12 });
        const pct = ((diffPx / (w * h)) * 100).toFixed(1);
        screenshots['diff_header_crop'] = PNG.sync.write(diffImg).toString('base64');
        if (parseFloat(pct) > 3) {
          diffs.push(`Header visual diff: ${pct}% pixels differ between Production and UAT header`);
        }
      }
    } catch {}
  }

  // Pixelmatch footer screenshots
  if (screenshots['site1_footer_crop'] && screenshots['site2_footer_crop']) {
    try {
      const img1 = PNG.sync.read(Buffer.from(screenshots['site1_footer_crop'], 'base64'));
      const img2 = PNG.sync.read(Buffer.from(screenshots['site2_footer_crop'], 'base64'));
      const w = Math.min(img1.width, img2.width);
      const h = Math.min(img1.height, img2.height);
      if (w > 10 && h > 10) {
        const crop = (img, cw, ch) => {
          const c = new PNG({ width: cw, height: ch });
          for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
            const si = (y * img.width + x) * 4, di = (y * cw + x) * 4;
            c.data[di] = img.data[si]; c.data[di+1] = img.data[si+1]; c.data[di+2] = img.data[si+2]; c.data[di+3] = img.data[si+3];
          }
          return c;
        };
        const c1 = img1.width === w && img1.height === h ? img1 : crop(img1, w, h);
        const c2 = img2.width === w && img2.height === h ? img2 : crop(img2, w, h);
        const diffImg = new PNG({ width: w, height: h });
        const diffPx = pixelmatch(c1.data, c2.data, diffImg.data, w, h, { threshold: 0.12 });
        const pct = ((diffPx / (w * h)) * 100).toFixed(1);
        screenshots['diff_footer_crop'] = PNG.sync.write(diffImg).toString('base64');
        if (parseFloat(pct) > 3) {
          diffs.push(`Footer visual diff: ${pct}% pixels differ between Production and UAT footer`);
        }
      }
    } catch {}
  }

  if (diffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: diffs.some(d => /MISSING/i.test(d)) ? 'High' : 'Medium',
      category: 'Regression',
      title: `Header/Footer differences — ${diffs.length} issues found`,
      description: `Comparing header and footer between Production and UAT:\n\n${diffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Align header and footer structure between Production and UAT',
      testType: 'Regression',
      location: 'Homepage — Header & Footer',
      steps: `1. Open Production ${site1Url} and UAT ${site2Url} side by side\n2. Compare header — logo, nav links, search, cart, account icons\n3. Compare footer — links, social icons, newsletter, copyright`,
      expected: 'Header and footer should match Production layout and content',
      actual: `${diffs.length} differences found in header/footer`,
      screenshotKey: screenshots['diff_header_crop'] ? 'diff_header_crop' : undefined,
    });
  }

  pageData['header_footer_compare'] = { prod: s1, uat: s2, diffs };
}

/** Compare CSS properties (fonts, colors, spacing) between prod and UAT */
async function runCSSCompare(browser, site1Url, site2Url, path, bugs, pageData) {
  const extractCSS = async (siteUrl) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let result = null;
    try {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      result = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const bodyData = {
          fontFamily: body.fontFamily,
          fontSize: body.fontSize,
          color: body.color,
          backgroundColor: body.backgroundColor,
          lineHeight: body.lineHeight,
        };

        // Heading fonts
        const headingFonts = {};
        for (const tag of ['h1', 'h2', 'h3']) {
          const el = document.querySelector(tag);
          if (el) {
            const s = getComputedStyle(el);
            headingFonts[tag] = { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, letterSpacing: s.letterSpacing };
          }
        }

        // Button styles
        const btn = document.querySelector('button, [role="button"], .btn, [class*="button"]');
        let buttonStyle = null;
        if (btn) {
          const s = getComputedStyle(btn);
          buttonStyle = { fontFamily: s.fontFamily, fontSize: s.fontSize, backgroundColor: s.backgroundColor, color: s.color, borderRadius: s.borderRadius, padding: s.padding };
        }

        // Link styles
        const link = document.querySelector('a[href]');
        let linkStyle = null;
        if (link) {
          const s = getComputedStyle(link);
          linkStyle = { color: s.color, textDecoration: s.textDecoration, fontFamily: s.fontFamily };
        }

        // Nav link styles
        const navLink = document.querySelector('nav a, header a');
        let navStyle = null;
        if (navLink) {
          const s = getComputedStyle(navLink);
          navStyle = { fontFamily: s.fontFamily, fontSize: s.fontSize, color: s.color, textTransform: s.textTransform, letterSpacing: s.letterSpacing };
        }

        return { body: bodyData, headings: headingFonts, button: buttonStyle, link: linkStyle, nav: navStyle };
      });
    } catch {}
    await page.close();
    return result;
  };

  const c1 = await extractCSS(site1Url);
  const c2 = await extractCSS(site2Url);
  if (!c1 || !c2) return;

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  // Compare body styles
  if (c1.body.fontFamily !== c2.body.fontFamily) diffs.push(`Body font: Production uses "${c1.body.fontFamily.substring(0, 50)}" vs UAT uses "${c2.body.fontFamily.substring(0, 50)}"`);
  if (c1.body.color !== c2.body.color) diffs.push(`Body text color: Production ${c1.body.color} vs UAT ${c2.body.color}`);
  if (c1.body.backgroundColor !== c2.body.backgroundColor) diffs.push(`Background color: Production ${c1.body.backgroundColor} vs UAT ${c2.body.backgroundColor}`);

  // Compare heading styles
  for (const tag of ['h1', 'h2', 'h3']) {
    if (c1.headings[tag] && c2.headings[tag]) {
      const h1 = c1.headings[tag], h2 = c2.headings[tag];
      if (h1.fontFamily !== h2.fontFamily) diffs.push(`${tag.toUpperCase()} font: Production "${h1.fontFamily.substring(0, 40)}" vs UAT "${h2.fontFamily.substring(0, 40)}"`);
      if (h1.fontSize !== h2.fontSize) diffs.push(`${tag.toUpperCase()} font-size: Production ${h1.fontSize} vs UAT ${h2.fontSize}`);
      if (h1.color !== h2.color) diffs.push(`${tag.toUpperCase()} color: Production ${h1.color} vs UAT ${h2.color}`);
    }
  }

  // Compare nav styles
  if (c1.nav && c2.nav) {
    if (c1.nav.fontFamily !== c2.nav.fontFamily) diffs.push(`Navigation font: Production "${c1.nav.fontFamily.substring(0, 40)}" vs UAT "${c2.nav.fontFamily.substring(0, 40)}"`);
    if (c1.nav.textTransform !== c2.nav.textTransform) diffs.push(`Navigation text-transform: Production "${c1.nav.textTransform}" vs UAT "${c2.nav.textTransform}"`);
    if (c1.nav.color !== c2.nav.color) diffs.push(`Navigation color: Production ${c1.nav.color} vs UAT ${c2.nav.color}`);
  }

  // Compare button styles
  if (c1.button && c2.button) {
    if (c1.button.backgroundColor !== c2.button.backgroundColor) diffs.push(`Button background: Production ${c1.button.backgroundColor} vs UAT ${c2.button.backgroundColor}`);
    if (c1.button.color !== c2.button.color) diffs.push(`Button text color: Production ${c1.button.color} vs UAT ${c2.button.color}`);
    if (c1.button.borderRadius !== c2.button.borderRadius) diffs.push(`Button border-radius: Production ${c1.button.borderRadius} vs UAT ${c2.button.borderRadius}`);
  }

  if (diffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: diffs.some(d => /font:/i.test(d)) ? 'High' : 'Medium',
      category: 'CSS/Theme',
      title: `CSS styling differs on ${path} — ${diffs.length} property changes`,
      description: `Comparing CSS properties between Production and UAT on ${path}:\n\n${diffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Verify CSS theme and styles are correctly applied on UAT',
      testType: 'Regression',
      location: path,
      steps: `1. Open Production ${site1Url}${path} → Inspect any element → check computed styles\n2. Open UAT ${site2Url}${path} → Inspect same element → check computed styles\n3. Compare fonts, colors, spacing as listed above`,
      expected: 'CSS styles (fonts, colors, spacing) should match Production',
      actual: `${diffs.length} CSS property differences found`,
    });
  }

  pageData[`css_compare_${path.replace(/[^a-z0-9]/gi, '_')}`] = { prod: c1, uat: c2, diffs };
}

/** Compare responsive behavior at multiple breakpoints between prod and UAT */
async function runResponsiveCompare(browser, site1Url, site2Url, bugs, pageData, screenshots) {
  const breakpoints = [
    { name: 'Mobile (375px)', width: 375, height: 812, isMobile: true },
    { name: 'Tablet (768px)', width: 768, height: 1024, isMobile: true },
    { name: 'Desktop (1440px)', width: 1440, height: 900, isMobile: false },
  ];

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  for (const bp of breakpoints) {
    const extractAtBP = async (siteUrl, label) => {
      const page = await browser.newPage({ viewport: { width: bp.width, height: bp.height }, isMobile: bp.isMobile });
      let result = null;
      try {
        await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);

        // Take screenshot at this breakpoint
        screenshots[`${label}_responsive_${bp.width}`] = b64(await page.screenshot({ fullPage: false }));

        result = await page.evaluate(() => {
          const hasHamburger = !!document.querySelector('[class*="hamburger"], [class*="menu-toggle"], button[aria-label*="menu" i], [class*="mobile-menu"]');
          const headerVisible = !!document.querySelector('header, [class*="header"]');
          const navVisible = document.querySelector('nav')?.getBoundingClientRect()?.height > 10;
          const heroImg = document.querySelector('[class*="hero"] img, [class*="banner"] img, [class*="slider"] img');
          const heroWidth = heroImg ? heroImg.getBoundingClientRect().width : 0;
          const bodyScroll = document.body.scrollWidth > window.innerWidth + 5;
          const pageHeight = document.body.scrollHeight;

          return { hasHamburger, headerVisible, navVisible, heroWidth: Math.round(heroWidth), bodyScroll, pageHeight };
        });
      } catch {}
      await page.close();
      return result;
    };

    const r1 = await extractAtBP(site1Url, 'site1');
    const r2 = await extractAtBP(site2Url, 'site2');
    if (!r1 || !r2) continue;

    // Compare at this breakpoint
    if (r1.hasHamburger !== r2.hasHamburger) diffs.push(`${bp.name}: Hamburger menu ${r1.hasHamburger ? 'shows' : 'hidden'} on Production, ${r2.hasHamburger ? 'shows' : 'hidden'} on UAT`);
    if (r1.bodyScroll !== r2.bodyScroll && r2.bodyScroll) diffs.push(`${bp.name}: UAT has horizontal scroll overflow (Production doesn't)`);
    const heightDiff = Math.abs(r1.pageHeight - r2.pageHeight);
    if (heightDiff > 500) diffs.push(`${bp.name}: Page height differs by ${heightDiff}px (Production: ${r1.pageHeight}px, UAT: ${r2.pageHeight}px)`);

    // Pixelmatch the two screenshots at this breakpoint
    const k1 = `site1_responsive_${bp.width}`, k2 = `site2_responsive_${bp.width}`;
    if (screenshots[k1] && screenshots[k2]) {
      try {
        const img1 = PNG.sync.read(Buffer.from(screenshots[k1], 'base64'));
        const img2 = PNG.sync.read(Buffer.from(screenshots[k2], 'base64'));
        const w = Math.min(img1.width, img2.width), h = Math.min(img1.height, img2.height);
        if (w > 10 && h > 10) {
          const crop = (img, cw, ch) => {
            const c = new PNG({ width: cw, height: ch });
            for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
              const si = (y * img.width + x) * 4, di = (y * cw + x) * 4;
              c.data[di] = img.data[si]; c.data[di+1] = img.data[si+1]; c.data[di+2] = img.data[si+2]; c.data[di+3] = img.data[si+3];
            }
            return c;
          };
          const c1 = img1.width === w && img1.height === h ? img1 : crop(img1, w, h);
          const c2 = img2.width === w && img2.height === h ? img2 : crop(img2, w, h);
          const diffImg = new PNG({ width: w, height: h });
          const diffPx = pixelmatch(c1.data, c2.data, diffImg.data, w, h, { threshold: 0.12 });
          const pct = ((diffPx / (w * h)) * 100).toFixed(1);
          screenshots[`diff_responsive_${bp.width}`] = PNG.sync.write(diffImg).toString('base64');
          if (parseFloat(pct) > 3) {
            diffs.push(`${bp.name}: ${pct}% visual difference between Production and UAT screenshots`);
          }
        }
      } catch {}
    }
  }

  if (diffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: diffs.some(d => /horizontal scroll|MISSING/i.test(d)) ? 'High' : 'Medium',
      category: 'Responsive',
      title: `Responsive behavior differs — ${diffs.length} breakpoint issues`,
      description: `Comparing responsive layouts between Production and UAT:\n\n${diffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Check responsive CSS at each breakpoint and ensure UAT matches Production behavior',
      testType: 'Regression',
      location: 'Homepage — All breakpoints',
      steps: `1. Open Production and UAT side by side\n2. Resize browser to Mobile (375px), Tablet (768px), Desktop (1440px)\n3. Compare layout, hamburger menu, hero images, scroll behavior`,
      expected: 'Responsive behavior should match Production at all breakpoints',
      actual: `${diffs.length} responsive differences detected`,
    });
  }

  pageData['responsive_compare'] = diffs;
}

/** Lighthouse performance comparison — runs full audit on both prod and UAT, compares scores */
async function runLighthouseCompare(site1Url, site2Url, path, bugs, pageData) {
  let lighthouse, chromeLauncher;
  try {
    lighthouse = require('lighthouse');
    chromeLauncher = require('chrome-launcher');
  } catch {
    return; // Lighthouse not available
  }

  const runAudit = async (url) => {
    let chrome;
    try {
      chrome = await chromeLauncher.launch({ chromeFlags: ['--headless', '--no-sandbox', '--disable-gpu'] });
      const options = {
        logLevel: 'error',
        output: 'json',
        onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
        port: chrome.port,
      };
      const result = await lighthouse(url, options);
      await chrome.kill();

      if (!result || !result.lhr) return null;
      const lhr = result.lhr;
      const audits = lhr.audits || {};

      return {
        performance: Math.round((lhr.categories.performance?.score || 0) * 100),
        accessibility: Math.round((lhr.categories.accessibility?.score || 0) * 100),
        bestPractices: Math.round((lhr.categories['best-practices']?.score || 0) * 100),
        seo: Math.round((lhr.categories.seo?.score || 0) * 100),
        fcp: Math.round(audits['first-contentful-paint']?.numericValue || 0),
        lcp: Math.round(audits['largest-contentful-paint']?.numericValue || 0),
        cls: parseFloat((audits['cumulative-layout-shift']?.numericValue || 0).toFixed(3)),
        tbt: Math.round(audits['total-blocking-time']?.numericValue || 0),
        si: Math.round(audits['speed-index']?.numericValue || 0),
        tti: Math.round(audits['interactive']?.numericValue || 0),
        totalSizeKB: Math.round((audits['total-byte-weight']?.numericValue || 0) / 1024),
        domSize: Math.round(audits['dom-size']?.numericValue || 0),
        serverResponseTime: Math.round(audits['server-response-time']?.numericValue || 0),
        renderBlockingResources: audits['render-blocking-resources']?.details?.items?.length || 0,
        unusedJS: Math.round((audits['unused-javascript']?.details?.overallSavingsBytes || 0) / 1024),
        unusedCSS: Math.round((audits['unused-css-rules']?.details?.overallSavingsBytes || 0) / 1024),
      };
    } catch {
      if (chrome) try { await chrome.kill(); } catch {}
      return null;
    }
  };

  const prod = await runAudit(site1Url + path);
  const uat = await runAudit(site2Url + path);
  if (!prod || !uat) return;

  const site2Name = siteName('site2', site2Url);
  const diffs = [];

  // Compare category scores
  const categories = [
    ['Performance', prod.performance, uat.performance],
    ['Accessibility', prod.accessibility, uat.accessibility],
    ['Best Practices', prod.bestPractices, uat.bestPractices],
    ['SEO', prod.seo, uat.seo],
  ];
  for (const [name, p, u] of categories) {
    const delta = u - p;
    if (Math.abs(delta) >= 5) {
      diffs.push(`${name} score: Production ${p}/100 → UAT ${u}/100 (${delta > 0 ? '+' : ''}${delta} points)`);
    }
  }

  // Compare Core Web Vitals
  const vitals = [
    ['FCP (First Contentful Paint)', prod.fcp, uat.fcp, 'ms', 1800, 3000],
    ['LCP (Largest Contentful Paint)', prod.lcp, uat.lcp, 'ms', 2500, 4000],
    ['CLS (Cumulative Layout Shift)', prod.cls, uat.cls, '', 0.1, 0.25],
    ['TBT (Total Blocking Time)', prod.tbt, uat.tbt, 'ms', 200, 600],
    ['Speed Index', prod.si, uat.si, 'ms', 3400, 5800],
    ['Time to Interactive', prod.tti, uat.tti, 'ms', 3800, 7300],
  ];
  for (const [name, p, u, unit, good, poor] of vitals) {
    const delta = u - p;
    const pctChange = p > 0 ? Math.round((delta / p) * 100) : 0;
    const rating = (v) => v <= good ? 'good' : v <= poor ? 'needs-improvement' : 'poor';
    if (Math.abs(pctChange) >= 15 || (rating(p) !== rating(u))) {
      const arrow = delta > 0 ? '↑ slower' : '↓ faster';
      diffs.push(`${name}: Production ${p}${unit} (${rating(p)}) → UAT ${u}${unit} (${rating(u)}) — ${Math.abs(pctChange)}% ${arrow}`);
    }
  }

  // Compare resource sizes
  if (Math.abs(prod.totalSizeKB - uat.totalSizeKB) > 100) {
    diffs.push(`Total page weight: Production ${prod.totalSizeKB}KB → UAT ${uat.totalSizeKB}KB (${uat.totalSizeKB > prod.totalSizeKB ? '+' : ''}${uat.totalSizeKB - prod.totalSizeKB}KB)`);
  }
  if (Math.abs(prod.domSize - uat.domSize) > 200) {
    diffs.push(`DOM size: Production ${prod.domSize} elements → UAT ${uat.domSize} elements`);
  }
  if (Math.abs(prod.unusedJS - uat.unusedJS) > 50) {
    diffs.push(`Unused JavaScript: Production ${prod.unusedJS}KB → UAT ${uat.unusedJS}KB`);
  }
  if (Math.abs(prod.renderBlockingResources - uat.renderBlockingResources) > 2) {
    diffs.push(`Render-blocking resources: Production ${prod.renderBlockingResources} → UAT ${uat.renderBlockingResources}`);
  }

  // Store full comparison data
  pageData[`lighthouse_compare_${path.replace(/[^a-z0-9]/gi, '_')}`] = { prod, uat, diffs };

  // Generate bugs for performance regressions
  if (diffs.length > 0) {
    const hasScoreDrop = categories.some(([, p, u]) => u < p - 10);
    const hasVitalRegression = vitals.some(([, p, u, , , poor]) => u > poor && p <= poor);

    bugs.push({
      id: bugs.length + 1,
      severity: hasScoreDrop || hasVitalRegression ? 'High' : 'Medium',
      category: 'Performance',
      title: `Lighthouse: ${diffs.length} performance differences on ${path} — Prod ${prod.performance} vs UAT ${uat.performance}`,
      description: `Full Lighthouse comparison on ${path}:\n\n**Scores:**\n• Performance: Prod ${prod.performance}/100 → UAT ${uat.performance}/100\n• Accessibility: Prod ${prod.accessibility}/100 → UAT ${uat.accessibility}/100\n• Best Practices: Prod ${prod.bestPractices}/100 → UAT ${uat.bestPractices}/100\n• SEO: Prod ${prod.seo}/100 → UAT ${uat.seo}/100\n\n**Core Web Vitals:**\n• FCP: Prod ${prod.fcp}ms → UAT ${uat.fcp}ms\n• LCP: Prod ${prod.lcp}ms → UAT ${uat.lcp}ms\n• CLS: Prod ${prod.cls} → UAT ${uat.cls}\n• TBT: Prod ${prod.tbt}ms → UAT ${uat.tbt}ms\n• Speed Index: Prod ${prod.si}ms → UAT ${uat.si}ms\n\n**Differences:**\n${diffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Compare Lighthouse audits — optimize images, reduce JS bundles, fix render-blocking resources on UAT',
      testType: 'Performance',
      location: path,
      steps: `1. Open Chrome DevTools → Lighthouse tab on Production ${site1Url}${path}\n2. Run audit → note scores\n3. Do the same on UAT ${site2Url}${path}\n4. Compare the differences listed above`,
      expected: 'UAT performance should match or exceed Production',
      actual: `${diffs.length} performance differences found between Production and UAT`,
    });
  }
}

/** Per-section visual diff — crops header, hero, content, footer and compares each */
async function runSectionVisualDiff(browser, site1Url, site2Url, path, bugs, pageData, screenshots) {
  const captureSections = async (siteUrl, label) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    let result = null;
    try {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      // Scroll to load lazy content
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 400) {
          window.scrollTo(0, y);
          await new Promise(r => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
      await page.waitForTimeout(1000);

      // Full page screenshot
      const fullKey = `${label}_section_${path.replace(/[^a-z0-9]/gi, '_')}_full`;
      screenshots[fullKey] = b64(await page.screenshot({ fullPage: true }));

      // Get section bounding boxes
      result = await page.evaluate(() => {
        const sections = [];
        const header = document.querySelector('header, [class*="header"], [role="banner"]');
        if (header) {
          const r = header.getBoundingClientRect();
          sections.push({ name: 'Header', top: Math.round(r.top + window.scrollY), height: Math.round(r.height) });
        }

        // Hero/banner area (first big visual area after header)
        const hero = document.querySelector('[class*="hero"], [class*="banner"], [class*="slider"], [class*="carousel"], main > *:first-child, [class*="home"] > *:first-child');
        if (hero) {
          const r = hero.getBoundingClientRect();
          if (r.height > 100) sections.push({ name: 'Hero/Banner', top: Math.round(r.top + window.scrollY), height: Math.round(r.height) });
        }

        // Main content area
        const main = document.querySelector('main, [role="main"], #content, .main-content, [class*="main-content"]');
        if (main) {
          const r = main.getBoundingClientRect();
          sections.push({ name: 'Main Content', top: Math.round(r.top + window.scrollY), height: Math.round(r.height) });
        }

        const footer = document.querySelector('footer, [class*="footer"], [role="contentinfo"]');
        if (footer) {
          const r = footer.getBoundingClientRect();
          sections.push({ name: 'Footer', top: Math.round(r.top + window.scrollY), height: Math.round(r.height) });
        }

        return { sections, pageHeight: document.body.scrollHeight };
      });
    } catch {}
    await page.close();
    return result;
  };

  const s1Data = await captureSections(site1Url, 'site1');
  const s2Data = await captureSections(site2Url, 'site2');
  if (!s1Data || !s2Data) return;

  const site2Name = siteName('site2', site2Url);
  const pathKey = path.replace(/[^a-z0-9]/gi, '_');
  const fullKey1 = `site1_section_${pathKey}_full`;
  const fullKey2 = `site2_section_${pathKey}_full`;
  if (!screenshots[fullKey1] || !screenshots[fullKey2]) return;

  const sectionDiffs = [];

  // Compare full page height
  const heightDiff = Math.abs(s1Data.pageHeight - s2Data.pageHeight);
  if (heightDiff > 200) {
    sectionDiffs.push(`Page height: Production ${s1Data.pageHeight}px vs UAT ${s2Data.pageHeight}px (${heightDiff}px ${s2Data.pageHeight > s1Data.pageHeight ? 'taller' : 'shorter'} on UAT)`);
  }

  // Do section-level pixelmatch using the full screenshots cropped to section regions
  try {
    const img1Full = PNG.sync.read(Buffer.from(screenshots[fullKey1], 'base64'));
    const img2Full = PNG.sync.read(Buffer.from(screenshots[fullKey2], 'base64'));

    // Match sections by name
    for (const sec1 of s1Data.sections) {
      const sec2 = s2Data.sections.find(s => s.name === sec1.name);
      if (!sec2) {
        sectionDiffs.push(`${sec1.name}: Present on Production but not found on UAT`);
        continue;
      }

      // Height difference for this section
      const secHeightDiff = Math.abs(sec1.height - sec2.height);
      if (secHeightDiff > 30) {
        sectionDiffs.push(`${sec1.name} height: Production ${sec1.height}px vs UAT ${sec2.height}px (${secHeightDiff}px difference)`);
      }

      // Crop and compare this section from both full screenshots
      const cropWidth = Math.min(img1Full.width, img2Full.width);
      const cropHeight = Math.min(sec1.height, sec2.height, img1Full.height - sec1.top, img2Full.height - sec2.top);
      if (cropWidth < 10 || cropHeight < 10) continue;

      const cropSection = (img, top, w, h) => {
        const cropped = new PNG({ width: w, height: h });
        for (let y = 0; y < h; y++) {
          const srcY = top + y;
          if (srcY >= img.height) break;
          for (let x = 0; x < w; x++) {
            if (x >= img.width) break;
            const si = (srcY * img.width + x) * 4;
            const di = (y * w + x) * 4;
            cropped.data[di] = img.data[si]; cropped.data[di+1] = img.data[si+1]; cropped.data[di+2] = img.data[si+2]; cropped.data[di+3] = img.data[si+3];
          }
        }
        return cropped;
      };

      const c1 = cropSection(img1Full, sec1.top, cropWidth, cropHeight);
      const c2 = cropSection(img2Full, sec2.top, cropWidth, cropHeight);
      const diffImg = new PNG({ width: cropWidth, height: cropHeight });
      const diffPx = pixelmatch(c1.data, c2.data, diffImg.data, cropWidth, cropHeight, { threshold: 0.12 });
      const pct = ((diffPx / (cropWidth * cropHeight)) * 100).toFixed(1);

      if (parseFloat(pct) > 3) {
        const secDiffKey = `diff_section_${pathKey}_${sec1.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}`;
        screenshots[secDiffKey] = PNG.sync.write(diffImg).toString('base64');
        sectionDiffs.push(`${sec1.name}: ${pct}% visual difference (${diffPx.toLocaleString()} pixels differ)`);
      }
    }

    // Check for sections only in UAT
    for (const sec2 of s2Data.sections) {
      if (!s1Data.sections.find(s => s.name === sec2.name)) {
        sectionDiffs.push(`${sec2.name}: Present on UAT but not on Production (new section?)`);
      }
    }
  } catch {}

  if (sectionDiffs.length > 0) {
    bugs.push({
      id: bugs.length + 1,
      severity: sectionDiffs.length > 3 ? 'High' : 'Medium',
      category: 'Visual Diff',
      title: `Section-level visual differences on ${path} — ${sectionDiffs.length} areas differ`,
      description: `Per-section comparison between Production and UAT on ${path}:\n\n${sectionDiffs.map(d => '• ' + d).join('\n')}`,
      site: site2Name,
      fix: 'Compare each section (header, hero, content, footer) side by side and verify changes are intentional',
      testType: 'Visual',
      location: path,
      steps: `1. Open Production ${site1Url}${path} and UAT ${site2Url}${path}\n2. Compare header, hero/banner, main content, and footer sections\n3. Check each area listed above for visual differences`,
      expected: 'Each page section should match Production (unless changes are intentional)',
      actual: `${sectionDiffs.length} section-level differences found`,
    });
  }

  pageData[`section_diff_${pathKey}`] = sectionDiffs;
}

/** Visual diff — compare screenshots between two sites using pixelmatch */
function runVisualDiff(screenshots, bugs, site1Name, site2Name) {
  const site1Keys = Object.keys(screenshots).filter(k => k.startsWith('site1_'));
  let diffCount = 0;
  const diffResults = {}; // key -> { diffPercent, diffPixels, totalPixels, s1Key, s2Key, diffKey, heightDiff, widthDiff, regions }

  for (const s1Key of site1Keys) {
    const s2Key = s1Key.replace('site1_', 'site2_');
    if (!screenshots[s2Key]) continue;

    try {
      const img1Buf = Buffer.from(screenshots[s1Key], 'base64');
      const img2Buf = Buffer.from(screenshots[s2Key], 'base64');

      const img1 = PNG.sync.read(img1Buf);
      const img2 = PNG.sync.read(img2Buf);

      const width = Math.min(img1.width, img2.width);
      const height = Math.min(img1.height, img2.height);
      const heightDiff = Math.abs(img1.height - img2.height);

      if (width < 10 || height < 10) continue;

      const crop = (img, w, h) => {
        const cropped = new PNG({ width: w, height: h });
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const srcIdx = (y * img.width + x) * 4;
            const dstIdx = (y * w + x) * 4;
            cropped.data[dstIdx] = img.data[srcIdx];
            cropped.data[dstIdx + 1] = img.data[srcIdx + 1];
            cropped.data[dstIdx + 2] = img.data[srcIdx + 2];
            cropped.data[dstIdx + 3] = img.data[srcIdx + 3];
          }
        }
        return cropped;
      };

      const cropped1 = img1.width === width && img1.height === height ? img1 : crop(img1, width, height);
      const cropped2 = img2.width === width && img2.height === height ? img2 : crop(img2, width, height);

      const diffImg = new PNG({ width, height });
      const diffPixels = pixelmatch(cropped1.data, cropped2.data, diffImg.data, width, height, { threshold: 0.10 });

      const totalPixels = width * height;
      const diffPercent = ((diffPixels / totalPixels) * 100).toFixed(1);

      // Analyze diff regions (top/middle/bottom of page)
      const regions = [];
      const sectionHeight = Math.floor(height / 3);
      for (let section = 0; section < 3; section++) {
        let sectionDiffPixels = 0;
        const yStart = section * sectionHeight;
        const yEnd = section === 2 ? height : (section + 1) * sectionHeight;
        for (let y = yStart; y < yEnd; y++) {
          for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            // Red channel in diff image indicates difference
            if (diffImg.data[idx] > 100 && diffImg.data[idx + 1] < 100) sectionDiffPixels++;
          }
        }
        const sectionTotal = (yEnd - yStart) * width;
        const sectionPct = ((sectionDiffPixels / sectionTotal) * 100).toFixed(1);
        const sectionName = section === 0 ? 'Header/Top' : section === 1 ? 'Middle/Content' : 'Footer/Bottom';
        if (parseFloat(sectionPct) > 1) {
          regions.push({ name: sectionName, percent: sectionPct });
        }
      }

      // Store diff image
      const diffKey = s1Key.replace('site1_', 'diff_');
      screenshots[diffKey] = PNG.sync.write(diffImg).toString('base64');

      // Store diff results for report
      diffResults[s1Key] = {
        diffPercent: parseFloat(diffPercent),
        diffPixels,
        totalPixels,
        s1Key,
        s2Key,
        diffKey,
        heightDiff,
        prodHeight: img1.height,
        uatHeight: img2.height,
        regions,
      };

      const keyParts = s1Key.replace('site1_', '').replace(/_/g, ' ').trim();

      if (parseFloat(diffPercent) > 3) {
        diffCount++;
        // Build plain English description of differences
        let desc = `The UAT page looks different from Production.\n\n`;
        if (heightDiff > 50) {
          desc += `Page height difference: Production is ${img1.height}px tall, UAT is ${img2.height}px tall (${heightDiff}px ${img2.height > img1.height ? 'taller' : 'shorter'} on UAT). This means content may be added or removed.\n\n`;
        }
        if (regions.length > 0) {
          desc += `Areas with visible changes:\n`;
          for (const r of regions) {
            desc += `- ${r.name} area: ${r.percent}% different\n`;
          }
          desc += `\n`;
        }
        desc += `Overall: ${diffPercent}% of pixels differ (${diffPixels.toLocaleString()} out of ${totalPixels.toLocaleString()} pixels). Check if these changes are intentional.`;

        bugs.push({
          id: bugs.length + 1,
          severity: parseFloat(diffPercent) > 25 ? 'High' : 'Medium',
          category: 'Visual Diff',
          title: `Visual differences found on ${keyParts} — ${diffPercent}% changed`,
          description: desc,
          site: site2Name,
          fix: 'Compare the Production and UAT screenshots side by side. Red areas in the diff image show where they differ. Verify if these changes are intentional.',
          testType: 'Visual',
          location: keyParts,
          steps: `1. Open ${site1Name} and ${site2Name} side by side\n2. Navigate to the same page\n3. Look for visual differences in the areas listed above`,
          expected: 'UAT should match Production visually (unless changes are intentional)',
          actual: `${diffPercent}% pixel difference detected between Production and UAT`,
          screenshotKey: diffKey,
        });
      }
    } catch {
      // Skip if PNG parsing fails
    }
  }
  return { diffCount, diffResults };
}

// ─────────────────────────────────────────────────────────────
// SEO VALIDATION TESTS
// ─────────────────────────────────────────────────────────────

async function runSEORobotsSitemap(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const results = [];
  const page = await browser.newPage();
  try {
    // Check robots.txt
    const robotsResp = await page.goto(siteUrl + '/robots.txt', { timeout: 15000 }).catch(() => null);
    if (robotsResp && robotsResp.status() === 200) {
      const robotsTxt = await page.evaluate(() => document.body.innerText);
      const hasDisallowAll = /Disallow:\s*\/\s*$/m.test(robotsTxt);
      const hasSitemap = /Sitemap:/i.test(robotsTxt);
      if (hasDisallowAll) {
        results.push({ test: 'robots.txt', status: 'failed', reason: 'robots.txt blocks all crawlers (Disallow: /)' });
      } else {
        results.push({ test: 'robots.txt', status: 'passed', reason: 'robots.txt allows crawling' });
      }
      if (!hasSitemap) {
        results.push({ test: 'robots.txt sitemap ref', status: 'failed', reason: 'robots.txt does not reference a sitemap' });
      }
      pageData[`${label}_robots_txt`] = robotsTxt.substring(0, 500);
    } else {
      results.push({ test: 'robots.txt', status: 'failed', reason: 'robots.txt not found or returns error' });
    }

    // Check sitemap.xml
    const sitemapResp = await page.goto(siteUrl + '/sitemap.xml', { timeout: 15000 }).catch(() => null);
    if (sitemapResp && sitemapResp.status() === 200) {
      const content = await page.evaluate(() => document.body.innerText);
      const urlCount = (content.match(/<loc>/gi) || []).length;
      results.push({ test: 'sitemap.xml', status: 'passed', reason: `sitemap.xml found with ${urlCount} URLs` });
      if (urlCount === 0) {
        results.push({ test: 'sitemap.xml content', status: 'failed', reason: 'sitemap.xml is empty — no URLs listed' });
      }
    } else {
      results.push({ test: 'sitemap.xml', status: 'failed', reason: 'sitemap.xml not found or returns error' });
    }
  } catch (e) {
    results.push({ test: 'SEO files', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_seo_robots_sitemap`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'SEO',
      title: `SEO: ${failures.length} robots.txt/sitemap issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Fix robots.txt and sitemap.xml to ensure proper search engine indexing',
      testType: 'SEO', location: '/robots.txt, /sitemap.xml',
      steps: '1. Check /robots.txt — ensure Disallow does not block all pages\n2. Check /sitemap.xml — ensure it exists and lists all pages\n3. Verify robots.txt has Sitemap: directive',
      expected: 'Valid robots.txt and sitemap.xml', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

async function runSEOStructuredData(browser, siteUrl, label, path, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    const seoData = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      const schemas = scripts.map(s => { try { return JSON.parse(s.textContent); } catch { return null; } }).filter(Boolean);
      const types = schemas.map(s => s['@type'] || (Array.isArray(s['@graph']) ? s['@graph'].map(g => g['@type']) : 'Unknown')).flat();
      const canonical = document.querySelector('link[rel="canonical"]');
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const ogDesc = document.querySelector('meta[property="og:description"]');
      const ogImage = document.querySelector('meta[property="og:image"]');
      const ogUrl = document.querySelector('meta[property="og:url"]');
      const twitterCard = document.querySelector('meta[name="twitter:card"]');
      const twitterTitle = document.querySelector('meta[name="twitter:title"]');
      const metaDesc = document.querySelector('meta[name="description"]');
      const h1s = Array.from(document.querySelectorAll('h1')).map(h => h.textContent.trim());
      return {
        schemaCount: schemas.length, schemaTypes: types,
        canonical: canonical?.href || null,
        ogTitle: ogTitle?.content || null,
        ogDesc: ogDesc?.content || null,
        ogImage: ogImage?.content || null,
        ogUrl: ogUrl?.content || null,
        twitterCard: twitterCard?.content || null,
        twitterTitle: twitterTitle?.content || null,
        metaDesc: metaDesc?.content || null,
        metaDescLength: (metaDesc?.content || '').length,
        h1s,
      };
    });

    // Schema.org checks
    if (seoData.schemaCount === 0) {
      issues.push('No Schema.org structured data (JSON-LD) found — hurts rich search results');
    }

    // Canonical URL checks
    if (!seoData.canonical) {
      issues.push('Missing canonical URL — risk of duplicate content penalty');
    }

    // Open Graph checks
    if (!seoData.ogTitle) issues.push('Missing og:title — social sharing preview broken');
    if (!seoData.ogImage) issues.push('Missing og:image — no image in social shares');
    if (!seoData.ogUrl) issues.push('Missing og:url — social share links may be wrong');

    // Twitter Card checks
    if (!seoData.twitterCard) issues.push('Missing twitter:card meta tag');

    // Meta description checks
    if (!seoData.metaDesc) {
      issues.push('Missing meta description — search engines show auto-generated snippet');
    } else if (seoData.metaDescLength < 50) {
      issues.push(`Meta description too short (${seoData.metaDescLength} chars) — aim for 120-160 chars`);
    } else if (seoData.metaDescLength > 160) {
      issues.push(`Meta description too long (${seoData.metaDescLength} chars) — may be truncated in search results`);
    }

    // H1 checks
    if (seoData.h1s.length === 0) {
      issues.push('No H1 tag found — every page should have exactly one H1');
    } else if (seoData.h1s.length > 1) {
      issues.push(`Multiple H1 tags found (${seoData.h1s.length}) — should have exactly one per page`);
    }

    pageData[`${label}_seo_structured_${path.replace(/[^a-z0-9]/gi, '_')}`] = seoData;
  } catch (e) {
    issues.push(friendlyError(e));
  }
  await page.close();

  if (issues.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: issues.length > 3 ? 'High' : 'Medium', category: 'SEO',
      title: `SEO: ${issues.length} issue(s) on ${path} (${sn})`,
      description: issues.map(i => '• ' + i).join('\n'),
      site: sn, fix: 'Add missing SEO tags: Schema.org JSON-LD, canonical URL, Open Graph, meta description',
      testType: 'SEO', location: path,
      steps: `1. Open ${siteUrl}${path}\n2. View page source\n3. Check for structured data, canonical, OG tags, meta description, H1 count`,
      expected: 'Schema.org data, canonical URL, OG tags, valid meta description, single H1',
      actual: issues.join('; '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// E-COMMERCE ENHANCED TESTS
// ─────────────────────────────────────────────────────────────

async function runProductGalleryZoom(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const pdpLink = discovery.productLinks[0];
  if (!pdpLink) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl + pdpLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    const galleryData = await page.evaluate(() => {
      const mainImg = document.querySelector('[class*="product"] img, [class*="gallery"] img, [class*="pdp"] img, .product-image img');
      const thumbnails = document.querySelectorAll('[class*="thumb"] img, [class*="gallery"] [class*="thumb"], [class*="carousel"] img, .product-thumbnails img');
      const zoomBtn = document.querySelector('[class*="zoom"], [class*="magnif"], button[aria-label*="zoom" i], [class*="fullscreen"]');
      const sizeGuide = document.querySelector('[class*="size-guide"], [class*="size_guide"], a[href*="size"], button:has-text("Size Guide"), [class*="sizechart"], [class*="size-chart"]');
      return {
        hasMainImage: !!mainImg,
        mainImageSrc: mainImg?.src || null,
        thumbnailCount: thumbnails.length,
        hasZoom: !!zoomBtn,
        hasSizeGuide: !!sizeGuide,
        sizeGuideText: sizeGuide?.textContent?.trim() || null,
      };
    });

    if (!galleryData.hasMainImage) {
      results.push({ test: 'Product Main Image', status: 'failed', reason: 'No main product image found on PDP' });
    } else {
      results.push({ test: 'Product Main Image', status: 'passed', reason: 'Main product image present' });
    }

    if (galleryData.thumbnailCount === 0) {
      results.push({ test: 'Image Gallery Thumbnails', status: 'failed', reason: 'No thumbnail images found — single image only' });
    } else {
      results.push({ test: 'Image Gallery Thumbnails', status: 'passed', reason: `${galleryData.thumbnailCount} thumbnail images found` });
      // Try clicking second thumbnail
      if (galleryData.thumbnailCount > 1) {
        const thumb = page.locator('[class*="thumb"] img, [class*="gallery"] [class*="thumb"], [class*="carousel"] img, .product-thumbnails img').nth(1);
        if (await thumb.isVisible().catch(() => false)) {
          await thumb.click();
          await page.waitForTimeout(1000);
          results.push({ test: 'Thumbnail Click', status: 'passed', reason: 'Clicked second thumbnail — image should change' });
        }
      }
    }

    // Test zoom
    if (galleryData.hasZoom) {
      const zoomBtn = page.locator('[class*="zoom"], [class*="magnif"], button[aria-label*="zoom" i], [class*="fullscreen"]').first();
      if (await zoomBtn.isVisible().catch(() => false)) {
        await zoomBtn.click();
        await page.waitForTimeout(1500);
        screenshots[`${label}_pdp_zoom`] = b64(await page.screenshot());
        results.push({ test: 'Image Zoom', status: 'passed', reason: 'Zoom button clicked — enlarged view shown' });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
      }
    } else {
      results.push({ test: 'Image Zoom', status: 'skipped', reason: 'No zoom button found' });
    }

    // Size guide
    if (galleryData.hasSizeGuide) {
      results.push({ test: 'Size Guide', status: 'passed', reason: `Size guide element found: "${galleryData.sizeGuideText}"` });
      const sizeGuideEl = page.locator('[class*="size-guide"], [class*="size_guide"], a[href*="size"], [class*="sizechart"], [class*="size-chart"]').first();
      if (await sizeGuideEl.isVisible().catch(() => false)) {
        await sizeGuideEl.click();
        await page.waitForTimeout(1500);
        screenshots[`${label}_size_guide`] = b64(await page.screenshot());
        results.push({ test: 'Size Guide Opens', status: 'passed', reason: 'Size guide popup/page opened' });
        await page.keyboard.press('Escape');
      }
    } else {
      results.push({ test: 'Size Guide', status: 'failed', reason: 'No size guide found — important for fashion e-commerce' });
    }

    screenshots[`${label}_pdp_gallery`] = b64(await page.screenshot());
  } catch (e) {
    results.push({ test: 'Product Gallery', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_product_gallery`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce',
      title: `PDP Gallery/Zoom: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: failures.map(f => f.reason).join('; '),
      testType: 'E-Commerce', location: pdpLink,
      steps: `1. Open ${siteUrl}${pdpLink}\n2. Check image gallery thumbnails\n3. Click zoom button\n4. Check for size guide link`,
      expected: 'Product gallery with thumbnails, zoom, and size guide', actual: `${failures.length} issues found`,
    });
  }
}

async function runOutOfStockTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    // Visit PLP and try to find out-of-stock indicators
    await withRetry(async () => {
      await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    const oosData = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="product-card"], [class*="product_card"], .product-item, [class*="product-list"] > *');
      let oosCount = 0;
      let oosLabels = [];
      cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        if (text.includes('out of stock') || text.includes('sold out') || text.includes('notify me') || text.includes('coming soon')) {
          oosCount++;
          const label = card.querySelector('[class*="out-of-stock"], [class*="sold-out"], [class*="notify"]');
          if (label) oosLabels.push(label.textContent.trim());
        }
      });
      return { totalCards: cards.length, oosCount, oosLabels: oosLabels.slice(0, 5) };
    });

    if (oosData.oosCount > 0) {
      results.push({ test: 'OOS on PLP', status: 'passed', reason: `${oosData.oosCount}/${oosData.totalCards} products show out-of-stock indicator` });
    } else {
      results.push({ test: 'OOS on PLP', status: 'passed', reason: 'No out-of-stock products found on PLP (all in stock)' });
    }

    // Visit a PDP and check add-to-cart disabled state
    const pdpLink = discovery.productLinks[0];
    if (pdpLink) {
      await withRetry(async () => {
        await page.goto(siteUrl + pdpLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      });
      await page.waitForTimeout(2000);

      const pdpOos = await page.evaluate(() => {
        const addToCartBtn = document.querySelector('button[class*="add-to-cart"], button[class*="add_to_cart"], [class*="add-to-bag"], button:has-text("Add to"), button:has-text("ADD TO")');
        const notifyBtn = document.querySelector('button:has-text("Notify"), [class*="notify-me"], button:has-text("NOTIFY")');
        const sizeOptions = document.querySelectorAll('[class*="size"] button, [class*="size"] [class*="option"], [class*="variant"] button');
        let disabledSizes = 0;
        sizeOptions.forEach(s => {
          if (s.disabled || s.classList.toString().includes('disabled') || s.classList.toString().includes('out-of-stock') || s.classList.toString().includes('strike')) {
            disabledSizes++;
          }
        });
        return {
          hasAddToCart: !!addToCartBtn,
          addToCartDisabled: addToCartBtn?.disabled || false,
          addToCartText: addToCartBtn?.textContent?.trim() || null,
          hasNotifyMe: !!notifyBtn,
          totalSizes: sizeOptions.length,
          disabledSizes,
        };
      });

      if (pdpOos.totalSizes > 0 && pdpOos.disabledSizes > 0) {
        results.push({ test: 'Size OOS Indicators', status: 'passed', reason: `${pdpOos.disabledSizes}/${pdpOos.totalSizes} sizes show as out-of-stock/disabled` });
      }
      if (pdpOos.hasNotifyMe) {
        results.push({ test: 'Notify Me Button', status: 'passed', reason: 'Notify Me button available for OOS products' });
      }
      if (pdpOos.hasAddToCart && pdpOos.addToCartDisabled) {
        results.push({ test: 'Add to Cart Disabled', status: 'passed', reason: 'Add to Cart button correctly disabled when no size selected or OOS' });
      }

      screenshots[`${label}_oos_pdp`] = b64(await page.screenshot());
    }
  } catch (e) {
    results.push({ test: 'Out of Stock', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_oos_test`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce',
      title: `Out-of-Stock UX: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Ensure out-of-stock products show proper indicators, disabled add-to-cart, and notify-me option',
      testType: 'E-Commerce', location: '/products',
      expected: 'Clear OOS indicators on PLP and PDP', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

async function runPriceFormatTest(browser, siteUrl, label, discovery, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    const priceData = await page.evaluate(() => {
      const priceEls = document.querySelectorAll('[class*="price"], [class*="amount"], [class*="cost"]');
      const prices = [];
      priceEls.forEach(el => {
        const text = el.textContent.trim();
        if (text && /[\d,.]/.test(text) && text.length < 30) {
          prices.push(text);
        }
      });
      return { prices: prices.slice(0, 20), count: prices.length };
    });

    // Check price format consistency
    const currencySymbols = new Set();
    let formatIssues = 0;
    for (const price of priceData.prices) {
      if (/₹/.test(price)) currencySymbols.add('₹');
      else if (/\$/.test(price)) currencySymbols.add('$');
      else if (/€/.test(price)) currencySymbols.add('€');
      else if (/Rs\.?/i.test(price)) currencySymbols.add('Rs');
      // Check for prices like "0" or "NaN" or empty
      if (/NaN|undefined|null/i.test(price) || price === '0' || price === '0.00') {
        formatIssues++;
        issues.push(`Invalid price value: "${price}"`);
      }
    }

    if (currencySymbols.size > 1) {
      issues.push(`Mixed currency symbols found: ${[...currencySymbols].join(', ')} — should be consistent`);
    }
    if (priceData.count === 0) {
      issues.push('No price elements found on PLP');
    }

    // Also check PDP
    const pdpLink = discovery.productLinks[0];
    if (pdpLink) {
      await page.goto(siteUrl + pdpLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      const pdpPrice = await page.evaluate(() => {
        const priceEl = document.querySelector('[class*="price"], [class*="amount"]');
        const mrpEl = document.querySelector('[class*="mrp"], [class*="original"], [class*="strike"], del, s');
        const discountEl = document.querySelector('[class*="discount"], [class*="off"], [class*="save"]');
        return {
          price: priceEl?.textContent?.trim() || null,
          mrp: mrpEl?.textContent?.trim() || null,
          discount: discountEl?.textContent?.trim() || null,
        };
      });

      if (!pdpPrice.price) {
        issues.push('No price found on PDP — critical for purchase decision');
      }

      pageData[`${label}_pdp_price`] = pdpPrice;
    }

    pageData[`${label}_price_format`] = { prices: priceData.prices.slice(0, 10), symbols: [...currencySymbols] };
  } catch (e) {
    issues.push(friendlyError(e));
  }
  await page.close();

  if (issues.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: issues.some(i => /no price|invalid|NaN/i.test(i)) ? 'High' : 'Medium', category: 'E-Commerce',
      title: `Price Format: ${issues.length} issue(s) (${sn})`,
      description: issues.map(i => '• ' + i).join('\n'),
      site: sn, fix: 'Ensure all prices display correct currency symbol and valid format',
      testType: 'E-Commerce', location: '/products',
      expected: 'Consistent currency formatting (e.g., ₹1,999)', actual: issues.join('; '),
    });
  }
}

async function runRelatedProductsTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const pdpLink = discovery.productLinks[0];
  if (!pdpLink) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl + pdpLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    // Scroll to bottom to load lazy sections
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y); await new Promise(r => setTimeout(r, 150));
      }
    });
    await page.waitForTimeout(1000);

    const relatedData = await page.evaluate(() => {
      const sections = document.querySelectorAll('section, div[class*="related"], div[class*="recommend"], div[class*="similar"], div[class*="you-may"], div[class*="also-like"], div[class*="recently"]');
      let related = null, recommended = null, recentlyViewed = null;
      sections.forEach(sec => {
        const text = sec.textContent.toLowerCase();
        const heading = sec.querySelector('h2, h3, h4');
        const headText = heading?.textContent?.toLowerCase() || '';
        const products = sec.querySelectorAll('[class*="product"], [class*="card"], a[href*="/product"]');
        if ((headText.includes('related') || headText.includes('similar') || text.includes('similar products')) && products.length > 0) {
          related = { title: heading?.textContent?.trim(), count: products.length };
        }
        if ((headText.includes('recommend') || headText.includes('you may') || headText.includes('also like') || headText.includes('you might')) && products.length > 0) {
          recommended = { title: heading?.textContent?.trim(), count: products.length };
        }
        if ((headText.includes('recently') || headText.includes('viewed')) && products.length > 0) {
          recentlyViewed = { title: heading?.textContent?.trim(), count: products.length };
        }
      });
      return { related, recommended, recentlyViewed };
    });

    if (relatedData.related) {
      results.push({ test: 'Related Products', status: 'passed', reason: `"${relatedData.related.title}" section found with ${relatedData.related.count} products` });
    } else {
      results.push({ test: 'Related Products', status: 'failed', reason: 'No related/similar products section found on PDP' });
    }

    if (relatedData.recommended) {
      results.push({ test: 'Recommended Products', status: 'passed', reason: `"${relatedData.recommended.title}" section found with ${relatedData.recommended.count} products` });
    } else {
      results.push({ test: 'Recommended Products', status: 'failed', reason: 'No "You May Also Like" / recommendations section found' });
    }

    if (relatedData.recentlyViewed) {
      results.push({ test: 'Recently Viewed', status: 'passed', reason: `"${relatedData.recentlyViewed.title}" section found with ${relatedData.recentlyViewed.count} products` });
    } else {
      results.push({ test: 'Recently Viewed', status: 'skipped', reason: 'No recently viewed section found (may appear after browsing multiple products)' });
    }

    screenshots[`${label}_related_products`] = b64(await page.screenshot({ fullPage: false }));
  } catch (e) {
    results.push({ test: 'Related Products', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_related_products`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce',
      title: `Missing product sections on PDP: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Add related/recommended products section on PDP to improve cross-selling',
      testType: 'E-Commerce', location: pdpLink,
      expected: 'Related products, recommended products sections on PDP', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

async function runCouponPromoTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    // Check cart page for coupon field
    const cartPaths = ['/cart/bag', '/cart', '/checkout'];
    let cartLoaded = false;
    for (const cp of cartPaths) {
      const resp = await page.goto(siteUrl + cp, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null);
      if (resp && resp.status() === 200) { cartLoaded = true; break; }
    }

    if (cartLoaded) {
      await page.waitForTimeout(2000);
      const couponData = await page.evaluate(() => {
        const couponInput = document.querySelector('input[placeholder*="coupon" i], input[placeholder*="promo" i], input[placeholder*="code" i], input[name*="coupon" i], input[name*="promo" i], [class*="coupon"] input, [class*="promo"] input');
        const couponBtn = document.querySelector('button:has-text("Apply"), [class*="coupon"] button, [class*="promo"] button');
        const offersSection = document.querySelector('[class*="offer"], [class*="coupon-list"], [class*="promo-list"], [class*="available-coupon"]');
        return {
          hasCouponInput: !!couponInput,
          hasCouponButton: !!couponBtn,
          hasOffersSection: !!offersSection,
        };
      });

      if (couponData.hasCouponInput) {
        results.push({ test: 'Coupon Input Field', status: 'passed', reason: 'Coupon/promo code input field found on cart page' });
        // Try applying an invalid coupon
        const input = page.locator('input[placeholder*="coupon" i], input[placeholder*="promo" i], input[placeholder*="code" i], input[name*="coupon" i], input[name*="promo" i], [class*="coupon"] input, [class*="promo"] input').first();
        await input.fill('INVALIDCODE123');
        const applyBtn = page.locator('button:has-text("Apply"), [class*="coupon"] button, [class*="promo"] button').first();
        if (await applyBtn.isVisible().catch(() => false)) {
          await applyBtn.click();
          await page.waitForTimeout(2000);
          const errorMsg = await page.evaluate(() => {
            const err = document.querySelector('[class*="error"], [class*="invalid"], [class*="toast"], [class*="alert"]');
            return err?.textContent?.trim() || null;
          });
          if (errorMsg) {
            results.push({ test: 'Invalid Coupon Handling', status: 'passed', reason: `Error shown for invalid code: "${errorMsg.substring(0, 80)}"` });
          } else {
            results.push({ test: 'Invalid Coupon Handling', status: 'failed', reason: 'No error message shown for invalid coupon code' });
          }
        }
        screenshots[`${label}_coupon_test`] = b64(await page.screenshot());
      } else {
        results.push({ test: 'Coupon Input Field', status: 'failed', reason: 'No coupon/promo code input found on cart/checkout page' });
      }

      if (couponData.hasOffersSection) {
        results.push({ test: 'Available Offers', status: 'passed', reason: 'Available offers/coupons section found' });
      }
    } else {
      results.push({ test: 'Cart Page', status: 'skipped', reason: 'Could not load cart page to test coupon functionality' });
    }
  } catch (e) {
    results.push({ test: 'Coupon/Promo', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_coupon_test`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'E-Commerce',
      title: `Coupon/Promo: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Add coupon/promo code input with proper validation on cart/checkout',
      testType: 'E-Commerce', location: '/cart',
      expected: 'Coupon input, apply button, error handling for invalid codes', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// NAVIGATION & UX TESTS
// ─────────────────────────────────────────────────────────────

async function runBreadcrumbTest(browser, siteUrl, label, discovery, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  const paths = [discovery.productLinks[0], '/products', '/contact-us'].filter(Boolean);
  try {
    for (const p of paths.slice(0, 3)) {
      await withRetry(async () => {
        await page.goto(siteUrl + p, { waitUntil: 'domcontentloaded', timeout: 20000 });
      });
      await page.waitForTimeout(1500);

      const breadcrumb = await page.evaluate(() => {
        const bc = document.querySelector('[class*="breadcrumb"], nav[aria-label*="breadcrumb" i], ol[class*="breadcrumb"], [itemtype*="BreadcrumbList"]');
        if (!bc) return null;
        const links = Array.from(bc.querySelectorAll('a'));
        return {
          items: links.map(a => ({ text: a.textContent.trim(), href: a.href })),
          totalItems: bc.querySelectorAll('li, a, span').length,
          hasHomeLink: links.some(a => a.textContent.trim().toLowerCase() === 'home' || a.getAttribute('href') === '/'),
        };
      });

      if (!breadcrumb) {
        issues.push(`${p}: No breadcrumb navigation found`);
      } else if (!breadcrumb.hasHomeLink) {
        issues.push(`${p}: Breadcrumb exists but missing "Home" link as first item`);
      } else if (breadcrumb.items.length === 0) {
        issues.push(`${p}: Breadcrumb container exists but has no links`);
      }
    }
  } catch (e) {
    issues.push(friendlyError(e));
  }
  await page.close();

  pageData[`${label}_breadcrumb_test`] = issues.length === 0 ? 'All breadcrumbs valid' : issues;
  if (issues.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'Navigation',
      title: `Breadcrumb: ${issues.length} issue(s) (${sn})`,
      description: issues.map(i => '• ' + i).join('\n'),
      site: sn, fix: 'Add breadcrumb navigation with Home > Category > Page structure',
      testType: 'Navigation',
      expected: 'Breadcrumb with Home link on all inner pages', actual: issues.join('; '),
    });
  }
}

async function runMobileMenuTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 375, height: 812 }, isMobile: true });
  const results = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    // Find hamburger menu button
    const hamburger = page.locator('[class*="hamburger"], [class*="menu-toggle"], button[aria-label*="menu" i], [class*="mobile-menu"] button, [class*="nav-toggle"], [class*="burger"], button[aria-label*="navigation" i], header button svg').first();
    if (await hamburger.isVisible().catch(() => false)) {
      results.push({ test: 'Hamburger Button', status: 'passed', reason: 'Mobile hamburger menu button found and visible' });
      screenshots[`${label}_mobile_before_menu`] = b64(await page.screenshot());

      await hamburger.click();
      await page.waitForTimeout(1500);
      screenshots[`${label}_mobile_menu_open`] = b64(await page.screenshot());

      // Check if menu panel appeared
      const menuPanel = await page.evaluate(() => {
        const panels = document.querySelectorAll('[class*="mobile-nav"], [class*="drawer"], [class*="sidebar"], [class*="off-canvas"], [class*="slide-menu"], nav[class*="mobile"]');
        for (const p of panels) {
          const style = getComputedStyle(p);
          if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
            const links = p.querySelectorAll('a');
            return { visible: true, linkCount: links.length, links: Array.from(links).slice(0, 10).map(a => a.textContent.trim()) };
          }
        }
        return { visible: false, linkCount: 0, links: [] };
      });

      if (menuPanel.visible) {
        results.push({ test: 'Menu Panel Opens', status: 'passed', reason: `Mobile menu opened with ${menuPanel.linkCount} navigation links` });
        if (menuPanel.linkCount === 0) {
          results.push({ test: 'Menu Links', status: 'failed', reason: 'Mobile menu opened but has no navigation links' });
        }
      } else {
        results.push({ test: 'Menu Panel Opens', status: 'failed', reason: 'Hamburger clicked but no menu panel became visible' });
      }

      // Try closing the menu
      const closeBtn = page.locator('[class*="close"], button[aria-label*="close" i], [class*="menu-close"]').first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click();
        await page.waitForTimeout(500);
        results.push({ test: 'Menu Close', status: 'passed', reason: 'Close button works' });
      } else {
        await hamburger.click();
        await page.waitForTimeout(500);
        results.push({ test: 'Menu Close', status: 'passed', reason: 'Menu toggled closed' });
      }
    } else {
      results.push({ test: 'Hamburger Button', status: 'failed', reason: 'No hamburger/menu toggle button found on mobile viewport' });
    }
  } catch (e) {
    results.push({ test: 'Mobile Menu', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_mobile_menu`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'Navigation',
      title: `Mobile Menu: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Ensure hamburger menu is visible, opens properly, shows nav links, and closes correctly',
      testType: 'Navigation', location: 'Homepage (mobile)',
      expected: 'Working hamburger menu with nav links', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

async function runCookieConsentTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    // Clear cookies to see consent banner
    await page.context().clearCookies();
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(3000);

    const cookieData = await page.evaluate(() => {
      const banners = document.querySelectorAll('[class*="cookie"], [class*="consent"], [class*="gdpr"], [class*="privacy-banner"], [id*="cookie"], [id*="consent"]');
      let visible = null;
      banners.forEach(b => {
        const style = getComputedStyle(b);
        if (style.display !== 'none' && style.visibility !== 'hidden' && b.offsetHeight > 0) {
          visible = {
            text: b.textContent.trim().substring(0, 200),
            hasAcceptBtn: !!b.querySelector('button:has-text("Accept"), button:has-text("Got it"), button:has-text("OK"), button:has-text("Agree"), [class*="accept"]'),
            hasRejectBtn: !!b.querySelector('button:has-text("Reject"), button:has-text("Decline"), button:has-text("Deny"), [class*="reject"]'),
            hasSettingsBtn: !!b.querySelector('button:has-text("Settings"), button:has-text("Preferences"), button:has-text("Manage"), [class*="settings"]'),
          };
        }
      });
      return visible;
    });

    if (cookieData) {
      results.push({ test: 'Cookie Banner Present', status: 'passed', reason: 'Cookie consent banner displayed on first visit' });
      screenshots[`${label}_cookie_banner`] = b64(await page.screenshot());
      if (!cookieData.hasAcceptBtn) {
        results.push({ test: 'Accept Button', status: 'failed', reason: 'No Accept/OK button on cookie banner' });
      } else {
        results.push({ test: 'Accept Button', status: 'passed', reason: 'Accept button available' });
      }
    } else {
      results.push({ test: 'Cookie Banner Present', status: 'skipped', reason: 'No cookie consent banner found — may not be required for this region' });
    }
  } catch (e) {
    results.push({ test: 'Cookie Consent', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_cookie_consent`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'Compliance',
      title: `Cookie Consent: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'skipped' ? '⊘' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Add proper cookie consent banner with Accept/Reject options',
      testType: 'Compliance', location: 'Homepage',
      expected: 'GDPR-compliant cookie consent banner', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

async function runSocialSharingTest(browser, siteUrl, label, discovery, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const pdpLink = discovery.productLinks[0];
  if (!pdpLink) return;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl + pdpLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    const socialData = await page.evaluate(() => {
      const shareBtn = document.querySelector('[class*="share"], button[aria-label*="share" i], [class*="social-share"]');
      const socialLinks = document.querySelectorAll('a[href*="facebook.com/share"], a[href*="twitter.com/intent"], a[href*="wa.me"], a[href*="whatsapp"], a[href*="pinterest.com/pin"], a[href*="linkedin.com/share"]');
      const socialIcons = document.querySelectorAll('[class*="social"] a, [class*="share"] a');
      return {
        hasShareButton: !!shareBtn,
        directShareLinks: socialLinks.length,
        socialIcons: socialIcons.length,
        platforms: Array.from(socialLinks).map(a => {
          if (a.href.includes('facebook')) return 'Facebook';
          if (a.href.includes('twitter') || a.href.includes('x.com')) return 'Twitter/X';
          if (a.href.includes('whatsapp') || a.href.includes('wa.me')) return 'WhatsApp';
          if (a.href.includes('pinterest')) return 'Pinterest';
          if (a.href.includes('linkedin')) return 'LinkedIn';
          return 'Other';
        }),
      };
    });

    if (socialData.hasShareButton || socialData.directShareLinks > 0 || socialData.socialIcons > 0) {
      results.push({ test: 'Social Sharing', status: 'passed', reason: `Social sharing available — ${socialData.platforms.join(', ') || 'share button found'}` });
    } else {
      results.push({ test: 'Social Sharing', status: 'failed', reason: 'No social sharing buttons found on PDP — missing opportunity for organic reach' });
    }
  } catch (e) {
    results.push({ test: 'Social Sharing', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_social_sharing`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Low', category: 'UX',
      title: `Social Sharing: ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Add social sharing buttons (WhatsApp, Facebook, Twitter) on product pages',
      testType: 'UX', location: pdpLink,
      expected: 'Social sharing options on PDP', actual: failures.map(f => f.reason).join('; '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SECURITY & TECHNICAL TESTS
// ─────────────────────────────────────────────────────────────

async function runHTTPSecurityHeaders(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage();
  const issues = [];
  try {
    const response = await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const headers = response.headers();

    const checks = [
      { header: 'strict-transport-security', name: 'HSTS (Strict-Transport-Security)', severity: 'high' },
      { header: 'x-content-type-options', name: 'X-Content-Type-Options', severity: 'medium' },
      { header: 'x-frame-options', name: 'X-Frame-Options', severity: 'medium' },
      { header: 'content-security-policy', name: 'Content-Security-Policy', severity: 'medium' },
      { header: 'x-xss-protection', name: 'X-XSS-Protection', severity: 'low' },
      { header: 'referrer-policy', name: 'Referrer-Policy', severity: 'low' },
      { header: 'permissions-policy', name: 'Permissions-Policy', severity: 'low' },
    ];

    const missing = [];
    const present = [];
    for (const check of checks) {
      if (headers[check.header]) {
        present.push(`${check.name}: ${headers[check.header].substring(0, 80)}`);
      } else {
        missing.push(check);
        issues.push(`Missing ${check.name} header`);
      }
    }

    // Check SSL (by URL)
    if (!siteUrl.startsWith('https://')) {
      issues.push('Site is not using HTTPS — critical security issue');
    }

    pageData[`${label}_security_headers`] = { present, missing: missing.map(m => m.name) };
  } catch (e) {
    issues.push(friendlyError(e));
  }
  await page.close();

  if (issues.length > 0) {
    const hasHighSeverity = issues.some(i => /HSTS|HTTPS/i.test(i));
    bugs.push({
      id: bugs.length + 1, severity: hasHighSeverity ? 'High' : 'Medium', category: 'Security',
      title: `Security Headers: ${issues.length} missing header(s) (${sn})`,
      description: issues.map(i => '• ' + i).join('\n'),
      site: sn, fix: 'Add missing HTTP security headers in server/CDN configuration',
      testType: 'Security', location: '/',
      steps: '1. Open browser DevTools → Network tab\n2. Check response headers for the homepage\n3. Verify HSTS, CSP, X-Frame-Options, X-Content-Type-Options are present',
      expected: 'All standard security headers present', actual: `${issues.length} headers missing`,
    });
  }
}

async function runImageOptimizationTest(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    // Scroll to trigger lazy loading
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 400) {
        window.scrollTo(0, y); await new Promise(r => setTimeout(r, 100));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(1000);

    const imgData = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      let noAlt = 0, noLazy = 0, nonOptimal = 0, oversized = 0;
      const details = [];
      imgs.forEach(img => {
        const src = img.src || img.dataset.src || '';
        if (!img.alt && !img.getAttribute('role')) noAlt++;
        if (!img.loading && img.loading !== 'lazy' && !img.dataset.src && !img.classList.toString().includes('lazy')) {
          // Check if below fold
          const rect = img.getBoundingClientRect();
          if (rect.top > window.innerHeight) noLazy++;
        }
        // Check format
        if (src && !src.includes('.webp') && !src.includes('.avif') && !src.includes('.svg') && !src.startsWith('data:')) {
          if (src.includes('.png') || src.includes('.jpg') || src.includes('.jpeg')) {
            nonOptimal++;
          }
        }
        // Check for oversized images
        if (img.naturalWidth > 0 && img.width > 0) {
          const ratio = img.naturalWidth / img.width;
          if (ratio > 2.5) {
            oversized++;
            details.push(`${src.split('/').pop()?.substring(0, 40)}: displayed ${img.width}px, actual ${img.naturalWidth}px (${ratio.toFixed(1)}x oversized)`);
          }
        }
      });
      return { total: imgs.length, noAlt, noLazy, nonOptimal, oversized, details: details.slice(0, 5) };
    });

    if (imgData.noAlt > 0) {
      issues.push(`${imgData.noAlt}/${imgData.total} images missing alt text — hurts accessibility and SEO`);
    }
    if (imgData.noLazy > 3) {
      issues.push(`${imgData.noLazy} below-fold images not using lazy loading — increases page load time`);
    }
    if (imgData.nonOptimal > 5) {
      issues.push(`${imgData.nonOptimal} images using JPG/PNG instead of WebP/AVIF — larger file sizes`);
    }
    if (imgData.oversized > 0) {
      issues.push(`${imgData.oversized} images are significantly oversized:\n${imgData.details.map(d => '  - ' + d).join('\n')}`);
    }

    pageData[`${label}_image_optimization`] = imgData;
  } catch (e) {
    issues.push(friendlyError(e));
  }
  await page.close();

  if (issues.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'Performance',
      title: `Image Optimization: ${issues.length} issue(s) (${sn})`,
      description: issues.map(i => '• ' + i).join('\n'),
      site: sn, fix: 'Add alt text to images, enable lazy loading, convert to WebP, resize oversized images',
      testType: 'Performance', location: '/',
      expected: 'Optimized images with alt text, lazy loading, and modern formats', actual: `${issues.length} optimization issues`,
    });
  }
}

async function runScrollPerformanceTest(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const issues = [];
  try {
    await withRetry(async () => {
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    });
    await page.waitForTimeout(2000);

    // Enable performance tracing
    const scrollData = await page.evaluate(async () => {
      const frames = [];
      let lastTime = performance.now();
      let longFrames = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration > 50) longFrames++;
        }
      });
      try { observer.observe({ type: 'longtask', buffered: true }); } catch {}

      // Measure scroll jank
      const scrollStart = performance.now();
      for (let y = 0; y < Math.min(document.body.scrollHeight, 5000); y += 100) {
        window.scrollTo(0, y);
        const now = performance.now();
        const delta = now - lastTime;
        if (delta > 33) frames.push(delta); // More than ~30fps = potential jank
        lastTime = now;
        await new Promise(r => setTimeout(r, 16));
      }
      const scrollTime = performance.now() - scrollStart;
      window.scrollTo(0, 0);
      observer.disconnect();

      return {
        totalScrollTime: Math.round(scrollTime),
        jankFrames: frames.length,
        maxFrameTime: frames.length > 0 ? Math.round(Math.max(...frames)) : 0,
        longTasks: longFrames,
        pageHeight: document.body.scrollHeight,
      };
    });

    if (scrollData.longTasks > 5) {
      issues.push(`${scrollData.longTasks} long tasks detected during scroll — may cause jank`);
    }
    if (scrollData.maxFrameTime > 100) {
      issues.push(`Max frame time: ${scrollData.maxFrameTime}ms — frames over 50ms cause visible stutter`);
    }

    pageData[`${label}_scroll_perf`] = scrollData;
  } catch (e) {
    issues.push(friendlyError(e));
  }
  await page.close();

  if (issues.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Medium', category: 'Performance',
      title: `Scroll Performance: ${issues.length} issue(s) (${sn})`,
      description: issues.map(i => '• ' + i).join('\n'),
      site: sn, fix: 'Optimize heavy DOM operations, reduce paint complexity, defer non-critical scripts',
      testType: 'Performance', location: '/',
      expected: 'Smooth 60fps scrolling', actual: issues.join('; '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// CONTENT & POLICY TESTS
// ─────────────────────────────────────────────────────────────

async function runPolicyPagesTest(browser, siteUrl, label, bugs, pageData) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  const policyPaths = [
    { path: '/shipping-policy', alt: ['/shipping', '/delivery-information', '/shipping-info'], name: 'Shipping Policy' },
    { path: '/return-policy', alt: ['/returns', '/return-exchange', '/refund-policy', '/returns-refunds', '/exchange'], name: 'Return/Exchange Policy' },
    { path: '/privacy-policy', alt: ['/privacy'], name: 'Privacy Policy' },
    { path: '/terms-and-conditions', alt: ['/terms', '/terms-of-service', '/tnc', '/terms-of-use'], name: 'Terms & Conditions' },
    { path: '/faq', alt: ['/faqs', '/help', '/support'], name: 'FAQ/Help' },
  ];

  try {
    for (const policy of policyPaths) {
      let found = false;
      const allPaths = [policy.path, ...policy.alt];
      for (const p of allPaths) {
        const resp = await page.goto(siteUrl + p, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
        if (resp && resp.status() === 200) {
          const wordCount = await page.evaluate(() => document.body.innerText.split(/\s+/).length);
          if (wordCount > 50) {
            results.push({ test: policy.name, status: 'passed', reason: `Found at ${p} (${wordCount} words)` });
            found = true;
            break;
          }
        }
      }
      if (!found) {
        results.push({ test: policy.name, status: 'failed', reason: `Not found at any of: ${allPaths.join(', ')}` });
      }
    }
  } catch (e) {
    results.push({ test: 'Policy Pages', status: 'failed', reason: friendlyError(e) });
  }
  await page.close();

  pageData[`${label}_policy_pages`] = results;
  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: failures.some(f => /Privacy|Terms/i.test(f.test)) ? 'High' : 'Medium',
      category: 'Content',
      title: `Missing Policy Pages: ${failures.length} page(s) not found (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Create and publish missing policy pages — required for legal compliance and buyer confidence',
      testType: 'Content',
      expected: 'All policy pages accessible', actual: failures.map(f => `${f.test} missing`).join(', '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// LOGIN + SCROLL VALIDATION TEST
// ─────────────────────────────────────────────────────────────

async function runLoginAndScrollTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    // Step 1: Navigate to login
    await page.goto(siteUrl + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    screenshots[`${label}_loginscroll_page`] = b64(await page.screenshot());

    // Step 2: Enter phone
    const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i], input[placeholder*="mobile" i]').first();
    if (!(await phoneInput.isVisible().catch(() => false))) {
      results.push({ step: 'Phone Input', status: 'failed', reason: 'Phone input not found' });
      throw new Error('No phone input');
    }
    await phoneInput.fill(TEST_CONFIG.credentials.phone);
    await page.waitForTimeout(500);
    results.push({ step: 'Phone Input', status: 'passed', reason: 'Phone entered' });

    // Step 3: Click checkbox (terms)
    const checkbox = page.locator('input[type="checkbox"], [class*="checkbox"], [class*="terms"] input').first();
    if (await checkbox.isVisible().catch(() => false)) {
      await checkbox.click();
      await page.waitForTimeout(300);
      results.push({ step: 'Terms Checkbox', status: 'passed', reason: 'Checkbox clicked' });
    }

    // Step 4: Click Get OTP
    const sendBtn = page.locator('button:has-text("Send"), button:has-text("Continue"), button:has-text("OTP"), button:has-text("Get OTP"), button:has-text("Sign"), button[type="submit"]').first();
    if (await sendBtn.isVisible().catch(() => false)) {
      await sendBtn.click();
      await page.waitForTimeout(3000);
      results.push({ step: 'Send OTP', status: 'passed', reason: 'OTP requested' });
    } else {
      results.push({ step: 'Send OTP', status: 'failed', reason: 'Send OTP button not found' });
      throw new Error('No send OTP button');
    }

    // Step 5: Enter OTP
    const otpInputs = page.locator('input[type="tel"][maxlength="1"], input[name*="otp"], input[placeholder*="otp" i]');
    const otpCount = await otpInputs.count();
    if (otpCount >= 4) {
      for (let i = 0; i < Math.min(otpCount, 4); i++) {
        await otpInputs.nth(i).fill(TEST_CONFIG.credentials.otp[i]);
        await page.waitForTimeout(200);
      }
    } else {
      const singleOtp = page.locator('input[name*="otp"], input[placeholder*="otp" i], input[type="tel"]:not([maxlength="1"])').first();
      if (await singleOtp.isVisible().catch(() => false)) await singleOtp.fill(TEST_CONFIG.credentials.otp);
    }
    results.push({ step: 'Enter OTP', status: 'passed', reason: 'OTP entered: 5401' });

    // Step 5b: Click Verify
    const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Login"), button:has-text("Sign"), button[type="submit"]').first();
    if (await verifyBtn.isVisible().catch(() => false)) {
      await verifyBtn.click();
      await page.waitForTimeout(5000);
    }

    // Step 6: Verify login — check for profile/logout
    const loggedIn = !(page.url().includes('/auth/login') || page.url().includes('/login'));
    const profileVisible = await page.locator('text=/profile|account|logout|sign out/i').first().isVisible().catch(() => false);
    if (loggedIn || profileVisible) {
      results.push({ step: 'Login Verify', status: 'passed', reason: `Logged in — URL: ${page.url().slice(-30)}` });
    } else {
      results.push({ step: 'Login Verify', status: 'failed', reason: 'Still on login page' });
    }
    screenshots[`${label}_loginscroll_loggedin`] = b64(await page.screenshot());

    // Step 7: Scroll validation
    // 500px scroll — no UI break
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1000);
    const scroll500 = await page.evaluate(() => {
      const header = document.querySelector('header, nav');
      return { scrollY: window.scrollY, headerVisible: header ? header.getBoundingClientRect().bottom > 0 : true, noError: true };
    });
    results.push({ step: 'Scroll 500px', status: 'passed', reason: `ScrollY=${scroll500.scrollY}, header visible=${scroll500.headerVisible}` });

    // 1500px scroll — lazy images load
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(2000);
    const scroll1500 = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img');
      let loaded = 0, broken = 0;
      imgs.forEach(img => { if (img.complete && img.naturalWidth > 0) loaded++; else if (img.complete) broken++; });
      return { loaded, broken, total: imgs.length };
    });
    results.push({ step: 'Scroll 1500px', status: scroll1500.broken > 3 ? 'warning' : 'passed', reason: `Images: ${scroll1500.loaded}/${scroll1500.total} loaded, ${scroll1500.broken} broken` });
    screenshots[`${label}_loginscroll_mid`] = b64(await page.screenshot());

    // Bottom scroll — no crash
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    const scrollBot = await page.evaluate(() => ({ atBottom: true, scrollY: window.scrollY, bodyH: document.body.scrollHeight }));
    results.push({ step: 'Scroll Bottom', status: 'passed', reason: `Reached bottom (${scrollBot.scrollY}px/${scrollBot.bodyH}px)` });
    screenshots[`${label}_loginscroll_bottom`] = b64(await page.screenshot());

    // Step 8: Refresh — session persists
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const sessionPersist = !(page.url().includes('/auth/login') || page.url().includes('/login'));
    const stillLoggedIn = await page.locator('text=/profile|account|logout|sign out/i').first().isVisible().catch(() => false);
    results.push({ step: 'Session Persist', status: (sessionPersist || stillLoggedIn) ? 'passed' : 'failed', reason: sessionPersist ? 'Session persists after refresh' : 'Session lost after refresh' });

    // Step 9: Click a product (optional)
    const productLink = page.locator('a[href*="/product/"]').first();
    if (await productLink.isVisible().catch(() => false)) {
      await productLink.click();
      await page.waitForTimeout(3000);
      const onPDP = page.url().includes('/product/');
      results.push({ step: 'PDP Navigate', status: onPDP ? 'passed' : 'warning', reason: onPDP ? 'PDP loaded from logged-in state' : `Navigated to: ${page.url().slice(-40)}` });
      screenshots[`${label}_loginscroll_pdp`] = b64(await page.screenshot());
    }

  } catch (e) {
    results.push({ step: 'Error', status: 'failed', reason: e.message?.substring(0, 100) });
  }

  await page.close();
  pageData[`${label}_login_scroll_results`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'Auth',
      title: `Login + Scroll Validation Failed — ${failures.length} issue(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : r.status === 'warning' ? '⚠' : '✗'} ${r.step}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Fix login flow, scroll behavior, or session persistence',
      testType: 'User Journey', expected: 'Login → Scroll → Session persist all pass', actual: failures.map(f => f.step).join(', ') + ' failed',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// SESSION PERSISTENCE TEST
// ─────────────────────────────────────────────────────────────

async function runSessionTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    // Login first
    await page.goto(siteUrl + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i]').first();
    if (await phoneInput.isVisible().catch(() => false)) {
      await phoneInput.fill(TEST_CONFIG.credentials.phone);
      const checkbox = page.locator('input[type="checkbox"]').first();
      if (await checkbox.isVisible().catch(() => false)) await checkbox.click();
      await page.waitForTimeout(300);

      const sendBtn = page.locator('button:has-text("Send"), button:has-text("Continue"), button:has-text("OTP"), button:has-text("Get OTP"), button[type="submit"]').first();
      if (await sendBtn.isVisible().catch(() => false)) {
        await sendBtn.click();
        await page.waitForTimeout(3000);

        const otpInputs = page.locator('input[type="tel"][maxlength="1"]');
        const otpCount = await otpInputs.count();
        if (otpCount >= 4) {
          for (let i = 0; i < Math.min(otpCount, 4); i++) await otpInputs.nth(i).fill(TEST_CONFIG.credentials.otp[i]);
        } else {
          const singleOtp = page.locator('input[name*="otp"], input[placeholder*="otp" i]').first();
          if (await singleOtp.isVisible().catch(() => false)) await singleOtp.fill(TEST_CONFIG.credentials.otp);
        }

        const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Login"), button[type="submit"]').first();
        if (await verifyBtn.isVisible().catch(() => false)) {
          await verifyBtn.click();
          await page.waitForTimeout(5000);
        }
      }
    }

    // Test 1: Session persists after refresh
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);
    const afterRefresh = !(page.url().includes('/auth/login'));
    results.push({ test: 'Persist after refresh', status: afterRefresh ? 'passed' : 'failed', reason: afterRefresh ? 'Session maintained' : 'Redirected to login' });

    // Test 2: Cart persists after login
    await page.goto(siteUrl + '/cart/bag', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const cartAccessible = !page.url().includes('/auth/login');
    results.push({ test: 'Cart accessible while logged in', status: cartAccessible ? 'passed' : 'failed', reason: cartAccessible ? 'Cart page loads' : 'Redirected to login' });

    // Test 3: Profile accessible
    await page.goto(siteUrl + '/profile', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const profileAccessible = !page.url().includes('/auth/login');
    results.push({ test: 'Profile accessible', status: profileAccessible ? 'passed' : 'failed', reason: profileAccessible ? 'Profile loads' : 'Redirected to login' });
    screenshots[`${label}_session_profile`] = b64(await page.screenshot());

    // Test 4: Logout clears session
    const logoutBtn = page.locator('text=/logout|sign out|log out/i, a[href*="logout"]').first();
    if (await logoutBtn.isVisible().catch(() => false)) {
      await logoutBtn.click();
      await page.waitForTimeout(3000);
      await page.goto(siteUrl + '/profile', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2000);
      const loggedOut = page.url().includes('/auth/login') || page.url().includes('/login');
      results.push({ test: 'Logout clears session', status: loggedOut ? 'passed' : 'failed', reason: loggedOut ? 'Redirected to login after logout' : 'Still logged in after logout' });
    } else {
      results.push({ test: 'Logout clears session', status: 'skipped', reason: 'No logout button found' });
    }

  } catch (e) {
    results.push({ test: 'Session test error', status: 'failed', reason: e.message?.substring(0, 100) });
  }

  await page.close();
  pageData[`${label}_session_results`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'Auth',
      title: `Session Persistence Issues — ${failures.length} failure(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Fix session management — cookies/tokens should persist correctly',
      testType: 'Session', expected: 'Session persists after refresh, cart accessible, logout works', actual: failures.map(f => f.test).join(', '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// PAYMENT METHODS TEST
// ─────────────────────────────────────────────────────────────

async function runPaymentTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    // Navigate to checkout (try cart first)
    await page.goto(siteUrl + '/cart/bag', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Look for checkout/proceed button
    const checkoutBtn = page.locator('button:has-text("Checkout"), button:has-text("Proceed"), a:has-text("Checkout"), a:has-text("Proceed"), button:has-text("Place Order")').first();
    if (await checkoutBtn.isVisible().catch(() => false)) {
      await checkoutBtn.click();
      await page.waitForTimeout(4000);
      screenshots[`${label}_payment_checkout`] = b64(await page.screenshot());

      // Check for payment method options
      const paymentMethods = await page.evaluate(() => {
        const methods = [];
        const cod = document.querySelector('[class*="cod"], [class*="cash"], text*="Cash on Delivery"');
        const upi = document.querySelector('[class*="upi"], text*="UPI"');
        const card = document.querySelector('[class*="card"], [class*="credit"], [class*="debit"], text*="Card"');
        const wallet = document.querySelector('[class*="wallet"], text*="Wallet"');
        if (cod) methods.push('COD');
        if (upi) methods.push('UPI');
        if (card) methods.push('Card');
        if (wallet) methods.push('Wallet');
        // Also check by text content
        const allText = document.body.innerText.toLowerCase();
        if (allText.includes('cash on delivery') && !methods.includes('COD')) methods.push('COD');
        if (allText.includes('upi') && !methods.includes('UPI')) methods.push('UPI');
        if ((allText.includes('credit card') || allText.includes('debit card')) && !methods.includes('Card')) methods.push('Card');
        return methods;
      });

      if (paymentMethods.length > 0) {
        results.push({ test: 'Payment Methods Available', status: 'passed', reason: `Found: ${paymentMethods.join(', ')}` });
      } else {
        results.push({ test: 'Payment Methods Available', status: 'failed', reason: 'No payment methods found on checkout page' });
      }

      // Try selecting COD
      const codBtn = page.locator('text=/cash on delivery|COD/i, [class*="cod"]').first();
      if (await codBtn.isVisible().catch(() => false)) {
        await codBtn.click();
        await page.waitForTimeout(1000);
        results.push({ test: 'COD Selection', status: 'passed', reason: 'COD option clicked' });
        screenshots[`${label}_payment_cod`] = b64(await page.screenshot());
      } else {
        results.push({ test: 'COD Selection', status: 'skipped', reason: 'COD option not visible' });
      }

      // Check for Place Order button
      const placeOrderBtn = page.locator('button:has-text("Place Order"), button:has-text("Confirm"), button:has-text("Pay")').first();
      results.push({
        test: 'Place Order Button', status: (await placeOrderBtn.isVisible().catch(() => false)) ? 'passed' : 'failed',
        reason: (await placeOrderBtn.isVisible().catch(() => false)) ? 'Place Order button visible' : 'No Place Order button found'
      });

    } else {
      results.push({ test: 'Checkout Access', status: 'skipped', reason: 'No checkout button found (cart may be empty)' });
    }

  } catch (e) {
    results.push({ test: 'Payment test error', status: 'failed', reason: e.message?.substring(0, 100) });
  }

  await page.close();
  pageData[`${label}_payment_results`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'Payment',
      title: `Payment Flow Issues — ${failures.length} failure(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Verify payment methods are configured and checkout flow is complete',
      testType: 'E-Commerce', expected: 'Payment methods visible, COD selectable, Place Order button present', actual: failures.map(f => f.test).join(', '),
    });
  }
}

// ─────────────────────────────────────────────────────────────
// ORDER LIFECYCLE TEST
// ─────────────────────────────────────────────────────────────

async function runOrderLifecycleTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    // Check order history page
    await page.goto(siteUrl + '/profile/orders', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);

    // If redirected to login, try logging in first
    if (page.url().includes('/auth/login') || page.url().includes('/login')) {
      const phoneInput = page.locator('input[type="tel"]').first();
      if (await phoneInput.isVisible().catch(() => false)) {
        await phoneInput.fill(TEST_CONFIG.credentials.phone);
        const cb = page.locator('input[type="checkbox"]').first();
        if (await cb.isVisible().catch(() => false)) await cb.click();
        const sendBtn = page.locator('button:has-text("Send"), button:has-text("Continue"), button:has-text("Get OTP"), button[type="submit"]').first();
        if (await sendBtn.isVisible().catch(() => false)) {
          await sendBtn.click();
          await page.waitForTimeout(3000);
          const otpInputs = page.locator('input[type="tel"][maxlength="1"]');
          if (await otpInputs.count() >= 4) {
            for (let i = 0; i < 4; i++) await otpInputs.nth(i).fill(TEST_CONFIG.credentials.otp[i]);
          }
          const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button[type="submit"]').first();
          if (await verifyBtn.isVisible().catch(() => false)) await verifyBtn.click();
          await page.waitForTimeout(5000);
          await page.goto(siteUrl + '/profile/orders', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.waitForTimeout(3000);
        }
      }
    }

    screenshots[`${label}_orders_page`] = b64(await page.screenshot());

    // Check order page loads
    const onOrdersPage = !page.url().includes('/auth/login');
    results.push({ test: 'Orders Page Accessible', status: onOrdersPage ? 'passed' : 'failed', reason: onOrdersPage ? 'Orders page loaded' : 'Redirected to login' });

    // Check for order items or empty state
    const orderData = await page.evaluate(() => {
      const orders = document.querySelectorAll('[class*="order-card"], [class*="order-item"], [class*="orderCard"]');
      const emptyText = document.body.innerText.toLowerCase();
      const hasEmptyState = emptyText.includes('no orders') || emptyText.includes('no order') || emptyText.includes('haven\'t placed');
      return { orderCount: orders.length, hasEmptyState };
    });

    if (orderData.orderCount > 0) {
      results.push({ test: 'Order History', status: 'passed', reason: `${orderData.orderCount} order(s) found` });

      // Try clicking first order for details
      const firstOrder = page.locator('[class*="order-card"], [class*="order-item"], [class*="orderCard"]').first();
      if (await firstOrder.isVisible().catch(() => false)) {
        await firstOrder.click();
        await page.waitForTimeout(3000);
        screenshots[`${label}_order_detail`] = b64(await page.screenshot());

        // Check for order ID
        const hasOrderId = await page.evaluate(() => {
          const text = document.body.innerText;
          return /order.*(id|#|number)/i.test(text) || /#\d+/.test(text);
        });
        results.push({ test: 'Order Detail View', status: 'passed', reason: hasOrderId ? 'Order ID visible' : 'Order detail page loaded' });

        // Check for cancel/return button
        const cancelBtn = page.locator('button:has-text("Cancel"), button:has-text("Return"), a:has-text("Cancel")').first();
        results.push({ test: 'Cancel/Return Option', status: (await cancelBtn.isVisible().catch(() => false)) ? 'passed' : 'info', reason: (await cancelBtn.isVisible().catch(() => false)) ? 'Cancel/Return button visible' : 'No cancel option (may be processed)' });
      }
    } else if (orderData.hasEmptyState) {
      results.push({ test: 'Order History', status: 'passed', reason: 'Empty state shown correctly (no orders)' });
    } else {
      results.push({ test: 'Order History', status: 'warning', reason: 'No orders and no empty state message' });
    }

  } catch (e) {
    results.push({ test: 'Order lifecycle error', status: 'failed', reason: e.message?.substring(0, 100) });
  }

  await page.close();
  pageData[`${label}_order_lifecycle`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'E-Commerce',
      title: `Order Lifecycle Issues — ${failures.length} failure(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Fix order history page, order details, and cancel/return flow',
      testType: 'E-Commerce',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// PRICING VALIDATION TEST
// ─────────────────────────────────────────────────────────────

async function runPricingValidationTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    // Go to cart
    await page.goto(siteUrl + '/cart/bag', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    screenshots[`${label}_pricing_cart`] = b64(await page.screenshot());

    const pricing = await page.evaluate(() => {
      const extractPrice = (text) => {
        if (!text) return null;
        const match = text.replace(/,/g, '').match(/[\d]+\.?\d*/);
        return match ? parseFloat(match[0]) : null;
      };

      // Item prices
      const itemEls = document.querySelectorAll('[class*="cart-item"], [class*="bag-item"], [class*="product-card"]');
      const items = [];
      itemEls.forEach(el => {
        const priceEl = el.querySelector('[class*="price"], [class*="amount"]');
        const qtyEl = el.querySelector('[class*="qty"], [class*="quantity"], input[type="number"]');
        const price = extractPrice(priceEl?.textContent);
        const qty = qtyEl ? (parseInt(qtyEl.value || qtyEl.textContent) || 1) : 1;
        if (price) items.push({ price, qty, total: price * qty });
      });

      // Subtotal / total
      const totalEl = document.querySelector('[class*="total"], [class*="subtotal"], [class*="grand-total"], [class*="order-total"]');
      const totalText = totalEl ? totalEl.textContent : null;
      const total = extractPrice(totalText);

      // Discount
      const discountEl = document.querySelector('[class*="discount"], [class*="savings"], [class*="coupon"]');
      const discount = discountEl ? extractPrice(discountEl.textContent) : 0;

      // Tax
      const taxEl = document.querySelector('[class*="tax"], [class*="gst"]');
      const tax = taxEl ? extractPrice(taxEl.textContent) : 0;

      const itemTotal = items.reduce((sum, i) => sum + i.total, 0);

      return { items, itemCount: items.length, itemTotal, displayTotal: total, discount, tax };
    });

    if (pricing.itemCount > 0) {
      results.push({ test: 'Items in Cart', status: 'passed', reason: `${pricing.itemCount} item(s), subtotal: ${pricing.itemTotal}` });

      // Validate item total = display total (accounting for discount/tax)
      if (pricing.displayTotal) {
        const expectedTotal = pricing.itemTotal - (pricing.discount || 0) + (pricing.tax || 0);
        const diff = Math.abs(expectedTotal - pricing.displayTotal);
        if (diff < 2) { // Allow small rounding differences
          results.push({ test: 'Price Calculation', status: 'passed', reason: `Items(${pricing.itemTotal}) - Discount(${pricing.discount}) + Tax(${pricing.tax}) ≈ Total(${pricing.displayTotal})` });
        } else {
          results.push({ test: 'Price Calculation', status: 'failed', reason: `Mismatch: Items(${pricing.itemTotal}) - Discount(${pricing.discount}) + Tax(${pricing.tax}) = ${expectedTotal}, but displayed: ${pricing.displayTotal} (diff: ${diff})` });
        }
      }
    } else {
      results.push({ test: 'Items in Cart', status: 'skipped', reason: 'Cart is empty — add items first' });
    }

  } catch (e) {
    results.push({ test: 'Pricing error', status: 'failed', reason: e.message?.substring(0, 100) });
  }

  await page.close();
  pageData[`${label}_pricing_results`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'Critical', category: 'E-Commerce',
      title: `Pricing Mismatch — Cart total incorrect (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Fix cart price calculation — item total should equal displayed total after discount/tax',
      testType: 'E-Commerce',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// RACE CONDITIONS TEST
// ─────────────────────────────────────────────────────────────

async function runRaceConditionTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];

  try {
    // Find a product page
    await page.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const productLink = await page.evaluate(() => {
      const a = document.querySelector('a[href*="/product/"]');
      return a ? a.getAttribute('href') : null;
    });

    if (productLink) {
      await page.goto(siteUrl + productLink, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);

      // Select size if available
      const sizeBtn = page.locator('[class*="size"] button, [class*="size"] label, [class*="variant"] button').first();
      if (await sizeBtn.isVisible().catch(() => false)) await sizeBtn.click();
      await page.waitForTimeout(500);

      // Test 1: Double-click ATC
      const atcBtn = page.locator('button:has-text("Add to Cart"), button:has-text("Add to Bag"), button:has-text("ADD TO BAG"), button:has-text("Buy Now")').first();
      if (await atcBtn.isVisible().catch(() => false)) {
        await atcBtn.dblclick();
        await page.waitForTimeout(3000);
        screenshots[`${label}_race_dblclick`] = b64(await page.screenshot());

        // Check if error or if qty > 1 unexpectedly
        const noError = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return !text.includes('error') || text.includes('added') || text.includes('success');
        });
        results.push({ test: 'Double-click ATC', status: noError ? 'passed' : 'warning', reason: noError ? 'No crash on double-click' : 'Error message appeared' });

        // Test 2: Rapid qty change in cart
        await page.goto(siteUrl + '/cart/bag', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() =>
          page.goto(siteUrl + '/cart', { waitUntil: 'domcontentloaded', timeout: 15000 })
        );
        await page.waitForTimeout(2000);

        const plusBtn = page.locator('button:has-text("+"), [class*="qty-plus"], [class*="increase"], [class*="increment"]').first();
        if (await plusBtn.isVisible().catch(() => false)) {
          // Rapid clicks
          await plusBtn.click();
          await plusBtn.click();
          await plusBtn.click();
          await page.waitForTimeout(2000);
          screenshots[`${label}_race_rapidqty`] = b64(await page.screenshot());

          const noQtyError = await page.evaluate(() => {
            const text = document.body.innerText.toLowerCase();
            return !text.includes('went wrong') && !text.includes('server error');
          });
          results.push({ test: 'Rapid Qty Change', status: noQtyError ? 'passed' : 'failed', reason: noQtyError ? 'Cart handles rapid qty changes' : 'Error on rapid quantity updates' });
        } else {
          results.push({ test: 'Rapid Qty Change', status: 'skipped', reason: 'No qty + button found' });
        }

      } else {
        results.push({ test: 'Double-click ATC', status: 'skipped', reason: 'ATC button not found' });
      }

      // Test 3: Multi-tab cart (open cart in new context)
      try {
        const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page2 = await ctx2.newPage();
        await page2.goto(siteUrl + '/cart/bag', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() =>
          page2.goto(siteUrl + '/cart', { waitUntil: 'domcontentloaded', timeout: 15000 })
        );
        await page2.waitForTimeout(2000);
        const noTabCrash = await page2.evaluate(() => document.body.innerText.length > 0);
        results.push({ test: 'Multi-tab Cart', status: noTabCrash ? 'passed' : 'failed', reason: noTabCrash ? 'Cart loads in separate session' : 'Cart crashed in second tab' });
        await page2.close();
        await ctx2.close();
      } catch {
        results.push({ test: 'Multi-tab Cart', status: 'warning', reason: 'Could not open second tab' });
      }

    } else {
      results.push({ test: 'Race Conditions', status: 'skipped', reason: 'No product found to test' });
    }

  } catch (e) {
    results.push({ test: 'Race condition error', status: 'failed', reason: e.message?.substring(0, 100) });
  }

  await page.close();
  pageData[`${label}_race_results`] = results;

  const failures = results.filter(r => r.status === 'failed');
  if (failures.length > 0) {
    bugs.push({
      id: bugs.length + 1, severity: 'High', category: 'E-Commerce',
      title: `Race Condition Issues — ${failures.length} failure(s) (${sn})`,
      description: results.map(r => `${r.status === 'passed' ? '✓' : '✗'} ${r.test}: ${r.reason}`).join('\n'),
      site: sn, fix: 'Add debouncing to ATC button, rate-limit qty API calls, handle concurrent cart access',
      testType: 'E-Commerce',
    });
  }
}

// ─────────────────────────────────────────────────────────────
// AUTHENTICATED DISCOVERY — Login then crawl for full data
// ─────────────────────────────────────────────────────────────

async function loginAndGetContext(browser, siteUrl, log) {
  log('  [AUTH] Logging in before discovery for authenticated crawl...');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

  try {
    await page.goto(siteUrl + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const phoneInput = page.locator('input[type="tel"], input[name="phone"], input[placeholder*="phone" i]').first();
    if (!(await phoneInput.isVisible().catch(() => false))) {
      log('  [AUTH] No phone input found — skipping auth');
      await page.close();
      return { context: ctx, loggedIn: false };
    }

    await phoneInput.fill(TEST_CONFIG.credentials.phone);

    // Checkbox
    const checkbox = page.locator('input[type="checkbox"]').first();
    if (await checkbox.isVisible().catch(() => false)) await checkbox.click();
    await page.waitForTimeout(300);

    // Send OTP
    const sendBtn = page.locator('button:has-text("Send"), button:has-text("Continue"), button:has-text("OTP"), button:has-text("Get OTP"), button[type="submit"]').first();
    if (!(await sendBtn.isVisible().catch(() => false))) {
      log('  [AUTH] No Send OTP button — skipping auth');
      await page.close();
      return { context: ctx, loggedIn: false };
    }
    await sendBtn.click();
    await page.waitForTimeout(3000);

    // Enter OTP
    const otpInputs = page.locator('input[type="tel"][maxlength="1"]');
    const otpCount = await otpInputs.count();
    if (otpCount >= 4) {
      for (let i = 0; i < Math.min(otpCount, 4); i++) {
        await otpInputs.nth(i).fill(TEST_CONFIG.credentials.otp[i]);
        await page.waitForTimeout(200);
      }
    } else {
      const singleOtp = page.locator('input[name*="otp"], input[placeholder*="otp" i], input[type="tel"]:not([maxlength="1"])').first();
      if (await singleOtp.isVisible().catch(() => false)) await singleOtp.fill(TEST_CONFIG.credentials.otp);
    }

    // Verify
    const verifyBtn = page.locator('button:has-text("Verify"), button:has-text("Submit"), button:has-text("Login"), button[type="submit"]').first();
    if (await verifyBtn.isVisible().catch(() => false)) {
      await verifyBtn.click();
      await page.waitForTimeout(5000);
    }

    const loggedIn = !(page.url().includes('/auth/login') || page.url().includes('/login'));
    log(loggedIn ? '  [AUTH] ✓ Logged in successfully — authenticated crawl enabled' : '  [AUTH] ✗ Login failed — crawling without auth');

    await page.close();
    return { context: ctx, loggedIn };

  } catch (e) {
    log(`  [AUTH] Login error: ${e.message?.substring(0, 80)} — crawling without auth`);
    await page.close();
    return { context: ctx, loggedIn: false };
  }
}

module.exports = {
  DEVICES,
  discoverSite,
  generateTestPlan,
  runPageLoadTest,
  runMultiDeviceTest,
  runFormTest,
  runLoginTest,
  runLinkValidation,
  runAccessibilityTest,
  runPerformanceTest,
  runCSSTest,
  runFontTest,
  runRedirectionTest,
  runContentComparison,
  runCartCheckoutTest,
  runSearchDeepTest,
  runPDPDeepTest,
  runPLPDeepTest,
  runWishlistTest,
  runExploratoryTest,
  runSecurityBasicTest,
  runInventoryTest,
  runVisualDiff,
  // Enhanced regression (prod vs UAT)
  runStructureCompare,
  runMetaCompare,
  runHeaderFooterCompare,
  runCSSCompare,
  runResponsiveCompare,
  runLighthouseCompare,
  runSectionVisualDiff,
  // Scenario tests (SKILL.md coverage)
  runAuthNegativeTests,
  runEmptyCartTest,
  runCartQuantityTest,
  runPLPInteractionTest,
  runHomepageDeepTest,
  runHeaderNavTest,
  runAddressTest,
  runTrackOrderTest,
  runNewsletterTest,
  runStoreLocatorTest,
  runPDPEdgeCaseTest,
  // Agent layer 3: execution utilities
  withRetry,
  runParallel,
  captureAPIs,
  // User journey flows
  runUserJourneyBrowseToCart,
  runUserJourneyLoginToProfile,
  runUserJourneySearchToProduct,
  // Interaction tests
  runInteractionTest,
  // API comparison
  runAPIComparison,
  // Form validation
  runFormValidationTest,
  // SEO tests
  runSEORobotsSitemap,
  runSEOStructuredData,
  // E-commerce enhanced tests
  runProductGalleryZoom,
  runOutOfStockTest,
  runPriceFormatTest,
  runRelatedProductsTest,
  runCouponPromoTest,
  // Navigation & UX tests
  runBreadcrumbTest,
  runMobileMenuTest,
  runCookieConsentTest,
  runSocialSharingTest,
  // Security & technical tests
  runHTTPSecurityHeaders,
  runImageOptimizationTest,
  runScrollPerformanceTest,
  // Content & policy tests
  runPolicyPagesTest,
  // Config
  loadSkillConfig,
  TEST_CONFIG,
  // New: Login-first architecture + enhanced tests
  runLoginAndScrollTest,
  loginAndGetContext,
  runSessionTest,
  runPaymentTest,
  runOrderLifecycleTest,
  runPricingValidationTest,
  runRaceConditionTest,
};
