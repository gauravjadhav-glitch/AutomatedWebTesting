/**
 * Enhanced Testing Module — 8 New Test Categories
 *
 * 1. Core Web Vitals (LCP, FID, CLS, TTFB, INP)
 * 2. Accessibility (axe-core WCAG 2.1)
 * 3. Multi-Language/Locale
 * 4. API Response Validation
 * 5. Cart Persistence Across Viewports
 * 6. Input Validation & Security (XSS, SQLi, invalid inputs)
 * 7. Test Priority Execution (dependency-aware ordering)
 * 8. Enhanced Report Data (charts, filtering, sorting)
 */

const { devices } = require('playwright');

// axe-core for accessibility — gracefully degrade if not available
let AxeBuilder;
try { ({ AxeBuilder } = require('@axe-core/playwright')); } catch { AxeBuilder = null; }

function b64(buffer) { return buffer.toString('base64'); }
function siteName(label, siteUrl) {
  if (siteUrl) { try { return new URL(siteUrl).hostname; } catch {} }
  return label;
}

// ─────────────────────────────────────────────────────────────
// 1. CORE WEB VITALS — LCP, CLS, FID/INP, TTFB per page
// ─────────────────────────────────────────────────────────────

async function runCoreWebVitals(browser, siteUrl, label, pagePaths, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const results = [];
  const testPages = (pagePaths || ['/']).slice(0, 8);

  for (const pagePath of testPages) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      const startNav = Date.now();
      await page.goto(siteUrl + pagePath, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(3000);

      // Scroll to trigger LCP and CLS
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight / 2);
      });
      await page.waitForTimeout(1000);
      await page.evaluate(() => { window.scrollTo(0, 0); });
      await page.waitForTimeout(1000);

      const vitals = await page.evaluate(() => {
        const result = { lcp: null, cls: 0, fcp: null, ttfb: null, inp: null, domSize: 0, totalResources: 0, totalSize: 0 };

        // Navigation timing
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav) {
          result.ttfb = Math.round(nav.responseStart - nav.requestStart);
          result.fcp = null;
        }

        // FCP
        const paintEntries = performance.getEntriesByType('paint');
        const fcpEntry = paintEntries.find(e => e.name === 'first-contentful-paint');
        if (fcpEntry) result.fcp = Math.round(fcpEntry.startTime);

        // LCP (from PerformanceObserver entries)
        const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
        if (lcpEntries.length > 0) {
          result.lcp = Math.round(lcpEntries[lcpEntries.length - 1].startTime);
        }

        // CLS
        const layoutShiftEntries = performance.getEntriesByType('layout-shift');
        let clsValue = 0;
        for (const entry of layoutShiftEntries) {
          if (!entry.hadRecentInput) clsValue += entry.value;
        }
        result.cls = Math.round(clsValue * 1000) / 1000;

        // Resource metrics
        const resources = performance.getEntriesByType('resource');
        result.totalResources = resources.length;
        result.totalSize = Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024);

        // DOM size
        result.domSize = document.querySelectorAll('*').length;

        // Long tasks (> 50ms)
        result.longTasks = performance.getEntriesByType('longtask').length;

        return result;
      });

      const totalLoad = Date.now() - startNav;
      vitals.totalLoad = totalLoad;
      vitals.page = pagePath;

      results.push(vitals);

      // Report bugs for poor vitals
      if (vitals.lcp && vitals.lcp > 4000) {
        bugs.push({
          id: bugs.length + 1, severity: vitals.lcp > 6000 ? 'Critical' : 'High',
          category: 'Performance', title: `Slow LCP (${vitals.lcp}ms) on ${pagePath}`,
          description: `Largest Contentful Paint is ${vitals.lcp}ms (threshold: 2500ms good, 4000ms poor). The main content takes too long to render.`,
          site: sn, fix: 'Optimize LCP element — preload hero image, use responsive images, reduce render-blocking resources',
          testType: 'Core Web Vitals', location: `${pagePath}`,
          steps: `1. Open ${siteUrl}${pagePath}\n2. Measure LCP with Chrome DevTools Performance tab`,
          expected: 'LCP < 2500ms (Good)', actual: `LCP = ${vitals.lcp}ms (Poor)`
        });
      }

      if (vitals.cls > 0.25) {
        bugs.push({
          id: bugs.length + 1, severity: 'High',
          category: 'Performance', title: `High CLS (${vitals.cls}) on ${pagePath}`,
          description: `Cumulative Layout Shift is ${vitals.cls} (threshold: 0.1 good, 0.25 poor). Page elements shift unexpectedly during load.`,
          site: sn, fix: 'Set explicit width/height on images/ads, avoid dynamic content injection above the fold',
          testType: 'Core Web Vitals', location: `${pagePath}`,
          steps: `1. Open ${siteUrl}${pagePath}\n2. Watch for layout shifts during page load`,
          expected: 'CLS < 0.1 (Good)', actual: `CLS = ${vitals.cls} (Poor)`
        });
      }

      if (vitals.fcp && vitals.fcp > 3000) {
        bugs.push({
          id: bugs.length + 1, severity: 'Medium',
          category: 'Performance', title: `Slow FCP (${vitals.fcp}ms) on ${pagePath}`,
          description: `First Contentful Paint is ${vitals.fcp}ms. Users see a blank screen for too long.`,
          site: sn, fix: 'Reduce render-blocking CSS/JS, inline critical CSS, preconnect to CDN origins',
          testType: 'Core Web Vitals', location: `${pagePath}`,
          steps: `1. Open ${siteUrl}${pagePath}\n2. Check FCP in Lighthouse`,
          expected: 'FCP < 1800ms (Good)', actual: `FCP = ${vitals.fcp}ms`
        });
      }

      if (vitals.ttfb && vitals.ttfb > 800) {
        bugs.push({
          id: bugs.length + 1, severity: vitals.ttfb > 1800 ? 'High' : 'Medium',
          category: 'Performance', title: `Slow TTFB (${vitals.ttfb}ms) on ${pagePath}`,
          description: `Time to First Byte is ${vitals.ttfb}ms. Server response is slow.`,
          site: sn, fix: 'Enable server-side caching, use CDN, optimize backend queries',
          testType: 'Core Web Vitals', location: `${pagePath}`,
          steps: `1. Open ${siteUrl}${pagePath}\n2. Check TTFB in Network tab`,
          expected: 'TTFB < 200ms (Good)', actual: `TTFB = ${vitals.ttfb}ms`
        });
      }

      if (vitals.domSize > 3000) {
        bugs.push({
          id: bugs.length + 1, severity: vitals.domSize > 5000 ? 'High' : 'Medium',
          category: 'Performance', title: `Large DOM (${vitals.domSize} elements) on ${pagePath}`,
          description: `DOM has ${vitals.domSize} elements. Excessive DOM size slows rendering and increases memory usage.`,
          site: sn, fix: 'Reduce DOM depth, lazy-load offscreen sections, virtualize long lists',
          testType: 'Core Web Vitals', location: `${pagePath}`,
          steps: `1. Open ${siteUrl}${pagePath}\n2. Run Lighthouse or check document.querySelectorAll('*').length`,
          expected: 'DOM < 1500 elements', actual: `DOM = ${vitals.domSize} elements`
        });
      }

      screenshots[`${label}_cwv_${pagePath.replace(/[^a-z0-9]/gi, '_')}`] = b64(await page.screenshot());
    } catch (e) {
      results.push({ page: pagePath, error: e.message });
    } finally {
      await page.close();
    }
  }

  pageData[`${label}_core_web_vitals`] = results;
  return results;
}

