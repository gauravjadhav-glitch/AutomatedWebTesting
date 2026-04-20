'use strict';

/**
 * Jira Cloud integration — auto-files Critical/High bugs.
 * Uses bug fingerprint to prevent duplicate tickets.
 *
 * Configure in .env:
 *   JIRA_BASE_URL (e.g., https://your-org.atlassian.net)
 *   JIRA_EMAIL
 *   JIRA_API_TOKEN
 *   JIRA_PROJECT_KEY (e.g., QA)
 */
async function fileJiraBugs(bugs, siteName) {
  const baseUrl = process.env.JIRA_BASE_URL;
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const projectKey = process.env.JIRA_PROJECT_KEY;

  if (!baseUrl || !email || !token || !projectKey) return [];

  const auth = Buffer.from(`${email}:${token}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  // Only file Critical and High bugs
  const toFile = bugs.filter(b => b.severity === 'Critical' || b.severity === 'High');
  if (toFile.length === 0) return [];

  const filed = [];

  for (const bug of toFile) {
    const fingerprint = bug.fingerprint || bug.id || '';

    // Check if already filed (search by fingerprint in description)
    try {
      const jql = encodeURIComponent(`project = ${projectKey} AND description ~ "Fingerprint: ${fingerprint}"`);
      const searchRes = await fetch(`${baseUrl}/rest/api/3/search?jql=${jql}&maxResults=1`, { headers });
      const searchData = await searchRes.json();

      if (searchData.total > 0) {
        console.log(`  [Jira] Bug already filed: ${bug.title} (${searchData.issues[0].key})`);
        continue;
      }
    } catch (e) {
      console.log(`  [Jira] Search failed: ${e.message}`);
    }

    // File new issue
    const priority = bug.severity === 'Critical' ? 'Highest' : 'High';
    const issueData = {
      fields: {
        project: { key: projectKey },
        summary: `[QA Auto] ${bug.title}`,
        description: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: `Site: ${siteName}\nPage: ${bug.location || 'N/A'}\nSeverity: ${bug.severity}\nCategory: ${bug.category}\n\n${bug.description || ''}\n\nSteps: ${Array.isArray(bug.steps) ? bug.steps.join(', ') : (bug.steps || 'N/A')}\nExpected: ${bug.expected || 'N/A'}\nActual: ${bug.actual || 'N/A'}\n\nFingerprint: ${fingerprint}` },
            ],
          }],
        },
        issuetype: { name: 'Bug' },
        priority: { name: priority },
        labels: ['qa-auto', siteName],
      },
    };

    try {
      const res = await fetch(`${baseUrl}/rest/api/3/issue`, {
        method: 'POST',
        headers,
        body: JSON.stringify(issueData),
      });

      if (res.ok) {
        const data = await res.json();
        console.log(`  [Jira] Filed: ${data.key} — ${bug.title}`);
        filed.push({ key: data.key, title: bug.title, fingerprint });
      } else {
        const err = await res.text();
        console.log(`  [Jira] Failed to file "${bug.title}": ${res.status} ${err.slice(0, 100)}`);
      }
    } catch (e) {
      console.log(`  [Jira] Error filing "${bug.title}": ${e.message}`);
    }
  }

  return filed;
}

module.exports = { fileJiraBugs };
