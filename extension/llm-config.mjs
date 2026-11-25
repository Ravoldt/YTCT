// Provider presets, profile normalization, and endpoint helpers shared by the panel and worker.
//
// The preset-driven connection flow and parts of the provider catalog are adapted from
// Cline (https://github.com/cline/cline), Copyright Cline Bot Inc., licensed under the
// Apache License, Version 2.0. See licenses/LICENSE-CLINE.txt and THIRD_PARTY_NOTICES.md.
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
    webSearchCapable: false,
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
    webSearchCapable: true,
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
    webSearchCapable: true,
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
    webSearchCapable: true,
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
    webSearchCapable: true,
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
    webSearchCapable: true,
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
    webSearchCapable: true,
    signupUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/guides/overview/pricing',
  }),
  ollama: preset('ollama', 'Ollama (local)', {
    defaultEndpoint: 'http://127.0.0.1:11434',
    defaultModel: '',
    chatPath: '/api/chat',
    modelsPath: '/api/tags',
    keyRequired: false,
    local: true,
    native: true,
    help: 'Uses Ollama’s native chat API through the extension’s loopback. No key is needed; host access is granted separately.',
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

export const THINKING_LEVELS = Object.freeze(['default', 'off', 'on', 'low', 'medium', 'high']);
export const MAX_CONTEXT_LIMIT = 2097152;
export const MIN_CONTEXT_LIMIT = 1024;
export const DEFAULT_LOCAL_CONTEXT = 32768;

const text = (value, limit) => String(value ?? '').trim().slice(0, limit);
const number = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const contextInt = (value) => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= MIN_CONTEXT_LIMIT ? Math.min(MAX_CONTEXT_LIMIT, parsed) : 0;
};
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);
const safeId = (value) => {
  const candidate = text(value, 80);
  return /^[A-Za-z0-9_-]{1,80}$/.test(candidate) && !FORBIDDEN_IDS.has(candidate) ? candidate : '';
};

export function providerSpec(provider) {
  return PROVIDERS[provider] || PROVIDERS.cloud;
}

export function isCloudManagedProvider(provider) {
  const spec = providerSpec(provider);
  return !spec.local && !spec.custom;
}

export function normalizeThinkingCapabilities(raw) {
  if (!raw || typeof raw !== 'object') return { supported: null, levels: ['default', 'off', 'low', 'medium', 'high'] };
  const supported = typeof raw.supported === 'boolean' ? raw.supported : null;
  if (supported === false) return { supported: false, levels: ['default'] };
  const rawLevels = Array.isArray(raw.levels) ? raw.levels.filter((level) => THINKING_LEVELS.includes(level)) : [];
  const levels = rawLevels.length
    ? ['default', ...rawLevels.filter((level) => level !== 'default')]
    : ['default', 'off', 'low', 'medium', 'high'];
  return { supported, levels: [...new Set(levels)] };
}

