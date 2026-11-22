// Provider presets, profile normalization, and endpoint helpers shared by the panel and worker.
//
// The preset-driven connection flow and parts of the provider catalog are adapted from
// Cline (https://github.com/cline/cline), Copyright Cline Bot Inc., licensed under the
// Apache License, Version 2.0. See LICENSE-CLINE.txt and THIRD_PARTY_NOTICES.md.
// Changes for this extension: trimmed provider set, Chrome MV3 host-permission flow,
// local Ollama loopback, profile/key storage, and UI-specific defaults.

const preset = (id, label, options = {}) => {
  const merged = {
    id,
    label,
    defaultEndpoint: '',
    defaultModel: '',
    models: [],
    chatPath: '/chat/completions',
    modelsPath: '/models',
    keyRequired: true,
    local: false,
    custom: false,
    native: false,
    auth: 'bearer',
    headers: {},
    signupUrl: '',
    docsUrl: '',
    help: '',
    ...options,
  };
  merged.keyOptional = !merged.keyRequired;
  return Object.freeze(merged);
};

export const PROVIDERS = Object.freeze({
  openai: preset('openai', 'OpenAI', {
    defaultEndpoint: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini', 'o3-mini'],
    signupUrl: 'https://platform.openai.com/api-keys',
    docsUrl: 'https://platform.openai.com/docs/models',
    help: 'Uses OpenAI’s chat completions API. Models are loaded from the account.',
  }),
  anthropic: preset('anthropic', 'Anthropic (Claude)', {
    defaultEndpoint: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-4-5',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    auth: 'anthropic',
    signupUrl: 'https://console.anthropic.com/settings/keys',
    docsUrl: 'https://docs.anthropic.com/en/api/openai-sdk',
    help: 'Uses Anthropic’s OpenAI-compatible endpoint. The key is sent only from the background.',
  }),
  gemini: preset('gemini', 'Google Gemini', {
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    signupUrl: 'https://aistudio.google.com/apikey',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    help: 'Uses Gemini’s OpenAI-compatible endpoint.',
  }),
  openrouter: preset('openrouter', 'OpenRouter', {
    defaultEndpoint: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
    models: [
      'openai/gpt-4o-mini', 'openai/gpt-4o', 'anthropic/claude-sonnet-4.5',
      'google/gemini-2.5-flash', 'deepseek/deepseek-chat',
    ],
    signupUrl: 'https://openrouter.ai/settings/keys',
    docsUrl: 'https://openrouter.ai/models',
    help: 'The model list is public, so it can be loaded before entering a key.',
  }),
  deepseek: preset('deepseek', 'DeepSeek', {
    defaultEndpoint: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    signupUrl: 'https://platform.deepseek.com/api_keys',
    docsUrl: 'https://api-docs.deepseek.com/',
    help: 'Uses DeepSeek’s OpenAI-compatible chat API.',
  }),
  groq: preset('groq', 'Groq', {
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
    signupUrl: 'https://console.groq.com/keys',
    docsUrl: 'https://console.groq.com/docs/models',
  }),
  mistral: preset('mistral', 'Mistral', {
    defaultEndpoint: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-large-latest',
    models: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest', 'ministral-8b-latest'],
    signupUrl: 'https://console.mistral.ai/api-keys',
    docsUrl: 'https://docs.mistral.ai/getting-started/models/',
  }),
  xai: preset('xai', 'xAI (Grok)', {
    defaultEndpoint: 'https://api.x.ai/v1',
    defaultModel: 'grok-3',
    models: ['grok-3', 'grok-3-mini', 'grok-4'],
    signupUrl: 'https://console.x.ai/',
    docsUrl: 'https://docs.x.ai/docs/models',
  }),
  together: preset('together', 'Together AI', {
    defaultEndpoint: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    models: [
      'meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo',
      'openai/gpt-oss-120b',
    ],
    signupUrl: 'https://api.together.ai/settings/api-keys',
    docsUrl: 'https://docs.together.ai/docs/serverless-models',
  }),
  fireworks: preset('fireworks', 'Fireworks AI', {
    defaultEndpoint: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: [
      'accounts/fireworks/models/llama-v3p3-70b-instruct',
      'accounts/fireworks/models/qwen3-235b-a22b',
    ],
    signupUrl: 'https://app.fireworks.ai/settings/users/api-keys',
    docsUrl: 'https://fireworks.ai/docs/',
  }),
  cerebras: preset('cerebras', 'Cerebras', {
    defaultEndpoint: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-8b',
    models: ['llama3.1-8b', 'llama-3.3-70b'],
    signupUrl: 'https://cloud.cerebras.ai/',
    docsUrl: 'https://inference-docs.cerebras.ai/models/overview',
  }),
  sambanova: preset('sambanova', 'SambaNova', {
    defaultEndpoint: 'https://api.sambanova.ai/v1',
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct'],
    signupUrl: 'https://cloud.sambanova.ai/',
    docsUrl: 'https://docs.sambanova.ai/cloud/docs/get-started/supported-models',
  }),
  nebius: preset('nebius', 'Nebius Token Factory', {
    defaultEndpoint: 'https://api.tokenfactory.nebius.com/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen3-235B-A22B'],
    signupUrl: 'https://auth.tokenfactory.nebius.com/',
    docsUrl: 'https://docs.tokenfactory.nebius.com/',
  }),
  perplexity: preset('perplexity', 'Perplexity', {
    defaultEndpoint: 'https://api.perplexity.ai',
    defaultModel: 'sonar',
    models: ['sonar', 'sonar-pro', 'sonar-reasoning'],
    chatPath: '/chat/completions',
    modelsPath: '/models',
    signupUrl: 'https://www.perplexity.ai/settings/api',
    docsUrl: 'https://docs.perplexity.ai/',
  }),
  moonshot: preset('moonshot', 'Moonshot AI', {
    defaultEndpoint: 'https://api.moonshot.ai/v1',
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
    signupUrl: 'https://platform.moonshot.ai/console/api-keys',
    docsUrl: 'https://platform.moonshot.ai/docs/api/chat',
  }),
  zai: preset('zai', 'Z.AI (GLM)', {
    defaultEndpoint: 'https://api.z.ai/api/paas/v4',
    defaultModel: 'glm-4.5',
    models: ['glm-4.5', 'glm-4.5-air', 'glm-4-plus'],
    signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/guides/overview/pricing',
  }),
  ollama: preset('ollama', 'Ollama (local)', {
    defaultEndpoint: 'http://127.0.0.1:11434',
    defaultModel: 'gemma4:12b',
    chatPath: '/api/chat',
    modelsPath: '/api/tags',
    keyRequired: false,
    local: true,
    native: true,
    help: 'Uses Ollama’s native chat API through the extension’s loopback. No key is needed.',
  }),
  openwebui: preset('openwebui', 'Open WebUI (local)', {
    defaultEndpoint: 'http://localhost:3000',
    defaultModel: '',
    chatPath: '/api/chat/completions',
    modelsPath: '/api/models',
    keyRequired: true,
    local: true,
    help: 'Uses Open WebUI’s /api/chat/completions endpoint. An API key from Open WebUI is usually required.',
  }),
  llamacpp: preset('llamacpp', 'llama.cpp server (local)', {
    defaultEndpoint: 'http://localhost:8080/v1',
    defaultModel: '',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    keyRequired: false,
    local: true,
    help: 'Uses llama.cpp’s OpenAI-compatible endpoint. A key is optional unless the server was started with --api-key.',
  }),
  lmstudio: preset('lmstudio', 'LM Studio (local)', {
    defaultEndpoint: 'http://localhost:1234/v1',
    defaultModel: '',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    keyRequired: false,
    local: true,
    help: 'Uses LM Studio’s OpenAI-compatible local server. No key is needed by default.',
  }),
  cloud: preset('cloud', 'Custom OpenAI-compatible', {
    defaultEndpoint: '',
    defaultModel: '',
    chatPath: '',
    modelsPath: '',
    keyRequired: false,
    custom: true,
    help: 'Enter the base URL and model for any OpenAI-compatible API. A key is optional; host access is granted separately for custom domains.',
  }),
});

