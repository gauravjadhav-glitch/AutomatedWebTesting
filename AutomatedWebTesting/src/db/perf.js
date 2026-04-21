'use strict';

const { getDb } = require('./index');

function saveMetrics(runId, perfData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO perf_metrics (run_id, page_path, load_time_ms, fcp_ms, lcp_ms,
      cls, ttfb_ms, dom_nodes, transfer_size_bytes, request_count)
    VALUES (@run_id, @page_path, @load_time_ms, @fcp_ms, @lcp_ms,
      @cls, @ttfb_ms, @dom_nodes, @transfer_size_bytes, @request_count)
  `);

  const insertMany = db.transaction((metrics) => {
    for (const m of metrics) {
      stmt.run({
        run_id: runId,
        page_path: m.path || '/',
        load_time_ms: m.loadTime || null,
        fcp_ms: m.fcp || null,
        lcp_ms: m.lcp || null,
        cls: m.cls || null,
        ttfb_ms: m.ttfb || null,
        dom_nodes: m.domNodes || null,
        transfer_size_bytes: m.transferSize || null,
        request_count: m.requests || null,
      });
    }
  });

  insertMany(perfData);
}

function getMetricsByRun(runId) {
  const db = getDb();
  return db.prepare('SELECT * FROM perf_metrics WHERE run_id = ? ORDER BY page_path').all(runId);
}

function getPerfTrends(siteName, pagePath, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT r.run_number, r.started_at, p.page_path,
      p.load_time_ms, p.fcp_ms, p.lcp_ms, p.cls, p.ttfb_ms, p.dom_nodes
    FROM perf_metrics p
    JOIN runs r ON r.id = p.run_id
    WHERE r.site_name = ? AND p.page_path = ?
    ORDER BY r.started_at DESC
    LIMIT ?
  `).all(siteName, pagePath, limit);
}

function getAvgMetrics(siteName) {
  const db = getDb();
  return db.prepare(`
    SELECT
      AVG(p.load_time_ms) as avg_load_time,
      AVG(p.fcp_ms) as avg_fcp,
      AVG(p.lcp_ms) as avg_lcp,
      AVG(p.ttfb_ms) as avg_ttfb,
      AVG(p.dom_nodes) as avg_dom_nodes
    FROM perf_metrics p
    JOIN runs r ON r.id = p.run_id
    WHERE r.site_name = ?
    AND r.id = (SELECT MAX(id) FROM runs WHERE site_name = ?)
  `).get(siteName, siteName);
}

module.exports = { saveMetrics, getMetricsByRun, getPerfTrends, getAvgMetrics };
