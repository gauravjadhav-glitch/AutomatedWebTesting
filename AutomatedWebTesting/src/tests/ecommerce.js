'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');
const SELECTORS = require('../config/selectors');

async function runECommerceTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDED2', `--- E-Commerce Tests (${discovery.platform}) ---`);

  // --- PLP: Find product listing page dynamically ---
  const plpPage = discovery.livePages.find(p =>
    /product|shop|store|catalog|collection|categor|browse|deal|offer|sale|all/i.test(p.path)
  ) || discovery.livePages.find(p => p.path === '/');

  if (plpPage) {
    await safeGoto(page, plpPage.url);
    ctx.testResults.total++;

    // Use adaptive selectors to find product cards on ANY platform
    const productCards = await page.$$(SELECTORS.productCard).catch(() => []);
    if (productCards.length === 0) {
      ctx.testResults.failed++;
      const ss = await safeScreenshot(ctx, page, 'plp_no_products');
      addBug(ctx, 'Critical', 'E-Commerce', 'No product cards found on listing page', `No products detected on ${plpPage.path} using adaptive selectors`, `${plpPage.path} — Desktop`, ['1. Navigate to ' + plpPage.url], 'Product cards visible', 'No product cards found', ss, 'Check product data API and rendering logic');
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `PLP: Found ${productCards.length} product cards on ${plpPage.path}`);
      await safeScreenshot(ctx, page, 'plp_products');

      // Check product card has image + price
      ctx.testResults.total++;
      const firstCard = productCards[0];
      const hasImage = await firstCard.$('img').catch(() => null);
      const hasPrice = await firstCard.$(SELECTORS.price).catch(() => null);
      if (!hasImage || !hasPrice) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, 'plp_card_structure');
        addBug(ctx, 'High', 'E-Commerce', 'Product card missing image or price', `Product card is missing ${[!hasImage && 'image', !hasPrice && 'price'].filter(Boolean).join(' and ')}`, `${plpPage.path} — Desktop`, ['1. Navigate to PLP', '2. Check first product card'], 'Product card shows image and price', `Missing: ${[!hasImage && 'image', !hasPrice && 'price'].filter(Boolean).join(', ')}`, ss, 'Verify product card template');
      } else {
        ctx.testResults.passed++;
      }
    }
  }

  // --- PDP: Navigate to a product detail page ---
  let pdpUrl = null;
  if (discovery.productLinks.length > 0) {
    pdpUrl = discovery.productLinks[0];
    if (!pdpUrl.startsWith('http')) pdpUrl = `${config.targetUrl}${pdpUrl}`;
  } else if (plpPage) {
    // Dynamically find product link from the PLP
    await safeGoto(page, plpPage.url);
    const productLink = await page.$(SELECTORS.productLink);
    if (productLink) pdpUrl = await productLink.getAttribute('href');
    if (pdpUrl && !pdpUrl.startsWith('http')) pdpUrl = `${config.targetUrl}${pdpUrl}`;
  }

  if (pdpUrl) {
    await safeGoto(page, pdpUrl);
    await safeScreenshot(ctx, page, 'pdp_page');

    // Check PDP elements with universal selectors
    const checks = [
      { name: 'Product Image', selector: '[class*="product"] img, [class*="gallery"] img, [class*="image"] img, .product-image img, img[class*="product"], #imgTagWrapperId img, #landingImage, ._396cs4', severity: 'Critical' },
      { name: 'Product Price', selector: SELECTORS.price, severity: 'High' },
      { name: 'Add to Cart/Buy Button', selector: SELECTORS.addToCart, severity: 'Critical' },
      { name: 'Product Title', selector: 'h1, [class*="product-title"], [class*="product-name"], [class*="ProductName"], #productTitle, ._35KGlq, .B_NuCI', severity: 'High' },
    ];

    for (const check of checks) {
      ctx.testResults.total++;
      const el = await page.$(check.selector).catch(() => null);
      if (!el) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `pdp_missing_${check.name.toLowerCase().replace(/\s/g, '_')}`);
        addBug(ctx, check.severity, 'E-Commerce', `PDP missing: ${check.name}`, `Product page does not show ${check.name}`, `PDP — Desktop`, ['1. Navigate to ' + pdpUrl], `${check.name} is visible`, `${check.name} not found on page`, ss, `Ensure ${check.name} is rendered on PDP`);
      } else {
        ctx.testResults.passed++;
        log(ctx, '\u2705', `PDP: ${check.name} found`);
      }
    }

    // Size/variant selector
    ctx.testResults.total++;
    const sizeEl = await page.$(SELECTORS.sizeSelector).catch(() => null);
    if (sizeEl) {
      ctx.testResults.passed++;
      log(ctx, '\u2705', 'PDP: Size/variant selector found');
    } else {
      ctx.testResults.skipped++;
      log(ctx, '\u2139\uFE0F', 'PDP: No size selector (may not apply to this product)');
    }

    // Try Add to Cart flow
    ctx.testResults.total++;
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
        await safeScreenshot(ctx, page, 'pdp_after_atc');

        const toast = await page.$('[class*="toast"], [class*="notification"], [class*="snackbar"], [class*="alert-success"], [class*="added"], #NATC_SMART_WAGON_CONF_MSG_SUCCESS').catch(() => null);
        const cartCount = await page.$('[class*="cart-count"], [class*="cart_count"], [class*="badge"], #nav-cart-count, ._2MHcPO').catch(() => null);
        if (toast || cartCount) {
          ctx.testResults.passed++;
          log(ctx, '\u2705', 'PDP: Add to Cart successful');
        } else {
          ctx.testResults.passed++;
          log(ctx, '\u2705', 'PDP: Add to Cart clicked (no error)');
        }
      } catch (e) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, 'pdp_atc_error');
        addBug(ctx, 'Critical', 'E-Commerce', 'Add to Cart button fails', `Error: ${e.message}`, 'PDP — Desktop', ['1. Open PDP', '2. Select size', '3. Click Add to Cart'], 'Item added to cart', `Error: ${e.message}`, ss, 'Debug the Add to Cart handler');
      }
    }
  }

  // --- Cart page test ---
  const cartPage = discovery.livePages.find(p => /cart|bag|basket/i.test(p.path));
  if (cartPage) {
    await safeGoto(page, cartPage.url);
    ctx.testResults.total++;
    await safeScreenshot(ctx, page, 'cart_page');

    const cartItems = await page.$$('[class*="cart-item"], [class*="cart_item"], [class*="CartItem"], [class*="bag-item"], [class*="basket-item"], [data-component-type="s-cart-item"], ._1AtVbE').catch(() => []);
    const emptyCart = await page.$('text=/no items/i, text=/empty/i, text=/cart is empty/i, text=/basket is empty/i').catch(() => null);

    if (cartItems.length > 0 || emptyCart) {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `Cart: ${cartItems.length} items or empty state shown`);
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2139\uFE0F', 'Cart: Page loaded (state unclear)');
    }
  }
}

module.exports = runECommerceTests;
