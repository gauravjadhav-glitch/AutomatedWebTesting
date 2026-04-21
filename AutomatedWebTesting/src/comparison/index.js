'use strict';

module.exports = {
  orchestrateComparison: require('./orchestrator').orchestrateComparison,
  ComparisonContext: require('./context').ComparisonContext,
  generateFlows: require('./flow-generator').generateFlows,
  replayFlow: require('./flow-replayer').replayFlow,
  computeDiffs: require('./diff-engine').computeDiffs,
  generateComparisonReport: require('./report-generator').generateComparisonReport,
};
