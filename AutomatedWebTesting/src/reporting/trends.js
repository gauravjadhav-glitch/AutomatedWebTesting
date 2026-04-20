'use strict';

const dbRuns = require('../db/runs');
const dbBugs = require('../db/bugs');
const dbPerf = require('../db/perf');

/**
 * Get all trend data for a site (for chart generation).
 */
function getTrendData(siteName, limit = 15) {
  const bugTrends = dbBugs.getBugTrends(siteName, limit);
  const runs = dbRuns.getRunsBySite(siteName, limit);

  // Health score trend
  const healthTrend = runs.map(r => ({
    run: r.run_number,
    date: r.started_at,
    score: r.health_score,
  })).reverse();

  // Bug count trend
  const bugCountTrend = bugTrends.map(t => ({
    run: t.run_number,
    date: t.started_at,
    total: t.total_bugs,
    critical: t.critical,
    high: t.high,
    medium: t.medium,
    low: t.low,
  })).reverse();

  // Pass rate trend
  const passRateTrend = runs.map(r => ({
    run: r.run_number,
    date: r.started_at,
    passed: r.tests_passed,
    failed: r.tests_failed,
    total: r.tests_total,
    rate: r.tests_total > 0 ? Math.round((r.tests_passed / r.tests_total) * 100) : 0,
  })).reverse();

  // Performance trend (avg metrics per run)
  const perfTrend = runs.map(r => {
    const metrics = dbPerf.getMetricsByRun(r.id);
    if (metrics.length === 0) return null;

    const avg = (arr, key) => {
      const vals = arr.map(m => m[key]).filter(v => v != null);
      return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    };

    return {
      run: r.run_number,
      date: r.started_at,
      avgFcp: avg(metrics, 'fcp_ms'),
      avgLcp: avg(metrics, 'lcp_ms'),
      avgTtfb: avg(metrics, 'ttfb_ms'),
      avgLoadTime: avg(metrics, 'load_time_ms'),
    };
  }).filter(Boolean).reverse();

  return { healthTrend, bugCountTrend, passRateTrend, perfTrend };
}

module.exports = { getTrendData };
