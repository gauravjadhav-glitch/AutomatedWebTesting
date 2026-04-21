'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Auto-generate index.html by scanning reports/ and run-* directories for report files.
 * Reads bug-report JSON files to extract bug counts per severity.
 */
function generateIndex(rootDir) {
  const entries = [];

  // Scan run-* directories
  const dirs = fs.readdirSync(rootDir).filter(d => d.startsWith('run-') && fs.statSync(path.join(rootDir, d)).isDirectory());
  for (const dir of dirs) {
    const match = dir.match(/^run-(\d+)_(.+?)_(\d{4}-\d{2}-\d{2})(?:_(\d{4}))?$/);
    if (!match) continue;
    const [, num, site, date, time] = match;
    const reportFile = fs.existsSync(path.join(rootDir, dir, 'index.html'))
      ? `${dir}/index.html`
      : fs.existsSync(path.join(rootDir, dir, 'full-comparison-report.html'))
        ? `${dir}/full-comparison-report.html`
        : null;
    if (!reportFile) continue;

    const counts = readBugCounts(path.join(rootDir, dir, 'bug-report.json'));
    entries.push({
      num: parseInt(num, 10),
      site: site.replace(/-/g, '.'),
      date: time ? `${date} ${time.slice(0, 2)}:${time.slice(2)}` : date,
      href: reportFile,
      ...counts,
    });
  }

  // Scan reports/ directory for full-report-*.html
  const reportsDir = path.join(rootDir, 'reports');
  if (fs.existsSync(reportsDir)) {
    const htmlFiles = fs.readdirSync(reportsDir).filter(f => f.startsWith('full-report-') && f.endsWith('.html'));
    for (const file of htmlFiles) {
      const siteName = file.replace('full-report-', '').replace('.html', '');
      const jsonPath = path.join(reportsDir, `bug-report-${siteName}.json`);
      const counts = readBugCounts(jsonPath);
      const alreadyListed = entries.some(e => e.href === `reports/${file}`);
      if (!alreadyListed) {
        entries.push({
          num: 0,
          site: siteName.replace(/-/g, '.'),
          date: getFileMtime(path.join(reportsDir, file)),
          href: `reports/${file}`,
          ...counts,
        });
      }
    }
  }

  // Sort by run number descending, then date
  entries.sort((a, b) => b.num - a.num || b.date.localeCompare(a.date));

  return buildHTML(entries);
}

function readBugCounts(jsonPath) {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const bugs = data.bugs || data.bugList || [];
    return {
      total: bugs.length,
      critical: bugs.filter(b => b.severity === 'Critical').length,
      high: bugs.filter(b => b.severity === 'High').length,
      medium: bugs.filter(b => b.severity === 'Medium').length,
      low: bugs.filter(b => b.severity === 'Low').length,
    };
  } catch {
    return { total: '?', critical: 0, high: 0, medium: 0, low: 0 };
  }
}

function getFileMtime(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString().slice(0, 10);
  } catch {
    return 'unknown';
  }
}

function buildHTML(entries) {
  const rows = entries.map((e, i) => {
    const isLatest = i === 0;
    const rowClass = isLatest ? ' class="latest-row"' : '';
    const latestTag = isLatest ? ' <span class="latest-tag">LATEST</span>' : '';
    return `<tr${rowClass}>
      <td><strong>#${e.num || '—'}</strong>${latestTag}</td>
      <td>${e.site}</td>
      <td>${e.date}</td>
      <td><strong>${e.total}</strong> <span class="badge critical">C:${e.critical}</span> <span class="badge high">H:${e.high}</span> <span class="badge medium">M:${e.medium}</span> <span class="badge low">L:${e.low}</span></td>
      <td><a href="${e.href}">View Report</a></td>
    </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Test Reports — All Runs</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
  .header { text-align: center; margin-bottom: 2rem; padding: 2rem; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #334155; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #38bdf8; }
  p.sub { color: #94a3b8; font-size: 1rem; }
  .stats { display: flex; gap: 1.5rem; justify-content: center; margin-top: 1rem; flex-wrap: wrap; }
  .stat { background: #1e293b; padding: 8px 20px; border-radius: 10px; border: 1px solid #334155; }
  .stat strong { color: #38bdf8; font-size: 1.3rem; }
  .stat span { color: #94a3b8; font-size: 0.85rem; display: block; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  th { background: #334155; color: #38bdf8; text-align: left; padding: 14px 16px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; }
  td { padding: 14px 16px; border-bottom: 1px solid #1e3a5f; font-size: 0.95rem; }
  tr:hover { background: #263347; }
  tr.latest-row { background: #172337; border-left: 3px solid #38bdf8; }
  a { color: #38bdf8; text-decoration: none; font-weight: 600; padding: 6px 14px; border: 1px solid #38bdf8; border-radius: 8px; transition: all 0.2s; display: inline-block; }
  a:hover { background: #38bdf8; color: #0f172a; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; margin: 0 1px; }
  .badge.critical { background: rgba(239,68,68,0.2); color: #f87171; }
  .badge.high { background: rgba(249,115,22,0.2); color: #fb923c; }
  .badge.medium { background: rgba(234,179,8,0.2); color: #fbbf24; }
  .badge.low { background: rgba(34,197,94,0.2); color: #4ade80; }
  .latest-tag { background: #38bdf8; color: #0f172a; padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; margin-left: 6px; }
  @media (max-width: 768px) { body { padding: 1rem; } td, th { padding: 10px 8px; font-size: 0.85rem; } .badge { font-size: 0.65rem; } }
</style>
</head><body>
<div class="header">
  <h1>QA Test Reports</h1>
  <p class="sub">Automated UI testing — all runs with screenshots & bug details</p>
  <div class="stats">
    <div class="stat"><strong>${entries.length}</strong><span>Total Runs</span></div>
  </div>
</div>
<table>
  <thead><tr><th>Run</th><th>Site</th><th>Date</th><th>Bugs</th><th>Report</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body></html>`;
}

module.exports = { generateIndex };