// ─────────────────────────────────────────────────────────────
// 2. ACCESSIBILITY — axe-core WCAG 2.1 deep scan
// ─────────────────────────────────────────────────────────────

async function runAxeAccessibility(browser, siteUrl, label, pagePaths, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const results = [];
  const testPages = (pagePaths || ['/']).slice(0, 5);

  for (const pagePath of testPages) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(siteUrl + pagePath, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      let axeResults = null;

      if (AxeBuilder) {
        // Use axe-core if available
        try {
          axeResults = await new AxeBuilder({ page })
            .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
            .analyze();
        } catch {}
      }

      if (axeResults) {
        const violations = axeResults.violations || [];
        const critical = violations.filter(v => v.impact === 'critical');
        const serious = violations.filter(v => v.impact === 'serious');
        const moderate = violations.filter(v => v.impact === 'moderate');

        results.push({
          page: pagePath,
          totalViolations: violations.length,
          critical: critical.length,
          serious: serious.length,
          moderate: moderate.length,
          violations: violations.slice(0, 10).map(v => ({
            id: v.id, impact: v.impact, description: v.description,
            nodes: v.nodes.length, help: v.helpUrl
          }))
        });

        // Report critical violations as bugs
        for (const v of critical.slice(0, 3)) {
          bugs.push({
            id: bugs.length + 1, severity: 'Critical',
            category: 'Accessibility', title: `A11y: ${v.id} — ${pagePath}`,
            description: `${v.description}\n\nAffects ${v.nodes.length} element(s). Impact: ${v.impact}.\nWCAG Rule: ${v.id}`,
            site: sn, fix: v.help || `Fix ${v.id} accessibility violation`,
            testType: 'Accessibility (axe)', location: pagePath,
            steps: `1. Open ${siteUrl}${pagePath}\n2. Run axe DevTools\n3. Check "${v.id}" rule`,
            expected: `No ${v.id} violations`, actual: `${v.nodes.length} element(s) violate ${v.id}`
          });
        }

        for (const v of serious.slice(0, 3)) {
          bugs.push({
            id: bugs.length + 1, severity: 'High',
            category: 'Accessibility', title: `A11y: ${v.id} — ${pagePath}`,
            description: `${v.description}\n\nAffects ${v.nodes.length} element(s). Impact: ${v.impact}.`,
            site: sn, fix: v.help || `Fix ${v.id} accessibility violation`,
            testType: 'Accessibility (axe)', location: pagePath,
            steps: `1. Open ${siteUrl}${pagePath}\n2. Run axe DevTools\n3. Check "${v.id}" rule`,
            expected: `No ${v.id} violations`, actual: `${v.nodes.length} element(s) violate ${v.id}`
          });
        }
      } else {
        // Fallback: manual a11y checks without axe-core
        const a11yData = await page.evaluate(() => {
          const issues = [];

          // Missing ARIA labels on interactive elements
          document.querySelectorAll('button, a, input, select, textarea').forEach(el => {
            if (el.offsetHeight === 0) return;
            const hasLabel = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ||
              el.textContent.trim().length > 0 || el.getAttribute('title') ||
              (el.tagName === 'INPUT' && (el.getAttribute('placeholder') || document.querySelector(`label[for="${el.id}"]`)));
            if (!hasLabel) {
              issues.push({ type: 'missing-label', tag: el.tagName, id: el.id || '', impact: 'serious' });
            }
          });

          // Missing lang attribute
          if (!document.documentElement.getAttribute('lang')) {
            issues.push({ type: 'missing-lang', tag: 'html', impact: 'serious' });
          }

          // Missing form labels
          document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').forEach(el => {
            if (el.offsetHeight === 0) return;
            const hasLabel = el.getAttribute('aria-label') || document.querySelector(`label[for="${el.id}"]`) ||
              el.closest('label') || el.getAttribute('placeholder');
            if (!hasLabel) {
              issues.push({ type: 'form-no-label', tag: 'input', name: el.name || el.type, impact: 'critical' });
            }
          });

          // Skip nav landmark check
          const hasSkipNav = !!document.querySelector('a[href="#main"], a[href="#content"], [class*="skip"]');
          if (!hasSkipNav) {
            issues.push({ type: 'no-skip-nav', impact: 'moderate' });
          }

          // Heading hierarchy
          const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map(h => parseInt(h.tagName[1]));
          let prevLevel = 0;
          for (const level of headings) {
            if (level > prevLevel + 1 && prevLevel > 0) {
              issues.push({ type: 'heading-skip', from: `h${prevLevel}`, to: `h${level}`, impact: 'moderate' });
              break;
            }
            prevLevel = level;
          }

          return { issues, total: issues.length };
        });

        results.push({ page: pagePath, manual: true, issues: a11yData.issues, total: a11yData.total });

        if (a11yData.total > 5) {
          const critIssues = a11yData.issues.filter(i => i.impact === 'critical' || i.impact === 'serious');
          if (critIssues.length > 0) {
            bugs.push({
              id: bugs.length + 1, severity: 'High',
              category: 'Accessibility', title: `${critIssues.length} A11y Issues — ${pagePath}`,
              description: `Found ${critIssues.length} critical/serious accessibility issues:\n${critIssues.slice(0, 5).map(i => `- ${i.type}: ${i.tag || ''} ${i.name || ''}`).join('\n')}`,
              site: sn, fix: 'Add ARIA labels, form labels, skip navigation, and fix heading hierarchy',
              testType: 'Accessibility', location: pagePath,
              steps: `1. Open ${siteUrl}${pagePath}\n2. Run accessibility audit`,
              expected: 'No critical accessibility issues', actual: `${critIssues.length} issues found`
            });
          }
        }
      }

      screenshots[`${label}_a11y_deep_${pagePath.replace(/[^a-z0-9]/gi, '_')}`] = b64(await page.screenshot());
    } catch (e) {
      results.push({ page: pagePath, error: e.message });
    } finally {
      await page.close();
    }
  }

  pageData[`${label}_axe_accessibility`] = results;
  return results;
}

