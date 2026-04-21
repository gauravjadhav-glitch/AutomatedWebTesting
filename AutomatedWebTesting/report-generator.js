'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Generates the full HTML report matching the sophisticated sidebar layout.
 * Accepts an options object with all runtime data.
 */
module.exports = function generateHTMLReport(opts) {
  const {
    discovery, metadata, testPlan = [], bugs = [], testResults = {},
    consoleErrors = [], networkErrors = [], screenshotDir = '',
    targetUrl = '', mode = 'standard', siteName = '', budgetMs = 0,
  } = opts;

  const { duration = '0s', reportNum = '?', perfData = [] } = metadata || {};
  const timestamp = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');
  const dateStr = new Date().toISOString().split('T')[0];
  const passedTests = testResults.passed || 0;
  const failedTests = testResults.failed || 0;
  const skippedTests = testResults.skipped || 0;

  // ── Severity counts ──
  const sev = { Critical: 0, High: 0, Medium: 0, Low: 0 };
  bugs.forEach(b => { sev[b.severity] = (sev[b.severity] || 0) + 1; });
  const totalBugs = bugs.length;

  // ── Health score ──
  const healthScore = Math.max(0, 100 - (sev.Critical * 25) - (sev.High * 10) - (sev.Medium * 3) - (sev.Low * 1));
  const healthColor = healthScore >= 80 ? '#22c55e' : healthScore >= 50 ? '#f59e0b' : '#ef4444';

  // ── Pie chart SVG ──
  const pieTotal = totalBugs || 1;
  const sevEntries = [
    ['Critical', '#ef4444'], ['High', '#f59e0b'], ['Medium', '#3b82f6'], ['Low', '#22c55e'],
  ];
  let pieCircles = '';
  let dashOffset = 0;
  sevEntries.forEach(([level, color]) => {
    const pct = (sev[level] / pieTotal) * 100;
    if (pct > 0) {
      pieCircles += `<circle r="15.9155" cx="50" cy="50" fill="none" stroke="${color}" stroke-width="10" stroke-dasharray="${pct} ${100 - pct}" stroke-dashoffset="${-dashOffset}" />`;
      dashOffset += pct;
    }
  });

  // ── Screenshot files ──
  let ssFiles = [];
  try { ssFiles = fs.readdirSync(screenshotDir).filter(f => f.endsWith('.png')); } catch (e) {}
  const ssCount = ssFiles.length;

  // ── Group screenshots by page ──
  const ssGroups = {};
  ssFiles.forEach(f => {
    // naming pattern: site1_page__path.png or site1__path_device.png
    let pagePath = '/';
    let device = 'Desktop';
    const base = f.replace('.png', '');
    if (base.includes('_iphone')) { device = 'iPhone 14 Pro'; }
    else if (base.includes('_pixel')) { device = 'Pixel 7'; }
    else if (base.includes('_4k')) { device = '4K — 3840x2160'; }

    // Extract page path from filename
    const m = base.match(/page_+(.*)/) || base.match(/site\d+_+(.+)/);
    if (m) {
      let slug = m[1]
        .replace(/_iphone.*|_pixel.*|_4k.*/i, '')
        .replace(/_/g, '/')
        .replace(/\/+/g, '/')
        .replace(/^\/|\/$/g, '');
      pagePath = '/' + (slug || '');
    }

    if (!ssGroups[pagePath]) ssGroups[pagePath] = [];
    ssGroups[pagePath].push({ file: f, device, pagePath });
  });

  // ── Categories & test types ──
  const categories = {};
  const testTypeCounts = {};
  bugs.forEach(b => {
    const cat = b.category || 'Other';
    categories[cat] = (categories[cat] || 0) + 1;
    const type = b.testType || cat;
    if (!testTypeCounts[type]) testTypeCounts[type] = { total: 0, Critical: 0, High: 0, Medium: 0, Low: 0 };
    testTypeCounts[type].total++;
    testTypeCounts[type][b.severity]++;
  });

  // ── Bug hotspots ──
  const locCounts = {};
  bugs.forEach(b => { const loc = b.location || 'Unknown'; locCounts[loc] = (locCounts[loc] || 0) + 1; });
  const hotspots = Object.entries(locCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const maxHotspot = hotspots.length > 0 ? hotspots[0][1] : 1;

  // ── Helpers ──
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const badgeBg = s => ({ Critical: 'bg-critical', High: 'bg-high', Medium: 'bg-medium', Low: 'bg-low' }[s] || 'bg-info');
  const bugBorder = s => ({ Critical: 'bug-critical', High: 'bug-high', Medium: 'bug-medium', Low: 'bug-low' }[s] || '');
  const sevColorMap = { Critical: '#ef4444', High: '#f59e0b', Medium: '#3b82f6', Low: '#22c55e' };
  const placeholderSvg = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='400' height='200'%3E%3Crect width='400' height='200' fill='%23111827'/%3E%3Ctext x='200' y='105' fill='%234b5563' text-anchor='middle' font-size='13'%3ELoading screenshot...%3C/text%3E%3C/svg%3E`;
  // Screenshot relative path prefix — includes site subdirectory
  const ssRelPath = siteName ? `screenshots/${siteName}` : 'screenshots';

  // ── Feature table rows ──
  const featureRows = () => {
    const rows = [];
    rows.push(`<tr><td>Pages Crawled</td><td>${discovery.livePages.length + discovery.deadPages.length}</td></tr>`);
    rows.push(`<tr><td>Live (200)</td><td class="pass">${discovery.livePages.length}</td></tr>`);
    rows.push(`<tr><td>Dead Pages</td><td class="${discovery.deadPages.length > 0 ? 'fail' : ''}">${discovery.deadPages.length}</td></tr>`);
    rows.push(`<tr><td>Console Errors</td><td class="${discovery.consoleErrors.length > 0 ? 'fail' : ''}">${discovery.consoleErrors.length}</td></tr>`);
    rows.push(`<tr><td>Network Errors</td><td class="${networkErrors.length > 0 ? 'fail' : ''}">${networkErrors.length}</td></tr>`);
    if (discovery.features) {
      Object.entries(discovery.features).forEach(([k, v]) => {
        const label = k.replace('has', '');
        rows.push(`<tr><td>${label}</td><td>${v ? '<span class="pass">Yes</span>' : 'No'}</td></tr>`);
      });
    }
    if (discovery.platform) rows.push(`<tr><td>Platform</td><td>${discovery.platform}</td></tr>`);
    return rows.join('');
  };

  // ── Test plan rows ──
  const testPlanRows = () => {
    if (!testPlan || testPlan.length === 0) return '<tr><td colspan="3">No test plan data</td></tr>';
    return testPlan.map(p => {
      return `<tr><td style="text-transform:capitalize;font-weight:600;">${esc(p.name)}</td><td>${p.tests || 0}</td><td>Tier ${p.tier || 1}</td></tr>`;
    }).join('');
  };

  // ── Crawl results rows ──
  const crawlRows = () => {
    const allPages = [...(discovery.livePages || []), ...(discovery.deadPages || [])];
    return allPages.map(p => {
      const isLive = p.status >= 200 && p.status < 400;
      return `<tr>
        <td style="font-family:monospace;font-size:12px;">${esc(p.path)}</td>
        <td><span class="badge ${isLive ? 'bg-pass' : 'bg-fail'}">${p.status || 'ERR'}</span></td>
      </tr>`;
    }).join('');
  };

  // ── Screenshots section ──
  const screenshotsHTML = () => {
    if (ssCount === 0) return '<p style="color:var(--text3);">No screenshots captured in this run.</p>';
    return Object.entries(ssGroups).map(([pagePath, shots]) => {
      const pageUrl = targetUrl.replace(/\/$/, '') + pagePath;
      // Find bugs related to this page
      const pageBugs = bugs.filter(b => (b.location || '').includes(pagePath));

      let deviceHTML = shots.map(s => {
        // Related bugs for this device/page combo
        const devBugs = pageBugs.filter(b => (b.location || '').toLowerCase().includes(s.device.toLowerCase().split(' ')[0]));
        const issueOverlay = devBugs.length > 0 ? `<div style="padding:10px;background:var(--bg4);border-top:1px solid var(--border);">
            <div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">Issues (${devBugs.length}):</div>
            ${devBugs.map(b => `<div style="padding:6px 8px;margin-bottom:4px;background:var(--bg5);border-radius:4px;border-left:3px solid ${sevColorMap[b.severity]};font-size:11px;">
              <span style="color:${sevColorMap[b.severity]};font-weight:700;">${b.severity}</span> ${esc(b.title)}
            </div>`).join('')}
          </div>` : '';

        const viewport = s.device === 'Desktop' ? '1440x900' :
          s.device === 'iPhone 14 Pro' ? '390x844' :
          s.device === 'Pixel 7' ? '412x915' :
          s.device.includes('4K') ? '3840x2160' : '';

        return `<div style="padding:6px 12px;background:var(--bg5);font-size:10px;color:var(--text3);border-top:1px solid var(--border);font-weight:700;">${s.device}${viewport ? ' — ' + viewport : ''}</div>
        <div style="border-top:1px solid var(--border);">
          <div style="padding:6px 12px;background:var(--bg4);text-align:center;font-size:11px;font-weight:700;color:#22c55e;border-bottom:1px solid var(--border);">${esc(siteName)}</div>
          <img class="lazy-img" data-src="${ssRelPath}/${s.file}" src="${placeholderSvg}" style="width:100%;display:block;" alt="${esc(s.file)}">
          ${issueOverlay}
        </div>`;
      }).join('');

      return `<div class="sb" style="margin-bottom:24px;">
        <div class="lb" style="padding:12px 16px;">
          <span style="font-size:13px;font-weight:700;">Page: ${esc(pagePath)}</span>
          <div style="font-size:10px;color:var(--text3);margin-top:4px;">
            <a href="${esc(pageUrl)}" target="_blank" style="color:#22c55e;text-decoration:underline;">${esc(pageUrl)}</a>
          </div>
        </div>
        ${deviceHTML}
      </div>`;
    }).join('');
  };

  // ── Performance section ──
  const performanceHTML = () => {
    const perfBugs = bugs.filter(b => b.category === 'Performance');

    // If real performance data was passed, show detailed metrics
    if (perfData && perfData.length > 0) {
      return `<div class="g2"><div>
        <h3 style="margin-bottom:10px;">${esc(siteName)}</h3>
        ${perfData.map(p => {
          const metricColor = v => !v ? '#67e8f9' : v > 3000 ? '#ef4444' : v > 1500 ? '#f59e0b' : '#22c55e';
          const clsColor = v => v > 0.25 ? '#ef4444' : v > 0.1 ? '#f59e0b' : '#22c55e';
          const fmtMs = v => v >= 1000 ? (v / 1000).toFixed(2) + 's' : Math.round(v) + 'ms';
          return `<div style="background:#0d1117;border-radius:8px;padding:14px;margin-bottom:10px;border:1px solid #1f2937;">
            <div style="font-weight:700;margin-bottom:10px;">${esc(p.path || '/')} <span style="color:#6b7280;font-weight:400;">Status: ${p.status || 200}</span></div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;">
              <div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${metricColor(p.loadTime)};">${p.loadTime ? fmtMs(p.loadTime) : 'N/A'}</div><div style="font-size:10px;color:#6b7280;">Load</div></div>
              <div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${metricColor(p.fcp)};">${p.fcp ? fmtMs(p.fcp) : 'N/A'}</div><div style="font-size:10px;color:#6b7280;">FCP</div></div>
              <div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${metricColor(p.lcp)};">${p.lcp ? fmtMs(p.lcp) : 'N/A'}</div><div style="font-size:10px;color:#6b7280;">LCP</div></div>
              <div style="text-align:center;padding:8px;background:#020617;border-radius:6px;"><div style="font-size:20px;font-weight:800;color:${clsColor(p.cls || 0)};">${p.cls != null ? p.cls.toFixed(3) : 'N/A'}</div><div style="font-size:10px;color:#6b7280;">CLS</div></div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px;">
              <div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.ttfb ? fmtMs(p.ttfb) : 'N/A'}</span><div style="color:#6b7280;font-size:10px;">TTFB</div></div>
              <div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.requests || 'N/A'}</span><div style="color:#6b7280;font-size:10px;">Requests</div></div>
              <div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.transferSize ? Math.round(p.transferSize / 1024) + 'KB' : 'N/A'}</span><div style="color:#6b7280;font-size:10px;">Size</div></div>
              <div style="text-align:center;padding:6px;background:#020617;border-radius:6px;font-size:12px;"><span style="color:#67e8f9;">${p.domNodes || 'N/A'}</span><div style="color:#6b7280;font-size:10px;">DOM</div></div>
            </div>
          </div>`;
        }).join('')}
      </div></div>`;
    }

    // Fallback: show performance bugs per page
    if (perfBugs.length === 0 && discovery.livePages.length === 0) {
      return '<p style="color:var(--text3);">No performance data available.</p>';
    }
    return `<div class="g2"><div>
      <h3 style="margin-bottom:10px;">${esc(siteName)}</h3>
      ${discovery.livePages.slice(0, 10).map(p => {
        const pageBugs = perfBugs.filter(b => (b.location || '').includes(p.path));
        return `<div style="background:#0d1117;border-radius:8px;padding:14px;margin-bottom:10px;border:1px solid #1f2937;">
          <div style="font-weight:700;margin-bottom:10px;">${esc(p.path)} <span style="color:#6b7280;font-weight:400;">Status: ${p.status}</span></div>
          ${pageBugs.length > 0 ? pageBugs.map(b => `<div style="padding:6px 8px;background:var(--bg5);border-radius:4px;border-left:3px solid ${sevColorMap[b.severity]};font-size:11px;margin-bottom:4px;">
            <span style="color:${sevColorMap[b.severity]};font-weight:700;">${b.severity}</span> ${esc(b.title)}
          </div>`).join('') : '<div style="font-size:12px;color:#22c55e;">No performance issues detected</div>'}
        </div>`;
      }).join('')}
    </div></div>`;
  };

  // ── Analytics dashboard ──
  const analyticsHTML = () => {
    const hotspotBars = hotspots.map(([loc, count]) => {
      const pct = Math.max(5, (count / maxHotspot) * 100);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="width:150px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(loc)}">${esc(loc)}</span>
        <div style="flex:1;background:var(--bg5);border-radius:4px;height:16px;overflow:hidden;">
          <div style="height:100%;width:${pct}%;display:flex;">
            ${sev.Critical > 0 ? `<div style="height:100%;flex:1;background:#ef4444;"></div>` : ''}
            ${sev.High > 0 ? `<div style="height:100%;flex:1;background:#f59e0b;"></div>` : ''}
            ${sev.Medium > 0 ? `<div style="height:100%;flex:1;background:#3b82f6;"></div>` : ''}
            ${sev.Low > 0 ? `<div style="height:100%;flex:1;background:#22c55e;"></div>` : ''}
          </div>
        </div>
        <span style="font-size:11px;color:var(--text3);min-width:30px;">${count}</span>
      </div>`;
    }).join('');

    const typeCards = Object.entries(testTypeCounts).map(([type, data]) => {
      let sevSpans = '';
      if (data.Critical > 0) sevSpans += `<span style="color:#ef4444">${data.Critical}C</span> `;
      if (data.High > 0) sevSpans += `<span style="color:#f59e0b">${data.High}H</span> `;
      if (data.Medium > 0) sevSpans += `<span style="color:#3b82f6">${data.Medium}M</span> `;
      if (data.Low > 0) sevSpans += `<span style="color:#22c55e">${data.Low}L</span> `;
      return `<div style="background:var(--bg3);border-radius:8px;padding:12px;border:1px solid var(--border);text-align:center;">
        <div style="font-size:20px;font-weight:800;color:var(--text);">${data.total}</div>
        <div style="font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:4px;">${esc(type)}</div>
        <div style="font-size:9px;color:var(--text3);margin-top:4px;">${sevSpans}</div>
      </div>`;
    }).join('');

    return `<div style="display:grid;grid-template-columns:200px 1fr;gap:24px;margin-bottom:24px;align-items:center;">
      <div style="text-align:center;">
        <div style="width:120px;height:120px;border-radius:50%;border:6px solid ${healthColor};display:flex;align-items:center;justify-content:center;margin:0 auto;">
          <div><div style="font-size:36px;font-weight:800;color:${healthColor};">${healthScore}</div><div style="font-size:10px;color:var(--text3);">HEALTH</div></div>
        </div>
      </div>
      <div>
        <h4 style="margin-bottom:12px;color:var(--text2);">Bug Hotspots (Top Pages)</h4>
        ${hotspotBars || '<p style="color:var(--text3);font-size:12px;">No bugs found</p>'}
      </div>
    </div>
    <h4 style="margin:16px 0 12px;color:var(--text2);">Bugs by Test Type</h4>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;">
      ${typeCards || '<p style="color:var(--text3);font-size:12px;">No test types</p>'}
    </div>`;
  };

  // ── Bug cards ──
  const bugCardsHTML = () => {
    return bugs.map(b => {
      const borderClass = bugBorder(b.severity);
      const bgClass = badgeBg(b.severity);

      const stepsHTML = b.steps ? b.steps.map(s => s).join('<br>') : 'N/A';

      let screenshotBlock = '';
      if (b.screenshot) {
        const ssName = path.basename(b.screenshot);
        screenshotBlock = `<div class="bug-screenshot">
          <img class="lazy-img" data-src="${ssRelPath}/${ssName}" src="${placeholderSvg}" alt="Screenshot showing ${esc(b.title)}">
          <div class="bug-ss-caption">Screenshot: ${esc(b.location || '')} — ${esc(b.title)}</div>
        </div>`;
      }

      return `<div class="bug-card ${borderClass}" data-severity="${b.severity}" data-category="${esc(b.category || '')}" data-type="${esc(b.testType || b.category || '')}">
      <div class="bug-card-header">
        <h3><span class="badge ${bgClass}">${b.severity}</span> ${esc(b.id)} — ${esc(b.title)} <span class="badge" style="background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f;">NEW</span></h3>
      </div>
      <div class="bug-card-body">
        <table class="bug-detail-table">
          <tr><td class="bug-field">Severity</td><td><span class="badge ${bgClass}">${b.severity}</span></td></tr>
          <tr><td class="bug-field">Category</td><td><span class="badge bg-info">${esc(b.category || 'Other')}</span></td></tr>
          <tr><td class="bug-field">Location</td><td>${esc(b.location || 'N/A')}</td></tr>
          <tr><td class="bug-field">Description</td><td>${esc(b.description || '')}</td></tr>
          <tr><td class="bug-field">Steps</td><td>${stepsHTML}</td></tr>
          <tr><td class="bug-field">Expected</td><td class="pass-text">${esc(b.expected || 'N/A')}</td></tr>
          <tr><td class="bug-field">Actual</td><td class="fail-text">${esc(b.actual || 'N/A')}</td></tr>
          ${b.fix ? `<tr><td class="bug-field">Fix</td><td><code>${esc(b.fix)}</code></td></tr>` : ''}
        </table>
        ${screenshotBlock}
      </div>
    </div>`;
    }).join('');
  };

  // ── Category filter buttons ──
  const catFilterBtns = () => {
    let btns = `<button class="filter-btn cat-filter-btn active" onclick="filterByCategory('all')" style="font-size:10px;">All</button>`;
    Object.entries(categories).forEach(([cat, count]) => {
      btns += `<button class="filter-btn cat-filter-btn" onclick="filterByCategory('${esc(cat)}')" style="font-size:10px;">${esc(cat)} (${count})</button>`;
    });
    return btns;
  };

  // ── Bug categories bar chart ──
  const categoryBars = () => {
    const maxCat = Math.max(...Object.values(categories), 1);
    return Object.entries(categories).map(([cat, count]) => {
      const pct = Math.max(2, (count / maxCat) * 100);
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="width:100px;font-size:12px;">${esc(cat)}</span>
        <div style="flex:1;background:#1f2937;border-radius:4px;height:20px;overflow:hidden;">
          <div style="height:100%;background:var(--accent);width:${pct}%;border-radius:4px;"></div>
        </div>
        <span style="font-size:12px;color:#6b7280;">${count}</span>
      </div>`;
    }).join('');
  };

  // ── Console/Network errors section ──
  const errorsHTML = () => {
    let html = '';
    if (consoleErrors.length > 0) {
      html += `<h4 style="margin:16px 0 8px;color:var(--text2);">Console Errors (${consoleErrors.length})</h4>`;
      html += consoleErrors.slice(0, 20).map(e => {
        const text = typeof e === 'string' ? e : (e.text || e.message || JSON.stringify(e));
        return `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">
          <span style="color:#ef4444;font-weight:700;">ERROR</span> ${esc(String(text).slice(0, 200))}
        </div>`;
      }).join('');
    }
    if (networkErrors.length > 0) {
      html += `<h4 style="margin:16px 0 8px;color:var(--text2);">Network Errors (${networkErrors.length})</h4>`;
      html += networkErrors.slice(0, 20).map(e => {
        return `<div style="padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">
          <span style="color:#f59e0b;font-weight:700;">FAIL</span> ${esc(String(e.url || '').slice(0, 100))} — ${esc(e.failure || 'Unknown')}
        </div>`;
      }).join('');
    }
    return html;
  };

  // ══════════════════════════════════════════════════════════════════════════════
  // FULL HTML OUTPUT
  // ══════════════════════════════════════════════════════════════════════════════
  const totalPages = discovery.livePages.length + discovery.deadPages.length;
  const totalTests = testResults.total || (testResults.passed + testResults.failed + testResults.skipped) || 0;

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>QA Report — ${esc(siteName)} — ${dateStr}</title>
<style>
:root{--bg:#0a0a0f;--bg2:#111827;--bg3:#0d1117;--bg4:#161b22;--bg5:#020617;--border:#1e293b;--text:#e2e8f0;--text2:#9ca3af;--text3:#6b7280;--accent:#3b82f6;--radius:12px}
[data-theme="light"]{--bg:#f0f2f5;--bg2:#ffffff;--bg3:#f8fafc;--bg4:#e8ecf1;--bg5:#f1f5f9;--border:#d1d5db;--text:#1e293b;--text2:#475569;--text3:#64748b;--accent:#2563eb}
*{margin:0;padding:0;box-sizing:border-box}
html{scroll-behavior:smooth}
body{font-family:-apple-system,'Segoe UI',system-ui,Roboto,sans-serif;background:var(--bg);color:var(--text);display:flex;line-height:1.5}
/* Sidebar */
.sidebar{position:fixed;top:0;left:0;width:230px;height:100vh;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:100;padding:0;transition:transform .3s;display:flex;flex-direction:column}
.sidebar .logo{padding:20px 20px 16px;font-weight:800;font-size:16px;color:var(--accent);border-bottom:1px solid var(--border);letter-spacing:-.3px}
.sidebar .logo small{display:block;font-size:10px;color:var(--text3);font-weight:400;margin-top:4px;letter-spacing:.5px;text-transform:uppercase}
.nav-link{display:flex;align-items:center;gap:8px;padding:10px 20px;font-size:13px;color:var(--text2);text-decoration:none;border-left:3px solid transparent;transition:all .2s}
.nav-link:hover{background:var(--bg4);color:var(--text)}
.nav-link.active{background:var(--bg3);color:var(--accent);border-left-color:var(--accent);font-weight:600}
/* Main */
.main{margin-left:230px;flex:1;min-width:0}
.hdr{background:linear-gradient(135deg,#0f172a 0%,#1e3a5f 40%,#2563eb 100%);padding:32px 40px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:16px}
.hdr h1{font-size:22px;color:#fff;font-weight:700;letter-spacing:-.3px}
.hdr p{color:#93c5fd;font-size:13px;margin-top:6px}
.hdr .site-urls{margin-top:8px;display:flex;gap:20px;flex-wrap:wrap}
.hdr .site-url{font-size:11px;padding:4px 12px;border-radius:6px;display:inline-flex;align-items:center;gap:6px}
.hdr .site-url.uat{background:rgba(59,130,246,.15);color:#93c5fd;border:1px solid rgba(59,130,246,.3)}
.toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toolbar input{background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);color:#fff;padding:8px 14px;border-radius:8px;font-size:12px;width:200px;backdrop-filter:blur(4px)}
.toolbar input::placeholder{color:rgba(255,255,255,.5)}
.toolbar button,.filter-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text2);padding:6px 14px;border-radius:8px;font-size:12px;cursor:pointer;transition:all .2s;font-weight:500}
.toolbar button:hover,.filter-btn:hover,.filter-btn.active{background:var(--accent);color:#fff;border-color:var(--accent);transform:translateY(-1px)}
.ctr{max-width:1400px;margin:0 auto;padding:24px}
/* Summary cards */
.exec-card{background:var(--bg2);border-radius:var(--radius);padding:24px;margin:20px 0;border:1px solid var(--border);display:grid;grid-template-columns:200px 1fr;gap:24px;align-items:center}
.pie-wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.pie-legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;justify-content:center}
.pie-legend span{display:flex;align-items:center;gap:5px}
.pie-legend .dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin:12px 0}
.stat-item{background:var(--bg3);border-radius:10px;padding:16px 12px;text-align:center;border:1px solid var(--border);transition:transform .2s}
.stat-item:hover{transform:translateY(-2px)}
.stat-item .val{font-size:26px;font-weight:800;line-height:1}
.stat-item .lbl{font-size:10px;color:var(--text3);text-transform:uppercase;margin-top:6px;letter-spacing:.5px}
/* Sections */
.sec{background:var(--bg2);border-radius:var(--radius);margin:20px 0;border:1px solid var(--border);overflow:hidden;transition:box-shadow .2s}
.sec:hover{box-shadow:0 4px 20px rgba(0,0,0,.15)}
.sec-h{padding:16px 24px;background:var(--bg3);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;cursor:pointer}
.sec-h h2{font-size:16px;font-weight:700;display:flex;align-items:center;gap:10px}
.sec-b{padding:24px}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:12px 0}
/* Screenshot cards */
.sb{background:var(--bg);border-radius:10px;overflow:hidden;border:1px solid var(--border);transition:box-shadow .2s}
.sb:hover{box-shadow:0 4px 16px rgba(0,0,0,.2)}
.sb .lb{padding:10px 16px;font-weight:600;font-size:12px;background:var(--bg4);border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
.sb img{width:100%;display:block;cursor:zoom-in;transition:opacity .4s}
/* Badges */
.badge{padding:4px 10px;border-radius:6px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
.bg-critical{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.bg-high{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-medium{background:#0c2d57;color:#93c5fd;border:1px solid #1e3a5f}
.bg-low{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-pass{background:#052e16;color:#86efac;border:1px solid #14532d}
.bg-fail{background:#450a0a;color:#fca5a5;border:1px solid #7f1d1d}
.bg-warn{background:#451a03;color:#fcd34d;border:1px solid #78350f}
.bg-info{background:#1e1b4b;color:#a5b4fc;border:1px solid #312e81}
/* Tables */
table{width:100%;border-collapse:collapse}
th{background:var(--bg3);padding:10px 14px;text-align:left;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:.5px;font-weight:600}
td{padding:10px 14px;border-bottom:1px solid var(--border);font-size:13px}
tr{transition:background .15s}
tr:hover{background:var(--bg4)}
/* Bug cards */
.bug-card{background:var(--bg3);border-radius:var(--radius);margin:16px 0;border-left:4px solid;overflow:hidden;transition:box-shadow .2s}
.bug-card:hover{box-shadow:0 2px 12px rgba(0,0,0,.15)}
.bug-critical{border-color:#ef4444}.bug-high{border-color:#f59e0b}.bug-medium{border-color:#3b82f6}.bug-low{border-color:#22c55e}
.bug-card-header{padding:16px 20px;background:var(--bg4);border-bottom:1px solid var(--border)}
.bug-card-header h3{font-size:14px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;font-weight:600}
.bug-card-body{padding:20px}
.bug-detail-table{width:100%;border-collapse:collapse;font-size:13px}
.bug-detail-table tr{border-bottom:1px solid var(--border)}
.bug-detail-table tr:last-child{border-bottom:none}
.bug-detail-table td{padding:10px 14px;vertical-align:top;line-height:1.6}
.bug-field{font-weight:700;color:var(--text2);white-space:nowrap;width:100px;text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.pass-text{color:#22c55e}.fail-text{color:#ef4444}
.bug-detail-table code{display:inline-block;background:var(--bg5);padding:8px 12px;border-radius:6px;font-size:12px;color:#67e8f9;white-space:pre-wrap;font-family:'Fira Code',Consolas,monospace}
.bug-screenshot{margin-top:14px;border-radius:10px;overflow:hidden;border:1px solid var(--border)}
.bug-screenshot img{width:100%;display:block;max-height:400px;object-fit:contain;background:#0a0a0a}
.bug-ss-caption{padding:10px 14px;background:var(--bg5);font-size:11px;color:var(--text2);font-style:italic}
/* Utility */
.crit{color:#ef4444}.high{color:#f59e0b}.med{color:#3b82f6}.low{color:#22c55e}.pass{color:#22c55e}.fail{color:#ef4444}
.ftr{text-align:center;padding:32px;color:var(--text3);font-size:11px;border-top:1px solid var(--border);margin-top:24px}
.filters{display:flex;gap:8px;margin:16px 0;flex-wrap:wrap}
.hidden{display:none!important}
.zoom-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;backdrop-filter:blur(4px)}
.zoom-overlay img{max-width:95vw;max-height:95vh;object-fit:contain;border-radius:8px}
/* Scrollbar */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--text3)}
/* Print & responsive */
@media print{.sidebar,.toolbar,.filters,.zoom-overlay{display:none!important}.main{margin-left:0!important}.sec{break-inside:avoid}.badge{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
@media(max-width:900px){.sidebar{transform:translateX(-100%)}.sidebar.open{transform:translateX(0)}.main{margin-left:0}.stat-grid{grid-template-columns:repeat(3,1fr)}.g2{grid-template-columns:1fr}.exec-card{grid-template-columns:1fr}}
.hamburger{display:none;position:fixed;top:12px;left:12px;z-index:200;background:var(--bg2);border:1px solid var(--border);color:var(--text);padding:8px 12px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1}
@media(max-width:900px){.hamburger{display:block}}
.collapse-icon{font-size:14px;color:var(--text3);font-weight:700;margin-left:auto;min-width:16px;text-align:center;transition:transform .2s}
</style>
</head>
<body>

<!-- HAMBURGER (mobile) -->
<button class="hamburger" onclick="document.getElementById('sidebar').classList.toggle('open')">&#9776;</button>

<!-- SIDEBAR NAVIGATION -->
<nav class="sidebar" id="sidebar">
  <div class="logo">QA Report<small>Report #${reportNum} — ${dateStr}</small></div>
  <a href="#summary" class="nav-link active">Summary</a>
  <a href="#discovery" class="nav-link">Discovery</a>
  <a href="#test-plan" class="nav-link">Test Plan</a>
  <a href="#crawl-results" class="nav-link">Crawl Results</a>
  <a href="#screenshots" class="nav-link">Screenshots</a>
  <a href="#performance" class="nav-link">Performance</a>
  <a href="#analytics" class="nav-link">Analytics</a>
  <a href="#all-bugs" class="nav-link">Bug Report</a>
  <a href="#bug-categories" class="nav-link">By Category</a>
</nav>

<!-- MAIN CONTENT -->
<div class="main">

<!-- HEADER -->
<div class="hdr">
  <div>
    <h1>Website QA Report <span style="font-size:11px;background:rgba(255,255,255,.2);color:#fff;padding:3px 12px;border-radius:20px;vertical-align:middle;font-weight:500;backdrop-filter:blur(4px);">${mode.toUpperCase()}</span></h1>
    <p>${dateStr} &middot; ${totalTests} tests &middot; ${duration} &middot; Budget: ${Math.round(budgetMs / 60000)}min</p>
    <div class="site-urls">
      <span class="site-url uat">${esc(targetUrl)}</span>
    </div>
  </div>
  <div class="toolbar">
    <input type="text" id="searchInput" placeholder="Search bugs..." onkeyup="filterBugs()">
    <button onclick="toggleTheme()">Theme</button>
    <button onclick="window.print()">Print</button>
  </div>
</div>

<div class="ctr">

<!-- EXECUTIVE SUMMARY -->
<div id="summary" class="exec-card">
  <div class="pie-wrap">
    <svg viewBox="0 0 100 100" width="120" height="120" style="transform:rotate(-90deg)">
      <circle r="15.9155" cx="50" cy="50" fill="none" stroke="var(--border)" stroke-width="10"/>
      ${pieCircles}
    </svg>
    <div class="pie-legend">
      <span><span class="dot" style="background:#ef4444"></span>${sev.Critical} Critical</span>
      <span><span class="dot" style="background:#f59e0b"></span>${sev.High} High</span>
      <span><span class="dot" style="background:#3b82f6"></span>${sev.Medium} Medium</span>
      <span><span class="dot" style="background:#22c55e"></span>${sev.Low} Low</span>
    </div>
  </div>
  <div>
    <div class="stat-grid">
      <div class="stat-item"><div class="val" style="color:var(--text)">${totalBugs}</div><div class="lbl">Total Bugs</div></div>
      <div class="stat-item"><div class="val crit">${sev.Critical}</div><div class="lbl">Critical</div></div>
      <div class="stat-item"><div class="val high">${sev.High}</div><div class="lbl">High</div></div>
      <div class="stat-item"><div class="val med">${sev.Medium}</div><div class="lbl">Medium</div></div>
      <div class="stat-item"><div class="val low">${sev.Low}</div><div class="lbl">Low</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${totalTests}</div><div class="lbl">Tests Run</div></div>
      <div class="stat-item"><div class="val pass">${passedTests}</div><div class="lbl">Passed</div></div>
      <div class="stat-item"><div class="val fail">${failedTests}</div><div class="lbl">Failed</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${totalPages}</div><div class="lbl">Pages Found</div></div>
      <div class="stat-item"><div class="val" style="color:#67e8f9">${ssCount}</div><div class="lbl">Screenshots</div></div>
    </div>
  </div>
</div>

<!-- DISCOVERY -->
<div id="discovery" class="sec">
  <div class="sec-h"><h2>Site Discovery Results</h2><span class="collapse-icon">-</span><span class="badge bg-info">${totalPages} pages crawled</span></div>
  <div class="sec-b">
    <table>
      <thead><tr><th>Feature</th><th>${esc(siteName)}</th></tr></thead>
      <tbody>${featureRows()}</tbody>
    </table>
  </div>
</div>

<!-- TEST PLAN -->
<div id="test-plan" class="sec">
  <div class="sec-h"><h2>Dynamic Test Plan</h2><span class="collapse-icon">-</span><span class="badge bg-info">${totalTests} TESTS</span></div>
  <div class="sec-b">
    <table>
      <thead><tr><th>Test Type</th><th>Count</th><th>Tier</th></tr></thead>
      <tbody>${testPlanRows()}</tbody>
    </table>
  </div>
</div>

<!-- CRAWL RESULTS -->
<div id="crawl-results" class="sec">
  <div class="sec-h"><h2>All Pages Crawled</h2><span class="collapse-icon">-</span><span class="badge bg-info">${totalPages} PATHS</span></div>
  <div class="sec-b">
    <table>
      <thead><tr><th>Path</th><th>Status</th></tr></thead>
      <tbody>${crawlRows()}</tbody>
    </table>
  </div>
</div>

<!-- SCREENSHOTS -->
<div id="screenshots" class="sec">
  <div class="sec-h"><h2>Screenshots</h2><span class="collapse-icon">-</span><span class="badge bg-info">${ssCount} captured</span></div>
  <div class="sec-b">
    ${screenshotsHTML()}
  </div>
</div>

<!-- PERFORMANCE -->
<div id="performance" class="sec">
  <div class="sec-h"><h2>Performance Metrics</h2><span class="collapse-icon">-</span><span class="badge bg-info">Core Web Vitals</span></div>
  <div class="sec-b">
    ${performanceHTML()}
  </div>
</div>

<!-- ANALYTICS DASHBOARD -->
<div id="analytics" class="sec">
  <div class="sec-h"><h2>Analytics Dashboard</h2><span class="collapse-icon">-</span><span class="badge bg-info">Health Score: ${healthScore}/100</span></div>
  <div class="sec-b">
    ${analyticsHTML()}
    ${errorsHTML()}
  </div>
</div>

<!-- ALL BUGS -->
<div id="all-bugs" class="sec">
  <div class="sec-h"><h2>Bug Report (${totalBugs} Issues Found)</h2>
    <div style="display:flex;gap:6px;">
      <button onclick="sortBugs('severity')" class="filter-btn" style="font-size:10px;">Sort: Severity</button>
      <button onclick="sortBugs('category')" class="filter-btn" style="font-size:10px;">Sort: Category</button>
      <button onclick="exportCSV()" class="filter-btn" style="font-size:10px;">Export CSV</button>
    </div>
  </div>
  <div class="sec-b">
    <div class="filters">
      <button class="filter-btn active" onclick="filterSeverity('all')">All (${totalBugs})</button>
      <button class="filter-btn" onclick="filterSeverity('Critical')">Critical (${sev.Critical})</button>
      <button class="filter-btn" onclick="filterSeverity('High')">High (${sev.High})</button>
      <button class="filter-btn" onclick="filterSeverity('Medium')">Medium (${sev.Medium})</button>
      <button class="filter-btn" onclick="filterSeverity('Low')">Low (${sev.Low})</button>
    </div>
    <div class="filters" style="margin-top:0;">
      <span style="font-size:10px;color:var(--text3);margin-right:4px;">Category:</span>
      ${catFilterBtns()}
    </div>
    ${bugCardsHTML()}
  </div>
</div>

<!-- BUG CATEGORIES -->
<div id="bug-categories" class="sec">
  <div class="sec-h"><h2>Bugs by Category</h2><span class="collapse-icon">-</span></div>
  <div class="sec-b">
    ${categoryBars()}
  </div>
</div>

<!-- FOOTER -->
<div class="ftr">
  <p>${totalBugs} bugs found &middot; ${totalTests} tests &middot; ${ssCount} screenshots &middot; ${duration}</p>
  <p style="margin-top:4px;opacity:.6;">Automated QA Report &middot; ${dateStr} &middot; Report #${reportNum}</p>
</div>

</div><!-- .ctr -->
</div><!-- .main -->

<!-- IMAGE LOADER BAR -->
<div id="img-loader-bar" style="position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,#3b82f6,#22c55e);z-index:9999;transition:width .3s;width:0%"></div>
<div id="img-loader-status" style="position:fixed;top:6px;right:16px;z-index:9999;font-size:11px;color:#6b7280;background:var(--bg2);padding:2px 10px;border-radius:8px;border:1px solid var(--border);opacity:1;transition:opacity .5s"></div>

<script>
/* Theme toggle */
function toggleTheme(){document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark'}

/* Severity filter */
function filterSeverity(sev){
  document.querySelectorAll('.filters .filter-btn:not(.cat-filter-btn)').forEach(b=>b.classList.remove('active'));
  if(event&&event.target)event.target.classList.add('active');
  document.querySelectorAll('#all-bugs .bug-card').forEach(c=>{
    if(sev==='all'){c.classList.remove('hidden');return}
    c.classList.toggle('hidden',c.dataset.severity!==sev);
  });
}

/* Search filter */
function filterBugs(){
  const q=document.getElementById('searchInput').value.toLowerCase();
  document.querySelectorAll('#all-bugs .bug-card').forEach(c=>{
    c.classList.toggle('hidden',q&&!c.textContent.toLowerCase().includes(q));
  });
}

/* Category filter */
function filterByCategory(cat){
  document.querySelectorAll('#all-bugs .bug-card').forEach(c=>{
    if(cat==='all'){c.classList.remove('hidden');return}
    c.classList.toggle('hidden',c.dataset.category!==cat);
  });
  document.querySelectorAll('.cat-filter-btn').forEach(b=>b.classList.remove('active'));
  if(event&&event.target)event.target.classList.add('active');
}

/* Sort bugs */
function sortBugs(criteria){
  const container=document.querySelector('#all-bugs .sec-b');
  const cards=[...container.querySelectorAll('.bug-card')];
  const sevOrder={Critical:0,High:1,Medium:2,Low:3};
  cards.sort((a,b)=>{
    if(criteria==='severity')return sevOrder[a.dataset.severity]-sevOrder[b.dataset.severity];
    if(criteria==='category')return(a.dataset.category||'').localeCompare(b.dataset.category||'');
    return 0;
  });
  cards.forEach(c=>c.remove());
  cards.forEach(c=>container.appendChild(c));
}

/* Export CSV */
function exportCSV(){
  const cards=document.querySelectorAll('#all-bugs .bug-card');
  let csv='ID,Severity,Category,Title,Location,Description,Fix\\n';
  cards.forEach(c=>{
    const rows=c.querySelectorAll('.bug-detail-table tr');
    const data={};
    rows.forEach(r=>{
      const field=r.querySelector('.bug-field');
      const val=r.querySelector('td:last-child');
      if(field&&val)data[field.textContent.trim().toLowerCase()]=val.textContent.trim().replace(/"/g,"'").replace(/\\n/g,' ');
    });
    const title=c.querySelector('h3')?.textContent?.trim()?.replace(/"/g,"'")||'';
    csv+='"'+[data.severity||'',data.category||'',title,data.location||'',data.description||'',data.fix||''].join('","')+'"\\n';
  });
  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='bug-report.csv';
  a.click();
}

/* Collapsible sections */
document.querySelectorAll('.sec-h').forEach(h=>{
  h.addEventListener('click',()=>{
    const body=h.nextElementSibling;
    if(body&&body.classList.contains('sec-b')){
      const collapsed=body.style.display!=='none';
      body.style.display=collapsed?'none':'block';
      const icon=h.querySelector('.collapse-icon');
      if(icon)icon.textContent=collapsed?'+':'-';
    }
  });
});

/* Image zoom */
document.addEventListener('click',e=>{
  if(e.target.tagName==='IMG'&&e.target.closest('.sb,.bug-screenshot')){
    const o=document.createElement('div');
    o.className='zoom-overlay';
    const i=document.createElement('img');
    i.src=e.target.dataset.src||e.target.src;
    o.appendChild(i);
    o.onclick=()=>o.remove();
    document.body.appendChild(o);
  }
});
/* ESC to close zoom overlay */
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'){
    const overlay=document.querySelector('.zoom-overlay');
    if(overlay)overlay.remove();
  }
});

/* Sidebar active tracking */
const obs=new IntersectionObserver(entries=>{
  entries.forEach(e=>{
    if(e.isIntersecting){
      document.querySelectorAll('.nav-link').forEach(l=>l.classList.remove('active'));
      const link=document.querySelector('.nav-link[href="#'+e.target.id+'"]');
      if(link)link.classList.add('active');
    }
  });
},{threshold:0.2});
document.querySelectorAll('[id]').forEach(s=>{
  if(s.classList.contains('sec')||s.classList.contains('exec-card')||s.id==='screenshots')obs.observe(s);
});

/* Progressive Image Loader */
(function(){
  const imgs=document.querySelectorAll('img.lazy-img[data-src]');
  const total=imgs.length;
  if(!total)return;
  const bar=document.getElementById('img-loader-bar');
  const status=document.getElementById('img-loader-status');
  const BUDGET_MS=10000;
  const batchSize=Math.max(1,Math.ceil(total/20));
  const interval=Math.floor(BUDGET_MS/Math.ceil(total/batchSize));
  let loaded=0;
  let idx=0;
  status.textContent='Loading 0/'+total+' screenshots...';

  const visibleFirst=[];
  const rest=[];
  imgs.forEach(img=>{
    const rect=img.getBoundingClientRect();
    if(rect.top<window.innerHeight*2)visibleFirst.push(img);
    else rest.push(img);
  });
  const ordered=[...visibleFirst,...rest];

  function loadBatch(){
    const end=Math.min(idx+batchSize,total);
    for(let i=idx;i<end;i++){
      const img=ordered[i];
      if(img.dataset.src){
        img.src=img.dataset.src;
        img.removeAttribute('data-src');
        img.style.opacity='0';
        img.style.transition='opacity .4s';
        img.onload=function(){this.style.opacity='1'};
      }
      loaded++;
    }
    idx=end;
    const pct=Math.round((loaded/total)*100);
    bar.style.width=pct+'%';
    status.textContent='Loading '+loaded+'/'+total+' screenshots... ('+pct+'%)';
    if(idx>=total){
      bar.style.width='100%';
      status.textContent=total+' screenshots loaded';
      setTimeout(()=>{bar.style.opacity='0';status.style.opacity='0'},2000);
      setTimeout(()=>{bar.remove();status.remove()},2500);
    }else{
      setTimeout(loadBatch,interval);
    }
  }
  setTimeout(loadBatch,100);
})();
</script>
</body>
</html>`;
};
