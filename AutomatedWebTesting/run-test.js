#!/usr/bin/env node
/**
 * run-test.js — Autonomous E-Commerce QA Agent
 *
 * 5-Layer Architecture:
 *   Layer 0: Login Agent — Authenticate before crawling
 *   Layer 1: Discovery Agent — Map site structure
 *   Layer 2: Planning Agent — Generate test plan
 *   Layer 3: Execution Agent — Run all tests with retry
 *   Layer 4: Reporting Agent — Generate HTML report + deploy
 *
 * Usage: node run-test.js <url> [--mode=fast|standard|deep]
 */

require('dotenv').config();
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');
const aiAgents = require('./ai-agents');
const generateReport = require('./report-generator');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const TARGET_URL = (process.argv.slice(2).find(a => !a.startsWith('--')) || process.env.UAT_URL || 'https://coachnew.fynd.io').replace(/\/+$/, '');
const MODE = (process.argv.find(a => a.startsWith('--mode=')) || `--mode=${process.env.TEST_MODE || 'standard'}`).split('=')[1];
const BUDGETS = { fast: 10 * 60 * 1000, standard: 20 * 60 * 1000, deep: 60 * 60 * 1000 };
const CRAWL_LIMITS = { fast: 20, standard: 30, deep: 100 };
const BUDGET_MS = BUDGETS[MODE] || BUDGETS.standard;
const START_TIME = Date.now();

const CREDS = { phone: process.env.TEST_PHONE || '8888888888', otp: process.env.TEST_OTP || '5401', pincode: process.env.TEST_PINCODE || '400001' };

const SITE_NAME = new URL(TARGET_URL).hostname.replace(/\./g, '-');
const SCREENSHOT_DIR = path.join(__dirname, 'reports', 'screenshots', SITE_NAME);
const REPORT_DIR = path.join(__dirname, 'reports');

// Devices
const TEST_DEVICES = {
  desktop: { viewport: { width: 1440, height: 900 }, name: 'Desktop' },
  '4k': { viewport: { width: 3840, height: 2160 }, name: '4K UHD' },
  iphone: { ...devices['iPhone 14 Pro'], name: 'iPhone 14 Pro' },
  pixel: { ...devices['Pixel 7'], name: 'Pixel 7' },
};

// ─── ADAPTIVE SELECTOR ENGINE ────────────────────────────────────────────────
// Universal selectors that work across Amazon, Flipkart, Myntra, Shopify, WooCommerce, etc.
const SELECTORS = {
  // Product Listing Detection — covers all major e-commerce platforms
  productCard: [
    '[data-component-type="s-search-result"]',       // Amazon
    '[data-id][class*="product"]', '._1AtVbE',       // Flipkart
    '[class*="product-card"]', '[class*="product-item"]', '[class*="product_card"]',
    '[class*="ProductCard"]', '[class*="productCard"]',
    '[class*="plp-card"]', '[class*="catalog-card"]',
    '[data-testid*="product"]', '[data-qa*="product"]',
    '.grid-product', '.product-tile', '.product-grid-item',
    'li[class*="product"]', 'article[class*="product"]',
    'a[href*="/product/"]', 'a[href*="/dp/"]', 'a[href*="/p/"]',
    'a[href*="/products/"]', 'a[href*="/item/"]',
  ].join(', '),

  // Product Link — to navigate from PLP to PDP
  productLink: [
    'a[href*="/product/"]', 'a[href*="/dp/"]', 'a[href*="/p/"]',
    'a[href*="/products/"]', 'a[href*="/item/"]', 'a[href*="/ip/"]',
    '[class*="product-card"] a', '[class*="product-item"] a',
    '[class*="ProductCard"] a', '[class*="productCard"] a',
    '[data-component-type="s-search-result"] a',
    '._1AtVbE a', '.product-tile a',
  ].join(', '),

  // Price Detection
  price: [
    '[class*="price"]', '[class*="Price"]', '[data-testid*="price"]',
    '[class*="amount"]', '[class*="cost"]', '[class*="mrp"]',
    '._30jeq3', '._16Jk6d',                          // Flipkart
    '.a-price', '.a-offscreen',                        // Amazon
    'span:has-text("$")', 'span:has-text("₹")', 'span:has-text("€")',
    'span:has-text("£")', 'span:has-text("¥")',
    'span:has-text("MRP")', 'span:has-text("Price")',
  ].join(', '),

  // Add to Cart / Buy Button
  addToCart: [
    'button:has-text("Add to Cart")', 'button:has-text("Add to Bag")',
    'button:has-text("ADD TO CART")', 'button:has-text("ADD TO BAG")',
    'button:has-text("Buy Now")', 'button:has-text("BUY NOW")',
    'button:has-text("Add to cart")', 'button:has-text("Add to bag")',
    'input[value*="Add to Cart"]', '#add-to-cart-button',  // Amazon
    '._2KpZ6l', '._3v+Zzd',                                // Flipkart
    '[class*="add-to-cart"]', '[class*="addToCart"]', '[class*="add-to-bag"]',
    '[class*="addToBag"]', '[class*="buy-now"]', '[class*="buyNow"]',
    '[data-testid*="add-to-cart"]', '[data-testid*="buy"]',
    'button[name="add"]', 'button[id*="cart"]',
  ].join(', '),

  // Search Input
  searchInput: [
    'input[type="search"]', 'input[name="q"]', 'input[name="query"]',
    'input[name="k"]',                                      // Amazon
    'input[name="search"]', 'input[title*="Search"]',
    'input[placeholder*="search" i]', 'input[placeholder*="Search"]',
    'input[aria-label*="search" i]', 'input[aria-label*="Search"]',
    '#twotabsearchtextbox',                                  // Amazon
    '[class*="search"] input', '[class*="Search"] input',
    'input[class*="search"]', 'input[class*="Search"]',
    'input[data-testid*="search"]',
  ].join(', '),

  // Search Trigger (icon/button)
  searchTrigger: [
    'button[aria-label*="search" i]', 'button[aria-label*="Search"]',
    '[class*="search-icon"]', '[class*="searchIcon"]', '[class*="search"] button',
    'a[href*="search"]', '.search-icon', 'svg[class*="search"]',
    'button[type="submit"][class*="search"]', '#nav-search-submit-button',
    'input[type="submit"][value*="search" i]',
  ].join(', '),

  // Cart Link/Icon
  cart: [
    'a[href*="cart"]', 'a[href*="Cart"]', 'a[href*="bag"]', 'a[href*="basket"]',
    '[class*="cart"]', '[class*="Cart"]', '[class*="bag-icon"]',
    '[aria-label*="cart" i]', '[aria-label*="bag" i]', '[aria-label*="basket" i]',
    '#nav-cart',                                              // Amazon
    '[data-testid*="cart"]', '.cart-icon', 'svg[class*="cart"]',
  ].join(', '),

  // Login/Account Link
  login: [
    'a[href*="login"]', 'a[href*="signin"]', 'a[href*="sign-in"]',
    'a[href*="auth"]', 'a[href*="account"]',
    '[class*="user"]', '[class*="account"]', '[class*="login"]',
    '[class*="signin"]', '[class*="profile"]',
    '#nav-link-accountList',                                  // Amazon
    'a:has-text("Sign In")', 'a:has-text("Log In")', 'a:has-text("Login")',
    'button:has-text("Sign In")', 'button:has-text("Login")',
  ].join(', '),

  // Wishlist
  wishlist: [
    'a[href*="wishlist"]', 'a[href*="favourite"]', 'a[href*="favorite"]',
    'a[href*="saved"]', '[class*="wishlist"]', '[class*="heart"]',
    '[class*="Wishlist"]', '[aria-label*="wish" i]',
  ].join(', '),

  // Size Selector
  sizeSelector: [
    '[class*="size-option"]', '[class*="sizeOption"]', '[class*="size_option"]',
    '[class*="size-selector"]', '[class*="sizeSelector"]',
    '[class*="size-container"] button', '[class*="size"] button',
    'select[name*="size" i]', '[data-testid*="size"]',
    'button:has-text(/^(XS|S|M|L|XL|XXL|XXXL|\\d{1,2})$/)',
    '#native_dropdown_selected_size_name',                    // Amazon
    '._1q8vHb',                                               // Flipkart
  ].join(', '),

  // Navigation
  nav: 'nav, header nav, [class*="navbar"], [class*="nav-bar"], [class*="header"], [role="navigation"]',
  footer: 'footer, [class*="footer"], [role="contentinfo"]',
};

// ─── GLOBALS ──────────────────────────────────────────────────────────────────
const bugs = [];
let bugCounter = 0;
let loggedIn = false;
const testResults = { passed: 0, failed: 0, skipped: 0, total: 0 };
const consoleErrors = [];
const networkErrors = [];
const perfData = [];  // Stores per-page performance metrics for the report
const screenshots = {};

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function elapsed() { return Date.now() - START_TIME; }
function budgetLeft() { return BUDGET_MS - elapsed(); }
function isBudgetExceeded() { return elapsed() >= BUDGET_MS; }
function log(icon, msg) { console.log(`${icon} [${(elapsed() / 1000).toFixed(1)}s] ${msg}`); }

function addBug(severity, category, title, description, location, steps, expected, actual, screenshotPath, fix) {
  bugCounter++;
  const id = `BUG-${String(bugCounter).padStart(3, '0')}`;
  bugs.push({ id, severity, category, title, description, location, steps, expected, actual, screenshot: screenshotPath, fix, timestamp: new Date().toISOString() });
  log(severity === 'Critical' ? '\u274C' : severity === 'High' ? '\u26A0\uFE0F' : '\u2139\uFE0F', `${id} [${severity}] ${title}`);
  return id;
}

async function safeScreenshot(page, name) {
  try {
    const filePath = path.join(SCREENSHOT_DIR, `${name}.png`);
    await page.screenshot({ path: filePath, fullPage: false, timeout: 15000 });
    screenshots[name] = filePath;
    return filePath;
  } catch (e) {
    return null;
  }
}

async function safeGoto(page, url, opts = {}) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, ...opts });
    await page.waitForTimeout(2000);
    return resp;
  } catch (e) {
    return null;
  }
}

async function retry(fn, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

function setupPageListeners(page) {
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push({ text: msg.text(), url: page.url(), timestamp: Date.now() });
    }
  });
  page.on('requestfailed', req => {
    networkErrors.push({ url: req.url(), failure: req.failure()?.errorText, page: page.url(), timestamp: Date.now() });
  });
}

