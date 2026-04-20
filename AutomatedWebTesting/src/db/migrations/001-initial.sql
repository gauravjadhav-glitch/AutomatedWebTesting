-- QA Agent Database Schema v1

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_number INTEGER NOT NULL,
  site_url TEXT NOT NULL,
  site_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_sec INTEGER,
  pages_live INTEGER DEFAULT 0,
  pages_dead INTEGER DEFAULT 0,
  tests_passed INTEGER DEFAULT 0,
  tests_failed INTEGER DEFAULT 0,
  tests_skipped INTEGER DEFAULT 0,
  tests_total INTEGER DEFAULT 0,
  health_score INTEGER DEFAULT 0,
  ai_cost_usd REAL DEFAULT 0,
  report_path TEXT,
  json_path TEXT,
  platform TEXT,
  git_sha TEXT
);

CREATE TABLE IF NOT EXISTS bugs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  bug_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  device TEXT,
  steps TEXT,
  expected TEXT,
  actual TEXT,
  fix TEXT,
  screenshot_path TEXT,
  test_type TEXT,
  ai_root_cause TEXT,
  ai_recommended_fix TEXT,
  ai_impact TEXT,
  fingerprint TEXT NOT NULL,
  status TEXT DEFAULT 'open',
  UNIQUE(run_id, bug_id)
);

CREATE TABLE IF NOT EXISTS bug_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bug_fingerprint TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS perf_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  page_path TEXT NOT NULL,
  load_time_ms INTEGER,
  fcp_ms INTEGER,
  lcp_ms INTEGER,
  cls REAL,
  ttfb_ms INTEGER,
  dom_nodes INTEGER,
  transfer_size_bytes INTEGER,
  request_count INTEGER
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  suggestion_type TEXT,
  data TEXT
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_bugs_run_id ON bugs(run_id);
CREATE INDEX IF NOT EXISTS idx_bugs_fingerprint ON bugs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_bugs_severity ON bugs(severity);
CREATE INDEX IF NOT EXISTS idx_bug_status_fingerprint ON bug_status_history(bug_fingerprint);
CREATE INDEX IF NOT EXISTS idx_perf_run_id ON perf_metrics(run_id);
CREATE INDEX IF NOT EXISTS idx_runs_site_name ON runs(site_name);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
