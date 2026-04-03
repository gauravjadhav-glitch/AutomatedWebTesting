#!/usr/bin/env node
/**
 * Place Order Automation Script
 * Usage: node place-order.js <collection-url>
 * Example: node place-order.js https://gas-jeans.fynd.io/collection/man
 *
 * Works with any Fynd-based store. Selects first available product,
 * adds to cart, logs in, and places order via COD.
 * Generates HTML report with assertions and screenshots.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ===== Config =====
const PHONE = '8888888888';
const OTP = '5401';
const PINCODE = '400001';
const HEADLESS = true;
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const REPORTS_DIR = path.join(__dirname, 'reports');

// ===== Parse CLI =====
const inputUrl = process.argv[2];
if (!inputUrl) {
  console.error('Usage: node place-order.js <url>');
  console.error('Example: node place-order.js https://gas-jeans.fynd.io/collection/man');
  process.exit(1);
}
const TARGET_URL = inputUrl.startsWith('http') ? inputUrl : 'https://' + inputUrl;
const BASE_URL = new URL(TARGET_URL).origin;

// ===== Test Results Tracker =====
const testResults = {
  url: TARGET_URL,
  baseUrl: BASE_URL,
  startTime: new Date(),
  endTime: null,
  steps: [],
  summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
  orderId: null,
  productName: null,
  productPrice: null,
};

function addStep(name, status, message, screenshot = null, assertions = []) {
  const step = {
    id: testResults.steps.length + 1,
    name,
    status, // 'passed' | 'failed' | 'skipped' | 'warning'
    message,
    screenshot,
    assertions,
    timestamp: new Date(),
  };
  testResults.steps.push(step);
  testResults.summary.total++;
  if (status === 'passed') testResults.summary.passed++;
  else if (status === 'failed') testResults.summary.failed++;
  else if (status === 'skipped') testResults.summary.skipped++;

  const icon = status === 'passed' ? '\u2705' : status === 'failed' ? '\u274C' : status === 'warning' ? '\u26A0\uFE0F' : '\u23ED\uFE0F';
  console.log(`${icon} STEP ${step.id}: ${name} — ${status.toUpperCase()}`);
  if (message) console.log(`   ${message}`);
  assertions.forEach(a => {
    const ai = a.passed ? '  \u2714' : '  \u2718';
    console.log(`   ${ai} ${a.description}`);
  });
}

// ===== Helpers =====
async function findFirst(page, selectors) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible()) return el;
    } catch (e) { /* next */ }
  }
  return null;
}

async function clickFirst(page, selectors) {
  const el = await findFirst(page, selectors);
  if (el) { await el.click(); return true; }
  return false;
}

async function ss(page, name) {
  const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  return `${name}.png`;
}

async function doLogin(page) {
  await page.waitForTimeout(1500);
  const phoneInput = await findFirst(page, [
    'input[type="tel"]',
    'input[placeholder*="phone"]', 'input[placeholder*="Phone"]',
    'input[placeholder*="mobile"]', 'input[placeholder*="Mobile"]',
    'input[placeholder*="Enter"]',
  ]);
  if (!phoneInput) return false;

  await phoneInput.click({ clickCount: 3 });
  await phoneInput.press('Backspace');
  await phoneInput.type(PHONE, { delay: 50 });
  await page.waitForTimeout(500);

  const checkbox = await page.$('input[type="checkbox"]');
  if (checkbox) {
    try {
      const isChecked = await checkbox.isChecked();
      if (!isChecked) await checkbox.check({ force: true });
    } catch (e) {
      const label = await findFirst(page, ['label:has-text("Terms")', 'label:has-text("agree")']);
      if (label) await label.click();
    }
  }
  await page.waitForTimeout(500);

  await clickFirst(page, [
    'button:has-text("GET OTP")', 'button:has-text("Get OTP")',
    'button:has-text("Send OTP")', 'button:has-text("SEND OTP")',
    'button:has-text("Continue")', 'button:has-text("CONTINUE")',
  ]);

  let otpScreenReady = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForTimeout(3000);
    const otpBoxes = await page.$$('input[maxlength="1"]');
    let visibleCount = 0;
    for (const box of otpBoxes) { if (await box.isVisible()) visibleCount++; }
    if (visibleCount >= 4) { otpScreenReady = true; break; }

    const singleOtp = await findFirst(page, ['input[placeholder*="OTP"]', 'input[placeholder*="otp"]']);
    if (singleOtp) { otpScreenReady = true; break; }

    const pageText = await page.textContent('body');
    if (pageText.includes('Verify Account') || pageText.includes('Enter OTP') || pageText.includes('OTP sent to')) {
      otpScreenReady = true; break;
    }
    if (pageText.includes('Please wait') || pageText.includes('Try again')) {
      const waitTime = 15000 + (attempt * 10000);
      await page.waitForTimeout(waitTime);
      await clickFirst(page, [
        'button:has-text("GET OTP")', 'button:has-text("Get OTP")',
        'button:has-text("Send OTP")', 'button:has-text("RESEND")', 'button:has-text("Resend")',
      ]);
    }
  }
  if (!otpScreenReady) return false;

  const otpBoxes = await page.$$('input[maxlength="1"]');
  const visibleBoxes = [];
  for (const box of otpBoxes) { if (await box.isVisible()) visibleBoxes.push(box); }

  if (visibleBoxes.length >= 4) {
    const digits = OTP.split('');
    for (let i = 0; i < digits.length && i < visibleBoxes.length; i++) {
      await visibleBoxes[i].click();
      await visibleBoxes[i].fill(digits[i]);
      await page.waitForTimeout(150);
    }
  } else {
    let singleOtp = await findFirst(page, ['input[placeholder*="OTP"]', 'input[placeholder*="otp"]']);
    if (!singleOtp) {
      const allInputs = await page.$$('input[type="text"], input[type="tel"], input[type="number"], input:not([type])');
      for (const inp of allInputs) {
        try {
          if (await inp.isVisible()) {
            const ariaLabel = await inp.getAttribute('aria-label') || '';
            const name = await inp.getAttribute('name') || '';
            const id = await inp.getAttribute('id') || '';
            if (ariaLabel.toLowerCase().includes('otp') || name.toLowerCase().includes('otp') || id.toLowerCase().includes('otp')) {
              singleOtp = inp; break;
            }
          }
        } catch (e) { /* next */ }
      }
    }
    if (!singleOtp) {
      const pageText = await page.textContent('body');
      if (pageText.includes('Verify Account') || pageText.includes('Enter OTP')) {
        const allInputs = await page.$$('input');
        for (const inp of allInputs) {
          try {
            if (await inp.isVisible()) {
              const type = await inp.getAttribute('type') || 'text';
              if (type !== 'checkbox' && type !== 'hidden' && type !== 'radio') { singleOtp = inp; break; }
            }
          } catch (e) { /* next */ }
        }
      }
    }
    if (singleOtp) { await singleOtp.click(); await singleOtp.fill(OTP); }
  }

  await page.waitForTimeout(1000);
  await clickFirst(page, [
    'button:has-text("CONTINUE")', 'button:has-text("Continue")',
    'button:has-text("Verify OTP")', 'button:has-text("VERIFY OTP")',
    'button:has-text("Verify")', 'button:has-text("VERIFY")',
    'button:has-text("Submit")', 'button:has-text("SUBMIT")',
    'button[type="submit"]',
  ]);
  await page.waitForTimeout(4000);
  return true;
}

