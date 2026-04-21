'use strict';

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

/**
 * Compare UAT vs PROD step results for a single flow.
 * Produces DiffResult[] with severity and details.
 */
function computeDiffs(flow, uatResults, prodResults, config) {
  const diffs = [];
  const threshold = config.comparison?.diffThreshold || 0.005;
  const perfThreshold = config.comparison?.perfRegressionThreshold || 0.3;
  const ssDir = path.join(config.reportDir, 'comparison-screenshots');

  const len = Math.max(uatResults.length, prodResults.length);
  for (let i = 0; i < len; i++) {
    const uatStep = uatResults[i] || null;
    const prodStep = prodResults[i] || null;
    const step = flow.steps[i];
    if (!step) continue;

    // Functional diff: one succeeded, the other failed
    if (uatStep && prodStep && uatStep.status !== prodStep.status) {
      diffs.push({
        flowId: flow.id,
        flowName: flow.name,
        stepIndex: i,
        stepDescription: step.description,
        diffType: 'functional',
        severity: uatStep.status === 'success' ? 'critical' : 'high',
        hasDiff: true,
        summary: `${step.description}: UAT ${uatStep.status}, PROD ${prodStep.status}`,
        details: {
          uatStatus: uatStep.status,
          prodStatus: prodStep.status,
          uatError: uatStep.error,
          prodError: prodStep.error,
        },
      });
    }

    // Action-specific diffs
    if (step.action === 'screenshot' && uatStep && prodStep) {
      const vDiff = computeVisualDiff(uatStep, prodStep, flow.id, i, step, ssDir, threshold);
      if (vDiff) diffs.push(vDiff);
    }

    if (step.action === 'check_element' && uatStep && prodStep) {
      if (uatStep.elementFound !== prodStep.elementFound) {
        diffs.push({
          flowId: flow.id, flowName: flow.name, stepIndex: i,
          stepDescription: step.description,
          diffType: 'structural',
          severity: 'high',
          hasDiff: true,
          summary: `${step.description}: UAT ${uatStep.elementFound ? 'found' : 'missing'}, PROD ${prodStep.elementFound ? 'found' : 'missing'}`,
          details: { uatFound: uatStep.elementFound, prodFound: prodStep.elementFound, selector: step.selector },
        });
      }
    }

    if (step.action === 'extract_data' && uatStep && prodStep) {
      const uatVal = uatStep.data[step.key];
      const prodVal = prodStep.data[step.key];
      if (normalizeText(uatVal) !== normalizeText(prodVal)) {
        diffs.push({
          flowId: flow.id, flowName: flow.name, stepIndex: i,
          stepDescription: step.description,
          diffType: 'data',
          severity: 'low',
          hasDiff: true,
          summary: `${step.description}: data mismatch`,
          details: { uatValue: uatVal, prodValue: prodVal, key: step.key },
        });
      }
    }

    if (step.action === 'extract_dom' && uatStep && prodStep) {
      const domDiff = computeDOMDiff(uatStep.domSnapshot, prodStep.domSnapshot);
      if (domDiff.hasDiff) {
        diffs.push({
          flowId: flow.id, flowName: flow.name, stepIndex: i,
          stepDescription: step.description,
          diffType: 'structural',
          severity: domDiff.missingCount > 3 ? 'high' : 'medium',
          hasDiff: true,
          summary: `${step.description}: ${domDiff.missingCount} DOM differences`,
          details: domDiff,
        });
      }
    }

    if (step.action === 'measure_perf' && uatStep && prodStep) {
      const pDiff = computePerfDiff(uatStep.perfMetrics, prodStep.perfMetrics, perfThreshold);
      if (pDiff.hasDiff) {
        diffs.push({
          flowId: flow.id, flowName: flow.name, stepIndex: i,
          stepDescription: step.description,
          diffType: 'performance',
          severity: pDiff.regressions.length > 2 ? 'high' : 'medium',
          hasDiff: true,
          summary: `${step.description}: ${pDiff.regressions.length} perf regressions`,
          details: pDiff,
        });
      }
    }

    if (step.action === 'goto' && uatStep && prodStep) {
      if (uatStep.httpStatus !== prodStep.httpStatus) {
        diffs.push({
          flowId: flow.id, flowName: flow.name, stepIndex: i,
          stepDescription: step.description,
          diffType: 'functional',
          severity: (prodStep.httpStatus >= 400 && uatStep.httpStatus < 400) ? 'critical' : 'medium',
          hasDiff: true,
          summary: `${step.description}: HTTP ${uatStep.httpStatus} (UAT) vs ${prodStep.httpStatus} (PROD)`,
          details: { uatStatus: uatStep.httpStatus, prodStatus: prodStep.httpStatus },
        });
      }
    }
  }

  return diffs;
}

