'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Generate a side-by-side HTML comparison report.
 */
function generateComparisonReport(compCtx) {
  const s = compCtx.summary;
  const duration = `${Math.round(compCtx.elapsed() / 1000)}s`;

  const flowSections = compCtx.flows.map(flow => {
    const uatResults = compCtx.uatResults[flow.id] || [];
    const prodResults = compCtx.prodResults[flow.id] || [];
    const flowDiffs = compCtx.diffs.filter(d => d.flowId === flow.id);
    const hasDiffs = flowDiffs.some(d => d.hasDiff);

    const stepRows = flow.steps.map((step, i) => {
      const uat = uatResults[i];
      const prod = prodResults[i];
      const stepDiffs = flowDiffs.filter(d => d.stepIndex === i && d.hasDiff);

      return buildStepRow(step, uat, prod, stepDiffs);
    }).join('');

    const flowIcon = hasDiffs ? '\u26A0\uFE0F' : '\u2705';
    const diffCount = flowDiffs.filter(d => d.hasDiff).length;
    const diffBadge = diffCount > 0 ? `<span class="badge high">${diffCount} diff${diffCount > 1 ? 's' : ''}</span>` : '<span class="badge match">Match</span>';

    return `
    <div class="flow-section">
      <div class="flow-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <h2>${flowIcon} ${esc(flow.name)} ${diffBadge}</h2>
        <span class="flow-meta">${flow.steps.length} steps | ${flow.category}</span>
      </div>
      <div class="flow-body">
        ${stepRows}
      </div>
    </div>`;
  }).join('\n');

  const diffTableRows = compCtx.diffs
    .filter(d => d.hasDiff)
    .map(d => `
      <tr class="severity-${d.severity}">
        <td><span class="badge ${d.severity}">${d.severity.toUpperCase()}</span></td>
        <td>${esc(d.diffType)}</td>
        <td>${esc(d.flowName || d.flowId)}</td>
        <td>${esc(d.summary)}</td>
      </tr>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Comparison Report — UAT vs PROD</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 2rem; min-height: 100vh; }

  .header { text-align: center; margin-bottom: 2rem; padding: 2rem; background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%); border-radius: 16px; border: 1px solid #334155; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #38bdf8; }
  .url-row { color: #94a3b8; font-size: 0.9rem; margin: 4px 0; }
  .url-row strong { color: #e2e8f0; }

  .stats { display: flex; gap: 1rem; justify-content: center; margin-top: 1.5rem; flex-wrap: wrap; }
  .stat { background: #1e293b; padding: 10px 20px; border-radius: 10px; border: 1px solid #334155; text-align: center; }
  .stat strong { font-size: 1.4rem; display: block; }
  .stat span { color: #94a3b8; font-size: 0.8rem; }
  .stat.match strong { color: #4ade80; }
  .stat.diff strong { color: #f87171; }
  .stat.info strong { color: #38bdf8; }

  .flow-section { background: #1e293b; border-radius: 12px; margin-bottom: 1.5rem; border: 1px solid #334155; overflow: hidden; }
  .flow-header { padding: 16px 20px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: #263347; }
  .flow-header:hover { background: #2d3d54; }
  .flow-header h2 { font-size: 1.1rem; color: #e2e8f0; display: flex; align-items: center; gap: 8px; }
  .flow-meta { color: #64748b; font-size: 0.85rem; }
  .flow-body { padding: 16px 20px; }
  .collapsed .flow-body { display: none; }

  .step { margin-bottom: 16px; padding: 12px; background: #0f172a; border-radius: 8px; border: 1px solid #1e3a5f; }
  .step-header { font-size: 0.9rem; color: #94a3b8; margin-bottom: 8px; display: flex; justify-content: space-between; }
  .step-header strong { color: #e2e8f0; }

  .side-by-side { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 8px; }
  .side-by-side.with-diff { grid-template-columns: 1fr auto 1fr; }
  .side-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 4px; }
  .side-label.uat { color: #38bdf8; }
  .side-label.prod { color: #fb923c; }
  .side-label.diff-label { color: #f87171; }

  .screenshot { width: 100%; border-radius: 6px; border: 1px solid #334155; }
  .diff-image { width: 200px; border-radius: 6px; border: 2px solid #f87171; }

  .comparison-value { padding: 6px 12px; background: #0f172a; border-radius: 6px; font-family: monospace; font-size: 0.9rem; }
  .comparison-value.match { border-left: 3px solid #4ade80; }
  .comparison-value.mismatch { border-left: 3px solid #f87171; }

  .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 0.7rem; font-weight: 700; margin: 0 2px; }
  .badge.critical { background: rgba(239,68,68,0.2); color: #f87171; }
  .badge.high { background: rgba(249,115,22,0.2); color: #fb923c; }
  .badge.medium { background: rgba(234,179,8,0.2); color: #fbbf24; }
  .badge.low { background: rgba(34,197,94,0.2); color: #4ade80; }
  .badge.info { background: rgba(56,189,248,0.15); color: #38bdf8; }
  .badge.match { background: rgba(34,197,94,0.15); color: #4ade80; }

  .diff-table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; margin-top: 2rem; }
  .diff-table th { background: #334155; color: #38bdf8; text-align: left; padding: 12px 16px; font-size: 0.8rem; text-transform: uppercase; }
  .diff-table td { padding: 12px 16px; border-bottom: 1px solid #1e3a5f; font-size: 0.9rem; }
  .diff-table tr:hover { background: #263347; }

  .perf-bar { display: flex; gap: 12px; margin-top: 6px; }
  .perf-item { font-size: 0.85rem; }
  .perf-item .label { color: #64748b; }
  .perf-item .value { font-weight: 600; }
  .perf-item .value.good { color: #4ade80; }
  .perf-item .value.bad { color: #f87171; }

  @media (max-width: 768px) {
    body { padding: 1rem; }
    .side-by-side { grid-template-columns: 1fr; }
    .side-by-side.with-diff { grid-template-columns: 1fr; }
  }
</style>
</head><body>

<div class="header">
  <h1>Comparison Report</h1>
  <p class="url-row"><strong>UAT:</strong> ${esc(compCtx.uatUrl)}</p>
  <p class="url-row"><strong>PROD:</strong> ${esc(compCtx.prodUrl)}</p>
  <p class="url-row">Duration: ${duration} | ${compCtx.flows.length} flows | ${s.totalSteps} steps | Platform: ${esc(compCtx.discovery?.platform || 'unknown')}</p>
  <div class="stats">
    <div class="stat match"><strong>${s.matchedSteps}</strong><span>Matched</span></div>
    <div class="stat diff"><strong>${s.diffSteps}</strong><span>Differences</span></div>
    <div class="stat info"><strong>${s.visualDiffs}</strong><span>Visual</span></div>
    <div class="stat info"><strong>${s.structuralDiffs}</strong><span>Structural</span></div>
    <div class="stat info"><strong>${s.dataDiffs}</strong><span>Data</span></div>
    <div class="stat ${s.functionalDiffs > 0 ? 'diff' : 'info'}"><strong>${s.functionalDiffs}</strong><span>Functional</span></div>
    <div class="stat ${s.perfRegressions > 0 ? 'diff' : 'info'}"><strong>${s.perfRegressions}</strong><span>Perf Regressions</span></div>
  </div>
</div>

${flowSections}

${diffTableRows.length > 0 ? `
<h2 style="color:#38bdf8; margin: 2rem 0 1rem;">All Differences</h2>
<table class="diff-table">
  <thead><tr><th>Severity</th><th>Type</th><th>Flow</th><th>Details</th></tr></thead>
  <tbody>
${diffTableRows}
  </tbody>
</table>
` : '<p style="text-align:center; color:#4ade80; margin-top:2rem; font-size:1.2rem;">\u2705 No differences found between UAT and PROD</p>'}

<p style="text-align:center; color:#64748b; margin-top:3rem; font-size:0.8rem;">
  Generated ${new Date().toISOString()} | AutomatedWebTesting Comparison Engine
</p>
</body></html>`;
}

function buildStepRow(step, uat, prod, stepDiffs) {
  const hasDiff = stepDiffs.length > 0;
  const borderColor = hasDiff ? '#f87171' : '#1e3a5f';

  let content = '';

  if (step.action === 'screenshot' && uat && prod) {
    const uatSrc = uat.screenshot ? imgToBase64(uat.screenshot) : '';
    const prodSrc = prod.screenshot ? imgToBase64(prod.screenshot) : '';
    const diffImg = stepDiffs.find(d => d.diffType === 'visual' && d.details?.diffImagePath);
    const diffSrc = diffImg ? imgToBase64(diffImg.details.diffImagePath) : '';

    content = `
    <div class="side-by-side ${diffSrc ? 'with-diff' : ''}">
      <div>
        <div class="side-label uat">UAT</div>
        ${uatSrc ? `<img class="screenshot" src="${uatSrc}" alt="UAT">` : '<p style="color:#64748b">No screenshot</p>'}
      </div>
      ${diffSrc ? `<div><div class="side-label diff-label">DIFF</div><img class="diff-image" src="${diffSrc}" alt="Diff"></div>` : ''}
      <div>
        <div class="side-label prod">PROD</div>
        ${prodSrc ? `<img class="screenshot" src="${prodSrc}" alt="PROD">` : '<p style="color:#64748b">No screenshot</p>'}
      </div>
    </div>`;
    if (stepDiffs.length > 0) {
      content += `<p style="margin-top:8px; color:${hasDiff ? '#f87171' : '#4ade80'}; font-size:0.85rem;">${esc(stepDiffs[0].summary)}</p>`;
    }
  } else if (step.action === 'check_element' && uat && prod) {
    const match = uat.elementFound === prod.elementFound;
    content = `
    <div class="side-by-side">
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">UAT: ${uat.elementFound ? 'Found' : 'Not Found'}</div>
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">PROD: ${prod.elementFound ? 'Found' : 'Not Found'}</div>
    </div>`;
  } else if (step.action === 'extract_data' && uat && prod) {
    const uatVal = uat.data[step.key] || '(none)';
    const prodVal = prod.data[step.key] || '(none)';
    const match = uatVal === prodVal;
    content = `
    <div class="side-by-side">
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">UAT: ${esc(String(uatVal).slice(0, 100))}</div>
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">PROD: ${esc(String(prodVal).slice(0, 100))}</div>
    </div>`;
  } else if (step.action === 'measure_perf' && uat && prod && uat.perfMetrics && prod.perfMetrics) {
    const um = uat.perfMetrics;
    const pm = prod.perfMetrics;
    content = `
    <div class="side-by-side">
      <div>
        <div class="side-label uat">UAT</div>
        <div class="perf-bar">
          <span class="perf-item"><span class="label">FCP:</span> <span class="value">${um.fcp || '?'}ms</span></span>
          <span class="perf-item"><span class="label">TTFB:</span> <span class="value">${um.ttfb || '?'}ms</span></span>
          <span class="perf-item"><span class="label">DOM:</span> <span class="value">${um.domSize || '?'}</span></span>
        </div>
      </div>
      <div>
        <div class="side-label prod">PROD</div>
        <div class="perf-bar">
          <span class="perf-item"><span class="label">FCP:</span> <span class="value ${perfClass(um.fcp, pm.fcp)}">${pm.fcp || '?'}ms</span></span>
          <span class="perf-item"><span class="label">TTFB:</span> <span class="value ${perfClass(um.ttfb, pm.ttfb)}">${pm.ttfb || '?'}ms</span></span>
          <span class="perf-item"><span class="label">DOM:</span> <span class="value">${pm.domSize || '?'}</span></span>
        </div>
      </div>
    </div>`;
  } else if (step.action === 'goto' && uat && prod) {
    const match = uat.httpStatus === prod.httpStatus;
    content = `
    <div class="side-by-side">
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">UAT: HTTP ${uat.httpStatus || '?'}</div>
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">PROD: HTTP ${prod.httpStatus || '?'}</div>
    </div>`;
  } else {
    // Generic step
    const uatStatus = uat ? uat.status : 'skipped';
    const prodStatus = prod ? prod.status : 'skipped';
    const match = uatStatus === prodStatus;
    content = `
    <div class="side-by-side">
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">UAT: ${uatStatus}</div>
      <div class="comparison-value ${match ? 'match' : 'mismatch'}">PROD: ${prodStatus}</div>
    </div>`;
  }

  const diffBadges = stepDiffs.map(d => `<span class="badge ${d.severity}">${d.diffType}</span>`).join(' ');

  return `
  <div class="step" style="border-color: ${borderColor}">
    <div class="step-header">
      <strong>Step ${(uat ? uat.stepIndex : 0) + 1}: ${esc(step.description)}</strong>
      <span>${step.action} ${diffBadges}</span>
    </div>
    ${content}
  </div>`;
}

function imgToBase64(filePath) {
  try {
    const data = fs.readFileSync(filePath);
    return `data:image/png;base64,${data.toString('base64')}`;
  } catch {
    return '';
  }
}

function perfClass(uatVal, prodVal) {
  if (!uatVal || !prodVal) return '';
  const delta = (prodVal - uatVal) / uatVal;
  if (delta > 0.3) return 'bad';
  if (delta < -0.1) return 'good';
  return '';
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { generateComparisonReport };
