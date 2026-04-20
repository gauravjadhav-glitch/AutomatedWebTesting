'use strict';

const crypto = require('crypto');
const { getDb } = require('./index');

/**
 * Generate a stable fingerprint for a bug.
 * Strips numbers so "5 broken images" and "3 broken images" match.
 * Normalizes paths so /product/123 and /product/456 match.
 */
function fingerprint(bug) {
  const normalizedTitle = (bug.title || '').replace(/\d+/g, 'N').trim().toLowerCase();
  const normalizedLocation = normalizeLocation(bug.location || '');
  const raw = `${bug.category}::${normalizedTitle}::${normalizedLocation}`;
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function normalizeLocation(location) {
  return (location || '')
    .replace(/\d+/g, 'N')          // Replace numbers
    .replace(/[a-f0-9]{8,}/gi, 'HASH')  // Replace hex hashes
    .trim()
    .toLowerCase();
}

function saveBugs(runId, bugs) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO bugs (run_id, bug_id, severity, category, title, description, location,
      device, steps, expected, actual, fix, screenshot_path, test_type,
      ai_root_cause, ai_recommended_fix, ai_impact, fingerprint, status)
    VALUES (@run_id, @bug_id, @severity, @category, @title, @description, @location,
      @device, @steps, @expected, @actual, @fix, @screenshot_path, @test_type,
      @ai_root_cause, @ai_recommended_fix, @ai_impact, @fingerprint, @status)
  `);

  const statusStmt = db.prepare(`
    INSERT INTO bug_status_history (bug_fingerprint, run_id, status, recorded_at)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = db.transaction((bugsArr) => {
    const now = new Date().toISOString();
    for (const bug of bugsArr) {
      const fp = fingerprint(bug);
      const aiAnalysis = bug.aiAnalysis || {};
      stmt.run({
        run_id: runId,
        bug_id: bug.id || '',
        severity: bug.severity || 'Medium',
        category: bug.category || 'Other',
        title: bug.title || '',
        description: bug.description || '',
        location: bug.location || '',
        device: bug.device || '',
        steps: Array.isArray(bug.steps) ? JSON.stringify(bug.steps) : (bug.steps || ''),
        expected: bug.expected || '',
        actual: bug.actual || '',
        fix: bug.fix || '',
        screenshot_path: bug.screenshot || '',
        test_type: bug.testType || '',
        ai_root_cause: aiAnalysis.rootCause || '',
        ai_recommended_fix: aiAnalysis.recommendedFix || '',
        ai_impact: aiAnalysis.impact || '',
        fingerprint: fp,
        status: 'open',
      });

      // Track this bug as "present" in this run
      statusStmt.run(fp, runId, 'present', now);
    }
  });

  insertMany(bugs);
}

/**
 * Classify bugs against previous runs:
 * - NEW: fingerprint not seen in any previous run
 * - RECURRING: fingerprint seen in the most recent previous run
 * - REGRESSION: fingerprint was absent in the most recent run but present before that
 * - FIXED: fingerprints from previous run that are NOT in this run
 */
