'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runAccessibilityTests(page, discovery, config, ctx) {
  log(ctx, '\u267F', '--- Accessibility Tests ---');
  let AxeBuilder;
  try { AxeBuilder = require('@axe-core/playwright').default; } catch (e) {
    log(ctx, '\u26A0\uFE0F', 'axe-core not available, running manual a11y checks');
  }

  const pagesToTest = discovery.livePages.slice(0, 5);
  for (const pg of pagesToTest) {
    if (ctx.isBudgetExceeded()) break;
    await safeGoto(page, pg.url);
    ctx.testResults.total++;

    if (AxeBuilder) {
      try {
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
        const violations = results.violations || [];
        const critical = violations.filter(v => v.impact === 'critical' || v.impact === 'serious');

        if (critical.length > 0) {
          ctx.testResults.failed++;
          const ss = await safeScreenshot(ctx, page, `a11y_${pg.path.replace(/\//g, '_')}`);
          const desc = critical.slice(0, 5).map(v => `- ${v.help} (${v.impact}, ${v.nodes.length} instances)`).join('\n');
          addBug(ctx, 'High', 'Accessibility', `${critical.length} a11y violations on ${pg.path}`, `Critical/serious WCAG violations:\n${desc}`, `${pg.path} — Desktop`, ['1. Run axe-core audit on ' + pg.path], '0 critical/serious violations', `${critical.length} violations found`, ss, 'Fix WCAG violations: ' + critical[0].help);
        } else {
          ctx.testResults.passed++;
          log(ctx, '\u2705', `A11y: ${pg.path} — ${violations.length} minor issues`);
        }
      } catch (e) {
        ctx.testResults.skipped++;
      }
    } else {
      // Manual checks
      const imgs = await page.$$eval('img:not([alt])', els => els.filter(el => el.offsetWidth > 50).length).catch(() => 0);
      const inputs = await page.$$eval('input:not([aria-label]):not([id])', els => els.filter(el => !el.closest('label')).length).catch(() => 0);
      const langAttr = await page.$eval('html', el => el.getAttribute('lang')).catch(() => null);

      let issues = [];
      if (imgs > 0) issues.push(`${imgs} images missing alt text`);
      if (inputs > 0) issues.push(`${inputs} inputs missing labels`);
      if (!langAttr) issues.push('Missing lang attribute on <html>');

      if (issues.length > 0) {
        ctx.testResults.failed++;
        const ss = await safeScreenshot(ctx, page, `a11y_manual_${pg.path.replace(/\//g, '_')}`);
        addBug(ctx, 'Medium', 'Accessibility', `A11y issues on ${pg.path}`, issues.join('; '), `${pg.path} — Desktop`, ['1. Audit page with accessibility checker'], 'No accessibility issues', issues.join('; '), ss, 'Add missing alt text, labels, and lang attribute');
      } else {
        ctx.testResults.passed++;
      }
    }
  }
}

module.exports = runAccessibilityTests;
