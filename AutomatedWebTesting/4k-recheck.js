const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://lamartina.fynd.io';
const VP = { width: 3840, height: 2160 };
const SS_DIR = path.join(__dirname, 'reports', 'screenshots');
if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const bugs = [];
let bugIndex = 1;

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addBug(b) {
  const id = `BUG-${String(bugIndex++).padStart(3, '0')}`;
  bugs.push({ id, ...b, categoryTags: b.categoryTags || [b.category] });
  const icon = b.severity === 'Critical' ? '\x1b[31m✗\x1b[0m' : b.severity === 'High' ? '\x1b[33m!\x1b[0m' : b.severity === 'Medium' ? '\x1b[36m~\x1b[0m' : '\x1b[32m○\x1b[0m';
  console.log(`  ${icon} ${id} [${b.severity}] ${b.title}`);
}

const PAGES = [
  { path: '/', name: 'Homepage' },
  { path: '/products', name: 'Products' },
  { path: '/collections', name: 'Collections' },
  { path: '/categories', name: 'Categories' },
  { path: '/cart', name: 'Cart' },
  { path: '/auth/login', name: 'Login' },
  { path: '/contact-us', name: 'Contact Us' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });

  async function loadPage(pagePath) {
    const page = await context.newPage();
    try { await page.goto(SITE + pagePath, { waitUntil: 'networkidle', timeout: 40000 }); }
    catch { try { await page.goto(SITE + pagePath, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch {} }
    await page.waitForTimeout(3000); // extra wait to let lazy images & JS settle
    // Scroll down and back up to trigger lazy loading
    await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight); });
    await page.waitForTimeout(1500);
    await page.evaluate(() => { window.scrollTo(0, 0); });
    await page.waitForTimeout(1500);
    return page;
  }

  function ss(slug, suffix) { return `4k_recheck_${slug}_${suffix}.png`; }

  console.log('\n  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║  4K RECHECK BUG REPORT — lamartina.fynd.io                  ║');
  console.log('  ║  Viewport: 3840 × 2160 — Strict Detection (No False +)      ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝\n');

  // ========== PER-PAGE CHECKS ==========
  for (const pg of PAGES) {
    console.log(`\n  ── ${pg.name} (${pg.path}) ──`);
    const page = await loadPage(pg.path);
    const slug = pg.path === '/' ? 'home' : pg.path.replace(/\//g, '_').slice(1);
    await page.screenshot({ path: path.join(SS_DIR, ss(slug, 'full')), fullPage: true });
    await page.screenshot({ path: path.join(SS_DIR, ss(slug, 'vp')), fullPage: false });

    // 1. HORIZONTAL SCROLL (strict — only if > 10px overflow)
    const hScroll = await page.evaluate(() => {
      const sw = document.documentElement.scrollWidth;
      const vw = window.innerWidth;
      return { sw, vw, overflow: sw > vw + 10 };
    });
    if (hScroll.overflow) {
      addBug({ title: `Horizontal Scroll — ${pg.path} on 4K`, severity: 'Critical', category: 'Layout', categoryTags: ['Layout', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `Horizontal scroll at 4K — scrollWidth (${hScroll.sw}px) exceeds viewport (${hScroll.vw}px) by ${hScroll.sw - hScroll.vw}px.`,
        steps: `1. Open ${SITE}${pg.path} on 4K (3840x2160)\n2. Horizontal scrollbar is visible\n3. Page extends beyond viewport`,
        expected: 'No horizontal scroll at 4K', actual: `scrollWidth=${hScroll.sw}px > viewport=${hScroll.vw}px`,
        fix: 'Find and fix the overflowing element. Use overflow-x: hidden or fix width.', screenshot: ss(slug, 'vp') });
    }

    // 2. NAV WIDTH (strict — only report once globally, not per page)
    if (pg.path === '/') {
      const nav = await page.evaluate(() => {
        const el = document.querySelector('nav');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100), cls: el.className.split(' ')[0].slice(0, 25) };
      });
      if (nav && nav.pct < 50) {
        addBug({ title: `Nav Bar Covers Only ${nav.pct}% of Viewport (Site-Wide)`, severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
          location: `All pages on 4K (3840x2160)`,
          description: `Navigation bar (nav.${nav.cls}) only covers ${nav.pct}% (${nav.width}px) of the 4K viewport (3840px) on all pages. Content is left-aligned with a massive empty gap on the right.\n\nAffected pages: /, /products, /collections, /categories, /cart, /auth/login, /contact-us`,
          steps: `1. Open any page on ${SITE} at 4K (3840x2160)\n2. Nav bar occupies only left ${nav.pct}% of screen\n3. Right ${100-nav.pct}% is completely empty`,
          expected: 'Navigation should span 100% of viewport', actual: `Nav is ${nav.width}px (${nav.pct}% of 3840px) — site-wide issue`,
          fix: 'Set nav width: 100% and remove max-width constraints.', screenshot: ss(slug, 'vp') });
      }
    }

    // 3. BLURRY IMAGES (strict — only count truly visible, large, upscaled images, deduplicate by natural size)
    const blurry = await page.evaluate(() => {
      const results = []; const seen = new Set();
      document.querySelectorAll('img').forEach(img => {
        const rect = img.getBoundingClientRect();
        // Only count visible images > 200px rendered, with real source, upscaled > 2x
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
      addBug({ title: `${blurry.length} Blurry Image(s) — ${pg.path} on 4K`, severity: 'High', category: 'Image Quality', categoryTags: ['Image Quality', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${blurry.length} image(s) are visibly blurry — source too small for 4K render size (${blurry[0].ratio}x upscale).\n\nBlurry images:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Images appear pixelated\n3. Inspect confirms natural size << rendered size\nBlurry images:\n${list}`,
        expected: 'Source image should be >= rendered size (1:1 ratio)', actual: `${blurry.length} images upscaled ${blurry[0].ratio}x`,
        fix: 'Serve higher-res images via srcset/CDN params. Min source: 900px for 4K.', screenshot: ss(slug, 'full') });
    }

    // 4. TRULY UNTAPPABLE / TINY ELEMENTS (strict — only visible, text-bearing, < 30px height, not inside larger clickable)
    const tinyEls = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('a, button').forEach(el => {
        const rect = el.getBoundingClientRect();
        const text = el.textContent.trim();
        // Only truly tiny visible elements with actual text
        if (rect.width > 5 && rect.height > 5 && rect.height < 25 && text.length > 1 && text.length < 50 && rect.top > 0 && rect.top < 5000 && el.offsetParent !== null) {
          // Skip if parent is also a clickable (avoids nested duplicates)
          const parent = el.parentElement?.closest('a, button');
          if (parent) return;
          results.push({ text: text.slice(0, 35), w: Math.round(rect.width), h: Math.round(rect.height), tag: el.tagName.toLowerCase() });
        }
      });
      return results.slice(0, 8);
    });
    if (tinyEls.length >= 2) {
      const list = tinyEls.map((el, i) => `${i+1}. <${el.tag}>"${el.text}" — only ${el.w}x${el.h}px`).join('\n');
      addBug({ title: `${tinyEls.length} Untappable Elements — ${pg.path} on 4K`, severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${tinyEls.length} element(s) are under 25px tall — too small to accurately click at 4K.\n\nAffected elements:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Try clicking these elements\nToo small:\n${list}`,
        expected: 'Interactive elements should be >= 44x44px (WCAG)', actual: `${tinyEls.length} elements under 25px tall`,
        fix: 'Increase padding/font-size for links and buttons. Min target: 44x44px.', screenshot: ss(slug, 'vp') });
    }

    // 5. BROKEN IMAGES (strict — only truly broken, exclude SVG placeholders and data: URIs)
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
      addBug({ title: `${broken.length} Broken Image(s) — ${pg.path}`, severity: 'Critical', category: 'Image Quality', categoryTags: ['Image Quality', 'Broken'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${broken.length} image(s) failed to load — showing broken placeholder.\n\nBroken:\n${list}`,
        steps: `1. Open ${SITE}${pg.path}\n2. Broken image icons visible\nBroken:\n${list}`,
        expected: 'All images should load', actual: `${broken.length} broken images`,
        fix: 'Fix image URLs. Check for 404s in network tab.', screenshot: ss(slug, 'vp') });
    }

    // 6. FOOTER CHECK
    if (pg.path === '/') {
      const footer = await page.evaluate(() => {
        const el = document.querySelector('footer');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const links = el.querySelectorAll('a');
        let tinyLinks = 0;
        links.forEach(a => { if (a.getBoundingClientRect().height > 0 && a.getBoundingClientRect().height < 20) tinyLinks++; });
        return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100), tinyLinks, totalLinks: links.length };
      });
      if (footer && footer.tinyLinks > 3) {
        addBug({ title: `${footer.tinyLinks} Footer Links Too Small at 4K`, severity: 'Medium', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
          location: `/ on 4K (3840x2160)`,
          description: `${footer.tinyLinks} of ${footer.totalLinks} footer links are under 20px tall — hard to click at 4K.`,
          steps: `1. Open ${SITE}/ on 4K\n2. Scroll to footer\n3. Links are tiny relative to viewport`,
          expected: 'Footer links should have adequate size (min 44px touch target)', actual: `${footer.tinyLinks}/${footer.totalLinks} footer links under 20px`,
          fix: 'Increase line-height and padding for footer links at large viewports.', screenshot: ss('home', 'full') });
      }
    }

    // 7. MISSING ALT TEXT (strict — only large visible images)
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
      addBug({ title: `${noAlts.count} Images Missing Alt Text — ${pg.path}`, severity: 'Medium', category: 'Accessibility', categoryTags: ['Accessibility', 'SEO'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${noAlts.count} large visible image(s) missing alt attributes (WCAG 1.1.1).\n\nExamples:\n${list}`,
        steps: `1. Open ${SITE}${pg.path}\n2. Inspect images\n3. Multiple images lack alt text\nExamples:\n${list}`,
        expected: 'All meaningful images should have alt text', actual: `${noAlts.count} images missing alt`,
        fix: 'Add descriptive alt text to all product/content images.', screenshot: ss(slug, 'vp') });
    }

    // 8. WHITESPACE CHECK (strict — only for specific pages like cart, login)
    if (['/cart', '/auth/login', '/contact-us'].includes(pg.path)) {
      const ws = await page.evaluate(() => {
        const main = document.querySelector('main, [class*="page-container"], [class*="content"]');
        if (!main) return null;
        const rect = main.getBoundingClientRect();
        return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100) };
      });
      if (ws && ws.pct < 40) {
        addBug({ title: `Excessive Whitespace (${100 - ws.pct}% unused) — ${pg.path} on 4K`, severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
          location: `${pg.path} on 4K (3840x2160)`,
          description: `Content uses only ${ws.pct}% (${ws.width}px) of the 4K viewport — ${100-ws.pct}% is wasted whitespace.`,
          steps: `1. Open ${SITE}${pg.path} on 4K\n2. Content confined to narrow column\n3. ${100-ws.pct}% of screen is empty`,
          expected: 'Content should use 60-80%+ of viewport at 4K', actual: `Only ${ws.pct}% utilized (${ws.width}px of 3840px)`,
          fix: 'Increase max-width for large viewports. Use responsive layout.', screenshot: ss(slug, 'vp') });
      }
    }

    await page.close();
  }

  // ========== GLOBAL TESTS (run once) ==========
  console.log('\n  ── Global Tests ──');
  let page = await loadPage('/');

  // FOCUS INDICATORS
  {
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
      addBug({ title: `No Focus Indicators — ${focus.noOutline}/${focus.total} Elements (${focus.pct}%)`, severity: 'High', category: 'Accessibility', categoryTags: ['Accessibility', 'WCAG 2.4.7'],
        location: `/ on 4K (3840x2160)`,
        description: `${focus.pct}% of focusable elements lack visible focus indicators. Keyboard users cannot navigate. WCAG 2.4.7 violation.\n\nExamples:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Press Tab to navigate\n3. No visible focus ring on any element\nExamples:\n${list}`,
        expected: 'All interactive elements should show :focus-visible style', actual: `${focus.noOutline}/${focus.total} elements have no focus indicator`,
        fix: 'Add :focus-visible { outline: 2px solid currentColor; } to all interactive elements.', screenshot: ss('home', 'vp') });
    }
  }

  // COLOR CONTRAST
  {
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
      addBug({ title: `Poor Color Contrast — ${contrast.low}/${contrast.total} Elements (${contrast.pct}%)`, severity: 'High', category: 'Accessibility', categoryTags: ['Accessibility', 'WCAG'],
        location: `/ on 4K (3840x2160)`,
        description: `${contrast.pct}% of text elements fail WCAG AA 4.5:1 contrast ratio.\n\nExamples:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Many text elements have low contrast\nExamples:\n${list}`,
        expected: 'All text should meet WCAG AA 4.5:1 ratio', actual: `${contrast.low}/${contrast.total} elements fail`,
        fix: 'Darken text or lighten backgrounds to meet 4.5:1 ratio.', screenshot: ss('home', 'vp') });
    }
  }

  // HEADER ICONS
  {
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
      addBug({ title: `${missing.length} Header Icon(s) Missing`, severity: 'High', category: 'Navigation', categoryTags: ['Navigation', '4K Responsive'],
        location: `/ on 4K (3840x2160)`,
        description: `${missing.length} essential header icon(s) not found at 4K.\n\nMissing:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Check header for icons\nMissing:\n${list}`,
        expected: 'Cart, account, search icons should be visible in header', actual: `${missing.length} icons not found`,
        fix: 'Ensure header icons render at 4K. Check if hidden by media queries.', screenshot: ss('home', 'vp') });
    }
  }

  // PERFORMANCE
  {
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
      addBug({ title: `Heavy Page — ${perf.total}KB Total (${perf.large.length} Files > 1MB)`, severity: 'Medium', category: 'Performance', categoryTags: ['Performance'],
        location: `/ on 4K (3840x2160)`,
        description: `Page weighs ${perf.total}KB with ${perf.large.length} resource(s) over 1MB. Load time: ${perf.loadTime}ms.\n\nLarge files:\n${list || 'None over 1MB'}`,
        steps: `1. Open ${SITE}/ on 4K\n2. DevTools > Network\n3. Total transfer: ${perf.total}KB\nLarge files:\n${list || 'N/A'}`,
        expected: 'Page weight should be optimized — under 3MB ideally', actual: `Total: ${perf.total}KB, Load: ${perf.loadTime}ms`,
        fix: 'Compress images (WebP/AVIF), minify CSS/JS, lazy-load offscreen content.', screenshot: ss('home', 'vp') });
    }
  }

  await page.close();

  // ========== PDP DEEP CHECK ==========
  console.log('\n  ── PDP Deep Check ──');
  page = await loadPage('/products');
  const pdpLink = await page.evaluate(() => { const a = document.querySelector('a[href*="/product/"]'); return a ? a.getAttribute('href') : null; });
  await page.close();

  if (pdpLink) {
    page = await loadPage(pdpLink);
    await page.screenshot({ path: path.join(SS_DIR, ss('pdp', 'full')), fullPage: true });
    await page.screenshot({ path: path.join(SS_DIR, ss('pdp', 'vp')), fullPage: false });

    const pdp = await page.evaluate(() => {
      const checks = [];
      // Size selector
      const size = document.querySelector('[class*="size"], [class*="variant"], select[name*="size" i], [class*="option-selector"]');
      checks.push({ name: 'Size/Variant Selector', found: !!(size && size.getBoundingClientRect().width > 0), severity: 'Critical' });
      // Add to cart
      let atc = false;
      document.querySelectorAll('button, a').forEach(b => {
        const t = b.textContent.toLowerCase().trim();
        if ((t.includes('add to bag') || t.includes('add to cart') || t === 'buy now' || t === 'buy') && b.getBoundingClientRect().width > 0) atc = true;
      });
      checks.push({ name: 'Add to Cart / Buy Button', found: atc, severity: 'Critical' });
      // Gallery nav
      const arrows = document.querySelectorAll('[class*="arrow"], [class*="next"], [class*="prev"], [class*="gallery"] button, [class*="carousel"] button');
      const thumbs = document.querySelectorAll('[class*="thumb"] img, [class*="gallery"] img');
      checks.push({ name: 'Image Gallery Navigation', found: arrows.length > 0 || thumbs.length > 1, severity: 'High' });
      // Price
      const price = document.querySelector('[class*="price"], [class*="Price"], [class*="amount"]');
      checks.push({ name: 'Product Price Display', found: !!(price && price.getBoundingClientRect().width > 0 && price.textContent.trim().length > 0), severity: 'High' });
      // Description
      const desc = document.querySelector('[class*="description"], [class*="detail"], [class*="product-info"]');
      checks.push({ name: 'Product Description', found: !!(desc && desc.textContent.trim().length > 20), severity: 'Medium' });
      return checks;
    });

    pdp.filter(c => !c.found).forEach(c => {
      addBug({ title: `PDP ${c.name} — Not Found on 4K`, severity: c.severity, category: 'UI Functionality', categoryTags: ['UI Functionality', 'PDP', '4K Responsive'],
        location: `${pdpLink} on 4K (3840x2160)`,
        description: `Product Detail Page: "${c.name}" is not found or not visible at 4K.${c.severity === 'Critical' ? ' This blocks the purchase flow.' : ''}`,
        steps: `1. Open ${SITE}${pdpLink} on 4K\n2. Look for ${c.name}\n3. Not found or not visible`,
        expected: `${c.name} should be visible and functional`, actual: `${c.name} not found at 4K`,
        fix: `Check if ${c.name} component renders at 4K. Verify no media queries hide it.`, screenshot: ss('pdp', 'vp') });
    });

    await page.close();
  }

  // ========== SEARCH CHECK ==========
  console.log('\n  ── Search Check ──');
  page = await loadPage('/');
  {
    const searchIcon = await page.$('[class*="search"] svg, [class*="search"] button, [aria-label*="search" i]');
    if (searchIcon) {
      await searchIcon.click();
      await page.waitForTimeout(1000);
      const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], [class*="search"] input');
      if (searchInput) {
        await searchInput.fill('shirt');
        await searchInput.press('Enter');
        await page.waitForTimeout(4000);
        await page.screenshot({ path: path.join(SS_DIR, ss('search', 'results')), fullPage: false });
        const results = await page.evaluate(() => {
          const items = document.querySelectorAll('[class*="product"], [class*="card"], [class*="result"]');
          return { count: items.length };
        });
        if (results.count === 0) {
          addBug({ title: `Search Returns No Results for "shirt"`, severity: 'Medium', category: 'UI Functionality', categoryTags: ['UI Functionality', 'Search'],
            location: `/ on 4K (3840x2160)`,
            description: `Searching for "shirt" returns no product results on the search results page.`,
            steps: `1. Open ${SITE}/ on 4K\n2. Click search\n3. Type "shirt" and Enter\n4. No results shown`,
            expected: 'Common search term should return results', actual: 'No product results displayed',
            fix: 'Debug search API/rendering. Verify results component loads at 4K.', screenshot: ss('search', 'results') });
        }
      }
    }
  }
  await page.close();

  await browser.close();

  // ========== REPORT ==========
  const critCount = bugs.filter(b => b.severity === 'Critical').length;
  const highCount = bugs.filter(b => b.severity === 'High').length;
  const medCount = bugs.filter(b => b.severity === 'Medium').length;
  const lowCount = bugs.filter(b => b.severity === 'Low').length;

  console.log(`\n  ╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`  ║  TOTAL: ${bugs.length} BUGS — ${critCount} Critical | ${highCount} High | ${medCount} Medium | ${lowCount} Low`);
  console.log(`  ╚═══════════════════════════════════════════════════════════════╝\n`);

  fs.writeFileSync(path.join(__dirname, 'reports', '4k-all-bugs.json'), JSON.stringify(bugs, null, 2));

  // HTML REPORT — same format as existing project reports
  const sevBg = s => s === 'Critical' ? 'bg-critical' : s === 'High' ? 'bg-high' : s === 'Medium' ? 'bg-medium' : 'bg-low';
  const sevBorder = s => s === 'Critical' ? 'bug-critical' : s === 'High' ? 'bug-high' : s === 'Medium' ? 'bug-medium' : 'bug-low';
  const categories = [...new Set(bugs.map(b => b.category))];
  const pieTotal = bugs.length || 1;

  // Reuse exact same HTML template from existing project (read from index.html styles)
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>4K Bug Report — lamartina.fynd.io — ${bugs.length} bugs</title>
<style>
:root{--bg:#0a0a0f;--bg2:#111827;--bg3:#0d1117;--bg4:#161b22;--bg5:#020617;--border:#1e293b;--text:#e2e8f0;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--radius:12px}
[data-theme="light"]{--bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#e8ecf1;--bg5:#f1f5f9;--border:#d1d5db;--text:#1e293b;--text2:#475569;--text3:#64748b;--accent:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}html{scroll-behavior:smooth}
body{font-family:-apple-system,'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;line-height:1.5}
.sidebar{position:fixed;top:0;left:0;width:230px;height:100vh;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:100;display:flex;flex-direction:column}
.sidebar .logo{padding:20px 20px 16px;font-weight:800;font-size:16px;color:var(--accent);border-bottom:1px solid var(--border)}.sidebar .logo small{display:block;font-size:10px;color:var(--text3);font-weight:400;margin-top:4px;letter-spacing:.5px;text-transform:uppercase}
.nav-link{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px;color:var(--text2);text-decoration:none;border-left:3px solid transparent;transition:all .2s}
.nav-link:hover{background:var(--bg4);color:var(--text)}.nav-link.active{background:var(--bg3);color:var(--accent);border-left-color:var(--accent);font-weight:600}
.main{margin-left:230px;flex:1;min-width:0}
.hdr{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 40%,#7c2d12 100%);padding:32px 40px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.hdr h1{font-size:22px;color:#fff;font-weight:700}.hdr p{color:#fbbf24;font-size:13px;margin-top:6px}
.hdr .site-url{font-size:11px;padding:4px 12px;border-radius:6px;background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3);margin-top:8px;display:inline-block}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbar input{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;width:200px}.toolbar input::placeholder{color:rgba(255,255,255,.5)}
.toolbar button{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:500}.toolbar button:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.ctr{max-width:1400px;margin:0 auto;padding:24px}
.exec-card{background:var(--bg2);border-radius:var(--radius);padding:24px;margin:20px 0;border:1px solid var(--border);display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:center}
.pie-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.pie-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;justify-content:center}.pie-legend span{display:flex;align-items:center;gap:5px}.pie-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.stat-item{background:var(--bg3);border-radius:10px;padding:16px 12px;text-align:center;border:1px solid var(--border)}.stat-item:hover{transform:translateY(-2px)}.stat-item .val{font-size:26px;font-weight:800;line-height:1}.stat-item .lbl{font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:6px;letter-spacing:.5px}
.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.bg-critical{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}.bg-high{background:#451a03;color:#fcd34d;border:1px solid #78350f}.bg-medium{background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f}.bg-low{background:#052e16;color:#86efac;border:1px solid #14532d}.bg-info{background:#1e1b4b;color:#a5b4fc;border:1px solid #312e81}
.filters{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.filter-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;font-weight:500}.filter-btn:hover,.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.bug-card{background:var(--bg3);border-radius:var(--radius);margin:16px 0;border-left:4px solid;overflow:hidden}.bug-card:hover{box-shadow:0 2px 12px rgba(0,0,0,.15)}
.bug-critical{border-color:#ef4444}.bug-high{border-color:#f59e0b}.bug-medium{border-color:#3b82f6}.bug-low{border-color:#22c55e}
.bug-card-header{padding:16px 20px;background:var(--bg4);border-bottom:1px solid var(--border)}.bug-card-header h3{font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-weight:600}
.bug-card-body{padding:20px}
.bug-detail-table{width:100%;border-collapse:collapse;font-size:13px}.bug-detail-table tr{border-bottom:1px solid var(--border)}.bug-detail-table tr:last-child{border-bottom:none}.bug-detail-table td{padding:10px 14px;vertical-align:top;line-height:1.6}
.bug-field{font-weight:700;color:var(--text2);white-space:nowrap;width:100px;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.pass-text{color:#22c55e}.fail-text{color:#ef4444}
.bug-detail-table code{display:inline-block;background:var(--bg5);padding:8px 12px;border-radius:6px;font-size:12px;color:#67e8f9;white-space:pre-wrap;font-family:'Fira Code',Consolas,monospace}
.bug-screenshot{margin-top:14px;border-radius:10px;overflow:hidden;border:1px solid var(--border)}.bug-screenshot img{width:100%;display:block;max-height:400px;object-fit:contain;background:#0a0a0a}.bug-ss-caption{padding:10px 14px;background:var(--bg5);font-size:11px;color:var(--text2);font-style:italic}
.ftr{text-align:center;padding:32px;color:var(--text3);font-size:11px;border-top:1px solid var(--border);margin-top:24px}
.hidden{display:none!important}
.zoom-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(4px)}.zoom-overlay img{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
@media print{.sidebar,.toolbar,.filters,.zoom-overlay{display:none!important}.main{margin-left:0!important}.bug-card{break-inside:avoid}}
@media(max-width:900px){.sidebar{transform:translateX(-100%)}.main{margin-left:0}.exec-card{grid-template-columns:1fr}}
</style></head><body>
<nav class="sidebar"><div class="logo">4K Bug Report<small>lamartina.fynd.io — Rechecked</small></div>
<a href="#summary" class="nav-link active">Summary</a><a href="#all-bugs" class="nav-link">All Bugs (${bugs.length})</a>
${categories.map(c=>`<a href="#" class="nav-link" onclick="filterCat('${c}');return false">${c} (${bugs.filter(b=>b.category===c).length})</a>`).join('\n')}</nav>
<div class="main"><div class="hdr"><div>
<h1>4K Bug Report <span style="font-size:11px;background:rgba(255,255,255,.2);color:#fff;padding:3px 12px;border-radius:20px;vertical-align:middle;font-weight:500">RECHECKED</span></h1>
<p>${new Date().toISOString().split('T')[0]} &middot; ${bugs.length} bugs &middot; 7 pages + PDP + Search &middot; 3840&times;2160</p>
<span class="site-url">lamartina.fynd.io</span></div>
<div class="toolbar"><input type="text" id="searchInput" placeholder="Search bugs..." onkeyup="filterBugs()">
<button onclick="toggleTheme()">Theme</button><button onclick="window.print()">Print</button></div></div>
<div class="ctr">
<div id="summary" class="exec-card"><div class="pie-wrap">
<svg viewBox="0 0 100 100" width="120" height="120" style="transform:rotate(-90deg)">
<circle r="15.9155" cx="50" cy="50" fill="none" stroke="var(--border)" stroke-width="10"/>
<circle r="15.9155" cx="50" cy="50" fill="none" stroke="#ef4444" stroke-width="10" stroke-dasharray="${critCount/pieTotal*100} ${100-critCount/pieTotal*100}" stroke-dashoffset="0"/>
<circle r="15.9155" cx="50" cy="50" fill="none" stroke="#f59e0b" stroke-width="10" stroke-dasharray="${highCount/pieTotal*100} ${100-highCount/pieTotal*100}" stroke-dashoffset="-${critCount/pieTotal*100}"/>
<circle r="15.9155" cx="50" cy="50" fill="none" stroke="#3b82f6" stroke-width="10" stroke-dasharray="${medCount/pieTotal*100} ${100-medCount/pieTotal*100}" stroke-dashoffset="-${(critCount+highCount)/pieTotal*100}"/>
<circle r="15.9155" cx="50" cy="50" fill="none" stroke="#22c55e" stroke-width="10" stroke-dasharray="${lowCount/pieTotal*100} ${100-lowCount/pieTotal*100}" stroke-dashoffset="-${(critCount+highCount+medCount)/pieTotal*100}"/>
</svg>
<div class="pie-legend"><span><span class="dot" style="background:#ef4444"></span>${critCount} Critical</span><span><span class="dot" style="background:#f59e0b"></span>${highCount} High</span><span><span class="dot" style="background:#3b82f6"></span>${medCount} Medium</span><span><span class="dot" style="background:#22c55e"></span>${lowCount} Low</span></div></div>
<div><div class="stat-grid">
<div class="stat-item"><div class="val" style="color:var(--text)">${bugs.length}</div><div class="lbl">Total Bugs</div></div>
<div class="stat-item"><div class="val" style="color:#ef4444">${critCount}</div><div class="lbl">Critical</div></div>
<div class="stat-item"><div class="val" style="color:#f59e0b">${highCount}</div><div class="lbl">High</div></div>
<div class="stat-item"><div class="val" style="color:#3b82f6">${medCount}</div><div class="lbl">Medium</div></div>
<div class="stat-item"><div class="val" style="color:#22c55e">${lowCount}</div><div class="lbl">Low</div></div>
<div class="stat-item"><div class="val" style="color:#67e8f9">7</div><div class="lbl">Pages</div></div>
</div></div></div>
<div id="all-bugs" style="margin-top:32px"><h2 style="font-size:18px;margin-bottom:16px">All Bugs (${bugs.length})</h2>
<div class="filters"><button class="filter-btn active" onclick="filterAll()">All (${bugs.length})</button>
<button class="filter-btn" onclick="filterSev('Critical')">Critical (${critCount})</button>
<button class="filter-btn" onclick="filterSev('High')">High (${highCount})</button>
<button class="filter-btn" onclick="filterSev('Medium')">Medium (${medCount})</button>
<button class="filter-btn" onclick="filterSev('Low')">Low (${lowCount})</button>
<span style="color:var(--text3);padding:6px">|</span>
${categories.map(c=>`<button class="filter-btn" onclick="filterCat('${c}')">${c} (${bugs.filter(b=>b.category===c).length})</button>`).join('\n')}</div>
${bugs.map(b=>`<div class="bug-card ${sevBorder(b.severity)}" data-severity="${escHtml(b.severity)}" data-category="${escHtml(b.category)}">
<div class="bug-card-header"><h3><span class="badge ${sevBg(b.severity)}">${escHtml(b.severity)}</span> ${escHtml(b.id)} — ${escHtml(b.title)} (lamartina.fynd.io) <span class="badge" style="background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f;">NEW</span></h3></div>
<div class="bug-card-body"><table class="bug-detail-table">
<tr><td class="bug-field">Severity</td><td><span class="badge ${sevBg(b.severity)}">${escHtml(b.severity)}</span></td></tr>
<tr><td class="bug-field">Category</td><td>${b.categoryTags.map(t=>`<span class="badge bg-info">${escHtml(t)}</span>`).join(' ')}</td></tr>
<tr><td class="bug-field">Location</td><td>${escHtml(b.location)}</td></tr>
<tr><td class="bug-field">Description</td><td>${escHtml(b.description)}</td></tr>
<tr><td class="bug-field">Steps</td><td>${b.steps.split('\n').map(s=>escHtml(s)).join('<br>')}</td></tr>
<tr><td class="bug-field">Expected</td><td class="pass-text">${escHtml(b.expected)}</td></tr>
<tr><td class="bug-field">Actual</td><td class="fail-text">${escHtml(b.actual)}</td></tr>
<tr><td class="bug-field">Fix</td><td><code>${escHtml(b.fix)}</code></td></tr>
</table>
<div class="bug-screenshot"><img src="screenshots/${b.screenshot}" alt="Screenshot: ${escHtml(b.title)}"><div class="bug-ss-caption">Screenshot: ${escHtml(b.location)} — ${escHtml(b.title)}</div></div></div></div>`).join('\n')}
</div>
<div class="ftr">4K Bug Report (Rechecked) &middot; lamartina.fynd.io &middot; ${bugs.length} bugs &middot; ${new Date().toISOString().split('T')[0]}</div>
</div></div>
<script>
function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'}
function filterBugs(){const q=document.getElementById('searchInput').value.toLowerCase();document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',!c.textContent.toLowerCase().includes(q))})}
function filterAll(){document.querySelectorAll('.bug-card').forEach(c=>c.classList.remove('hidden'));document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
function filterSev(s){document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',c.dataset.severity!==s)});document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
function filterCat(c){document.querySelectorAll('.bug-card').forEach(el=>{el.classList.toggle('hidden',el.dataset.category!==c)});document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event&&event.target&&event.target.classList.add('active')}
document.addEventListener('click',e=>{if(e.target.tagName==='IMG'&&e.target.closest('.bug-screenshot')){const o=document.createElement('div');o.className='zoom-overlay';o.innerHTML='<img src="'+e.target.src+'">';o.onclick=()=>o.remove();document.body.appendChild(o)}});
</script></body></html>`;

  fs.writeFileSync(path.join(__dirname, 'reports', '4k-all-bugs.html'), html);
  console.log(`  Report: reports/4k-all-bugs.html`);
  console.log(`  JSON:   reports/4k-all-bugs.json\n`);
})();