function classifyBugs(runId, siteName) {
  const db = getDb();

  // Get the current run's bug fingerprints
  const currentFingerprints = new Set(
    db.prepare('SELECT DISTINCT fingerprint FROM bugs WHERE run_id = ?').all(runId).map(r => r.fingerprint)
  );

  // Get previous run for this site
  const previousRun = db.prepare(
    'SELECT id FROM runs WHERE site_name = ? AND id < ? ORDER BY id DESC LIMIT 1'
  ).get(siteName, runId);

  if (!previousRun) {
    // First run — all bugs are NEW
    return {
      newBugs: [...currentFingerprints],
      recurringBugs: [],
      fixedBugs: [],
      regressions: [],
    };
  }

  const previousFingerprints = new Set(
    db.prepare('SELECT DISTINCT fingerprint FROM bugs WHERE run_id = ?').all(previousRun.id).map(r => r.fingerprint)
  );

  // Get all historical fingerprints (before previous run)
  const historicalFingerprints = new Set(
    db.prepare('SELECT DISTINCT fingerprint FROM bugs WHERE run_id < ?').all(previousRun.id).map(r => r.fingerprint)
  );

  const newBugs = [];
  const recurringBugs = [];
  const regressions = [];

  for (const fp of currentFingerprints) {
    if (previousFingerprints.has(fp)) {
      recurringBugs.push(fp);
    } else if (historicalFingerprints.has(fp)) {
      regressions.push(fp);
    } else {
      newBugs.push(fp);
    }
  }

  // Fixed: in previous run but not in current
  const fixedBugs = [];
  for (const fp of previousFingerprints) {
    if (!currentFingerprints.has(fp)) {
      fixedBugs.push(fp);
      // Record as absent in bug_status_history
      db.prepare(
        'INSERT INTO bug_status_history (bug_fingerprint, run_id, status, recorded_at) VALUES (?, ?, ?, ?)'
      ).run(fp, runId, 'absent', new Date().toISOString());
    }
  }

  return { newBugs, recurringBugs, fixedBugs, regressions };
}

/**
 * Detect flaky bugs: fingerprints that oscillate between present/absent
 * across the last N runs.
 */
function detectFlakyBugs(siteName, minRuns = 4) {
  const db = getDb();

  // Get last N runs for this site
  const runs = db.prepare(
    'SELECT id FROM runs WHERE site_name = ? ORDER BY id DESC LIMIT ?'
  ).all(siteName, minRuns);

  if (runs.length < minRuns) return [];

  const runIds = runs.map(r => r.id);
  const placeholders = runIds.map(() => '?').join(',');

  // Get all fingerprints that appeared in any of these runs
  const entries = db.prepare(`
    SELECT bug_fingerprint, status FROM bug_status_history
    WHERE run_id IN (${placeholders})
    ORDER BY bug_fingerprint, run_id
  `).all(...runIds);

  // Group by fingerprint
  const byFp = {};
  for (const e of entries) {
    if (!byFp[e.bug_fingerprint]) byFp[e.bug_fingerprint] = [];
    byFp[e.bug_fingerprint].push(e.status);
  }

  // A bug is flaky if it alternates present/absent at least twice
  const flaky = [];
  for (const [fp, statuses] of Object.entries(byFp)) {
    let transitions = 0;
    for (let i = 1; i < statuses.length; i++) {
      if (statuses[i] !== statuses[i - 1]) transitions++;
    }
    if (transitions >= 2) flaky.push(fp);
  }

  return flaky;
}

function getBugsByRun(runId) {
  const db = getDb();
  return db.prepare('SELECT * FROM bugs WHERE run_id = ? ORDER BY id').all(runId);
}

function getBugByFingerprint(fp) {
  const db = getDb();
  return db.prepare('SELECT * FROM bugs WHERE fingerprint = ? ORDER BY run_id DESC LIMIT 1').get(fp);
}

function getBugTrends(siteName, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT r.run_number, r.started_at,
      COUNT(b.id) as total_bugs,
      SUM(CASE WHEN b.severity = 'Critical' THEN 1 ELSE 0 END) as critical,
      SUM(CASE WHEN b.severity = 'High' THEN 1 ELSE 0 END) as high,
      SUM(CASE WHEN b.severity = 'Medium' THEN 1 ELSE 0 END) as medium,
      SUM(CASE WHEN b.severity = 'Low' THEN 1 ELSE 0 END) as low
    FROM runs r
    LEFT JOIN bugs b ON b.run_id = r.id
    WHERE r.site_name = ?
    GROUP BY r.id
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(siteName, limit);
}

module.exports = {
  fingerprint, saveBugs, classifyBugs, detectFlakyBugs,
  getBugsByRun, getBugByFingerprint, getBugTrends,
};
