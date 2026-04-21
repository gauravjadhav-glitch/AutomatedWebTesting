'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runExploratoryTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDC12', '--- Exploratory / Monkey Tests ---');
  const pagesToExplore = discovery.livePages.slice(0, 5);
  const jsErrors = [];

  // Capture JS errors during exploratory run
  page.on('pageerror', err => jsErrors.push({ page: page.url(), error: err.message }));

  for (const pg of pagesToExplore) {
    if (ctx.isBudgetExceeded()) break;
    try {
      await safeGoto(page, pg.url);
      await page.waitForTimeout(1000);

      // -- Test 1: Rapid clicking -- find race conditions / double-submit bugs --
      ctx.testResults.total++;
      const clickables = await page.$$('a, button, [role="button"], [onclick]');
      const rapidErrors = [];
      for (const el of clickables.slice(0, 8)) {
        try {
          const box = await el.boundingBox();
          if (!box || box.width < 5 || box.height < 5) continue;
          // Double-click rapidly
          await el.click({ timeout: 2000 }).catch(() => {});
          await el.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(200);
        } catch (e) {
          rapidErrors.push(e.message.slice(0, 80));
        }
      }
      // Navigate back to the test page after clicks may have navigated away
      if (page.url() !== pg.url) await safeGoto(page, pg.url);

      if (rapidErrors.length > 3) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `exploratory_rapid_${pg.path.replace(/\//g, '_') || 'home'}`);
        addBug(ctx, 'Medium', 'Exploratory', `Rapid click issues on ${pg.path}`, `${rapidErrors.length} errors during rapid clicking: ${rapidErrors.slice(0, 3).join('; ')}`, `${pg.path} \u2014 Desktop`, ['1. Open ' + pg.url, '2. Rapidly click interactive elements'], 'No errors on rapid clicks', `${rapidErrors.length} errors occurred`, ss, 'Add debounce/throttle to click handlers and prevent double-submit');
      } else {
        ctx.testResults.passed++;
      }

      // -- Test 2: Random input in text fields --
      ctx.testResults.total++;
      const inputs = await page.$$('input[type="text"], input[type="search"], input[type="email"], input:not([type]), textarea');
      const fuzzStrings = ['<script>alert(1)</script>', '\uD83D\uDCA9\uD83D\uDD25\uD83C\uDF89', "' OR 1=1 --", 'a'.repeat(500), '   ', '../../etc/passwd', '{{constructor.constructor("return this")()}}'];
      let inputCrash = false;
      for (const input of inputs.slice(0, 4)) {
        try {
          const fuzz = fuzzStrings[Math.floor(Math.random() * fuzzStrings.length)];
          await input.fill('');
          await input.type(fuzz, { delay: 10 });
          await page.waitForTimeout(300);
        } catch (e) {
          inputCrash = true;
        }
      }
      if (inputCrash) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `exploratory_input_${pg.path.replace(/\//g, '_') || 'home'}`);
        addBug(ctx, 'High', 'Exploratory', `Input fuzzing crash on ${pg.path}`, 'Page crashed or threw errors when unexpected input was entered in text fields', `${pg.path} \u2014 Desktop`, ['1. Enter special characters in input fields', '2. Enter very long strings', '3. Enter XSS/SQL payloads'], 'Graceful handling of unexpected input', 'Page crashed or errored', ss, 'Add input validation and sanitization');
      } else {
        ctx.testResults.passed++;
      }

      // Navigate back clean
      await safeGoto(page, pg.url);

      // -- Test 3: Back/Forward navigation --
      ctx.testResults.total++;
      try {
        // Navigate to a second page, then back, then forward
        const secondPage = pagesToExplore.find(p => p.url !== pg.url);
        if (secondPage) {
          await safeGoto(page, secondPage.url);
          await page.waitForTimeout(500);
          await page.goBack({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          const backUrl = page.url();
          await page.goForward({ timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1000);
          const forwardUrl = page.url();

          // Check if the page looks broken after back/forward
          const isBroken = await page.evaluate(() => {
            return document.body.innerText.length < 50 || document.title === '' || document.querySelectorAll('img[src=""],img:not([src])').length > 5;
          });

          if (isBroken) {
            ctx.testResults.failed++;
            const ss = await safeScreenshot(ctx, page, `exploratory_backfwd_${pg.path.replace(/\//g, '_') || 'home'}`);
            addBug(ctx, 'High', 'Exploratory', `Page broken after Back/Forward on ${pg.path}`, `Navigating Back \u2192 Forward results in broken page state (empty content or missing images)`, `${pg.path} \u2014 Desktop`, ['1. Navigate from ' + pg.path + ' to another page', '2. Click browser Back', '3. Click browser Forward'], 'Page restores correctly', 'Page appears broken after history navigation', ss, 'Ensure SPA router handles popstate events correctly');
          } else {
            ctx.testResults.passed++;
          }
        } else {
          ctx.testResults.passed++;
        }
      } catch (e) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `exploratory_backfwd_err_${pg.path.replace(/\//g, '_') || 'home'}`);
        addBug(ctx, 'Medium', 'Exploratory', `Back/Forward navigation error on ${pg.path}`, `Error during history navigation: ${e.message.slice(0, 150)}`, `${pg.path} \u2014 Desktop`, ['1. Navigate between pages', '2. Use Back/Forward'], 'Smooth history navigation', `Error: ${e.message.slice(0, 100)}`, ss, 'Fix history/popstate handling');
      }

      // -- Test 4: Scroll chaos -- rapid scrolling up/down --
      ctx.testResults.total++;
      try {
        await safeGoto(page, pg.url);
        const preScrollErrors = jsErrors.length;
        // Rapid scroll: top -> bottom -> top -> middle repeatedly
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await page.waitForTimeout(150);
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForTimeout(150);
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
          await page.waitForTimeout(150);
        }
        const postScrollErrors = jsErrors.length - preScrollErrors;
        if (postScrollErrors > 0) {
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, `exploratory_scroll_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug(ctx, 'Medium', 'Exploratory', `${postScrollErrors} JS error(s) during rapid scroll on ${pg.path}`, `Rapid scrolling triggered ${postScrollErrors} JavaScript errors: ${jsErrors.slice(-3).map(e => e.error.slice(0, 80)).join('; ')}`, `${pg.path} \u2014 Desktop`, ['1. Open ' + pg.url, '2. Scroll up and down rapidly'], 'No JS errors on scroll', `${postScrollErrors} JS errors during scroll`, ss, 'Fix scroll event handlers \u2014 add error boundaries and debouncing');
        } else {
          ctx.testResults.passed++;
          log(ctx, '\u2705', `Exploratory: Rapid scroll OK on ${pg.path}`);
        }
      } catch (e) {
        ctx.testResults.skipped++;
      }

      // -- Test 5: Resize viewport rapidly -- responsive layout stress test --
      ctx.testResults.total++;
      try {
        const breakpoints = [
          { width: 375, height: 812 },   // iPhone SE
          { width: 1920, height: 1080 }, // Full HD
          { width: 768, height: 1024 },  // iPad
          { width: 320, height: 568 },   // iPhone 5
          { width: 2560, height: 1440 }, // QHD
          { width: 1440, height: 900 },  // Default
        ];
        let resizeErrors = 0;
        for (const bp of breakpoints) {
          await page.setViewportSize(bp);
          await page.waitForTimeout(300);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 10);
          if (overflow) resizeErrors++;
        }
        // Reset viewport
        await page.setViewportSize({ width: 1440, height: 900 });

        if (resizeErrors >= 3) {
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, `exploratory_resize_${pg.path.replace(/\//g, '_') || 'home'}`);
          addBug(ctx, 'High', 'Exploratory', `Layout breaks at ${resizeErrors} breakpoints on ${pg.path}`, `Page has horizontal overflow at ${resizeErrors}/6 tested viewport sizes \u2014 responsive design is unstable`, `${pg.path} \u2014 Multiple viewports`, ['1. Resize browser to various widths (320-2560px)', '2. Check for horizontal overflow'], 'No overflow at any viewport', `Overflow at ${resizeErrors} breakpoints`, ss, 'Use responsive CSS with max-width:100%, overflow-x:hidden, and test at all breakpoints');
        } else {
          ctx.testResults.passed++;
          log(ctx, '\u2705', `Exploratory: Resize test OK on ${pg.path} (${resizeErrors} overflows)`);
        }
      } catch (e) {
        ctx.testResults.skipped++;
        await page.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
      }
    } catch (e) {
      log(ctx, '\u26A0\uFE0F', `Exploratory test failed on ${pg.path}: ${e.message.slice(0, 80)}`);
    }
  }

  // -- Test 6: Global JS error summary --
  ctx.testResults.total++;
  if (jsErrors.length > 0) {
    ctx.testResults.failed++;
    const uniqueErrors = [...new Set(jsErrors.map(e => e.error.slice(0, 100)))];
    const ss = await safeScreenshot(ctx, page, 'exploratory_js_errors');
    addBug(ctx, jsErrors.length > 10 ? 'High' : 'Medium', 'Exploratory', `${jsErrors.length} JS errors during exploratory testing`, `${uniqueErrors.length} unique JS errors caught during monkey testing:\n${uniqueErrors.slice(0, 5).map((e, i) => `${i + 1}. ${e}`).join('\n')}`, 'Multiple pages', ['1. Interact chaotically with the site', '2. Monitor console for errors'], 'No unhandled JS errors', `${jsErrors.length} errors across ${pagesToExplore.length} pages`, ss, 'Add global error handlers and fix unhandled exceptions');
  } else {
    ctx.testResults.passed++;
    log(ctx, '\u2705', 'Exploratory: No JS errors caught during monkey testing');
  }

  // Remove the error listener
  page.removeAllListeners('pageerror');
  log(ctx, '\uD83D\uDC12', `Exploratory tests complete \u2014 ${jsErrors.length} JS errors caught`);
}

module.exports = runExploratoryTests;
