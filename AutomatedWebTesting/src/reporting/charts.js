'use strict';

/**
 * Inline SVG chart generator — no external JS libraries needed.
 * Generates embeddable SVG strings for HTML reports.
 */

const COLORS = {
  primary: '#4f46e5',
  success: '#22c55e',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#3b82f6',
  muted: '#6b7280',
  critical: '#dc2626',
  high: '#f97316',
  medium: '#eab308',
  low: '#22d3ee',
  bg: '#1e1e2e',
  gridLine: '#333',
  text: '#a0a0a0',
};

/**
 * Line chart for trends (health score, pass rate, performance).
 */
function lineChart({ title, data, keys, labels, width = 600, height = 250, yLabel = '' }) {
  if (!data || data.length === 0) return '';

  const padding = { top: 40, right: 20, bottom: 50, left: 55 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  // Compute Y range
  let allVals = [];
  for (const key of keys) {
    allVals = allVals.concat(data.map(d => d[key]).filter(v => v != null));
  }
  const yMin = Math.min(...allVals, 0);
  const yMax = Math.max(...allVals, 1) * 1.1;

  const xScale = (i) => padding.left + (i / Math.max(data.length - 1, 1)) * chartW;
  const yScale = (v) => padding.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

  const colors = [COLORS.primary, COLORS.success, COLORS.warning, COLORS.danger, COLORS.info];

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="background:${COLORS.bg};border-radius:8px;margin:10px 0;">`;

  // Title
  svg += `<text x="${width / 2}" y="22" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">${title}</text>`;

  // Y-axis grid lines
  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const val = yMin + (i / yTicks) * (yMax - yMin);
    const y = yScale(val);
    svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${COLORS.gridLine}" stroke-dasharray="3"/>`;
    svg += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" fill="${COLORS.text}" font-size="10">${Math.round(val)}</text>`;
  }

  // Y-axis label
  if (yLabel) {
    svg += `<text x="12" y="${height / 2}" text-anchor="middle" fill="${COLORS.text}" font-size="10" transform="rotate(-90, 12, ${height / 2})">${yLabel}</text>`;
  }

  // Draw lines for each key
  keys.forEach((key, ki) => {
    const points = data.map((d, i) => d[key] != null ? `${xScale(i)},${yScale(d[key])}` : null).filter(Boolean);
    if (points.length > 1) {
      svg += `<polyline points="${points.join(' ')}" fill="none" stroke="${colors[ki % colors.length]}" stroke-width="2.5" stroke-linejoin="round"/>`;
    }
    // Dots
    data.forEach((d, i) => {
      if (d[key] != null) {
        svg += `<circle cx="${xScale(i)}" cy="${yScale(d[key])}" r="3" fill="${colors[ki % colors.length]}"/>`;
      }
    });
  });

  // X-axis labels
  data.forEach((d, i) => {
    if (data.length <= 10 || i % Math.ceil(data.length / 8) === 0) {
      const label = d.date ? d.date.slice(5, 10) : `#${d.run}`;
      svg += `<text x="${xScale(i)}" y="${height - 10}" text-anchor="middle" fill="${COLORS.text}" font-size="9">${label}</text>`;
    }
  });

  // Legend
  if (labels && labels.length > 1) {
    labels.forEach((label, i) => {
      const lx = padding.left + i * 100;
      svg += `<rect x="${lx}" y="${height - 28}" width="10" height="10" rx="2" fill="${colors[i % colors.length]}"/>`;
      svg += `<text x="${lx + 14}" y="${height - 19}" fill="${COLORS.text}" font-size="10">${label}</text>`;
    });
  }

  svg += '</svg>';
  return svg;
}

/**
 * Stacked bar chart for bug severity distribution per run.
 */
