'use strict';

const express = require('express');
const { fork } = require('child_process');
const path = require('path');
const dbRuns = require('../../db/runs');
const dbBugs = require('../../db/bugs');
const dbPerf = require('../../db/perf');
const { getTrendData } = require('../../reporting/trends');

const router = express.Router();

// Active runs tracking
const activeRuns = new Map();

// GET /api/runs — list recent runs
router.get('/runs', (req, res) => {
  const site = req.query.site;
  const limit = parseInt(req.query.limit || '20', 10);
  const runs = site ? dbRuns.getRunsBySite(site, limit) : dbRuns.getRecentRuns(limit);
  res.json(runs);
});

// GET /api/runs/:id — single run details
router.get('/runs/:id', (req, res) => {
  const run = dbRuns.getRunById(parseInt(req.params.id, 10));
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const bugs = dbBugs.getBugsByRun(run.id);
  const metrics = dbPerf.getMetricsByRun(run.id);
  res.json({ ...run, bugs, metrics });
});

// GET /api/trends/:site — trend data for charts
router.get('/trends/:site', (req, res) => {
  const limit = parseInt(req.query.limit || '15', 10);
  const data = getTrendData(req.params.site, limit);
  res.json(data);
});

// GET /api/sites — list all tested sites
router.get('/sites', (req, res) => {
  const runs = dbRuns.getRecentRuns(200);
  const siteMap = {};
  for (const r of runs) {
    if (!siteMap[r.site_name]) {
      siteMap[r.site_name] = { name: r.site_name, url: r.site_url, runs: 0, lastRun: r.started_at, lastHealth: r.health_score };
    }
    siteMap[r.site_name].runs++;
  }
  res.json(Object.values(siteMap));
});

// POST /api/runs — trigger a new test run
router.post('/runs', (req, res) => {
  const { url, mode } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  const runId = Date.now().toString();

  // Fork a child process to run the tests
  const child = fork(path.join(__dirname, '..', '..', '..', 'run-test.js'), [url, `--mode=${mode || 'standard'}`], {
    env: { ...process.env },
    stdio: 'pipe',
  });

  const logs = [];
  child.stdout?.on('data', (data) => logs.push(data.toString()));
  child.stderr?.on('data', (data) => logs.push(data.toString()));

  activeRuns.set(runId, { url, mode, status: 'running', startedAt: new Date().toISOString(), logs, pid: child.pid });

  child.on('exit', (code) => {
    const run = activeRuns.get(runId);
    if (run) {
      run.status = code === 0 ? 'completed' : 'failed';
      run.finishedAt = new Date().toISOString();
    }
  });

  res.json({ id: runId, status: 'started', pid: child.pid });
});

// GET /api/active — get active/recent triggered runs
router.get('/active', (req, res) => {
  const runs = [];
  for (const [id, run] of activeRuns) {
    runs.push({ id, ...run, logs: run.logs.slice(-20) });
  }
  res.json(runs);
});

// GET /api/bugs/flaky/:site — get flaky bugs
router.get('/bugs/flaky/:site', (req, res) => {
  const flaky = dbBugs.detectFlakyBugs(req.params.site);
  const bugs = flaky.map(fp => dbBugs.getBugByFingerprint(fp)).filter(Boolean);
  res.json(bugs);
});

module.exports = router;
