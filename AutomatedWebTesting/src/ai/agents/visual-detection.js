'use strict';

const { parseJSON } = require('../utils');

async function analyzeScreenshotsForBugs(provider, screenshots, siteContext, isBudgetExceeded) {
  const priorityKeys = ['page__', '_products', '_cart', '_auth_login', '_contact', '_about', '_collections', '_categories', '_wishlist', '_profile'];
  const allKeys = Object.keys(screenshots);

  const selected = [];
  for (const pk of priorityKeys) {
    for (const key of allKeys) {
      if (key.includes(pk) && selected.length < 20) {
        if (!selected.includes(key)) selected.push(key);
      }
    }
  }
  for (const key of allKeys) {
    if (selected.length >= 20) break;
    if (!selected.includes(key)) selected.push(key);
  }

  if (selected.length === 0) return [];

  const allBugs = [];
  for (let i = 0; i < selected.length; i += 5) {
    if (isBudgetExceeded()) break;
    const batch = selected.slice(i, i + 5);

    const imageContent = batch.map(key => ({
      type: 'image_url',
      image_url: {
        url: `data:image/png;base64,${screenshots[key]}`,
        detail: 'low',
      },
    }));

    const deviceInfo = batch.map(key => {
      const dm = key.match(/(iphone_14_pro|pixel_7|desktop|ipad|4k)/i);
      const pm = key.match(/page_(.+)$/) || key.match(/site\d_(.+?)_(desktop|iphone|pixel)/);
      return `${key}: ${dm ? dm[1] : 'unknown device'}, page: ${pm ? pm[1].replace(/_/g, '/') : 'unknown'}`;
    }).join('\n');

    const content = [
      { type: 'text', text: `You are a senior QA engineer reviewing e-commerce website screenshots from ${siteContext.site1 || 'the site'}.\n\nScreenshot details:\n${deviceInfo}\n\nAnalyze each screenshot for visual/UI bugs:\n- Misaligned or overlapping elements\n- Broken layouts, content overflow\n- Missing images or broken image placeholders\n- Text truncation or overflow\n- Poor mobile responsive design\n- Empty sections that should have content\n- Broken navigation or footer\n- Color/contrast issues\n\nReturn a JSON array of bugs found. Each bug: {"title": "...", "severity": "High|Medium", "category": "UI Alignment|Layout|Responsive|Content|Image Quality", "description": "...", "page": "/path", "device": "device name", "fix": "suggested fix"}\n\nIf no bugs found, return []. Be strict — only report real visual issues, not design preferences.` },
      ...imageContent,
    ];

    const res = await provider.chatWithVision('gpt-4o', content, 1000);
    if (!res) continue;

    const bugs = parseJSON(res);
    if (Array.isArray(bugs)) {
      for (const b of bugs) {
        allBugs.push({
          severity: b.severity || 'Medium',
          category: b.category || 'UI Alignment',
          title: `[AI] ${b.title}`,
          description: b.description || '',
          site: siteContext.site1 || '',
          location: b.page || '',
          device: b.device || '',
          steps: `AI Visual Analysis detected this issue on ${b.device || 'the page'}`,
          expected: 'Clean, properly aligned UI without visual defects',
          actual: b.description || b.title,
          fix: b.fix || '',
          testType: 'AI-Visual',
          source: 'gpt-4o-vision',
        });
      }
    }
  }

  return allBugs;
}

module.exports = { analyzeScreenshotsForBugs };