function stackedBarChart({ title, data, width = 600, height = 250 }) {
  if (!data || data.length === 0) return '';

  const padding = { top: 40, right: 20, bottom: 50, left: 55 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const maxTotal = Math.max(...data.map(d => d.total || 1), 1);
  const barWidth = Math.min(30, (chartW / data.length) * 0.7);
  const barGap = (chartW - barWidth * data.length) / (data.length + 1);

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" style="background:${COLORS.bg};border-radius:8px;margin:10px 0;">`;
  svg += `<text x="${width / 2}" y="22" text-anchor="middle" fill="#fff" font-size="14" font-weight="bold">${title}</text>`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const val = (i / 4) * maxTotal;
    const y = padding.top + chartH - (val / maxTotal) * chartH;
    svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${COLORS.gridLine}" stroke-dasharray="3"/>`;
    svg += `<text x="${padding.left - 8}" y="${y + 4}" text-anchor="end" fill="${COLORS.text}" font-size="10">${Math.round(val)}</text>`;
  }

  const sevColors = { critical: COLORS.critical, high: COLORS.high, medium: COLORS.medium, low: COLORS.low };
  const sevKeys = ['low', 'medium', 'high', 'critical'];

  data.forEach((d, i) => {
    const x = padding.left + barGap + i * (barWidth + barGap);
    let yOffset = 0;

    for (const sev of sevKeys) {
      const val = d[sev] || 0;
      const barH = (val / maxTotal) * chartH;
      const y = padding.top + chartH - yOffset - barH;
      svg += `<rect x="${x}" y="${y}" width="${barWidth}" height="${barH}" fill="${sevColors[sev]}" rx="1"/>`;
      yOffset += barH;
    }

    // Label
    const label = d.date ? d.date.slice(5, 10) : `#${d.run}`;
    svg += `<text x="${x + barWidth / 2}" y="${height - 10}" text-anchor="middle" fill="${COLORS.text}" font-size="9">${label}</text>`;
  });

  // Legend
  const sevLabels = [
    { key: 'critical', label: 'Critical' },
    { key: 'high', label: 'High' },
    { key: 'medium', label: 'Medium' },
    { key: 'low', label: 'Low' },
  ];
  sevLabels.forEach((s, i) => {
    const lx = padding.left + i * 80;
    svg += `<rect x="${lx}" y="${height - 28}" width="10" height="10" rx="2" fill="${sevColors[s.key]}"/>`;
    svg += `<text x="${lx + 14}" y="${height - 19}" fill="${COLORS.text}" font-size="10">${s.label}</text>`;
  });

  svg += '</svg>';
  return svg;
}

/**
 * Generate all trend charts as HTML string for embedding in reports.
 */
function generateTrendCharts(trendData) {
  const charts = [];

  if (trendData.healthTrend.length > 1) {
    charts.push(lineChart({
      title: 'Health Score Trend',
      data: trendData.healthTrend,
      keys: ['score'],
      labels: ['Health %'],
      yLabel: 'Score',
    }));
  }

  if (trendData.bugCountTrend.length > 1) {
    charts.push(stackedBarChart({
      title: 'Bug Count by Severity',
      data: trendData.bugCountTrend,
    }));
  }

  if (trendData.passRateTrend.length > 1) {
    charts.push(lineChart({
      title: 'Test Pass Rate',
      data: trendData.passRateTrend,
      keys: ['rate'],
      labels: ['Pass %'],
      yLabel: 'Pass Rate %',
    }));
  }

  if (trendData.perfTrend.length > 1) {
    charts.push(lineChart({
      title: 'Performance Trends',
      data: trendData.perfTrend,
      keys: ['avgFcp', 'avgLcp', 'avgTtfb'],
      labels: ['FCP', 'LCP', 'TTFB'],
      yLabel: 'ms',
    }));
  }

  if (charts.length === 0) return '';

  return `
    <div class="trend-charts" style="margin:30px 0;">
      <h2 style="color:#fff;border-bottom:2px solid #4f46e5;padding-bottom:8px;">Historical Trends</h2>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(550px, 1fr));gap:15px;">
        ${charts.join('\n')}
      </div>
    </div>
  `;
}

module.exports = { lineChart, stackedBarChart, generateTrendCharts };
