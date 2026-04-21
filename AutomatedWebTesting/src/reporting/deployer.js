'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

/**
 * Deploy report to gh-pages branch and push to GitHub.
 *
 * Strategy: git worktree → copy report → update index → commit → push → cleanup.
 * Only HTML reports go to gh-pages (self-contained, no external images).
 *
 * @param {Object} opts
 * @param {string} opts.reportPath    — Absolute path to the HTML report file
 * @param {string} opts.siteName      — e.g. "facegym-fynd-io"
 * @param {number} opts.bugCount      — Total bugs found
 * @param {Object} opts.bugCounts     — { critical, high, medium, low }
 * @param {number} [opts.runNumber]   — Run number for index
 * @param {string} [opts.type]        — "single" or "comparison"
 * @param {string} [opts.compareSite] — PROD site name for comparison reports
 */
async function deployToGitPages(opts) {
  const {
    reportPath,
    siteName,
    bugCount = 0,
    bugCounts = { critical: 0, high: 0, medium: 0, low: 0 },
    runNumber = 0,
    type = 'single',
    compareSite = '',
  } = opts;

  const tmpDir = path.join(require('os').tmpdir(), `gh-pages-deploy-${Date.now()}`);
  const repoRoot = findGitRoot();
  if (!repoRoot) {
    console.log('\u26A0\uFE0F  Git deploy skipped: not inside a git repository');
    return;
  }

  console.log('\n--- Deploying report to GitHub Pages ---\n');

  // Check if we're already on gh-pages (direct deploy without worktree)
  const currentBranch = getCurrentBranch(repoRoot);
  const onGhPages = currentBranch === 'gh-pages';

  try {
    let deployDir;

    if (onGhPages) {
      // Already on gh-pages — deploy directly in repo root
      deployDir = repoRoot;
    } else {
      // Create worktree for gh-pages
      deployDir = tmpDir;
      try {
        execSync(`git worktree add "${tmpDir}" gh-pages`, { cwd: repoRoot, stdio: 'pipe' });
      } catch (e) {
        // gh-pages might not exist yet — create orphan
        console.log('  Creating gh-pages branch...');
        execSync(`git worktree add --detach "${tmpDir}"`, { cwd: repoRoot, stdio: 'pipe' });
        execSync('git checkout --orphan gh-pages', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git rm -rf . 2>/dev/null || true', { cwd: tmpDir, stdio: 'pipe', shell: true });
        fs.writeFileSync(path.join(tmpDir, '.nojekyll'), '');
        execSync('git add .nojekyll', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git commit -m "Initialize gh-pages"', { cwd: tmpDir, stdio: 'pipe' });
      }
    }

    // 2. Ensure directory structure
    const deployReportsDir = path.join(deployDir, 'AutomatedWebTesting', 'reports');
    fs.mkdirSync(deployReportsDir, { recursive: true });

    // Ensure .nojekyll exists
    const nojekyllPath = path.join(deployDir, '.nojekyll');
    if (!fs.existsSync(nojekyllPath)) {
      fs.writeFileSync(nojekyllPath, '');
    }

    // 3. Copy report file
    const reportFileName = path.basename(reportPath);
    const destPath = path.join(deployReportsDir, reportFileName);
    fs.copyFileSync(reportPath, destPath);
    console.log(`  Copied: ${reportFileName}`);

    // 4. Update index.html
    const indexPath = path.join(deployDir, 'index.html');
    const existingEntries = parseExistingIndex(indexPath);

    const today = new Date().toISOString().slice(0, 10);
    const newEntry = {
      num: runNumber,
      site: type === 'comparison' ? `${siteName.replace(/-/g, '.')} vs ${compareSite.replace(/-/g, '.')}` : siteName.replace(/-/g, '.'),
      date: today,
      href: `AutomatedWebTesting/reports/${reportFileName}`,
      total: bugCount,
      ...bugCounts,
      isComparison: type === 'comparison',
    };

    // Remove duplicate entry for same report file
    const filtered = existingEntries.filter(e => e.href !== newEntry.href);
    filtered.unshift(newEntry);

    const indexHtml = buildDeployIndex(filtered);
    fs.writeFileSync(indexPath, indexHtml);
    console.log('  Updated: index.html');

    // 5. Git add specific files only (never -A, which can re-add deleted files)
    const relReport = path.relative(deployDir, destPath);
    const relIndex = path.relative(deployDir, indexPath);
    const relNojekyll = path.relative(deployDir, nojekyllPath);
    execSync(`git add "${relReport}" "${relIndex}" "${relNojekyll}"`, { cwd: deployDir, stdio: 'pipe' });

    // Check if there are changes to commit
    try {
      execSync('git diff --staged --quiet', { cwd: deployDir, stdio: 'pipe' });
      console.log('  No changes to deploy (report unchanged)');
    } catch {
      // There are changes — commit and push
      const commitMsg = type === 'comparison'
        ? `Report: ${siteName.replace(/-/g, '.')} vs ${compareSite.replace(/-/g, '.')} \u2014 ${bugCount} bugs`
        : `Report: ${siteName.replace(/-/g, '.')} \u2014 ${bugCount} bugs`;

      execSync(`git commit -m "${commitMsg}"`, { cwd: deployDir, stdio: 'pipe' });
      console.log(`  Committed: ${commitMsg}`);

      try {
        execSync('git push origin gh-pages', { cwd: deployDir, stdio: 'pipe', timeout: 60000 });
        console.log('  Pushed to origin/gh-pages');

        // Detect GitHub Pages URL
        const remoteUrl = getRemoteUrl(deployDir);
        if (remoteUrl) {
          const pagesUrl = githubPagesUrl(remoteUrl);
          console.log(`\n  Report live at: ${pagesUrl}/AutomatedWebTesting/reports/${reportFileName}`);
          console.log(`  Index page:     ${pagesUrl}/`);
        }
      } catch (pushErr) {
        console.log(`\u26A0\uFE0F  Push failed: ${pushErr.message.split('\n')[0]}`);
        console.log('  Report committed locally on gh-pages. Push manually with: git push origin gh-pages');
      }
    }
  } catch (e) {
    console.log(`\u26A0\uFE0F  Git deploy failed: ${e.message.split('\n')[0]}`);
  } finally {
    // 6. Cleanup worktree (only if we created one)
    if (!onGhPages) {
      try {
        execSync(`git worktree remove "${tmpDir}" --force`, { cwd: repoRoot, stdio: 'pipe' });
      } catch {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        try { execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' }); } catch {}
      }
    }
  }
}

/**
 * Parse existing index.html to extract report entries.
 */
function parseExistingIndex(indexPath) {
  if (!fs.existsSync(indexPath)) return [];
  try {
    const html = fs.readFileSync(indexPath, 'utf-8');
    const entries = [];
    const rowRe = /<tr[^>]*>\s*<td><strong>#(\d+|\u2014)<\/strong>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td>(.*?)<\/td>\s*<td><a href="(.*?)">.*?<\/a><\/td>\s*<\/tr>/gs;
    let m;
    while ((m = rowRe.exec(html)) !== null) {
      const num = m[1] === '\u2014' ? 0 : parseInt(m[1], 10);
      const isComparison = m[2].includes('comparison-tag');
      const site = m[3].replace(/<[^>]+>/g, '').trim();
      const date = m[4].trim();
      const bugsTd = m[5];
      const href = m[6];

      const totalMatch = bugsTd.match(/<strong>(\d+|\?)<\/strong>/);
      const cMatch = bugsTd.match(/C:(\d+)/);
      const hMatch = bugsTd.match(/H:(\d+)/);
      const mMatch = bugsTd.match(/M:(\d+)/);
      const lMatch = bugsTd.match(/L:(\d+)/);

      entries.push({
        num,
        site,
        date,
        href,
        total: totalMatch ? (totalMatch[1] === '?' ? '?' : parseInt(totalMatch[1], 10)) : '?',
        critical: cMatch ? parseInt(cMatch[1], 10) : 0,
        high: hMatch ? parseInt(hMatch[1], 10) : 0,
        medium: mMatch ? parseInt(mMatch[1], 10) : 0,
        low: lMatch ? parseInt(lMatch[1], 10) : 0,
        isComparison,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Build the index.html for gh-pages deployment.
 */
function buildDeployIndex(entries) {
  const rows = entries.map((e, i) => {
    const isLatest = i === 0;
    const rowClass = isLatest ? ' class="latest-row"' : '';
    const latestTag = isLatest ? ' <span class="latest-tag">LATEST</span>' : '';
    const compTag = e.isComparison ? ' <span class="comparison-tag">COMPARISON</span>' : '';
    return `<tr${rowClass}>
        <td><strong>#${e.num || '\u2014'}</strong>${latestTag}${compTag}</td>
        <td>${e.site}</td>
        <td>${e.date}</td>
        <td><strong>${e.total}</strong> <span class="badge critical">C:${e.critical}</span> <span class="badge high">H:${e.high}</span> <span class="badge medium">M:${e.medium}</span> <span class="badge low">L:${e.low}</span></td>
        <td><a href="${e.href}">View Report</a></td>
      </tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QA Test Reports \u2014 All Runs</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }
  .header { text-align: center; margin-bottom: 2rem; padding: 2rem; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #334155; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #38bdf8; }
  p.sub { color: #94a3b8; font-size: 1rem; }
  .stats { display: flex; gap: 1.5rem; justify-content: center; margin-top: 1rem; flex-wrap: wrap; }
  .stat { background: #1e293b; padding: 8px 20px; border-radius: 10px; border: 1px solid #334155; }
  .stat strong { color: #38bdf8; font-size: 1.3rem; }
  .stat span { color: #94a3b8; font-size: 0.85rem; display: block; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,0.3); }
  th { background: #334155; color: #38bdf8; text-align: left; padding: 14px 16px; font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.08em; }
  td { padding: 14px 16px; border-bottom: 1px solid #1e3a5f; font-size: 0.95rem; }
  tr:hover { background: #263347; }
  tr.latest-row { background: #172337; border-left: 3px solid #38bdf8; }
  a { color: #38bdf8; text-decoration: none; font-weight: 600; padding: 6px 14px; border: 1px solid #38bdf8; border-radius: 8px; transition: all 0.2s; display: inline-block; }
  a:hover { background: #38bdf8; color: #0f172a; }
  .badge { display: inline-block; padding: 2px 7px; border-radius: 6px; font-size: 0.75rem; font-weight: 700; margin: 0 1px; }
  .badge.critical { background: rgba(239,68,68,0.2); color: #f87171; }
  .badge.high { background: rgba(249,115,22,0.2); color: #fb923c; }
  .badge.medium { background: rgba(234,179,8,0.2); color: #fbbf24; }
  .badge.low { background: rgba(34,197,94,0.2); color: #4ade80; }
  .latest-tag { background: #38bdf8; color: #0f172a; padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; margin-left: 6px; }
  .comparison-tag { background: #a78bfa; color: #0f172a; padding: 2px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; margin-left: 6px; }
  @media (max-width: 768px) { body { padding: 1rem; } td, th { padding: 10px 8px; font-size: 0.85rem; } .badge { font-size: 0.65rem; } }
</style>
</head><body>
<div class="header">
  <h1>QA Test Reports</h1>
  <p class="sub">Automated UI testing \u2014 all runs with screenshots & bug details</p>
  <div class="stats">
    <div class="stat"><strong>${entries.length}</strong><span>Total Reports</span></div>
  </div>
</div>
<table>
  <thead><tr><th>Run</th><th>Site</th><th>Date</th><th>Bugs</th><th>Report</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>
</body></html>`;
}

function getCurrentBranch(cwd) {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

function findGitRoot() {
  try {
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

function getRemoteUrl(cwd) {
  try {
    return execSync('git remote get-url origin', { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

function githubPagesUrl(remoteUrl) {
  let m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (m) return `https://${m[1]}.github.io/${m[2]}`;
  return null;
}

module.exports = { deployToGitPages };
