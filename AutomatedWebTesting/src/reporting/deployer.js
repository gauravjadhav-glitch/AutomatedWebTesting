'use strict';

const fs = require('fs');
const path = require('path');

function deployToGitHubPages(htmlReport, jsonReport, config) {
  try {
    const deployDir = path.join(config.reportDir, 'deploy', 'AutomatedWebTesting', 'reports', config.siteName);
    fs.mkdirSync(deployDir, { recursive: true });
    fs.writeFileSync(path.join(deployDir, 'index.html'), htmlReport);
    fs.writeFileSync(path.join(deployDir, 'bug-report.json'), JSON.stringify(jsonReport, null, 2));

    // Copy screenshots
    const deployScreenshotDir = path.join(deployDir, 'screenshots');
    fs.mkdirSync(deployScreenshotDir, { recursive: true });
    try {
      const ssFiles = fs.readdirSync(config.screenshotDir).filter(f => f.endsWith('.png'));
      for (const f of ssFiles) {
        fs.copyFileSync(path.join(config.screenshotDir, f), path.join(deployScreenshotDir, f));
      }
    } catch (e) {
      // Screenshot dir may not exist
    }

    console.log(`\u2705 Deploy files saved to: ${deployDir}`);
  } catch (e) {
    console.log(`\u26A0\uFE0F Deploy copy failed: ${e.message}`);
  }
}

module.exports = { deployToGitHubPages };