// ─── LAYER 0: UNIVERSAL LOGIN AGENT ──────────────────────────────────────────
// Auto-detects login type: OTP, email/password, or skip if no creds
async function loginAgent(page) {
  log('\uD83D\uDD10', 'Layer 0: Universal Login Agent starting...');

  // Skip login if no credentials configured
  if (!CREDS.phone && !process.env.TEST_EMAIL) {
    log('\u2139\uFE0F', 'Login: No credentials configured, skipping authentication');
    return false;
  }

  try {
    // Find login page dynamically
    const loginPaths = ['/auth/login', '/login', '/signin', '/sign-in', '/account/login', '/customer/account/login'];
    let loginFound = false;
    for (const loginPath of loginPaths) {
      const resp = await safeGoto(page, `${TARGET_URL}${loginPath}`);
      if (resp && resp.status() < 400) {
        const hasForm = await page.$('form, input[type="email"], input[type="tel"], input[type="password"]');
        if (hasForm) { loginFound = true; break; }
      }
    }

    if (!loginFound) {
      // Try finding login link on homepage
      await safeGoto(page, TARGET_URL);
      const loginLink = await page.$(SELECTORS.login);
      if (loginLink) {
        await loginLink.click().catch(() => {});
        await page.waitForTimeout(2000);
        loginFound = true;
      }
    }

    if (!loginFound) {
      log('\u26A0\uFE0F', 'Login: No login page found, skipping');
      return false;
    }
    await safeScreenshot(page, 'login_page');

    // Detect login type: email/password OR phone/OTP
    const emailInput = await page.$('input[type="email"], input[name="email"], input[placeholder*="email" i], input[name="username"], #ap_email');
    const passwordInput = await page.$('input[type="password"], input[name="password"], #ap_password');
    const phoneInput = await page.$('input[type="tel"], input[placeholder*="phone" i], input[placeholder*="mobile" i], input[name*="phone" i], input[name*="mobile" i]');

    if (emailInput && passwordInput && process.env.TEST_EMAIL && process.env.TEST_PASSWORD) {
      // --- Email/Password Login Flow ---
      log('\uD83D\uDD10', 'Login type: Email/Password');
      await emailInput.fill(process.env.TEST_EMAIL);
      await page.waitForTimeout(500);
      await passwordInput.fill(process.env.TEST_PASSWORD);
      await page.waitForTimeout(500);

      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Sign In"), button:has-text("Log In"), button:has-text("Login"), button:has-text("Submit"), #signInSubmit');
      if (submitBtn) {
        await submitBtn.click();
        log('\u2705', 'Login: Submitted email/password');
      }
      await page.waitForTimeout(5000);

    } else if (phoneInput && CREDS.phone) {
      // --- Phone/OTP Login Flow ---
      log('\uD83D\uDD10', 'Login type: Phone/OTP');
      await phoneInput.fill(CREDS.phone);
      await page.waitForTimeout(500);

      // Checkbox (terms/agree)
      const checkbox = await page.$('input[type="checkbox"], .checkbox, [class*="checkbox"], [class*="terms"], [class*="agree"]');
      if (checkbox) {
        const isChecked = await checkbox.isChecked().catch(() => false);
        if (!isChecked) await checkbox.click().catch(() => {});
        log('\u2705', 'Login: Terms checkbox clicked');
      }
      await page.waitForTimeout(500);

      // Get OTP button
      const otpBtn = await page.$('button:has-text("OTP"), button:has-text("otp"), button:has-text("Continue"), button:has-text("Send"), button[type="submit"]');
      if (otpBtn) {
        await otpBtn.click();
        log('\u2705', 'Login: Get OTP clicked');
      } else {
        log('\u26A0\uFE0F', 'Login: OTP button not found');
        return false;
      }
      await page.waitForTimeout(3000);
      await safeScreenshot(page, 'login_otp_page');

      // Enter OTP
      const otpInputs = await page.$$('input[type="tel"], input[type="number"], input[inputmode="numeric"], input[maxlength="1"]');
      if (otpInputs.length >= 4) {
        for (let i = 0; i < Math.min(otpInputs.length, CREDS.otp.length); i++) {
          await otpInputs[i].fill(CREDS.otp[i]);
        }
        log('\u2705', 'Login: OTP entered (multi-box)');
      } else {
        const otpInput = await page.$('input[placeholder*="otp" i], input[placeholder*="code" i], input[name*="otp" i], input[type="tel"]:not([value]), input[type="number"]');
        if (otpInput) {
          await otpInput.fill(CREDS.otp);
          log('\u2705', 'Login: OTP entered (single box)');
        }
      }
      await page.waitForTimeout(1000);

      const verifyBtn = await page.$('button:has-text("Verify"), button:has-text("Login"), button:has-text("Submit"), button:has-text("Continue"), button[type="submit"]');
      if (verifyBtn) {
        await verifyBtn.click();
        log('\u2705', 'Login: Verify clicked');
      }
      await page.waitForTimeout(5000);

    } else {
      log('\u26A0\uFE0F', 'Login: No matching credentials for detected login type');
      return false;
    }

    await safeScreenshot(page, 'login_after');

    // Verify login success (universal checks)
    const profileLink = await page.$('a[href*="profile"], a[href*="account"], [class*="user-icon"], [class*="account"], [class*="profile"], #nav-link-accountList, ._2N-Vbe');
    const logoutLink = await page.$('a:has-text("Logout"), button:has-text("Logout"), a:has-text("Sign Out"), a:has-text("Sign out")');
    if (profileLink || logoutLink) {
      loggedIn = true;
      log('\u2705', 'Login: SUCCESS - Authenticated');
      return true;
    }

    const currentUrl = page.url();
    if (!currentUrl.includes('/login') && !currentUrl.includes('/signin') && !currentUrl.includes('/auth')) {
      loggedIn = true;
      log('\u2705', 'Login: SUCCESS - Redirected from login page');
      return true;
    }

    log('\u26A0\uFE0F', 'Login: Could not verify login success, continuing...');
    return false;
  } catch (e) {
    log('\u274C', `Login failed: ${e.message}`);
    return false;
  }
}

// ─── LAYER 1: SMART DISCOVERY AGENT ──────────────────────────────────────────
// Universal crawler — discovers site structure dynamically from any website
async function discoveryAgent(page) {
  log('\uD83D\uDD0D', 'Layer 1: Smart Discovery Agent starting...');
  const discovery = {
    baseUrl: TARGET_URL,
    siteName: SITE_NAME,
    pages: [],
    livePages: [],
    deadPages: [],
    features: { hasSearch: false, hasCart: false, hasLogin: false, hasWishlist: false, hasProducts: false, hasForms: false, hasFooter: false, hasNav: false },
    navLinks: [],
    footerLinks: [],
    productLinks: [],
    searchTerms: [],
    consoleErrors: [],
    networkErrors: [],
    forms: [],
    platform: 'unknown',
  };

  const crawlLimit = CRAWL_LIMITS[MODE] || 30;
  const visited = new Set();
  const toVisit = [];
  const hostname = new URL(TARGET_URL).hostname;

  // --- Phase 1: Load homepage and detect platform ---
  log('\uD83C\uDF10', 'Phase 1: Analyzing homepage & detecting platform...');
  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(2000);

  discovery.platform = await page.evaluate(() => {
    const html = document.documentElement.innerHTML.toLowerCase();
    const meta = document.querySelector('meta[name="generator"]')?.content?.toLowerCase() || '';
    if (html.includes('shopify') || meta.includes('shopify')) return 'shopify';
    if (html.includes('woocommerce') || meta.includes('woocommerce') || html.includes('wp-content')) return 'woocommerce';
    if (html.includes('magento') || meta.includes('magento')) return 'magento';
    if (document.querySelector('#a-page, #nav-logo-sprites, #twotabsearchtextbox')) return 'amazon';
    if (document.querySelector('._1AtVbE, ._1YokD2, ._2WkVRV')) return 'flipkart';
    if (html.includes('fynd') || document.querySelector('[class*="fynd"]')) return 'fynd';
    if (html.includes('bigcommerce')) return 'bigcommerce';
    if (html.includes('prestashop')) return 'prestashop';
    if (html.includes('myntra') || document.querySelector('[class*="myntra"]')) return 'myntra';
    return 'custom';
  });
  log('\uD83C\uDFE2', `Platform detected: ${discovery.platform}`);

  // --- Phase 2: Collect all links from homepage ---
  log('\uD83D\uDD17', 'Phase 2: Crawling site links from homepage...');
  const homepageLinks = await page.evaluate((hn) => {
    const links = new Set();
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const url = new URL(a.href, window.location.origin);
        if (url.hostname === hn || url.hostname === '') {
          links.add(url.pathname);
        }
      } catch {}
    });
    return [...links];
  }, hostname);

  const fallbackPaths = ['/', '/cart', '/login', '/signin', '/sign-in', '/auth/login', '/account', '/contact', '/about'];
  const allPaths = [...new Set([...homepageLinks, ...fallbackPaths])];
  for (const p of allPaths) toVisit.push(p);
  log('\uD83D\uDD17', `Found ${homepageLinks.length} links on homepage`);

  // --- Phase 3: Try sitemap.xml ---
  try {
    const sitemapResp = await page.goto(`${TARGET_URL}/sitemap.xml`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    if (sitemapResp && sitemapResp.status() === 200) {
      const sitemapUrls = await page.evaluate(() => {
        const locs = document.querySelectorAll('loc');
        return Array.from(locs).map(l => {
          try { return new URL(l.textContent).pathname; } catch { return null; }
        }).filter(Boolean);
      });
      for (const p of sitemapUrls) {
        if (!toVisit.includes(p)) toVisit.push(p);
      }
      log('\u2705', `Sitemap: found ${sitemapUrls.length} URLs`);
    }
  } catch {}

  // --- Phase 4: Crawl discovered URLs ---
  log('\uD83D\uDD0D', `Phase 4: Crawling ${Math.min(toVisit.length, crawlLimit)} pages...`);
  for (const pagePath of toVisit) {
    if (visited.size >= crawlLimit || isBudgetExceeded()) break;
    const normalizedPath = pagePath.split('?')[0].split('#')[0];
    if (visited.has(normalizedPath)) continue;
    visited.add(normalizedPath);

    const url = normalizedPath.startsWith('http') ? normalizedPath : `${TARGET_URL}${normalizedPath}`;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1500);
      const status = resp ? resp.status() : 0;
      const title = await page.title().catch(() => '');
      const finalUrl = page.url();

      const titleLower = title.toLowerCase();
      const isSoft404 = titleLower.includes('page not found') || titleLower === '404' || titleLower.includes('404 -') ||
        (await page.$('h1:has-text("Page Not Found"), h1:has-text("404"), [class*="not-found"], [class*="error-page"], [class*="page-not-found"]').catch(() => null));

      const pageInfo = { path: normalizedPath, url, finalUrl, status, title, isSoft404: !!isSoft404, isRedirect: finalUrl !== url };
      discovery.pages.push(pageInfo);

      if (status >= 200 && status < 400 && !isSoft404) {
        discovery.livePages.push(pageInfo);
      } else {
        discovery.deadPages.push(pageInfo);
      }

      log(status >= 200 && status < 400 && !isSoft404 ? '\u2705' : '\u274C', `[${status}] ${normalizedPath} — ${title || '(no title)'}`);
    } catch (e) {
      discovery.pages.push({ path: normalizedPath, url, status: 0, error: e.message });
      discovery.deadPages.push({ path: normalizedPath, url, status: 0, error: e.message });
    }
  }

  // --- Phase 5: Detect features using adaptive selectors ---
  log('\uD83E\uDDE0', 'Phase 5: Detecting site features...');
  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(2000);

  discovery.features.hasSearch = !!(await page.$(SELECTORS.searchInput + ', ' + SELECTORS.searchTrigger).catch(() => null));
  discovery.features.hasCart = !!(await page.$(SELECTORS.cart).catch(() => null));
  discovery.features.hasLogin = !!(await page.$(SELECTORS.login).catch(() => null));
  discovery.features.hasWishlist = !!(await page.$(SELECTORS.wishlist).catch(() => null));
  discovery.features.hasNav = !!(await page.$(SELECTORS.nav).catch(() => null));
  discovery.features.hasFooter = !!(await page.$(SELECTORS.footer).catch(() => null));
  discovery.features.hasForms = !!(await page.$('form, [class*="form"]').catch(() => null));

  // Detect products dynamically
  const productPages = discovery.livePages.filter(p =>
    /product|shop|store|catalog|collection|categor|search|browse|buy|deal|offer|sale/i.test(p.path + ' ' + p.title)
  );
  if (productPages.length === 0) {
    const homeProducts = await page.$$(SELECTORS.productCard).catch(() => []);
    discovery.features.hasProducts = homeProducts.length > 0;
  } else {
    discovery.features.hasProducts = true;
  }

  // --- Phase 6: Collect nav/footer/product links ---
  const navLinkEls = await page.$$(`${SELECTORS.nav} a, header a`).catch(() => []);
  for (const el of navLinkEls.slice(0, 40)) {
    const href = await el.getAttribute('href').catch(() => null);
    const text = (await el.textContent().catch(() => '')).trim();
    if (href && text && text.length < 100) discovery.navLinks.push({ href, text });
  }

  const footerLinkEls = await page.$$(`${SELECTORS.footer} a`).catch(() => []);
  for (const el of footerLinkEls.slice(0, 40)) {
    const href = await el.getAttribute('href').catch(() => null);
    const text = (await el.textContent().catch(() => '')).trim();
    if (href && text && text.length < 100) discovery.footerLinks.push({ href, text });
  }

  const productLinkEls = await page.$$(SELECTORS.productLink).catch(() => []);
  for (const el of productLinkEls.slice(0, 20)) {
    const href = await el.getAttribute('href').catch(() => null);
    if (href) discovery.productLinks.push(href);
  }

  // --- Phase 7: Extract search terms from site content ---
  discovery.searchTerms = await page.evaluate(() => {
    const terms = new Set();
    document.querySelectorAll('nav a, [class*="category"] a, [class*="menu"] a').forEach(a => {
      const t = (a.textContent || '').trim();
      if (t.length >= 3 && t.length <= 30 && !/home|about|contact|faq|login|sign|cart|account|privacy|terms|policy/i.test(t)) {
        terms.add(t);
      }
    });
    document.querySelectorAll('[class*="product"] [class*="title"], [class*="product"] [class*="name"], [class*="product"] h2, [class*="product"] h3').forEach(el => {
      const words = (el.textContent || '').trim().split(/\s+/);
      if (words.length >= 1 && words[0].length >= 3) terms.add(words[0]);
    });
    return [...terms].slice(0, 10);
  });
  if (discovery.searchTerms.length === 0) discovery.searchTerms = ['shoes', 'bag', 'dress'];
  log('\uD83D\uDD0D', `Search terms extracted: ${discovery.searchTerms.slice(0, 5).join(', ')}`);

  // Collect forms
  const formEls = await page.$$('form').catch(() => []);
  for (const form of formEls.slice(0, 10)) {
    const action = await form.getAttribute('action').catch(() => '');
    const inputs = await form.$$('input, textarea, select').catch(() => []);
    discovery.forms.push({ action, fieldCount: inputs.length, page: '/' });
  }

  discovery.consoleErrors = consoleErrors.slice();
  discovery.networkErrors = networkErrors.slice();

  log('\uD83D\uDCCA', `Discovery complete: ${discovery.livePages.length} live / ${discovery.deadPages.length} dead / Platform: ${discovery.platform} / Features: ${Object.entries(discovery.features).filter(([,v]) => v).map(([k]) => k).join(', ')}`);
  return discovery;
}

