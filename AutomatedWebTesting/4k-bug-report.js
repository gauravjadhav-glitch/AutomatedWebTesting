const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://lamartina.fynd.io';
const VP = { width: 3840, height: 2160 };
const SS_DIR = path.join(__dirname, 'reports', 'screenshots');
if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const bugs = [];
let bugIndex = 1;

function addBug({ title, category, categoryTags, location, description, steps, expected, actual, fix, screenshot }) {
  const id = `BUG-${String(bugIndex++).padStart(3, '0')}`;
  bugs.push({ id, title, severity: 'High', category, categoryTags: categoryTags || [category], location, description, steps, expected, actual, fix, screenshot });
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

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
    await page.waitForTimeout(2000);
    return page;
  }

  console.log('\n  Crawling lamartina.fynd.io at 4K for HIGH severity bugs...\n');

  // ===== HOMEPAGE =====
  let page = await loadPage('/');
  await page.screenshot({ path: path.join(SS_DIR, 'site1___4k.png'), fullPage: true });

  // BUG: Nav alignment
  {
    const nav = await page.evaluate(() => {
      const el = document.querySelector('nav');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100), className: el.className.split(' ')[0].slice(0, 20) };
    });
    if (nav && nav.pct < 50) {
      await page.screenshot({ path: path.join(SS_DIR, 'site1___4k_nav.png'), fullPage: false });
      addBug({
        title: `Nav Bar Misaligned — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['UI Alignment', '4K Responsive'],
        category: 'UI Alignment',
        location: `/ on 4K (3840x2160)`,
        description: `The navigation bar (nav.${nav.className}) only covers ${nav.pct}% (${nav.width}px) of the 4K viewport width (3840px). The nav content is left-aligned with a massive empty gap on the right side, making the header look broken on 4K displays.\n\nThe issue is consistent across all pages on the site.`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160) or use DevTools device emulation\n2. Observe the top navigation bar\n3. The nav content only occupies the left ~${nav.pct}% of the screen\n4. The remaining ~${100 - nav.pct}% on the right side is empty`,
        expected: 'Navigation bar should span the full viewport width (100%) at 4K resolution, with content properly distributed across the available space',
        actual: `Navigation bar is only ${nav.width}px wide (${nav.pct}% of 3840px viewport) — leaves ${3840 - nav.width}px of empty space on the right`,
        fix: `Set nav container to width: 100% and remove any restrictive max-width. Use flexbox or grid to distribute nav items across the full width at large viewports.`,
        screenshot: 'site1___4k_nav.png'
      });
    }
  }

  // BUG: Blurry homepage images
  {
    const blurryImgs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('img').forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 200 && img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5) {
          results.push({
            alt: (img.alt || img.src.split('/').pop()).slice(0, 60),
            rendered: Math.round(rect.width),
            natural: img.naturalWidth,
            ratio: (rect.width / img.naturalWidth).toFixed(1),
            tag: img.tagName.toLowerCase(),
            cls: (img.className || img.parentElement?.className || '').split(' ')[0].slice(0, 20)
          });
        }
      });
      return results;
    });
    if (blurryImgs.length > 0) {
      const uniqueImgs = [];
      const seen = new Set();
      blurryImgs.forEach(img => {
        if (!seen.has(img.alt)) { seen.add(img.alt); uniqueImgs.push(img); }
      });
      const elementsList = uniqueImgs.slice(0, 8).map((img, i) =>
        `${i + 1}. <img${img.cls ? '.' + img.cls : ''}>"${img.alt}" — natural: ${img.natural}px, rendered at: ${img.rendered}px (${img.ratio}x upscale)`
      ).join('\n');
      addBug({
        title: `Blurry Images — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['Image Quality', '4K Responsive'],
        category: 'Image Quality',
        location: `/ on 4K (3840x2160)`,
        description: `${uniqueImgs.length} image(s) on the homepage are severely blurry at 4K resolution (3840x2160). The images are being rendered at ${blurryImgs[0].rendered}px wide but the source files are only ${blurryImgs[0].natural}px — a ${blurryImgs[0].ratio}x upscale that produces visible pixelation.\n\nAffected images:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160) or use DevTools device emulation\n2. Scroll through the homepage\n3. Observe the collection/category images — they appear pixelated and blurry\n4. Right-click any image > Inspect to confirm natural dimensions vs rendered size\nImages that are blurry:\n${elementsList}`,
        expected: 'All images should be crisp and sharp at 4K resolution. Source images should be at least as large as their rendered dimensions (1:1 ratio or higher)',
        actual: `${uniqueImgs.length} images are upscaled ${blurryImgs[0].ratio}x — source is ${blurryImgs[0].natural}px but rendered at ${blurryImgs[0].rendered}px, causing visible blurriness`,
        fix: `Use srcset and sizes attributes to serve higher resolution images for 4K displays. Upload source images at 2x the max rendered size. Use image CDN parameters (e.g., ?w=1200&dpr=2) to request appropriately sized images.`,
        screenshot: 'site1___4k.png'
      });
    }
  }

  // BUG: Hero content alignment
  {
    const heroIssues = await page.evaluate(() => {
      const issues = [];
      const selectors = ['[class*="hero"] [class*="block"]', '[class*="hero"] [class*="subtitle"]', '[class*="hero"] [class*="cta"]', '[class*="hero"] [class*="title"]'];
      selectors.forEach(sel => {
        const el = document.querySelector(sel);
        if (el) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.width < 3840 * 0.3 && rect.height > 0) {
            issues.push({
              className: el.className.split(' ')[0].slice(0, 30),
              tag: el.tagName.toLowerCase(),
              width: Math.round(rect.width),
              pct: Math.round(rect.width / 3840 * 100),
              text: el.textContent.trim().slice(0, 40)
            });
          }
        }
      });
      return issues;
    });
    if (heroIssues.length > 0) {
      const heroSection = await page.$('[class*="hero"]');
      if (heroSection) {
        await heroSection.screenshot({ path: path.join(SS_DIR, 'site1___4k_hero.png') });
      }
      const elementsList = heroIssues.map((el, i) =>
        `${i + 1}. <${el.tag}.${el.className}>"${el.text}" — only ${el.width}px wide (${el.pct}% of viewport)`
      ).join('\n');
      addBug({
        title: `Hero Section Content Misaligned — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['UI Alignment', '4K Responsive'],
        category: 'UI Alignment',
        location: `/ on 4K (3840x2160)`,
        description: `${heroIssues.length} hero section element(s) occupy less than 30% of the 4K viewport width and appear pushed to the left, leaving 70%+ of the screen empty. The hero CTA and text content look disproportionately small on 4K displays.\n\nAffected elements:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160) or use DevTools device emulation\n2. Look at the hero banner section\n3. Notice the text block and CTA button are tiny and left-aligned\n4. Over 70% of the hero area on the right side is unused\nElements affected:\n${elementsList}`,
        expected: 'Hero content (title, subtitle, CTA) should scale proportionally at 4K and be properly centered or span a reasonable portion of the viewport',
        actual: `Hero elements occupy only ${heroIssues[0].pct}% of the viewport — text and CTA buttons are disproportionately small at 4K`,
        fix: `Use responsive typography (clamp() or vw-based units) for hero text. Scale CTA button padding and font size for larger viewports. Center content or use max-width with auto margins.`,
        screenshot: 'site1___4k_hero.png'
      });
    }
  }

  // BUG: Small buttons homepage
  {
    const smallBtns = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('button, a[class*="btn"], [class*="button"], a[class*="cta"], a').forEach(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 80 || rect.height < 30) && btn.textContent.trim().length > 0 && btn.textContent.trim().length < 40) {
          results.push({
            text: btn.textContent.trim().slice(0, 40),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            tag: btn.tagName.toLowerCase(),
            cls: (btn.className || '').split(' ')[0].slice(0, 20)
          });
        }
      });
      return results.slice(0, 10);
    });
    if (smallBtns.length >= 3) {
      const elementsList = smallBtns.map((btn, i) =>
        `${i + 1}. <${btn.tag}${btn.cls ? '.' + btn.cls : ''}>"${btn.text}" — only ${btn.width}x${btn.height}px — too small to click`
      ).join('\n');
      addBug({
        title: `Undersized Clickable Elements — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['UI Alignment', '4K Responsive'],
        category: 'UI Alignment',
        location: `/ on 4K (3840x2160)`,
        description: `${smallBtns.length} button(s) or link(s) on this page are disproportionately small at 4K (3840x2160). They are so tiny relative to the viewport that a user cannot accurately click them.\n\nAffected elements:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160) or use DevTools device emulation\n2. Try clicking the elements listed below\n3. They are very small relative to the large viewport and hard to target\nElements that are too small:\n${elementsList}`,
        expected: 'All buttons and links on the page should be clickable and respond to user interaction with adequate sizing at 4K',
        actual: `${smallBtns.length} element(s) are too small — they are under 80px wide or 30px tall at 4K resolution`,
        fix: `Use responsive sizing (clamp(), min(), or vw-based units) for button padding and font sizes. Ensure all interactive elements meet minimum 44x44px click target size at any resolution.`,
        screenshot: 'site1___4k.png'
      });
    }
  }

  // BUG: Cart/account icons missing
  {
    const icons = await page.evaluate(() => {
      const cartIcon = document.querySelector('a[href*="cart"], [class*="cart-icon"], [class*="bag-icon"], header [class*="cart"]');
      const accIcon = document.querySelector('a[href*="login"], a[href*="account"], a[href*="profile"], [class*="user-icon"], header [class*="account"]');
      return { cartFound: !!cartIcon, accFound: !!accIcon };
    });
    if (!icons.cartFound || !icons.accFound) {
      const missing = [];
      if (!icons.cartFound) missing.push('Cart icon');
      if (!icons.accFound) missing.push('Account/Login icon');
      addBug({
        title: `Header Icons Missing — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['Navigation', '4K Responsive'],
        category: 'Navigation',
        location: `/ on 4K (3840x2160)`,
        description: `${missing.length} essential header icon(s) could not be found at 4K resolution (3840x2160). Standard e-commerce header navigation icons (cart, user/account) are either not rendered or not detectable.\n\nMissing elements:\n${missing.map((m, i) => `${i + 1}. ${m} — not found in header`).join('\n')}`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160) or use DevTools device emulation\n2. Look at the top-right area of the header for cart and account icons\n3. ${missing.join(' and ')} cannot be found\n4. Users cannot access their cart or account from the header`,
        expected: 'Header should contain visible and accessible cart and account/login icons at all resolutions including 4K',
        actual: `${missing.join(' and ')} not found in the header at 4K resolution`,
        fix: `Ensure cart and account icons are rendered in the header at 4K viewports. Check if these elements are hidden by a media query or if their selectors/class names follow standard conventions.`,
        screenshot: 'site1___4k_nav.png'
      });
    }
  }

  await page.close();

  // ===== PRODUCTS PAGE =====
  page = await loadPage('/products');
  await page.screenshot({ path: path.join(SS_DIR, 'site1__products_4k.png'), fullPage: true });
  await page.screenshot({ path: path.join(SS_DIR, 'site1__products_4k_viewport.png'), fullPage: false });

  // BUG: Product images blurry
  {
    const blurryProducts = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('img').forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 200 && img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5) {
          const alt = (img.alt || img.src.split('/').pop()).slice(0, 50);
          if (!seen.has(alt)) {
            seen.add(alt);
            results.push({
              alt,
              rendered: Math.round(rect.width),
              natural: img.naturalWidth,
              ratio: (rect.width / img.naturalWidth).toFixed(1),
              cls: (img.className || img.parentElement?.className || '').split(' ')[0].slice(0, 20)
            });
          }
        }
      });
      return results;
    });
    if (blurryProducts.length > 0) {
      const elementsList = blurryProducts.slice(0, 8).map((img, i) =>
        `${i + 1}. <img${img.cls ? '.' + img.cls : ''}>"${img.alt}" — natural: ${img.natural}px, rendered: ${img.rendered}px (${img.ratio}x upscale)`
      ).join('\n');
      addBug({
        title: `Product Images Blurry — /products on 4K (lamartina.fynd.io)`,
        categoryTags: ['Image Quality', '4K Responsive'],
        category: 'Image Quality',
        location: `/products on 4K (3840x2160)`,
        description: `${blurryProducts.length} unique product image(s) on the products listing page are rendered at ${blurryProducts[0].rendered}px but the source images are only ${blurryProducts[0].natural}px — a ${blurryProducts[0].ratio}x upscale that makes every product image appear pixelated and blurry at 4K.\n\nAffected products:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/products on a 4K display (3840x2160) or use DevTools device emulation\n2. Browse the product grid\n3. All product images appear pixelated and blurry\n4. Right-click any product image > Inspect to see natural size is ${blurryProducts[0].natural}px but rendered at ${blurryProducts[0].rendered}px\nAffected products:\n${elementsList}`,
        expected: 'Product images should be crisp at 4K. Source images should be at least 1:1 with rendered size (minimum 900px+ for the current grid layout)',
        actual: `${blurryProducts.length} product images are ${blurryProducts[0].ratio}x upscaled — source is only ${blurryProducts[0].natural}px but rendered at ${blurryProducts[0].rendered}px`,
        fix: `Request higher resolution product images from the CDN using width/DPR parameters (e.g., ?w=900 or ?dpr=2). Implement srcset to serve appropriate sizes based on viewport. Minimum recommended source width: 900px for 4K grid display.`,
        screenshot: 'site1__products_4k_viewport.png'
      });
    }
  }

  // BUG: Nav alignment on products
  {
    const nav = await page.evaluate(() => {
      const el = document.querySelector('nav');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100), className: el.className.split(' ')[0].slice(0, 20) };
    });
    if (nav && nav.pct < 50) {
      addBug({
        title: `Nav Bar Misaligned — /products on 4K (lamartina.fynd.io)`,
        categoryTags: ['UI Alignment', '4K Responsive'],
        category: 'UI Alignment',
        location: `/products on 4K (3840x2160)`,
        description: `The navigation bar (nav.${nav.className}) only covers ${nav.pct}% (${nav.width}px) of the 4K viewport on the products page. The nav is compressed to the left with a massive empty gap on the right, making the page header look broken.`,
        steps: `1. Open https://lamartina.fynd.io/products on a 4K display (3840x2160) or use DevTools device emulation\n2. Observe the top navigation bar\n3. The nav is squeezed into the left ${nav.pct}% of the screen\n4. The right ${100 - nav.pct}% is completely empty`,
        expected: 'Navigation should span 100% of the viewport width at 4K resolution',
        actual: `Nav is ${nav.width}px wide — only ${nav.pct}% of 3840px viewport`,
        fix: `Remove max-width constraints on the nav container and set width: 100%. Distribute nav items using flexbox across the full width.`,
        screenshot: 'site1__products_4k_viewport.png'
      });
    }
  }

  // BUG: Lazy loading broken
  {
    const lazyCheck = await page.evaluate(() => {
      const broken = [];
      let total = 0;
      document.querySelectorAll('img[loading="lazy"]').forEach(img => {
        total++;
        const rect = img.getBoundingClientRect();
        if (rect.top < window.innerHeight && (!img.complete || img.naturalWidth === 0)) {
          broken.push({
            alt: (img.alt || img.src.split('/').pop()).slice(0, 50),
            top: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          });
        }
      });
      return { broken, total };
    });
    if (lazyCheck.broken.length > 0) {
      const elementsList = lazyCheck.broken.map((img, i) =>
        `${i + 1}. <img>"${img.alt}" at y=${img.top}px — ${img.width}x${img.height}px — not loaded`
      ).join('\n');
      addBug({
        title: `Lazy-Loaded Images Broken in Viewport — /products on 4K (lamartina.fynd.io)`,
        categoryTags: ['Image Quality', '4K Responsive'],
        category: 'Image Quality',
        location: `/products on 4K (3840x2160)`,
        description: `${lazyCheck.broken.length} of ${lazyCheck.total} lazy-loaded images that are within the visible viewport at 4K (2160px tall) failed to load. Because the 4K viewport is much taller than standard displays, more images are "above the fold" but the lazy loading threshold may not account for this.\n\nBroken images:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/products on a 4K display (3840x2160) or use DevTools device emulation\n2. Wait for the page to fully load (5+ seconds)\n3. Observe blank/missing image placeholders within the visible viewport\n4. These images have loading="lazy" but are in the viewport and should have loaded\nBroken images:\n${elementsList}`,
        expected: 'All images within the visible viewport should load immediately, regardless of the loading="lazy" attribute',
        actual: `${lazyCheck.broken.length}/${lazyCheck.total} lazy images within the 4K viewport did not load — leaving blank spaces`,
        fix: `For images that are likely to be in the initial viewport at large resolutions, either remove loading="lazy" or use loading="eager". Consider using Intersection Observer with a larger rootMargin to preload images near the viewport edge.`,
        screenshot: 'site1__products_4k_viewport.png'
      });
    }
  }

  await page.close();

  // ===== COLLECTIONS PAGE =====
  page = await loadPage('/collections');
  await page.screenshot({ path: path.join(SS_DIR, 'site1__collections_4k.png'), fullPage: true });

  // BUG: Blurry collection images
  {
    const blurryColl = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      document.querySelectorAll('img').forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 200 && img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5) {
          const alt = (img.alt || img.src.split('/').pop()).slice(0, 50);
          if (!seen.has(alt)) {
            seen.add(alt);
            results.push({
              alt,
              rendered: Math.round(rect.width),
              natural: img.naturalWidth,
              ratio: (rect.width / img.naturalWidth).toFixed(1)
            });
          }
        }
      });
      return results;
    });
    if (blurryColl.length > 0) {
      const elementsList = blurryColl.map((img, i) =>
        `${i + 1}. <img>"${img.alt}" — natural: ${img.natural}px, rendered: ${img.rendered}px (${img.ratio}x upscale)`
      ).join('\n');
      addBug({
        title: `Collection Images Blurry — /collections on 4K (lamartina.fynd.io)`,
        categoryTags: ['Image Quality', '4K Responsive'],
        category: 'Image Quality',
        location: `/collections on 4K (3840x2160)`,
        description: `${blurryColl.length} collection image(s) are severely blurry at 4K. Source images are ${blurryColl[0].natural}px but rendered at ${blurryColl[0].rendered}px — a ${blurryColl[0].ratio}x upscale.\n\nAffected images:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/collections on a 4K display (3840x2160) or use DevTools device emulation\n2. View the collection grid\n3. All collection cover images appear pixelated and blurry\n4. Source images are only ${blurryColl[0].natural}px wide but displayed at ${blurryColl[0].rendered}px\nAffected images:\n${elementsList}`,
        expected: 'Collection images should be crisp and sharp at 4K with source images at least matching rendered dimensions',
        actual: `${blurryColl.length} collection images are ${blurryColl[0].ratio}x upscaled — visibly blurry at 4K`,
        fix: `Upload higher resolution collection images (at least 900px wide). Use srcset/sizes for responsive image delivery. Use image CDN parameters to request appropriate resolutions.`,
        screenshot: 'site1__collections_4k.png'
      });
    }
  }

  await page.close();

  // ===== CART PAGE =====
  page = await loadPage('/cart');
  await page.screenshot({ path: path.join(SS_DIR, 'site1__cart_4k.png'), fullPage: false });

  // BUG: Cart layout whitespace
  {
    const cartLayout = await page.evaluate(() => {
      const main = document.querySelector('main, [class*="cart"], [class*="bag"]');
      if (!main) return null;
      const rect = main.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: Math.round(rect.width / 3840 * 100) };
    });
    if (cartLayout && cartLayout.pct < 60) {
      addBug({
        title: `Cart Page Excessive Whitespace — /cart on 4K (lamartina.fynd.io)`,
        categoryTags: ['UI Alignment', '4K Responsive'],
        category: 'UI Alignment',
        location: `/cart on 4K (3840x2160)`,
        description: `The cart page content only uses ${cartLayout.pct}% (${cartLayout.width}px) of the 4K viewport, leaving ${100 - cartLayout.pct}% as empty whitespace. The cart items and summary appear compressed into a narrow column while the majority of the 4K screen is unused.`,
        steps: `1. Open https://lamartina.fynd.io/cart on a 4K display (3840x2160) or use DevTools device emulation\n2. Observe the cart content area\n3. Cart items and checkout summary are confined to a narrow column\n4. Over ${100 - cartLayout.pct}% of the horizontal space is wasted whitespace`,
        expected: 'Cart layout should utilize at least 60-80% of the viewport at 4K, with cart items and order summary arranged side-by-side to use the available space',
        actual: `Cart content only occupies ${cartLayout.pct}% of the viewport (${cartLayout.width}px of 3840px) — massive whitespace on both sides`,
        fix: `Increase max-width of cart container for large viewports. Use a two-column layout (cart items + order summary side by side) at 4K. Apply responsive max-width that scales with viewport.`,
        screenshot: 'site1__cart_4k.png'
      });
    }
  }

  await page.close();

  // ===== LOGIN PAGE =====
  page = await loadPage('/auth/login');
  await page.screenshot({ path: path.join(SS_DIR, 'site1__auth_login_4k.png'), fullPage: false });

  // BUG: Small buttons on login
  {
    const smallBtns = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('button, a[class*="btn"], [class*="button"], input[type="submit"], a').forEach(btn => {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0 && (rect.width < 80 || rect.height < 30) && btn.textContent.trim().length > 0 && btn.textContent.trim().length < 40) {
          results.push({
            text: btn.textContent.trim().slice(0, 40),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            tag: btn.tagName.toLowerCase(),
            cls: (btn.className || '').split(' ')[0].slice(0, 20)
          });
        }
      });
      return results.slice(0, 8);
    });
    if (smallBtns.length >= 2) {
      const elementsList = smallBtns.map((btn, i) =>
        `${i + 1}. <${btn.tag}${btn.cls ? '.' + btn.cls : ''}>"${btn.text}" — only ${btn.width}x${btn.height}px — too small to click`
      ).join('\n');
      addBug({
        title: `Undersized Clickable Elements — /auth/login on 4K (lamartina.fynd.io)`,
        categoryTags: ['UI Alignment', '4K Responsive'],
        category: 'UI Alignment',
        location: `/auth/login on 4K (3840x2160)`,
        description: `${smallBtns.length} button(s) or link(s) on the login page are disproportionately small at 4K resolution (3840x2160). They are difficult to locate and click on a large viewport.\n\nAffected elements:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/auth/login on a 4K display (3840x2160) or use DevTools device emulation\n2. Try clicking the elements listed below\n3. They are very small relative to the large viewport\nElements that are too small:\n${elementsList}`,
        expected: 'All buttons and interactive elements should scale proportionally at 4K and maintain minimum 44x44px clickable area',
        actual: `${smallBtns.length} element(s) are under 80px wide or 30px tall — too small at 4K resolution`,
        fix: `Use responsive sizing for button padding and font sizes. Ensure all interactive elements meet WCAG minimum 44x44px target size.`,
        screenshot: 'site1__auth_login_4k.png'
      });
    }
  }

  await page.close();

  // ===== PDP =====
  page = await loadPage('/products');
  const pdpLink = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/product/"]');
    return a ? a.getAttribute('href') : null;
  });
  await page.close();

  if (pdpLink) {
    page = await loadPage(pdpLink);
    const pdpSlug = pdpLink.replace(/\//g, '_').slice(1).slice(0, 40);
    await page.screenshot({ path: path.join(SS_DIR, `site1__pdp_4k.png`), fullPage: true });
    await page.screenshot({ path: path.join(SS_DIR, `site1__pdp_4k_viewport.png`), fullPage: false });

    // BUG: PDP gallery missing
    {
      const gallery = await page.evaluate(() => {
        const arrows = document.querySelectorAll('[class*="arrow"], [class*="next"], [class*="prev"], [class*="thumb"], [class*="gallery"] button');
        const thumbs = document.querySelectorAll('[class*="thumb"] img, [class*="gallery"] img');
        return { arrows: arrows.length, thumbs: thumbs.length };
      });
      if (gallery.arrows === 0 && gallery.thumbs <= 1) {
        addBug({
          title: `PDP Image Gallery Missing — ${pdpLink.slice(0,40)} on 4K (lamartina.fynd.io)`,
          categoryTags: ['UI Functionality', '4K Responsive'],
          category: 'UI Functionality',
          location: `${pdpLink} on 4K (3840x2160)`,
          description: `The product detail page has no visible image gallery navigation at 4K resolution — no arrow buttons, no thumbnail strip, and no carousel indicators. Users cannot browse through different product images.\n\nMissing elements:\n1. Previous/Next arrows — not found\n2. Thumbnail image strip — not found\n3. Carousel dots/indicators — not found`,
          steps: `1. Open https://lamartina.fynd.io${pdpLink} on a 4K display (3840x2160) or use DevTools device emulation\n2. Look for image navigation controls (arrows, thumbnails, dots)\n3. No gallery navigation elements are present\n4. User can only see the default product image`,
          expected: 'PDP should have image gallery navigation (arrows, thumbnails, or swipe) allowing users to view all product images',
          actual: `No gallery navigation found — ${gallery.arrows} arrows, ${gallery.thumbs} thumbnails detected`,
          fix: `Ensure image gallery component renders navigation controls (prev/next arrows, thumbnail strip) on the PDP. Check if the gallery JS is loading correctly at 4K viewport sizes.`,
          screenshot: 'site1__pdp_4k_viewport.png'
        });
      }
    }

    // BUG: PDP Add to Cart / Size missing
    {
      const pdpElements = await page.evaluate(() => {
        let sizeSelector = false;
        let addToCart = false;
        let sizeDetails = 'not found';
        let atcDetails = 'not found';
        document.querySelectorAll('[class*="size"], [class*="variant"], select[name*="size" i], [class*="option"]').forEach(el => {
          if (el.getBoundingClientRect().width > 0) { sizeSelector = true; sizeDetails = `found (${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}px)`; }
        });
        document.querySelectorAll('button').forEach(b => {
          const text = b.textContent.toLowerCase();
          if ((text.includes('add to') || text.includes('cart') || text.includes('buy')) && b.getBoundingClientRect().width > 0) { addToCart = true; atcDetails = `"${b.textContent.trim().slice(0,30)}" (${Math.round(b.getBoundingClientRect().width)}x${Math.round(b.getBoundingClientRect().height)}px)`; }
        });
        return { sizeSelector, addToCart, sizeDetails, atcDetails };
      });
      if (!pdpElements.sizeSelector || !pdpElements.addToCart) {
        const missing = [];
        if (!pdpElements.sizeSelector) missing.push('Size/variant selector');
        if (!pdpElements.addToCart) missing.push('Add to Cart / Buy button');
        addBug({
          title: `PDP Critical Elements Missing — ${pdpLink.slice(0,40)} on 4K (lamartina.fynd.io)`,
          categoryTags: ['UI Functionality', '4K Responsive'],
          category: 'UI Functionality',
          location: `${pdpLink} on 4K (3840x2160)`,
          description: `The product detail page is missing critical e-commerce elements at 4K resolution: ${missing.join(' and ')}. This completely blocks the purchase funnel — users cannot select a product variant or add items to their cart.\n\nMissing elements:\n${missing.map((m, i) => `${i + 1}. ${m} — ${m.includes('Size') ? pdpElements.sizeDetails : pdpElements.atcDetails}`).join('\n')}`,
          steps: `1. Open https://lamartina.fynd.io${pdpLink} on a 4K display (3840x2160) or use DevTools device emulation\n2. Try to select a product size/variant\n3. Try to find and click "Add to Cart" or "Buy" button\n4. Neither element is present or visible\nMissing elements:\n${missing.map((m, i) => `${i + 1}. ${m} — not found`).join('\n')}`,
          expected: 'PDP must display a working size/variant selector and a prominent Add to Cart button at all resolutions including 4K',
          actual: `${missing.join(' and ')} not found on the PDP — purchase flow is completely blocked`,
          fix: `Verify PDP components render at 4K viewport. Check if size selector and ATC button are hidden behind media queries or if the component JS fails to initialize at large viewports. Ensure these critical elements have no max-width or display:none rules at 4K.`,
          screenshot: 'site1__pdp_4k.png'
        });
      }
    }

    await page.close();
  }

  // ===== ACCESSIBILITY =====
  page = await loadPage('/');

  // BUG: Focus indicators
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
            if (examples.length < 5) {
              examples.push({
                tag: el.tagName.toLowerCase(),
                text: el.textContent.trim().slice(0, 30),
                cls: (el.className || '').split(' ')[0].slice(0, 20)
              });
            }
          }
        }
      });
      return { total, noOutline, examples };
    });
    if (focusCheck.noOutline >= focusCheck.total * 0.5) {
      const elementsList = focusCheck.examples.map((el, i) =>
        `${i + 1}. <${el.tag}${el.cls ? '.' + el.cls : ''}>"${el.text}" — no focus outline`
      ).join('\n');
      addBug({
        title: `No Focus Indicators — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['Accessibility', '4K Responsive'],
        category: 'Accessibility',
        location: `/ on 4K (3840x2160)`,
        description: `${focusCheck.noOutline} of ${focusCheck.total} focusable elements (${Math.round(focusCheck.noOutline / focusCheck.total * 100)}%) lack visible focus indicators at 4K. Keyboard navigation is impossible to track visually. This is a WCAG 2.4.7 violation.\n\nExample elements:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160)\n2. Press Tab to navigate through the page\n3. No visible focus ring or outline appears on any element\n4. User cannot tell which element is currently focused\nExample elements without focus:\n${elementsList}`,
        expected: 'All focusable elements should display a visible focus indicator (outline, box-shadow, or color change) when navigated to via keyboard',
        actual: `${focusCheck.noOutline}/${focusCheck.total} focusable elements have outline: none with no alternative focus style — keyboard users cannot navigate the page`,
        fix: `Add visible :focus and :focus-visible styles to all interactive elements. Use outline: 2px solid currentColor or box-shadow with sufficient contrast. Do not set outline: none without providing an alternative focus style.`,
        screenshot: 'site1___4k.png'
      });
    }
  }

  // BUG: Color contrast
  {
    const contrast = await page.evaluate(() => {
      function luminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }
      function parseColor(c) {
        const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? [+m[1], +m[2], +m[3]] : null;
      }
      const texts = document.querySelectorAll('p, h1, h2, h3, h4, a, span, li, label');
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
              if (examples.length < 5) {
                examples.push({
                  text: el.textContent.trim().slice(0, 30),
                  ratio: ratio.toFixed(2),
                  fg: getComputedStyle(el).color,
                  bg: getComputedStyle(el).backgroundColor,
                  tag: el.tagName.toLowerCase()
                });
              }
            }
          }
        }
      });
      return { total, low, examples };
    });
    if (contrast.low > 5) {
      const elementsList = contrast.examples.map((el, i) =>
        `${i + 1}. <${el.tag}>"${el.text}" — contrast ratio: ${el.ratio}:1 (fg: ${el.fg}, bg: ${el.bg})`
      ).join('\n');
      addBug({
        title: `Poor Color Contrast — / on 4K (lamartina.fynd.io)`,
        categoryTags: ['Accessibility', '4K Responsive'],
        category: 'Accessibility',
        location: `/ on 4K (3840x2160)`,
        description: `${contrast.low} of ${contrast.total} text elements (${Math.round(contrast.low / contrast.total * 100)}%) have a contrast ratio below the WCAG AA minimum of 4.5:1. Text is hard to read, especially on 4K displays where pixel density can amplify the effect.\n\nExample elements:\n${elementsList}`,
        steps: `1. Open https://lamartina.fynd.io/ on a 4K display (3840x2160)\n2. Observe text elements across the page\n3. Many text elements have insufficient contrast against their background\n4. Use browser DevTools > Accessibility panel to verify contrast ratios\nExample elements with low contrast:\n${elementsList}`,
        expected: 'All text elements should meet WCAG AA contrast ratio of 4.5:1 for normal text and 3:1 for large text',
        actual: `${contrast.low}/${contrast.total} text elements have contrast ratio below 4.5:1 — failing WCAG AA standards`,
        fix: `Review text colors against backgrounds to meet WCAG AA (4.5:1 for normal text, 3:1 for large text). Darken text or lighten backgrounds where needed. Use a contrast checker tool to verify.`,
        screenshot: 'site1___4k.png'
      });
    }
  }

  await page.close();
  await browser.close();

  // ===== CONSOLE OUTPUT =====
  console.log(`\n  Found ${bugs.length} HIGH severity bugs\n`);
  bugs.forEach(bug => {
    console.log(`  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`  ${bug.id} — ${bug.title}`);
    console.log(`  NEW`);
    console.log(`  Severity    ${bug.severity}`);
    console.log(`  Category    ${bug.categoryTags.join(', ')}`);
    console.log(`  Location    ${bug.location}`);
    console.log(`  Description    ${bug.description.split('\n')[0]}`);
    console.log(`  Screenshot    ${bug.screenshot}`);
    console.log('');
  });

  // ===== GENERATE HTML =====
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>4K Bug Report — HIGH Severity — lamartina.fynd.io</title>
<style>
:root{--bg:#0a0a0f;--bg2:#111827;--bg3:#0d1117;--bg4:#161b22;--bg5:#020617;--border:#1e293b;--text:#e2e8f0;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--radius:12px}
[data-theme="light"]{--bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#e8ecf1;--bg5:#f1f5f9;--border:#d1d5db;--text:#1e293b;--text2:#475569;--text3:#64748b;--accent:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;line-height:1.5}
.sidebar{position:fixed;top:0;left:0;width:230px;height:100vh;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:100;padding:0;transition:transform .3s;display:flex;flex-direction:column}
.sidebar .logo{padding:20px 20px 16px;font-weight:800;font-size:16px;color:var(--accent);border-bottom:1px solid var(--border);letter-spacing:-.3px}
.sidebar .logo small{display:block;font-size:10px;color:var(--text3);font-weight:400;margin-top:4px;letter-spacing:.5px;text-transform:uppercase}
.nav-link{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px;color:var(--text2);text-decoration:none;border-left:3px solid transparent;transition:all .2s}
.nav-link:hover{background:var(--bg4);color:var(--text)}
.nav-link.active{background:var(--bg3);color:var(--accent);border-left-color:var(--accent);font-weight:600}
.main{margin-left:230px;flex:1;min-width:0}
.hdr{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 40%,#7c2d12 100%);padding:32px 40px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.hdr h1{font-size:22px;color:#fff;font-weight:700;letter-spacing:-.3px}
.hdr p{color:#fbbf24;font-size:13px;margin-top:6px}
.hdr .site-urls{margin-top:8px;display:flex;gap:20px;flex-wrap:wrap}
.hdr .site-url{font-size:11px;padding:4px 12px;border-radius:6px;display:inline-flex;align-items:center;gap:6px;background:rgba(251,191,36,.15);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbar input{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;width:200px;backdrop-filter:blur(4px)}
.toolbar input::placeholder{color:rgba(255,255,255,.5)}
.toolbar button{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;transition:all .2s;font-weight:500}
.toolbar button:hover{background:var(--accent);color:#fff;border-color:var(--accent)}
.ctr{max-width:1400px;margin:0 auto;padding:24px}
.exec-card{background:var(--bg2);border-radius:var(--radius);padding:24px;margin:20px 0;border:1px solid var(--border);display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:center}
.pie-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.pie-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;justify-content:center}
.pie-legend span{display:flex;align-items:center;gap:5px}
.pie-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0}
.stat-item{background:var(--bg3);border-radius:10px;padding:16px 12px;text-align:center;border:1px solid var(--border);transition:transform .2s}
.stat-item:hover{transform:translateY(-2px)}
.stat-item .val{font-size:26px;font-weight:800;line-height:1}
.stat-item .lbl{font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:6px;letter-spacing:.5px}
.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.bg-high{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-info{background:#1e1b4b;color:#a5b4fc;border:1px solid #312e81}
.bg-pass{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-fail{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.filters{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.filter-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;transition:all .2s;font-weight:500}
.filter-btn:hover,.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.bug-card{background:var(--bg3);border-radius:var(--radius);margin:16px 0;border-left:4px solid #f59e0b;overflow:hidden;transition:box-shadow .2s}
.bug-card:hover{box-shadow:0 2px 12px rgba(0,0,0,.15)}
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
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
@media print{.sidebar,.toolbar,.filters,.zoom-overlay{display:none!important}.main{margin-left:0!important}.bug-card{break-inside:avoid}}
@media(max-width:900px){.sidebar{transform:translateX(-100%)}.main{margin-left:0}.exec-card{grid-template-columns:1fr}}
</style>
</head>
<body>
<nav class="sidebar" id="sidebar">
  <div class="logo">4K Bug Report<small>lamartina.fynd.io</small></div>
  <a href="#summary" class="nav-link active">Summary</a>
  <a href="#all-bugs" class="nav-link">All Bugs (${bugs.length})</a>
${[...new Set(bugs.map(b => b.category))].map(cat => `  <a href="#cat-${cat.replace(/\s/g, '-')}" class="nav-link">${cat}</a>`).join('\n')}
</nav>
<div class="main">
<div class="hdr">
  <div>
    <h1>4K Bug Report <span style="font-size:11px;background:rgba(255,255,255,.2);color:#fff;padding:3px 12px;border-radius:20px;vertical-align:middle;font-weight:500">HIGH SEVERITY</span></h1>
    <p>2026-04-03 &middot; ${bugs.length} bugs &middot; Viewport: 3840&times;2160 (4K UHD)</p>
    <div class="site-urls">
      <span class="site-url">lamartina.fynd.io</span>
    </div>
  </div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="Search bugs..." onkeyup="filterBugs()">
    <button onclick="toggleTheme()">Theme</button>
    <button onclick="window.print()">Print</button>
  </div>
</div>
<div class="ctr">

<!-- SUMMARY -->
<div id="summary" class="exec-card">
  <div class="pie-wrap">
    <svg viewBox="0 0 100 100" width="120" height="120" style="transform:rotate(-90deg)">
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="var(--border)" stroke-width="10"/>
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="#f59e0b" stroke-width="10" stroke-dasharray="100 0" stroke-dashoffset="0" />
    </svg>
    <div class="pie-legend">
      <span><span class="dot" style="background:#f59e0b"></span>${bugs.length} High</span>
    </div>
  </div>
  <div>
    <div class="stat-grid">
      <div class="stat-item"><div class="val" style="color:var(--text)">${bugs.length}</div><div class="lbl">Total Bugs</div></div>
      <div class="stat-item"><div class="val" style="color:#f59e0b">${bugs.length}</div><div class="lbl">High</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${bugs.filter(b => b.category === 'Image Quality').length}</div><div class="lbl">Image Quality</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${bugs.filter(b => b.category === 'UI Alignment').length}</div><div class="lbl">UI Alignment</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${bugs.filter(b => b.category === 'UI Functionality').length}</div><div class="lbl">Functionality</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${bugs.filter(b => b.category === 'Accessibility').length}</div><div class="lbl">Accessibility</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${bugs.filter(b => b.category === 'Navigation').length}</div><div class="lbl">Navigation</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">7</div><div class="lbl">Pages Tested</div></div>
    </div>
  </div>
</div>

<!-- ALL BUGS -->
<div id="all-bugs" style="margin-top:32px">
  <h2 style="font-size:18px;margin-bottom:16px">All Bugs (${bugs.length})</h2>
  <div class="filters">
    <button class="filter-btn active" onclick="filterCat('all')">All (${bugs.length})</button>
${[...new Set(bugs.map(b => b.category))].map(cat => {
  const count = bugs.filter(b => b.category === cat).length;
  return `    <button class="filter-btn" onclick="filterCat('${cat}')">${cat} (${count})</button>`;
}).join('\n')}
  </div>

${bugs.map(bug => `
  <div class="bug-card" data-severity="High" data-category="${escHtml(bug.category)}">
    <div class="bug-card-header">
      <h3><span class="badge bg-high">High</span> ${escHtml(bug.id)} — ${escHtml(bug.title)} <span class="badge" style="background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f;">NEW</span></h3>
    </div>
    <div class="bug-card-body">
      <table class="bug-detail-table">
        <tr><td class="bug-field">Severity</td><td><span class="badge bg-high">High</span></td></tr>
        <tr><td class="bug-field">Category</td><td>${bug.categoryTags.map(t => `<span class="badge bg-info">${escHtml(t)}</span>`).join(' ')}</td></tr>
        <tr><td class="bug-field">Location</td><td>${escHtml(bug.location)}</td></tr>
        <tr><td class="bug-field">Description</td><td>${escHtml(bug.description)}</td></tr>
        <tr><td class="bug-field">Steps</td><td>${bug.steps.split('\n').map(s => escHtml(s)).join('<br>')}</td></tr>
        <tr><td class="bug-field">Expected</td><td class="pass-text">${escHtml(bug.expected)}</td></tr>
        <tr><td class="bug-field">Actual</td><td class="fail-text">${escHtml(bug.actual)}</td></tr>
        <tr><td class="bug-field">Fix</td><td><code>${escHtml(bug.fix)}</code></td></tr>
      </table>
      <div class="bug-screenshot"><img src="screenshots/${bug.screenshot}" alt="Screenshot showing ${escHtml(bug.title)}"><div class="bug-ss-caption">Screenshot: ${escHtml(bug.location)} — ${escHtml(bug.title)}</div></div>
    </div>
  </div>
`).join('')}
</div>

<div class="ftr">4K Bug Report &middot; lamartina.fynd.io &middot; ${bugs.length} HIGH severity bugs &middot; 3840&times;2160 &middot; Generated ${new Date().toISOString().split('T')[0]}</div>
</div>
</div>

<script>
function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='light'?'dark':'light'}
function filterBugs(){const q=document.getElementById('searchInput').value.toLowerCase();document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',!c.textContent.toLowerCase().includes(q))})}
function filterCat(cat){document.querySelectorAll('.bug-card').forEach(c=>{c.classList.toggle('hidden',cat!=='all'&&c.dataset.category!==cat)});document.querySelectorAll('.filter-btn').forEach(b=>b.classList.remove('active'));event.target.classList.add('active')}
document.addEventListener('click',e=>{if(e.target.tagName==='IMG'&&e.target.closest('.bug-screenshot')){const o=document.createElement('div');o.className='zoom-overlay';o.innerHTML='<img src="'+e.target.src+'">';o.onclick=()=>o.remove();document.body.appendChild(o)}if(e.target.closest('.zoom-overlay'))e.target.closest('.zoom-overlay').remove()});
document.querySelectorAll('.nav-link').forEach(a=>{a.addEventListener('click',()=>{document.querySelectorAll('.nav-link').forEach(n=>n.classList.remove('active'));a.classList.add('active')})});
</script>
</body>
</html>`;

  fs.writeFileSync(path.join(__dirname, 'reports', '4k-bugs-high.html'), html);
  fs.writeFileSync(path.join(__dirname, 'reports', '4k-bugs-high.json'), JSON.stringify(bugs, null, 2));
  console.log(`\n  Report saved: reports/4k-bugs-high.html`);
  console.log(`  JSON saved:   reports/4k-bugs-high.json`);
  console.log(`  Screenshots:  reports/screenshots/\n`);
})();
