'use strict';

const { log, addBug, safeScreenshot, safeGoto } = require('../utils');

async function runSEOTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD0E', '--- SEO / Meta Tag Tests ---');
  const pagesToTest = discovery.livePages.slice(0, 8);

  for (const pg of pagesToTest) {
    if (ctx.isBudgetExceeded()) break;
    await safeGoto(page, pg.url);
    ctx.testResults.total++;

    const seo = await page.evaluate(() => {
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el ? el.getAttribute('content') : null;
      };
      return {
        title: document.title || '',
        description: getMeta('description'),
        ogTitle: getMeta('og:title'),
        ogDescription: getMeta('og:description'),
        ogImage: getMeta('og:image'),
        canonical: document.querySelector('link[rel="canonical"]')?.href || null,
        h1Count: document.querySelectorAll('h1').length,
        hasViewport: !!document.querySelector('meta[name="viewport"]'),
        hasCharset: !!document.querySelector('meta[charset]'),
        imgsMissingAlt: Array.from(document.querySelectorAll('img')).filter(i => i.offsetWidth > 50 && (!i.alt || !i.alt.trim())).length,
      };
    });

    const issues = [];
    if (!seo.title || seo.title.length < 10) issues.push('Title missing or too short (<10 chars)');
    if (seo.title && seo.title.length > 70) issues.push(`Title too long (${seo.title.length} chars, max 70)`);
    if (!seo.description) issues.push('Missing meta description');
    if (seo.description && seo.description.length > 160) issues.push(`Meta description too long (${seo.description.length} chars)`);
    if (!seo.ogTitle) issues.push('Missing og:title');
    if (!seo.ogImage) issues.push('Missing og:image');
    if (!seo.canonical) issues.push('Missing canonical URL');
    if (seo.h1Count === 0) issues.push('No <h1> tag on page');
    if (seo.h1Count > 1) issues.push(`Multiple <h1> tags (${seo.h1Count})`);
    if (seo.imgsMissingAlt > 0) issues.push(`${seo.imgsMissingAlt} images missing alt text`);

    if (issues.length > 0) {
      ctx.testResults.failed++;
      const ss = await safeScreenshot(ctx, page, `seo_${pg.path.replace(/\//g, '_')}`);
      addBug(ctx, issues.some(i => i.includes('Title missing') || i.includes('No <h1>')) ? 'High' : 'Medium', 'SEO', `SEO issues on ${pg.path} (${issues.length})`, issues.join('; '), `${pg.path} \u2014 Desktop`, ['1. Audit ' + pg.url + ' with SEO checker'], 'Valid meta tags and SEO structure', issues.join('; '), ss, 'Add missing meta tags and fix SEO structure');
    } else {
      ctx.testResults.passed++;
      log(ctx, '\u2705', `SEO: ${pg.path} \u2014 all checks passed`);
    }
  }
}

module.exports = runSEOTests;
