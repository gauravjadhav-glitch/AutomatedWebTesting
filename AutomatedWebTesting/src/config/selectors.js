'use strict';

/**
 * Adaptive Selector Engine
 * Universal selectors that work across Amazon, Flipkart, Myntra, Shopify, WooCommerce, Fynd, etc.
 */

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

module.exports = SELECTORS;