// ─────────────────────────────────────────────────────────────
// 3. MULTI-LANGUAGE / LOCALE TESTING
// ─────────────────────────────────────────────────────────────

async function runLocaleTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = { hasLanguageSwitcher: false, languages: [], switchWorks: false, issues: [] };

  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // Detect language switcher
    const langData = await page.evaluate(() => {
      const selectors = [
        '[class*="lang"]', '[class*="locale"]', '[class*="language"]',
        'select[name*="lang"]', 'select[name*="locale"]',
        '[data-locale]', '[data-language]',
        'a[hreflang]', '[class*="country-select"]', '[class*="region"]',
      ];
      let switcher = null;
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetHeight > 0) {
          switcher = { selector: sel, tag: el.tagName, text: el.textContent.trim().slice(0, 50) };
          break;
        }
      }

      // Check current lang attribute
      const htmlLang = document.documentElement.getAttribute('lang');
      const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.content;

      // Check for alternate hreflang links
      const hreflangs = [...document.querySelectorAll('link[hreflang]')].map(l => ({
        lang: l.getAttribute('hreflang'),
        href: l.getAttribute('href')
      }));

      // Check page content language consistency
      const bodyText = document.body.innerText.slice(0, 500);

      return { switcher, htmlLang, metaLang, hreflangs, bodyText };
    });

    results.htmlLang = langData.htmlLang;
    results.hreflangs = langData.hreflangs;

    if (langData.switcher) {
      results.hasLanguageSwitcher = true;

      // Try to find language options
      if (langData.switcher.tag === 'SELECT') {
        const options = await page.$$eval(`${langData.switcher.selector} option`, opts =>
          opts.map(o => ({ value: o.value, text: o.textContent.trim() }))
        );
        results.languages = options;

        // Try switching language
        if (options.length > 1) {
          const currentText = await page.evaluate(() => document.body.innerText.slice(0, 200));
          await page.selectOption(langData.switcher.selector, options[1].value);
          await page.waitForTimeout(3000);
          const newText = await page.evaluate(() => document.body.innerText.slice(0, 200));

          results.switchWorks = currentText !== newText;
          if (!results.switchWorks) {
            results.issues.push('Language switcher exists but content does not change');
            bugs.push({
              id: bugs.length + 1, severity: 'Medium',
              category: 'i18n/Locale', title: `Language Switcher Does Not Change Content`,
              description: `Language switcher exists with ${options.length} options but switching to "${options[1].text}" does not change page content.`,
              site: sn, fix: 'Ensure language switcher actually translates content or redirects to localized URL',
              testType: 'Locale', location: '/',
              steps: `1. Open ${siteUrl}\n2. Find language switcher\n3. Change language to "${options[1].text}"\n4. Content remains the same`,
              expected: 'Page content should change to selected language', actual: 'Content remains unchanged'
            });
          }
        }
      } else {
        // Click-based language switcher
        try {
          await page.click(langData.switcher.selector);
          await page.waitForTimeout(1000);
          const dropdown = await page.evaluate(() => {
            const items = document.querySelectorAll('[class*="lang"] li, [class*="locale"] li, [class*="language"] a');
            return [...items].slice(0, 5).map(i => i.textContent.trim());
          });
          results.languages = dropdown.map(t => ({ text: t }));
        } catch {}
      }
    }

    // Check for missing lang attribute
    if (!langData.htmlLang) {
      bugs.push({
        id: bugs.length + 1, severity: 'Medium',
        category: 'Accessibility', title: `Missing lang Attribute on <html>`,
        description: `The <html> element does not have a lang attribute. This is required for screen readers and SEO.`,
        site: sn, fix: 'Add lang="en" (or appropriate locale) to <html> tag',
        testType: 'Locale', location: '/',
        steps: `1. Open ${siteUrl}\n2. Inspect <html> tag\n3. No lang attribute present`,
        expected: '<html lang="en">', actual: '<html> without lang attribute'
      });
    }

    // Check for missing hreflang tags (if site has language switcher)
    if (results.hasLanguageSwitcher && langData.hreflangs.length === 0) {
      bugs.push({
        id: bugs.length + 1, severity: 'Low',
        category: 'SEO/Meta', title: `No hreflang Tags Despite Language Switcher`,
        description: `Site has a language switcher but no <link rel="alternate" hreflang="..."> tags for SEO.`,
        site: sn, fix: 'Add hreflang tags for each supported language in <head>',
        testType: 'Locale', location: '/',
        steps: `1. Open ${siteUrl}\n2. Check <head> for hreflang links\n3. None found`,
        expected: 'hreflang tags for each language', actual: 'No hreflang tags'
      });
    }

    screenshots[`${label}_locale`] = b64(await page.screenshot());
  } catch (e) {
    results.error = e.message;
  } finally {
    await page.close();
  }

  pageData[`${label}_locale_test`] = results;
  return results;
}