export function knownModelCapabilities(provider, modelId) {
  const id = String(modelId || '').toLowerCase();
  const leaf = id.split('/').pop().split(':')[0];
  let contextLength = 0;
  let maxOutputTokens = 0;
  let thinking = { supported: null, levels: ['default', 'off', 'low', 'medium', 'high'] };
  if (/^gpt-5/.test(leaf)) {
    contextLength = 400000;
    maxOutputTokens = 128000;
    thinking = { supported: true, levels: ['default', 'low', 'medium', 'high'] };
  } else if (/^gpt-4\.1/.test(leaf)) {
    contextLength = 1047576;
    maxOutputTokens = 32768;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^gpt-4o/.test(leaf)) {
    contextLength = 128000;
    maxOutputTokens = 16384;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^o[134](?:-|$)/.test(leaf)) {
    contextLength = 200000;
    maxOutputTokens = 100000;
    thinking = { supported: true, levels: ['default', 'low', 'medium', 'high'] };
  } else if (/^claude-(?:opus-4|sonnet-4|haiku-4|3-7-sonnet|3\.7-sonnet)/.test(leaf)) {
    contextLength = 200000;
    maxOutputTokens = 64000;
    thinking = { supported: true, levels: ['default', 'off', 'low', 'medium', 'high'] };
  } else if (/^claude-3-5|^claude-3\.5/.test(leaf)) {
    contextLength = 200000;
    maxOutputTokens = 8192;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^gemini-2\.5|^gemini-3/.test(leaf)) {
    contextLength = 1048576;
    maxOutputTokens = 65536;
    thinking = { supported: true, levels: ['default', 'off', 'low', 'medium', 'high'] };
  } else if (/^gemini-2\.0/.test(leaf)) {
    contextLength = 1048576;
    maxOutputTokens = 8192;
    thinking = { supported: /thinking/.test(leaf), levels: /thinking/.test(leaf) ? ['default', 'off', 'low', 'medium', 'high'] : ['default'] };
  } else if (/^deepseek-reasoner|^deepseek-r1/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 65536;
    thinking = { supported: true, levels: ['default'] };
  } else if (/^deepseek-chat|^deepseek-v3/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 8192;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^grok-4/.test(leaf)) {
    contextLength = 256000;
    maxOutputTokens = 64000;
    thinking = { supported: true, levels: ['default', 'low', 'medium', 'high'] };
  } else if (/^grok-3-mini/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 32768;
    thinking = { supported: true, levels: ['default', 'low', 'high'] };
  } else if (/^grok-3/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 32768;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^sonar-reasoning/.test(leaf)) {
    contextLength = 128000;
    maxOutputTokens = 8192;
    thinking = { supported: true, levels: ['default'] };
  } else if (/^sonar/.test(leaf)) {
    contextLength = 128000;
    maxOutputTokens = 8192;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^mistral-large|^mistral-small|^ministral|^codestral/.test(leaf)) {
    contextLength = /codestral/.test(leaf) ? 256000 : 128000;
    maxOutputTokens = 32768;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^llama-3\.[123]|^llama3\.[123]|^meta-llama-3\.[123]|^llama-v3p3/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 32768;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^qwen3|^qwq/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 32768;
    thinking = { supported: true, levels: ['default', 'off', 'on'] };
  } else if (/^qwen2\.5/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 8192;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^gpt-oss/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 32768;
    thinking = { supported: true, levels: ['default', 'low', 'medium', 'high'] };
  } else if (/^moonshot-v1-8k/.test(leaf)) {
    contextLength = 8192;
    maxOutputTokens = 8192;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^moonshot-v1-32k/.test(leaf)) {
    contextLength = 32768;
    maxOutputTokens = 32768;
    thinking = { supported: false, levels: ['default'] };
  } else if (/^kimi-k2/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 32768;
    thinking = { supported: /thinking/.test(leaf), levels: /thinking/.test(leaf) ? ['default', 'off', 'on'] : ['default'] };
  } else if (/^glm-4\.5|^glm-4-plus/.test(leaf)) {
    contextLength = 131072;
    maxOutputTokens = 65536;
    thinking = { supported: /^glm-4\.5/.test(leaf), levels: /^glm-4\.5/.test(leaf) ? ['default', 'off', 'on'] : ['default'] };
  }
  if (!contextLength && isCloudManagedProvider(provider)) contextLength = 128000;
  return { contextLength, maxOutputTokens, thinking };
}

export function resolveModelCapabilities(provider, modelId, apiMeta = null) {
  const fallback = knownModelCapabilities(provider, modelId);
  const apiContext = contextInt(apiMeta?.contextLength);
  const apiOutRaw = Math.floor(Number(apiMeta?.maxOutputTokens));
  const apiOutput = Number.isFinite(apiOutRaw) && apiOutRaw >= 256 ? Math.min(MAX_CONTEXT_LIMIT, apiOutRaw) : 0;
  const apiThinking = apiMeta?.thinking && typeof apiMeta.thinking.supported === 'boolean'
    ? normalizeThinkingCapabilities(apiMeta.thinking)
    : null;
  return {
    contextLength: apiContext || fallback.contextLength,
    maxOutputTokens: apiOutput || fallback.maxOutputTokens || 0,
    thinking: apiThinking || normalizeThinkingCapabilities(fallback.thinking),
  };
}

