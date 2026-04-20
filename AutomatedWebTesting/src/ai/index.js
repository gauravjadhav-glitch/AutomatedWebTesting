'use strict';

const OpenAIProvider = require('./providers/openai');
const AnthropicProvider = require('./providers/anthropic');
const { analyzeScreenshotsForBugs } = require('./agents/visual-detection');
const { analyzeBugsWithAI } = require('./agents/bug-analysis');
const { generateExecutiveSummary } = require('./agents/executive-summary');
const { generateTestIntelligence } = require('./agents/test-intelligence');
const { triageBugs } = require('./agents/auto-triage');
const { analyzeFlaky } = require('./agents/flaky-detector');
const { generateTestCases } = require('./agents/test-case-generator');

class AIOrchestrator {
  constructor(config) {
    this.config = config;
    this.provider = null;
    this.providerName = config.ai?.provider || 'openai';
    this.totalTokens = { input: 0, output: 0 };
    this.budgetUsd = config.ai?.budget || 0.50;

    // Select provider based on AI_PROVIDER config
    if (this.providerName === 'anthropic' && config.ai?.anthropicApiKey) {
      this.provider = new AnthropicProvider(config.ai.anthropicApiKey);
    } else if (config.ai?.openaiApiKey) {
      this.provider = new OpenAIProvider(config.ai.openaiApiKey);
      this.providerName = 'openai';
    }

    if (this.provider) {
      console.log(`  [AI] Provider: ${this.providerName} (budget: $${this.budgetUsd})`);
    }
  }

  isAvailable() {
    return !!this.provider;
  }

  getUsageCost() {
    return this.provider ? this.provider.getUsageCost() : 0;
  }

  isBudgetExceeded() {
    return this.getUsageCost() >= this.budgetUsd;
  }

  async analyzeScreenshotsForBugs(screenshots, siteContext) {
    if (!this.provider) return [];
    return analyzeScreenshotsForBugs(this.provider, screenshots, siteContext, () => this.isBudgetExceeded());
  }

  async analyzeBugsWithAI(bugs) {
    if (!this.provider) return {};
    return analyzeBugsWithAI(this.provider, bugs, () => this.isBudgetExceeded());
  }

  async generateExecutiveSummary(counts, classified, siteNames, healthScore) {
    if (!this.provider) return '';
    return generateExecutiveSummary(this.provider, counts, classified, siteNames, healthScore, () => this.isBudgetExceeded());
  }

  async generateTestIntelligence(discovery1, discovery2, knowledge, bugs) {
    if (!this.provider) return null;
    return generateTestIntelligence(this.provider, discovery1, discovery2, knowledge, bugs, () => this.isBudgetExceeded());
  }

  async triageBugs(bugs, historicalBugs) {
    if (!this.provider) return {};
    return triageBugs(this.provider, bugs, historicalBugs, () => this.isBudgetExceeded());
  }

  async analyzeFlaky(flakyFingerprints, siteName) {
    if (!this.provider) return [];
    return analyzeFlaky(this.provider, flakyFingerprints, siteName, () => this.isBudgetExceeded());
  }

  async generateTestCases(discovery, bugs) {
    if (!this.provider) return [];
    return generateTestCases(this.provider, discovery, bugs, () => this.isBudgetExceeded());
  }
}

module.exports = { AIOrchestrator };
