'use strict';

const dbRuns = require('../db/runs');
const dbBugs = require('../db/bugs');
const { close: closeDb } = require('../db');

function printHistory(siteName) {
  try {
    const runs = siteName ? dbRuns.getRunsBySite(siteName) : dbRuns.getRecentRuns(20);

    if (runs.length === 0) {
      console.log(siteName ? `No runs found for "${siteName}".` : 'No runs found in database.');
      console.log('Run a test first: node run-test.js <url>');
      return;
    }

    console.log('\n' + '='.repeat(90));
    console.log(siteName ? ` RUN HISTORY: ${siteName}` : ' RECENT RUNS (all sites)');
    console.log('='.repeat(90));
    console.log(
      pad('Run#', 6) + pad('Site', 25) + pad('Mode', 10) +
      pad('Bugs', 6) + pad('Health', 8) + pad('Duration', 10) + 'Date'
    );
    console.log('-'.repeat(90));

    for (const r of runs) {
      const date = r.started_at ? r.started_at.slice(0, 16).replace('T', ' ') : 'N/A';
      console.log(
        pad(`#${r.run_number}`, 6) +
        pad(r.site_name, 25) +
        pad(r.mode, 10) +
        pad(String(r.tests_failed || 0), 6) +
        pad(`${r.health_score}%`, 8) +
        pad(`${r.duration_sec}s`, 10) +
        date
      );
    }
    console.log('='.repeat(90) + '\n');
  } finally {
    closeDb();
  }
}

function printTrends(siteName) {
  try {
    if (!siteName) {
      // List all sites
      const runs = dbRuns.getRecentRuns(100);
      const sites = [...new Set(runs.map(r => r.site_name))];
      if (sites.length === 0) {
        console.log('No runs found in database.');
        return;
      }
      console.log('\nAvailable sites:');
      for (const s of sites) {
        const siteRuns = runs.filter(r => r.site_name === s);
        console.log(`  ${s} (${siteRuns.length} runs)`);
      }
      console.log('\nUsage: node run-test.js --trends <site-name>\n');
      return;
    }

    const trends = dbBugs.getBugTrends(siteName, 15);
    if (trends.length === 0) {
      console.log(`No bug data found for "${siteName}".`);
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log(` BUG TRENDS: ${siteName}`);
    console.log('='.repeat(80));
    console.log(
      pad('Run#', 6) + pad('Total', 8) + pad('Critical', 10) +
      pad('High', 8) + pad('Medium', 8) + pad('Low', 8) + 'Date'
    );
    console.log('-'.repeat(80));

    for (const t of trends) {
      const date = t.started_at ? t.started_at.slice(0, 16).replace('T', ' ') : 'N/A';
      console.log(
        pad(`#${t.run_number}`, 6) +
        pad(String(t.total_bugs), 8) +
        pad(String(t.critical), 10) +
        pad(String(t.high), 8) +
        pad(String(t.medium), 8) +
        pad(String(t.low), 8) +
        date
      );
    }

    // Show bar chart
    console.log('\n Bug count over time:');
    const maxBugs = Math.max(...trends.map(t => t.total_bugs), 1);
    for (const t of trends.reverse()) {
      const barLen = Math.round((t.total_bugs / maxBugs) * 40);
      const bar = '\u2588'.repeat(barLen) + '\u2591'.repeat(40 - barLen);
      console.log(`  #${String(t.run_number).padStart(3)} ${bar} ${t.total_bugs}`);
    }

    // Flaky bugs
    const flaky = dbBugs.detectFlakyBugs(siteName);
    if (flaky.length > 0) {
      console.log(`\n Flaky bugs detected: ${flaky.length}`);
      for (const fp of flaky.slice(0, 5)) {
        const bug = dbBugs.getBugByFingerprint(fp);
        if (bug) console.log(`  [${bug.severity}] ${bug.title} (${fp})`);
      }
    }

    console.log('='.repeat(80) + '\n');
  } finally {
    closeDb();
  }
}

function pad(str, len) {
  return String(str).padEnd(len);
}

module.exports = { printHistory, printTrends };
