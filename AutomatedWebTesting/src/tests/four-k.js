'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function run4KTests(browser, discovery, config, ctx) {
  log(ctx, '\uD83D\uDDA5\uFE0F', '--- 4K UHD Tests (3840x2160) ---');
  const context = await browser.newContext({ viewport: { width: 3840, height: 2160 } });
  const page = await context.newPage();
  const pagesToTest = discovery.livePages.slice(0, 10);

  for (const pg of pagesToTest) {
    if (ctx.isBudgetExceeded()) break;
    await safeGoto(page, pg.url);
    const ssName = `4k_${pg.path.replace(/\//g, '_') || 'home'}`;
    await safeScreenshot(ctx, page, ssName);

    // 1. Horizontal scroll check
    ctx.testResults.total++;
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    if (scrollW > 3850) {
      ctx.testResults.failed++;
      addBug(ctx, 'Critical', '4K Responsive', `Horizontal scroll at 4K on ${pg.path}`, `scrollWidth (${scrollW}px) > viewport (3840px)`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160'], 'No horizontal overflow', `${scrollW - 3840}px overflow`, ctx.screenshots[ssName], 'Fix CSS max-width at 4K');
    } else { ctx.testResults.passed++; }

    // 2. Nav width check
    ctx.testResults.total++;
    const navWidth = await page.evaluate(() => {
      const nav = document.querySelector('nav, header, [class*="navbar"], [class*="header"]');
      return nav ? nav.getBoundingClientRect().width : 0;
    });
    if (navWidth > 0 && navWidth < 3840 * 0.5) {
      ctx.testResults.failed++;
      addBug(ctx, 'High', '4K Responsive', `Nav covers only ${Math.round(navWidth / 3840 * 100)}% at 4K on ${pg.path}`, `Navigation bar is ${Math.round(navWidth)}px wide on 3840px viewport`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160', '2. Check nav width'], 'Nav covers >50% viewport', `Nav covers ${Math.round(navWidth / 3840 * 100)}%`, ctx.screenshots[ssName], 'Set nav max-width: 100% at large viewports');
    } else { ctx.testResults.passed++; }

    // 3. Blurry images check
    ctx.testResults.total++;
    const blurryImgs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('img')).filter(img => {
        if (!img.src || img.src.startsWith('data:') || img.src.includes('.svg')) return false;
        const rect = img.getBoundingClientRect();
        if (rect.width < 200) return false;
        return img.naturalWidth > 0 && img.naturalWidth < rect.width * 0.5;
      }).length;
    });
    if (blurryImgs > 0) {
      ctx.testResults.failed++;
      addBug(ctx, 'High', 'Image Quality', `${blurryImgs} blurry image(s) at 4K on ${pg.path}`, `Images are upscaled >2x at 4K resolution, appearing blurry`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160', '2. Check image clarity'], 'Sharp images at 4K', `${blurryImgs} blurry images`, ctx.screenshots[ssName], 'Provide higher resolution image assets for 4K displays');
    } else { ctx.testResults.passed++; }

    // 4. Untappable elements check
    ctx.testResults.total++;
    const tinyEls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a, button, input, select, textarea, [role="button"]')).filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.height > 0 && rect.height < 25 && rect.width > 0;
      }).length;
    });
    if (tinyEls >= 2) {
      ctx.testResults.failed++;
      addBug(ctx, 'High', '4K Responsive', `${tinyEls} untappable elements (<25px) at 4K on ${pg.path}`, `Interactive elements too small for touch at 4K resolution`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160'], 'All interactive elements >= 25px', `${tinyEls} elements < 25px`, ctx.screenshots[ssName], 'Increase min-height for interactive elements');
    } else { ctx.testResults.passed++; }

    // 5. Excessive whitespace check
    ctx.testResults.total++;
    const contentRatio = await page.evaluate(() => {
      const body = document.body;
      const contentEls = document.querySelectorAll('img, p, h1, h2, h3, h4, h5, h6, span, a, button, input, table, ul, ol');
      let contentArea = 0;
      contentEls.forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) contentArea += rect.width * rect.height;
      });
      const viewportArea = window.innerWidth * window.innerHeight;
      return contentArea / viewportArea;
    });
    if (contentRatio < 0.4) {
      ctx.testResults.failed++;
      addBug(ctx, 'High', '4K Responsive', `Excessive whitespace at 4K on ${pg.path} (${Math.round(contentRatio * 100)}% content)`, `Content covers less than 40% of 4K viewport`, `${pg.path} — 4K UHD`, ['1. Open at 3840x2160'], 'Content covers >40% of viewport', `Content covers ${Math.round(contentRatio * 100)}%`, ctx.screenshots[ssName], 'Use fluid layouts or max-width containers for 4K');
    } else { ctx.testResults.passed++; }
  }

  await context.close().catch(() => {});
}

module.exports = run4KTests;
