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

function addBug({ title, severity, category, categoryTags, location, description, steps, expected, actual, fix, screenshot }) {
  const id = `BUG-${String(bugIndex++).padStart(3, '0')}`;
  bugs.push({ id, title, severity: severity || 'High', category, categoryTags: categoryTags || [category], location, description, steps, expected, actual, fix, screenshot });
  const icon = severity === 'Critical' ? '\x1b[31m✗\x1b[0m' : severity === 'High' ? '\x1b[33m!\x1b[0m' : '\x1b[36m~\x1b[0m';
  console.log(`  ${icon} ${id} [${severity || 'High'}] ${title}`);
}

const PAGES_TO_TEST = [
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
    try {
      await page.goto(SITE + pagePath, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      try { await page.goto(SITE + pagePath, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
    }
    await page.waitForTimeout(2500);
    return page;
  }

  function ssName(prefix, suffix) { return `4k_${prefix}_${suffix}.png`; }

  console.log('\n  ╔═══════════════════════════════════════════════════════════════╗');
  console.log('  ║  4K EXPLORATORY BUG REPORT — lamartina.fynd.io              ║');
  console.log('  ║  Viewport: 3840 × 2160 (4K UHD) — All Severities           ║');
  console.log('  ╚═══════════════════════════════════════════════════════════════╝\n');

  // ==========================================================================
  // PER-PAGE TESTS
  // ==========================================================================
  for (const pg of PAGES_TO_TEST) {
    console.log(`\n  ── ${pg.name} (${pg.path}) ──`);
    const page = await loadPage(pg.path);
    const slug = pg.path === '/' ? 'home' : pg.path.replace(/\//g, '_').slice(1);
    await page.screenshot({ path: path.join(SS_DIR, ssName(slug, 'full')), fullPage: true });
    await page.screenshot({ path: path.join(SS_DIR, ssName(slug, 'viewport')), fullPage: false });

    // 1. HORIZONTAL SCROLL
    const hScroll = await page.evaluate(() => {
      const sw = document.documentElement.scrollWidth;
      const vw = window.innerWidth;
      return { sw, vw, overflow: sw > vw + 5 };
    });
    if (hScroll.overflow) {
      addBug({
        title: `Horizontal Scroll Detected — ${pg.path} on 4K`,
        severity: 'Critical', category: 'Layout', categoryTags: ['Layout', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `Page has horizontal scroll at 4K. scrollWidth (${hScroll.sw}px) exceeds viewport (${hScroll.vw}px) by ${hScroll.sw - hScroll.vw}px.`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Scroll horizontally\n3. Content extends beyond viewport`,
        expected: 'No horizontal scrollbar at 4K resolution',
        actual: `scrollWidth=${hScroll.sw}px > viewport=${hScroll.vw}px — horizontal scroll present`,
        fix: 'Find and fix the element causing overflow. Add overflow-x: hidden to body or fix the offending element width.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 2. NAV ALIGNMENT
    const nav = await page.evaluate(() => {
      const el = document.querySelector('nav');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100), cls: el.className.split(' ')[0].slice(0, 25) };
    });
    if (nav && nav.pct < 50) {
      addBug({
        title: `Nav Bar Covers Only ${nav.pct}% of Viewport — ${pg.path} on 4K`,
        severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `Navigation bar (nav.${nav.cls}) only covers ${nav.pct}% (${nav.width}px) of the 4K viewport (3840px). Massive empty gap on the right side.`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Observe the top nav bar\n3. Nav content occupies only left ${nav.pct}%\n4. Right ${100 - nav.pct}% is empty`,
        expected: 'Navigation bar should span 100% of viewport width at 4K',
        actual: `Nav is ${nav.width}px (${nav.pct}% of 3840px) — ${3840 - nav.width}px empty space on right`,
        fix: 'Set nav width: 100% and remove restrictive max-width. Use flexbox to distribute items.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 3. BLURRY IMAGES
    const blurry = await page.evaluate(() => {
      const results = []; const seen = new Set();
      document.querySelectorAll('img').forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 150 && img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5) {
          const alt = (img.alt || img.src.split('/').pop()).slice(0, 50);
          if (!seen.has(alt)) { seen.add(alt); results.push({ alt, rendered: Math.round(rect.width), natural: img.naturalWidth, ratio: (rect.width / img.naturalWidth).toFixed(1) }); }
        }
      });
      return results;
    });
    if (blurry.length > 0) {
      const list = blurry.slice(0, 6).map((img, i) => `${i+1}. "${img.alt}" — natural: ${img.natural}px, rendered: ${img.rendered}px (${img.ratio}x upscale)`).join('\n');
      addBug({
        title: `${blurry.length} Blurry Image(s) — ${pg.path} on 4K`,
        severity: 'High', category: 'Image Quality', categoryTags: ['Image Quality', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${blurry.length} image(s) are severely blurry at 4K. Source images are too small for render size (${blurry[0].ratio}x upscale).\n\nAffected images:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Scroll through the page\n3. Images appear pixelated and blurry\n4. Inspect shows natural size << rendered size\nAffected images:\n${list}`,
        expected: 'All images should be crisp at 4K. Source >= rendered size (1:1 ratio)',
        actual: `${blurry.length} images upscaled ${blurry[0].ratio}x — source ${blurry[0].natural}px rendered at ${blurry[0].rendered}px`,
        fix: 'Use srcset/sizes or CDN params (?w=1200&dpr=2) to serve high-res images. Min source width: 900px for 4K.',
        screenshot: ssName(slug, 'full')
      });
    }

    // 4. SMALL INTERACTIVE ELEMENTS
    const smallEls = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('button, a, input[type="submit"], [role="button"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        const text = el.textContent.trim().slice(0, 40);
        if (rect.width > 0 && rect.height > 0 && text.length > 0 && text.length < 50 && (rect.width < 44 || rect.height < 44) && rect.width < 200) {
          results.push({ text, w: Math.round(rect.width), h: Math.round(rect.height), tag: el.tagName.toLowerCase(), cls: (el.className || '').split(' ')[0].slice(0, 20) });
        }
      });
      return results.slice(0, 10);
    });
    if (smallEls.length >= 2) {
      const list = smallEls.map((el, i) => `${i+1}. <${el.tag}${el.cls ? '.' + el.cls : ''}>"${el.text}" — only ${el.w}x${el.h}px — too small to click`).join('\n');
      addBug({
        title: `${smallEls.length} Undersized Clickable Elements — ${pg.path} on 4K`,
        severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${smallEls.length} interactive element(s) are below the WCAG 44x44px minimum touch target size at 4K.\n\nAffected elements:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Try clicking elements below\n3. They are too small to target accurately\nElements that are too small:\n${list}`,
        expected: 'All interactive elements should meet WCAG 44x44px minimum target size',
        actual: `${smallEls.length} element(s) below 44x44px at 4K`,
        fix: 'Use responsive sizing (clamp(), vw units) for padding/font. Min click target: 44x44px.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 5. TINY TEXT
    const tinyText = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('p, span, a, li, td, th, label, small, div').forEach(el => {
        if (el.children.length > 2) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        const text = el.textContent.trim();
        if (fs > 0 && fs < 12 && text.length > 2 && text.length < 60 && el.offsetHeight > 0 && el.offsetWidth > 0) {
          results.push({ text: text.slice(0, 40), fontSize: fs, tag: el.tagName.toLowerCase() });
        }
      });
      return results.slice(0, 8);
    });
    if (tinyText.length >= 3) {
      const list = tinyText.map((t, i) => `${i+1}. <${t.tag}>"${t.text}" — font-size: ${t.fontSize}px`).join('\n');
      addBug({
        title: `${tinyText.length} Tiny Text Elements — ${pg.path} on 4K`,
        severity: 'Medium', category: 'Typography', categoryTags: ['Typography', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${tinyText.length} text element(s) have font-size below 12px — nearly unreadable on a 4K display.\n\nAffected elements:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Look for tiny text across the page\n3. Several elements have font-size under 12px\nElements with tiny text:\n${list}`,
        expected: 'All text should be at least 12px at 4K for readability',
        actual: `${tinyText.length} elements below 12px font-size`,
        fix: 'Use clamp() or min() for font sizes. Ensure minimum 12px at all viewport widths.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 6. LAZY LOADING BROKEN IN VIEWPORT
    const lazyBroken = await page.evaluate(() => {
      const broken = []; let total = 0;
      document.querySelectorAll('img[loading="lazy"]').forEach(img => {
        total++;
        const rect = img.getBoundingClientRect();
        if (rect.top < window.innerHeight && rect.top > -100 && (!img.complete || img.naturalWidth === 0)) {
          broken.push({ alt: (img.alt || img.src.split('/').pop()).slice(0, 50), top: Math.round(rect.top) });
        }
      });
      return { broken, total };
    });
    if (lazyBroken.broken.length > 0) {
      const list = lazyBroken.broken.map((img, i) => `${i+1}. "${img.alt}" at y=${img.top}px — not loaded`).join('\n');
      addBug({
        title: `${lazyBroken.broken.length} Lazy Images Not Loaded in Viewport — ${pg.path} on 4K`,
        severity: 'High', category: 'Image Quality', categoryTags: ['Image Quality', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${lazyBroken.broken.length}/${lazyBroken.total} lazy-loaded images within the 4K viewport (2160px tall) failed to load.\n\nBroken images:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Wait for full page load\n3. Blank image placeholders visible in viewport\nBroken images:\n${list}`,
        expected: 'All in-viewport images should load immediately',
        actual: `${lazyBroken.broken.length}/${lazyBroken.total} lazy images in viewport did not load`,
        fix: 'Remove loading="lazy" from above-the-fold images or use larger Intersection Observer rootMargin.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 7. OVERLAPPING ELEMENTS
    const overlaps = await page.evaluate(() => {
      const results = [];
      const els = document.querySelectorAll('button, a, input, [role="button"], nav, header, [class*="modal"], [class*="overlay"], [class*="popup"]');
      const rects = [];
      els.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.width < 3840) {
          rects.push({ el, rect, tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 30), cls: (el.className || '').split(' ')[0].slice(0, 20) });
        }
      });
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].rect, b = rects[j].rect;
          if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) {
            const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
            const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
            const overlapArea = overlapW * overlapH;
            const smallerArea = Math.min(a.width * a.height, b.width * b.height);
            if (overlapArea > smallerArea * 0.5 && smallerArea > 100 && rects[i].text !== rects[j].text) {
              results.push({ el1: `<${rects[i].tag}>"${rects[i].text}"`, el2: `<${rects[j].tag}>"${rects[j].text}"`, overlap: Math.round(overlapArea / smallerArea * 100) });
              if (results.length >= 5) return results;
            }
          }
        }
      }
      return results;
    });
    if (overlaps.length > 0) {
      const list = overlaps.map((o, i) => `${i+1}. ${o.el1} overlaps ${o.el2} by ${o.overlap}%`).join('\n');
      addBug({
        title: `${overlaps.length} Overlapping Elements — ${pg.path} on 4K`,
        severity: 'Critical', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${overlaps.length} element(s) overlap at 4K, potentially blocking interaction.\n\nOverlapping elements:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Observe overlapping UI elements\nOverlapping elements:\n${list}`,
        expected: 'No interactive elements should overlap at 4K',
        actual: `${overlaps.length} element pair(s) overlap significantly`,
        fix: 'Fix z-index stacking and positioning for 4K. Use proper responsive layout.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 8. FOOTER WIDTH CHECK
    const footer = await page.evaluate(() => {
      const el = document.querySelector('footer');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100), height: Math.round(rect.height) };
    });
    if (footer && footer.pct < 90) {
      addBug({
        title: `Footer Does Not Span Full Width — ${pg.path} on 4K`,
        severity: 'Medium', category: 'Layout', categoryTags: ['Layout', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `Footer only spans ${footer.pct}% (${footer.width}px) of the 4K viewport, leaving gaps on the sides.`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Scroll to footer\n3. Footer doesn't reach viewport edges`,
        expected: 'Footer should span 100% of viewport width',
        actual: `Footer is ${footer.width}px (${footer.pct}% of 3840px)`,
        fix: 'Set footer width: 100% and remove max-width constraints.',
        screenshot: ssName(slug, 'full')
      });
    }

    // 9. WHITESPACE RATIO (content vs viewport)
    const contentRatio = await page.evaluate(() => {
      const main = document.querySelector('main') || document.querySelector('[class*="content"]') || document.querySelector('[class*="container"]');
      if (!main) return null;
      const rect = main.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100) };
    });
    if (contentRatio && contentRatio.pct < 50 && !['/', '/products', '/collections', '/categories'].includes(pg.path)) {
      addBug({
        title: `Excessive Whitespace (${100 - contentRatio.pct}% unused) — ${pg.path} on 4K`,
        severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `Main content area only uses ${contentRatio.pct}% (${contentRatio.width}px) of the 4K viewport. ${100 - contentRatio.pct}% of the screen is empty whitespace.`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Observe content is confined to narrow center column\n3. ${100 - contentRatio.pct}% of viewport is wasted`,
        expected: 'Content should utilize 60-80%+ of viewport at 4K',
        actual: `Content uses only ${contentRatio.pct}% of viewport (${contentRatio.width}px of 3840px)`,
        fix: 'Increase container max-width for large viewports. Use responsive layout that scales up.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 10. BROKEN LINKS / IMAGES
    const brokenImgs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('img').forEach(img => {
        if (img.complete && img.naturalWidth === 0 && img.src && !img.src.startsWith('data:')) {
          results.push({ alt: (img.alt || 'no alt').slice(0, 40), src: img.src.slice(-60) });
        }
      });
      return results;
    });
    if (brokenImgs.length > 0) {
      const list = brokenImgs.slice(0, 5).map((img, i) => `${i+1}. "${img.alt}" — src: ...${img.src}`).join('\n');
      addBug({
        title: `${brokenImgs.length} Broken Image(s) — ${pg.path} on 4K`,
        severity: 'Critical', category: 'Image Quality', categoryTags: ['Image Quality', 'Broken'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${brokenImgs.length} image(s) failed to load completely — showing broken image icons.\n\nBroken images:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Look for broken image placeholders\nBroken images:\n${list}`,
        expected: 'All images should load successfully',
        actual: `${brokenImgs.length} images have naturalWidth=0 after loading`,
        fix: 'Verify image URLs exist and are accessible. Check for 404 errors in network tab.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 11. MISSING ALT TEXT
    const missingAlts = await page.evaluate(() => {
      let count = 0;
      const examples = [];
      document.querySelectorAll('img').forEach(img => {
        if (!img.alt && img.offsetWidth > 50 && !img.src.startsWith('data:')) {
          count++;
          if (examples.length < 5) examples.push({ src: img.src.split('/').pop().slice(0, 40), w: Math.round(img.getBoundingClientRect().width) });
        }
      });
      return { count, examples };
    });
    if (missingAlts.count >= 3) {
      const list = missingAlts.examples.map((img, i) => `${i+1}. <img> src="...${img.src}" (${img.w}px wide) — no alt attribute`).join('\n');
      addBug({
        title: `${missingAlts.count} Images Missing Alt Text — ${pg.path}`,
        severity: 'Medium', category: 'Accessibility', categoryTags: ['Accessibility', 'SEO'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${missingAlts.count} visible image(s) are missing alt attributes — WCAG 1.1.1 violation and SEO issue.\n\nExamples:\n${list}`,
        steps: `1. Open ${SITE}${pg.path}\n2. Inspect images in DevTools\n3. Multiple images lack alt attributes\nExamples:\n${list}`,
        expected: 'All meaningful images should have descriptive alt text',
        actual: `${missingAlts.count} images missing alt text`,
        fix: 'Add descriptive alt text to all product and content images. Use alt="" only for decorative images.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 12. CONSOLE ERRORS
    const consoleErrors = [];
    page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 100)); });
    await page.evaluate(() => {}); // trigger any pending
    await page.waitForTimeout(500);

    // 13. Z-INDEX STACKING (sticky header blocking content)
    const stickyBlocking = await page.evaluate(() => {
      const stickyEls = [];
      document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        if ((style.position === 'fixed' || style.position === 'sticky') && el.offsetHeight > 0 && el.offsetWidth > 100) {
          const rect = el.getBoundingClientRect();
          stickyEls.push({ tag: el.tagName.toLowerCase(), cls: (el.className || '').split(' ')[0].slice(0, 25), h: Math.round(rect.height), w: Math.round(rect.width), zIndex: style.zIndex, pct: Math.round(rect.height / 2160 * 100) });
        }
      });
      return stickyEls;
    });
    const bigSticky = stickyBlocking.filter(s => s.pct > 10);
    if (bigSticky.length > 0) {
      const list = bigSticky.map((s, i) => `${i+1}. <${s.tag}.${s.cls}> — ${s.h}px tall (${s.pct}% of viewport), z-index: ${s.zIndex}`).join('\n');
      addBug({
        title: `Fixed/Sticky Element Covers ${bigSticky[0].pct}% of Viewport — ${pg.path} on 4K`,
        severity: 'Medium', category: 'Layout', categoryTags: ['Layout', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${bigSticky.length} fixed/sticky element(s) cover more than 10% of the 4K viewport height, reducing visible content area.\n\nElements:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Scroll down\n3. Sticky element(s) consume significant screen space\nElements:\n${list}`,
        expected: 'Fixed/sticky elements should not consume more than 10% of viewport',
        actual: `Sticky element covers ${bigSticky[0].pct}% of 4K viewport (${bigSticky[0].h}px of 2160px)`,
        fix: 'Reduce height of sticky elements at 4K or make them auto-hide on scroll.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 14. INPUT FIELDS TOO SMALL
    const smallInputs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('input, textarea, select').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && rect.height < 36 && el.type !== 'hidden' && el.type !== 'checkbox' && el.type !== 'radio') {
          results.push({ type: el.type || 'text', name: (el.name || el.placeholder || '').slice(0, 30), w: Math.round(rect.width), h: Math.round(rect.height) });
        }
      });
      return results;
    });
    if (smallInputs.length > 0) {
      const list = smallInputs.map((inp, i) => `${i+1}. <input type="${inp.type}"> "${inp.name}" — ${inp.w}x${inp.h}px`).join('\n');
      addBug({
        title: `${smallInputs.length} Undersized Input Field(s) — ${pg.path} on 4K`,
        severity: 'Medium', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${smallInputs.length} form input(s) have height below 36px — too small for comfortable interaction at 4K.\n\nAffected inputs:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Find the form inputs\n3. Input fields are disproportionately small\nAffected inputs:\n${list}`,
        expected: 'Form inputs should be at least 36-44px tall at 4K',
        actual: `${smallInputs.length} input(s) below 36px height`,
        fix: 'Use responsive padding and min-height for form inputs. Min recommended height: 44px.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    // 15. CONTENT NOT CENTERED
    const offCenter = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('main, [class*="container"], [class*="wrapper"], [class*="content"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const maxW = parseInt(style.maxWidth);
        if (maxW && maxW < 3000 && rect.height > 100 && rect.width > 100) {
          const leftGap = Math.round(rect.left);
          const rightGap = Math.round(3840 - rect.right);
          const diff = Math.abs(leftGap - rightGap);
          if (diff > 100) {
            results.push({ cls: (el.className || '').split(' ')[0].slice(0, 30), leftGap, rightGap, diff, maxW });
          }
        }
      });
      return results;
    });
    if (offCenter.length > 0) {
      const list = offCenter.map((c, i) => `${i+1}. ".${c.cls}" (max-width: ${c.maxW}px) — left gap: ${c.leftGap}px, right gap: ${c.rightGap}px (${c.diff}px off-center)`).join('\n');
      addBug({
        title: `${offCenter.length} Container(s) Not Centered — ${pg.path} on 4K`,
        severity: 'Medium', category: 'Layout', categoryTags: ['Layout', '4K Responsive'],
        location: `${pg.path} on 4K (3840x2160)`,
        description: `${offCenter.length} container(s) with max-width are not horizontally centered at 4K — content appears shifted to one side.\n\nOff-center containers:\n${list}`,
        steps: `1. Open ${SITE}${pg.path} on 4K\n2. Observe content is not centered\n3. Larger gap on one side\nOff-center containers:\n${list}`,
        expected: 'Containers should be horizontally centered with equal margins',
        actual: `${offCenter.length} container(s) are off-center by ${offCenter[0].diff}px+`,
        fix: 'Add margin: 0 auto to centered containers. Verify no conflicting margin/padding rules.',
        screenshot: ssName(slug, 'viewport')
      });
    }

    await page.close();
  }

  // ==========================================================================
  // GLOBAL EXPLORATORY TESTS
  // ==========================================================================
  console.log('\n  ── Global Exploratory Tests ──');

  // ACCESSIBILITY: Focus indicators
  let page = await loadPage('/');
  {
    const focusCheck = await page.evaluate(() => {
      const focusable = document.querySelectorAll('a, button, input, select, textarea, [tabindex]');
      let noOutline = 0, total = 0;
      const examples = [];
      focusable.forEach(el => {
        if (el.offsetHeight > 0) {
          total++;
          const style = getComputedStyle(el);
          if (style.outlineStyle === 'none' && style.outlineWidth === '0px') {
            noOutline++;
            if (examples.length < 5) examples.push({ tag: el.tagName.toLowerCase(), text: el.textContent.trim().slice(0, 25) });
          }
        }
      });
      return { total, noOutline, examples };
    });
    if (focusCheck.noOutline >= focusCheck.total * 0.5 && focusCheck.total > 5) {
      const list = focusCheck.examples.map((el, i) => `${i+1}. <${el.tag}>"${el.text}" — no focus outline`).join('\n');
      addBug({
        title: `No Focus Indicators — ${focusCheck.noOutline}/${focusCheck.total} Elements`,
        severity: 'High', category: 'Accessibility', categoryTags: ['Accessibility', 'WCAG'],
        location: `/ on 4K (3840x2160)`,
        description: `${focusCheck.noOutline}/${focusCheck.total} (${Math.round(focusCheck.noOutline / focusCheck.total * 100)}%) focusable elements lack visible focus indicators. Keyboard navigation is impossible. WCAG 2.4.7 violation.\n\nExamples:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Press Tab to navigate\n3. No visible focus ring appears\n4. User cannot track focused element\nExamples:\n${list}`,
        expected: 'All focusable elements should have visible :focus/:focus-visible styles',
        actual: `${focusCheck.noOutline}/${focusCheck.total} elements have outline: none — no focus visible`,
        fix: 'Add :focus-visible { outline: 2px solid currentColor; outline-offset: 2px; } to all interactive elements.',
        screenshot: ssName('home', 'viewport')
      });
    }
  }

  // ACCESSIBILITY: Color contrast
  {
    const contrast = await page.evaluate(() => {
      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }
      function parseColor(c) { const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : null; }
      const texts = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, a, span, li, label, button');
      let low = 0, total = 0;
      const examples = [];
      texts.forEach(el => {
        if (el.offsetHeight > 0 && el.textContent.trim().length > 2) {
          total++;
          const fg = parseColor(getComputedStyle(el).color);
          const bg = parseColor(getComputedStyle(el).backgroundColor);
          if (fg && bg) {
            const l1 = luminance(...fg), l2 = luminance(...bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            if (ratio < 4.5) {
              low++;
              if (examples.length < 5) examples.push({ text: el.textContent.trim().slice(0, 30), ratio: ratio.toFixed(2), tag: el.tagName.toLowerCase() });
            }
          }
        }
      });
      return { total, low, examples };
    });
    if (contrast.low > 5) {
      const list = contrast.examples.map((el, i) => `${i+1}. <${el.tag}>"${el.text}" — contrast ratio: ${el.ratio}:1`).join('\n');
      addBug({
        title: `Poor Color Contrast — ${contrast.low}/${contrast.total} Elements Fail WCAG`,
        severity: 'High', category: 'Accessibility', categoryTags: ['Accessibility', 'WCAG'],
        location: `/ on 4K (3840x2160)`,
        description: `${contrast.low}/${contrast.total} (${Math.round(contrast.low / contrast.total * 100)}%) text elements have contrast ratio below WCAG AA minimum 4.5:1.\n\nExamples:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Observe text elements across the page\n3. Many have insufficient contrast\nExamples:\n${list}`,
        expected: 'All text should meet WCAG AA 4.5:1 contrast ratio',
        actual: `${contrast.low}/${contrast.total} elements fail contrast check`,
        fix: 'Darken text or lighten backgrounds. Use a contrast checker tool to verify. Min ratio: 4.5:1 (normal), 3:1 (large text).',
        screenshot: ssName('home', 'viewport')
      });
    }
  }

  // PERFORMANCE: LCP, CLS, load time
  {
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const loadTime = nav ? Math.round(nav.loadEventEnd - nav.fetchStart) : null;
      const domReady = nav ? Math.round(nav.domContentLoadedEventEnd - nav.fetchStart) : null;
      const resources = performance.getEntriesByType('resource');
      const largeResources = resources.filter(r => r.transferSize > 500000).map(r => ({ name: r.name.split('/').pop().slice(0, 40), size: Math.round(r.transferSize / 1024), type: r.initiatorType }));
      const totalTransfer = Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024);
      return { loadTime, domReady, largeResources, totalTransfer, resourceCount: resources.length };
    });
    if (perf.largeResources.length > 0) {
      const list = perf.largeResources.slice(0, 5).map((r, i) => `${i+1}. "${r.name}" (${r.type}) — ${r.size}KB`).join('\n');
      addBug({
        title: `${perf.largeResources.length} Oversized Resource(s) — Total ${perf.totalTransfer}KB`,
        severity: 'Medium', category: 'Performance', categoryTags: ['Performance', '4K Responsive'],
        location: `/ on 4K (3840x2160)`,
        description: `${perf.largeResources.length} resource(s) over 500KB detected. Total page weight: ${perf.totalTransfer}KB across ${perf.resourceCount} resources. Load time: ${perf.loadTime}ms.\n\nLarge resources:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Open DevTools > Network tab\n3. Sort by size\n4. Multiple resources over 500KB\nLarge resources:\n${list}`,
        expected: 'Individual resources should be under 500KB. Total page weight should be optimized.',
        actual: `${perf.largeResources.length} resources over 500KB. Total: ${perf.totalTransfer}KB`,
        fix: 'Compress images (WebP/AVIF), minify JS/CSS, use code splitting. Serve appropriately sized assets for each viewport.',
        screenshot: ssName('home', 'viewport')
      });
    }
  }

  // CLS CHECK
  {
    const cls = await page.evaluate(() => {
      return new Promise(resolve => {
        let clsValue = 0;
        const po = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) { if (!entry.hadRecentInput) clsValue += entry.value; }
        });
        po.observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => { po.disconnect(); resolve(clsValue); }, 2000);
      });
    });
    if (cls >= 0.1) {
      addBug({
        title: `Layout Shift Detected — CLS: ${cls.toFixed(4)}`,
        severity: cls >= 0.25 ? 'High' : 'Medium', category: 'Performance', categoryTags: ['Performance', 'CLS'],
        location: `/ on 4K (3840x2160)`,
        description: `Cumulative Layout Shift (CLS) is ${cls.toFixed(4)} — ${cls >= 0.25 ? 'poor' : 'needs improvement'}. Elements shift position as the page loads, causing a jarring user experience.`,
        steps: `1. Open ${SITE}/ on 4K\n2. Watch as the page loads\n3. Elements visibly shift position\n4. CLS value: ${cls.toFixed(4)}`,
        expected: 'CLS should be below 0.1 (good)',
        actual: `CLS: ${cls.toFixed(4)} — ${cls >= 0.25 ? 'poor (>0.25)' : 'needs improvement (>0.1)'}`,
        fix: 'Set explicit width/height on images and embeds. Avoid inserting content above existing content. Reserve space for dynamic elements.',
        screenshot: ssName('home', 'viewport')
      });
    }
  }

  await page.close();

  // HEADER/FOOTER CONSISTENCY CHECK
  console.log('\n  ── Header/Footer Icon Check ──');
  page = await loadPage('/');
  {
    const headerIcons = await page.evaluate(() => {
      const cart = document.querySelector('a[href*="cart"], [class*="cart-icon"], [class*="bag-icon"], header [class*="cart"]');
      const acc = document.querySelector('a[href*="login"], a[href*="account"], a[href*="profile"], [class*="user-icon"], header [class*="account"]');
      const wishlist = document.querySelector('a[href*="wishlist"], [class*="wishlist"], [class*="heart-icon"]');
      const search = document.querySelector('input[type="search"], [class*="search"] input, [class*="search-bar"], [class*="search"] button');
      const check = (el, name) => {
        if (!el) return { name, found: false };
        const rect = el.getBoundingClientRect();
        return { name, found: true, w: Math.round(rect.width), h: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0 };
      };
      return [check(cart, 'Cart'), check(acc, 'Account/Login'), check(wishlist, 'Wishlist'), check(search, 'Search')];
    });
    const missing = headerIcons.filter(i => !i.found);
    const tooSmall = headerIcons.filter(i => i.found && (i.w < 24 || i.h < 24));
    if (missing.length > 0 || tooSmall.length > 0) {
      const issues = [];
      missing.forEach(i => issues.push(`${i.name} icon — not found`));
      tooSmall.forEach(i => issues.push(`${i.name} icon — only ${i.w}x${i.h}px — too small`));
      const list = issues.map((s, i) => `${i+1}. ${s}`).join('\n');
      addBug({
        title: `Header Icons Missing/Too Small — ${issues.length} Issue(s)`,
        severity: 'High', category: 'Navigation', categoryTags: ['Navigation', '4K Responsive'],
        location: `/ on 4K (3840x2160)`,
        description: `${issues.length} header icon issue(s) at 4K resolution. Essential e-commerce navigation icons are missing or too small.\n\nIssues:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Look at the header for cart, account, search, wishlist icons\n3. Some icons are missing or undersized\nIssues:\n${list}`,
        expected: 'All header icons (cart, account, search, wishlist) should be visible and at least 24x24px',
        actual: `${issues.length} header icon issue(s) — ${missing.length} missing, ${tooSmall.length} too small`,
        fix: 'Ensure all header icons render at 4K. Use SVG icons that scale. Min size: 24x24px (recommended: 44x44px).',
        screenshot: ssName('home', 'viewport')
      });
    }
  }

  // SCROLL TEST — scroll to bottom and check for issues
  {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(SS_DIR, ssName('home', 'scrolled')), fullPage: false });

    const scrollIssues = await page.evaluate(() => {
      const issues = [];
      // Check for back-to-top button
      const btt = document.querySelector('[class*="back-to-top"], [class*="scroll-top"], [class*="go-top"], [aria-label*="top"]');
      if (!btt) issues.push('No back-to-top button found');
      // Check footer links are clickable
      const footerLinks = document.querySelectorAll('footer a');
      let tinyFooterLinks = 0;
      footerLinks.forEach(a => {
        const rect = a.getBoundingClientRect();
        if (rect.height > 0 && rect.height < 20) tinyFooterLinks++;
      });
      if (tinyFooterLinks > 3) issues.push(`${tinyFooterLinks} footer links are under 20px tall — hard to click at 4K`);
      return issues;
    });
    if (scrollIssues.length > 0) {
      const list = scrollIssues.map((s, i) => `${i+1}. ${s}`).join('\n');
      addBug({
        title: `Scroll/Footer UX Issues — ${scrollIssues.length} Problem(s)`,
        severity: 'Low', category: 'UX', categoryTags: ['UX', '4K Responsive'],
        location: `/ on 4K (3840x2160)`,
        description: `${scrollIssues.length} scroll/footer UX issue(s) at 4K.\n\nIssues:\n${list}`,
        steps: `1. Open ${SITE}/ on 4K\n2. Scroll to the bottom of the page\n3. Check for back-to-top button and footer link sizes\nIssues:\n${list}`,
        expected: 'Page should have back-to-top button and footer links should be adequately sized at 4K',
        actual: `${scrollIssues.length} UX issue(s) found`,
        fix: 'Add a back-to-top button for long pages. Ensure footer links have adequate padding (min 44px touch target).',
        screenshot: ssName('home', 'scrolled')
      });
    }
  }

  // PDP DEEP TEST
  console.log('\n  ── PDP Deep Exploratory Test ──');
  await page.close();
  page = await loadPage('/products');
  const pdpLink = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/product/"]');
    return a ? a.getAttribute('href') : null;
  });
  await page.close();

  if (pdpLink) {
    page = await loadPage(pdpLink);
    await page.screenshot({ path: path.join(SS_DIR, ssName('pdp', 'full')), fullPage: true });
    await page.screenshot({ path: path.join(SS_DIR, ssName('pdp', 'viewport')), fullPage: false });

    const pdpChecks = await page.evaluate(() => {
      const issues = [];
      // Size selector
      const sizeEl = document.querySelector('[class*="size"], [class*="variant"], select[name*="size" i]');
      if (!sizeEl || sizeEl.getBoundingClientRect().width === 0) issues.push({ item: 'Size/Variant Selector', status: 'not found', severity: 'Critical' });
      // Add to cart
      let atcFound = false;
      document.querySelectorAll('button').forEach(b => {
        const t = b.textContent.toLowerCase();
        if ((t.includes('add to') || t.includes('cart') || t.includes('buy now')) && b.getBoundingClientRect().width > 0) atcFound = true;
      });
      if (!atcFound) issues.push({ item: 'Add to Cart / Buy Button', status: 'not found', severity: 'Critical' });
      // Gallery
      const arrows = document.querySelectorAll('[class*="arrow"], [class*="next"], [class*="prev"], [class*="gallery"] button');
      const thumbs = document.querySelectorAll('[class*="thumb"] img, [class*="gallery"] img');
      if (arrows.length === 0 && thumbs.length <= 1) issues.push({ item: 'Image Gallery Navigation', status: 'no arrows or thumbnails found', severity: 'High' });
      // Price
      const price = document.querySelector('[class*="price"], [class*="Price"]');
      if (!price || price.getBoundingClientRect().width === 0) issues.push({ item: 'Product Price', status: 'not found or hidden', severity: 'High' });
      else {
        const fs = parseFloat(getComputedStyle(price).fontSize);
        if (fs < 16) issues.push({ item: 'Product Price', status: `font-size only ${fs}px — too small at 4K`, severity: 'Medium' });
      }
      // Product title
      const title = document.querySelector('h1, [class*="product-title"], [class*="product-name"]');
      if (title) {
        const fs = parseFloat(getComputedStyle(title).fontSize);
        if (fs < 20) issues.push({ item: 'Product Title', status: `font-size only ${fs}px — too small at 4K`, severity: 'Medium' });
      }
      // Breadcrumb
      const breadcrumb = document.querySelector('[class*="breadcrumb"], nav[aria-label="breadcrumb"]');
      if (!breadcrumb) issues.push({ item: 'Breadcrumb Navigation', status: 'not found on PDP', severity: 'Low' });
      // Description/details
      const desc = document.querySelector('[class*="description"], [class*="detail"], [class*="product-info"]');
      if (!desc || desc.textContent.trim().length < 10) issues.push({ item: 'Product Description', status: 'missing or empty', severity: 'Medium' });
      // Delivery info
      const delivery = document.querySelector('[class*="delivery"], [class*="shipping"], [class*="pincode"]');
      if (!delivery) issues.push({ item: 'Delivery/Shipping Info', status: 'not found', severity: 'Low' });
      // Wishlist
      const wishlist = document.querySelector('[class*="wishlist"], [class*="heart"], [class*="favorite"]');
      if (!wishlist) issues.push({ item: 'Wishlist/Favorite Button', status: 'not found', severity: 'Low' });
      return issues;
    });

    pdpChecks.forEach(issue => {
      addBug({
        title: `PDP ${issue.item} — ${issue.status} on 4K`,
        severity: issue.severity, category: 'UI Functionality', categoryTags: ['UI Functionality', 'PDP', '4K Responsive'],
        location: `${pdpLink} on 4K (3840x2160)`,
        description: `Product Detail Page issue at 4K: ${issue.item} — ${issue.status}.\n\nThis ${issue.severity === 'Critical' ? 'completely blocks the purchase funnel' : 'degrades the shopping experience'} at 4K resolution.`,
        steps: `1. Open ${SITE}${pdpLink} on 4K\n2. Look for ${issue.item}\n3. Element is ${issue.status}`,
        expected: `${issue.item} should be visible and functional at 4K resolution`,
        actual: `${issue.item} — ${issue.status}`,
        fix: `Verify ${issue.item} component renders at 4K viewport. Check if it's hidden by media queries or if JS fails to initialize at large viewports.`,
        screenshot: ssName('pdp', 'viewport')
      });
    });

    await page.close();
  }

  // SEARCH EXPLORATORY TEST
  console.log('\n  ── Search Exploratory Test ──');
  page = await loadPage('/');
  {
    const searchIcon = await page.$('[class*="search"] svg, [class*="search"] button, [aria-label*="search" i], [class*="search"]');
    if (searchIcon) {
      try {
        await searchIcon.click();
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(SS_DIR, ssName('search', 'open')), fullPage: false });

        const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], [class*="search"] input');
        if (searchInput) {
          const inputSize = await page.evaluate(el => {
            const rect = el.getBoundingClientRect();
            return { w: Math.round(rect.width), h: Math.round(rect.height) };
          }, searchInput);

          if (inputSize.w < 300) {
            addBug({
              title: `Search Input Too Narrow at 4K — ${inputSize.w}px`,
              severity: 'Medium', category: 'UI Alignment', categoryTags: ['UI Alignment', 'Search', '4K Responsive'],
              location: `/ on 4K (3840x2160)`,
              description: `Search input is only ${inputSize.w}px wide at 4K (3840px viewport) — uses less than ${Math.round(inputSize.w/3840*100)}% of available space. Disproportionately small.`,
              steps: `1. Open ${SITE}/ on 4K\n2. Click the search icon\n3. Search input opens but is only ${inputSize.w}px wide\n4. Input is tiny relative to 4K viewport`,
              expected: 'Search input should scale proportionally at 4K — at least 400px+ wide',
              actual: `Search input is ${inputSize.w}x${inputSize.h}px — too narrow for 4K`,
              fix: 'Use responsive width (e.g., min(600px, 50vw)) for the search input at large viewports.',
              screenshot: ssName('search', 'open')
            });
          }

          // Try searching
          await searchInput.fill('shirt');
          await searchInput.press('Enter');
          await page.waitForTimeout(3000);
          await page.screenshot({ path: path.join(SS_DIR, ssName('search', 'results')), fullPage: false });

          const searchResults = await page.evaluate(() => {
            const results = document.querySelectorAll('[class*="product"], [class*="card"], [class*="result-item"]');
            return { count: results.length };
          });
          if (searchResults.count === 0) {
            addBug({
              title: `Search Returns No Results for "shirt"`,
              severity: 'Medium', category: 'UI Functionality', categoryTags: ['UI Functionality', 'Search'],
              location: `/ on 4K (3840x2160)`,
              description: `Searching for "shirt" returns no visible product results. The search functionality may be broken or the results page layout is not rendering products.`,
              steps: `1. Open ${SITE}/ on 4K\n2. Click search icon\n3. Type "shirt" and press Enter\n4. No product results displayed`,
              expected: 'Search for common term "shirt" should return product results',
              actual: 'No product results visible after search',
              fix: 'Debug search API/component. Verify search results render at all viewport sizes.',
              screenshot: ssName('search', 'results')
            });
          }
        }
      } catch (e) { /* search interaction failed */ }
    }
  }
  await page.close();

  // MOBILE MENU AT 4K CHECK (should NOT show hamburger)
  console.log('\n  ── Responsive Behavior Check ──');
  page = await loadPage('/');
  {
    const menuCheck = await page.evaluate(() => {
      const hamburger = document.querySelector('[class*="hamburger"], [class*="menu-toggle"], [class*="mobile-menu"], button[aria-label*="menu" i]');
      if (!hamburger) return null;
      const rect = hamburger.getBoundingClientRect();
      return { visible: rect.width > 0 && rect.height > 0, w: Math.round(rect.width), h: Math.round(rect.height) };
    });
    if (menuCheck && menuCheck.visible) {
      addBug({
        title: `Hamburger Menu Visible at 4K — Should Show Full Nav`,
        severity: 'High', category: 'UI Alignment', categoryTags: ['UI Alignment', '4K Responsive'],
        location: `/ on 4K (3840x2160)`,
        description: `A hamburger/mobile menu toggle is visible at 4K (3840x2160) — this is a desktop viewport and should show the full navigation, not a collapsed mobile menu.`,
        steps: `1. Open ${SITE}/ on 4K\n2. Look at the header\n3. Hamburger menu icon is visible instead of full nav\n4. This is a mobile pattern incorrectly shown at 4K`,
        expected: 'At 4K resolution, full desktop navigation should be displayed, not a hamburger menu',
        actual: 'Hamburger menu toggle is visible at 3840px viewport — mobile breakpoint incorrectly triggered',
        fix: 'Fix media query breakpoints. Hamburger should only appear below ~1024px. At 3840px, show full desktop nav.',
        screenshot: ssName('home', 'viewport')
      });
    }
  }
  await page.close();

  await browser.close();

  // ==========================================================================
  // GENERATE REPORT
  // ==========================================================================
  const critCount = bugs.filter(b => b.severity === 'Critical').length;
  const highCount = bugs.filter(b => b.severity === 'High').length;
  const medCount = bugs.filter(b => b.severity === 'Medium').length;
  const lowCount = bugs.filter(b => b.severity === 'Low').length;

  console.log(`\n  ╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`  ║  TOTAL: ${bugs.length} BUGS — ${critCount} Critical | ${highCount} High | ${medCount} Medium | ${lowCount} Low`);
  console.log(`  ╚═══════════════════════════════════════════════════════════════╝\n`);

  // Save JSON
  fs.writeFileSync(path.join(__dirname, 'reports', '4k-all-bugs.json'), JSON.stringify(bugs, null, 2));

  // Generate HTML
  const sevColor = s => s === 'Critical' ? '#ef4444' : s === 'High' ? '#f59e0b' : s === 'Medium' ? '#3b82f6' : '#22c55e';
  const sevBg = s => s === 'Critical' ? 'bg-critical' : s === 'High' ? 'bg-high' : s === 'Medium' ? 'bg-medium' : 'bg-low';
  const sevBorder = s => s === 'Critical' ? 'bug-critical' : s === 'High' ? 'bug-high' : s === 'Medium' ? 'bug-medium' : 'bug-low';
  const categories = [...new Set(bugs.map(b => b.category))];
  const pieTotal = bugs.length || 1;
  const critPct = critCount / pieTotal * 100;
  const highPct = highCount / pieTotal * 100;
  const medPct = medCount / pieTotal * 100;
  const lowPct = lowCount / pieTotal * 100;

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>4K Exploratory Bug Report — lamartina.fynd.io</title>
<style>
:root{--bg:#0a0a0f;--bg2:#111827;--bg3:#0d1117;--bg4:#161b22;--bg5:#020617;--border:#1e293b;--text:#e2e8f0;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--radius:12px}
[data-theme="light"]{--bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#e8ecf1;--bg5:#f1f5f9;--border:#d1d5db;--text:#1e293b;--text2:#475569;--text3:#64748b;--accent:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;line-height:1.5}
.sidebar{position:fixed;top:0;left:0;width:230px;height:100vh;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:100;display:flex;flex-direction:column}
.sidebar .logo{padding:20px 20px 16px;font-weight:800;font-size:16px;color:var(--accent);border-bottom:1px solid var(--border)}
.sidebar .logo small{display:block;font-size:10px;color:var(--text3);font-weight:400;margin-top:4px;letter-spacing:.5px;text-transform:uppercase}
.nav-link{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px;color:var(--text2);text-decoration:none;border-left:3px solid transparent;transition:all .2s}
.nav-link:hover{background:var(--bg4);color:var(--text)}
.nav-link.active{background:var(--bg3);color:var(--accent);border-left-color:var(--accent);font-weight:600}
.main{margin-left:230px;flex:1;min-width:0}
.hdr{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 40%,#7c2d12 100%);padding:32px 40px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.hdr h1{font-size:22px;color:#fff;font-weight:700}
.hdr p{color:#fbbf24;font-size:13px;margin-top:6px}
.hdr .site-url{font-size:11px;padding:4px 12px;border-radius:6px;background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3);margin-top:8px;display:inline-block}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbar input{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;width:200px}
.toolbar input::placeholder{color:rgba(255,255,255,.5)}
.toolbar button{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;transition:all .2s;font-weight:500}
.toolbar button:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.ctr{max-width:1400px;margin:0 auto;padding:24px}
.exec-card{background:var(--bg2);border-radius:var(--radius);padding:24px;margin:20px 0;border:1px solid var(--border);display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:center}
.pie-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.pie-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;justify-content:center}
.pie-legend span{display:flex;align-items:center;gap:5px}
.pie-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px}
.stat-item{background:var(--bg3);border-radius:10px;padding:16px 12px;text-align:center;border:1px solid var(--border);transition:transform .2s}
.stat-item:hover{transform:translateY(-2px)}
.stat-item .val{font-size:26px;font-weight:800;line-height:1}
.stat-item .lbl{font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:6px;letter-spacing:.5px}
.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.bg-critical{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.bg-high{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-medium{background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f}
.bg-low{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-info{background:#1e1b4b;color:#a5b4fc;border:1px solid #312e81}
.filters{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.filter-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;transition:all .2s;font-weight:500}
.filter-btn:hover,.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
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
.ftr{text-align:center;padding:32px;color:var(--text3);font-size:11px;border-top:1px solid var(--border);margin-top:24px}
.hidden{display:none!important}
.zoom-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(4px)}
.zoom-overlay img{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
@media print{.sidebar,.toolbar,.filters,.zoom-overlay{display:none!important}.main{margin-left:0!important}.bug-card{break-inside:avoid}}
@media(max-width:900px){.sidebar{transform:translateX(-100%)}.main{margin-left:0}.exec-card{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav class="sidebar">
  <div class="logo">4K Exploratory Report<small>lamartina.fynd.io</small></div>
  <a href="#summary" class="nav-link active">Summary</a>
  <a href="#all-bugs" class="nav-link">All Bugs (${bugs.length})</a>
${categories.map(cat => `  <a href="#cat-${cat.replace(/\s/g,'-')}" class="nav-link">${cat} (${bugs.filter(b=>b.category===cat).length})</a>`).join('\n')}
</nav>
<div class="main">
<div class="hdr">
  <div>
    <h1>4K Exploratory Bug Report <span style="font-size:11px;background:rgba(255,255,255,.2);color:#fff;padding:3px 12px;border-radius:20px;vertical-align:middle;font-weight:500">ALL SEVERITIES</span></h1>
    <p>${new Date().toISOString().split('T')[0]} &middot; ${bugs.length} bugs &middot; ${PAGES_TO_TEST.length} pages &middot; 3840&times;2160 (4K UHD)</p>
    <span class="site-url">lamartina.fynd.io</span>
  </div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="Search bugs..." onkeyup="filterBugs()">
    <button onclick="toggleTheme()">Theme</button>
    <button onclick="window.print()">Print</button>
  </div>
</div>
<div class="ctr">
<div id="summary" class="exec-card">
  <div class="pie-wrap">
    <svg viewBox="0 0 100 100" width="120" height="120" style="transform:rotate(-90deg)">
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="var(--border)" stroke-width="10"/>
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="#ef4444" stroke-width="10" stroke-dasharray="${critPct} ${100-critPct}" stroke-dashoffset="0"/>
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="#f59e0b" stroke-width="10" stroke-dasharray="${highPct} ${100-highPct}" stroke-dashoffset="-${critPct}"/>
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="#3b82f6" stroke-width="10" stroke-dasharray="${medPct} ${100-medPct}" stroke-dashoffset="-${critPct+highPct}"/>
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="#22c55e" stroke-width="10" stroke-dasharray="${lowPct} ${100-lowPct}" stroke-dashoffset="-${critPct+highPct+medPct}"/>
    </svg>
    <div class="pie-legend">
      <span><span class="dot" style="background:#ef4444"></span>${critCount} Critical</span>
      <span><span class="dot" style="background:#f59e0b"></span>${highCount} High</span>
      <span><span class="dot" style="background:#3b82f6"></span>${medCount} Medium</span>
      <span><span class="dot" style="background:#22c55e"></span>${lowCount} Low</span>
    </div>
  </div>
  <div>
    <div class="stat-grid">
      <div class="stat-item"><div class="val" style="color:var(--text)">${bugs.length}</div><div class="lbl">Total Bugs</div></div>
      <div class="stat-item"><div class="val" style="color:#ef4444">${critCount}</div><div class="lbl">Critical</div></div>
      <div class="stat-item"><div class="val" style="color:#f59e0b">${highCount}</div><div class="lbl">High</div></div>
      <div class="stat-item"><div class="val" style="color:#3b82f6">${medCount}</div><div class="lbl">Medium</div></div>
      <div class="stat-item"><div class="val" style="color:#22c55e">${lowCount}</div><div class="lbl">Low</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${PAGES_TO_TEST.length}</div><div class="lbl">Pages Tested</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${categories.length}</div><div class="lbl">Categories</div></div>
    </div>
  </div>
</div>

<div id="all-bugs" style="margin-top:32px">
  <h2 style="font-size:18px;margin-bottom:16px">All Bugs (${bugs.length})</h2>
  <div class="filters">
    <button class="filter-btn active" onclick="filterAll()">All (${bugs.length})</button>
    <button class="filter-btn" onclick="filterSev('Critical')">Critical (${critCount})</button>
    <button class="filter-btn" onclick="filterSev('High')">High (${highCount})</button>
    <button class="filter-btn" onclick="filterSev('Medium')">Medium (${medCount})</button>
    <button class="filter-btn" onclick="filterSev('Low')">Low (${lowCount})</button>
    <span style="color:var(--text3);padding:6px">|</span>
${categories.map(cat => `    <button class="filter-btn" onclick="filterCat('${cat}')">${cat} (${bugs.filter(b=>b.category===cat).length})</button>`).join('\n')}
  </div>

${bugs.map(bug => `
  <div class="bug-card ${sevBorder(bug.severity)}" data-severity="${escHtml(bug.severity)}" data-category="${escHtml(bug.category)}">
    <div class="bug-card-header">
      <h3><span class="badge ${sevBg(bug.severity)}">${escHtml(bug.severity)}</span> ${escHtml(bug.id)} — ${escHtml(bug.title)} <span class="badge" style="background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f;">NEW</span></h3>
    </div>
    <div class="bug-card-body">
      <table class="bug-detail-table">
        <tr><td class="bug-field">Severity</td><td><span class="badge ${sevBg(bug.severity)}">${escHtml(bug.severity)}</span></td></tr>
        <tr><td class="bug-field">Category</td><td>${bug.categoryTags.map(t => `<span class="badge bg-info">${escHtml(t)}</span>`).join(' ')}</td></tr>
        <tr><td class="bug-field">Location</td><td>${escHtml(bug.location)}</td></tr>
        <tr><td class="bug-field">Description</td><td>${escHtml(bug.description)}</td></tr>
        <tr><td class="bug-field">Steps</td><td>${bug.steps.split('\n').map(s => escHtml(s)).join('<br>')}</td></tr>
        <tr><td class="bug-field">Expected</td><td class="pass-text">${escHtml(bug.expected)}</td></tr>
        <tr><td class="bug-field">Actual</td><td class="fail-text">${escHtml(bug.actual)}</td></tr>
        <tr><td class="bug-field">Fix</td><td><code>${escHtml(bug.fix)}</code></td></tr>
      </table>
      <div class="bug-screenshot"><img src="screenshots/${bug.screenshot}" alt="Screenshot: ${escHtml(bug.title)}"><div class="bug-ss-caption">Screenshot: ${escHtml(bug.location)} — ${escHtml(bug.title)}</div></div>
    </div>
  </div>
`).join('')}
</div>

<div class="ftr">4K Exploratory Bug Report &middot; lamartina.fynd.io &middot; ${bugs.length} bugs (${critCount}C/${highCount}H/${medCount}M/${lowCount}L) &middot; ${PAGES_TO_TEST.length} pages &middot; 3840&times;2160 &middot; ${new Date().toISOString().split('T')[0]}</div>
</div>
</div>
<script>
function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'}
function filterBugs(){const q=document.getElementById('searchInput').value.toLowerCase();document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',!c.textContent.toLowerCase().includes(q))})}
function filterAll(){document.querySelectorAll('.bug-card').forEach(c=>c.classList.remove('hidden'));document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
function filterSev(s){document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',c.dataset.severity!==s)});document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
function filterCat(cat){document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',c.dataset.category!==cat)});document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
document.addEventListener('click',e=>{if(e.target.tagName==='IMG'&&e.target.closest('.bug-screenshot')){const o=document.createElement('div');o.className='zoom-overlay';o.innerHTML='<img src="'+e.target.src+'">';o.onclick=()=>o.remove();document.body.appendChild(o)}});
document.querySelectorAll('.nav-link').forEach(a=>{a.addEventListener('click',()=>{document.querySelectorAll('.nav-link').forEach(n=>n.classList.remove('active'));a.classList.add('active')})});
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(__dirname, 'reports', '4k-all-bugs.html'), html);
  console.log(`\n  Report: reports/4k-all-bugs.html`);
  console.log(`  JSON:   reports/4k-all-bugs.json`);
  console.log(`  Screenshots: reports/screenshots/\n`);
})();