export function contextSteps(maxContext, maxStops = 7) {
  const top = Math.max(MIN_CONTEXT_LIMIT, Math.min(MAX_CONTEXT_LIMIT, Math.floor(Number(maxContext) || 262144)));
  const floor = top > 4096 ? 4000 : MIN_CONTEXT_LIMIT;
  const steps = [];
  let value = top;
  while (steps.length < maxStops && value >= MIN_CONTEXT_LIMIT) {
    steps.unshift(value);
    const half = Math.floor(value / 2);
    if (half < floor || half === value) break;
    value = half;
  }
  return steps;
}

export function formatContextLabel(tokens) {
  const value = Math.floor(Number(tokens) || 0);
  if (value <= 0) return 'Auto';
  if (value % 1024 === 0) {
    const k = value / 1024;
    if (k >= 1024 && k % 1024 === 0) return (k / 1024) + 'M';
    return k + 'k';
  }
  if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (value >= 1000) return Math.round(value / 1000) + 'k';
  return String(value);
}

export function effectiveContextWindow(profile, fallback = DEFAULT_LOCAL_CONTEXT) {
  if (!profile) return fallback;
  const known = knownModelCapabilities(profile.provider, profile.model).contextLength;
  const max = contextInt(profile.maxContext) || known;
  if (isCloudManagedProvider(profile.provider)) {
    return max || 128000;
  }
  const chosen = contextInt(profile.contextWindow);
  if (chosen) return max ? Math.min(chosen, max) : chosen;
  return max ? Math.min(fallback, max) : fallback;
}

export function defaultProfile(provider = 'cloud') {
  const spec = providerSpec(provider);
  const caps = knownModelCapabilities(PROVIDERS[provider] ? provider : 'cloud', spec.defaultModel);
  return {
    id: globalThis.crypto?.randomUUID?.() || 'llm-' + Date.now(),
    label: spec.label,
    name: '',
    provider: PROVIDERS[provider] ? provider : 'cloud',
    endpoint: spec.defaultEndpoint,
    model: spec.defaultModel,
    thinking: 'default',
    contextWindow: isCloudManagedProvider(provider) ? 0 : DEFAULT_LOCAL_CONTEXT,
    maxContext: caps.contextLength,
    maxOutputTokens: caps.maxOutputTokens || 0,
    thinkingCapabilities: caps.thinking,
    allowWebSearch: false,
    pricingMode: 'auto',
    pricing: { input: 0, output: 0, cacheRead: 0, webSearch: 0 },
    hasKey: false,
    keyHint: '',
    lastUsedAt: 0,
  };
}

export function defaultLlmConfig() {
  return { version: 1, activeProfileId: '', profiles: [] };
}