function computeVisualDiff(uatStep, prodStep, flowId, stepIndex, step, ssDir, threshold) {
  if (!uatStep.screenshotBuffer || !prodStep.screenshotBuffer) return null;

  try {
    const uatPng = PNG.sync.read(uatStep.screenshotBuffer);
    const prodPng = PNG.sync.read(prodStep.screenshotBuffer);

    // Size mismatch
    if (uatPng.width !== prodPng.width || uatPng.height !== prodPng.height) {
      return {
        flowId, flowName: step.description, stepIndex,
        stepDescription: step.description,
        diffType: 'visual',
        severity: 'medium',
        hasDiff: true,
        summary: `Screenshot size mismatch: UAT ${uatPng.width}x${uatPng.height} vs PROD ${prodPng.width}x${prodPng.height}`,
        details: {
          uatSize: `${uatPng.width}x${uatPng.height}`,
          prodSize: `${prodPng.width}x${prodPng.height}`,
          uatScreenshot: uatStep.screenshot,
          prodScreenshot: prodStep.screenshot,
        },
      };
    }

    const { width, height } = uatPng;
    const diff = new PNG({ width, height });
    const mismatchedPixels = pixelmatch(uatPng.data, prodPng.data, diff.data, width, height, { threshold: 0.1 });
    const totalPixels = width * height;
    const diffPercent = mismatchedPixels / totalPixels;

    if (diffPercent > threshold) {
      const diffFileName = `diff_${flowId}_${step.name}.png`;
      const diffPath = path.join(ssDir, diffFileName);
      fs.writeFileSync(diffPath, PNG.sync.write(diff));

      return {
        flowId, flowName: step.description, stepIndex,
        stepDescription: step.description,
        diffType: 'visual',
        severity: diffPercent > 0.05 ? 'high' : 'medium',
        hasDiff: true,
        summary: `${(diffPercent * 100).toFixed(1)}% pixel difference (${mismatchedPixels} pixels)`,
        details: {
          diffPercent,
          mismatchedPixels,
          totalPixels,
          diffImagePath: diffPath,
          uatScreenshot: uatStep.screenshot,
          prodScreenshot: prodStep.screenshot,
        },
      };
    }
  } catch (e) {
    return {
      flowId, flowName: step.description, stepIndex,
      stepDescription: step.description,
      diffType: 'visual',
      severity: 'low',
      hasDiff: true,
      summary: `Visual comparison failed: ${e.message}`,
      details: { error: e.message },
    };
  }

  return null; // No significant diff
}

function computeDOMDiff(uatDom, prodDom) {
  const missing = [];

  function compare(uNode, pNode, path) {
    if (!uNode && !pNode) return;
    if (!uNode || !pNode) {
      missing.push({ path, uatHas: !!uNode, prodHas: !!pNode });
      return;
    }
    if (uNode.tag !== pNode.tag) {
      missing.push({ path, uatTag: uNode.tag, prodTag: pNode.tag });
      return;
    }
    // Compare children count
    const uChildren = uNode.children || [];
    const pChildren = pNode.children || [];
    const maxLen = Math.max(uChildren.length, pChildren.length);
    for (let i = 0; i < Math.min(maxLen, 10); i++) {
      compare(uChildren[i] || null, pChildren[i] || null, `${path}>${uNode.tag}[${i}]`);
    }
  }

  compare(uatDom, prodDom, 'root');

  return {
    hasDiff: missing.length > 0,
    missingCount: missing.length,
    differences: missing.slice(0, 20),
  };
}

function computePerfDiff(uatMetrics, prodMetrics, threshold) {
  if (!uatMetrics || !prodMetrics) return { hasDiff: false, regressions: [] };

  const regressions = [];
  const fields = ['fcp', 'ttfb', 'loadTime'];
  for (const field of fields) {
    const uVal = uatMetrics[field];
    const pVal = prodMetrics[field];
    if (uVal && pVal && pVal > 0) {
      const delta = (pVal - uVal) / uVal;
      if (Math.abs(delta) > threshold) {
        const direction = delta > 0 ? 'PROD slower' : 'PROD faster';
        regressions.push({
          metric: field.toUpperCase(),
          uatValue: uVal,
          prodValue: pVal,
          deltaPercent: Math.round(delta * 100),
          direction,
        });
      }
    }
  }

  // DOM size comparison
  if (uatMetrics.domSize && prodMetrics.domSize) {
    const domDelta = Math.abs(prodMetrics.domSize - uatMetrics.domSize) / uatMetrics.domSize;
    if (domDelta > threshold) {
      regressions.push({
        metric: 'DOM_SIZE',
        uatValue: uatMetrics.domSize,
        prodValue: prodMetrics.domSize,
        deltaPercent: Math.round(domDelta * 100),
        direction: prodMetrics.domSize > uatMetrics.domSize ? 'PROD larger' : 'PROD smaller',
      });
    }
  }

  return {
    hasDiff: regressions.length > 0,
    regressions,
    uatMetrics,
    prodMetrics,
  };
}

function normalizeText(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\s+/g, ' ').trim().toLowerCase();
}

module.exports = { computeDiffs };
