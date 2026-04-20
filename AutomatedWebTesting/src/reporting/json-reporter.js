'use strict';

function generateJSONReport(discovery, metadata, config, ctx) {
  return {
    meta: {
      url: config.targetUrl,
      mode: config.mode,
      timestamp: new Date().toISOString(),
      duration: metadata.duration,
      reportNum: metadata.reportNum,
      testResults: ctx.testResults,
      aiCost: metadata.aiCost || 'N/A',
    },
    discovery: {
      livePages: discovery.livePages.length,
      deadPages: discovery.deadPages.length,
      features: discovery.features,
    },
    bugs: ctx.bugs,
    consoleErrors: ctx.consoleErrors.slice(0, 50),
    networkErrors: ctx.networkErrors.slice(0, 50),
  };
}

module.exports = { generateJSONReport };
