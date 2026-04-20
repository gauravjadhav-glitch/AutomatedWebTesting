'use strict';

const fs = require('fs');
const path = require('path');
const generateHTMLReport = require('./html-generator');
const { generateJSONReport } = require('./json-reporter');
const { deployToGitHubPages } = require('./deployer');

function generateReports(discovery, metadata, testPlan, config, ctx) {
  const htmlReport = generateHTMLReport({
    discovery, metadata, testPlan,
    bugs: ctx.bugs,
    testResults: ctx.testResults,
    consoleErrors: ctx.consoleErrors,
    networkErrors: ctx.networkErrors,
    screenshotDir: config.screenshotDir,
    targetUrl: config.targetUrl,
    mode: config.mode,
    siteName: config.siteName,
    budgetMs: config.budgetMs,
  });

  // Save HTML report
  const reportFileName = `full-report-${config.siteName}.html`;
  const reportPath = path.join(config.reportDir, reportFileName);
  fs.writeFileSync(reportPath, htmlReport);

  // Save JSON report
  const jsonReport = generateJSONReport(discovery, metadata, config, ctx);
  const jsonPath = path.join(config.reportDir, `bug-report-${config.siteName}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, null, 2));

  // Deploy to GitHub Pages
  deployToGitHubPages(htmlReport, jsonReport, config);

  return { reportPath, jsonPath };
}

module.exports = { generateReports };
