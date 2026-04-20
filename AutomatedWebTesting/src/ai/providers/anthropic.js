'use strict';

const Anthropic = require('@anthropic-ai/sdk').default;

const COST_MAP = {
  'claude-sonnet-4-6':  { input: 3.00, output: 15.00 },
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
};

// Model aliases for convenience
const MODEL_ALIASES = {
  'sonnet': 'claude-sonnet-4-6',
  'haiku': 'claude-haiku-4-5-20251001',
};

class AnthropicProvider {
  constructor(apiKey) {
    this.client = new Anthropic({ apiKey });
    this.totalTokens = { input: 0, output: 0 };
    this.modelUsage = {};
  }

  resolveModel(model) {
    return MODEL_ALIASES[model] || model;
  }

  trackUsage(model, usage) {
    if (!usage) return;
    this.totalTokens.input += usage.input_tokens || 0;
    this.totalTokens.output += usage.output_tokens || 0;
    if (!this.modelUsage[model]) this.modelUsage[model] = { input: 0, output: 0 };
    this.modelUsage[model].input += usage.input_tokens || 0;
    this.modelUsage[model].output += usage.output_tokens || 0;
  }

  getUsageCost() {
    let total = 0;
    for (const [model, tokens] of Object.entries(this.modelUsage)) {
      const rates = COST_MAP[model] || COST_MAP['claude-sonnet-4-6'];
      total += (tokens.input / 1_000_000 * rates.input) + (tokens.output / 1_000_000 * rates.output);
    }
    return total;
  }

  /**
   * chat() — matches OpenAIProvider interface.
   * Accepts OpenAI-style messages array and maps to Anthropic format.
   * Model names: pass OpenAI model names and they get mapped, or use Claude model names directly.
   */
  async chat(model, messages, maxTokens = 500) {
    try {
      const resolvedModel = this._mapModel(model);

      // Separate system message from conversation
      const systemMsgs = messages.filter(m => m.role === 'system');
      const conversationMsgs = messages.filter(m => m.role !== 'system');

      const params = {
        model: resolvedModel,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: conversationMsgs.map(m => ({ role: m.role, content: m.content })),
      };

      if (systemMsgs.length > 0) {
        params.system = systemMsgs.map(m => m.content).join('\n\n');
      }

      const res = await this.client.messages.create(params);
      this.trackUsage(resolvedModel, res.usage);
      return res.content?.[0]?.text || '';
    } catch (e) {
      console.log(`  [AI] Anthropic API error: ${e.message.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * chatWithVision() — matches OpenAIProvider interface.
   * Converts OpenAI vision content format to Anthropic format.
   */
  async chatWithVision(model, content, maxTokens = 1000) {
    try {
      const resolvedModel = this._mapModel(model);

      // Convert OpenAI content format to Anthropic content blocks
      const anthropicContent = content.map(item => {
        if (item.type === 'text') {
          return { type: 'text', text: item.text };
        }
        if (item.type === 'image_url') {
          const url = item.image_url?.url || '';
          // Handle base64 data URIs
          const match = url.match(/^data:(image\/\w+);base64,(.+)$/);
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1],
                data: match[2],
              },
            };
          }
          // Handle regular URLs
          return {
            type: 'image',
            source: { type: 'url', url },
          };
        }
        return item;
      });

      const res = await this.client.messages.create({
        model: resolvedModel,
        max_tokens: maxTokens,
        temperature: 0.3,
        messages: [{ role: 'user', content: anthropicContent }],
      });

      this.trackUsage(resolvedModel, res.usage);
      return res.content?.[0]?.text || '';
    } catch (e) {
      console.log(`  [AI] Anthropic API error: ${e.message.slice(0, 100)}`);
      return null;
    }
  }

  /**
   * Map OpenAI model names to Anthropic equivalents.
   * Also accepts Claude model names directly.
   */
  _mapModel(model) {
    if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
    if (model.startsWith('claude-')) return model;

    // Map OpenAI models to Claude equivalents
    const mapping = {
      'gpt-4o': 'claude-sonnet-4-6',
      'gpt-4o-mini': 'claude-haiku-4-5-20251001',
      'gpt-4-turbo': 'claude-sonnet-4-6',
      'gpt-3.5-turbo': 'claude-haiku-4-5-20251001',
    };
    return mapping[model] || 'claude-sonnet-4-6';
  }
}

module.exports = AnthropicProvider;
