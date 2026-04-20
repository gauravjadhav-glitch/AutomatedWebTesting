'use strict';

/**
 * Linear integration — auto-files Critical/High bugs via GraphQL API.
 * Uses bug fingerprint to prevent duplicate issues.
 *
 * Configure in .env:
 *   LINEAR_API_KEY
 *   LINEAR_TEAM_ID
 */
async function fileLinearBugs(bugs, siteName) {
  const apiKey = process.env.LINEAR_API_KEY;
  const teamId = process.env.LINEAR_TEAM_ID;

  if (!apiKey || !teamId) return [];

  const headers = {
    'Authorization': apiKey,
    'Content-Type': 'application/json',
  };

  const toFile = bugs.filter(b => b.severity === 'Critical' || b.severity === 'High');
  if (toFile.length === 0) return [];

  const filed = [];

  for (const bug of toFile) {
    const fingerprint = bug.fingerprint || bug.id || '';

    // Search for existing issue with this fingerprint
    try {
      const searchQuery = {
        query: `{
          issues(filter: {
            team: { id: { eq: "${teamId}" } }
            description: { contains: "Fingerprint: ${fingerprint}" }
          }, first: 1) {
            nodes { id identifier title }
          }
        }`,
      };

      const searchRes = await fetch('https://api.linear.app/graphql', {
        method: 'POST', headers,
        body: JSON.stringify(searchQuery),
      });
      const searchData = await searchRes.json();

      if (searchData.data?.issues?.nodes?.length > 0) {
        const existing = searchData.data.issues.nodes[0];
        console.log(`  [Linear] Bug already filed: ${bug.title} (${existing.identifier})`);
        continue;
      }
    } catch (e) {
      console.log(`  [Linear] Search failed: ${e.message}`);
    }

    // File new issue
    const priority = bug.severity === 'Critical' ? 1 : 2; // 1=Urgent, 2=High
    const description = [
      `**Site:** ${siteName}`,
      `**Page:** ${bug.location || 'N/A'}`,
      `**Severity:** ${bug.severity}`,
      `**Category:** ${bug.category}`,
      '',
      bug.description || '',
      '',
      `**Steps:** ${Array.isArray(bug.steps) ? bug.steps.join(' → ') : (bug.steps || 'N/A')}`,
      `**Expected:** ${bug.expected || 'N/A'}`,
      `**Actual:** ${bug.actual || 'N/A'}`,
      '',
      `Fingerprint: ${fingerprint}`,
    ].join('\n');

    const mutation = {
      query: `mutation {
        issueCreate(input: {
          teamId: "${teamId}"
          title: "[QA Auto] ${bug.title.replace(/"/g, '\\"')}"
          description: ${JSON.stringify(description)}
          priority: ${priority}
          labelIds: []
        }) {
          success
          issue { id identifier title }
        }
      }`,
    };

    try {
      const res = await fetch('https://api.linear.app/graphql', {
        method: 'POST', headers,
        body: JSON.stringify(mutation),
      });
      const data = await res.json();

      if (data.data?.issueCreate?.success) {
        const issue = data.data.issueCreate.issue;
        console.log(`  [Linear] Filed: ${issue.identifier} — ${bug.title}`);
        filed.push({ id: issue.identifier, title: bug.title, fingerprint });
      } else {
        console.log(`  [Linear] Failed to file "${bug.title}": ${JSON.stringify(data.errors || data).slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`  [Linear] Error filing "${bug.title}": ${e.message}`);
    }
  }

  return filed;
}

module.exports = { fileLinearBugs };