export function normalizeProfile(raw, index = 0) {
  const provider = raw && Object.hasOwn(PROVIDERS, raw.provider) ? raw.provider : 'cloud';
  const spec = PROVIDERS[provider];
  const model = text(raw?.model, 160) || spec.defaultModel;
  const cloudManaged = isCloudManagedProvider(provider);
  const known = knownModelCapabilities(provider, model);
  const maxContext = contextInt(raw?.maxContext) || known.contextLength;
  const rawMaxOut = Math.floor(Number(raw?.maxOutputTokens));
  const maxOutputTokens = (Number.isFinite(rawMaxOut) && rawMaxOut >= 256 ? Math.min(MAX_CONTEXT_LIMIT, rawMaxOut) : 0) || known.maxOutputTokens || 0;
  const rawContext = contextInt(raw?.contextWindow);
  const contextWindow = cloudManaged ? 0 : (rawContext ? (maxContext ? Math.min(rawContext, maxContext) : rawContext) : DEFAULT_LOCAL_CONTEXT);
  const thinkingCapabilities = raw?.thinkingCapabilities
    ? normalizeThinkingCapabilities(raw.thinkingCapabilities)
    : known.thinking;
  const thinking = THINKING_LEVELS.includes(raw?.thinking) && thinkingCapabilities.levels.includes(raw.thinking)
    ? raw.thinking : 'default';
  const pricing = {
    input: number(raw?.pricing?.input),
    output: number(raw?.pricing?.output),
    cacheRead: number(raw?.pricing?.cacheRead),
    webSearch: number(raw?.pricing?.webSearch),
  };
  const pricingMode = raw?.pricingMode === 'custom' ? 'custom'
    : raw?.pricingMode === 'auto' ? 'auto'
      : (pricing.input > 0 || pricing.output > 0 || pricing.cacheRead > 0 || pricing.webSearch > 0) ? 'custom' : 'auto';
  return {
    id: safeId(raw?.id) || (globalThis.crypto?.randomUUID?.() || 'llm-' + Date.now() + '-' + index),
    label: text(raw?.label, 60) || spec.label,
    name: text(raw?.name, 32),
    provider,
    endpoint: provider === 'ollama' ? spec.defaultEndpoint : (text(raw?.endpoint, 400) || spec.defaultEndpoint),
    model,
    thinking,
    contextWindow,
    maxContext,
    maxOutputTokens,
    thinkingCapabilities,
    allowWebSearch: raw?.allowWebSearch === true,
    pricingMode,
    pricing,
    hasKey: !!raw?.hasKey,
    keyHint: text(raw?.keyHint, 8),
    lastUsedAt: Number.isFinite(raw?.lastUsedAt) ? raw.lastUsedAt : 0,
  };
}

export function normalizeLlmConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : defaultLlmConfig();
  const profiles = Array.isArray(source.profiles) && source.profiles.length
    ? source.profiles.slice(0, 50).map(normalizeProfile)
    : [];
  let activeProfileId = safeId(source.activeProfileId);
  if (!profiles.length) activeProfileId = '';
  else if (!profiles.some((profile) => profile.id === activeProfileId)) activeProfileId = profiles[0].id;
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

export function isLoopback(url) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export function endpointUrl(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Enter a valid provider base URL.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url))) {
    throw new Error('Use HTTPS for provider endpoints. HTTP is allowed on loopback only.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Enter a base URL without credentials, query parameters, or a fragment.');
  }
  return url;
}

export function canonicalEndpoint(endpoint) {
  const url = endpointUrl(endpoint);
  return url.origin + url.pathname.replace(/\/+$/, '');
}

export function profileDestination(profile) {
  return JSON.stringify([profile.id, profile.provider, canonicalEndpoint(profile.endpoint), profile.model]);
}

export function modelApprovalKey(profile) {
  return JSON.stringify([profile.provider, canonicalEndpoint(profile.endpoint), profile.model]);
}

function trimBase(endpoint) {
  try { return canonicalEndpoint(endpoint); } catch { return ''; }
}

function resolvedBase(profile, spec) {
  const raw = text(profile?.endpoint, 400);
  if (raw) return trimBase(raw);
  return spec.defaultEndpoint;
}

export function chatEndpoint(profile) {
  const spec = providerSpecFor(profile);
  const base = resolvedBase(profile, spec);
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
  const base = resolvedBase(profile, spec);
  if (!base) return '';
  if (/\/models$/i.test(base) || /\/api\/tags$/i.test(base)) return base;
  if (/\/chat\/completions$/i.test(base)) return base.replace(/\/chat\/completions$/i, '/models');
  if (/\/api\/chat$/i.test(base)) return base.replace(/\/api\/chat$/i, '/api/tags');
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
    return endpointUrl(profile.endpoint).origin + '/*';
  } catch {
    return '';
  }
}

export function providerOrigin(profile) {
  try {
    return endpointUrl(profile.endpoint).origin;
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
  if (level === 'on') return 'medium';
  if (level === 'off') return 'none';
  return '';
}
