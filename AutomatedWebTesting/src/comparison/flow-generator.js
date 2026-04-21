'use strict';

const SELECTORS = require('../config/selectors');

/**
 * Generate deterministic test flows from a discovery object.
 * Each flow is a sequence of steps that can be replayed identically on both UAT and PROD.
 */
function generateFlows(discovery, config) {
  const flows = [];
  const maxFlows = config.comparison?.maxFlows || 10;

  // 1. Homepage Flow (always)
  flows.push({
    id: 'homepage',
    name: 'Homepage',
    category: 'navigation',
    steps: [
      { action: 'goto', path: '/', description: 'Load homepage' },
      { action: 'screenshot', name: 'homepage', description: 'Capture homepage' },
      { action: 'check_element', selector: SELECTORS.nav, key: 'nav_present', description: 'Check navigation' },
      { action: 'check_element', selector: SELECTORS.footer, key: 'footer_present', description: 'Check footer' },
      { action: 'check_element', selector: SELECTORS.searchInput + ', ' + SELECTORS.searchTrigger, key: 'search_present', description: 'Check search' },
      { action: 'check_element', selector: SELECTORS.cart, key: 'cart_present', description: 'Check cart icon' },
      { action: 'extract_dom', selector: 'body', depth: 3, key: 'homepage_structure', description: 'Capture DOM structure' },
      { action: 'measure_perf', key: 'homepage_perf', description: 'Measure performance' },
    ],
  });

  // 2. Navigation Flow
  if (discovery.navLinks && discovery.navLinks.length > 0) {
    const navSteps = [];
    const navLinks = discovery.navLinks.slice(0, 5);
    for (const link of navLinks) {
      const linkPath = toRelativePath(link.href, discovery.baseUrl);
      if (!linkPath) continue;
      navSteps.push({ action: 'goto', path: linkPath, description: `Navigate to "${link.text}"` });
      navSteps.push({ action: 'screenshot', name: `nav_${sanitize(link.text)}`, description: `Capture ${link.text}` });
      navSteps.push({ action: 'measure_perf', key: `nav_${sanitize(link.text)}_perf`, description: `Perf: ${link.text}` });
    }
    if (navSteps.length > 0) {
      flows.push({ id: 'navigation', name: 'Navigation Links', category: 'navigation', steps: navSteps });
    }
  }

  // 3. Product Listing Flow
  if (discovery.features.hasProducts) {
    const plpPage = discovery.livePages.find(p =>
      /product|shop|store|catalog|collection|categor|browse/i.test(p.path + ' ' + (p.title || ''))
    );
    const plpPath = plpPage ? plpPage.path : '/';
    flows.push({
      id: 'product-listing',
      name: 'Product Listing Page',
      category: 'ecommerce',
      steps: [
        { action: 'goto', path: plpPath, description: 'Load product listing' },
        { action: 'screenshot', name: 'plp', description: 'Capture PLP' },
        { action: 'check_element', selector: SELECTORS.productCard, key: 'product_cards', description: 'Check product cards' },
        { action: 'extract_data', selector: SELECTORS.price, key: 'first_price', description: 'Extract first price' },
        { action: 'extract_dom', selector: 'body', depth: 3, key: 'plp_structure', description: 'Capture PLP structure' },
        { action: 'measure_perf', key: 'plp_perf', description: 'Measure PLP performance' },
      ],
    });
  }

  // 4. Product Detail Flow
  if (discovery.productLinks && discovery.productLinks.length > 0) {
    const pdpPath = toRelativePath(discovery.productLinks[0], discovery.baseUrl) || discovery.productLinks[0];
    flows.push({
      id: 'product-detail',
      name: 'Product Detail Page',
      category: 'ecommerce',
      steps: [
        { action: 'goto', path: pdpPath, description: 'Load product detail page' },
        { action: 'screenshot', name: 'pdp', description: 'Capture PDP' },
        { action: 'check_element', selector: 'img, picture, [class*="image"]', key: 'pdp_image', description: 'Check product image' },
        { action: 'check_element', selector: SELECTORS.price, key: 'pdp_price_el', description: 'Check price element' },
        { action: 'extract_data', selector: SELECTORS.price, key: 'pdp_price', description: 'Extract product price' },
        { action: 'check_element', selector: SELECTORS.addToCart, key: 'add_to_cart_btn', description: 'Check add-to-cart button' },
        { action: 'extract_dom', selector: 'body', depth: 3, key: 'pdp_structure', description: 'Capture PDP structure' },
        { action: 'measure_perf', key: 'pdp_perf', description: 'Measure PDP performance' },
      ],
    });
  }

  // 5. Search Flow
  if (discovery.features.hasSearch && discovery.searchTerms.length > 0) {
    flows.push({
      id: 'search',
      name: 'Search Functionality',
      category: 'search',
      steps: [
        { action: 'goto', path: '/', description: 'Go to homepage for search' },
        { action: 'search', query: discovery.searchTerms[0], description: `Search for "${discovery.searchTerms[0]}"` },
        { action: 'screenshot', name: 'search_results', description: 'Capture search results' },
        { action: 'check_element', selector: SELECTORS.productCard, key: 'search_has_results', description: 'Check search results' },
        { action: 'measure_perf', key: 'search_perf', description: 'Measure search performance' },
      ],
    });
  }

  // 6. Cart Flow
  const cartPage = discovery.livePages.find(p => /cart|bag|basket/i.test(p.path));
  if (cartPage || discovery.features.hasCart) {
    const cartPath = cartPage ? cartPage.path : '/cart';
    flows.push({
      id: 'cart',
      name: 'Cart Page',
      category: 'ecommerce',
      steps: [
        { action: 'goto', path: cartPath, description: 'Load cart page' },
        { action: 'screenshot', name: 'cart', description: 'Capture cart page' },
        { action: 'extract_dom', selector: 'body', depth: 3, key: 'cart_structure', description: 'Capture cart structure' },
        { action: 'measure_perf', key: 'cart_perf', description: 'Measure cart performance' },
      ],
    });
  }

  // 7. Footer Flow
  if (discovery.features.hasFooter) {
    flows.push({
      id: 'footer',
      name: 'Footer Section',
      category: 'navigation',
      steps: [
        { action: 'goto', path: '/', description: 'Go to homepage for footer' },
        { action: 'scroll', y: 99999, description: 'Scroll to bottom' },
        { action: 'screenshot', name: 'footer', description: 'Capture footer' },
        { action: 'check_element', selector: SELECTORS.footer, key: 'footer_visible', description: 'Check footer visible' },
        { action: 'extract_dom', selector: SELECTORS.footer, depth: 3, key: 'footer_structure', description: 'Capture footer structure' },
      ],
    });
  }

  // 8. Dead Pages Flow
  if (discovery.deadPages && discovery.deadPages.length > 0) {
    const deadSteps = [];
    for (const dp of discovery.deadPages.slice(0, 3)) {
      deadSteps.push({ action: 'goto', path: dp.path, description: `Check dead page: ${dp.path}` });
      deadSteps.push({ action: 'screenshot', name: `dead_${sanitize(dp.path)}`, description: `Capture ${dp.path}` });
    }
    if (deadSteps.length > 0) {
      flows.push({ id: 'dead-pages', name: 'Dead Pages Check', category: 'navigation', steps: deadSteps });
    }
  }

  return flows.slice(0, maxFlows);
}

function toRelativePath(href, baseUrl) {
  if (!href) return null;
  try {
    const url = new URL(href, baseUrl);
    const base = new URL(baseUrl);
    if (url.hostname === base.hostname) return url.pathname;
    return null;
  } catch {
    if (href.startsWith('/')) return href;
    return null;
  }
}

function sanitize(str) {
  return (str || 'unknown').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 30).toLowerCase();
}

module.exports = { generateFlows };
