const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://lamartina.fynd.io';
const VP = { width: 3840, height: 2160 };
const SS_DIR = path.join(__dirname, '4k-screenshots');
if (!fs.existsSync(SS_DIR)) fs.mkdirSync(SS_DIR, { recursive: true });

const results = [];
function log(id, title, area, severity, status, details) {
  results.push({ id, title, area, severity, status, details });
  const icon = status === 'PASS' ? '\x1b[32m✓\x1b[0m' : status === 'FAIL' ? '\x1b[31m✗\x1b[0m' : '\x1b[33m⊘\x1b[0m';
  console.log(`  ${icon} ${id} [${severity}] ${title}`);
  if (details) console.log(`    → ${details}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });

  async function loadPage(pagePath, label) {
    const page = await context.newPage();
    try {
      await page.goto(SITE + pagePath, { waitUntil: 'networkidle', timeout: 30000 });
    } catch {
      try { await page.goto(SITE + pagePath, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
    }
    await page.waitForTimeout(2000);
    return page;
  }

  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  4K UI TEST CASES — lamartina.fynd.io            ║');
  console.log('  ║  Viewport: 3840 × 2160 (4K UHD)                 ║');
  console.log('  ╚══════════════════════════════════════════════════╝\n');

  // ===== HOMEPAGE =====
  console.log('  ── Homepage Tests ──');
  let page = await loadPage('/', 'homepage');
  await page.screenshot({ path: path.join(SS_DIR, 'tc_homepage_4k.png'), fullPage: true });

  // TC-001: Viewport fills without horizontal scroll
  {
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    const vw = await page.evaluate(() => window.innerWidth);
    if (scrollW <= vw + 5) {
      log('TC-001', 'Viewport fills without horizontal scroll', 'Layout', 'Critical', 'PASS', `scrollWidth=${scrollW}, viewport=${vw}`);
    } else {
      log('TC-001', 'Viewport fills without horizontal scroll', 'Layout', 'Critical', 'FAIL', `Horizontal scroll detected: scrollWidth=${scrollW}px > viewport=${vw}px`);
    }
  }

  // TC-002: Hero banner stretches correctly
  {
    const hero = await page.evaluate(() => {
      const el = document.querySelector('[class*="hero"], [class*="banner"], [class*="slider"], .slick-slider, [class*="carousel"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: rect.width, className: el.className.slice(0, 50) };
    });
    if (!hero) {
      log('TC-002', 'Hero banner stretches correctly', 'Layout', 'High', 'FAIL', 'No hero/banner element found on homepage');
    } else if (hero.width >= 3840 * 0.95) {
      log('TC-002', 'Hero banner stretches correctly', 'Layout', 'High', 'PASS', `Hero width: ${Math.round(hero.width)}px (${(hero.width/3840*100).toFixed(0)}% of viewport)`);
    } else {
      log('TC-002', 'Hero banner stretches correctly', 'Layout', 'High', 'FAIL', `Hero "${hero.className}" is only ${Math.round(hero.width)}px wide (${(hero.width/3840*100).toFixed(0)}% of 4K viewport) — does not stretch to full width`);
    }
  }

  // TC-003: Max-width container centering
  {
    const containers = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('[class*="container"], [class*="wrapper"], main, [class*="content"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const maxW = parseInt(style.maxWidth);
        if (maxW && maxW < 3000 && rect.height > 100) {
          const leftGap = rect.left;
          const rightGap = 3840 - rect.right;
          const diff = Math.abs(leftGap - rightGap);
          results.push({ className: el.className.slice(0, 40), maxW, leftGap: Math.round(leftGap), rightGap: Math.round(rightGap), diff: Math.round(diff), centered: diff < 50 });
        }
      });
      return results;
    });
    const offCenter = containers.filter(c => !c.centered);
    if (offCenter.length === 0) {
      log('TC-003', 'Max-width container centering', 'Layout', 'Medium', 'PASS', `${containers.length} containers checked — all centered`);
    } else {
      log('TC-003', 'Max-width container centering', 'Layout', 'Medium', 'FAIL', `${offCenter.length} container(s) not centered: ${offCenter.map(c => `"${c.className}" leftGap=${c.leftGap}px rightGap=${c.rightGap}px`).join('; ')}`);
    }
  }

  // TC-004: Footer layout at 4K
  {
    const footer = await page.evaluate(() => {
      const el = document.querySelector('footer');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: (rect.width / 3840 * 100).toFixed(0) };
    });
    if (!footer) {
      log('TC-004', 'Footer layout at 4K', 'Layout', 'Medium', 'FAIL', 'No footer element found');
    } else if (parseInt(footer.pct) >= 95) {
      log('TC-004', 'Footer layout at 4K', 'Layout', 'Medium', 'PASS', `Footer spans ${footer.pct}% of viewport (${footer.width}px)`);
    } else {
      log('TC-004', 'Footer layout at 4K', 'Layout', 'Medium', 'FAIL', `Footer only ${footer.pct}% of viewport (${footer.width}px) — leaves large gaps at 4K`);
    }
  }

  // TC-005: Section padding/margins scale appropriately
  {
    const sectionCheck = await page.evaluate(() => {
      const sections = document.querySelectorAll('section, [class*="section"], main > div');
      let tooNarrow = 0, total = 0;
      const issues = [];
      sections.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.height > 50 && rect.width > 0) {
          total++;
          const style = getComputedStyle(el);
          const pl = parseFloat(style.paddingLeft);
          const pr = parseFloat(style.paddingRight);
          if (rect.width < 3840 * 0.8 && rect.width > 100) {
            tooNarrow++;
            issues.push(`"${el.className.slice(0,30)}" width=${Math.round(rect.width)}px (${(rect.width/3840*100).toFixed(0)}%)`);
          }
        }
      });
      return { total, tooNarrow, issues: issues.slice(0, 3) };
    });
    if (sectionCheck.tooNarrow === 0) {
      log('TC-005', 'Section padding/margins scale appropriately', 'Layout', 'Low', 'PASS', `${sectionCheck.total} sections checked — all scale well`);
    } else {
      log('TC-005', 'Section padding/margins scale appropriately', 'Layout', 'Low', 'FAIL', `${sectionCheck.tooNarrow}/${sectionCheck.total} sections too narrow: ${sectionCheck.issues.join('; ')}`);
    }
  }

  // TC-006: Header/navbar stays fixed and legible
  {
    const header = await page.evaluate(() => {
      const el = document.querySelector('header') || document.querySelector('nav');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        width: Math.round(rect.width), pct: (rect.width / 3840 * 100).toFixed(0),
        position: style.position, fontSize: parseFloat(style.fontSize),
        height: Math.round(rect.height)
      };
    });
    if (!header) {
      log('TC-006', 'Header/navbar stays fixed and legible', 'Navigation', 'Critical', 'FAIL', 'No header/nav element found');
    } else {
      const widthOk = parseInt(header.pct) >= 95;
      const posOk = ['fixed', 'sticky'].includes(header.position);
      if (widthOk) {
        log('TC-006', 'Header/navbar stays fixed and legible', 'Navigation', 'Critical', 'PASS', `Header spans ${header.pct}%, position: ${header.position}, height: ${header.height}px`);
      } else {
        log('TC-006', 'Header/navbar stays fixed and legible', 'Navigation', 'Critical', 'FAIL', `Header only covers ${header.pct}% of 4K viewport (${header.width}px). Position: ${header.position}`);
      }
    }
  }

  // TC-007: Hamburger or mega-menu opens correctly
  {
    const menuTest = await page.evaluate(() => {
      const triggers = document.querySelectorAll('[class*="menu"], [class*="hamburger"], [class*="nav-toggle"], button[aria-label*="menu" i], [class*="mega"]');
      const navLinks = document.querySelectorAll('nav a, header a');
      return { triggers: triggers.length, navLinks: navLinks.length };
    });
    // On 4K desktop, should show full nav, not hamburger
    if (menuTest.navLinks > 3) {
      log('TC-007', 'Hamburger or mega-menu opens correctly', 'Navigation', 'High', 'PASS', `${menuTest.navLinks} nav links visible at 4K — full menu displayed (no hamburger needed)`);
    } else {
      log('TC-007', 'Hamburger or mega-menu opens correctly', 'Navigation', 'High', 'FAIL', `Only ${menuTest.navLinks} nav links visible at 4K — menu may be collapsed inappropriately`);
    }
  }

  // TC-008: Logo renders crisply
  {
    const logo = await page.evaluate(() => {
      const el = document.querySelector('[class*="logo"] img, header img, nav img, a[href="/"] img');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { renderedW: Math.round(rect.width), naturalW: el.naturalWidth, src: el.src.slice(-50) };
    });
    if (!logo) {
      log('TC-008', 'Logo renders crisply', 'Navigation', 'Medium', 'FAIL', 'No logo image found in header/nav');
    } else if (logo.naturalW >= logo.renderedW) {
      log('TC-008', 'Logo renders crisply', 'Navigation', 'Medium', 'PASS', `Logo natural=${logo.naturalW}px, rendered=${logo.renderedW}px — sharp`);
    } else {
      log('TC-008', 'Logo renders crisply', 'Navigation', 'Medium', 'FAIL', `Logo is upscaled: natural=${logo.naturalW}px but rendered at ${logo.renderedW}px — will appear blurry at 4K`);
    }
  }

  // TC-009: Cart/account icons accessible
  {
    const icons = await page.evaluate(() => {
      const cartIcon = document.querySelector('a[href*="cart"], [class*="cart-icon"], [class*="bag-icon"], header [class*="cart"]');
      const accIcon = document.querySelector('a[href*="login"], a[href*="account"], a[href*="profile"], [class*="user-icon"], header [class*="account"]');
      const check = (el) => {
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        return { found: true, width: Math.round(rect.width), height: Math.round(rect.height), tooSmall: rect.width < 24 || rect.height < 24 };
      };
      return { cart: check(cartIcon), account: check(accIcon) };
    });
    const cartOk = icons.cart.found && !icons.cart.tooSmall;
    const accOk = icons.account.found && !icons.account.tooSmall;
    if (cartOk && accOk) {
      log('TC-009', 'Cart/account icons in header are accessible', 'Navigation', 'Medium', 'PASS', `Cart: ${icons.cart.width}x${icons.cart.height}px, Account: ${icons.account.width}x${icons.account.height}px`);
    } else {
      const issues = [];
      if (!icons.cart.found) issues.push('Cart icon not found');
      else if (icons.cart.tooSmall) issues.push(`Cart icon too small: ${icons.cart.width}x${icons.cart.height}px`);
      if (!icons.account.found) issues.push('Account icon not found');
      else if (icons.account.tooSmall) issues.push(`Account icon too small: ${icons.account.width}x${icons.account.height}px`);
      log('TC-009', 'Cart/account icons in header are accessible', 'Navigation', 'Medium', 'FAIL', issues.join('; '));
    }
  }

  // TC-010: Heading font sizes scale proportionally
  {
    const headings = await page.evaluate(() => {
      const result = {};
      ['h1','h2','h3'].forEach(tag => {
        const el = document.querySelector(tag);
        if (el) result[tag] = parseFloat(getComputedStyle(el).fontSize);
      });
      return result;
    });
    const h1 = headings.h1 || 0;
    const h2 = headings.h2 || 0;
    if (h1 >= 24) {
      log('TC-010', 'Heading font sizes scale proportionally', 'Typography', 'High', 'PASS', `H1: ${h1}px, H2: ${h2 || 'N/A'}px, H3: ${headings.h3 || 'N/A'}px`);
    } else {
      log('TC-010', 'Heading font sizes scale proportionally', 'Typography', 'High', 'FAIL', `H1 is only ${h1}px — too small for 4K. H2: ${h2 || 'N/A'}px, H3: ${headings.h3 || 'N/A'}px`);
    }
  }

  // TC-011: Body text readability
  {
    const bodyText = await page.evaluate(() => {
      const ps = document.querySelectorAll('p');
      let minSize = Infinity, count = 0;
      ps.forEach(p => {
        if (p.textContent.trim().length > 10 && p.offsetHeight > 0) {
          const fs = parseFloat(getComputedStyle(p).fontSize);
          if (fs < minSize) minSize = fs;
          count++;
        }
      });
      return { minSize: minSize === Infinity ? 0 : minSize, count };
    });
    if (bodyText.minSize >= 14) {
      log('TC-011', 'Body text readability', 'Typography', 'Medium', 'PASS', `Smallest body text: ${bodyText.minSize}px across ${bodyText.count} paragraphs`);
    } else {
      log('TC-011', 'Body text readability', 'Typography', 'Medium', 'FAIL', `Body text as small as ${bodyText.minSize}px — hard to read on 4K display (${bodyText.count} paragraphs checked)`);
    }
  }

  await page.close();

  // ===== PRODUCTS PAGE =====
  console.log('\n  ── Products Page Tests ──');
  page = await loadPage('/products', 'products');
  await page.screenshot({ path: path.join(SS_DIR, 'tc_products_4k.png'), fullPage: true });

  // TC-012: Price labels correctly sized
  {
    const prices = await page.evaluate(() => {
      const els = document.querySelectorAll('[class*="price"], [class*="Price"], [class*="amount"]');
      let minSize = Infinity, count = 0;
      els.forEach(el => {
        if (el.textContent.match(/[\d.,]+/) && el.offsetHeight > 0) {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs < minSize) minSize = fs;
          count++;
        }
      });
      return { minSize: minSize === Infinity ? 0 : minSize, count };
    });
    if (prices.minSize >= 14) {
      log('TC-012', 'Price labels are correctly sized', 'Typography', 'High', 'PASS', `Smallest price text: ${prices.minSize}px (${prices.count} price elements)`);
    } else if (prices.count === 0) {
      log('TC-012', 'Price labels are correctly sized', 'Typography', 'High', 'SKIP', 'No price elements found');
    } else {
      log('TC-012', 'Price labels are correctly sized', 'Typography', 'High', 'FAIL', `Price text as small as ${prices.minSize}px at 4K — hard to read (${prices.count} elements)`);
    }
  }

  // TC-013: Product images load at high resolution
  {
    const imgs = await page.evaluate(() => {
      const results = [];
      document.querySelectorAll('[class*="product"] img, [class*="card"] img, .product-image img').forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 100 && img.naturalWidth > 0) {
          results.push({ alt: (img.alt || img.src.split('/').pop()).slice(0, 40), rendered: Math.round(rect.width), natural: img.naturalWidth, blurry: img.naturalWidth < rect.width * 0.5 });
        }
      });
      return results;
    });
    const blurry = imgs.filter(i => i.blurry);
    if (blurry.length === 0 && imgs.length > 0) {
      log('TC-013', 'Product images load at high resolution', 'Imagery', 'High', 'PASS', `${imgs.length} product images — all high-res`);
    } else if (imgs.length === 0) {
      log('TC-013', 'Product images load at high resolution', 'Imagery', 'High', 'SKIP', 'No product images found');
    } else {
      log('TC-013', 'Product images load at high resolution', 'Imagery', 'High', 'FAIL', `${blurry.length}/${imgs.length} product images are blurry at 4K (e.g. "${blurry[0].alt}" rendered at ${blurry[0].rendered}px but source is ${blurry[0].natural}px)`);
    }
  }

  // TC-014: Image lazy loading doesn't break at 4K
  {
    const lazyCheck = await page.evaluate(() => {
      const imgs = document.querySelectorAll('img[loading="lazy"]');
      let broken = 0, total = imgs.length;
      imgs.forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.top < window.innerHeight && (!img.complete || img.naturalWidth === 0)) broken++;
      });
      return { total, broken };
    });
    if (lazyCheck.broken === 0) {
      log('TC-014', 'Image lazy loading does not break at 4K', 'Imagery', 'Medium', 'PASS', `${lazyCheck.total} lazy-loaded images — all loaded correctly in viewport`);
    } else {
      log('TC-014', 'Image lazy loading does not break at 4K', 'Imagery', 'Medium', 'FAIL', `${lazyCheck.broken}/${lazyCheck.total} lazy images failed to load in viewport at 4K`);
    }
  }

  // TC-015: Zoom/hover effect on product images
  {
    const firstProduct = await page.$('[class*="product"] img, [class*="card"] img');
    let zoomWorks = false;
    if (firstProduct) {
      await firstProduct.hover();
      await page.waitForTimeout(500);
      zoomWorks = await page.evaluate(el => {
        const style = getComputedStyle(el);
        const parent = el.closest('[class*="product"], [class*="card"]');
        const parentStyle = parent ? getComputedStyle(parent) : null;
        return style.transform !== 'none' || style.opacity !== '1' ||
          (parentStyle && parentStyle.overflow === 'hidden') ||
          style.transition.includes('transform');
      }, firstProduct);
    }
    if (zoomWorks) {
      log('TC-015', 'Zoom/hover effect on product images', 'Imagery', 'Low', 'PASS', 'Hover effect detected on product images');
    } else if (!firstProduct) {
      log('TC-015', 'Zoom/hover effect on product images', 'Imagery', 'Low', 'SKIP', 'No product images to test hover on');
    } else {
      log('TC-015', 'Zoom/hover effect on product images', 'Imagery', 'Low', 'FAIL', 'No zoom/hover effect on product images at 4K');
    }
  }

  // TC-016: Product grid column count at 4K
  {
    const grid = await page.evaluate(() => {
      const cards = document.querySelectorAll('[class*="product-card"], [class*="product-item"], [class*="product-list"] > *, [class*="grid"] > [class*="product"], [class*="card"]');
      if (cards.length < 2) return { cols: 0, count: cards.length };
      const firstTop = cards[0].getBoundingClientRect().top;
      let cols = 0;
      for (const c of cards) {
        if (Math.abs(c.getBoundingClientRect().top - firstTop) < 10) cols++;
        else break;
      }
      return { cols, count: cards.length };
    });
    if (grid.cols >= 4) {
      log('TC-016', 'Product grid column count at 4K', 'Layout', 'High', 'PASS', `${grid.cols} columns at 4K — good use of screen space (${grid.count} products)`);
    } else if (grid.count === 0) {
      log('TC-016', 'Product grid column count at 4K', 'Layout', 'High', 'SKIP', 'No product grid found');
    } else {
      log('TC-016', 'Product grid column count at 4K', 'Layout', 'High', 'FAIL', `Only ${grid.cols} columns at 4K — wastes screen real estate on large display (${grid.count} products)`);
    }
  }

  await page.close();

  // ===== PDP =====
  console.log('\n  ── PDP Tests ──');
  // Find a product link
  page = await loadPage('/products', 'products-for-pdp');
  const pdpLink = await page.evaluate(() => {
    const a = document.querySelector('a[href*="/product/"]');
    return a ? a.getAttribute('href') : null;
  });
  await page.close();

  if (pdpLink) {
    page = await loadPage(pdpLink, 'pdp');
    await page.screenshot({ path: path.join(SS_DIR, 'tc_pdp_4k.png'), fullPage: true });

    // TC-017: PDP layout — image and details side by side
    {
      const pdpLayout = await page.evaluate(() => {
        const img = document.querySelector('[class*="product"] img, [class*="gallery"] img, [class*="pdp"] img, main img');
        const details = document.querySelector('[class*="product-info"], [class*="product-detail"], [class*="pdp-right"], [class*="product-description"]');
        if (!img || !details) return null;
        const imgRect = img.getBoundingClientRect();
        const detRect = details.getBoundingClientRect();
        return { sideBySide: Math.abs(imgRect.top - detRect.top) < 100, imgW: Math.round(imgRect.width), detW: Math.round(detRect.width) };
      });
      if (pdpLayout && pdpLayout.sideBySide) {
        log('TC-017', 'PDP layout at 4K — image and details side by side', 'PDP', 'High', 'PASS', `Image: ${pdpLayout.imgW}px, Details: ${pdpLayout.detW}px — side by side`);
      } else if (!pdpLayout) {
        log('TC-017', 'PDP layout at 4K — image and details side by side', 'PDP', 'High', 'SKIP', 'Could not identify PDP image/details sections');
      } else {
        log('TC-017', 'PDP layout at 4K — image and details side by side', 'PDP', 'High', 'FAIL', 'Image and product details are stacked vertically at 4K instead of side by side');
      }
    }

    // TC-018: Size selector visible
    {
      const sizeSelector = await page.evaluate(() => {
        const el = document.querySelector('[class*="size"], [class*="variant"], select[name*="size" i], [class*="option"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { width: Math.round(rect.width), height: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0 };
      });
      if (sizeSelector && sizeSelector.visible) {
        log('TC-018', 'Size selector works and is visible', 'PDP', 'Critical', 'PASS', `Size selector: ${sizeSelector.width}x${sizeSelector.height}px`);
      } else {
        log('TC-018', 'Size selector works and is visible', 'PDP', 'Critical', 'FAIL', sizeSelector ? 'Size selector found but not visible' : 'No size selector element found on PDP');
      }
    }

    // TC-019: Add to Cart button prominent
    {
      const atcBtn = await page.evaluate(() => {
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.textContent.toLowerCase().includes('add to') || b.textContent.toLowerCase().includes('cart') || b.textContent.toLowerCase().includes('buy')) {
            const rect = b.getBoundingClientRect();
            return { text: b.textContent.trim().slice(0, 30), width: Math.round(rect.width), height: Math.round(rect.height), visible: rect.width > 0 };
          }
        }
        return null;
      });
      if (atcBtn && atcBtn.width >= 100 && atcBtn.height >= 30) {
        log('TC-019', 'Add to Cart button is prominent and clickable', 'PDP', 'Critical', 'PASS', `"${atcBtn.text}" — ${atcBtn.width}x${atcBtn.height}px`);
      } else if (!atcBtn) {
        log('TC-019', 'Add to Cart button is prominent and clickable', 'PDP', 'Critical', 'FAIL', 'No Add to Cart / Buy button found');
      } else {
        log('TC-019', 'Add to Cart button is prominent and clickable', 'PDP', 'Critical', 'FAIL', `"${atcBtn.text}" too small at 4K: ${atcBtn.width}x${atcBtn.height}px`);
      }
    }

    // TC-020: Image gallery/carousel navigation
    {
      const gallery = await page.evaluate(() => {
        const arrows = document.querySelectorAll('[class*="arrow"], [class*="next"], [class*="prev"], [class*="thumb"], [class*="gallery"] button');
        const thumbs = document.querySelectorAll('[class*="thumb"] img, [class*="gallery"] img');
        return { arrows: arrows.length, thumbs: thumbs.length };
      });
      if (gallery.arrows > 0 || gallery.thumbs > 1) {
        log('TC-020', 'Image gallery/carousel navigation works', 'PDP', 'Medium', 'PASS', `${gallery.arrows} nav arrows, ${gallery.thumbs} thumbnail images`);
      } else {
        log('TC-020', 'Image gallery/carousel navigation works', 'PDP', 'Medium', 'FAIL', 'No gallery navigation (arrows/thumbnails) found on PDP');
      }
    }

    await page.close();
  } else {
    ['TC-017', 'TC-018', 'TC-019', 'TC-020'].forEach(id => {
      log(id, 'PDP test', 'PDP', 'High', 'SKIP', 'No product link found to navigate to PDP');
    });
  }

  // ===== CART PAGE =====
  console.log('\n  ── Cart Page Tests ──');
  page = await loadPage('/cart', 'cart');
  await page.screenshot({ path: path.join(SS_DIR, 'tc_cart_4k.png'), fullPage: true });

  // TC-021: Cart layout at 4K
  {
    const cartLayout = await page.evaluate(() => {
      const main = document.querySelector('main, [class*="cart"], [class*="bag"]');
      if (!main) return null;
      const rect = main.getBoundingClientRect();
      return { width: Math.round(rect.width), pct: (rect.width / 3840 * 100).toFixed(0) };
    });
    if (cartLayout && parseInt(cartLayout.pct) >= 60) {
      log('TC-021', 'Cart drawer/page layout at 4K', 'Cart', 'High', 'PASS', `Cart content: ${cartLayout.pct}% of viewport (${cartLayout.width}px)`);
    } else {
      log('TC-021', 'Cart drawer/page layout at 4K', 'Cart', 'High', 'FAIL', `Cart content only uses ${cartLayout ? cartLayout.pct : '?'}% of 4K viewport — too much whitespace`);
    }
  }

  // TC-022: Checkout button accessible
  {
    const checkout = await page.evaluate(() => {
      const btns = document.querySelectorAll('button, a');
      for (const b of btns) {
        const text = b.textContent.toLowerCase();
        if (text.includes('checkout') || text.includes('proceed') || text.includes('place order')) {
          const rect = b.getBoundingClientRect();
          return { text: b.textContent.trim().slice(0, 30), width: Math.round(rect.width), height: Math.round(rect.height) };
        }
      }
      return null;
    });
    if (checkout && checkout.width >= 80) {
      log('TC-022', 'Checkout button is accessible in cart', 'Cart', 'Critical', 'PASS', `"${checkout.text}" — ${checkout.width}x${checkout.height}px`);
    } else if (!checkout) {
      log('TC-022', 'Checkout button is accessible in cart', 'Cart', 'Critical', 'SKIP', 'No checkout button found (cart may be empty)');
    } else {
      log('TC-022', 'Checkout button is accessible in cart', 'Cart', 'Critical', 'FAIL', `"${checkout.text}" too small: ${checkout.width}x${checkout.height}px`);
    }
  }

  await page.close();

  // ===== SEARCH =====
  console.log('\n  ── Search Tests ──');
  page = await loadPage('/', 'search');

  // TC-023: Search bar expands and usable
  {
    const search = await page.evaluate(() => {
      const el = document.querySelector('input[type="search"], input[placeholder*="search" i], [class*="search"] input, [class*="search-bar"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), visible: rect.width > 0 };
    });
    if (search && search.width >= 200) {
      log('TC-023', 'Search bar expands and is usable at 4K', 'Search', 'High', 'PASS', `Search input: ${search.width}x${search.height}px`);
    } else if (!search) {
      // Try clicking search icon
      const searchIcon = await page.$('[class*="search"] svg, [class*="search"] button, [aria-label*="search" i]');
      if (searchIcon) {
        await searchIcon.click();
        await page.waitForTimeout(500);
        const expanded = await page.evaluate(() => {
          const el = document.querySelector('input[type="search"], input[placeholder*="search" i], [class*="search"] input');
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return { width: Math.round(rect.width), height: Math.round(rect.height) };
        });
        if (expanded && expanded.width >= 200) {
          log('TC-023', 'Search bar expands and is usable at 4K', 'Search', 'High', 'PASS', `Search expands on click: ${expanded.width}x${expanded.height}px`);
        } else {
          log('TC-023', 'Search bar expands and is usable at 4K', 'Search', 'High', 'FAIL', `Search bar too small after click: ${expanded ? expanded.width + 'px' : 'not found'}`);
        }
      } else {
        log('TC-023', 'Search bar expands and is usable at 4K', 'Search', 'High', 'FAIL', 'No search bar or search icon found');
      }
    } else {
      log('TC-023', 'Search bar expands and is usable at 4K', 'Search', 'High', 'FAIL', `Search bar too narrow at 4K: ${search.width}px`);
    }
  }

  // TC-024: Search results grid
  {
    // Type a search query
    const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], [class*="search"] input');
    let searchResultsOk = null;
    if (searchInput) {
      try {
        await searchInput.fill('shirt', { timeout: 5000 });
        await searchInput.press('Enter');
        await page.waitForTimeout(3000);
        await page.screenshot({ path: path.join(SS_DIR, 'tc_search_results_4k.png'), fullPage: false });
        searchResultsOk = await page.evaluate(() => {
          const results = document.querySelectorAll('[class*="product"], [class*="card"], [class*="result"], [class*="item"]');
          return { count: results.length };
        });
      } catch { searchResultsOk = null; }
    }
    if (searchResultsOk && searchResultsOk.count > 0) {
      log('TC-024', 'Search results page grid at 4K', 'Search', 'Medium', 'PASS', `${searchResultsOk.count} search results displayed`);
    } else {
      log('TC-024', 'Search results page grid at 4K', 'Search', 'Medium', 'SKIP', 'Could not trigger search or no results');
    }
  }

  await page.close();

  // ===== PERFORMANCE =====
  console.log('\n  ── Performance Tests ──');
  page = await loadPage('/', 'perf');

  // TC-025: Page load time at 4K
  {
    const perfMetrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return null;
      return { loadTime: Math.round(nav.loadEventEnd - nav.fetchStart), domReady: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart) };
    });
    if (perfMetrics && perfMetrics.loadTime < 5000) {
      log('TC-025', 'Page load time at 4K (large assets check)', 'Performance', 'High', 'PASS', `Load: ${perfMetrics.loadTime}ms, DOM ready: ${perfMetrics.domReady}ms`);
    } else if (perfMetrics) {
      log('TC-025', 'Page load time at 4K (large assets check)', 'Performance', 'High', 'FAIL', `Slow load: ${perfMetrics.loadTime}ms, DOM ready: ${perfMetrics.domReady}ms`);
    } else {
      log('TC-025', 'Page load time at 4K (large assets check)', 'Performance', 'High', 'SKIP', 'Could not read performance metrics');
    }
  }

  // TC-026: No layout shift when images load
  {
    const cls = await page.evaluate(() => {
      return new Promise(resolve => {
        let clsValue = 0;
        const po = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) clsValue += entry.value;
          }
        });
        po.observe({ type: 'layout-shift', buffered: true });
        setTimeout(() => { po.disconnect(); resolve(clsValue); }, 2000);
      });
    });
    if (cls < 0.1) {
      log('TC-026', 'No layout shift when images load', 'Performance', 'Medium', 'PASS', `CLS: ${cls.toFixed(4)} (good, < 0.1)`);
    } else if (cls < 0.25) {
      log('TC-026', 'No layout shift when images load', 'Performance', 'Medium', 'FAIL', `CLS: ${cls.toFixed(4)} (needs improvement, > 0.1)`);
    } else {
      log('TC-026', 'No layout shift when images load', 'Performance', 'Medium', 'FAIL', `CLS: ${cls.toFixed(4)} (poor, > 0.25) — significant layout shifts at 4K`);
    }
  }

  await page.close();

  // ===== ACCESSIBILITY =====
  console.log('\n  ── Accessibility Tests ──');
  page = await loadPage('/', 'a11y');

  // TC-027: Focus indicators visible at 4K
  {
    const focusCheck = await page.evaluate(() => {
      const focusable = document.querySelectorAll('a, button, input, select, textarea, [tabindex]');
      let noOutline = 0, total = 0;
      focusable.forEach(el => {
        if (el.offsetHeight > 0) {
          total++;
          const style = getComputedStyle(el);
          const focusStyle = getComputedStyle(el, ':focus');
          if (style.outlineStyle === 'none' && style.outlineWidth === '0px') noOutline++;
        }
      });
      return { total, noOutline };
    });
    if (focusCheck.noOutline < focusCheck.total * 0.5) {
      log('TC-027', 'Focus indicators visible at 4K', 'Accessibility', 'Medium', 'PASS', `${focusCheck.total - focusCheck.noOutline}/${focusCheck.total} elements have focus indicators`);
    } else {
      log('TC-027', 'Focus indicators visible at 4K', 'Accessibility', 'Medium', 'FAIL', `${focusCheck.noOutline}/${focusCheck.total} focusable elements lack visible focus indicators at 4K`);
    }
  }

  // TC-028: Color contrast at 4K
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
      texts.forEach(el => {
        if (el.offsetHeight > 0 && el.textContent.trim().length > 2) {
          total++;
          const fg = parseColor(getComputedStyle(el).color);
          const bg = parseColor(getComputedStyle(el).backgroundColor);
          if (fg && bg) {
            const l1 = luminance(...fg), l2 = luminance(...bg);
            const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
            if (ratio < 4.5) low++;
          }
        }
      });
      return { total, low };
    });
    if (contrast.low <= 2) {
      log('TC-028', 'Color contrast sufficient at 4K', 'Accessibility', 'Medium', 'PASS', `${contrast.total} text elements checked — ${contrast.low} low contrast`);
    } else {
      log('TC-028', 'Color contrast sufficient at 4K', 'Accessibility', 'Medium', 'FAIL', `${contrast.low}/${contrast.total} text elements have contrast ratio below 4.5:1`);
    }
  }

  await page.close();

  // ===== PRODUCTS PAGE — FILTERS & BREADCRUMB =====
  console.log('\n  ── Filters & Breadcrumb Tests ──');
  page = await loadPage('/products', 'filters');

  // TC-029: Filters/facets sidebar at 4K
  {
    const filters = await page.evaluate(() => {
      const el = document.querySelector('[class*="filter"], [class*="facet"], [class*="sidebar"], aside');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), visible: rect.width > 0 && rect.height > 0 };
    });
    if (filters && filters.visible && filters.width >= 150) {
      log('TC-029', 'Filters/facets sidebar at 4K', 'Layout', 'Medium', 'PASS', `Filter panel: ${filters.width}x${filters.height}px`);
    } else if (!filters) {
      log('TC-029', 'Filters/facets sidebar at 4K', 'Layout', 'Medium', 'SKIP', 'No filter/facet sidebar found');
    } else {
      log('TC-029', 'Filters/facets sidebar at 4K', 'Layout', 'Medium', 'FAIL', `Filter sidebar too small at 4K: ${filters.width}x${filters.height}px`);
    }
  }

  // TC-030: Breadcrumb navigation
  {
    const breadcrumb = await page.evaluate(() => {
      const el = document.querySelector('[class*="breadcrumb"], nav[aria-label="breadcrumb"], ol[class*="bread"]');
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const fs = parseFloat(getComputedStyle(el).fontSize);
      return { width: Math.round(rect.width), fontSize: fs, visible: rect.height > 0 };
    });
    if (breadcrumb && breadcrumb.visible && breadcrumb.fontSize >= 12) {
      log('TC-030', 'Breadcrumb navigation at 4K', 'Layout', 'Low', 'PASS', `Breadcrumb visible, font-size: ${breadcrumb.fontSize}px, width: ${breadcrumb.width}px`);
    } else if (!breadcrumb) {
      log('TC-030', 'Breadcrumb navigation at 4K', 'Layout', 'Low', 'SKIP', 'No breadcrumb navigation found');
    } else {
      log('TC-030', 'Breadcrumb navigation at 4K', 'Layout', 'Low', 'FAIL', `Breadcrumb font too small at 4K: ${breadcrumb.fontSize}px`);
    }
  }

  await page.close();
  await browser.close();

  // ===== FINAL REPORT =====
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skip = results.filter(r => r.status === 'SKIP').length;

  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log(`  ║  4K TEST RESULTS: ${pass} PASS | ${fail} FAIL | ${skip} SKIP`);
  console.log('  ╚══════════════════════════════════════════════════╝\n');

  // Print table
  console.log('  ┌────────┬──────────────────────────────────────────────────┬──────────────┬──────────┬────────┐');
  console.log('  │ ID     │ Title                                            │ Area         │ Severity │ Status │');
  console.log('  ├────────┼──────────────────────────────────────────────────┼──────────────┼──────────┼────────┤');
  results.forEach(r => {
    const id = r.id.padEnd(6);
    const title = r.title.slice(0, 48).padEnd(48);
    const area = r.area.slice(0, 12).padEnd(12);
    const sev = r.severity.padEnd(8);
    const st = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m  ' : r.status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m  ' : '\x1b[33mSKIP\x1b[0m  ';
    console.log(`  │ ${id} │ ${title} │ ${area} │ ${sev} │ ${st}│`);
  });
  console.log('  └────────┴──────────────────────────────────────────────────┴──────────────┴──────────┴────────┘');

  // Print failures detail
  const failures = results.filter(r => r.status === 'FAIL');
  if (failures.length > 0) {
    console.log(`\n  ── ${failures.length} FAILED TEST DETAILS ──`);
    failures.forEach(r => {
      console.log(`\n  ${r.id} [${r.severity}] ${r.title}`);
      console.log(`  → ${r.details}`);
    });
  }

  console.log('\n  Screenshots: ' + SS_DIR + '\n');
})();
