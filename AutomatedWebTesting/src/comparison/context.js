'use strict';

class ComparisonContext {
  constructor(uatUrl, prodUrl, config) {
    this.uatUrl = uatUrl.replace(/\/+$/, '');
    this.prodUrl = prodUrl.replace(/\/+$/, '');
    this.config = config;
    this.discovery = null;
    this.flows = [];
    this.uatResults = {};   // flowId -> StepResult[]
    this.prodResults = {};  // flowId -> StepResult[]
    this.diffs = [];        // DiffResult[]
    this.startTime = Date.now();

    this.summary = {
      totalSteps: 0,
      matchedSteps: 0,
      diffSteps: 0,
      failedSteps: 0,
      visualDiffs: 0,
      structuralDiffs: 0,
      dataDiffs: 0,
      functionalDiffs: 0,
      perfRegressions: 0,
    };
  }

  elapsed() { return Date.now() - this.startTime; }
  isBudgetExceeded() { return this.elapsed() >= this.config.budgetMs * 1.5; }

  addDiff(diff) {
    this.diffs.push(diff);
    if (diff.hasDiff) {
      this.summary.diffSteps++;
      if (diff.diffType === 'visual') this.summary.visualDiffs++;
      if (diff.diffType === 'structural') this.summary.structuralDiffs++;
      if (diff.diffType === 'data') this.summary.dataDiffs++;
      if (diff.diffType === 'functional') this.summary.functionalDiffs++;
      if (diff.diffType === 'performance') this.summary.perfRegressions++;
    } else {
      this.summary.matchedSteps++;
    }
  }
}

module.exports = { ComparisonContext };
