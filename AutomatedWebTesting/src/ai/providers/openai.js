'use strict';

const OpenAI = require('openai');

const COST_MAP = {
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};

class OpenAIProvider {
  constructor(apiKey) {
    this.client = new OpenAI({ apiKey });
    this.totalTokens = { input: 0, output: 0 };
  }

  trackUsage(model, usage) {
    if (!usage) return;
    this.totalTokens.input += usage.prompt_tokens || 0;
    this.totalTokens.output += usage.completion_tokens || 0;
  }

  getUsageCost() {
    const rates = COST_MAP['gpt-4o'];
    return (this.totalTokens.input / 1_000_000 * rates.input) + (this.totalTokens.output / 1_000_000 * rates.output);
  }

  async chat(model, messages, maxTokens = 500) {
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.3,
      });
      this.trackUsage(model, res.usage);
      return res.choices[0]?.message?.content || '';
    } catch (e) {
      console.log(`  [AI] API error: ${e.message.slice(0, 100)}`);
      return null;
    }
  }

  async chatWithVision(model, content, maxTokens = 1000) {
    try {
      const res = await this.client.chat.completions.create({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens,
        temperature: 0.3,
      });
      this.trackUsage(model, res.usage);
      return res.choices[0]?.message?.content || '';
    } catch (e) {
      console.log(`  [AI] API error: ${e.message.slice(0, 100)}`);
      return null;
    }
  }
}

module.exports = OpenAIProvider;
