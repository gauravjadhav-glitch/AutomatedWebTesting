'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Slack notification — posts test summary in professional format.
 *
 * Format:
 *   SiteName-Test-Summary | TOTAL: 19 📊 | PASS: 14 ✅ | FAIL: 5 ❌ | FLAKY: 0 ⚠️ | SKIP: 0 ⏩
 *   URL: https://...
 *   Environment: UAT
 *   Branch: main
 *   Report: 🔗 link
 *   Browser: chromium
 *   Triggered By: user@example.com
 *
 * Configure in .env:
 *   SLACK_WEBHOOK_URL  — Incoming webhook URL
 *   SLACK_BOT_TOKEN    — Bot token (for PDF upload)
 *   SLACK_CHANNEL      — Channel ID (for PDF upload)
 *   TRIGGERED_BY       — Email of person who triggered the run (optional)
 */
async function sendSlackNotification(runData) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const botToken = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;

  if (!webhookUrl && !botToken) return null;
  if (!webhookUrl && !channel) {
    console.log('  [Slack] Skipped: SLACK_CHANNEL not set');
    return null;
  }

  const total = runData.total || 0;
  const passed = runData.passed || 0;
  const failed = runData.failed || 0;
  const flaky = runData.flaky || 0;
  const skipped = runData.skipped || 0;

  const siteName = formatSiteName(runData.siteName);
  const env = detectEnvironment(runData.targetUrl || runData.siteName);
  const branch = getGitBranch();
  const triggeredBy = process.env.TRIGGERED_BY || getGitUser();
  const reportUrl = runData.reportUrl || '';

  // Status emoji based on results
  const statusEmoji = failed > 0 ? ':x:' : ':white_check_mark:';

  const blocks = [
    // Header — Site-Test-Summary with stats bar
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${siteName}-Test-Summary`,
      },
    },
    // Bugs bar — Bugs Found | Critical | High | Medium | Low
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `:bug: *Bugs Found:  ${runData.totalBugs || 0}*`,
          `:rotating_light: *Critical:  ${runData.critical || 0}*`,
          `:fire: *High:  ${runData.high || 0}*`,
          `:large_yellow_circle: *Medium:  ${runData.medium || 0}*`,
          `:white_check_mark: *Low:  ${runData.low || 0}*`,
        ].join('  |  '),
      },
    },
    { type: 'divider' },
    // Metadata fields
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*URL :*\n ${runData.targetUrl || runData.siteName || 'N/A'}`,
        },
        {
          type: 'mrkdwn',
          text: `*Environment :*\n ${env}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Branch :*\n ${branch}`,
        },
        {
          type: 'mrkdwn',
          text: `*Report :*\n ${reportUrl ? `<${reportUrl}|:link: View Report>` : ':link:'}`,
        },
      ],
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: '*Browser :*\n chromium',
        },
        {
          type: 'mrkdwn',
          text: `*Triggered By :*\n ${triggeredBy}`,
        },
      ],
    },
  ];

  // Duration + Health
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `:stopwatch: Duration: ${runData.duration || 'N/A'}  |  :heartpulse: Health: ${runData.healthScore || 'N/A'}%  |  :page_facing_up: Pages: ${runData.pagesLive || 0} live / ${runData.pagesDead || 0} dead`,
      },
    ],
  });

  try {
    let response;

    if (webhookUrl) {
      // Use webhook (tied to a fixed channel)
      response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blocks }),
      });
      if (!response.ok) {
        console.log(`  [Slack] Webhook failed: ${response.status} ${response.statusText}`);
        return false;
      }
    } else {
      // Use Bot Token + chat.postMessage (sends to SLACK_CHANNEL)
      response = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, blocks }),
      });
      const data = await response.json();
      if (!data.ok) {
        console.log(`  [Slack] Failed: ${data.error}`);
        return false;
      }
    }

    console.log('  [Slack] Notification sent successfully');
    return true;
  } catch (e) {
    console.log(`  [Slack] Error: ${e.message}`);
    return false;
  }
}

/**
 * Convert HTML report to PDF using Playwright and upload to Slack.
 *
 * Configure in .env:
 *   SLACK_BOT_TOKEN  — Bot token with files:write + chat:write scopes
 *   SLACK_CHANNEL    — Channel ID to post the PDF (e.g. C0123456789)
 *
 * @param {string} reportPath — Absolute path to the HTML report file
 * @param {Object} runData    — Run metadata (siteName, totalBugs, etc.)
 */