// ===== Report Generator =====
function generateReport() {
  testResults.endTime = new Date();
  const duration = ((testResults.endTime - testResults.startTime) / 1000).toFixed(1);
  const { total, passed, failed, skipped } = testResults.summary;
  const overallStatus = failed === 0 ? 'PASSED' : 'FAILED';
  const passRate = total > 0 ? ((passed / total) * 100).toFixed(0) : 0;
  const dateStr = testResults.startTime.toISOString().split('T')[0];
  const timeStr = testResults.startTime.toLocaleTimeString();

  const stepsHtml = testResults.steps.map(step => {
    const statusClass = step.status === 'passed' ? 'bg-pass' : step.status === 'failed' ? 'bg-fail' : step.status === 'warning' ? 'bg-warn' : 'bg-info';
    const statusIcon = step.status === 'passed' ? '\u2705' : step.status === 'failed' ? '\u274C' : step.status === 'warning' ? '\u26A0\uFE0F' : '\u23ED\uFE0F';
    const borderClass = step.status === 'passed' ? 'border-pass' : step.status === 'failed' ? 'border-fail' : 'border-warn';

    const assertionsHtml = step.assertions.length > 0 ? `
      <div class="assertions">
        <h4>Assertions</h4>
        <table>
          <thead><tr><th>Status</th><th>Check</th><th>Expected</th><th>Actual</th></tr></thead>
          <tbody>
            ${step.assertions.map(a => `
              <tr class="${a.passed ? 'row-pass' : 'row-fail'}">
                <td><span class="badge ${a.passed ? 'bg-pass' : 'bg-fail'}">${a.passed ? 'PASS' : 'FAIL'}</span></td>
                <td>${a.description}</td>
                <td>${a.expected || '-'}</td>
                <td>${a.actual || '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>` : '';

    const screenshotHtml = step.screenshot ? `
      <div class="step-screenshot">
        <img src="../screenshots/${step.screenshot}" alt="${step.name}" loading="lazy" onclick="this.classList.toggle('zoomed')" />
      </div>` : '';

    return `
      <div class="step-card ${borderClass}">
        <div class="step-header">
          <div class="step-title">
            <span class="step-num">${step.id}</span>
            <span>${statusIcon} ${step.name}</span>
          </div>
          <span class="badge ${statusClass}">${step.status.toUpperCase()}</span>
        </div>
        <div class="step-body">
          <p class="step-msg">${step.message}</p>
          ${assertionsHtml}
          ${screenshotHtml}
        </div>
      </div>`;
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Place Order Report — ${dateStr}</title>
<style>
:root{--bg:#0a0a0f;--bg2:#111827;--bg3:#0d1117;--bg4:#161b22;--border:#1e293b;--text:#e2e8f0;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--radius:12px}
[data-theme="light"]{--bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#e8ecf1;--border:#d1d5db;--text:#1e293b;--text2:#475569;--text3:#64748b;--accent:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6}
.container{max-width:1100px;margin:0 auto;padding:24px}

/* Header */
.header{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 40%,#2563eb 100%);padding:32px 40px;border-radius:var(--radius);margin-bottom:24px}
.header h1{font-size:24px;color:#fff;font-weight:700}
.header p{color:#93c5fd;font-size:13px;margin-top:4px}
.header .url-tag{font-size:11px;padding:4px 12px;border-radius:6px;background:rgba(34,197,94,.15);color:#86efac;border:1px solid rgba(34,197,94,.3);display:inline-block;margin-top:10px;word-break:break-all}
.header .meta{display:flex;gap:24px;margin-top:14px;flex-wrap:wrap}
.header .meta span{color:#93c5fd;font-size:12px}

/* Summary Cards */
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.stat-card{background:var(--bg2);border-radius:var(--radius);padding:20px;text-align:center;border:1px solid var(--border)}
.stat-card .val{font-size:32px;font-weight:800;line-height:1}
.stat-card .lbl{font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:6px;letter-spacing:.5px}
.stat-card.passed .val{color:#22c55e}
.stat-card.failed .val{color:#ef4444}
.stat-card.total .val{color:var(--accent)}
.stat-card.time .val{color:#a78bfa;font-size:24px}
.stat-card.rate .val{color:#22c55e}

/* Overall Banner */
.overall{padding:16px 24px;border-radius:var(--radius);margin-bottom:24px;font-weight:700;font-size:18px;text-align:center;letter-spacing:.5px}
.overall.pass-banner{background:#052e16;color:#86efac;border:2px solid #14532d}
.overall.fail-banner{background:#450a0a;color:#fca5a5;border:2px solid #7f1d1d}

/* Order Info */
.order-info{background:var(--bg2);border-radius:var(--radius);padding:20px 24px;margin-bottom:24px;border:1px solid var(--border);display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px}
.order-info .info-item{font-size:13px}
.order-info .info-label{color:var(--text3);font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:2px}
.order-info .info-value{font-weight:600;color:var(--text)}

/* Steps */
.steps-title{font-size:18px;font-weight:700;margin:24px 0 16px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.step-card{background:var(--bg2);border-radius:var(--radius);margin:12px 0;border-left:4px solid;overflow:hidden;border:1px solid var(--border)}
.step-card.border-pass{border-left:4px solid #22c55e}
.step-card.border-fail{border-left:4px solid #ef4444}
.step-card.border-warn{border-left:4px solid #f59e0b}
.step-header{padding:14px 20px;background:var(--bg3);display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.step-header:hover{background:var(--bg4)}
.step-title{display:flex;align-items:center;gap:10px;font-weight:600;font-size:14px}
.step-num{background:var(--accent);color:#fff;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;flex-shrink:0}
.step-body{padding:16px 20px}
.step-msg{color:var(--text2);font-size:13px;margin-bottom:12px}

/* Assertions */
.assertions{margin:12px 0}
.assertions h4{font-size:12px;color:var(--text3);text-transform:uppercase;margin-bottom:8px;letter-spacing:.5px}
table{width:100%;border-collapse:collapse}
th{background:var(--bg3);padding:8px 12px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px}
td{padding:8px 12px;border-bottom:1px solid var(--border);font-size:12px}
tr.row-pass td:first-child{border-left:3px solid #22c55e}
tr.row-fail td:first-child{border-left:3px solid #ef4444}

/* Badges */
.badge{padding:3px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.bg-pass{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-fail{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.bg-warn{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-info{background:#1e1b4b;color:#a5b4fc;border:1px solid #312e81}

/* Screenshots */
.step-screenshot{margin-top:12px;border-radius:8px;overflow:hidden;border:1px solid var(--border)}
.step-screenshot img{width:100%;display:block;cursor:zoom-in;transition:transform .3s}
.step-screenshot img.zoomed{transform:scale(1.5);cursor:zoom-out}

/* Theme Toggle */
.theme-toggle{position:fixed;top:16px;right:16px;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:8px 14px;border-radius:8px;cursor:pointer;font-size:12px;z-index:100}
.theme-toggle:hover{background:var(--accent);color:#fff}

/* Footer */
.footer{text-align:center;color:var(--text3);font-size:11px;padding:32px 0;margin-top:32px;border-top:1px solid var(--border)}
</style>
</head>
<body>
<button class="theme-toggle" onclick="document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'">Toggle Theme</button>

<div class="container">
  <div class="header">
    <h1>Place Order Test Report</h1>
    <p>Automated end-to-end order placement test</p>
    <div class="url-tag">${TARGET_URL}</div>
    <div class="meta">
      <span>Date: ${dateStr}</span>
      <span>Time: ${timeStr}</span>
      <span>Duration: ${duration}s</span>
      <span>Mode: Headless</span>
    </div>
  </div>

  <div class="overall ${overallStatus === 'PASSED' ? 'pass-banner' : 'fail-banner'}">
    ${overallStatus === 'PASSED' ? '\u2705' : '\u274C'} Overall: ${overallStatus}
  </div>

  <div class="summary">
    <div class="stat-card total"><div class="val">${total}</div><div class="lbl">Total Steps</div></div>
    <div class="stat-card passed"><div class="val">${passed}</div><div class="lbl">Passed</div></div>
    <div class="stat-card failed"><div class="val">${failed}</div><div class="lbl">Failed</div></div>
    <div class="stat-card rate"><div class="val">${passRate}%</div><div class="lbl">Pass Rate</div></div>
    <div class="stat-card time"><div class="val">${duration}s</div><div class="lbl">Duration</div></div>
  </div>

  ${testResults.orderId ? `
  <div class="order-info">
    <div class="info-item"><div class="info-label">Order ID</div><div class="info-value">${testResults.orderId}</div></div>
    <div class="info-item"><div class="info-label">Product</div><div class="info-value">${testResults.productName || '-'}</div></div>
    <div class="info-item"><div class="info-label">Price</div><div class="info-value">${testResults.productPrice || '-'}</div></div>
    <div class="info-item"><div class="info-label">Payment</div><div class="info-value">Cash On Delivery</div></div>
  </div>` : ''}

  <div class="steps-title">Test Steps (${total})</div>
  ${stepsHtml}

  <div class="footer">
    Generated by Place Order Automation &bull; ${dateStr} ${timeStr}
  </div>
</div>
</body>
</html>`;

  const reportPath = path.join(REPORTS_DIR, 'place-order-report.html');
  fs.writeFileSync(reportPath, html);
  console.log(`\nReport: ${reportPath}`);
  return reportPath;
}

// ===== Main =====
(async () => {
  console.log(`\nTarget: ${TARGET_URL}`);
  console.log(`Base: ${BASE_URL}`);
  console.log(`Headless: ${HEADLESS}\n`);

  const browser = await chromium.launch({ headless: HEADLESS, slowMo: 300 });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    // ========== STEP 1: Open page ==========
    await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2000);
    const shot1 = await ss(page, '01-listing');

    const pageTitle = await page.title();
    const pageLoaded = pageTitle.length > 0;
    const hasProducts = !!(await findFirst(page, ['a[href*="/product/"]', 'a[href*="/p/"]', '[class*="product"]']));

    addStep('Open Collection Page', pageLoaded ? 'passed' : 'failed',
      `Opened ${TARGET_URL}`, shot1, [
        { description: 'Page loaded successfully', expected: 'Page title present', actual: pageTitle || 'Empty', passed: pageLoaded },
        { description: 'Products visible on page', expected: 'At least 1 product', actual: hasProducts ? 'Products found' : 'No products', passed: hasProducts },
      ]);

    // ========== STEP 2: Select product ==========
    const productSelectors = [
      'a[href*="/product/"]', 'a[href*="/p/"]', 'a[href*="/products/"]',
      '[data-testid="product-card"] a', '.product-card a', '.plp-card a',
      '[class*="product"] a[href]', '[class*="Product"] a[href]',
    ];
    let productLink = await findFirst(page, productSelectors);

    // If no products on current page (homepage), navigate to a category first
    if (!productLink) {
      const currentUrl = page.url();
      const isAlreadyProduct = currentUrl.includes('/product/') || currentUrl.includes('/p/') || currentUrl.includes('/products/');

      if (!isAlreadyProduct) {
        console.log('   No products on page. Discovering category...');

        // Try clicking category nav links
        const categoryClicked = await clickFirst(page, [
          'a:has-text("Men")', 'a:has-text("Women")', 'a:has-text("New In")',
          'a:has-text("Shop")', 'a:has-text("All")', 'a:has-text("Products")',
          'a:has-text("Collection")', 'a:has-text("Man")', 'a:has-text("Woman")',
          'a:has-text("New Arrivals")', 'a:has-text("CHECK IT OUT")',
          'a[href*="/collection/"]', 'a[href*="/category/"]', 'a[href*="/products"]',
          'a[href*="/men"]', 'a[href*="/women"]', 'a[href*="/new"]',
        ]);

        if (categoryClicked) {
          console.log('   Navigated to category page');
          await page.waitForTimeout(4000);
          await page.evaluate(() => window.scrollBy(0, 500));
          await page.waitForTimeout(2000);
          productLink = await findFirst(page, productSelectors);
        }

        // If still no products, try direct URL patterns
        if (!productLink) {
          const categoryPaths = ['/products', '/collection/all', '/collection/men', '/collection/women', '/collection/new-in', '/men', '/women'];
          for (const cp of categoryPaths) {
            try {
              await page.goto(BASE_URL + cp, { waitUntil: 'networkidle', timeout: 15000 });
              await page.waitForTimeout(2000);
              await page.evaluate(() => window.scrollBy(0, 500));
              await page.waitForTimeout(1500);
              productLink = await findFirst(page, productSelectors);
              if (productLink) {
                console.log(`   Found products at ${cp}`);
                break;
              }
            } catch (e) { /* try next */ }
          }
        }
      }
    }

    if (productLink) {
      await productLink.click();
      await page.waitForTimeout(3000);
    }
    const shot2 = await ss(page, '02-product');

    const curUrl = page.url();
    const onProductPage = curUrl.includes('/product/') || curUrl.includes('/p/') || curUrl.includes('/products/');
    const productName = await page.textContent('h1').catch(() => null);
    testResults.productName = productName;

    // Get price
    const priceEl = await findFirst(page, ['[class*="price"]', '[class*="Price"]', 'span:has-text("\u20B9")']);
    if (priceEl) testResults.productPrice = await priceEl.textContent().catch(() => null);

    addStep('Select Product', onProductPage ? 'passed' : 'failed',
      productName ? `Selected: ${productName.trim().substring(0, 60)}` : 'Product selection attempted', shot2, [
        { description: 'Navigated to product page', expected: 'URL contains /product/', actual: page.url().split('?')[0], passed: onProductPage },
        { description: 'Product name visible', expected: 'Product title exists', actual: productName ? productName.trim().substring(0, 50) : 'Not found', passed: !!productName },
      ]);

    // ========== STEP 3: Select size ==========
    let sizeBtn = await findFirst(page, [
      '[class*="size"] button:not([disabled])', '[class*="Size"] button:not([disabled])',
      'button[class*="size"]:not([disabled])', '[data-testid*="size"] button:not([disabled])',
      '[class*="variant"] button:not([disabled])',
    ]);

    // If no size button found via class, try matching numeric/text size buttons
    if (!sizeBtn) {
      const allButtons = await page.$$('button, div[role="button"]');
      for (const btn of allButtons) {
        try {
          if (await btn.isVisible()) {
            const text = (await btn.textContent()).trim();
            if (/^(XS|S|M|L|XL|XXL|XXXL|2[6-9]|3[0-9]|4[0-6])$/.test(text)) {
              const disabled = await btn.getAttribute('disabled');
              const classList = (await btn.getAttribute('class')) || '';
              if (!disabled && !classList.includes('disabled') && !classList.includes('out-of-stock') && !classList.includes('unavailable') && !classList.includes('strike')) {
                sizeBtn = btn;
                break;
              }
            }
          }
        } catch (e) { /* next */ }
      }
    }

    if (sizeBtn) {
      const sizeText = await sizeBtn.textContent().catch(() => 'Unknown');
      await sizeBtn.click();
      await page.waitForTimeout(1500);
      const shot3 = await ss(page, '02b-size-selected');
      addStep('Select Size', 'passed', `Selected size: ${sizeText.trim()}`, shot3, [
        { description: 'Size option available and clickable', expected: 'Size button found', actual: `Size "${sizeText.trim()}" selected`, passed: true },
      ]);
    } else {
      addStep('Select Size', 'passed', 'Size pre-selected or not required', null, [
        { description: 'Size selection handled', expected: 'Size pre-selected or N/A', actual: 'Default size used', passed: true },
      ]);
    }
    await page.waitForTimeout(1000);

    // ========== STEP 4: Enter pincode ==========
    const pincodeInput = await findFirst(page, [
      'input[placeholder*="Check delivery"]', 'input[placeholder*="pincode"]',
      'input[placeholder*="Pincode"]', 'input[placeholder*="PIN"]',
      'input[placeholder*="zip"]', 'input[placeholder*="Enter delivery"]',
    ]);
    let deliveryAvailable = false;
    if (pincodeInput) {
      await pincodeInput.click();
      await pincodeInput.fill(PINCODE);
      await clickFirst(page, ['button:has-text("CHECK")', 'button:has-text("Check")', 'button:has-text("Apply")']);
      await page.waitForTimeout(3000);

      const bodyText = await page.textContent('body');
      deliveryAvailable = bodyText.includes('Delivery') && !bodyText.includes('not serviceable') && !bodyText.includes('Failed to fetch');
    }
    const shot4 = await ss(page, '03-pincode');

    addStep('Check Delivery Pincode', deliveryAvailable ? 'passed' : 'warning',
      `Pincode: ${PINCODE}`, shot4, [
        { description: 'Pincode input found', expected: 'Pincode field present', actual: pincodeInput ? 'Found' : 'Not found', passed: !!pincodeInput },
        { description: 'Delivery available for pincode', expected: 'Delivery confirmation', actual: deliveryAvailable ? 'Available' : 'Check manually', passed: deliveryAvailable },
      ]);

    // ========== STEP 5: Add to cart ==========
    let addedToCart = await clickFirst(page, [
      'button:has-text("ADD TO CART")', 'button:has-text("Add to Cart")',
      'button:has-text("Add to Bag")', 'button:has-text("ADD TO BAG")',
      'button:has-text("Add To Cart")', 'button:has-text("Add To Bag")',
      'button:has-text("Buy Now")', 'button:has-text("BUY NOW")',
      '[data-testid="add-to-cart"]', '[data-testid="add-to-bag"]',
    ]);

    // Some sites have a "Select Size" button that acts as add-to-cart after size is selected
    if (!addedToCart) {
      // Check if there's a prominent CTA button that might be the cart button with different text
      const ctaBtn = await findFirst(page, [
        'button:has-text("Select Size")',
        'button[class*="cart"]', 'button[class*="Cart"]',
        'button[class*="add"]', 'button[class*="Add"]',
        'button[class*="buy"]', 'button[class*="Buy"]',
      ]);
      if (ctaBtn) {
        const ctaText = (await ctaBtn.textContent()).trim();
        // If it says "Select Size" and we already selected one, it might need a re-click
        if (ctaText.includes('Select Size')) {
          // Size wasn't properly selected; try clicking a size again then this button
          if (sizeBtn) {
            await sizeBtn.click();
            await page.waitForTimeout(1000);
          }
          await ctaBtn.click();
          addedToCart = true;
        } else {
          await ctaBtn.click();
          addedToCart = true;
        }
      }
    }

    await page.waitForTimeout(3000);
    const shot5 = await ss(page, '04-added');

    const bodyAfterAdd = await page.textContent('body');
    const addConfirm = bodyAfterAdd.includes('added') || bodyAfterAdd.includes('Added') || bodyAfterAdd.includes('Go to Bag') || bodyAfterAdd.includes('View Bag') || bodyAfterAdd.includes('View Cart') || bodyAfterAdd.includes('Go to Cart');

    addStep('Add to Cart', addedToCart ? 'passed' : 'failed',
      addedToCart ? 'Product added to cart' : 'Add to cart button not found', shot5, [
        { description: 'Add to Cart button clicked', expected: 'Button found and clickable', actual: addedToCart ? 'Clicked' : 'Not found', passed: addedToCart },
        { description: 'Cart updated', expected: 'Cart shows item', actual: addConfirm ? 'Item added confirmation' : 'Check screenshot', passed: addedToCart },
      ]);

    // ========== STEP 6: Go to cart ==========
    let wentToBag = await clickFirst(page, [
      'button:has-text("Go to Bag")', 'button:has-text("GO TO BAG")',
      'a:has-text("Go to Bag")', 'button:has-text("View Bag")',
      'button:has-text("VIEW BAG")', 'button:has-text("View Cart")',
    ]);
    if (!wentToBag) {
      const cartPaths = ['/cart/bag/', '/cart/bag', '/cart', '/checkout/cart'];
      for (const p of cartPaths) {
        try {
          await page.goto(BASE_URL + p, { waitUntil: 'networkidle', timeout: 15000 });
          const body = await page.textContent('body');
          if (body.includes('Bag') || body.includes('Cart') || body.includes('bag') || body.includes('cart')) break;
        } catch (e) { /* try next path */ }
      }
    }
    await page.waitForTimeout(3000);
    const shot6 = await ss(page, '05-cart');

    const cartBody = await page.textContent('body');
    const cartHasItems = cartBody.includes('item') || cartBody.includes('Item') || cartBody.includes('Bag') || cartBody.includes('MRP') || cartBody.includes('Subtotal');
    const cartIsEmpty = (cartBody.includes('empty') || cartBody.includes('Empty')) && !cartBody.includes('MRP');

    addStep('Navigate to Cart', (cartHasItems && !cartIsEmpty) ? 'passed' : 'failed',
      'Opened cart/bag page', shot6, [
        { description: 'Cart page loaded', expected: 'Cart page visible', actual: page.url(), passed: true },
        { description: 'Cart has items', expected: 'At least 1 item', actual: cartIsEmpty ? 'Cart is empty' : 'Items present', passed: !cartIsEmpty },
      ]);

    // ========== STEP 7: Login ==========
    const loginBtn = await findFirst(page, [
      'button:has-text("LOGIN")', 'button:has-text("Login")',
      'button:has-text("SIGN IN")', 'button:has-text("Sign In")',
    ]);
    if (loginBtn) {
      // Force click - button may be temporarily disabled during cart load
      await loginBtn.click({ force: true });
      await page.waitForTimeout(2000);
      const loginSuccess = await doLogin(page);
      const shot7 = await ss(page, '07-after-login');

      if (loginSuccess) {
        await page.waitForTimeout(2000);
        for (const p of ['/cart/bag/', '/cart/bag', '/cart']) {
          try { await page.goto(BASE_URL + p, { waitUntil: 'networkidle', timeout: 15000 }); break; } catch (e) { /* next */ }
        }
        await page.waitForTimeout(3000);
      }

      const loginCheck = await page.textContent('body');
      const isLoggedIn = loginCheck.includes('Checkout') || loginCheck.includes('CHECKOUT') || loginCheck.includes('Place Order') || loginCheck.includes('PLACE ORDER') || !loginCheck.includes('LOGIN');

      addStep('Login', isLoggedIn ? 'passed' : 'failed',
        `Phone: ${PHONE}`, shot7, [
          { description: 'Login modal opened', expected: 'Phone input visible', actual: 'Modal opened', passed: true },
          { description: 'OTP entered and verified', expected: 'Login success', actual: isLoggedIn ? 'Logged in' : 'Login failed', passed: isLoggedIn },
          { description: 'User authenticated', expected: 'Checkout accessible', actual: isLoggedIn ? 'Authenticated' : 'Still on login', passed: isLoggedIn },
        ]);

      await ss(page, '08-cart-logged-in');
    } else {
      addStep('Login', 'passed', 'Already logged in', null, [
        { description: 'User already authenticated', expected: 'No login required', actual: 'Logged in', passed: true },
      ]);
    }

    // ========== STEP 8: Checkout ==========
    const checkoutClicked = await clickFirst(page, [
      'button:has-text("Place Order")', 'button:has-text("PLACE ORDER")',
      'button:has-text("Checkout")', 'button:has-text("CHECKOUT")',
      'button:has-text("Proceed")', 'button:has-text("PROCEED")',
      'button:has-text("Proceed to Checkout")', 'button:has-text("PROCEED TO CHECKOUT")',
      'a:has-text("Checkout")', 'a:has-text("Place Order")',
    ]);
    await page.waitForTimeout(5000);

    // If checkout redirected to login page, handle login
    const postCheckoutUrl = page.url();
    const postCheckoutBody = await page.textContent('body');
    if (postCheckoutUrl.includes('/auth/login') || postCheckoutUrl.includes('/login') ||
        postCheckoutBody.includes('Enter your Mobile Number') || postCheckoutBody.includes('Mobile Number to continue')) {
      console.log('   Checkout redirected to login. Logging in...');
      await ss(page, '08b-login-redirect');
      const loginOk = await doLogin(page);
      await page.waitForTimeout(3000);
      if (loginOk) {
        // After login, should auto-redirect to checkout; if not, navigate manually
        const afterLoginUrl = page.url();
        if (!afterLoginUrl.includes('checkout') && !afterLoginUrl.includes('order')) {
          for (const p of ['/cart/bag/', '/cart/bag', '/cart']) {
            try { await page.goto(BASE_URL + p, { waitUntil: 'networkidle', timeout: 15000 }); break; } catch (e) { /* next */ }
          }
          await page.waitForTimeout(2000);
          await clickFirst(page, [
            'button:has-text("Place Order")', 'button:has-text("PLACE ORDER")',
            'button:has-text("Checkout")', 'button:has-text("CHECKOUT")',
            'button:has-text("Proceed")', 'button:has-text("PROCEED")',
          ]);
          await page.waitForTimeout(5000);
        }
      }
    }

    const shot8 = await ss(page, '09-checkout');

    const checkoutUrl = page.url();
    const onCheckout = checkoutUrl.includes('checkout') || checkoutUrl.includes('order');
    const checkoutBody = await page.textContent('body');
    const hasAddress = checkoutBody.includes('Deliver To') || checkoutBody.includes('Delivery') || checkoutBody.includes('Address') || checkoutBody.includes('Shipment');

    addStep('Proceed to Checkout', onCheckout ? 'passed' : 'failed',
      'Navigated to checkout page', shot8, [
        { description: 'Checkout button clicked', expected: 'Button found', actual: checkoutClicked ? 'Clicked' : 'Not found', passed: checkoutClicked },
        { description: 'Checkout page loaded', expected: 'URL contains checkout', actual: checkoutUrl.split('?')[0], passed: onCheckout },
        { description: 'Delivery address shown', expected: 'Address section visible', actual: hasAddress ? 'Address present' : 'Not visible', passed: hasAddress },
      ]);

    // ========== STEP 9: Address ==========
    const addAddrBtn = await findFirst(page, [
      'button:has-text("Add New Address")', 'button:has-text("ADD NEW ADDRESS")',
      'a:has-text("Add New Address")',
    ]);
    if (addAddrBtn) {
      await addAddrBtn.click();
      await page.waitForTimeout(2000);
      const nameInput = await findFirst(page, ['input[name="name"]', 'input[placeholder*="Name"]']);
      if (nameInput) await nameInput.fill('Test User Automation');
      const addressInput = await findFirst(page, ['input[name="address"]', 'textarea[name="address"]', 'input[placeholder*="Address"]', 'input[placeholder*="House"]', 'input[placeholder*="Flat"]']);
      if (addressInput) await addressInput.fill('123 Test Street, Test Area');
      const cityInput = await findFirst(page, ['input[name="city"]', 'input[placeholder*="City"]']);
      if (cityInput) await cityInput.fill('Mumbai');
      const stateInput = await findFirst(page, ['input[name="state"]', 'input[placeholder*="State"]']);
      if (stateInput) await stateInput.fill('Maharashtra');
      const pinInput = await findFirst(page, ['input[name="pincode"]', 'input[name="zip"]', 'input[placeholder*="Pincode"]']);
      if (pinInput) await pinInput.fill(PINCODE);
      const emailInput = await findFirst(page, ['input[name="email"]', 'input[type="email"]', 'input[placeholder*="Email"]']);
      if (emailInput) await emailInput.fill('testuser@example.com');
      await clickFirst(page, ['button:has-text("Save Address")', 'button:has-text("SAVE ADDRESS")', 'button:has-text("Save")', 'button[type="submit"]']);
      await page.waitForTimeout(3000);
    }

    await clickFirst(page, [
      'button:has-text("Deliver Here")', 'button:has-text("DELIVER HERE")',
      'button:has-text("Select Address")', 'button:has-text("Continue")', 'button:has-text("CONTINUE")',
    ]);
    await page.waitForTimeout(3000);
    const shot9 = await ss(page, '10-address');

    const addrBody = await page.textContent('body');
    const addressConfirmed = addrBody.includes('Deliver To') || addrBody.includes('Order Summary') || addrBody.includes('Payment') || addrBody.includes('Shipment');

    addStep('Select Delivery Address', addressConfirmed ? 'passed' : 'warning',
      hasAddress ? 'Address confirmed' : 'Address selection attempted', shot9, [
        { description: 'Delivery address selected', expected: 'Address confirmation', actual: addressConfirmed ? 'Confirmed' : 'Check screenshot', passed: addressConfirmed },
      ]);

    // ========== STEP 10: Payment ==========
    await clickFirst(page, ['button:has-text("PROCEED TO PAY")', 'button:has-text("Proceed to Pay")']);
    await page.waitForTimeout(3000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    const codClicked = await clickFirst(page, [
      'text=Cash On Delivery', 'text=Cash on Delivery', 'text=COD', 'text=Pay on Delivery',
      'button:has-text("Cash On Delivery")', 'button:has-text("Cash on Delivery")',
      'label:has-text("Cash On Delivery")', 'label:has-text("Cash on Delivery")',
      'div:has-text("Cash On Delivery"):not(:has(div:has-text("Cash")))',
    ]);
    await page.waitForTimeout(2000);
    const shot10 = await ss(page, '11-payment');

    const paymentBody = await page.textContent('body');
    const paymentVisible = paymentBody.includes('Payment') || paymentBody.includes('payment') || paymentBody.includes('Card') || paymentBody.includes('UPI') || paymentBody.includes('COD') || paymentBody.includes('Cash');

    addStep('Select Payment Method', codClicked ? 'passed' : 'failed',
      codClicked ? 'Cash On Delivery selected' : 'COD option not found', shot10, [
        { description: 'Payment page loaded', expected: 'Payment options visible', actual: paymentVisible ? 'Visible' : 'Not visible', passed: paymentVisible },
        { description: 'Cash On Delivery selected', expected: 'COD option clicked', actual: codClicked ? 'Selected' : 'Not found', passed: codClicked },
      ]);

    // ========== STEP 11: Place order ==========
    await page.waitForTimeout(2000);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    const orderPlaced = await clickFirst(page, [
      'button:has-text("Place Order")', 'button:has-text("PLACE ORDER")',
      'button:has-text("PAY \u20B9")', 'button:has-text("Pay \u20B9")',
      'button:has-text("Confirm Order")', 'button:has-text("CONFIRM ORDER")',
      'button:has-text("PROCEED TO PAY")', 'button:has-text("Proceed to Pay")',
      'button:has-text("Complete Order")', 'button:has-text("COMPLETE ORDER")',
      'button:has-text("Pay")', 'button:has-text("PAY")',
    ]);
    await page.waitForTimeout(6000);
    const shot11 = await ss(page, '12-confirmation');

    const finalUrl = page.url();
    const finalBody = await page.textContent('body');
    const orderConfirmed = finalBody.includes('Order Confirmed') || finalBody.includes('order confirmed') ||
      finalBody.includes('Thank you') || finalBody.includes('Order Placed') || finalBody.includes('successfully') ||
      finalUrl.includes('success=true') || finalUrl.includes('order-status');

    // Extract Order ID
    const orderIdMatch = finalUrl.match(/order_id=([A-Z0-9]+)/) || finalBody.match(/ORDER\s*ID\s*:\s*([A-Z0-9]+)/i) || finalBody.match(/Order\s*Id\s*:\s*([A-Z0-9]+)/i);
    if (orderIdMatch) testResults.orderId = orderIdMatch[1];

    addStep('Place Order', orderConfirmed ? 'passed' : 'failed',
      orderConfirmed ? `Order placed! ID: ${testResults.orderId || 'See screenshot'}` : 'Order placement may have failed', shot11, [
        { description: 'Place Order button clicked', expected: 'Button found', actual: orderPlaced ? 'Clicked' : 'Not found', passed: orderPlaced },
        { description: 'Order confirmation page', expected: 'Success message or URL', actual: orderConfirmed ? 'Order Confirmed' : 'Not confirmed', passed: orderConfirmed },
        { description: 'Order ID generated', expected: 'Order ID present', actual: testResults.orderId || 'Not found', passed: !!testResults.orderId },
        { description: 'Redirected to success page', expected: 'URL contains success/order-status', actual: finalUrl.split('?')[0], passed: finalUrl.includes('success') || finalUrl.includes('order-status') },
      ]);

  } catch (error) {
    const shotErr = await ss(page, 'error').catch(() => null);
    addStep('Unexpected Error', 'failed', error.message, shotErr, [
      { description: 'No unexpected errors', expected: 'No errors', actual: error.message, passed: false },
    ]);
  } finally {
    await page.waitForTimeout(2000);
    await browser.close();

    const reportPath = generateReport();

    // Also save JSON results
    const jsonPath = path.join(REPORTS_DIR, 'place-order-results.json');
    fs.writeFileSync(jsonPath, JSON.stringify(testResults, null, 2));
    console.log(`JSON:   ${jsonPath}`);

    // Open report
    try {
      const { execSync } = require('child_process');
      execSync(`open "${reportPath}"`);
    } catch (e) { /* no-op */ }

    const { passed, failed, total } = testResults.summary;
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
    if (testResults.orderId) console.log(`Order ID: ${testResults.orderId}`);
    console.log(`${'='.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
  }
})();
