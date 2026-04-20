'use strict';

/**
 * RunContext — replaces all global mutable state.
 * Each test run gets its own instance, enabling multi-site parallel execution.
 */
class RunContext {
  constructor(config) {
    this.config = config;
    this.bugs = [];
    this.bugCounter = 0;
    this.screenshots = {};
    this.consoleErrors = [];
    this.networkErrors = [];
    this.perfData = [];
    this.testResults = { passed: 0, failed: 0, skipped: 0, total: 0 };
    this.loggedIn = false;
    this.startTime = Date.now();
  }

  elapsed() {
    return Date.now() - this.startTime;
  }

  budgetLeft() {
    return this.config.budgetMs - this.elapsed();
  }

  isBudgetExceeded() {
    return this.elapsed() >= this.config.budgetMs;
  }
}

module.exports = { RunContext };
