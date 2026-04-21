'use strict';

const { getDb } = require('./index');

function saveRun(runData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO runs (run_number, site_url, site_name, mode, started_at, finished_at,
      duration_sec, pages_live, pages_dead, tests_passed, tests_failed, tests_skipped,
      tests_total, health_score, ai_cost_usd, report_path, json_path, platform, git_sha)
    VALUES (@run_number, @site_url, @site_name, @mode, @started_at, @finished_at,
      @duration_sec, @pages_live, @pages_dead, @tests_passed, @tests_failed, @tests_skipped,
      @tests_total, @health_score, @ai_cost_usd, @report_path, @json_path, @platform, @git_sha)
  `);
  const result = stmt.run(runData);
  return result.lastInsertRowid;
}

function getLatestRunNumber(siteName) {
  const db = getDb();
  const row = db.prepare('SELECT MAX(run_number) as maxNum FROM runs WHERE site_name = ?').get(siteName);
  return row?.maxNum || 0;
}

function getNextRunNumber(siteName) {
  return getLatestRunNumber(siteName) + 1;
}

function getRunById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
}

function getRecentRuns(limit = 20) {
  const db = getDb();
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?').all(limit);
}

function getRunsBySite(siteName, limit = 20) {
  const db = getDb();
  return db.prepare('SELECT * FROM runs WHERE site_name = ? ORDER BY started_at DESC LIMIT ?').all(siteName, limit);
}

function getAllRuns() {
  const db = getDb();
  return db.prepare('SELECT * FROM runs ORDER BY started_at DESC').all();
}

function updateRun(id, updates) {
  const db = getDb();
  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  const stmt = db.prepare(`UPDATE runs SET ${fields} WHERE id = @id`);
  stmt.run({ ...updates, id });
}

module.exports = { saveRun, getLatestRunNumber, getNextRunNumber, getRunById, getRecentRuns, getRunsBySite, getAllRuns, updateRun };
