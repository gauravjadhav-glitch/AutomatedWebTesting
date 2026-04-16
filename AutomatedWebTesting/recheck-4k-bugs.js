const { chromium } = require('playwright');

const SITE = 'https://lamartina.fynd.io';
const VP = { width: 3840, height: 2160 };
const RESULTS = [];

function log(bugId, title, status, details) {
  const r = { bugId, title, status, details };
  RESULTS.push(r);
  const icon = status === 'FIXED' ? '✅' : status === 'STILL_OPEN' ? '❌' : '⚠️';
  console.log(`${icon} ${bugId} — ${title} — ${status}`);
  if (details) console.log(`   ${details}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VP, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);

  // ========== HOME PAGE ==========
  console.log('\n📄 Checking HOME PAGE (/) ...');
  await page.goto(`${SITE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // BUG-001: Nav bar width
  const navEl = await page.$('nav, header, [class*="nav"], [class*="header"]');
  if (navEl) {
    const navBox = await navEl.boundingBox();
    if (navBox) {
      const pct = Math.round((navBox.width / VP.width) * 100);
      if (pct >= 80) {
        log('BUG-001', 'Nav Bar Covers Only 14% of Viewport', 'FIXED', `Nav now covers ${pct}% (${Math.round(navBox.width)}px of ${VP.width}px)`);
      } else {
        log('BUG-001', 'Nav Bar Covers Only 14% of Viewport', 'STILL_OPEN', `Nav covers only ${pct}% (${Math.round(navBox.width)}px of ${VP.width}px)`);
      }
    }
  } else {
    log('BUG-001', 'Nav Bar Covers Only 14% of Viewport', 'UNKNOWN', 'Could not find nav element');
  }

  // BUG-002: Blurry images on home
  const homeImages = await page.$$eval('img[src]:not([src=""])', imgs => imgs.map(img => ({
    alt: img.alt || img.src.split('/').pop().substring(0, 50),
    naturalWidth: img.naturalWidth,
    displayWidth: img.getBoundingClientRect().width,
    src: img.src.substring(0, 80)
  })).filter(i => i.displayWidth > 100));
  const blurryHome = homeImages.filter(i => i.naturalWidth > 0 && i.displayWidth / i.naturalWidth > 1.5);
  if (blurryHome.length === 0) {
    log('BUG-002', '7 Blurry Images on Home', 'FIXED', `All ${homeImages.length} images have adequate resolution`);
  } else {
    log('BUG-002', '7 Blurry Images on Home', 'STILL_OPEN', `${blurryHome.length} blurry image(s): ${blurryHome.slice(0,3).map(i => `"${i.alt}" ${i.naturalWidth}→${Math.round(i.displayWidth)}px`).join(', ')}`);
  }

  // BUG-003: Untappable elements on home
  const smallElsHome = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.height < 25 && r.width > 0;
  }).map(el => ({ tag: el.tagName, text: (el.textContent || '').trim().substring(0, 30), h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) })));
  if (smallElsHome.length === 0) {
    log('BUG-003', '7 Untappable Elements on Home', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-003', '7 Untappable Elements on Home', 'STILL_OPEN', `${smallElsHome.length} elements under 25px: ${smallElsHome.slice(0,3).map(e => `"${e.text}" ${e.w}x${e.h}px`).join(', ')}`);
  }

  // BUG-004: Missing alt text on home
  const noAltHome = await page.$$eval('img', imgs => imgs.filter(i => {
    const r = i.getBoundingClientRect();
    return r.width > 50 && (!i.alt || i.alt.trim() === '');
  }).length);
  if (noAltHome === 0) {
    log('BUG-004', '9 Images Missing Alt Text on Home', 'FIXED', 'All visible images have alt text');
  } else {
    log('BUG-004', '9 Images Missing Alt Text on Home', 'STILL_OPEN', `${noAltHome} image(s) still missing alt text`);
  }

  // BUG-015: Focus indicators
  const focusableEls = await page.$$('a, button, input, select, textarea, [tabindex]');
  let noFocusCount = 0;
  const sampleSize = Math.min(focusableEls.length, 10);
  for (let i = 0; i < sampleSize; i++) {
    try {
      await focusableEls[i].focus();
      const hasOutline = await focusableEls[i].evaluate(el => {
        const s = getComputedStyle(el);
        return s.outlineStyle !== 'none' && s.outlineWidth !== '0px' || s.boxShadow !== 'none';
      });
      if (!hasOutline) noFocusCount++;
    } catch(e) {}
  }
  if (noFocusCount === 0) {
    log('BUG-015', 'No Focus Indicators (100%)', 'FIXED', `Checked ${sampleSize} elements — all have focus styles`);
  } else {
    log('BUG-015', 'No Focus Indicators (100%)', 'STILL_OPEN', `${noFocusCount}/${sampleSize} sampled elements lack focus indicators`);
  }

  // BUG-016: Header icons missing
  const headerIcons = await page.evaluate(() => {
    const header = document.querySelector('header, nav, [class*="header"], [class*="nav"]');
    if (!header) return { found: [] };
    const text = header.innerHTML.toLowerCase();
    const found = [];
    if (text.includes('cart') || header.querySelector('[class*="cart"], [aria-label*="cart"], [title*="cart"], a[href*="cart"]')) found.push('Cart');
    if (text.includes('account') || text.includes('user') || text.includes('profile') || header.querySelector('[class*="account"], [class*="user"], [class*="profile"], a[href*="auth"], a[href*="login"], a[href*="account"]')) found.push('Account');
    if (text.includes('wishlist') || text.includes('wish') || header.querySelector('[class*="wish"], a[href*="wish"]')) found.push('Wishlist');
    if (text.includes('search') || header.querySelector('[class*="search"], input[type="search"], [aria-label*="search"]')) found.push('Search');
    return { found };
  });
  const missingIcons = ['Cart', 'Account', 'Wishlist', 'Search'].filter(i => !headerIcons.found.includes(i));
  if (missingIcons.length === 0) {
    log('BUG-016', '4 Header Icons Missing', 'FIXED', `All icons found: ${headerIcons.found.join(', ')}`);
  } else {
    log('BUG-016', '4 Header Icons Missing', 'STILL_OPEN', `Missing: ${missingIcons.join(', ')} | Found: ${headerIcons.found.join(', ') || 'none'}`);
  }

  // Screenshot home
  await page.screenshot({ path: 'reports/screenshots/recheck_home.png', fullPage: false });

  // ========== PRODUCTS PAGE ==========
  console.log('\n📄 Checking PRODUCTS PAGE (/products) ...');
  await page.goto(`${SITE}/products`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // BUG-005: Blurry images on products
  const prodImages = await page.$$eval('img[src]:not([src=""])', imgs => imgs.map(img => ({
    alt: img.alt || img.src.split('/').pop().substring(0, 50),
    naturalWidth: img.naturalWidth,
    displayWidth: img.getBoundingClientRect().width,
  })).filter(i => i.displayWidth > 100));
  const blurryProd = prodImages.filter(i => i.naturalWidth > 0 && i.displayWidth / i.naturalWidth > 1.5);
  if (blurryProd.length === 0) {
    log('BUG-005', '17 Blurry Images on Products', 'FIXED', `All ${prodImages.length} images have adequate resolution`);
  } else {
    log('BUG-005', '17 Blurry Images on Products', 'STILL_OPEN', `${blurryProd.length} blurry image(s): ${blurryProd.slice(0,3).map(i => `"${i.alt}" ${i.naturalWidth}→${Math.round(i.displayWidth)}px`).join(', ')}`);
  }

  // BUG-006: Untappable elements on products
  const smallElsProd = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 25 && r.width > 0;
  }).length);
  if (smallElsProd === 0) {
    log('BUG-006', '7 Untappable Elements on Products', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-006', '7 Untappable Elements on Products', 'STILL_OPEN', `${smallElsProd} elements under 25px`);
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_products.png', fullPage: false });

  // ========== COLLECTIONS PAGE ==========
  console.log('\n📄 Checking COLLECTIONS PAGE (/collections) ...');
  await page.goto(`${SITE}/collections`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // BUG-007: Blurry images on collections
  const collImages = await page.$$eval('img[src]:not([src=""])', imgs => imgs.map(img => ({
    alt: img.alt || '',
    naturalWidth: img.naturalWidth,
    displayWidth: img.getBoundingClientRect().width,
  })).filter(i => i.displayWidth > 100));
  const blurryColl = collImages.filter(i => i.naturalWidth > 0 && i.displayWidth / i.naturalWidth > 1.5);
  if (blurryColl.length === 0) {
    log('BUG-007', '1 Blurry Image on Collections', 'FIXED', `All ${collImages.length} images OK`);
  } else {
    log('BUG-007', '1 Blurry Image on Collections', 'STILL_OPEN', `${blurryColl.length} blurry image(s)`);
  }

  // BUG-008: Untappable elements on collections
  const smallElsColl = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 25 && r.width > 0;
  }).length);
  if (smallElsColl === 0) {
    log('BUG-008', '8 Untappable Elements on Collections', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-008', '8 Untappable Elements on Collections', 'STILL_OPEN', `${smallElsColl} elements under 25px`);
  }

  // BUG-009: Missing alt text on collections
  const noAltColl = await page.$$eval('img', imgs => imgs.filter(i => {
    const r = i.getBoundingClientRect();
    return r.width > 50 && (!i.alt || i.alt.trim() === '');
  }).length);
  if (noAltColl === 0) {
    log('BUG-009', '5 Images Missing Alt Text on Collections', 'FIXED', 'All visible images have alt text');
  } else {
    log('BUG-009', '5 Images Missing Alt Text on Collections', 'STILL_OPEN', `${noAltColl} image(s) missing alt`);
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_collections.png', fullPage: false });

  // ========== CATEGORIES PAGE ==========
  console.log('\n📄 Checking CATEGORIES PAGE (/categories) ...');
  await page.goto(`${SITE}/categories`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // BUG-010: Untappable elements on categories
  const smallElsCat = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 25 && r.width > 0;
  }).length);
  if (smallElsCat === 0) {
    log('BUG-010', '8 Untappable Elements on Categories', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-010', '8 Untappable Elements on Categories', 'STILL_OPEN', `${smallElsCat} elements under 25px`);
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_categories.png', fullPage: false });

  // ========== CART PAGE ==========
  console.log('\n📄 Checking CART PAGE (/cart) ...');
  await page.goto(`${SITE}/cart`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // BUG-011: Untappable elements on cart
  const smallElsCart = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 25 && r.width > 0;
  }).length);
  if (smallElsCart === 0) {
    log('BUG-011', '7 Untappable Elements on Cart', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-011', '7 Untappable Elements on Cart', 'STILL_OPEN', `${smallElsCart} elements under 25px`);
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_cart.png', fullPage: false });

  // ========== AUTH/LOGIN PAGE ==========
  console.log('\n📄 Checking AUTH/LOGIN PAGE (/auth/login) ...');
  await page.goto(`${SITE}/auth/login`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // BUG-012: Untappable elements on auth/login
  const smallElsLogin = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 25 && r.width > 0;
  }).length);
  if (smallElsLogin === 0) {
    log('BUG-012', '7 Untappable Elements on Auth/Login', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-012', '7 Untappable Elements on Auth/Login', 'STILL_OPEN', `${smallElsLogin} elements under 25px`);
  }

  // BUG-013: Excessive whitespace on auth/login
  const loginContent = await page.evaluate(() => {
    const main = document.querySelector('main, [class*="login"], [class*="auth"], form');
    if (!main) return { width: 0 };
    return { width: main.getBoundingClientRect().width };
  });
  const loginPct = Math.round((loginContent.width / VP.width) * 100);
  if (loginPct >= 30) {
    log('BUG-013', 'Excessive Whitespace (99%) on Auth/Login', 'FIXED', `Content uses ${loginPct}% of viewport (${Math.round(loginContent.width)}px)`);
  } else {
    log('BUG-013', 'Excessive Whitespace (99%) on Auth/Login', 'STILL_OPEN', `Content uses only ${loginPct}% of viewport (${Math.round(loginContent.width)}px of ${VP.width}px)`);
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_auth_login.png', fullPage: false });

  // ========== CONTACT-US PAGE ==========
  console.log('\n📄 Checking CONTACT-US PAGE (/contact-us) ...');
  await page.goto(`${SITE}/contact-us`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // BUG-014: Untappable elements on contact-us
  const smallElsContact = await page.$$eval('a, button, input, select, [role="button"]', els => els.filter(el => {
    const r = el.getBoundingClientRect(); return r.height > 0 && r.height < 25 && r.width > 0;
  }).length);
  if (smallElsContact === 0) {
    log('BUG-014', '7 Untappable Elements on Contact-Us', 'FIXED', 'All interactive elements >= 25px tall');
  } else {
    log('BUG-014', '7 Untappable Elements on Contact-Us', 'STILL_OPEN', `${smallElsContact} elements under 25px`);
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_contact-us.png', fullPage: false });

  // ========== PDP PAGE ==========
  console.log('\n📄 Checking PDP PAGE ...');
  // First get a product link from the products page
  await page.goto(`${SITE}/products`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  let pdpUrl = await page.evaluate(() => {
    const link = document.querySelector('a[href*="/product/"]');
    return link ? link.href : null;
  });
  if (!pdpUrl) pdpUrl = `${SITE}/product/dark-blue-straight-fit-larkee-jeans-17576710`;

  await page.goto(pdpUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // BUG-017: Size/Variant Selector
  const sizeSelector = await page.evaluate(() => {
    const selectors = [
      '[class*="size"]', '[class*="variant"]', 'select', '[class*="Size"]',
      '[class*="Variant"]', '[data-testid*="size"]', '[class*="option"]',
      'button[class*="size"]', '[class*="selector"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) return { found: true, selector: sel, text: (el.textContent || '').trim().substring(0, 50) };
    }
    return { found: false };
  });
  if (sizeSelector.found) {
    log('BUG-017', 'PDP Size/Variant Selector Not Found', 'FIXED', `Found via "${sizeSelector.selector}": "${sizeSelector.text}"`);
  } else {
    log('BUG-017', 'PDP Size/Variant Selector Not Found', 'STILL_OPEN', 'Size/Variant selector still not found at 4K');
  }

  // BUG-018: Add to Cart / Buy Button
  const addToCart = await page.evaluate(() => {
    const selectors = [
      'button[class*="add-to-cart"]', 'button[class*="addToCart"]', 'button[class*="buy"]',
      '[class*="add-to-bag"]', '[class*="addToBag"]', 'button[class*="cart"]',
      '[class*="add_to_cart"]', '[class*="add-to-cart"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) return { found: true, text: (el.textContent || '').trim().substring(0, 50) };
    }
    // Also check by text content
    const buttons = document.querySelectorAll('button, a[role="button"], [class*="btn"]');
    for (const btn of buttons) {
      const txt = (btn.textContent || '').toLowerCase();
      if ((txt.includes('add to') || txt.includes('buy') || txt.includes('add to cart') || txt.includes('add to bag')) && btn.getBoundingClientRect().height > 0) {
        return { found: true, text: btn.textContent.trim().substring(0, 50) };
      }
    }
    return { found: false };
  });
  if (addToCart.found) {
    log('BUG-018', 'PDP Add to Cart/Buy Button Not Found', 'FIXED', `Found: "${addToCart.text}"`);
  } else {
    log('BUG-018', 'PDP Add to Cart/Buy Button Not Found', 'STILL_OPEN', 'Add to Cart / Buy button still not found at 4K');
  }

  // BUG-019: Image Gallery Navigation
  const imgGallery = await page.evaluate(() => {
    const selectors = [
      '[class*="gallery"]', '[class*="carousel"]', '[class*="slider"]', '[class*="thumb"]',
      '[class*="swiper"]', '[class*="image-nav"]', 'button[class*="prev"]', 'button[class*="next"]',
      '[class*="arrow"]', '[class*="dot"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) return { found: true, selector: sel };
    }
    return { found: false };
  });
  if (imgGallery.found) {
    log('BUG-019', 'PDP Image Gallery Navigation Not Found', 'FIXED', `Found via "${imgGallery.selector}"`);
  } else {
    log('BUG-019', 'PDP Image Gallery Navigation Not Found', 'STILL_OPEN', 'Image gallery navigation still not found at 4K');
  }

  // BUG-020: Product Price Display
  const priceDisplay = await page.evaluate(() => {
    const selectors = [
      '[class*="price"]', '[class*="Price"]', '[data-testid*="price"]',
      '[class*="amount"]', '[class*="cost"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0) {
        return { found: true, text: (el.textContent || '').trim().substring(0, 50) };
      }
    }
    // Check for currency symbols
    const allEls = document.querySelectorAll('span, div, p');
    for (const el of allEls) {
      const txt = el.textContent || '';
      if ((txt.includes('₹') || txt.includes('$') || txt.includes('€') || txt.includes('MRP')) && el.getBoundingClientRect().height > 0 && txt.length < 50) {
        return { found: true, text: txt.trim().substring(0, 50) };
      }
    }
    return { found: false };
  });
  if (priceDisplay.found) {
    log('BUG-020', 'PDP Product Price Not Found', 'FIXED', `Found: "${priceDisplay.text}"`);
  } else {
    log('BUG-020', 'PDP Product Price Not Found', 'STILL_OPEN', 'Price display still not found at 4K');
  }

  // BUG-021: Product Description
  const prodDesc = await page.evaluate(() => {
    const selectors = [
      '[class*="description"]', '[class*="Description"]', '[class*="detail"]',
      '[class*="product-info"]', '[data-testid*="description"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.getBoundingClientRect().height > 0 && (el.textContent || '').trim().length > 20) {
        return { found: true, text: (el.textContent || '').trim().substring(0, 80) };
      }
    }
    return { found: false };
  });
  if (prodDesc.found) {
    log('BUG-021', 'PDP Product Description Not Found', 'FIXED', `Found: "${prodDesc.text}"`);
  } else {
    log('BUG-021', 'PDP Product Description Not Found', 'STILL_OPEN', 'Description still not found at 4K');
  }

  await page.screenshot({ path: 'reports/screenshots/recheck_pdp.png', fullPage: false });

  // ========== SEARCH ==========
  console.log('\n📄 Checking SEARCH for "shirt" ...');
  await page.goto(`${SITE}/`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // BUG-022: Search returns no results
  let searchWorked = false;
  try {
    // Try clicking search icon
    const searchTrigger = await page.$('[class*="search"], [aria-label*="search"], button:has(svg), input[type="search"]');
    if (searchTrigger) {
      await searchTrigger.click();
      await page.waitForTimeout(1000);
    }
    // Try typing in search
    const searchInput = await page.$('input[type="search"], input[placeholder*="search" i], input[class*="search"]');
    if (searchInput) {
      await searchInput.fill('shirt');
      await searchInput.press('Enter');
      await page.waitForTimeout(3000);

      const results = await page.evaluate(() => {
        const products = document.querySelectorAll('[class*="product"], [class*="card"], [class*="item"]');
        return products.length;
      });
      if (results > 0) {
        searchWorked = true;
        log('BUG-022', 'Search Returns No Results for "shirt"', 'FIXED', `Search returned ${results} result(s)`);
      } else {
        log('BUG-022', 'Search Returns No Results for "shirt"', 'STILL_OPEN', 'Search still returns no results');
      }
    } else {
      // Try URL-based search
      await page.goto(`${SITE}/products/?q=shirt`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(2000);
      const results = await page.$$eval('img', imgs => imgs.filter(i => i.getBoundingClientRect().width > 80).length);
      if (results > 2) {
        searchWorked = true;
        log('BUG-022', 'Search Returns No Results for "shirt"', 'FIXED', `URL search returned product images`);
      } else {
        log('BUG-022', 'Search Returns No Results for "shirt"', 'STILL_OPEN', 'Search still returns no results');
      }
    }
  } catch(e) {
    log('BUG-022', 'Search Returns No Results for "shirt"', 'UNKNOWN', `Error: ${e.message}`);
  }

  if (!searchWorked) {
    await page.screenshot({ path: 'reports/screenshots/recheck_search.png', fullPage: false });
  }

  // ========== SUMMARY ==========
  console.log('\n' + '='.repeat(60));
  console.log('RECHECK SUMMARY — lamartina.fynd.io — 4K (3840×2160)');
  console.log('='.repeat(60));
  const fixed = RESULTS.filter(r => r.status === 'FIXED').length;
  const open = RESULTS.filter(r => r.status === 'STILL_OPEN').length;
  const unknown = RESULTS.filter(r => r.status === 'UNKNOWN').length;
  console.log(`✅ FIXED: ${fixed}/${RESULTS.length}`);
  console.log(`❌ STILL OPEN: ${open}/${RESULTS.length}`);
  if (unknown > 0) console.log(`⚠️ UNKNOWN: ${unknown}/${RESULTS.length}`);
  console.log('='.repeat(60));

  // Save results JSON
  const fs = require('fs');
  fs.writeFileSync('reports/recheck-results.json', JSON.stringify({ date: new Date().toISOString(), site: SITE, viewport: VP, results: RESULTS }, null, 2));

  await browser.close();
})();