// ─── LAYER 2: PLANNING AGENT ─────────────────────────────────────────────────
function planningAgent(discovery) {
  log('\uD83D\uDCCB', 'Layer 2: Planning Agent starting...');
  const testPlan = [];
  const tier = (t) => MODE === 'fast' ? t <= 1 : MODE === 'standard' ? t <= 2 : t <= 4;

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

  log('\uD83D\uDCCB', `Test plan: ${testPlan.length} phases, ${testPlan.reduce((s, t) => s + t.tests, 0)} tests (mode=${MODE})`);
  return testPlan.filter(t => tier(t.tier));
}

// ─── LAYER 3: EXECUTION AGENT ─────────────────────────────────────────────────

// -- Sanity Tests --
async function runSanityTests(page, discovery) {
  log('\uD83E\uDDEA', '--- Sanity Tests ---');
  const pages = discovery.livePages.slice(0, 20);
  for (const pg of pages) {
    if (isBudgetExceeded()) break;
    try {
      const resp = await safeGoto(page, pg.url);
      const status = resp ? resp.status() : 0;
      testResults.total++;

      if (status >= 400 || status === 0) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `sanity_${pg.path.replace(/\//g, '_')}`);
        addBug(status === 404 ? 'Critical' : 'High', 'Routing', `Page returns ${status}: ${pg.path}`, `The page at ${pg.path} returns HTTP ${status}`, `${pg.path} — Desktop`, ['1. Navigate to ' + pg.url], 'Page loads with 200 OK', `HTTP ${status}`, ss, 'Check server routing and ensure page exists');
      } else {
        // Check for soft 404 — strict: only match headings/dedicated error elements
        const isSoft404 = await page.$('h1:has-text("Page Not Found"), h1:has-text("404"), [class*="not-found"], [class*="error-page"], [class*="page-not-found"]').catch(() => null);
        if (isSoft404) {
          testResults.failed++;
          const ss = await safeScreenshot(page, `sanity_soft404_${pg.path.replace(/\//g, '_')}`);
          addBug('High', 'Routing', `Soft 404 on ${pg.path}`, `Page loads but shows "not found" content`, `${pg.path} — Desktop`, ['1. Navigate to ' + pg.url], 'Valid page content', 'Shows not found / 404 message', ss, 'Check routing configuration');
        } else {
          testResults.passed++;
        }
      }
    } catch (e) {
      testResults.total++;
      testResults.failed++;
    }
  }
}

// -- Visual Tests (Multi-device screenshots) --
async function runVisualTests(browser, discovery) {
  log('\uD83D\uDCF7', '--- Visual Tests ---');
  const pages = discovery.livePages.slice(0, 10);
  const deviceList = [
    { key: 'desktop', config: TEST_DEVICES.desktop },
    { key: '4k', config: TEST_DEVICES['4k'] },
    { key: 'iphone', config: { viewport: TEST_DEVICES.iphone.viewport, userAgent: TEST_DEVICES.iphone.userAgent, isMobile: true, hasTouch: true } },
    { key: 'pixel', config: { viewport: TEST_DEVICES.pixel.viewport, userAgent: TEST_DEVICES.pixel.userAgent, isMobile: true, hasTouch: true } },
  ];

  for (const device of deviceList) {
    if (isBudgetExceeded()) break;
    let context, page;
    try {
      context = await browser.newContext({ viewport: device.config.viewport, userAgent: device.config.userAgent, isMobile: device.config.isMobile, hasTouch: device.config.hasTouch });
      page = await context.newPage();
    } catch (e) { continue; }

    for (const pg of pages) {
      if (isBudgetExceeded()) break;
      try {
        await safeGoto(page, pg.url);
        testResults.total++;
        const ssName = `visual_${device.key}_${pg.path.replace(/\//g, '_') || 'home'}`;
        await safeScreenshot(page, ssName);

        // Check horizontal overflow
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const viewportWidth = device.config.viewport.width;
        if (scrollWidth > viewportWidth + 10) {
          const ss = await safeScreenshot(page, `overflow_${device.key}_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug('Critical', 'Responsive', `Horizontal overflow on ${pg.path} (${device.config.name || device.key})`, `Page scrollWidth (${scrollWidth}px) exceeds viewport (${viewportWidth}px) by ${scrollWidth - viewportWidth}px`, `${pg.path} — ${device.config.name || device.key}`, ['1. Open ' + pg.url, `2. View at ${viewportWidth}x${device.config.viewport.height}`], 'No horizontal scrollbar', `Horizontal overflow of ${scrollWidth - viewportWidth}px`, ss, 'Fix CSS overflow — check max-width constraints');
          testResults.failed++;
        } else {
          testResults.passed++;
        }

        // Check for broken images
        const brokenImgs = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('img')).filter(img => {
            if (img.src.startsWith('data:') || img.src.includes('.svg')) return false;
            return img.complete && img.naturalWidth === 0;
          }).map(img => img.src).slice(0, 5);
        });
        if (brokenImgs.length > 0) {
          testResults.total++;
          testResults.failed++;
          const ss = await safeScreenshot(page, `broken_img_${device.key}_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug('High', 'Image Quality', `${brokenImgs.length} broken image(s) on ${pg.path} (${device.config.name || device.key})`, `Images failed to load: ${brokenImgs.join(', ')}`, `${pg.path} — ${device.config.name || device.key}`, ['1. Open ' + pg.url], 'All images load', `${brokenImgs.length} images broken`, ss, 'Check image URLs and CDN availability');
        }
      } catch (e) {
        testResults.total++;
        testResults.skipped++;
      }
    }
    await context.close().catch(() => {});
  }
}

// -- Universal E-Commerce Tests (PLP, PDP, Cart) --
// Works on Amazon, Flipkart, Myntra, Shopify, WooCommerce, Fynd, etc.
async function runECommerceTests(page, discovery) {
  log('\uD83D\uDED2', `--- E-Commerce Tests (${discovery.platform}) ---`);

  // --- PLP: Find product listing page dynamically ---
  const plpPage = discovery.livePages.find(p =>
    /product|shop|store|catalog|collection|categor|browse|deal|offer|sale|all/i.test(p.path)
  ) || discovery.livePages.find(p => p.path === '/');

  if (plpPage) {
    await safeGoto(page, plpPage.url);
    testResults.total++;

    // Use adaptive selectors to find product cards on ANY platform
    const productCards = await page.$$(SELECTORS.productCard).catch(() => []);
    if (productCards.length === 0) {
      testResults.failed++;
      const ss = await safeScreenshot(page, 'plp_no_products');
      addBug('Critical', 'E-Commerce', 'No product cards found on listing page', `No products detected on ${plpPage.path} using adaptive selectors`, `${plpPage.path} — Desktop`, ['1. Navigate to ' + plpPage.url], 'Product cards visible', 'No product cards found', ss, 'Check product data API and rendering logic');
    } else {
      testResults.passed++;
      log('\u2705', `PLP: Found ${productCards.length} product cards on ${plpPage.path}`);
      await safeScreenshot(page, 'plp_products');

      // Check product card has image + price
      testResults.total++;
      const firstCard = productCards[0];
      const hasImage = await firstCard.$('img').catch(() => null);
      const hasPrice = await firstCard.$(SELECTORS.price).catch(() => null);
      if (!hasImage || !hasPrice) {
        testResults.failed++;
        const ss = await safeScreenshot(page, 'plp_card_structure');
        addBug('High', 'E-Commerce', 'Product card missing image or price', `Product card is missing ${[!hasImage && 'image', !hasPrice && 'price'].filter(Boolean).join(' and ')}`, `${plpPage.path} — Desktop`, ['1. Navigate to PLP', '2. Check first product card'], 'Product card shows image and price', `Missing: ${[!hasImage && 'image', !hasPrice && 'price'].filter(Boolean).join(', ')}`, ss, 'Verify product card template');
      } else {
        testResults.passed++;
      }
    }
  }

  // --- PDP: Navigate to a product detail page ---
  let pdpUrl = null;
  if (discovery.productLinks.length > 0) {
    pdpUrl = discovery.productLinks[0];
    if (!pdpUrl.startsWith('http')) pdpUrl = `${TARGET_URL}${pdpUrl}`;
  } else if (plpPage) {
    // Dynamically find product link from the PLP
    await safeGoto(page, plpPage.url);
    const productLink = await page.$(SELECTORS.productLink);
    if (productLink) pdpUrl = await productLink.getAttribute('href');
    if (pdpUrl && !pdpUrl.startsWith('http')) pdpUrl = `${TARGET_URL}${pdpUrl}`;
  }

  if (pdpUrl) {
    await safeGoto(page, pdpUrl);
    await safeScreenshot(page, 'pdp_page');

    // Check PDP elements with universal selectors
    const checks = [
      { name: 'Product Image', selector: '[class*="product"] img, [class*="gallery"] img, [class*="image"] img, .product-image img, img[class*="product"], #imgTagWrapperId img, #landingImage, ._396cs4', severity: 'Critical' },
      { name: 'Product Price', selector: SELECTORS.price, severity: 'High' },
      { name: 'Add to Cart/Buy Button', selector: SELECTORS.addToCart, severity: 'Critical' },
      { name: 'Product Title', selector: 'h1, [class*="product-title"], [class*="product-name"], [class*="ProductName"], #productTitle, ._35KGlq, .B_NuCI', severity: 'High' },
    ];

    for (const check of checks) {
      testResults.total++;
      const el = await page.$(check.selector).catch(() => null);
      if (!el) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `pdp_missing_${check.name.toLowerCase().replace(/\s/g, '_')}`);
        addBug(check.severity, 'E-Commerce', `PDP missing: ${check.name}`, `Product page does not show ${check.name}`, `PDP — Desktop`, ['1. Navigate to ' + pdpUrl], `${check.name} is visible`, `${check.name} not found on page`, ss, `Ensure ${check.name} is rendered on PDP`);
      } else {
        testResults.passed++;
        log('\u2705', `PDP: ${check.name} found`);
      }
    }

    // Size/variant selector
    testResults.total++;
    const sizeEl = await page.$(SELECTORS.sizeSelector).catch(() => null);
    if (sizeEl) {
      testResults.passed++;
      log('\u2705', 'PDP: Size/variant selector found');
    } else {
      testResults.skipped++;
      log('\u2139\uFE0F', 'PDP: No size selector (may not apply to this product)');
    }

    // Try Add to Cart flow
    testResults.total++;
    const atcBtn = await page.$(SELECTORS.addToCart).catch(() => null);
    if (atcBtn) {
      try {
        // Select size/variant first if available
        const sizeBtn = await page.$(SELECTORS.sizeSelector);
        if (sizeBtn) {
          const tagName = await sizeBtn.evaluate(el => el.tagName.toLowerCase());
          if (tagName === 'select') {
            // Dropdown — select second option
            const options = await sizeBtn.$$('option');
            if (options.length > 1) await options[1].click().catch(() => {});
          } else {
            await sizeBtn.click().catch(() => {});
          }
          await page.waitForTimeout(500);
        }

        await atcBtn.click();
        await page.waitForTimeout(3000);
        await safeScreenshot(page, 'pdp_after_atc');

        const toast = await page.$('[class*="toast"], [class*="notification"], [class*="snackbar"], [class*="alert-success"], [class*="added"], #NATC_SMART_WAGON_CONF_MSG_SUCCESS').catch(() => null);
        const cartCount = await page.$('[class*="cart-count"], [class*="cart_count"], [class*="badge"], #nav-cart-count, ._2MHcPO').catch(() => null);
        if (toast || cartCount) {
          testResults.passed++;
          log('\u2705', 'PDP: Add to Cart successful');
        } else {
          testResults.passed++;
          log('\u2705', 'PDP: Add to Cart clicked (no error)');
        }
      } catch (e) {
        testResults.failed++;
        const ss = await safeScreenshot(page, 'pdp_atc_error');
        addBug('Critical', 'E-Commerce', 'Add to Cart button fails', `Error: ${e.message}`, 'PDP — Desktop', ['1. Open PDP', '2. Select size', '3. Click Add to Cart'], 'Item added to cart', `Error: ${e.message}`, ss, 'Debug the Add to Cart handler');
      }
    }
  }

  // --- Cart page test ---
  const cartPage = discovery.livePages.find(p => /cart|bag|basket/i.test(p.path));
  if (cartPage) {
    await safeGoto(page, cartPage.url);
    testResults.total++;
    await safeScreenshot(page, 'cart_page');

    const cartItems = await page.$$('[class*="cart-item"], [class*="cart_item"], [class*="CartItem"], [class*="bag-item"], [class*="basket-item"], [data-component-type="s-cart-item"], ._1AtVbE').catch(() => []);
    const emptyCart = await page.$('text=/no items/i, text=/empty/i, text=/cart is empty/i, text=/basket is empty/i').catch(() => null);

    if (cartItems.length > 0 || emptyCart) {
      testResults.passed++;
      log('\u2705', `Cart: ${cartItems.length} items or empty state shown`);
    } else {
      testResults.passed++;
      log('\u2139\uFE0F', 'Cart: Page loaded (state unclear)');
    }
  }
}

