'use strict';

const express = require('express');
const dbRuns = require('../../db/runs');
const dbBugs = require('../../db/bugs');
const { getTrendData } = require('../../reporting/trends');
const { generateTrendCharts } = require('../../reporting/charts');

const router = express.Router();

// Dashboard — main page
router.get('/', (req, res) => {
  const runs = dbRuns.getRecentRuns(10);
  const allRuns = dbRuns.getRecentRuns(200);

  // Aggregate site stats
  const siteMap = {};
  for (const r of allRuns) {
    if (!siteMap[r.site_name]) {
      siteMap[r.site_name] = { name: r.site_name, url: r.site_url, runs: 0, lastHealth: r.health_score, lastRun: r.started_at };
    }
    siteMap[r.site_name].runs++;
  }
  const sites = Object.values(siteMap);

  const totalRuns = allRuns.length;
  const avgHealth = runs.length > 0 ? Math.round(runs.reduce((s, r) => s + (r.health_score || 0), 0) / runs.length) : 0;

  res.send(layout('Dashboard', `
    <div class="stats-grid">
      <div class="stat-card info"><div class="value">${totalRuns}</div><div class="label">Total Runs</div></div>
      <div class="stat-card ${avgHealth >= 80 ? 'success' : avgHealth >= 50 ? '' : 'critical'}"><div class="value">${avgHealth}%</div><div class="label">Avg Health</div></div>
      <div class="stat-card info"><div class="value">${sites.length}</div><div class="label">Sites Tested</div></div>
    </div>

    <div class="card">
      <h2>Sites</h2>
      <table>
        <tr><th>Site</th><th>Runs</th><th>Last Health</th><th>Last Run</th></tr>
        ${sites.map(s => `
          <tr>
            <td><a href="/site/${s.name}">${s.name}</a></td>
            <td>${s.runs}</td>
            <td><span class="badge ${s.lastHealth >= 80 ? 'pass' : s.lastHealth >= 50 ? 'medium' : 'fail'}">${s.lastHealth}%</span></td>
            <td>${fmtDate(s.lastRun)}</td>
          </tr>
        `).join('')}
      </table>
    </div>

    <div class="card">
      <h2>Recent Runs</h2>
      <table>
        <tr><th>#</th><th>Site</th><th>Mode</th><th>Bugs</th><th>Health</th><th>Duration</th><th>Date</th></tr>
        ${runs.map(r => `
          <tr>
            <td><a href="/run/${r.id}">#${r.run_number}</a></td>
            <td>${r.site_name}</td>
            <td>${r.mode}</td>
            <td>${r.tests_failed || 0}</td>
            <td><span class="badge ${r.health_score >= 80 ? 'pass' : r.health_score >= 50 ? 'medium' : 'fail'}">${r.health_score}%</span></td>
            <td>${r.duration_sec}s</td>
            <td>${fmtDate(r.started_at)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `));
});

// Site detail page with trends
router.get('/site/:name', (req, res) => {
  const siteName = req.params.name;
  const runs = dbRuns.getRunsBySite(siteName, 20);
  if (runs.length === 0) return res.status(404).send(layout('Not Found', '<p>No data for this site.</p>'));

  const trendData = getTrendData(siteName, 15);
  const charts = generateTrendCharts(trendData);

  res.send(layout(siteName, `
    <h2 style="color:#fff;margin-bottom:20px;">${siteName}</h2>
    ${charts}
    <div class="card">
      <h2>Run History</h2>
      <table>
        <tr><th>#</th><th>Mode</th><th>Bugs</th><th>Health</th><th>Tests</th><th>Duration</th><th>Date</th></tr>
        ${runs.map(r => `
          <tr>
            <td><a href="/run/${r.id}">#${r.run_number}</a></td>
            <td>${r.mode}</td>
            <td>${r.tests_failed || 0}</td>
            <td><span class="badge ${r.health_score >= 80 ? 'pass' : r.health_score >= 50 ? 'medium' : 'fail'}">${r.health_score}%</span></td>
            <td>${r.tests_passed}/${r.tests_total}</td>
            <td>${r.duration_sec}s</td>
            <td>${fmtDate(r.started_at)}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `));
});

// Run detail page
router.get('/run/:id', (req, res) => {
  const run = dbRuns.getRunById(parseInt(req.params.id, 10));
  if (!run) return res.status(404).send(layout('Not Found', '<p>Run not found.</p>'));

  const bugs = dbBugs.getBugsByRun(run.id);

  res.send(layout(`Run #${run.run_number}`, `
    <h2 style="color:#fff;">Run #${run.run_number} — ${run.site_name}</h2>
    <div class="stats-grid" style="margin-top:16px;">
      <div class="stat-card ${run.health_score >= 80 ? 'success' : run.health_score >= 50 ? '' : 'critical'}"><div class="value">${run.health_score}%</div><div class="label">Health</div></div>
      <div class="stat-card"><div class="value">${bugs.length}</div><div class="label">Bugs</div></div>
      <div class="stat-card success"><div class="value">${run.tests_passed}</div><div class="label">Passed</div></div>
      <div class="stat-card critical"><div class="value">${run.tests_failed}</div><div class="label">Failed</div></div>
    </div>

    <div class="card">
      <h2>Bugs (${bugs.length})</h2>
      <table>
        <tr><th>ID</th><th>Severity</th><th>Category</th><th>Title</th><th>Location</th></tr>
        ${bugs.map(b => `
          <tr>
            <td>${b.bug_id}</td>
            <td><span class="badge ${b.severity.toLowerCase()}">${b.severity}</span></td>
            <td>${b.category}</td>
            <td>${esc(b.title)}</td>
            <td>${esc(b.location || '')}</td>
          </tr>
        `).join('')}
      </table>
    </div>
  `));
});

// Trigger page
router.get('/trigger', (req, res) => {
  res.send(layout('Trigger Run', `
    <div class="card">
      <h2>Trigger New Test Run</h2>
      <form class="trigger-form" id="triggerForm">
        <div class="field">
          <label for="url">Target URL</label>
          <input type="url" id="url" name="url" placeholder="https://coachnew.fynd.io" required style="width:350px;">
        </div>
        <div class="field">
          <label for="mode">Mode</label>
          <select id="mode" name="mode">
            <option value="fast">Fast</option>
            <option value="standard" selected>Standard</option>
            <option value="deep">Deep</option>
          </select>
        </div>
        <button type="submit" class="btn" id="submitBtn">Start Test Run</button>
      </form>
      <div id="result" style="margin-top:16px;"></div>
    </div>
    <script>
      document.getElementById('triggerForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const btn = document.getElementById('submitBtn');
        btn.disabled = true;
        btn.textContent = 'Starting...';
        try {
          const res = await fetch('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: document.getElementById('url').value, mode: document.getElementById('mode').value }),
          });
          const data = await res.json();
          document.getElementById('result').innerHTML = '<p style="color:#22c55e;">Run started! PID: ' + data.pid + '</p>';
        } catch (e) {
          document.getElementById('result').innerHTML = '<p style="color:#dc2626;">Error: ' + e.message + '</p>';
        }
        btn.disabled = false;
        btn.textContent = 'Start Test Run';
      });
    </script>
  `));
});

function layout(title, content) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — QA Dashboard</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header>
    <div class="container">
      <h1>QA Dashboard</h1>
      <nav>
        <a href="/">Dashboard</a>
        <a href="/trigger">Trigger Run</a>
      </nav>
    </div>
  </header>
  <div class="container">${content}</div>
</body>
</html>`;
}

function fmtDate(d) {
  if (!d) return 'N/A';
  return d.slice(0, 16).replace('T', ' ');
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = router;