// ─────────────────────────────────────────────────────────────
// 4. API RESPONSE VALIDATION — Intercept & validate XHR/fetch
// ─────────────────────────────────────────────────────────────

async function runAPIValidation(browser, siteUrl, label, pagePaths, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const allApiCalls = [];
  const testPages = (pagePaths || ['/', '/products', '/cart']).slice(0, 5);

  for (const pagePath of testPages) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const apiCalls = [];

    try {
      // Intercept all API responses
      page.on('response', async (response) => {
        const url = response.url();
        const isAPI = url.includes('/api/') || url.includes('/v1/') || url.includes('/v2/') ||
          url.includes('/graphql') || url.includes('.json') ||
          url.includes('/rest/') || url.includes('/service/');
        const isStatic = url.includes('.js') || url.includes('.css') || url.includes('.png') ||
          url.includes('.jpg') || url.includes('.svg') || url.includes('.woff') ||
          url.includes('.ico') || url.includes('.gif');

        if (isAPI && !isStatic) {
          const status = response.status();
          const timing = await response.request().timing().catch(() => null);
          const entry = {
            url: url.substring(0, 200),
            status,
            method: response.request().method(),
            responseTime: timing ? Math.round(timing.responseEnd) : null,
            page: pagePath,
            isError: status >= 400,
            isSlow: timing && timing.responseEnd > 3000,
          };

          // Try to check response body for malformed JSON (only for JSON APIs)
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('json') && status < 400) {
            try {
              const body = await response.text();
              JSON.parse(body);
              entry.validJSON = true;
            } catch {
              entry.validJSON = false;
              entry.malformedJSON = true;
            }
          }

          apiCalls.push(entry);
        }
      });

      await page.goto(siteUrl + pagePath, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      // Trigger some interactions to capture more API calls
      await page.evaluate(() => { window.scrollTo(0, document.body.scrollHeight / 2); });
      await page.waitForTimeout(1500);

      allApiCalls.push(...apiCalls);
    } catch (e) {
      // Page load failed, still process any captured API calls
      allApiCalls.push(...apiCalls);
    } finally {
      await page.close();
    }
  }

  // Analyze API calls
  const errorAPIs = allApiCalls.filter(a => a.isError);
  const slowAPIs = allApiCalls.filter(a => a.isSlow);
  const malformedAPIs = allApiCalls.filter(a => a.malformedJSON);

  // Report 4xx/5xx API errors
  if (errorAPIs.length > 0) {
    const errors4xx = errorAPIs.filter(a => a.status >= 400 && a.status < 500);
    const errors5xx = errorAPIs.filter(a => a.status >= 500);

    if (errors5xx.length > 0) {
      const list = errors5xx.slice(0, 5).map((a, i) => `${i + 1}. ${a.method} ${a.url} → ${a.status} (page: ${a.page})`).join('\n');
      bugs.push({
        id: bugs.length + 1, severity: 'Critical',
        category: 'API', title: `${errors5xx.length} Server Error API(s) (5xx)`,
        description: `${errors5xx.length} API endpoint(s) returned server errors:\n\n${list}`,
        site: sn, fix: 'Check server logs for these failing endpoints. Fix backend errors.',
        testType: 'API Validation', location: 'Multiple pages',
        steps: `1. Navigate to affected pages\n2. Open Network tab\n3. Filter by XHR/Fetch\n${list}`,
        expected: 'All APIs return 2xx responses', actual: `${errors5xx.length} APIs return 5xx`
      });
    }

    if (errors4xx.length > 3) {
      const list = errors4xx.slice(0, 5).map((a, i) => `${i + 1}. ${a.method} ${a.url} → ${a.status}`).join('\n');
      bugs.push({
        id: bugs.length + 1, severity: 'High',
        category: 'API', title: `${errors4xx.length} Client Error API(s) (4xx)`,
        description: `${errors4xx.length} API endpoint(s) returned client errors:\n\n${list}`,
        site: sn, fix: 'Check if endpoints are correct. Update deprecated API URLs.',
        testType: 'API Validation', location: 'Multiple pages',
        steps: `1. Navigate to affected pages\n2. Open Network tab\n${list}`,
        expected: 'All APIs return successful responses', actual: `${errors4xx.length} APIs return 4xx`
      });
    }
  }

  // Report slow APIs
  if (slowAPIs.length > 0) {
    const list = slowAPIs.slice(0, 5).map((a, i) => `${i + 1}. ${a.method} ${a.url} → ${a.responseTime}ms`).join('\n');
    bugs.push({
      id: bugs.length + 1, severity: 'High',
      category: 'Performance', title: `${slowAPIs.length} Slow API(s) (>3s response)`,
      description: `${slowAPIs.length} API endpoint(s) took over 3 seconds to respond:\n\n${list}`,
      site: sn, fix: 'Optimize slow queries, add caching, paginate large responses',
      testType: 'API Validation', location: 'Multiple pages',
      steps: `1. Navigate to affected pages\n2. Check Network timing\n${list}`,
      expected: 'API responses < 1s', actual: `${slowAPIs.length} APIs > 3s`
    });
  }

  // Report malformed JSON
  if (malformedAPIs.length > 0) {
    const list = malformedAPIs.slice(0, 3).map((a, i) => `${i + 1}. ${a.method} ${a.url}`).join('\n');
    bugs.push({
      id: bugs.length + 1, severity: 'High',
      category: 'API', title: `${malformedAPIs.length} API(s) Return Malformed JSON`,
      description: `${malformedAPIs.length} API endpoint(s) return invalid JSON responses:\n\n${list}`,
      site: sn, fix: 'Fix JSON serialization in these API endpoints',
      testType: 'API Validation', location: 'Multiple pages',
      steps: `1. Call the affected APIs\n2. Parse response as JSON\n3. JSON.parse fails\n${list}`,
      expected: 'Valid JSON responses', actual: 'Malformed JSON'
    });
  }

  pageData[`${label}_api_validation`] = {
    totalCalls: allApiCalls.length,
    errors: errorAPIs.length,
    slow: slowAPIs.length,
    malformed: malformedAPIs.length,
    calls: allApiCalls.slice(0, 20)
  };

  return allApiCalls;
}

