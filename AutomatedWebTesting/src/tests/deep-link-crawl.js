'use strict';

const { log, addBug } = require('../utils');

/**
 * Deep Link Crawl — recursive link crawler that discovers and validates
 * all internal links up to a configurable depth.
 */
async function runDeepLinkCrawlTests(page, discovery, config, ctx) {
  log(ctx, '\uD83D\uDD77\uFE0F', '--- Deep Link Crawl Tests ---');

  const maxDepth = config.mode === 'deep' ? 3 : 2;
  const maxLinks = config.mode === 'deep' ? 200 : 100;
  const siteDomain = new URL(config.targetUrl).hostname;

  const visited = new Set();
  const broken = [];
  const redirects = [];
  const slow = [];

  async function crawl(url, depth) {
    if (depth > maxDepth || visited.size >= maxLinks || ctx.isBudgetExceeded()) return;

    const normalized = url.split('#')[0].split('?')[0].replace(/\/+$/, '');
    if (visited.has(normalized)) return;
    visited.add(normalized);

    try {
      const start = Date.now();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const elapsed = Date.now() - start;

      if (!response) {
        broken.push({ url, status: 0, error: 'No response' });
        return;
      }

      const status = response.status();
      const finalUrl = page.url();

      if (status >= 400) {
        broken.push({ url, status, depth });
      } else if (elapsed > 8000) {
        slow.push({ url, time: elapsed, depth });
      }

      // Track redirects
      if (finalUrl !== url && !finalUrl.includes(url.replace(/\/$/, ''))) {
        redirects.push({ from: url, to: finalUrl, status });
      }

      // Discover links on the page for deeper crawling
      if (depth < maxDepth && status < 400) {
        const links = await page.$$eval('a[href]', (anchors, domain) => {
          return anchors
            .map(a => a.href)
            .filter(href => {
              try {
                const u = new URL(href);
                return u.hostname === domain && !href.match(/\.(pdf|zip|jpg|png|gif|svg|css|js|woff|ttf)$/i);
              } catch { return false; }
            });
        }, siteDomain);

        const uniqueLinks = [...new Set(links)].slice(0, 20);
        for (const link of uniqueLinks) {
          if (visited.size >= maxLinks || ctx.isBudgetExceeded()) break;
          await crawl(link, depth + 1);
        }
      }
    } catch (e) {
      broken.push({ url, status: 0, error: e.message.slice(0, 100) });
    }
  }

  // Start crawling from the homepage
  await crawl(config.targetUrl, 0);

  // Also crawl any pages discovered in Layer 1 that weren't visited
  for (const pg of discovery.livePages) {
    if (visited.size >= maxLinks || ctx.isBudgetExceeded()) break;
    await crawl(pg.url, 1);
  }

  log(ctx, '\uD83D\uDD0D', `Crawled ${visited.size} pages (depth: ${maxDepth})`);

  // Report broken links
  ctx.testResults.total++;
  if (broken.length > 0) {
    ctx.testResults.failed++;
    const brokenList = broken.slice(0, 10).map(b =>
      `${new URL(b.url).pathname}: ${b.status || 'timeout'} ${b.error || ''}`
    ).join('\n');

    addBug(ctx,
      broken.some(b => b.status >= 500) ? 'High' : 'Medium',
      'Broken Links',
      `${broken.length} broken links found in deep crawl`,
      `Crawled ${visited.size} pages (depth ${maxDepth}), found ${broken.length} broken:\n${brokenList}`,
      `Site-wide — ${siteDomain}`,
      ['1. Crawl all internal links recursively', `2. Test each link's HTTP response`],
      'All internal links return 200',
      `${broken.length} links return errors`,
      null,
      'Fix or remove broken links; update any stale references'
    );
  } else {
    ctx.testResults.passed++;
    log(ctx, '\u2705', `Deep crawl: All ${visited.size} pages return valid responses`);
  }

  // Report slow pages
  ctx.testResults.total++;
  if (slow.length > 0) {
    ctx.testResults.failed++;
    const slowList = slow.slice(0, 5).map(s =>
      `${new URL(s.url).pathname}: ${s.time}ms`
    ).join(', ');

    addBug(ctx, 'Medium', 'Performance',
      `${slow.length} slow-loading pages found in deep crawl`,
      `Pages taking >8s to load: ${slowList}`,
      `Site-wide — ${siteDomain}`,
      ['1. Navigate to each page', '2. Measure load time'],
      'All pages load within 8 seconds',
      `${slow.length} pages exceed 8s load time`,
      null,
      'Investigate slow pages for performance bottlenecks'
    );
  } else {
    ctx.testResults.passed++;
    log(ctx, '\u2705', 'Deep crawl: All pages load within acceptable time');
  }

  // Report redirect chains
  if (redirects.length > 3) {
    ctx.testResults.total++;
    ctx.testResults.failed++;
    addBug(ctx, 'Low', 'SEO',
      `${redirects.length} redirects detected in deep crawl`,
      `Redirects: ${redirects.slice(0, 5).map(r => `${new URL(r.from).pathname} → ${new URL(r.to).pathname}`).join(', ')}`,
      `Site-wide — ${siteDomain}`,
      ['1. Crawl site links', '2. Track HTTP redirects'],
      'Minimal redirects for internal links',
      `${redirects.length} redirects found`,
      null,
      'Update internal links to point to final URLs to avoid redirect chains'
    );
  }
}

module.exports = runDeepLinkCrawlTests;