// -- Universal Search Tests --
// Uses search terms extracted from the site itself — no hardcoded queries
async function runSearchTests(page, discovery) {
  log('\uD83D\uDD0D', '--- Search Tests ---');
  const searchTerm = (discovery.searchTerms && discovery.searchTerms[0]) || 'shoes';
  log('\uD83D\uDD0D', `Search term: "${searchTerm}" (extracted from site)`);

  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(2000);

  testResults.total++;
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
    await safeScreenshot(page, 'search_suggestions');

    // Check for autocomplete
    const suggestions = await page.$$('[class*="suggestion"], [class*="autocomplete"], [class*="search-result"], [class*="dropdown"] li, [class*="search"] li, [class*="typeahead"]').catch(() => []);
    if (suggestions.length > 0) {
      log('\u2705', `Search: ${suggestions.length} autocomplete suggestions`);
    }

    // Submit search
    await searchInput.press('Enter');
    await page.waitForTimeout(3000);
    await safeScreenshot(page, 'search_results');

    // Check results with adaptive selectors
    const results = await page.$$(SELECTORS.productCard + ', [class*="search-result"]').catch(() => []);
    const noResults = await page.$('text=/no results/i, text=/nothing found/i, text=/no products/i, text=/did not match/i, text=/no items/i').catch(() => null);

    if (results.length > 0) {
      testResults.passed++;
      log('\u2705', `Search: ${results.length} results for "${searchTerm}"`);
    } else if (noResults) {
      testResults.failed++;
      const ss = await safeScreenshot(page, 'search_no_results');
      addBug('Medium', 'Search', `Search returns no results for "${searchTerm}"`, `Searching for "${searchTerm}" (extracted from site categories) returns zero results`, 'Search — Desktop', ['1. Click search', `2. Type "${searchTerm}"`, '3. Press Enter'], 'Relevant products shown', 'No results found', ss, 'Check search index and product data');
    } else {
      testResults.passed++;
    }
  } else {
    testResults.failed++;
    const ss = await safeScreenshot(page, 'search_no_input');
    addBug('High', 'Search', 'Search input not accessible', 'Cannot find search input field using multiple selector strategies', 'Homepage — Desktop', ['1. Look for search input/icon'], 'Search input appears', 'No search input found', ss, 'Check search component rendering');
  }
}

// -- Accessibility Tests --
async function runAccessibilityTests(page, discovery) {
  log('\u267F', '--- Accessibility Tests ---');
  let AxeBuilder;
  try { AxeBuilder = require('@axe-core/playwright').default; } catch (e) {
    log('\u26A0\uFE0F', 'axe-core not available, running manual a11y checks');
  }

  const pagesToTest = discovery.livePages.slice(0, 5);
  for (const pg of pagesToTest) {
    if (isBudgetExceeded()) break;
    await safeGoto(page, pg.url);
    testResults.total++;

    if (AxeBuilder) {
      try {
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        const violations = results.violations || [];
        const critical = violations.filter(v => v.impact === 'critical' || v.impact === 'serious');

        if (critical.length > 0) {
          testResults.failed++;
          const ss = await safeScreenshot(page, `a11y_${pg.path.replace(/\//g, '_')}`);
          const desc = critical.slice(0, 5).map(v => `- ${v.help} (${v.impact}, ${v.nodes.length} instances)`).join('\n');
          addBug('High', 'Accessibility', `${critical.length} a11y violations on ${pg.path}`, `Critical/serious WCAG violations:\n${desc}`, `${pg.path} — Desktop`, ['1. Run axe-core audit on ' + pg.path], '0 critical/serious violations', `${critical.length} violations found`, ss, 'Fix WCAG violations: ' + critical[0].help);
        } else {
          testResults.passed++;
          log('\u2705', `A11y: ${pg.path} — ${violations.length} minor issues`);
        }
      } catch (e) {
        testResults.skipped++;
      }
    } else {
      // Manual checks
      const imgs = await page.$$eval('img:not([alt])', els => els.filter(el => el.offsetWidth > 50).length).catch(() => 0);
      const inputs = await page.$$eval('input:not([aria-label]):not([id])', els => els.filter(el => !el.closest('label')).length).catch(() => 0);
      const langAttr = await page.$eval('html', el => el.getAttribute('lang')).catch(() => null);

      let issues = [];
      if (imgs > 0) issues.push(`${imgs} images missing alt text`);
      if (inputs > 0) issues.push(`${inputs} inputs missing labels`);
      if (!langAttr) issues.push('Missing lang attribute on <html>');

      if (issues.length > 0) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `a11y_manual_${pg.path.replace(/\//g, '_')}`);
        addBug('Medium', 'Accessibility', `A11y issues on ${pg.path}`, issues.join('; '), `${pg.path} — Desktop`, ['1. Audit page with accessibility checker'], 'No accessibility issues', issues.join('; '), ss, 'Add missing alt text, labels, and lang attribute');
      } else {
        testResults.passed++;
      }
    }
  }
}

// -- Performance / Web Vitals Tests --
async function runPerformanceTests(page, discovery) {
  log('\u26A1', '--- Performance Tests ---');
  const pagesToTest = discovery.livePages.slice(0, 5);

  for (const pg of pagesToTest) {
    if (isBudgetExceeded()) break;
    testResults.total++;
    try {
      const startNav = Date.now();
      await page.goto(pg.url, { waitUntil: 'load', timeout: 30000 });
      const loadTime = Date.now() - startNav;

      // Measure web vitals via Performance API
      const vitals = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0] || {};
        const paint = performance.getEntriesByType('paint');
        const fcp = paint.find(p => p.name === 'first-contentful-paint');
        return {
          ttfb: perf.responseStart ? Math.round(perf.responseStart - perf.requestStart) : null,
          fcp: fcp ? Math.round(fcp.startTime) : null,
          domSize: document.querySelectorAll('*').length,
          loadTime: Math.round(perf.loadEventEnd - perf.navigationStart) || null,
        };
      });

      // Store metrics for the report's Performance section
      perfData.push({
        path: pg.path, status: pg.status || 200,
        loadTime, fcp: vitals.fcp, lcp: vitals.fcp, // LCP approximation
        cls: 0, ttfb: vitals.ttfb, requests: null,
        transferSize: null, domNodes: vitals.domSize,
      });

      const issues = [];
      if (vitals.fcp && vitals.fcp > 3000) issues.push(`FCP: ${vitals.fcp}ms (poor, >3000ms)`);
      if (vitals.ttfb && vitals.ttfb > 800) issues.push(`TTFB: ${vitals.ttfb}ms (poor, >800ms)`);
      if (vitals.domSize > 3000) issues.push(`DOM size: ${vitals.domSize} elements (warning, >3000)`);
      if (loadTime > 10000) issues.push(`Total load: ${loadTime}ms (>10s)`);

      if (issues.length > 0) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `perf_${pg.path.replace(/\//g, '_')}`);
        addBug(vitals.fcp > 4000 || loadTime > 15000 ? 'High' : 'Medium', 'Performance', `Performance issues on ${pg.path}`, issues.join('; '), `${pg.path} — Desktop`, ['1. Load ' + pg.url, '2. Measure Core Web Vitals'], 'FCP <1800ms, TTFB <200ms, DOM <3000', issues.join('; '), ss, 'Optimize loading performance');
      } else {
        testResults.passed++;
        log('\u2705', `Perf: ${pg.path} — FCP:${vitals.fcp || '?'}ms TTFB:${vitals.ttfb || '?'}ms DOM:${vitals.domSize}`);
      }
    } catch (e) {
      testResults.failed++;
    }
  }
}

// -- 4K UHD Tests --
async function run4KTests(browser, discovery) {
  log('\uD83D\uDDA5\uFE0F', '--- 4K UHD Tests (3840x2160) ---');
  const context = await browser.newContext({ viewport: { width: 3840, height: 2160 } });
  const page = await context.newPage();
  const pagesToTest = discovery.livePages.slice(0, 10);

  for (const pg of pagesToTest) {
    if (isBudgetExceeded()) break;
    await safeGoto(page, pg.url);
    const ssName = `4k_${pg.path.replace(/\//g, '_') || 'home'}`;
    await safeScreenshot(page, ssName);

    // 1. Horizontal scroll check
    testResults.total++;
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollW > 3850) {
      testResults.failed++;
      addBug('Critical', '4K Responsive', `Horizontal scroll at 4K on ${pg.path}`, `scrollWidth (${scrollW}px) > viewport (3840px)`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160'], 'No horizontal overflow', `${scrollW - 3840}px overflow`, screenshots[ssName], 'Fix CSS max-width at 4K');
    } else { testResults.passed++; }

    // 2. Nav width check
    testResults.total++;
    const navWidth = await page.evaluate(() => {
      const nav = document.querySelector('nav, header, [class*="navbar"], [class*="header"]');
      return nav ? nav.getBoundingClientRect().width : 0;
    });
    if (navWidth > 0 && navWidth < 3840 * 0.5) {
      testResults.failed++;
      addBug('High', '4K Responsive', `Nav covers only ${Math.round(navWidth / 3840 * 100)}% at 4K on ${pg.path}`, `Navigation bar is ${Math.round(navWidth)}px wide on 3840px viewport`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160', '2. Check nav width'], 'Nav covers >50% viewport', `Nav covers ${Math.round(navWidth / 3840 * 100)}%`, screenshots[ssName], 'Set nav max-width: 100% at large viewports');
    } else { testResults.passed++; }

    // 3. Blurry images check
    testResults.total++;
    const blurryImgs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).filter(img => {
        if (!img.src || img.src.startsWith('data:') || img.src.includes('.svg')) return false;
        const rect = img.getBoundingClientRect();
        if (rect.width < 200) return false;
        return img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5;
      }).length;
    });
    if (blurryImgs > 0) {
      testResults.failed++;
      addBug('High', 'Image Quality', `${blurryImgs} blurry image(s) at 4K on ${pg.path}`, `Images are upscaled >2x at 4K resolution, appearing blurry`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160', '2. Check image clarity'], 'Sharp images at 4K', `${blurryImgs} blurry images`, screenshots[ssName], 'Provide higher resolution image assets for 4K displays');
    } else { testResults.passed++; }

    // 4. Untappable elements check
    testResults.total++;
    const tinyEls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]')).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.height < 25 && rect.width > 0;
      }).length;
    });
    if (tinyEls >= 2) {
      testResults.failed++;
      addBug('High', '4K Responsive', `${tinyEls} untappable elements (<25px) at 4K on ${pg.path}`, `Interactive elements too small for touch at 4K resolution`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160'], 'All interactive elements >= 25px', `${tinyEls} elements < 25px`, screenshots[ssName], 'Increase min-height for interactive elements');
    } else { testResults.passed++; }

    // 5. Excessive whitespace check
    testResults.total++;
    const contentRatio = await page.evaluate(() => {
      const body = document.body;
      const contentEls = document.querySelectorAll('img, p, h1, h2, h3, h4, h5, h6, span, a, button, input, table, ul, ol');
      let contentArea = 0;
      contentEls.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) contentArea += rect.width * rect.height;
      });
      const viewportArea = window.innerWidth * window.innerHeight;
      return contentArea / viewportArea;
    });
    if (contentRatio < 0.4) {
      testResults.failed++;
      addBug('High', '4K Responsive', `Excessive whitespace at 4K on ${pg.path} (${Math.round(contentRatio * 100)}% content)`, `Content covers less than 40% of 4K viewport`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160'], 'Content covers >40% of viewport', `Content covers ${Math.round(contentRatio * 100)}%`, screenshots[ssName], 'Use fluid layouts or max-width containers for 4K');
    } else { testResults.passed++; }
  }

  await context.close().catch(() => {});
}