// ─────────────────────────────────────────────────────────────
// 5. CART PERSISTENCE ACROSS VIEWPORTS
// ─────────────────────────────────────────────────────────────

async function runCartPersistenceTest(browser, siteUrl, label, discovery, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const results = { addedOnMobile: false, persistedOnDesktop: false, issues: [] };

  // Step 1: Add to cart on mobile viewport
  const mobileContext = await browser.newContext({
    viewport: { width: 393, height: 852 },
    isMobile: true,
    userAgent: devices['iPhone 14 Pro']?.userAgent
  });
  const mobilePage = await mobileContext.newPage();

  try {
    // Go to PLP and find a product
    await mobilePage.goto(siteUrl + '/products', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await mobilePage.waitForTimeout(2000);

    // Click first product
    const productLink = await mobilePage.evaluate(() => {
      const link = document.querySelector('a[href*="/product/"], a[href*="/p/"], [class*="product"] a, [class*="card"] a');
      return link ? link.getAttribute('href') : null;
    });

    if (productLink) {
      const fullUrl = productLink.startsWith('http') ? productLink : siteUrl + productLink;
      await mobilePage.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await mobilePage.waitForTimeout(2000);

      // Try to add to cart
      const addBtn = mobilePage.locator('button:has-text("Add to"), button:has-text("ADD TO"), button:has-text("Buy"), button:has-text("BUY"), [class*="add-to-cart"], [class*="add-to-bag"]').first();
      if (await addBtn.isVisible().catch(() => false)) {
        // Try to select size first
        const sizeBtn = mobilePage.locator('[class*="size"] button, [class*="size"] label, [class*="variant"] button').first();
        if (await sizeBtn.isVisible().catch(() => false)) {
          await sizeBtn.click();
          await mobilePage.waitForTimeout(500);
        }

        await addBtn.click();
        await mobilePage.waitForTimeout(2000);
        results.addedOnMobile = true;
        screenshots[`${label}_cart_persist_mobile_add`] = b64(await mobilePage.screenshot());

        // Get cookies/storage to share session
        const cookies = await mobileContext.cookies();
        const storage = await mobilePage.evaluate(() => {
          const data = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            data[key] = localStorage.getItem(key);
          }
          return data;
        });

        // Step 2: Check cart on desktop viewport
        const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await desktopContext.addCookies(cookies);
        const desktopPage = await desktopContext.newPage();

        // Restore localStorage
        await desktopPage.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await desktopPage.evaluate((storageData) => {
          for (const [key, value] of Object.entries(storageData)) {
            localStorage.setItem(key, value);
          }
        }, storage);

        // Navigate to cart
        await desktopPage.goto(siteUrl + '/cart/bag', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(async () => {
          await desktopPage.goto(siteUrl + '/cart', { waitUntil: 'domcontentloaded', timeout: 20000 });
        });
        await desktopPage.waitForTimeout(2000);

        // Check if cart has items
        const cartHasItems = await desktopPage.evaluate(() => {
          const emptyIndicators = document.querySelectorAll('[class*="empty"], [class*="no-item"]');
          const cartItems = document.querySelectorAll('[class*="cart-item"], [class*="bag-item"], [class*="product-item"]');
          const bodyText = document.body.innerText.toLowerCase();
          const isEmpty = emptyIndicators.length > 0 || bodyText.includes('empty') || bodyText.includes('no items');
          return { isEmpty, itemCount: cartItems.length };
        });

        results.persistedOnDesktop = !cartHasItems.isEmpty || cartHasItems.itemCount > 0;
        screenshots[`${label}_cart_persist_desktop_check`] = b64(await desktopPage.screenshot());

        if (!results.persistedOnDesktop) {
          results.issues.push('Cart items added on mobile not visible on desktop');
          bugs.push({
            id: bugs.length + 1, severity: 'High',
            category: 'E-Commerce', title: `Cart Not Persisted Across Viewports`,
            description: `Items added to cart on mobile (iPhone 14 Pro) are not visible when viewing cart on desktop (1440x900). Cart state should be session-based, not viewport-dependent.`,
            site: sn, fix: 'Ensure cart is stored server-side or in cookies/localStorage that work across viewports',
            testType: 'Cart Persistence', location: '/cart',
            steps: `1. Open ${siteUrl}/products on iPhone (393x852)\n2. Add a product to cart\n3. Open ${siteUrl}/cart on Desktop (1440x900)\n4. Cart appears empty`,
            expected: 'Cart items persist across viewports', actual: 'Cart empty on desktop after adding on mobile'
          });
        }

        await desktopPage.close();
        await desktopContext.close();
      }
    }
  } catch (e) {
    results.error = e.message;
  } finally {
    await mobilePage.close();
    await mobileContext.close();
  }

  pageData[`${label}_cart_persistence`] = results;
  return results;
}

// ─────────────────────────────────────────────────────────────
// 6. INPUT VALIDATION & SECURITY TESTING
// ─────────────────────────────────────────────────────────────

async function runInputSecurityTest(browser, siteUrl, label, bugs, pageData, screenshots) {
  const sn = siteName(label, siteUrl);
  const results = { searchXSS: false, searchSQLi: false, phoneValidation: false, emailValidation: false, issues: [] };

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    // ── Test 1: Search XSS ──
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], [class*="search"] input').first();
    if (await searchInput.isVisible().catch(() => false)) {
      // XSS payload test
      const xssPayload = '<script>alert("xss")</script>';
      await searchInput.fill(xssPayload);
      await searchInput.press('Enter');
      await page.waitForTimeout(2000);

      const hasXSSReflection = await page.evaluate((payload) => {
        return document.body.innerHTML.includes(payload) || document.body.innerHTML.includes('<script>alert');
      }, xssPayload);

      if (hasXSSReflection) {
        results.searchXSS = true;
        results.issues.push('XSS payload reflected in search results');
        bugs.push({
          id: bugs.length + 1, severity: 'Critical',
          category: 'Security', title: `Reflected XSS in Search`,
          description: `Search input reflects unescaped HTML/script content. The XSS payload "<script>alert('xss')</script>" appears in the DOM without sanitization.`,
          site: sn, fix: 'Sanitize and HTML-encode all user input before rendering. Use DOMPurify or framework auto-escaping.',
          testType: 'Security', location: '/search',
          steps: `1. Open ${siteUrl}\n2. Search for: ${xssPayload}\n3. Payload is reflected in page HTML`,
          expected: 'Input should be sanitized/escaped', actual: 'Script tag reflected in DOM'
        });
      }
      screenshots[`${label}_security_xss`] = b64(await page.screenshot());

      // SQL injection test (informational — just check for error messages)
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1000);
      const searchInput2 = page.locator('input[type="search"], input[placeholder*="search" i], [class*="search"] input').first();
      if (await searchInput2.isVisible().catch(() => false)) {
        const sqliPayload = "' OR 1=1 --";
        await searchInput2.fill(sqliPayload);
        await searchInput2.press('Enter');
        await page.waitForTimeout(2000);

        const hasSQLError = await page.evaluate(() => {
          const text = document.body.innerText.toLowerCase();
          return text.includes('sql syntax') || text.includes('mysql') || text.includes('postgresql') ||
            text.includes('sqlite') || text.includes('syntax error') || text.includes('unclosed quotation') ||
            text.includes('unterminated string');
        });

        if (hasSQLError) {
          results.searchSQLi = true;
          results.issues.push('SQL error message exposed in search');
          bugs.push({
            id: bugs.length + 1, severity: 'Critical',
            category: 'Security', title: `Potential SQL Injection in Search`,
            description: `Search input with SQL payload ("' OR 1=1 --") triggers a database error message, indicating potential SQL injection vulnerability.`,
            site: sn, fix: 'Use parameterized queries/prepared statements. Never interpolate user input into SQL.',
            testType: 'Security', location: '/search',
            steps: `1. Open ${siteUrl}\n2. Search for: ' OR 1=1 --\n3. SQL error message appears`,
            expected: 'No database error messages exposed', actual: 'SQL syntax error visible to user'
          });
        }
        screenshots[`${label}_security_sqli`] = b64(await page.screenshot());
      }
    }

    // ── Test 2: Phone Number Validation ──
    await page.goto(siteUrl + '/auth/login', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const phoneInput = page.locator('input[type="tel"], input[name*="phone" i], input[name*="mobile" i], input[placeholder*="phone" i], input[placeholder*="mobile" i]').first();
    if (await phoneInput.isVisible().catch(() => false)) {
      // Test with invalid phone
      const invalidPhones = ['abc', '12345', '0000000000', '+1-555-INVALID'];
      for (const invalidPhone of invalidPhones) {
        await phoneInput.fill(invalidPhone);
        await page.waitForTimeout(500);

        // Try to submit
        const submitBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Login"), button:has-text("Send"), button:has-text("Get OTP")').first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(1500);

          const hasValidation = await page.evaluate(() => {
            const errorEls = document.querySelectorAll('[class*="error"], [class*="invalid"], [role="alert"]');
            return errorEls.length > 0 || document.querySelector('input:invalid') !== null;
          });

          if (!hasValidation && invalidPhone === 'abc') {
            results.phoneValidation = true;
            results.issues.push('Phone field accepts non-numeric input');
            bugs.push({
              id: bugs.length + 1, severity: 'Medium',
              category: 'Form Validation', title: `Phone Field Accepts Invalid Input`,
              description: `Login phone field accepts non-numeric input "${invalidPhone}" without validation error.`,
              site: sn, fix: 'Add client-side phone number validation. Restrict input to digits only, validate format.',
              testType: 'Input Validation', location: '/auth/login',
              steps: `1. Open ${siteUrl}/auth/login\n2. Enter "${invalidPhone}" in phone field\n3. Click submit\n4. No validation error shown`,
              expected: 'Error message for invalid phone number', actual: 'No validation — form accepts invalid input'
            });
          }
          break;
        }
      }
      screenshots[`${label}_security_phone`] = b64(await page.screenshot());
    }

    // ── Test 3: Address Field XSS ──
    await page.goto(siteUrl + '/profile/address', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(async () => {
      await page.goto(siteUrl + '/address', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    });
    await page.waitForTimeout(1500);

    const addressInput = page.locator('input[name*="address" i], textarea[name*="address" i], input[placeholder*="address" i]').first();
    if (await addressInput.isVisible().catch(() => false)) {
      const xssAddress = '<img src=x onerror=alert(1)>';
      await addressInput.fill(xssAddress);
      await page.waitForTimeout(500);

      const reflected = await page.evaluate((payload) => {
        return document.body.innerHTML.includes('onerror=alert');
      }, xssAddress);

      if (reflected) {
        results.issues.push('XSS payload reflected in address field');
        bugs.push({
          id: bugs.length + 1, severity: 'High',
          category: 'Security', title: `XSS in Address Input Field`,
          description: `Address field reflects unsanitized HTML input. Malicious script could execute.`,
          site: sn, fix: 'Sanitize all user inputs. Use Content-Security-Policy headers.',
          testType: 'Security', location: '/profile/address',
          steps: `1. Open address form\n2. Enter: ${xssAddress}\n3. Payload reflected in DOM`,
          expected: 'Input sanitized/escaped', actual: 'HTML reflected without encoding'
        });
      }
    }
  } catch (e) {
    results.error = e.message;
  } finally {
    await page.close();
  }

  pageData[`${label}_input_security`] = results;
  return results;
}

