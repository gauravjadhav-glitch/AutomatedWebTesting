/**
 * 4K UHD Testing Module — Strict Detection (No False Positives)
 *
 * Consolidated from 5 separate 4K test files into one module.
 * Uses strict detection patterns validated against lamartina.fynd.io:
 *  - Parent-child overlap exclusion
 *  - SVG/data: URI exclusion for broken images
 *  - Scroll trigger for lazy loading
 *  - Site-wide nav deduplication
 *  - Min size thresholds (200px blurry, 25px tiny, 100px broken)
 *
 * Usage (from run-test.js):
 *   const fourK = require('./tests/4k-tests');
 *   await fourK.run4KTests(browser, siteUrl, label, bugs, pageData, screenshots);
 */

const fs = require('fs');
const path = require('path');

const VP_4K = { width: 3840, height: 2160 };

const PAGES = [
  { path: '/', name: 'Homepage' },
  { path: '/products', name: 'Products' },
  { path: '/collections', name: 'Collections' },
  { path: '/categories', name: 'Categories' },
  { path: '/cart', name: 'Cart' },
  { path: '/auth/login', name: 'Login' },
  { path: '/contact-us', name: 'Contact Us' },
];

const SS_DIR = path.join(__dirname, '..', 'reports', 'screenshots');

function ssName(slug, suffix) {
  return `4k_${slug}_${suffix}.png`;
}

/**
 * Load a page at 4K with lazy-loading trigger
 */
async function loadPage4K(context, siteUrl, pagePath) {
  const page = await context.newPage();
  try {
    await page.goto(siteUrl + pagePath, { waitUntil: 'networkidle', timeout: 40000 });
  } catch {
    try { await page.goto(siteUrl + pagePath, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {}
  }
  await page.waitForTimeout(3000);
  // Scroll down and back up to trigger lazy loading
  await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.scrollTo(0, 0); });
  await page.waitForTimeout(1500);
  return page;
}

/**
 * Run all 4K-specific tests on a site.
 *
 * @param {import('playwright').Browser} browser
 * @param {string} siteUrl - Base URL (e.g. "https://lamartina.fynd.io")
 * @param {string} label - Site label ("site1" or "site2")
 * @param {Array} bugs - Bugs array to push into
 * @param {Object} pageData - Page data object
 * @param {Object} screenshots - Screenshots object (base64)
 */