export const PROVIDER_GROUPS = Object.freeze([
  {
    label: 'Cloud APIs',
    ids: ['openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'groq', 'mistral', 'xai',
      'together', 'fireworks', 'cerebras', 'sambanova', 'nebius', 'perplexity', 'moonshot', 'zai'],
  },
  { label: 'Local servers', ids: ['ollama', 'openwebui', 'llamacpp', 'lmstudio'] },
  { label: 'Custom', ids: ['cloud'] },
]);

export const THINKING_LEVELS = Object.freeze(['default', 'off', 'low', 'medium', 'high']);
export const DEFAULT_PROFILE_ID = 'local-gemma';

const text = (value, limit) => String(value ?? '').trim().slice(0, limit);
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function providerSpec(provider) {
  return PROVIDERS[provider] || PROVIDERS.cloud;
}

export function defaultProfile(provider = 'ollama') {
  const spec = providerSpec(provider);
  return {
    id: provider === 'ollama' ? DEFAULT_PROFILE_ID : (globalThis.crypto?.randomUUID?.() || 'llm-' + Date.now()),
    label: provider === 'ollama' ? 'Local Gemma' : spec.label,
    name: '',
    provider: PROVIDERS[provider] ? provider : 'cloud',
    endpoint: spec.defaultEndpoint,
    model: spec.defaultModel,
    thinking: 'default',
    pricing: { input: 0, output: 0 },
    hasKey: false,
    keyHint: '',
    lastUsedAt: 0,
  };
}

export function defaultLlmConfig() {
  const profile = defaultProfile('ollama');
  return { version: 1, activeProfileId: profile.id, profiles: [profile] };
}