// ─────────────────────────────────────────────────────────────
// 7. TEST PRIORITY EXECUTION ORDER
// ─────────────────────────────────────────────────────────────

function buildPriorityOrder(testPlan, loginResult) {
  // Priority groups: tests that should run first, and dependencies
  const priorities = {
    critical: [], // Must run first
    high: [],     // Run after critical
    standard: [], // Run after high
    low: [],      // Run last or skip if budget exceeded
  };

  for (const test of testPlan) {
    // Critical priority: login, checkout, payment
    if (test.type === 'auth' || test.subtype === 'login_flow' || test.subtype === 'login_scroll') {
      priorities.critical.push(test);
    } else if (test.type === 'cart_checkout' || test.type === 'payment') {
      priorities.critical.push(test);
    }
    // High priority: e-commerce, search, PDP
    else if (test.type === 'ecommerce' || test.type === 'search_deep' || test.type === 'pdp_deep') {
      priorities.high.push(test);
    }
    // Standard: everything else functional
    else if (test.type === 'sanity' || test.type === 'performance' || test.type === 'accessibility' ||
      test.type === 'links' || test.type === 'forms' || test.type === 'session' ||
      test.type === 'order_lifecycle' || test.type === 'pricing' || test.type === 'race_condition') {
      priorities.standard.push(test);
    }
    // Low: visual, comparison, exploratory
    else {
      priorities.low.push(test);
    }
  }

  // If login failed, skip dependent tests
  const skipDependents = loginResult && !loginResult.loggedIn;
  const dependentTypes = ['session', 'order_lifecycle', 'payment', 'pricing'];

  return {
    priorities,
    shouldSkip(testType) {
      return skipDependents && dependentTypes.includes(testType);
    },
    getSkipReason(testType) {
      if (skipDependents && dependentTypes.includes(testType)) {
        return 'Skipped — login failed (dependency)';
      }
      return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────
// 8. ENHANCED REPORT DATA — Bug distribution, charts, filters
// ─────────────────────────────────────────────────────────────

function generateEnhancedReportData(bugs, pageData) {
  // Bug distribution by test type
  const byTestType = {};
  const byPage = {};
  const timeline = [];

  for (const b of bugs) {
    const tt = b.testType || 'Other';
    if (!byTestType[tt]) byTestType[tt] = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    byTestType[tt].total++;
    byTestType[tt][b.severity.toLowerCase()]++;

    const loc = b.location || 'unknown';
    if (!byPage[loc]) byPage[loc] = { total: 0, critical: 0, high: 0, medium: 0, low: 0 };
    byPage[loc].total++;
    byPage[loc][b.severity.toLowerCase()]++;
  }

  // Sort pages by bug count (descending)
  const hotspots = Object.entries(byPage)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .map(([page, counts]) => ({ page, ...counts }));

  // Calculate severity ratio
  const critical = bugs.filter(b => b.severity === 'Critical').length;
  const high = bugs.filter(b => b.severity === 'High').length;
  const total = bugs.length || 1;
  const healthScore = Math.max(0, 100 - (critical * 15) - (high * 8) - ((bugs.length - critical - high) * 2));

  return {
    byTestType,
    hotspots,
    healthScore: Math.min(100, healthScore),
    categoryCount: Object.keys(byTestType).length,
    avgBugsPerPage: hotspots.length > 0 ? Math.round(bugs.length / hotspots.length * 10) / 10 : 0,
  };
}

function generateEnhancedReportHTML(enhancedData, counts) {
  let html = '';

  // Health Score
  const scoreColor = enhancedData.healthScore >= 70 ? '#22c55e' : enhancedData.healthScore >= 40 ? '#f59e0b' : '#ef4444';
  html += `<div style="display:grid;grid-template-columns:200px 1fr;gap:24px;margin-bottom:24px;align-items:center;">`;
  html += `<div style="text-align:center;">
    <div style="width:120px;height:120px;border-radius:50%;border:6px solid ${scoreColor};display:flex;align-items:center;justify-content:center;margin:0 auto;">
      <div><div style="font-size:36px;font-weight:800;color:${scoreColor};">${enhancedData.healthScore}</div><div style="font-size:10px;color:var(--text3);">HEALTH</div></div>
    </div>
  </div>`;

  // Bug hotspots
  html += `<div>
    <h4 style="margin-bottom:12px;color:var(--text2);">Bug Hotspots (Top Pages)</h4>`;
  for (const h of enhancedData.hotspots.slice(0, 5)) {
    const pct = Math.round((h.total / (counts.total || 1)) * 100);
    html += `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
      <span style="width:150px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${h.page}">${h.page}</span>
      <div style="flex:1;background:var(--bg5);border-radius:4px;height:16px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;display:flex;">
          ${h.critical ? `<div style="height:100%;width:${(h.critical/h.total)*100}%;background:#ef4444;"></div>` : ''}
          ${h.high ? `<div style="height:100%;width:${(h.high/h.total)*100}%;background:#f59e0b;"></div>` : ''}
          ${h.medium ? `<div style="height:100%;width:${(h.medium/h.total)*100}%;background:#3b82f6;"></div>` : ''}
          ${h.low ? `<div style="height:100%;width:${(h.low/h.total)*100}%;background:#22c55e;"></div>` : ''}
        </div>
      </div>
      <span style="font-size:11px;color:var(--text3);min-width:30px;">${h.total}</span>
    </div>`;
  }
  html += `</div></div>`;

  // Bug distribution by test type
  html += `<h4 style="margin:16px 0 12px;color:var(--text2);">Bugs by Test Type</h4>`;
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;">`;
  for (const [type, data] of Object.entries(enhancedData.byTestType)) {
    html += `<div style="background:var(--bg3);border-radius:8px;padding:12px;border:1px solid var(--border);text-align:center;">
      <div style="font-size:20px;font-weight:800;color:var(--text);">${data.total}</div>
      <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:4px;">${type}</div>
      <div style="font-size:9px;color:var(--text3);margin-top:4px;">
        ${data.critical ? `<span style="color:#ef4444">${data.critical}C</span> ` : ''}
        ${data.high ? `<span style="color:#f59e0b">${data.high}H</span> ` : ''}
        ${data.medium ? `<span style="color:#3b82f6">${data.medium}M</span> ` : ''}
        ${data.low ? `<span style="color:#22c55e">${data.low}L</span>` : ''}
      </div>
    </div>`;
  }
  html += `</div>`;

  return html;
}

// Enhanced filter/sort JavaScript for the report
function getEnhancedFilterJS() {
  return `
/* Enhanced filtering — severity + category + test type */
function filterByCategory(cat) {
  document.querySelectorAll('#all-bugs .bug-card').forEach(c => {
    if (cat === 'all') { c.classList.remove('hidden'); return; }
    c.classList.toggle('hidden', c.dataset.category !== cat);
  });
  document.querySelectorAll('.cat-filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

function filterByTestType(type) {
  document.querySelectorAll('#all-bugs .bug-card').forEach(c => {
    if (type === 'all') { c.classList.remove('hidden'); return; }
    c.classList.toggle('hidden', c.dataset.type !== type);
  });
  document.querySelectorAll('.type-filter-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
}

function sortBugs(criteria) {
  const container = document.querySelector('#all-bugs .sec-b');
  const cards = [...container.querySelectorAll('.bug-card')];
  const sevOrder = { Critical: 0, High: 1, Medium: 2, Low: 3 };

  cards.sort((a, b) => {
    if (criteria === 'severity') return sevOrder[a.dataset.severity] - sevOrder[b.dataset.severity];
    if (criteria === 'category') return (a.dataset.category || '').localeCompare(b.dataset.category || '');
    if (criteria === 'type') return (a.dataset.type || '').localeCompare(b.dataset.type || '');
    return 0;
  });

  const filters = container.querySelector('.filters');
  // Remove all bug cards, re-append in order
  cards.forEach(c => c.remove());
  cards.forEach(c => container.appendChild(c));
}

/* Export bugs to CSV */
function exportCSV() {
  const cards = document.querySelectorAll('#all-bugs .bug-card');
  let csv = 'ID,Severity,Category,TestType,Title,Location,Description,Fix\\n';
  cards.forEach(c => {
    const rows = c.querySelectorAll('.bug-detail-table tr');
    const data = {};
    rows.forEach(r => {
      const field = r.querySelector('.bug-field');
      const val = r.querySelector('td:last-child');
      if (field && val) data[field.textContent.trim().toLowerCase()] = val.textContent.trim().replace(/"/g, "'").replace(/\\n/g, ' ');
    });
    const title = c.querySelector('h3')?.textContent?.trim()?.replace(/"/g, "'") || '';
    csv += '"' + [data.severity || '', data.category || '', data.type || '', title, data.location || '', data.description || '', data.fix || ''].join('","') + '"\\n';
  });
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'bug-report.csv';
  a.click();
}
`;
}

module.exports = {
  // Test functions
  runCoreWebVitals,
  runAxeAccessibility,
  runLocaleTest,
  runAPIValidation,
  runCartPersistenceTest,
  runInputSecurityTest,
  // Utility functions
  buildPriorityOrder,
  generateEnhancedReportData,
  generateEnhancedReportHTML,
  getEnhancedFilterJS,
};
