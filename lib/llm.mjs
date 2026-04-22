/**
 * lib/llm.mjs — Provider-agnostic LLM client for career-ops.
 *
 * Supports:
 *   - anthropic (native SDK, uses system+messages shape, supports cache_control)
 *   - openai     (https://api.openai.com/v1)
 *   - minimax    (https://api.minimaxi.com/v1 — OpenAI-compatible)
 *   - deepseek   (https://api.deepseek.com/v1)
 *   - together   (https://api.together.xyz/v1)
 *   - groq       (https://api.groq.com/openai/v1)
 *   - mistral    (https://api.mistral.ai/v1)
 *   - custom     (any OpenAI-compatible endpoint via LLM_BASE_URL)
 *
 * Configuration via env vars (precedence: LLM_* overrides provider-specific):
 *   LLM_PROVIDER        — one of the keys above (default: anthropic)
 *   LLM_MODEL           — model name for the selected provider
 *   LLM_API_KEY         — API key (falls back to provider-specific env var)
 *   LLM_BASE_URL        — override baseURL (required for `custom` provider)
 *
 * Fallback env vars per provider:
 *   anthropic  → ANTHROPIC_API_KEY
 *   openai     → OPENAI_API_KEY
 *   minimax    → MINIMAX_API_KEY
 *   deepseek   → DEEPSEEK_API_KEY
 *   together   → TOGETHER_API_KEY
 *   groq       → GROQ_API_KEY
 *   mistral    → MISTRAL_API_KEY
 */

import Anthropic from '@anthropic-ai/sdk';
import { OpenAI } from 'openai';

const PROVIDER_DEFAULTS = {
  anthropic: {
    baseURL: null,                                       // Anthropic SDK uses its own
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-haiku-4-5-20251001',
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-4o-mini',
  },
  minimax: {
    baseURL: 'https://api.minimaxi.com/v1',
    apiKeyEnv: 'MINIMAX_API_KEY',
    defaultModel: 'MiniMax-M1',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
  },
  together: {
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  },
  groq: {
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
  },
  mistral: {
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    defaultModel: 'mistral-small-latest',
  },
  custom: {
    baseURL: null,                                       // must set LLM_BASE_URL
    apiKeyEnv: null,                                     // must set LLM_API_KEY
    defaultModel: 'unset',
  },
};

/**
 * Build LLM config from environment variables.
 * @param {object} overrides — optional overrides (for tests)
 * @returns {{provider: string, model: string, apiKey: string, baseURL: string|null}}
 */
export function buildLlmConfig(overrides = {}) {
  const provider = overrides.provider || process.env.LLM_PROVIDER || 'anthropic';
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new Error(`Unknown LLM_PROVIDER: "${provider}". Valid: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`);
  }
  const model = overrides.model || process.env.LLM_MODEL || defaults.defaultModel;
  const apiKey = overrides.apiKey || process.env.LLM_API_KEY
    || (defaults.apiKeyEnv ? process.env[defaults.apiKeyEnv] : null);
  const baseURL = overrides.baseURL || process.env.LLM_BASE_URL || defaults.baseURL;

  if (provider === 'custom' && !baseURL) {
    throw new Error('LLM_PROVIDER=custom requires LLM_BASE_URL to be set.');
  }
  if (!apiKey) {
    const hint = defaults.apiKeyEnv ? `Set ${defaults.apiKeyEnv} or LLM_API_KEY.` : 'Set LLM_API_KEY.';
    throw new Error(`No API key for provider "${provider}". ${hint}`);
  }

  return { provider, model, apiKey, baseURL };
}

/**
 * Create a provider-specific native client.
 */
export function createLlmClient(config) {
  if (config.provider === 'anthropic') {
    return new Anthropic({ apiKey: config.apiKey });
  }
  // OpenAI-compatible providers
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });
}

/**
 * Universal chat completion.
 *
 * Inputs:
 *   - systemBlocks: string or array of { type: 'text', text, cache_control? }
 *     (cache_control is ignored for non-anthropic providers)
 *   - userMessage: string
 *
 * Returns: { text: string, usage: object }
 */
export async function chat({ client, config, systemBlocks, userMessage, maxTokens = 120, temperature = 0 }) {
  if (config.provider === 'anthropic') {
    // Anthropic: system goes as a separate parameter, supports array of blocks with cache_control
    const system = typeof systemBlocks === 'string' ? systemBlocks : systemBlocks;
    const response = await client.messages.create({
      model: config.model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: userMessage }],
    });
    return {
      text: response.content?.[0]?.text || '',
      usage: response.usage || {},
    };
  }

  // OpenAI-compatible: flatten system blocks, no cache_control
  const systemText = typeof systemBlocks === 'string'
    ? systemBlocks
    : (systemBlocks || []).map(b => (typeof b === 'string' ? b : b.text)).join('\n\n');

  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: userMessage },
    ],
  });
  return {
    text: response.choices?.[0]?.message?.content || '',
    usage: response.usage || {},
  };
}

/**
 * Convenience: build config + client in one call.
 */
export function initLlm(overrides = {}) {
  const config = buildLlmConfig(overrides);
  const client = createLlmClient(config);
  return { config, client };
}