async function run4KTests(browser, siteUrl, label, bugs, pageData, screenshots) {
  const hostname = (() => { try { return new URL(siteUrl).hostname; } catch { return siteUrl; } })();

  fs.mkdirSync(SS_DIR, { recursive: true });

  const context = await browser.newContext({ viewport: VP_4K, deviceScaleFactor: 1 });
  const fourKBugs = [];
  let bugIndex = bugs.length + 1;

  function addBug(b) {
    const bug = {
      id: bugIndex++,
      severity: b.severity,
      category: b.category,
      title: b.title,
      description: b.description,
      site: hostname,
      fix: b.fix,
      testType: '4K UHD',
      location: b.location,
      steps: b.steps,
      expected: b.expected,
      actual: b.actual,
      screenshot: b.screenshot || null,
    };
    fourKBugs.push(bug);
    bugs.push(bug);
  }

  console.log(`\n  ── 4K UHD Tests (3840×2160) — ${hostname} ──`);

  // ========== PER-PAGE CHECKS ==========
  for (const pg of PAGES) {
    const slug = pg.path === '/' ? 'home' : pg.path.replace(/\//g, '_').slice(1);
    let page;
    try {
      page = await loadPage4K(context, siteUrl, pg.path);
    } catch {
      console.log(`    [SKIP] Could not load ${pg.path} at 4K`);
      continue;
    }

    try {
      await page.screenshot({ path: path.join(SS_DIR, ssName(slug, 'full')), fullPage: true });
      await page.screenshot({ path: path.join(SS_DIR, ssName(slug, 'vp')), fullPage: false });
      screenshots[`${label}_4k_${slug}`] = (await page.screenshot()).toString('base64');
    } catch {}

    // 1. HORIZONTAL SCROLL (strict — only if > 10px overflow)
    try {
      const hScroll = await page.evaluate(() => {
        const sw = document.documentElement.scrollWidth;
        const vw = window.innerWidth;
        return { sw, vw, overflow: sw > vw + 10 };
      });
      if (hScroll.overflow) {
        addBug({ title: `Horizontal Scroll — ${pg.path} on 4K`, severity: 'Critical', category: 'Layout',
          location: `${pg.path} on 4K (3840x2160)`,
          description: `Horizontal scroll at 4K — scrollWidth (${hScroll.sw}px) exceeds viewport (${hScroll.vw}px) by ${hScroll.sw - hScroll.vw}px.`,
          steps: `1. Open ${siteUrl}${pg.path} on 4K (3840x2160)\n2. Horizontal scrollbar is visible`,
          expected: 'No horizontal scroll at 4K', actual: `scrollWidth=${hScroll.sw}px > viewport=${hScroll.vw}px`,
          fix: 'Fix the overflowing element. Use overflow-x: hidden or fix width.', screenshot: ssName(slug, 'vp') });
      }
    } catch {}

    // 2. NAV WIDTH (strict — only report once on homepage)
    if (pg.path === '/') {
      try {
        const nav = await page.evaluate(() => {
          const el = document.querySelector('nav');
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100) };
        });
        if (nav && nav.pct < 50) {
          addBug({ title: `Nav Bar Covers Only ${nav.pct}% of Viewport (Site-Wide)`, severity: 'High', category: 'UI Alignment',
            location: `All pages on 4K (3840x2160)`,
            description: `Navigation bar only covers ${nav.pct}% (${nav.width}px) of the 4K viewport on all pages.`,
            steps: `1. Open any page on ${siteUrl} at 4K\n2. Nav bar occupies only left ${nav.pct}% of screen`,
            expected: 'Navigation should span 100% of viewport', actual: `Nav is ${nav.width}px (${nav.pct}% of 3840px)`,
            fix: 'Set nav width: 100% and remove max-width constraints.', screenshot: ssName(slug, 'vp') });
        }
      } catch {}
    }

    // 3. BLURRY IMAGES (strict — visible, large, upscaled > 2x, deduplicated)
    try {
      const blurry = await page.evaluate(() => {
        const results = []; const seen = new Set();
        document.querySelectorAll('img').forEach(img => {
          const rect = img.getBoundingClientRect();
          if (rect.width > 200 && rect.height > 100 && img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5 && img.complete && !img.src.startsWith('data:') && rect.top < 10000) {
            const key = `${img.naturalWidth}x${Math.round(rect.width)}`;
            const alt = (img.alt || img.src.split('/').pop()).slice(0, 50);
            if (!seen.has(alt)) { seen.add(alt); results.push({ alt, rendered: Math.round(rect.width), natural: img.naturalWidth, ratio: (rect.width / img.naturalWidth).toFixed(1) }); }
          }
        });
        return results;
      });
      if (blurry.length > 0) {
        const list = blurry.slice(0, 6).map((img, i) => `${i+1}. "${img.alt}" — source: ${img.natural}px, displayed: ${img.rendered}px (${img.ratio}x upscale)`).join('\n');
        addBug({ title: `${blurry.length} Blurry Image(s) — ${pg.path} on 4K`, severity: 'High', category: 'Image Quality',
          location: `${pg.path} on 4K (3840x2160)`,
          description: `${blurry.length} image(s) are visibly blurry — source too small for 4K.\n\nBlurry images:\n${list}`,
          steps: `1. Open ${siteUrl}${pg.path} on 4K\n2. Images appear pixelated\nBlurry images:\n${list}`,
          expected: 'Source image should be >= rendered size', actual: `${blurry.length} images upscaled ${blurry[0].ratio}x`,
          fix: 'Serve higher-res images via srcset/CDN params.', screenshot: ssName(slug, 'full') });
      }
    } catch {}

    // 4. TINY / UNTAPPABLE ELEMENTS (strict — visible, text-bearing, < 25px, no nested)
    try {
      const tinyEls = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('a, button').forEach(el => {
          const rect = el.getBoundingClientRect();
          const text = el.textContent.trim();
          if (rect.width > 5 && rect.height > 5 && rect.height < 25 && text.length > 1 && text.length < 50 && rect.top > 0 && rect.top < 5000 && el.offsetParent !== null) {
            const parent = el.parentElement?.closest('a, button');
            if (parent) return;
            results.push({ text: text.slice(0, 35), w: Math.round(rect.width), h: Math.round(rect.height), tag: el.tagName.toLowerCase() });
          }
        });
        return results.slice(0, 8);
      });
      if (tinyEls.length >= 2) {
        const list = tinyEls.map((el, i) => `${i+1}. <${el.tag}>"${el.text}" — only ${el.w}x${el.h}px`).join('\n');
        addBug({ title: `${tinyEls.length} Untappable Elements — ${pg.path} on 4K`, severity: 'High', category: 'UI Alignment',
          location: `${pg.path} on 4K (3840x2160)`,
          description: `${tinyEls.length} element(s) are under 25px tall — too small at 4K.\n\nAffected:\n${list}`,
          steps: `1. Open ${siteUrl}${pg.path} on 4K\n2. Try clicking these elements\n${list}`,
          expected: 'Interactive elements should be >= 44x44px (WCAG)', actual: `${tinyEls.length} elements under 25px tall`,
          fix: 'Increase padding/font-size for links and buttons.', screenshot: ssName(slug, 'vp') });
      }
    } catch {}

    // 5. BROKEN IMAGES (strict — exclude SVG, data: URIs, small placeholders)
    try {
      const broken = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('img').forEach(img => {
          if (img.complete && img.naturalWidth === 0 && img.src && !img.src.startsWith('data:') && !img.src.includes('.svg') && img.offsetWidth > 30 && img.offsetHeight > 30) {
            results.push({ alt: (img.alt || 'no alt').slice(0, 40), src: img.src.slice(-50) });
          }
        });
        return results;
      });
      if (broken.length > 0) {
        const list = broken.slice(0, 5).map((img, i) => `${i+1}. "${img.alt}" — ...${img.src}`).join('\n');
        addBug({ title: `${broken.length} Broken Image(s) — ${pg.path}`, severity: 'Critical', category: 'Image Quality',
          location: `${pg.path} on 4K (3840x2160)`,
          description: `${broken.length} image(s) failed to load.\n\nBroken:\n${list}`,
          steps: `1. Open ${siteUrl}${pg.path}\n2. Broken image icons visible\n${list}`,
          expected: 'All images should load', actual: `${broken.length} broken images`,
          fix: 'Fix image URLs. Check for 404s in network tab.', screenshot: ssName(slug, 'vp') });
      }
    } catch {}

    // 6. FOOTER CHECK (homepage only)
    if (pg.path === '/') {
      try {
        const footer = await page.evaluate(() => {
          const el = document.querySelector('footer');
          if (!el) return null;
          const links = el.querySelectorAll('a');
          let tinyLinks = 0;
          links.forEach(a => { if (a.getBoundingClientRect().height > 0 && a.getBoundingClientRect().height < 20) tinyLinks++; });
          return { tinyLinks, totalLinks: links.length };
        });
        if (footer && footer.tinyLinks > 3) {
          addBug({ title: `${footer.tinyLinks} Footer Links Too Small at 4K`, severity: 'Medium', category: 'UI Alignment',
            location: `/ on 4K (3840x2160)`,
            description: `${footer.tinyLinks} of ${footer.totalLinks} footer links are under 20px tall.`,
            steps: `1. Open ${siteUrl}/ on 4K\n2. Scroll to footer\n3. Links are tiny`,
            expected: 'Footer links should have adequate size (min 44px)', actual: `${footer.tinyLinks}/${footer.totalLinks} footer links under 20px`,
            fix: 'Increase line-height and padding for footer links at large viewports.', screenshot: ssName('home', 'full') });
        }
      } catch {}
    }

    // 7. MISSING ALT TEXT (strict — only large visible images)
    try {
      const noAlts = await page.evaluate(() => {
        let count = 0;
        const examples = [];
        document.querySelectorAll('img').forEach(img => {
          const rect = img.getBoundingClientRect();
          if (!img.alt && rect.width > 100 && rect.height > 100 && !img.src.startsWith('data:') && img.offsetParent !== null) {
            count++;
            if (examples.length < 4) examples.push({ src: img.src.split('/').pop().slice(0, 40), w: Math.round(rect.width) });
          }
        });
        return { count, examples };
      });
      if (noAlts.count >= 3) {
        const list = noAlts.examples.map((img, i) => `${i+1}. "...${img.src}" (${img.w}px) — missing alt`).join('\n');
        addBug({ title: `${noAlts.count} Images Missing Alt Text — ${pg.path}`, severity: 'Medium', category: 'Accessibility',
          location: `${pg.path} on 4K (3840x2160)`,
          description: `${noAlts.count} large visible image(s) missing alt attributes (WCAG 1.1.1).\n\n${list}`,
          steps: `1. Open ${siteUrl}${pg.path}\n2. Inspect images\n${list}`,
          expected: 'All meaningful images should have alt text', actual: `${noAlts.count} images missing alt`,
          fix: 'Add descriptive alt text to all product/content images.', screenshot: ssName(slug, 'vp') });
      }
    } catch {}

    // 8. WHITESPACE CHECK (specific pages: cart, login, contact)
    if (['/cart', '/auth/login', '/contact-us'].includes(pg.path)) {
      try {
        const ws = await page.evaluate(() => {
          const main = document.querySelector('main, [class*="page-container"], [class*="content"]');
          if (!main) return null;
          const rect = main.getBoundingClientRect();
          return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100) };
        });
        if (ws && ws.pct < 40) {
          addBug({ title: `Excessive Whitespace (${100 - ws.pct}% unused) — ${pg.path} on 4K`, severity: 'High', category: 'UI Alignment',
            location: `${pg.path} on 4K (3840x2160)`,
            description: `Content uses only ${ws.pct}% (${ws.width}px) of the 4K viewport.`,
            steps: `1. Open ${siteUrl}${pg.path} on 4K\n2. Content confined to narrow column`,
            expected: 'Content should use 60-80%+ of viewport at 4K', actual: `Only ${ws.pct}% utilized`,
            fix: 'Increase max-width for large viewports.', screenshot: ssName(slug, 'vp') });
        }
      } catch {}
    }

    await page.close();
  }

  // ========== GLOBAL TESTS (run once on homepage) ==========
  let page;
  try {
    page = await loadPage4K(context, siteUrl, '/');
  } catch {
    await context.close();
    return fourKBugs;
  }

  // FOCUS INDICATORS
  try {
    const focus = await page.evaluate(() => {
      let noOutline = 0, total = 0;
      const examples = [];
      document.querySelectorAll('a, button, input, select, textarea').forEach(el => {
        if (el.offsetHeight > 0 && el.offsetWidth > 0) {
          total++;
          const style = getComputedStyle(el);
          if (style.outlineStyle === 'none' || style.outlineWidth === '0px') {
            noOutline++;
            if (examples.length < 4) examples.push({ tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 20) });
          }
        }
      });
      return { total, noOutline, pct: Math.round(noOutline / total * 100), examples };
    });
    if (focus.pct >= 80 && focus.total > 10) {
      const list = focus.examples.map((el, i) => `${i+1}. <${el.tag}>"${el.text}" — no focus style`).join('\n');
      addBug({ title: `No Focus Indicators — ${focus.noOutline}/${focus.total} Elements (${focus.pct}%)`, severity: 'High', category: 'Accessibility',
        location: `/ on 4K (3840x2160)`,
        description: `${focus.pct}% of focusable elements lack visible focus indicators. WCAG 2.4.7.\n\n${list}`,
        steps: `1. Open ${siteUrl}/ on 4K\n2. Press Tab\n3. No visible focus ring\n${list}`,
        expected: 'All interactive elements should show :focus-visible style', actual: `${focus.noOutline}/${focus.total} elements have no focus indicator`,
        fix: 'Add :focus-visible { outline: 2px solid currentColor; }', screenshot: ssName('home', 'vp') });
    }
  } catch {}

  // COLOR CONTRAST
  try {
    const contrast = await page.evaluate(() => {
      function lum(r, g, b) { const [rs, gs, bs] = [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }); return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs; }
      function parseC(c) { const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
      const texts = document.querySelectorAll('p, h1, h2, h3, h4, a, span, li, label');
      let low = 0, total = 0; const examples = [];
      texts.forEach(el => {
        if (el.offsetHeight > 0 && el.textContent.trim().length > 3 && el.children.length < 3) {
          const fg = parseC(getComputedStyle(el).color);
          const bg = parseC(getComputedStyle(el).backgroundColor);
          if (fg && bg && !(bg[0] === 0 && bg[1] === 0 && bg[2] === 0 && getComputedStyle(el).backgroundColor.includes('0)'))) {
            total++;
            const l1 = lum(...fg), l2 = lum(...bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            if (ratio < 4.5) { low++; if (examples.length < 4) examples.push({ text: el.textContent.trim().slice(0, 25), ratio: ratio.toFixed(2) }); }
          }
        }
      });
      return { total, low, pct: total > 0 ? Math.round(low / total * 100) : 0, examples };
    });
    if (contrast.low > 5 && contrast.pct > 30) {
      const list = contrast.examples.map((el, i) => `${i+1}. "${el.text}" — ratio: ${el.ratio}:1`).join('\n');
      addBug({ title: `Poor Color Contrast — ${contrast.low}/${contrast.total} Elements (${contrast.pct}%)`, severity: 'High', category: 'Accessibility',
        location: `/ on 4K (3840x2160)`,
        description: `${contrast.pct}% of text elements fail WCAG AA 4.5:1.\n\n${list}`,
        steps: `1. Open ${siteUrl}/ on 4K\n2. Many text elements have low contrast\n${list}`,
        expected: 'All text should meet WCAG AA 4.5:1 ratio', actual: `${contrast.low}/${contrast.total} fail`,
        fix: 'Darken text or lighten backgrounds to meet 4.5:1.', screenshot: ssName('home', 'vp') });
    }
  } catch {}

  // HEADER ICONS
  try {
    const icons = await page.evaluate(() => {
      const check = (el, name) => {
        if (!el) return { name, found: false };
        const rect = el.getBoundingClientRect();
        return { name, found: true, w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 5 && rect.height > 5 };
      };
      return {
        cart: check(document.querySelector('a[href*="cart"], [class*="cart-icon"], [class*="bag-icon"], header [class*="cart"]'), 'Cart'),
        account: check(document.querySelector('a[href*="login"], a[href*="account"], [class*="user-icon"], header [class*="account"]'), 'Account'),
        wishlist: check(document.querySelector('a[href*="wishlist"], [class*="wishlist"]'), 'Wishlist'),
        search: check(document.querySelector('input[type="search"], [class*="search"] input, [class*="search-bar"]'), 'Search')
      };
    });
    const missing = Object.values(icons).filter(i => !i.found);
    if (missing.length > 0) {
      const list = missing.map((m, i) => `${i+1}. ${m.name} — not found in header`).join('\n');
      addBug({ title: `${missing.length} Header Icon(s) Missing at 4K`, severity: 'High', category: 'Navigation',
        location: `/ on 4K (3840x2160)`,
        description: `${missing.length} essential header icon(s) not found at 4K.\n\n${list}`,
        steps: `1. Open ${siteUrl}/ on 4K\n2. Check header\n${list}`,
        expected: 'Cart, account, search icons should be visible', actual: `${missing.length} icons not found`,
        fix: 'Ensure header icons render at 4K. Check media queries.', screenshot: ssName('home', 'vp') });
    }
  } catch {}

  // PERFORMANCE
  try {
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const loadTime = nav ? Math.round(nav.loadEventEnd - nav.fetchStart) : null;
      const resources = performance.getEntriesByType('resource');
      const large = resources.filter(r => r.transferSize > 1000000).map(r => ({ name: r.name.split('/').pop().slice(0, 40), size: Math.round(r.transferSize / 1024), type: r.initiatorType }));
      const total = Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024);
      return { loadTime, large, total };
    });
    if (perf.total > 5000) {
      const list = perf.large.slice(0, 5).map((r, i) => `${i+1}. "${r.name}" (${r.type}) — ${r.size}KB`).join('\n');
      addBug({ title: `Heavy Page — ${perf.total}KB Total at 4K`, severity: 'Medium', category: 'Performance',
        location: `/ on 4K (3840x2160)`,
        description: `Page weighs ${perf.total}KB. Load time: ${perf.loadTime}ms.\n\n${list || 'No files over 1MB'}`,
        steps: `1. Open ${siteUrl}/ on 4K\n2. Total transfer: ${perf.total}KB`,
        expected: 'Page weight should be under 3MB', actual: `Total: ${perf.total}KB, Load: ${perf.loadTime}ms`,
        fix: 'Compress images (WebP/AVIF), minify CSS/JS, lazy-load offscreen content.', screenshot: ssName('home', 'vp') });
    }
  } catch {}

  await page.close();

  // ========== PDP DEEP CHECK ==========
  try {
    page = await loadPage4K(context, siteUrl, '/products');
    const pdpLink = await page.evaluate(() => { const a = document.querySelector('a[href*="/product/"]'); return a ? a.getAttribute('href') : null; });
    await page.close();

    if (pdpLink) {
      page = await loadPage4K(context, siteUrl, pdpLink);
      try {
        await page.screenshot({ path: path.join(SS_DIR, ssName('pdp', 'full')), fullPage: true });
        await page.screenshot({ path: path.join(SS_DIR, ssName('pdp', 'vp')), fullPage: false });
        screenshots[`${label}_4k_pdp`] = (await page.screenshot()).toString('base64');
      } catch {}

      const pdp = await page.evaluate(() => {
        const checks = [];
        const size = document.querySelector('[class*="size"], [class*="variant"], select[name*="size" i], [class*="option-selector"]');
        checks.push({ name: 'Size/Variant Selector', found: !!(size && size.getBoundingClientRect().width > 0), severity: 'Critical' });
        let atc = false;
        document.querySelectorAll('button, a').forEach(b => {
          const t = b.textContent.toLowerCase().trim();
          if ((t.includes('add to bag') || t.includes('add to cart') || t === 'buy now' || t === 'buy') && b.getBoundingClientRect().width > 0) atc = true;
        });
        checks.push({ name: 'Add to Cart / Buy Button', found: atc, severity: 'Critical' });
        const arrows = document.querySelectorAll('[class*="arrow"], [class*="next"], [class*="prev"], [class*="gallery"] button, [class*="carousel"] button');
        const thumbs = document.querySelectorAll('[class*="thumb"] img, [class*="gallery"] img');
        checks.push({ name: 'Image Gallery Navigation', found: arrows.length > 0 || thumbs.length > 1, severity: 'High' });
        const price = document.querySelector('[class*="price"], [class*="Price"], [class*="amount"]');
        checks.push({ name: 'Product Price Display', found: !!(price && price.getBoundingClientRect().width > 0 && price.textContent.trim().length > 0), severity: 'High' });
        const desc = document.querySelector('[class*="description"], [class*="detail"], [class*="product-info"]');
        checks.push({ name: 'Product Description', found: !!(desc && desc.textContent.trim().length > 20), severity: 'Medium' });
        return checks;
      });

      pdp.filter(c => !c.found).forEach(c => {
        addBug({ title: `PDP ${c.name} — Not Found on 4K`, severity: c.severity, category: 'UI Functionality',
          location: `${pdpLink} on 4K (3840x2160)`,
          description: `"${c.name}" is not found or not visible at 4K.${c.severity === 'Critical' ? ' This blocks the purchase flow.' : ''}`,
          steps: `1. Open ${siteUrl}${pdpLink} on 4K\n2. Look for ${c.name}\n3. Not found`,
          expected: `${c.name} should be visible and functional`, actual: `${c.name} not found at 4K`,
          fix: `Check if ${c.name} renders at 4K. Verify media queries.`, screenshot: ssName('pdp', 'vp') });
      });

      await page.close();
    }
  } catch {}

  // ========== SEARCH CHECK ==========
  try {
    page = await loadPage4K(context, siteUrl, '/');
    const searchIcon = await page.$('[class*="search"] svg, [class*="search"] button, [aria-label*="search" i]');
    if (searchIcon) {
      await searchIcon.click();
      await page.waitForTimeout(1000);
      const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], [class*="search"] input');
      if (searchInput) {
        await searchInput.fill('shirt');
        await searchInput.press('Enter');
        await page.waitForTimeout(4000);
        try {
          await page.screenshot({ path: path.join(SS_DIR, ssName('search', 'results')), fullPage: false });
          screenshots[`${label}_4k_search`] = (await page.screenshot()).toString('base64');
        } catch {}
        const results = await page.evaluate(() => {
          const items = document.querySelectorAll('[class*="product"], [class*="card"], [class*="result"]');
          return { count: items.length };
        });
        if (results.count === 0) {
          addBug({ title: `Search Returns No Results for "shirt" at 4K`, severity: 'Medium', category: 'UI Functionality',
            location: `/ on 4K (3840x2160)`,
            description: `Searching for "shirt" returns no product results.`,
            steps: `1. Open ${siteUrl}/ on 4K\n2. Click search\n3. Type "shirt" and Enter\n4. No results`,
            expected: 'Common search term should return results', actual: 'No product results displayed',
            fix: 'Debug search API/rendering at 4K.', screenshot: ssName('search', 'results') });
        }
      }
    }
    await page.close();
  } catch {}

  await context.close();

  console.log(`    Found ${fourKBugs.length} 4K-specific bugs`);
  pageData[`${label}_4k_bugs`] = fourKBugs.length;

  return fourKBugs;
}

module.exports = { run4KTests, VP_4K, PAGES };
