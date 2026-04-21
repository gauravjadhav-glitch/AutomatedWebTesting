'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { ComparisonContext } = require('./context');
const { generateFlows } = require('./flow-generator');
const { replayFlow } = require('./flow-replayer');
const { computeDiffs } = require('./diff-engine');
const { generateComparisonReport } = require('./report-generator');
const { RunContext } = require('../state');
const loginAgent = require('../agents/login');
const discoveryAgent = require('../agents/discovery');
const { setupPageListeners } = require('../utils');

/**
 * Orchestrate a full UAT vs PROD comparison.
 */
async function orchestrateComparison(uatUrl, prodUrl, config) {
  const compCtx = new ComparisonContext(uatUrl, prodUrl, config);

  console.log('\n' + '='.repeat(60));
  console.log(' COMPARISON MODE');
  console.log(` UAT:  ${compCtx.uatUrl}`);
  console.log(` PROD: ${compCtx.prodUrl}`);
  console.log(` Mode: ${config.mode} (budget: ${Math.round(config.budgetMs * 1.5 / 60000)} min)`);
  console.log('='.repeat(60) + '\n');

  // Setup directories
  const ssDir = path.join(config.reportDir, 'comparison-screenshots');
  fs.mkdirSync(ssDir, { recursive: true });
  fs.mkdirSync(config.reportDir, { recursive: true });

  // Launch browser with stealth settings
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    // Phase 1: Discovery on UAT
    console.log('\n--- Phase 1: Discovery (UAT only) ---\n');
    const discoveryCtx = new RunContext(config);
    const discoveryContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const discoveryPage = await discoveryContext.newPage();
    setupPageListeners(discoveryCtx, discoveryPage);

    // Login on UAT
    const uatConfig = { ...config, targetUrl: compCtx.uatUrl };
    await loginAgent(discoveryPage, uatConfig, discoveryCtx);

    // Discover on UAT
    const discovery = await discoveryAgent(discoveryPage, uatConfig, discoveryCtx);
    compCtx.discovery = discovery;
    await discoveryContext.close().catch(() => {});

    // Phase 2: Generate flows
    console.log('\n--- Phase 2: Generate Flows ---\n');
    const flows = generateFlows(discovery, config);
    compCtx.flows = flows;

    const totalSteps = flows.reduce((sum, f) => sum + f.steps.length, 0);
    compCtx.summary.totalSteps = totalSteps;
    console.log(`Generated ${flows.length} flows with ${totalSteps} total steps:`);
    for (const f of flows) {
      console.log(`  - ${f.name} (${f.steps.length} steps, ${f.category})`);
    }

    // Phase 3: Replay flows on both environments
    console.log('\n--- Phase 3: Replay & Compare ---\n');
    for (const flow of flows) {
      if (compCtx.isBudgetExceeded()) {
        console.log(`\u23F1\uFE0F Budget exceeded — skipping remaining flows`);
        break;
      }

      console.log(`\n\u25B6 Flow: ${flow.name} (${flow.steps.length} steps)`);

      // Replay on UAT
      console.log(`  [UAT] Replaying...`);
      const uatResults = await replayFlow(flow, compCtx.uatUrl, browser, config, 'uat');
      compCtx.uatResults[flow.id] = uatResults;
      const uatSuccess = uatResults.filter(r => r.status === 'success').length;
      console.log(`  [UAT] Done: ${uatSuccess}/${uatResults.length} steps succeeded`);

      // Replay on PROD
      console.log(`  [PROD] Replaying...`);
      const prodResults = await replayFlow(flow, compCtx.prodUrl, browser, config, 'prod');
      compCtx.prodResults[flow.id] = prodResults;
      const prodSuccess = prodResults.filter(r => r.status === 'success').length;
      console.log(`  [PROD] Done: ${prodSuccess}/${prodResults.length} steps succeeded`);

      // Compute diffs
      const diffs = computeDiffs(flow, uatResults, prodResults, config);
      for (const diff of diffs) {
        compCtx.addDiff(diff);
      }

      // Count matched steps (steps with no diffs)
      const stepsWithDiffs = new Set(diffs.filter(d => d.hasDiff).map(d => d.stepIndex));
      const matched = flow.steps.length - stepsWithDiffs.size;
      compCtx.summary.matchedSteps += matched;

      const diffCount = diffs.filter(d => d.hasDiff).length;
      if (diffCount > 0) {
        console.log(`  \u26A0\uFE0F  ${diffCount} differences found`);
      } else {
        console.log(`  \u2705 No differences`);
      }
    }

    // Phase 4: Generate Report
    console.log('\n--- Phase 4: Generate Comparison Report ---\n');
    const reportHtml = generateComparisonReport(compCtx);
    const reportPath = path.join(config.reportDir, 'full-comparison-report.html');
    fs.writeFileSync(reportPath, reportHtml);

    // Save JSON report
    const jsonReport = {
      meta: {
        type: 'comparison',
        uatUrl: compCtx.uatUrl,
        prodUrl: compCtx.prodUrl,
        timestamp: new Date().toISOString(),
        duration: `${Math.round(compCtx.elapsed() / 1000)}s`,
        mode: config.mode,
        flowCount: compCtx.flows.length,
        totalSteps: compCtx.summary.totalSteps,
      },
      summary: compCtx.summary,
      diffs: compCtx.diffs,
      flows: compCtx.flows.map(f => ({
        id: f.id,
        name: f.name,
        category: f.category,
        stepCount: f.steps.length,
      })),
    };
    const jsonPath = path.join(config.reportDir, 'comparison-report.json');
    fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));

    // Print summary
    const s = compCtx.summary;
    console.log('\n' + '='.repeat(60));
    console.log(' COMPARISON SUMMARY');
    console.log('='.repeat(60));
    console.log(` UAT:            ${compCtx.uatUrl}`);
    console.log(` PROD:           ${compCtx.prodUrl}`);
    console.log(` Duration:       ${Math.round(compCtx.elapsed() / 1000)}s`);
    console.log(` Flows:          ${compCtx.flows.length}`);
    console.log(` Total Steps:    ${s.totalSteps}`);
    console.log(` Matched:        ${s.matchedSteps}`);
    console.log(` Differences:    ${s.diffSteps}`);
    console.log(`   Visual:       ${s.visualDiffs}`);
    console.log(`   Structural:   ${s.structuralDiffs}`);
    console.log(`   Data:         ${s.dataDiffs}`);
    console.log(`   Functional:   ${s.functionalDiffs}`);
    console.log(`   Performance:  ${s.perfRegressions}`);
    console.log(` Report:         ${reportPath}`);
    console.log('='.repeat(60) + '\n');

    // Open report
    try {
      const { exec } = require('child_process');
      exec(`open "${reportPath}"`);
    } catch {}

  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { orchestrateComparison };