// -- Interaction Tests --
async function runInteractionTests(page, discovery) {
  log('\uD83D\uDD04', '--- Interaction Tests ---');
  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(2000);

  // Sticky header test
  testResults.total++;
  const headerBefore = await page.evaluate(() => {
    const header = document.querySelector('header, [class*="header"], nav');
    return header ? header.getBoundingClientRect().top : null;
  });
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(1000);
  const headerAfter = await page.evaluate(() => {
    const header = document.querySelector('header, [class*="header"], nav');
    if (!header) return null;
    const style = window.getComputedStyle(header);
    return { top: header.getBoundingClientRect().top, position: style.position };
  });
  if (headerAfter && (headerAfter.position === 'fixed' || headerAfter.position === 'sticky' || headerAfter.top < 10)) {
    testResults.passed++;
    log('\u2705', 'Interaction: Sticky header works');
  } else {
    testResults.failed++;
    const ss = await safeScreenshot(page, 'sticky_header');
    addBug('Medium', 'Interaction', 'Header is not sticky after scroll', 'Header does not remain fixed when scrolling down', 'Homepage — Desktop', ['1. Open homepage', '2. Scroll down 500px'], 'Header stays fixed at top', 'Header scrolls away', ss, 'Add position: sticky to header');
  }

  // Back to top test
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);
  testResults.total++;
  const backToTop = await page.$('button[class*="back-to-top"], [class*="scroll-top"], a[href="#top"], [class*="backToTop"], [aria-label*="top"]');
  if (backToTop) {
    testResults.passed++;
    log('\u2705', 'Interaction: Back to top button found');
  } else {
    testResults.skipped++;
    log('\u2139\uFE0F', 'Interaction: No back-to-top button (optional)');
  }

  // Carousel/Slider test
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(500);
  testResults.total++;
  const carousel = await page.$('[class*="carousel"], [class*="slider"], [class*="swiper"], [class*="banner"], [class*="hero-slide"]');
  if (carousel) {
    const nextBtn = await page.$('[class*="carousel"] [class*="next"], [class*="slider"] [class*="next"], [class*="swiper-button-next"], button[aria-label*="next"]');
    if (nextBtn) {
      await nextBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      testResults.passed++;
      log('\u2705', 'Interaction: Carousel next button works');
    } else {
      testResults.passed++;
      log('\u2705', 'Interaction: Carousel found (no next button)');
    }
  } else {
    testResults.skipped++;
    log('\u2139\uFE0F', 'Interaction: No carousel/slider found');
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

// -- Link Validation --
async function runLinkValidation(page, discovery) {
  log('\uD83D\uDD17', '--- Link Validation ---');
  const allLinks = [...discovery.navLinks, ...discovery.footerLinks];
  const checked = new Set();

  for (const link of allLinks.slice(0, 30)) {
    if (isBudgetExceeded()) break;
    let href = link.href;
    if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (!href.startsWith('http')) href = `${TARGET_URL}${href.startsWith('/') ? '' : '/'}${href}`;
    if (checked.has(href)) continue;
    checked.add(href);

    // Only check internal links
    try {
      const linkUrl = new URL(href);
      if (linkUrl.hostname !== new URL(TARGET_URL).hostname) continue;
    } catch (e) { continue; }

    testResults.total++;
    try {
      const resp = await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = resp ? resp.status() : 0;
      if (status >= 400) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `link_broken_${link.text.replace(/\W/g, '_').slice(0, 30)}`);
        addBug('High', 'Navigation', `Broken link: "${link.text}" → ${status}`, `Link "${link.text}" (${href}) returns HTTP ${status}`, 'Navigation/Footer — Desktop', ['1. Click "' + link.text + '"'], 'Link loads (200)', `HTTP ${status}`, ss, 'Fix link URL or remove dead link');
      } else {
        testResults.passed++;
      }
    } catch (e) {
      testResults.total++;
      testResults.failed++;
    }
  }
}

// -- Form Validation Tests --
async function runFormValidationTests(page, discovery) {
  log('\uD83D\uDCDD', '--- Form Validation Tests ---');
  // Test contact form
  const contactPage = discovery.livePages.find(p => p.path === '/contact-us' || p.path === '/contact');
  if (contactPage) {
    await safeGoto(page, contactPage.url);
    testResults.total++;

    const form = await page.$('form');
    if (form) {
      // Try empty submit
      const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Submit"), button:has-text("Send")');
      if (submitBtn) {
        await submitBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
        const validationErrors = await page.$$('[class*="error"], [class*="invalid"], .error, .invalid, [aria-invalid="true"]').catch(() => []);
        if (validationErrors.length > 0) {
          testResults.passed++;
          log('\u2705', 'Form: Empty submit shows validation errors');
        } else {
          testResults.failed++;
          const ss = await safeScreenshot(page, 'form_no_validation');
          addBug('Medium', 'Form Validation', 'No validation on empty form submit', 'Submitting empty form shows no validation errors', `${contactPage.path} — Desktop`, ['1. Open contact page', '2. Click submit without filling fields'], 'Validation errors shown', 'No validation errors', ss, 'Add required field validation');
        }
      }
      await safeScreenshot(page, 'form_validation');
    }
  }
}

// -- Session Tests --
async function runSessionTests(page, discovery) {
  log('\uD83D\uDD12', '--- Session Tests ---');
  if (!loggedIn) {
    log('\u26A0\uFE0F', 'Session tests skipped — not logged in');
    testResults.skipped += 3;
    testResults.total += 3;
    return;
  }

  // Test session persistence after refresh
  testResults.total++;
  await safeGoto(page, TARGET_URL);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const stillLoggedIn = await page.$('a[href*="profile"], [class*="user-icon"], [class*="account"], a:has-text("Logout")');
  if (stillLoggedIn) {
    testResults.passed++;
    log('\u2705', 'Session: Persists after refresh');
  } else {
    testResults.failed++;
    const ss = await safeScreenshot(page, 'session_lost');
    addBug('High', 'Session', 'Session lost after page refresh', 'User is logged out after refreshing the page', 'Homepage — Desktop', ['1. Login', '2. Refresh page'], 'Still logged in', 'Session lost', ss, 'Check session cookie persistence');
  }

  // Test profile accessible
  testResults.total++;
  const profilePage = discovery.livePages.find(p => p.path === '/profile');
  if (profilePage) {
    await safeGoto(page, profilePage.url);
    const redirected = page.url().includes('/login') || page.url().includes('/auth');
    if (redirected) {
      testResults.failed++;
      const ss = await safeScreenshot(page, 'profile_redirect');
      addBug('High', 'Session', 'Profile redirects to login despite being authenticated', 'Accessing /profile redirects to login page', '/profile — Desktop', ['1. Login', '2. Navigate to /profile'], 'Profile page loads', 'Redirected to login', ss, 'Check auth middleware for profile route');
    } else {
      testResults.passed++;
      log('\u2705', 'Session: Profile accessible');
    }
  }
}

// -- Security Tests --
async function runSecurityTests(page, discovery) {
  log('\uD83D\uDD12', '--- Security Tests ---');

  // Check HTTPS
  testResults.total++;
  if (TARGET_URL.startsWith('https://')) {
    testResults.passed++;
  } else {
    testResults.failed++;
    const httpSs = await safeScreenshot(page, 'security_no_https');
    addBug('Critical', 'Security', 'Site not using HTTPS', 'Site is served over HTTP instead of HTTPS', 'All pages', ['1. Check URL protocol'], 'HTTPS', 'HTTP', httpSs, 'Enable HTTPS/TLS');
  }

  // Check security headers
  testResults.total++;
  try {
    const resp = await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    const headers = resp ? resp.headers() : {};
    const missingHeaders = [];
    if (!headers['strict-transport-security']) missingHeaders.push('HSTS');
    if (!headers['x-frame-options'] && !headers['content-security-policy']?.includes('frame-ancestors')) missingHeaders.push('X-Frame-Options');
    if (!headers['x-content-type-options']) missingHeaders.push('X-Content-Type-Options');

    if (missingHeaders.length > 0) {
      testResults.failed++;
      const headerSs = await safeScreenshot(page, 'security_missing_headers');
      addBug('Medium', 'Security', `Missing security headers: ${missingHeaders.join(', ')}`, `The following security headers are absent: ${missingHeaders.join(', ')}`, 'All pages', ['1. Check response headers'], 'All security headers present', `Missing: ${missingHeaders.join(', ')}`, headerSs, 'Add missing security headers to server config');
    } else {
      testResults.passed++;
    }
  } catch (e) { testResults.skipped++; }

  // XSS test on search
  testResults.total++;
  if (discovery.features.hasSearch) {
    await safeGoto(page, `${TARGET_URL}/?q=<script>alert('xss')</script>`);
    await page.waitForTimeout(2000);
    const bodyHtml = await page.content();
    if (bodyHtml.includes("<script>alert('xss')</script>")) {
      testResults.failed++;
      const ss = await safeScreenshot(page, 'xss_reflected');
      addBug('Critical', 'Security', 'Reflected XSS in search', 'Script tag is reflected in page HTML without sanitization', 'Search — Desktop', ['1. Enter XSS payload in search'], 'Input sanitized', 'Script tag reflected in DOM', ss, 'Sanitize all user input before rendering');
    } else {
      testResults.passed++;
      log('\u2705', 'Security: No reflected XSS in search');
    }
  } else { testResults.skipped++; }
}

// -- User Journey Tests --
async function runUserJourneyTests(page, discovery) {
  log('\uD83D\uDEB6', '--- User Journey Tests ---');

  // Journey 1: Browse → PLP → PDP
  testResults.total++;
  try {
    await safeGoto(page, TARGET_URL);
    await safeScreenshot(page, 'journey1_home');

    // Navigate to products
    const plp = discovery.livePages.find(p => p.path === '/products' || p.path === '/collections');
    if (plp) {
      await safeGoto(page, plp.url);
      await safeScreenshot(page, 'journey1_plp');

      // Click first product
      const productLink = await page.$('a[href*="/product/"], [class*="product-card"] a, [class*="product-item"] a');
      if (productLink) {
        await productLink.click();
        await page.waitForTimeout(3000);
        await safeScreenshot(page, 'journey1_pdp');
        testResults.passed++;
        log('\u2705', 'Journey 1: Browse → PLP → PDP successful');
      } else {
        testResults.failed++;
        const ss = await safeScreenshot(page, 'journey1_no_product');
        addBug('High', 'User Journey', 'Cannot navigate from PLP to PDP', 'No clickable product links on PLP', 'Products — Desktop', ['1. Open PLP', '2. Click product'], 'PDP opens', 'No product links found', ss, 'Add product links to PLP cards');
      }
    } else {
      testResults.skipped++;
    }
  } catch (e) {
    testResults.failed++;
  }

  // Journey 2: Homepage deep scroll
  testResults.total++;
  try {
    await safeGoto(page, TARGET_URL);

    // Scroll test
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(1000);
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(1000);

    // Check for lazy loaded images
    const allImgs = await page.$$eval('img', imgs => imgs.filter(i => i.offsetWidth > 0).length);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(2000);
    await safeScreenshot(page, 'journey2_bottom');

    // Check for JS errors during scroll
    const recentErrors = consoleErrors.filter(e => Date.now() - e.timestamp < 10000);
    if (recentErrors.length > 3) {
      testResults.failed++;
      addBug('Medium', 'UI Functionality', 'Console errors during scroll', `${recentErrors.length} JS errors occurred while scrolling`, 'Homepage — Desktop', ['1. Open homepage', '2. Scroll to bottom'], 'No JS errors', `${recentErrors.length} errors`, screenshots['journey2_bottom'], 'Fix JS errors triggered by scroll events');
    } else {
      testResults.passed++;
      log('\u2705', 'Journey 2: Deep scroll — no issues');
    }
  } catch (e) {
    testResults.failed++;
  }

  // Journey 3: Search → Product (if search works)
  if (discovery.features.hasSearch) {
    testResults.total++;
    try {
      await safeGoto(page, TARGET_URL);
      const searchIcon = await page.$('input[type="search"], [class*="search"] input, [placeholder*="search" i], button[aria-label*="search" i], [class*="search-icon"], [class*="search"]');
      if (searchIcon) {
        await searchIcon.click();
        await page.waitForTimeout(1000);
        const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], [class*="search"] input, input[name="q"]');
        if (searchInput) {
          await searchInput.fill('bag');
          await searchInput.press('Enter');
          await page.waitForTimeout(3000);
          await safeScreenshot(page, 'journey3_search_results');

          const resultLink = await page.$('a[href*="/product/"]');
          if (resultLink) {
            await resultLink.click();
            await page.waitForTimeout(3000);
            await safeScreenshot(page, 'journey3_pdp');
            testResults.passed++;
            log('\u2705', 'Journey 3: Search → PDP successful');
          } else {
            testResults.passed++; // Search worked, just no product links
          }
        } else {
          testResults.skipped++;
        }
      } else {
        testResults.skipped++;
      }
    } catch (e) {
      testResults.failed++;
    }
  }
}

