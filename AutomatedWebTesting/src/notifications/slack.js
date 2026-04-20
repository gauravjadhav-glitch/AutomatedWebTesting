'use strict';

/**
 * Slack notification — posts test run summary via incoming webhook.
 * Configure: SLACK_WEBHOOK_URL in .env
 */
async function sendSlackNotification(runData) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const emoji = runData.healthScore >= 80 ? ':white_check_mark:' :
                runData.healthScore >= 50 ? ':warning:' : ':rotating_light:';

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} QA Report: ${runData.siteName}` },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Health Score:*\n${runData.healthScore}%` },
        { type: 'mrkdwn', text: `*Mode:*\n${runData.mode}` },
        { type: 'mrkdwn', text: `*Bugs:*\n${runData.totalBugs} total` },
        { type: 'mrkdwn', text: `*Duration:*\n${runData.duration}` },
      ],
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Critical:* ${runData.critical || 0}` },
        { type: 'mrkdwn', text: `*High:* ${runData.high || 0}` },
        { type: 'mrkdwn', text: `*Tests:* ${runData.passed}/${runData.total} passed` },
        { type: 'mrkdwn', text: `*Pages:* ${runData.pagesLive} live, ${runData.pagesDead} dead` },
      ],
    },
  ];

  if (runData.reportUrl) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View Report' },
        url: runData.reportUrl,
      }],
    });
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    });

    if (!response.ok) {
      console.log(`  [Slack] Failed: ${response.status} ${response.statusText}`);
      return false;
    }
    console.log('  [Slack] Notification sent successfully');
    return true;
  } catch (e) {
    console.log(`  [Slack] Error: ${e.message}`);
    return false;
  }
}

module.exports = { sendSlackNotification };