export function normalizeProfile(raw, index = 0) {
  const provider = raw && Object.hasOwn(PROVIDERS, raw.provider) ? raw.provider : 'ollama';
  const spec = PROVIDERS[provider];
  return {
    id: text(raw?.id, 80) || (globalThis.crypto?.randomUUID?.() || 'llm-' + Date.now() + '-' + index),
    label: text(raw?.label, 60) || (provider === 'ollama' ? 'Local Gemma' : spec.label),
    name: text(raw?.name, 32),
    provider,
    endpoint: provider === 'ollama' ? spec.defaultEndpoint : (text(raw?.endpoint, 400) || spec.defaultEndpoint),
    model: text(raw?.model, 160) || spec.defaultModel,
    thinking: THINKING_LEVELS.includes(raw?.thinking) ? raw.thinking : 'default',
    pricing: { input: number(raw?.pricing?.input), output: number(raw?.pricing?.output) },
    hasKey: !!raw?.hasKey,
    keyHint: text(raw?.keyHint, 8),
    lastUsedAt: Number.isFinite(raw?.lastUsedAt) ? raw.lastUsedAt : 0,
  };
}

export function normalizeLlmConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : defaultLlmConfig();
  const profiles = Array.isArray(source.profiles) && source.profiles.length
    ? source.profiles.slice(0, 50).map(normalizeProfile)
    : [defaultProfile('ollama')];
  let activeProfileId = text(source.activeProfileId, 80);
  if (!profiles.some((profile) => profile.id === activeProfileId)) activeProfileId = profiles[0].id;
  return { version: 1, activeProfileId, profiles };
}

export function activeProfile(config) {
  return config?.profiles?.find((profile) => profile.id === config.activeProfileId) || config?.profiles?.[0] || null;
}

export function assistantLabel(config) {
  const profile = activeProfile(config);
  const custom = text(profile?.name, 32);
  if (custom) return custom;
  const model = text(profile?.model, 160);
  const leaf = (model || text(profile?.label || 'LLM', 60)).split('/').pop().split(':')[0];
  const stripped = leaf.replace(/^local\s+/i, '').replace(/\d+(?:\.\d+)*$/, '') || leaf;
  const word = stripped.split(/[\s_-]/)[0] || stripped || 'LLM';
  const label = word[0].toUpperCase() + word.slice(1);
  return /^gpt$/i.test(label) ? 'GPT' : label;
}

export function providerSpecFor(profile) {
  return providerSpec(profile?.provider);
}

export function providerKeyRequired(profile) {
  return !!providerSpecFor(profile).keyRequired;
}

export function providerModelChoices(profile) {
  return [...(providerSpecFor(profile).models || [])];
}

export function trimBase(endpoint) {
  return String(endpoint || '').trim().replace(/\/+$/, '');
}

export function chatEndpoint(profile) {
  const spec = providerSpecFor(profile);
  const base = trimBase(profile?.endpoint) || spec.defaultEndpoint;
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base) || /\/api\/chat$/i.test(base)) return base;
  if (profile?.provider === 'openwebui') {
    if (/\/api$/i.test(base)) return base + '/chat/completions';
    if (!/\/api\//i.test(base)) return base + '/api/chat/completions';
  }
  if (spec.chatPath) return base + spec.chatPath;
  // Custom OpenAI-compatible base URL: accept a full endpoint or infer /v1.
  if (/\/v1$/i.test(base)) return base + '/chat/completions';
  if (/\/api$/i.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

export function modelsEndpoint(profile) {
  const spec = providerSpecFor(profile);
  const base = trimBase(profile?.endpoint) || spec.defaultEndpoint;
  if (!base) return '';
  if (/\/models$/i.test(base) || /\/api\/tags$/i.test(base)) return base;
  if (profile?.provider === 'openwebui') {
    if (/\/api$/i.test(base)) return base + '/models';
    if (!/\/api\//i.test(base)) return base + '/api/models';
  }
  if (spec.modelsPath) return base + spec.modelsPath;
  if (/\/v1$/i.test(base)) return base + '/models';
  if (/\/api$/i.test(base)) return base + '/models';
  return base + '/v1/models';
}

export function originPattern(profile) {
  try {
    return new URL(profile.endpoint).origin + '/*';
  } catch {
    return '';
  }
}

export function providerOrigin(profile) {
  try {
    return new URL(profile.endpoint).origin;
  } catch {
    return '';
  }
}

export function providerHeaders(profile, key, purpose = 'chat') {
  const spec = providerSpecFor(profile);
  const headers = { ...(spec.headers || {}) };
  if (!key) return headers;
  if (spec.auth === 'anthropic') {
    headers['anthropic-version'] = headers['anthropic-version'] || '2023-06-01';
    if (purpose === 'models') headers['x-api-key'] = key;
    else headers.Authorization = 'Bearer ' + key;
    return headers;
  }
  headers.Authorization = 'Bearer ' + key;
  return headers;
}

export function maskKey(hint) {
  const tail = text(hint, 4);
  return tail ? '••••' + tail : 'saved key';
}

export function reasoningEffort(level) {
  if (level === 'low' || level === 'medium' || level === 'high') return level;
  if (level === 'off') return 'none';
  return '';
}