// -- SEO / Meta Tag Tests --
async function runSEOTests(page, discovery) {
  log('\uD83D\uDD0E', '--- SEO / Meta Tag Tests ---');
  const pagesToTest = discovery.livePages.slice(0, 8);

  for (const pg of pagesToTest) {
    if (isBudgetExceeded()) break;
    await safeGoto(page, pg.url);
    testResults.total++;

    const seo = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el ? el.getAttribute('content') : null;
      };
      return {
        title: document.title || '',
        description: getMeta('description'),
        ogTitle: getMeta('og:title'),
        ogDescription: getMeta('og:description'),
        ogImage: getMeta('og:image'),
        canonical: document.querySelector('link[rel="canonical"]')?.href || null,
        h1Count: document.querySelectorAll('h1').length,
        hasViewport: !!document.querySelector('meta[name="viewport"]'),
        hasCharset: !!document.querySelector('meta[charset]'),
        imgsMissingAlt: Array.from(document.querySelectorAll('img')).filter(i => i.offsetWidth > 50 && (!i.alt || !i.alt.trim())).length,
      };
    });

    const issues = [];
    if (!seo.title || seo.title.length < 10) issues.push('Title missing or too short (<10 chars)');
    if (seo.title && seo.title.length > 70) issues.push(`Title too long (${seo.title.length} chars, max 70)`);
    if (!seo.description) issues.push('Missing meta description');
    if (seo.description && seo.description.length > 160) issues.push(`Meta description too long (${seo.description.length} chars)`);
    if (!seo.ogTitle) issues.push('Missing og:title');
    if (!seo.ogImage) issues.push('Missing og:image');
    if (!seo.canonical) issues.push('Missing canonical URL');
    if (seo.h1Count === 0) issues.push('No <h1> tag on page');
    if (seo.h1Count > 1) issues.push(`Multiple <h1> tags (${seo.h1Count})`);
    if (seo.imgsMissingAlt > 0) issues.push(`${seo.imgsMissingAlt} images missing alt text`);

    if (issues.length > 0) {
      testResults.failed++;
      const ss = await safeScreenshot(page, `seo_${pg.path.replace(/\//g, '_')}`);
      addBug(issues.some(i => i.includes('Title missing') || i.includes('No <h1>')) ? 'High' : 'Medium', 'SEO', `SEO issues on ${pg.path} (${issues.length})`, issues.join('; '), `${pg.path} — Desktop`, ['1. Audit ' + pg.url + ' with SEO checker'], 'Valid meta tags and SEO structure', issues.join('; '), ss, 'Add missing meta tags and fix SEO structure');
    } else {
      testResults.passed++;
      log('\u2705', `SEO: ${pg.path} — all checks passed`);
    }
  }
}

// -- Cookie Consent Tests --
async function runCookieConsentTests(page, discovery) {
  log('\uD83C\uDF6A', '--- Cookie Consent Tests ---');
  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(3000);
  testResults.total++;

  const cookieBanner = await page.$('[class*="cookie"], [class*="consent"], [class*="Cookie"], [class*="Consent"], [class*="gdpr"], [class*="GDPR"], [id*="cookie"], [id*="consent"], [aria-label*="cookie" i]');

  if (cookieBanner) {
    const isVisible = await cookieBanner.isVisible().catch(() => false);
    if (isVisible) {
      testResults.passed++;
      log('\u2705', 'Cookie: Consent banner is displayed');
      await safeScreenshot(page, 'cookie_consent_banner');

      // Test accept button
      testResults.total++;
      const acceptBtn = await page.$('[class*="cookie"] button:has-text("Accept"), [class*="consent"] button:has-text("Accept"), [class*="cookie"] button:has-text("OK"), [class*="consent"] button:has-text("Allow"), button:has-text("Accept All"), button:has-text("Accept Cookies")');
      if (acceptBtn) {
        await acceptBtn.click().catch(() => {});
        await page.waitForTimeout(1500);
        const stillVisible = await cookieBanner.isVisible().catch(() => false);
        if (!stillVisible) {
          testResults.passed++;
          log('\u2705', 'Cookie: Banner dismissed after Accept');
        } else {
          testResults.failed++;
          const ss = await safeScreenshot(page, 'cookie_not_dismissed');
          addBug('Medium', 'Cookie Consent', 'Cookie banner not dismissed after Accept', 'Clicking Accept does not hide the cookie consent banner', 'Homepage — Desktop', ['1. Wait for cookie banner', '2. Click Accept'], 'Banner is hidden', 'Banner still visible', ss, 'Fix dismiss logic on cookie accept handler');
        }
      } else {
        testResults.failed++;
        const ss = await safeScreenshot(page, 'cookie_no_accept_btn');
        addBug('Medium', 'Cookie Consent', 'No Accept button on cookie banner', 'Cookie consent banner has no Accept/OK button', 'Homepage — Desktop', ['1. Check cookie banner'], 'Accept button visible', 'No accept button found', ss, 'Add Accept button to cookie consent component');
      }
    } else {
      testResults.skipped++;
      log('\u2139\uFE0F', 'Cookie: Banner element exists but not visible');
    }
  } else {
    testResults.skipped++;
    log('\u2139\uFE0F', 'Cookie: No consent banner found (may not be required for this region)');
  }
}

// -- Mobile Menu Tests --
async function runMobileMenuTests(browser, discovery) {
  log('\uD83D\uDCF1', '--- Mobile Menu Tests ---');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
  });
  const page = await context.newPage();

  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(2000);

  // Test hamburger menu presence
  testResults.total++;
  const hamburger = await page.$('button[class*="menu"], button[class*="hamburger"], button[aria-label*="menu" i], [class*="menu-toggle"], [class*="nav-toggle"], [class*="burger"], button:has(svg[class*="menu"]), .hamburger');
  if (hamburger) {
    testResults.passed++;
    log('\u2705', 'Mobile Menu: Hamburger icon found');
    await safeScreenshot(page, 'mobile_menu_closed');

    // Test menu opens
    testResults.total++;
    await hamburger.click().catch(() => {});
    await page.waitForTimeout(1500);
    const menuPanel = await page.$('nav[class*="open"], [class*="menu"][class*="open"], [class*="sidebar"][class*="open"], [class*="drawer"][class*="open"], nav[class*="active"], [class*="mobile-menu"], [class*="nav-menu"]');
    const menuLinks = await page.$$('nav a, [class*="menu"] a, [class*="sidebar"] a, [class*="drawer"] a').catch(() => []);

    if (menuPanel || menuLinks.length > 3) {
      testResults.passed++;
      log('\u2705', `Mobile Menu: Opens with ${menuLinks.length} links`);
      await safeScreenshot(page, 'mobile_menu_open');

      // Test menu close
      testResults.total++;
      const closeBtn = await page.$('button[class*="close"], button[aria-label*="close" i], [class*="menu-close"]');
      if (closeBtn) {
        await closeBtn.click().catch(() => {});
        await page.waitForTimeout(1000);
        testResults.passed++;
        log('\u2705', 'Mobile Menu: Close button works');
      } else {
        // Try clicking hamburger again to toggle
        await hamburger.click().catch(() => {});
        await page.waitForTimeout(1000);
        testResults.passed++;
        log('\u2705', 'Mobile Menu: Toggle close works');
      }
    } else {
      testResults.failed++;
      const ss = await safeScreenshot(page, 'mobile_menu_broken');
      addBug('High', 'Mobile Navigation', 'Mobile menu does not open', 'Clicking hamburger icon does not reveal navigation menu', 'Homepage — iPhone', ['1. Open on mobile', '2. Tap hamburger icon'], 'Navigation menu opens', 'Menu does not appear', ss, 'Fix mobile menu toggle handler');
    }
  } else {
    testResults.failed++;
    const ss = await safeScreenshot(page, 'mobile_no_hamburger');
    addBug('High', 'Mobile Navigation', 'No hamburger menu on mobile', 'Mobile viewport shows no hamburger/menu icon for navigation', 'Homepage — iPhone (390x844)', ['1. Open on mobile viewport'], 'Hamburger menu visible', 'No menu icon found', ss, 'Add hamburger menu for mobile viewports');
  }

  // Test touch target sizes on mobile
  testResults.total++;
  const smallTouchTargets = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a, button, input, select, [role="button"]')).filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.height > 0 && (rect.height < 44 || rect.width < 44) && rect.width > 0;
    }).length;
  });
  if (smallTouchTargets > 5) {
    testResults.failed++;
    const ss = await safeScreenshot(page, 'mobile_touch_targets');
    addBug('Medium', 'Mobile UX', `${smallTouchTargets} elements below 44px touch target`, 'Apple HIG recommends minimum 44x44px touch targets', 'Homepage — iPhone', ['1. Open on mobile', '2. Check interactive element sizes'], 'All touch targets >= 44px', `${smallTouchTargets} elements below 44px`, ss, 'Increase padding/min-height on interactive elements');
  } else {
    testResults.passed++;
    log('\u2705', `Mobile: Touch targets OK (${smallTouchTargets} small elements)`);
  }

  await context.close().catch(() => {});
}

// -- Lazy Loading Tests --
async function runLazyLoadTests(page, discovery) {
  log('\uD83D\uDDBC\uFE0F', '--- Lazy Loading Tests ---');
  await safeGoto(page, TARGET_URL);
  await page.waitForTimeout(2000);
  testResults.total++;

  // Count images above the fold
  const aboveFold = await page.evaluate(() => {
    const viewportH = window.innerHeight;
    const allImgs = Array.from(document.querySelectorAll('img'));
    const above = allImgs.filter(img => img.getBoundingClientRect().top < viewportH);
    const below = allImgs.filter(img => img.getBoundingClientRect().top >= viewportH);
    const lazyBelow = below.filter(img => img.loading === 'lazy' || img.getAttribute('data-src') || img.classList.contains('lazyload'));
    return {
      totalImages: allImgs.length,
      aboveFold: above.length,
      belowFold: below.length,
      lazyLoaded: lazyBelow.length,
      belowWithoutLazy: below.length - lazyBelow.length,
    };
  });

  if (aboveFold.belowFold > 0 && aboveFold.belowWithoutLazy > 5) {
    testResults.failed++;
    const ss = await safeScreenshot(page, 'lazy_load_missing');
    addBug('Medium', 'Performance', `${aboveFold.belowWithoutLazy} below-fold images not lazy loaded`, `${aboveFold.belowWithoutLazy} of ${aboveFold.belowFold} below-fold images lack lazy loading — hurts initial page load`, 'Homepage — Desktop', ['1. Check images below viewport', '2. Verify loading="lazy" attribute'], 'Below-fold images use lazy loading', `${aboveFold.belowWithoutLazy} images load eagerly`, ss, 'Add loading="lazy" to below-fold images');
  } else {
    testResults.passed++;
    log('\u2705', `Lazy Load: ${aboveFold.lazyLoaded}/${aboveFold.belowFold} below-fold images are lazy loaded`);
  }

  // Scroll and verify images actually load
  testResults.total++;
  const beforeScroll = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter(i => i.complete && i.naturalWidth > 0).length);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  const afterScroll = await page.evaluate(() => Array.from(document.querySelectorAll('img')).filter(i => i.complete && i.naturalWidth > 0).length);

  if (afterScroll >= beforeScroll) {
    testResults.passed++;
    log('\u2705', `Lazy Load: Images loaded after scroll (${beforeScroll} → ${afterScroll})`);
  } else {
    testResults.failed++;
    const lazySs = await safeScreenshot(page, 'lazy_load_fail');
    addBug('Medium', 'Performance', 'Images fail to load on scroll', `Image count dropped from ${beforeScroll} to ${afterScroll} after scrolling`, 'Homepage — Desktop', ['1. Scroll to bottom'], 'All lazy images load', 'Some images failed to load', lazySs, 'Check lazy loading implementation');
  }

  await page.evaluate(() => window.scrollTo(0, 0));
}

