'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { RunContext } = require('./state');
const { log, retry, setupPageListeners } = require('./utils');
const { AIOrchestrator } = require('./ai');
const { getRunner } = require('./tests');
const loginAgent = require('./agents/login');
const discoveryAgent = require('./agents/discovery');
const planningAgent = require('./agents/planning');
const { generateReports, deployToGitPages } = require('./reporting');
const dbRuns = require('./db/runs');
const dbBugs = require('./db/bugs');
const dbPerf = require('./db/perf');
const { close: closeDb } = require('./db');
const { sendSlackNotification, sendSlackPDF } = require('./notifications/slack');
const { sendEmailNotification } = require('./notifications/email');
const { fileJiraBugs } = require('./integrations/jira');
const { fileLinearBugs } = require('./integrations/linear');

async function orchestrate(config) {
  config = config || loadConfig();

  console.log('\n' + '='.repeat(60));
  console.log(' AUTONOMOUS QA AGENT');
  console.log(` Target: ${config.targetUrl}`);
  console.log(` Mode:   ${config.mode} (budget: ${config.budgetMs / 60000} min)`);
  console.log('='.repeat(60) + '\n');

  const ctx = new RunContext(config);

  // Setup directories
  fs.mkdirSync(config.screenshotDir, { recursive: true });
  fs.mkdirSync(config.reportDir, { recursive: true });

  // Launch browser with stealth settings
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    locale: 'en-IN',
    extraHTTPHeaders: {
      'Accept-Language': 'en-IN,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Google Chrome";v="125", "Chromium";v="125", "Not.A/Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    },
  });

  // Remove navigator.webdriver flag
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en'] });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  setupPageListeners(ctx, page);

  try {
    // Layer 0: Login
    await loginAgent(page, config, ctx);

    // Layer 1: Discovery
    const discovery = await discoveryAgent(page, config, ctx);

    // Layer 2: Planning
    const testPlan = planningAgent(discovery, config, ctx);

    // Layer 3: Execution
    log(ctx, '\uD83D\uDE80', 'Layer 3: Execution Agent starting...');
    for (const phase of testPlan) {
      if (ctx.isBudgetExceeded()) {
        log(ctx, '\u23F1\uFE0F', `Budget exceeded — skipping ${phase.name}`);
        break;
      }
      log(ctx, '\uD83D\uDCE6', `Running: ${phase.name} (${phase.tests} tests, Tier ${phase.tier})`);
      const runnerInfo = getRunner(phase.fn);
      if (!runnerInfo) {
        log(ctx, '\u26A0\uFE0F', `Unknown test: ${phase.fn}`);
        continue;
      }
      try {
        const target = runnerInfo.needsBrowser ? browser : page;
        await retry(() => runnerInfo.fn(target, discovery, config, ctx), 1);
      } catch (e) {
        log(ctx, '\u274C', `${phase.name} crashed: ${e.message}`);
      }
    }

    // Layer 4: Reporting
    log(ctx, '\uD83D\uDCCA', 'Layer 4: Reporting Agent starting...');
    const duration = `${Math.round(ctx.elapsed() / 1000)}s`;

    // AI analysis
    const aiOrchestrator = new AIOrchestrator(config);
    let aiCost = 'N/A';
    if (aiOrchestrator.isAvailable()) {
      log(ctx, '\uD83E\uDD16', 'Running AI bug analysis...');
      try {
        await aiOrchestrator.analyzeBugsWithAI(ctx.bugs);
        aiCost = `$${aiOrchestrator.getUsageCost().toFixed(4)}`;
        log(ctx, '\u2705', `AI Analysis complete (cost: ${aiCost})`);

        const intel = await aiOrchestrator.generateTestIntelligence(discovery, null, null, ctx.bugs);
        if (intel) log(ctx, '\u2705', 'AI Test Intelligence saved to knowledge/ai-suggestions.json');
      } catch (e) {
        log(ctx, '\u26A0\uFE0F', `AI analysis failed: ${e.message}`);
      }
    }

    // Determine report number from database
    const reportNum = dbRuns.getNextRunNumber(config.siteName);

    const metadata = { duration, reportNum, perfData: ctx.perfData, aiCost };

    const { reportPath, jsonPath } = generateReports(discovery, metadata, testPlan, config, ctx);
    log(ctx, '\u2705', `Reports saved: ${reportPath}`);

    // ---- Persist to SQLite ----
    log(ctx, '\uD83D\uDCBE', 'Saving run data to database...');
    const durationSec = Math.round(ctx.elapsed() / 1000);
    const healthScore = Math.max(0, Math.round(
      100 - (ctx.bugs.filter(b => b.severity === 'Critical').length * 20)
          - (ctx.bugs.filter(b => b.severity === 'High').length * 10)
          - (ctx.bugs.filter(b => b.severity === 'Medium').length * 3)
          - (ctx.bugs.filter(b => b.severity === 'Low').length * 1)
    ));

    let gitSha = '';
    try { gitSha = require('child_process').execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch (e) {}

    const runId = dbRuns.saveRun({
      run_number: reportNum,
      site_url: config.targetUrl,
      site_name: config.siteName,
      mode: config.mode,
      started_at: new Date(ctx.startTime).toISOString(),
      finished_at: new Date().toISOString(),
      duration_sec: durationSec,
      pages_live: discovery.livePages.length,
      pages_dead: discovery.deadPages.length,
      tests_passed: ctx.testResults.passed,
      tests_failed: ctx.testResults.failed,
      tests_skipped: ctx.testResults.skipped,
      tests_total: ctx.testResults.total,
      health_score: healthScore,
      ai_cost_usd: aiOrchestrator.isAvailable() ? aiOrchestrator.getUsageCost() : 0,
      report_path: reportPath || '',
      json_path: jsonPath || '',
      platform: process.platform,
      git_sha: gitSha,
    });

    // Save bugs with fingerprints
    if (ctx.bugs.length > 0) {
      dbBugs.saveBugs(runId, ctx.bugs);
      const classification = dbBugs.classifyBugs(runId, config.siteName);
      log(ctx, '\uD83D\uDD0D', `Bug classification — New: ${classification.newBugs.length}, Recurring: ${classification.recurringBugs.length}, Fixed: ${classification.fixedBugs.length}, Regressions: ${classification.regressions.length}`);
    }

    // Save performance metrics
    if (ctx.perfData.length > 0) {
      dbPerf.saveMetrics(runId, ctx.perfData);
    }

    log(ctx, '\u2705', `Run #${reportNum} saved to database (ID: ${runId})`);

    // ---- Notifications & Integrations ----
    // Build GitHub Pages report URL
    const reportFileName = `full-report-${config.siteName}.html`;
    let pagesReportUrl = '';
    try {
      const remoteUrl = require('child_process').execSync('git remote get-url origin', { encoding: 'utf-8', stdio: 'pipe' }).trim();
      const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) pagesReportUrl = `https://${m[1]}.github.io/${m[2]}/AutomatedWebTesting/reports/${reportFileName}`;
    } catch {}

    const notificationData = {
      siteName: config.siteName,
      targetUrl: config.targetUrl,
      mode: config.mode,
      healthScore,
      totalBugs: ctx.bugs.length,
      critical: ctx.bugs.filter(b => b.severity === 'Critical').length,
      high: ctx.bugs.filter(b => b.severity === 'High').length,
      medium: ctx.bugs.filter(b => b.severity === 'Medium').length,
      low: ctx.bugs.filter(b => b.severity === 'Low').length,
      passed: ctx.testResults.passed,
      failed: ctx.testResults.failed,
      skipped: ctx.testResults.skipped,
      flaky: ctx.testResults.flaky || 0,
      total: ctx.testResults.total,
      pagesLive: discovery.livePages.length,
      pagesDead: discovery.deadPages.length,
      duration: `${durationSec}s`,
      reportUrl: pagesReportUrl,
    };

    // Send notifications (non-blocking)
    const notifyPromises = [
      sendSlackNotification(notificationData).catch(() => {}),
      sendEmailNotification(notificationData).catch(() => {}),
    ];

    // File bugs to Jira/Linear
    if (ctx.bugs.length > 0) {
      notifyPromises.push(fileJiraBugs(ctx.bugs, config.siteName).catch(() => []));
      notifyPromises.push(fileLinearBugs(ctx.bugs, config.siteName).catch(() => []));
    }

    await Promise.all(notifyPromises);

    // Send report PDF to Slack
    await sendSlackPDF(reportPath, notificationData).catch(() => {});

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log(' TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(` URL:        ${config.targetUrl}`);
    console.log(` Duration:   ${durationSec}s`);
    console.log(` Pages:      ${discovery.livePages.length} live / ${discovery.deadPages.length} dead`);
    console.log(` Tests:      ${ctx.testResults.total} total — ${ctx.testResults.passed} passed, ${ctx.testResults.failed} failed, ${ctx.testResults.skipped} skipped`);
    console.log(` Bugs:       ${ctx.bugs.length} total`);
    console.log(`   Critical: ${ctx.bugs.filter(b => b.severity === 'Critical').length}`);
    console.log(`   High:     ${ctx.bugs.filter(b => b.severity === 'High').length}`);
    console.log(`   Medium:   ${ctx.bugs.filter(b => b.severity === 'Medium').length}`);
    console.log(`   Low:      ${ctx.bugs.filter(b => b.severity === 'Low').length}`);
    console.log(` Health:     ${healthScore}%`);
    console.log(` Report:     ${reportPath}`);
    console.log(` DB Run ID:  ${runId}`);
    console.log('='.repeat(60) + '\n');

    // Auto-deploy report to GitHub Pages
    await deployToGitPages({
      reportPath,
      siteName: config.siteName,
      bugCount: ctx.bugs.length,
      bugCounts: {
        critical: ctx.bugs.filter(b => b.severity === 'Critical').length,
        high: ctx.bugs.filter(b => b.severity === 'High').length,
        medium: ctx.bugs.filter(b => b.severity === 'Medium').length,
        low: ctx.bugs.filter(b => b.severity === 'Low').length,
      },
      runNumber: reportNum,
      type: 'single',
    });

  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
    closeDb();
  }
}

module.exports = { orchestrate };