async function sendSlackPDF(reportPath, runData) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL;

  if (!token || !channel) {
    if (!token) console.log('  [Slack PDF] Skipped: SLACK_BOT_TOKEN not set');
    if (!channel) console.log('  [Slack PDF] Skipped: SLACK_CHANNEL not set');
    return null;
  }

  if (!fs.existsSync(reportPath)) {
    console.log(`  [Slack PDF] Report not found: ${reportPath}`);
    return null;
  }

  console.log('  [Slack PDF] Converting report to PDF...');

  // 1. Convert HTML to PDF using Playwright
  const pdfPath = reportPath.replace(/\.html$/, '.pdf');
  try {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(`file://${reportPath}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      landscape: true,
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
    });
    await browser.close();
    const pdfSize = fs.statSync(pdfPath).size;
    console.log(`  [Slack PDF] PDF generated: ${(pdfSize / 1048576).toFixed(1)} MB`);
  } catch (e) {
    console.log(`  [Slack PDF] PDF generation failed: ${e.message}`);
    return null;
  }

  // 2. Upload PDF to Slack using files.uploadV2
  const siteName = runData.siteName || 'unknown';
  const bugCount = runData.totalBugs || 0;
  const today = new Date().toISOString().slice(0, 10);
  const fileName = `QA-Report_${siteName}_${today}.pdf`;
  const title = `QA Report: ${siteName} \u2014 ${bugCount} bugs (${today})`;

  const env = detectEnvironment(runData.targetUrl || siteName);
  const initialComment = [
    `*${formatSiteName(siteName)}-${env}-Test-Report* :page_facing_up:`,
    `Bugs: *${bugCount}*  |  Tests: *${runData.total || 0}* (${runData.passed || 0} pass / ${runData.failed || 0} fail)`,
    runData.reportUrl ? `<${runData.reportUrl}|:link: View online report>` : '',
  ].filter(Boolean).join('\n');

  try {
    const pdfBuffer = fs.readFileSync(pdfPath);

    // Step 1: Get upload URL
    const getUrlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        filename: fileName,
        length: pdfBuffer.length.toString(),
      }),
    });
    const getUrlData = await getUrlRes.json();
    if (!getUrlData.ok) {
      console.log(`  [Slack PDF] Get upload URL failed: ${getUrlData.error}`);
      return null;
    }

    // Step 2: Upload the file
    const uploadRes = await fetch(getUrlData.upload_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/pdf' },
      body: pdfBuffer,
    });
    if (!uploadRes.ok) {
      console.log(`  [Slack PDF] Upload failed: ${uploadRes.status}`);
      return null;
    }

    // Step 3: Complete upload and share to channel
    const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        files: [{ id: getUrlData.file_id, title }],
        channel_id: channel,
        initial_comment: initialComment,
      }),
    });
    const completeData = await completeRes.json();
    if (!completeData.ok) {
      console.log(`  [Slack PDF] Complete upload failed: ${completeData.error}`);
      return null;
    }

    console.log(`  [Slack PDF] Report uploaded to #${channel}`);

    // Cleanup PDF
    try { fs.unlinkSync(pdfPath); } catch {}

    return true;
  } catch (e) {
    console.log(`  [Slack PDF] Error: ${e.message}`);
    try { fs.unlinkSync(pdfPath); } catch {}
    return null;
  }
}

// --- Helpers ---

/**
 * Format site name for display: "coachnew-fynd-io" → "Coachnew-Fynd-Io"
 */
function formatSiteName(name) {
  if (!name) return 'Unknown';
  return name
    .replace(/https?:\/\//, '')
    .replace(/[/.]/g, '-')
    .replace(/-+$/, '')
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

/**
 * Detect environment from URL: fynd.io → UAT, .com/.in → PROD
 */
function detectEnvironment(urlOrName) {
  if (!urlOrName) return 'N/A';
  const s = urlOrName.toLowerCase();
  if (s.includes('fynd.io')) return 'UAT';
  if (s.includes('localhost') || s.includes('127.0.0.1')) return 'LOCAL';
  if (s.includes('staging') || s.includes('stage')) return 'STAGING';
  if (s.includes('uat') || s.includes('test') || s.includes('dev')) return 'UAT';
  return 'PROD';
}

/**
 * Get current git branch name.
 */
function getGitBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return 'N/A';
  }
}

/**
 * Get git user email for "Triggered By".
 */
function getGitUser() {
  try {
    return execSync('git config user.email', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return process.env.USER || 'automation';
  }
}

module.exports = { sendSlackNotification, sendSlackPDF };