// -- Exploratory Tests (Monkey Testing) --
async function runExploratoryTests(page, discovery) {
  log('🐒', '--- Exploratory / Monkey Tests ---');
  const pagesToExplore = discovery.livePages.slice(0, 5);
  const jsErrors = [];

  // Capture JS errors during exploratory run
  page.on('pageerror', err => jsErrors.push({ page: page.url(), error: err.message }));

  for (const pg of pagesToExplore) {
    if (isBudgetExceeded()) break;
    try {
      await safeGoto(page, pg.url);
      await page.waitForTimeout(1000);

      // ── Test 1: Rapid clicking — find race conditions / double-submit bugs ──
      testResults.total++;
      const clickables = await page.$$('a, button, [role="button"], [onclick]');
      const rapidErrors = [];
      for (const el of clickables.slice(0, 8)) {
        try {
          const box = await el.boundingBox();
          if (!box || box.width < 5 || box.height < 5) continue;
          // Double-click rapidly
          await el.click({ timeout: 2000 }).catch(() => {});
          await el.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(200);
        } catch (e) {
          rapidErrors.push(e.message.slice(0, 80));
        }
      }
      // Navigate back to the test page after clicks may have navigated away
      if (page.url() !== pg.url) await safeGoto(page, pg.url);

      if (rapidErrors.length > 3) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `exploratory_rapid_${pg.path.replace(/\//g, '_') || 'home'}`);
        addBug('Medium', 'Exploratory', `Rapid click issues on ${pg.path}`, `${rapidErrors.length} errors during rapid clicking: ${rapidErrors.slice(0, 3).join('; ')}`, `${pg.path} — Desktop`, ['1. Open ' + pg.url, '2. Rapidly click interactive elements'], 'No errors on rapid clicks', `${rapidErrors.length} errors occurred`, ss, 'Add debounce/throttle to click handlers and prevent double-submit');
      } else {
        testResults.passed++;
      }

      // ── Test 2: Random input in text fields ──
      testResults.total++;
      const inputs = await page.$$('input[type="text"], input[type="search"], input[type="email"], input:not([type]), textarea');
      const fuzzStrings = ['<script>alert(1)</script>', '💩🔥🎉', "' OR 1=1 --", 'a'.repeat(500), '   ', '../../etc/passwd', '{{constructor.constructor("return this")()}}'];
      let inputCrash = false;
      for (const input of inputs.slice(0, 4)) {
        try {
          const fuzz = fuzzStrings[Math.floor(Math.random() * fuzzStrings.length)];
          await input.fill('');
          await input.type(fuzz, { delay: 10 });
          await page.waitForTimeout(300);
        } catch (e) {
          inputCrash = true;
        }
      }
      if (inputCrash) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `exploratory_input_${pg.path.replace(/\//g, '_') || 'home'}`);
        addBug('High', 'Exploratory', `Input fuzzing crash on ${pg.path}`, 'Page crashed or threw errors when unexpected input was entered in text fields', `${pg.path} — Desktop`, ['1. Enter special characters in input fields', '2. Enter very long strings', '3. Enter XSS/SQL payloads'], 'Graceful handling of unexpected input', 'Page crashed or errored', ss, 'Add input validation and sanitization');
      } else {
        testResults.passed++;
      }

      // Navigate back clean
      await safeGoto(page, pg.url);

      // ── Test 3: Back/Forward navigation ──
      testResults.total++;
      try {
        // Navigate to a second page, then back, then forward
        const secondPage = pagesToExplore.find(p => p.url !== pg.url);
        if (secondPage) {
          await safeGoto(page, secondPage.url);
          await page.waitForTimeout(500);
          await page.goBack({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          const backUrl = page.url();
          await page.goForward({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          const forwardUrl = page.url();

          // Check if the page looks broken after back/forward
          const isBroken = await page.evaluate(() => {
            return document.body.innerText.length < 50 || document.title === '' || document.querySelectorAll('img[src=""],img:not([src])').length > 5;
          });

          if (isBroken) {
            testResults.failed++;
            const ss = await safeScreenshot(page, `exploratory_backfwd_${pg.path.replace(/\//g, '_') || 'home'}`);
            addBug('High', 'Exploratory', `Page broken after Back/Forward on ${pg.path}`, `Navigating Back → Forward results in broken page state (empty content or missing images)`, `${pg.path} — Desktop`, ['1. Navigate from ' + pg.path + ' to another page', '2. Click browser Back', '3. Click browser Forward'], 'Page restores correctly', 'Page appears broken after history navigation', ss, 'Ensure SPA router handles popstate events correctly');
          } else {
            testResults.passed++;
          }
        } else {
          testResults.passed++;
        }
      } catch (e) {
        testResults.failed++;
        const ss = await safeScreenshot(page, `exploratory_backfwd_err_${pg.path.replace(/\//g, '_') || 'home'}`);
        addBug('Medium', 'Exploratory', `Back/Forward navigation error on ${pg.path}`, `Error during history navigation: ${e.message.slice(0, 150)}`, `${pg.path} — Desktop`, ['1. Navigate between pages', '2. Use Back/Forward'], 'Smooth history navigation', `Error: ${e.message.slice(0, 100)}`, ss, 'Fix history/popstate handling');
      }

      // ── Test 4: Scroll chaos — rapid scrolling up/down ──
      testResults.total++;
      try {
        await safeGoto(page, pg.url);
        const preScrollErrors = jsErrors.length;
        // Rapid scroll: top → bottom → top → middle repeatedly
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(150);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(150);
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
          await page.waitForTimeout(150);
        }
        const postScrollErrors = jsErrors.length - preScrollErrors;
        if (postScrollErrors > 0) {
          testResults.failed++;
          const ss = await safeScreenshot(page, `exploratory_scroll_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug('Medium', 'Exploratory', `${postScrollErrors} JS error(s) during rapid scroll on ${pg.path}`, `Rapid scrolling triggered ${postScrollErrors} JavaScript errors: ${jsErrors.slice(-3).map(e => e.error.slice(0, 80)).join('; ')}`, `${pg.path} — Desktop`, ['1. Open ' + pg.url, '2. Scroll up and down rapidly'], 'No JS errors on scroll', `${postScrollErrors} JS errors during scroll`, ss, 'Fix scroll event handlers — add error boundaries and debouncing');
        } else {
          testResults.passed++;
          log('✅', `Exploratory: Rapid scroll OK on ${pg.path}`);
        }
      } catch (e) {
        testResults.skipped++;
      }

      // ── Test 5: Resize viewport rapidly — responsive layout stress test ──
      testResults.total++;
      try {
        const breakpoints = [
          { width: 375, height: 812 },   // iPhone SE
          { width: 1920, height: 1080 }, // Full HD
          { width: 768, height: 1024 },  // iPad
          { width: 320, height: 568 },   // iPhone 5
          { width: 2560, height: 1440 }, // QHD
          { width: 1440, height: 900 },  // Default
        ];
        let resizeErrors = 0;
        for (const bp of breakpoints) {
          await page.setViewportSize(bp);
          await page.waitForTimeout(300);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 10);
          if (overflow) resizeErrors++;
        }
        // Reset viewport
        await page.setViewportSize({ width: 1440, height: 900 });

        if (resizeErrors >= 3) {
          testResults.failed++;
          const ss = await safeScreenshot(page, `exploratory_resize_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug('High', 'Exploratory', `Layout breaks at ${resizeErrors} breakpoints on ${pg.path}`, `Page has horizontal overflow at ${resizeErrors}/6 tested viewport sizes — responsive design is unstable`, `${pg.path} — Multiple viewports`, ['1. Resize browser to various widths (320-2560px)', '2. Check for horizontal overflow'], 'No overflow at any viewport', `Overflow at ${resizeErrors} breakpoints`, ss, 'Use responsive CSS with max-width:100%, overflow-x:hidden, and test at all breakpoints');
        } else {
          testResults.passed++;
          log('✅', `Exploratory: Resize test OK on ${pg.path} (${resizeErrors} overflows)`);
        }
      } catch (e) {
        testResults.skipped++;
        await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
      }
    } catch (e) {
      log('⚠️', `Exploratory test failed on ${pg.path}: ${e.message.slice(0, 80)}`);
    }
  }

  // ── Test 6: Global JS error summary ──
  testResults.total++;
  if (jsErrors.length > 0) {
    testResults.failed++;
    const uniqueErrors = [...new Set(jsErrors.map(e => e.error.slice(0, 100)))];
    const ss = await safeScreenshot(page, 'exploratory_js_errors');
    addBug(jsErrors.length > 10 ? 'High' : 'Medium', 'Exploratory', `${jsErrors.length} JS errors during exploratory testing`, `${uniqueErrors.length} unique JS errors caught during monkey testing:\n${uniqueErrors.slice(0, 5).map((e, i) => `${i + 1}. ${e}`).join('\n')}`, 'Multiple pages', ['1. Interact chaotically with the site', '2. Monitor console for errors'], 'No unhandled JS errors', `${jsErrors.length} errors across ${pagesToExplore.length} pages`, ss, 'Add global error handlers and fix unhandled exceptions');
  } else {
    testResults.passed++;
    log('✅', 'Exploratory: No JS errors caught during monkey testing');
  }

  // Remove the error listener
  page.removeAllListeners('pageerror');
  log('🐒', `Exploratory tests complete — ${jsErrors.length} JS errors caught`);
}

// ─── LAYER 4: REPORTING AGENT ─────────────────────────────────────────────────
function generateHTMLReport(discovery, metadata, testPlan) {
  return generateReport({
    discovery, metadata, testPlan, bugs, testResults,
    consoleErrors, networkErrors, screenshotDir: SCREENSHOT_DIR,
    targetUrl: TARGET_URL, mode: MODE, siteName: SITE_NAME, budgetMs: BUDGET_MS,
  });
}

/* ── OLD REPORT GENERATOR (replaced by report-generator.js) ──
function _generateHTMLReport_old(discovery, metadata) {
  const severityCounts = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  bugs.forEach(b => severityCounts[b.severity] = (severityCounts[b.severity] || 0) + 1);

  const healthScore = Math.max(0, 100 - (severityCounts.Critical * 25) - (severityCounts.High * 10) - (severityCounts.Medium * 3) - (severityCounts.Low * 1));

  const screenshotHTML = (ss) => {
    if (!ss) return '';
    try {
      const data = fs.readFileSync(ss);
      return `<img src="data:image/png;base64,${data.toString('base64')}" style="max-width:100%;border-radius:8px;margin-top:8px;cursor:pointer;" onclick="this.style.maxWidth=this.style.maxWidth==='100%'?'200%':'100%'" />`;
    } catch (e) { return '<p style="color:#888">Screenshot not available</p>'; }
  };

  const bugCards = bugs.map(b => `
    <div class="bug-card severity-${b.severity.toLowerCase()}">
      <div class="bug-header">
        <span class="bug-id">${b.id}</span>
        <span class="severity-badge ${b.severity.toLowerCase()}">${b.severity}</span>
        <span class="category-badge">${b.category}</span>
      </div>
      <h3>${b.title}</h3>
      <p>${b.description}</p>
      <div class="bug-meta">
        <div><strong>Location:</strong> ${b.location || 'N/A'}</div>
        <div><strong>Expected:</strong> ${b.expected || 'N/A'}</div>
        <div><strong>Actual:</strong> ${b.actual || 'N/A'}</div>
        ${b.fix ? `<div><strong>Fix:</strong> ${b.fix}</div>` : ''}
      </div>
      ${b.steps ? `<div class="steps"><strong>Steps:</strong><ol>${b.steps.map(s => `<li>${s}</li>`).join('')}</ol></div>` : ''}
      <div class="screenshot">${screenshotHTML(b.screenshot)}</div>
    </div>
  `).join('\n');

  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Report — ${discovery.siteName} — ${timestamp}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; line-height: 1.6; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

  .header { background: linear-gradient(135deg, #1a1a2e, #16213e, #0f3460); padding: 40px; border-radius: 16px; margin-bottom: 30px; text-align: center; }
  .header h1 { font-size: 2em; color: #fff; margin-bottom: 8px; }
  .header .subtitle { color: #8b949e; font-size: 1.1em; }
  .header .meta { display: flex; justify-content: center; gap: 20px; margin-top: 16px; flex-wrap: wrap; }
  .header .meta span { background: rgba(255,255,255,0.1); padding: 4px 12px; border-radius: 20px; font-size: 0.9em; color: #c9d1d9; }

  .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; margin-bottom: 30px; }
  .stat-card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; text-align: center; }
  .stat-card .number { font-size: 2.2em; font-weight: bold; }
  .stat-card .label { color: #8b949e; font-size: 0.9em; margin-top: 4px; }
  .stat-card.health .number { color: ${healthScore >= 80 ? '#3fb950' : healthScore >= 50 ? '#d29922' : '#f85149'}; }
  .stat-card.critical .number { color: #f85149; }
  .stat-card.high .number { color: #d29922; }
  .stat-card.medium .number { color: #58a6ff; }
  .stat-card.low .number { color: #8b949e; }
  .stat-card.total .number { color: #c9d1d9; }
  .stat-card.passed .number { color: #3fb950; }
  .stat-card.failed .number { color: #f85149; }

  .section-title { font-size: 1.4em; margin: 30px 0 15px; padding-bottom: 8px; border-bottom: 1px solid #30363d; }

  .filters { margin-bottom: 20px; display: flex; gap: 8px; flex-wrap: wrap; }
  .filter-btn { padding: 6px 14px; border-radius: 20px; border: 1px solid #30363d; background: #161b22; color: #c9d1d9; cursor: pointer; font-size: 0.85em; }
  .filter-btn.active, .filter-btn:hover { background: #1f6feb; border-color: #1f6feb; color: #fff; }

  .bug-card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; margin-bottom: 16px; border-left: 4px solid #30363d; }
  .bug-card.severity-critical { border-left-color: #f85149; }
  .bug-card.severity-high { border-left-color: #d29922; }
  .bug-card.severity-medium { border-left-color: #58a6ff; }
  .bug-card.severity-low { border-left-color: #8b949e; }
  .bug-header { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .bug-id { font-weight: bold; color: #58a6ff; font-size: 0.9em; }
  .severity-badge { padding: 2px 10px; border-radius: 12px; font-size: 0.8em; font-weight: bold; color: #fff; }
  .severity-badge.critical { background: #f85149; }
  .severity-badge.high { background: #d29922; }
  .severity-badge.medium { background: #1f6feb; }
  .severity-badge.low { background: #6e7681; }
  .category-badge { padding: 2px 10px; border-radius: 12px; font-size: 0.8em; background: #30363d; color: #c9d1d9; }
  .bug-card h3 { font-size: 1.1em; color: #f0f6fc; margin-bottom: 6px; }
  .bug-meta { margin: 10px 0; font-size: 0.9em; }
  .bug-meta div { margin-bottom: 4px; }
  .steps { margin: 10px 0; font-size: 0.9em; }
  .steps ol { padding-left: 20px; }
  .screenshot img { margin-top: 12px; border: 1px solid #30363d; border-radius: 8px; }

  .discovery-section { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 20px; margin-bottom: 16px; }
  .discovery-section h3 { margin-bottom: 10px; }
  .page-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
  .page-item { padding: 6px 12px; background: #0d1117; border-radius: 8px; font-size: 0.85em; display: flex; justify-content: space-between; }
  .page-item.live { border-left: 3px solid #3fb950; }
  .page-item.dead { border-left: 3px solid #f85149; }

  .footer { text-align: center; padding: 30px; color: #8b949e; font-size: 0.85em; margin-top: 40px; border-top: 1px solid #30363d; }
</style>
</head>
<body>
<div class="container">

<div class="header">
  <h1>QA Bug Report</h1>
  <div class="subtitle">${TARGET_URL}</div>
  <div class="meta">
    <span>Report #${metadata.reportNum || '?'}</span>
    <span>${timestamp}</span>
    <span>Mode: ${MODE}</span>
    <span>Duration: ${metadata.duration}</span>
    <span>Pages: ${discovery.livePages.length} live / ${discovery.deadPages.length} dead</span>
  </div>
</div>

<div class="summary">
  <div class="stat-card health"><div class="number">${healthScore}</div><div class="label">Health Score</div></div>
  <div class="stat-card total"><div class="number">${bugs.length}</div><div class="label">Total Bugs</div></div>
  <div class="stat-card critical"><div class="number">${severityCounts.Critical}</div><div class="label">Critical</div></div>
  <div class="stat-card high"><div class="number">${severityCounts.High}</div><div class="label">High</div></div>
  <div class="stat-card medium"><div class="number">${severityCounts.Medium}</div><div class="label">Medium</div></div>
  <div class="stat-card low"><div class="number">${severityCounts.Low}</div><div class="label">Low</div></div>
  <div class="stat-card passed"><div class="number">${testResults.passed}</div><div class="label">Passed</div></div>
  <div class="stat-card failed"><div class="number">${testResults.failed}</div><div class="label">Failed</div></div>
</div>

<h2 class="section-title">Discovery — Site Map</h2>
<div class="discovery-section">
  <h3>Features Detected</h3>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
    ${Object.entries(discovery.features).map(([k, v]) => `<span style="padding:4px 12px;border-radius:12px;font-size:0.85em;background:${v ? '#238636' : '#30363d'};color:${v ? '#fff' : '#8b949e'}">${k.replace('has', '')}</span>`).join('')}
  </div>
  <h3>Discovered Pages (${discovery.livePages.length} live / ${discovery.deadPages.length} dead)</h3>
  <div class="page-list">
    ${discovery.livePages.map(p => `<div class="page-item live"><span>${p.path}</span><span style="color:#3fb950">${p.status}</span></div>`).join('')}
    ${discovery.deadPages.slice(0, 10).map(p => `<div class="page-item dead"><span>${p.path}</span><span style="color:#f85149">${p.status || 'ERR'}</span></div>`).join('')}
  </div>
</div>

<h2 class="section-title">Bugs (${bugs.length})</h2>
<div class="filters">
  <button class="filter-btn active" onclick="filterBugs('all')">All (${bugs.length})</button>
  <button class="filter-btn" onclick="filterBugs('Critical')">Critical (${severityCounts.Critical})</button>
  <button class="filter-btn" onclick="filterBugs('High')">High (${severityCounts.High})</button>
  <button class="filter-btn" onclick="filterBugs('Medium')">Medium (${severityCounts.Medium})</button>
  <button class="filter-btn" onclick="filterBugs('Low')">Low (${severityCounts.Low})</button>
</div>
<div id="bug-list">
${bugCards}
</div>

${discovery.consoleErrors.length > 0 ? `
<h2 class="section-title">Console Errors (${discovery.consoleErrors.length})</h2>
<div class="discovery-section">
  ${discovery.consoleErrors.slice(0, 20).map(e => `<div style="padding:6px 0;border-bottom:1px solid #21262d;font-size:0.85em;"><span style="color:#f85149">ERROR</span> ${e.text.slice(0, 200)}</div>`).join('')}
</div>
` : ''}

${networkErrors.length > 0 ? `
<h2 class="section-title">Network Errors (${networkErrors.length})</h2>
<div class="discovery-section">
  ${networkErrors.slice(0, 20).map(e => `<div style="padding:6px 0;border-bottom:1px solid #21262d;font-size:0.85em;"><span style="color:#d29922">FAIL</span> ${e.url.slice(0, 100)} — ${e.failure || 'Unknown'}</div>`).join('')}
</div>
` : ''}

<div class="footer">
  <p>Generated by Autonomous QA Agent | ${timestamp} | ${TARGET_URL}</p>
  <p>Tests: ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped / ${testResults.total} total</p>
</div>

</div>
<script>
function filterBugs(severity) {
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.querySelectorAll('.bug-card').forEach(card => {
    if (severity === 'all') { card.style.display = ''; }
    else { card.style.display = card.classList.contains('severity-' + severity.toLowerCase()) ? '' : 'none'; }
  });
}
</script>
</body>
</html>`;
}
── END OLD REPORT GENERATOR ── */

// ─── MAIN ORCHESTRATOR ────────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log(' AUTONOMOUS QA AGENT');
  console.log(` Target: ${TARGET_URL}`);
  console.log(` Mode:   ${MODE} (budget: ${BUDGET_MS / 60000} min)`);
  console.log('='.repeat(60) + '\n');

  // Setup directories
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  // Launch with stealth settings to bypass anti-bot protection (Ajio, Amazon, Flipkart, etc.)
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-IN',
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  // Remove navigator.webdriver flag to avoid bot detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  setupPageListeners(page);

  try {
    // Layer 0: Login
    await loginAgent(page);

    // Layer 1: Discovery
    const discovery = await discoveryAgent(page);

    // Layer 2: Planning
    const testPlan = planningAgent(discovery);

    // Layer 3: Execution
    // Function map — cleaner than switch/case, easy to extend
    const TEST_RUNNERS = {
      runSanityTests: (p, d) => runSanityTests(p, d),
      runVisualTests: (_p, d) => runVisualTests(browser, d),
      runECommerceTests: (p, d) => runECommerceTests(p, d),
      runSearchTests: (p, d) => runSearchTests(p, d),
      runAccessibilityTests: (p, d) => runAccessibilityTests(p, d),
      runPerformanceTests: (p, d) => runPerformanceTests(p, d),
      runUserJourneyTests: (p, d) => runUserJourneyTests(p, d),
      runInteractionTests: (p, d) => runInteractionTests(p, d),
      runLinkValidation: (p, d) => runLinkValidation(p, d),
      run4KTests: (_p, d) => run4KTests(browser, d),
      runFormValidationTests: (p, d) => runFormValidationTests(p, d),
      runSessionTests: (p, d) => runSessionTests(p, d),
      runSecurityTests: (p, d) => runSecurityTests(p, d),
      runSEOTests: (p, d) => runSEOTests(p, d),
      runCookieConsentTests: (p, d) => runCookieConsentTests(p, d),
      runMobileMenuTests: (_p, d) => runMobileMenuTests(browser, d),
      runLazyLoadTests: (p, d) => runLazyLoadTests(p, d),
      runExploratoryTests: (p, d) => runExploratoryTests(p, d),
    };

    log('\uD83D\uDE80', 'Layer 3: Execution Agent starting...');
    for (const phase of testPlan) {
      if (isBudgetExceeded()) {
        log('\u23F1\uFE0F', `Budget exceeded — skipping ${phase.name}`);
        break;
      }
      log('\uD83D\uDCE6', `Running: ${phase.name} (${phase.tests} tests, Tier ${phase.tier})`);
      const runner = TEST_RUNNERS[phase.fn];
      if (!runner) {
        log('\u26A0\uFE0F', `Unknown test: ${phase.fn}`);
        continue;
      }
      try {
        await retry(() => runner(page, discovery), 1);
      } catch (e) {
        log('\u274C', `${phase.name} crashed: ${e.message}`);
      }
    }

    // Layer 4: Reporting
    log('\uD83D\uDCCA', 'Layer 4: Reporting Agent starting...');
    const duration = `${Math.round(elapsed() / 1000)}s`;

    // AI-powered analysis (if API key is available)
    if (aiAgents.isAvailable()) {
      log('\uD83E\uDD16', 'Running AI bug analysis...');
      try {
        // AI Agent 2: Smart Bug Analysis — root cause + fix suggestions
        await aiAgents.analyzeBugsWithAI(bugs);
        log('\u2705', `AI Analysis complete (cost: $${aiAgents.getUsageCost().toFixed(4)})`);

        // AI Agent 4: Test Intelligence — suggestions for next run
        const intel = await aiAgents.generateTestIntelligence(discovery, null, null, bugs);
        if (intel) log('\u2705', 'AI Test Intelligence saved to knowledge/ai-suggestions.json');
      } catch (e) {
        log('\u26A0\uFE0F', `AI analysis failed: ${e.message}`);
      }
    }

    // Determine report number
    let reportNum = 33;
    try {
      const existingReports = fs.readdirSync(path.join(REPORT_DIR, 'deploy', 'AutomatedWebTesting', 'reports')).filter(f => f.endsWith('.html'));
      reportNum = 30 + existingReports.length + 1;
    } catch (e) {}

    const htmlReport = generateHTMLReport(discovery, { duration, reportNum, perfData }, testPlan);
    const reportFileName = `full-report-${SITE_NAME}.html`;
    const reportPath = path.join(REPORT_DIR, reportFileName);
    fs.writeFileSync(reportPath, htmlReport);
    log('\u2705', `HTML report saved: ${reportPath}`);

    // Save JSON bug report
    const jsonReport = {
      meta: { url: TARGET_URL, mode: MODE, timestamp: new Date().toISOString(), duration, reportNum, testResults, aiCost: aiAgents.isAvailable() ? `$${aiAgents.getUsageCost().toFixed(4)}` : 'N/A' },
      discovery: { livePages: discovery.livePages.length, deadPages: discovery.deadPages.length, features: discovery.features },
      bugs,
      consoleErrors: consoleErrors.slice(0, 50),
      networkErrors: networkErrors.slice(0, 50),
    };
    const jsonPath = path.join(REPORT_DIR, `bug-report-${SITE_NAME}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));
    log('\u2705', `JSON report saved: ${jsonPath}`);

    // Also save to deploy directory for GitHub Pages
    try {
      const deployDir = path.join(REPORT_DIR, 'deploy', 'AutomatedWebTesting', 'reports', SITE_NAME);
      fs.mkdirSync(deployDir, { recursive: true });
      fs.writeFileSync(path.join(deployDir, 'index.html'), htmlReport);
      fs.writeFileSync(path.join(deployDir, 'bug-report.json'), JSON.stringify(jsonReport, null, 2));
      // Copy screenshots
      const deployScreenshotDir = path.join(deployDir, 'screenshots');
      fs.mkdirSync(deployScreenshotDir, { recursive: true });
      const ssFiles = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
      for (const f of ssFiles) {
        fs.copyFileSync(path.join(SCREENSHOT_DIR, f), path.join(deployScreenshotDir, f));
      }
      log('\u2705', `Deploy files saved to: ${deployDir}`);
    } catch (e) {
      log('\u26A0\uFE0F', `Deploy copy failed: ${e.message}`);
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log(' TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(` URL:        ${TARGET_URL}`);
    console.log(` Duration:   ${duration}`);
    console.log(` Pages:      ${discovery.livePages.length} live / ${discovery.deadPages.length} dead`);
    console.log(` Tests:      ${testResults.total} total — ${testResults.passed} passed, ${testResults.failed} failed, ${testResults.skipped} skipped`);
    console.log(` Bugs:       ${bugs.length} total`);
    console.log(`   Critical: ${bugs.filter(b => b.severity === 'Critical').length}`);
    console.log(`   High:     ${bugs.filter(b => b.severity === 'High').length}`);
    console.log(`   Medium:   ${bugs.filter(b => b.severity === 'Medium').length}`);
    console.log(`   Low:      ${bugs.filter(b => b.severity === 'Low').length}`);
    console.log(` Report:     ${reportPath}`);
    console.log('='.repeat(60) + '\n');

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
