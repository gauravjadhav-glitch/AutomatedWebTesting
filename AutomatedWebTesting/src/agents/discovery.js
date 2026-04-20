'use strict';

const { log, safeGoto } = require('../utils');
const SELECTORS = require('../config/selectors');
const { CRAWL_LIMITS } = require('../config');

/**
 * Layer 1: Smart Discovery Agent
 * Crawls the target site, detects platform, discovers pages, features, and search terms.
 *
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {object} config - { targetUrl, siteName, mode, crawlLimit }
 * @param {object} ctx   - RunContext with consoleErrors, networkErrors, isBudgetExceeded()
 * @returns {object} discovery report
 */
async function discoveryAgent(page, config, ctx) {
  log(ctx, '🔍', 'Layer 1: Smart Discovery Agent starting...');
  const discovery = {
    baseUrl: config.targetUrl,
    siteName: config.siteName,
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

  const crawlLimit = config.crawlLimit || CRAWL_LIMITS[config.mode] || 30;
  const visited = new Set();
  const toVisit = [];
  const hostname = new URL(config.targetUrl).hostname;

  // Phase 1: Load homepage and detect platform
  log(ctx, '🌐', 'Phase 1: Analyzing homepage & detecting platform...');
  await safeGoto(page, config.targetUrl);
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
  log(ctx, '🏢', `Platform detected: ${discovery.platform}`);

  // Phase 2: Collect all links from homepage
  log(ctx, '🔗', 'Phase 2: Crawling site links from homepage...');
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
  log(ctx, '🔗', `Found ${homepageLinks.length} links on homepage`);

  // Phase 3: Try sitemap.xml
  try {
    const sitemapResp = await page.goto(`${config.targetUrl}/sitemap.xml`, { waitUntil: 'domcontentloaded', timeout: 10000 });
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
      log(ctx, '✅', `Sitemap: found ${sitemapUrls.length} URLs`);
    }
  } catch {}

  // Phase 4: Crawl discovered URLs
  log(ctx, '🔍', `Phase 4: Crawling ${Math.min(toVisit.length, crawlLimit)} pages...`);
  for (const pagePath of toVisit) {
    if (visited.size >= crawlLimit || ctx.isBudgetExceeded()) break;
    const normalizedPath = pagePath.split('?')[0].split('#')[0];
    if (visited.has(normalizedPath)) continue;
    visited.add(normalizedPath);

    const url = normalizedPath.startsWith('http') ? normalizedPath : `${config.targetUrl}${normalizedPath}`;
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

      log(ctx, status >= 200 && status < 400 && !isSoft404 ? '✅' : '❌', `[${status}] ${normalizedPath} — ${title || '(no title)'}`);
    } catch (e) {
      discovery.pages.push({ path: normalizedPath, url, status: 0, error: e.message });
      discovery.deadPages.push({ path: normalizedPath, url, status: 0, error: e.message });
    }
  }

  // Phase 5: Detect features
  log(ctx, '🧠', 'Phase 5: Detecting site features...');
  await safeGoto(page, config.targetUrl);
  await page.waitForTimeout(2000);

  discovery.features.hasSearch = !!(await page.$(SELECTORS.searchInput + ', ' + SELECTORS.searchTrigger).catch(() => null));
  discovery.features.hasCart = !!(await page.$(SELECTORS.cart).catch(() => null));
  discovery.features.hasLogin = !!(await page.$(SELECTORS.login).catch(() => null));
  discovery.features.hasWishlist = !!(await page.$(SELECTORS.wishlist).catch(() => null));
  discovery.features.hasNav = !!(await page.$(SELECTORS.nav).catch(() => null));
  discovery.features.hasFooter = !!(await page.$(SELECTORS.footer).catch(() => null));
  discovery.features.hasForms = !!(await page.$('form, [class*="form"]').catch(() => null));

  const productPages = discovery.livePages.filter(p =>
    /product|shop|store|catalog|collection|categor|search|browse|buy|deal|offer|sale/i.test(p.path + ' ' + p.title)
  );
  if (productPages.length === 0) {
    const homeProducts = await page.$$(SELECTORS.productCard).catch(() => []);
    discovery.features.hasProducts = homeProducts.length > 0;
  } else {
    discovery.features.hasProducts = true;
  }

  // Phase 6: Collect nav/footer/product links
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

  // Phase 7: Extract search terms
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
  log(ctx, '🔍', `Search terms extracted: ${discovery.searchTerms.slice(0, 5).join(', ')}`);

  // Collect forms
  const formEls = await page.$$('form').catch(() => []);
  for (const form of formEls.slice(0, 10)) {
    const action = await form.getAttribute('action').catch(() => '');
    const inputs = await form.$$('input, textarea, select').catch(() => []);
    discovery.forms.push({ action, fieldCount: inputs.length, page: '/' });
  }

  discovery.consoleErrors = ctx.consoleErrors.slice();
  discovery.networkErrors = ctx.networkErrors.slice();

  log(ctx, '📊', `Discovery complete: ${discovery.livePages.length} live / ${discovery.deadPages.length} dead / Platform: ${discovery.platform} / Features: ${Object.entries(discovery.features).filter(([,v]) => v).map(([k]) => k).join(', ')}`);
  return discovery;
}

module.exports = discoveryAgent;
