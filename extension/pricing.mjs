// Automatic cloud model pricing catalog (LiteLLM pruned registry + OpenRouter live rates
// + compact offline snapshot) and prompt cost calculation.

export const LITELLM_PRICING_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
export const PRICING_TTL_MS = 60 * 60 * 1000; // 1 hour on-demand refresh when sending prompts
export const PRICING_STORAGE_KEY = 'pricingCatalog';

const ALLOWED_LITELLM_PROVIDERS = new Set([
  'openai', 'anthropic', 'gemini', 'openrouter', 'deepseek', 'groq', 'mistral', 'xai',
  'together_ai', 'fireworks_ai', 'cerebras', 'sambanova', 'nebius', 'perplexity', 'moonshot', 'zai',
]);

const PROVIDER_PREFIXES = Object.freeze({
  openai: ['openai/', ''],
  anthropic: ['anthropic/', ''],
  gemini: ['gemini/', 'google/', ''],
  openrouter: ['openrouter/', ''],
  deepseek: ['deepseek/', ''],
  groq: ['groq/', ''],
  mistral: ['mistral/', ''],
  xai: ['xai/', 'x-ai/', ''],
  together: ['together_ai/', 'together/', ''],
  fireworks: ['fireworks_ai/', 'fireworks/', ''],
  cerebras: ['cerebras/', ''],
  sambanova: ['sambanova/', ''],
  nebius: ['nebius/', ''],
  perplexity: ['perplexity/', ''],
  moonshot: ['moonshot/', ''],
  zai: ['zai/', ''],
  cloud: ['', 'openai/', 'openrouter/'],
});

const posNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function pruneLiteLlmCatalog(raw) {
  const models = Object.create(null);
  if (!raw || typeof raw !== 'object') return models;
  for (const [key, row] of Object.entries(raw)) {
    if (!row || typeof row !== 'object' || key === 'sample_spec') continue;
    if (row.mode && row.mode !== 'chat' && row.mode !== 'responses') continue;
    const lp = String(row.litellm_provider || '').toLowerCase();
    if (!ALLOWED_LITELLM_PROVIDERS.has(lp)) continue;
    const i = posNum(row.input_cost_per_token);
    const o = posNum(row.output_cost_per_token);
    const cr = posNum(row.cache_read_input_token_cost ?? row.input_cost_per_token_cache_hit);
    const cw = posNum(row.cache_creation_input_token_cost);
    const i200 = posNum(row.input_cost_per_token_above_200k_tokens);
    const o200 = posNum(row.output_cost_per_token_above_200k_tokens);
    const srRaw = row.search_context_cost_per_query;
    const sr = posNum(typeof srRaw === 'object' && srRaw
      ? (srRaw.search_context_size_medium ?? srRaw.search_context_size_low ?? srRaw.search_context_size_high)
      : srRaw);
    const mi = Math.floor(Number(row.max_input_tokens || row.max_tokens || 0)) || 0;
    const mo = Math.floor(Number(row.max_output_tokens || 0)) || 0;
    if (!i && !o && mi < 1024 && mo < 256) continue;
    const entry = {};
    if (i) entry.i = i;
    if (o) entry.o = o;
    if (cr) entry.cr = cr;
    if (cw) entry.cw = cw;
    if (i200) entry.i200 = i200;
    if (o200) entry.o200 = o200;
    if (sr) entry.sr = sr;
    if (mi >= 1024) entry.mi = mi;
    if (mo >= 256) entry.mo = mo;
    if (row.supports_web_search) entry.ws = 1;
    if (row.supports_reasoning) entry.rs = 1;
    models[key] = entry;
  }
  return models;
}

export function extractOpenRouterPricing(row) {
  if (!row || typeof row !== 'object') return null;
  const p = row.pricing && typeof row.pricing === 'object' ? row.pricing : null;
  const i = posNum(p?.prompt);
  const o = posNum(p?.completion);
  const cr = posNum(p?.input_cache_read);
  const cw = posNum(p?.input_cache_write);
  const sr = posNum(p?.web_search);
  const mi = Math.floor(Number(row.context_length || row.top_provider?.context_length || 0)) || 0;
  const mo = Math.floor(Number(row.top_provider?.max_completion_tokens || 0)) || 0;
  // OpenRouter uses "-1" for dynamic auto-routers; posNum filters <= 0.
  if (!i && !o && mi < 1024 && mo < 256) return null;
  const entry = {};
  if (i) entry.i = i;
  if (o) entry.o = o;
  if (cr) entry.cr = cr;
  if (cw) entry.cw = cw;
  if (sr) entry.sr = sr;
  if (mi >= 1024) entry.mi = mi;
  if (mo >= 256) entry.mo = mo;
  return entry;
}

function candidateKeys(provider, modelId) {
  const clean = String(modelId || '').trim().replace(/^models\//i, '');
  if (!clean) return [];
  const lower = clean.toLowerCase();
  const prefixes = PROVIDER_PREFIXES[provider] || [''];
  const bases = [clean];
  if (lower !== clean) bases.push(lower);
  // Strip :free / :online / :thinking / :exacto OpenRouter variants for base lookup.
  const noTag = clean.replace(/:[a-z0-9_-]+$/i, '');
  if (noTag !== clean) {
    bases.push(noTag);
    if (noTag.toLowerCase() !== noTag) bases.push(noTag.toLowerCase());
  }
  // Strip trailing dated snapshots like -2025-04-14 or -20250514 as fallback.
  const noDate = noTag.replace(/-(?:20\d{2}-\d{2}-\d{2}|20\d{6}|\d{4})$/, '');
  if (noDate !== noTag && noDate.length >= 3) {
    bases.push(noDate);
    if (noDate.toLowerCase() !== noDate) bases.push(noDate.toLowerCase());
  }
  const leaf = noTag.includes('/') ? noTag.split('/').pop() : '';
  if (leaf) {
    bases.push(leaf);
    if (leaf.toLowerCase() !== leaf) bases.push(leaf.toLowerCase());
  }

  const keys = [];
  const seen = new Set();
  const push = (k) => {
    if (k && !seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  };
  for (const base of bases) {
    for (const prefix of prefixes) {
      if (prefix && base.toLowerCase().startsWith(prefix)) push(base);
      else push(prefix + base);
    }
  }
  // Cross-provider fallback for OpenRouter / custom OpenAI-compatible endpoints.
  for (const base of bases) {
    push(base);
    push('openrouter/' + base);
  }
  return keys;
}

function findInModels(models, provider, modelId) {
  if (!models || typeof models !== 'object') return null;
  const candidates = candidateKeys(provider, modelId);
  for (const k of candidates) {
    if (Object.hasOwn(models, k)) return { key: k, entry: models[k] };
  }
  // Case-insensitive exact fallback on pruned map.
  const wanted = new Set(candidates.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(models)) {
    if (wanted.has(k.toLowerCase())) return { key: k, entry: v };
  }
  return null;
}

export function normalizePricingEntry(entry, meta = {}) {
  if (!entry || typeof entry !== 'object') return null;
  return {
    inputPerToken: posNum(entry.i ?? entry.inputPerToken),
    outputPerToken: posNum(entry.o ?? entry.outputPerToken),
    cacheReadPerToken: posNum(entry.cr ?? entry.cacheReadPerToken),
    cacheWritePerToken: posNum(entry.cw ?? entry.cacheWritePerToken),
    inputAbove200kPerToken: posNum(entry.i200 ?? entry.inputAbove200kPerToken),
    outputAbove200kPerToken: posNum(entry.o200 ?? entry.outputAbove200kPerToken),
    webSearchPerQuery: posNum(entry.sr ?? entry.webSearchPerQuery),
    maxInputTokens: Math.floor(Number(entry.mi ?? entry.maxInputTokens ?? 0)) || 0,
    maxOutputTokens: Math.floor(Number(entry.mo ?? entry.maxOutputTokens ?? 0)) || 0,
    supportsWebSearch: !!(entry.ws || entry.supportsWebSearch),
    supportsReasoning: !!(entry.rs || entry.supportsReasoning),
    matchedKey: meta.key || entry.matchedKey || '',
    source: meta.source || entry.source || 'litellm',
    fetchedAt: Number(meta.fetchedAt ?? entry.fetchedAt ?? 0) || 0,
  };
}

export function lookupModelPricing(provider, modelId, catalog = null, snapshot = null, openRouterOverrides = null) {
  if (!modelId) return null;
  // For OpenRouter, prefer live OpenRouter rates captured from /api/v1/models when available.
  if (provider === 'openrouter' && openRouterOverrides) {
    const hit = findInModels(openRouterOverrides, provider, modelId);
    if (hit) {
      return normalizePricingEntry(hit.entry, {
        key: hit.key,
        source: 'openrouter',
        fetchedAt: catalog?.openRouterFetchedAt || catalog?.fetchedAt || Date.now(),
      });
    }
  }
  if (catalog?.models) {
    const hit = findInModels(catalog.models, provider, modelId);
    if (hit) {
      return normalizePricingEntry(hit.entry, {
        key: hit.key,
        source: catalog.source || 'litellm',
        fetchedAt: catalog.fetchedAt || 0,
      });
    }
  }
  if (snapshot?.models) {
    const hit = findInModels(snapshot.models, provider, modelId);
    if (hit) {
      return normalizePricingEntry(hit.entry, {
        key: hit.key,
        source: 'snapshot',
        fetchedAt: Date.parse(snapshot.generatedAt || '') || 0,
      });
    }
  }
  return null;
}

export function ratesForProfile(profile, catalogEntry = null) {
  if (!profile) return null;
  const mode = profile.pricingMode === 'custom' ? 'custom' : 'auto';
  if (mode === 'custom') {
    const p = profile.pricing || {};
    const inputPerToken = posNum(p.input) / 1e6;
    const outputPerToken = posNum(p.output) / 1e6;
    const cacheReadPerToken = posNum(p.cacheRead) / 1e6;
    const webSearchPerQuery = posNum(p.webSearch) / 1e3;
    if (!inputPerToken && !outputPerToken && !cacheReadPerToken && !webSearchPerQuery) return null;
    return {
      mode: 'custom',
      source: 'custom',
      fetchedAt: 0,
      inputPerToken,
      outputPerToken,
      cacheReadPerToken,
      cacheWritePerToken: 0,
      inputAbove200kPerToken: 0,
      outputAbove200kPerToken: 0,
      webSearchPerQuery,
    };
  }
  if (!catalogEntry) return null;
  if (!catalogEntry.inputPerToken && !catalogEntry.outputPerToken && !catalogEntry.webSearchPerQuery) return null;
  return { mode: 'auto', ...catalogEntry };
}

export function estimatePromptCost({ profile, usage = {}, webSearchCount = 0, catalogEntry = null } = {}) {
  const reportedCost = posNum(usage?.cost ?? usage?.total_cost);
  const rates = ratesForProfile(profile, catalogEntry);

  const promptTokens = Math.max(0, Math.floor(Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0)) || 0);
  const outputTokens = Math.max(0, Math.floor(Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0)) || 0);
  const cacheReadTokens = Math.max(0, Math.floor(Number(
    usage?.prompt_tokens_details?.cached_tokens
    ?? usage?.cache_read_input_tokens
    ?? usage?.prompt_cache_hit_tokens
    ?? 0,
  )) || 0);
  const cacheWriteTokens = Math.max(0, Math.floor(Number(
    usage?.cache_creation_input_tokens
    ?? usage?.prompt_tokens_details?.cache_write_tokens
    ?? 0,
  )) || 0);
  const searchUnits = Math.max(0, Math.floor(Number(webSearchCount || usage?.num_sources_used || 0)) || 0);

  // If provider reports exact billed cost (e.g. OpenRouter) and user is not overriding manually:
  if (reportedCost > 0 && profile?.pricingMode !== 'custom') {
    return {
      total: reportedCost,
      inputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      outputCost: 0,
      searchCost: 0,
      source: 'provider',
      mode: 'provider',
      detail: 'Reported directly by provider',
    };
  }
  if (!rates) return null;

  const over200k = promptTokens > 200000;
  const inRate = (over200k && rates.inputAbove200kPerToken) ? rates.inputAbove200kPerToken : rates.inputPerToken;
  const outRate = (over200k && rates.outputAbove200kPerToken) ? rates.outputAbove200kPerToken : rates.outputPerToken;
  const regularInputTokens = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);

  const inputCost = regularInputTokens * inRate;
  const cacheReadCost = cacheReadTokens > 0 && rates.cacheReadPerToken
    ? cacheReadTokens * rates.cacheReadPerToken
    : (cacheReadTokens > 0 ? cacheReadTokens * inRate : 0);
  const cacheWriteCost = cacheWriteTokens > 0 && rates.cacheWritePerToken
    ? cacheWriteTokens * rates.cacheWritePerToken
    : 0;
  const outputCost = outputTokens * outRate;
  // Only apply search surcharge if web search was actually used.
  const searchCost = searchUnits > 0 && rates.webSearchPerQuery
    ? (searchUnits > 0 ? rates.webSearchPerQuery : 0)
    : 0;
  const total = inputCost + cacheReadCost + cacheWriteCost + outputCost + searchCost;

  const parts = [];
  if (inputCost > 0) parts.push('Input ' + formatMoney(inputCost));
  if (cacheReadTokens > 0 && cacheReadCost > 0) parts.push('Cache hit ' + formatMoney(cacheReadCost));
  if (cacheWriteTokens > 0 && cacheWriteCost > 0) parts.push('Cache write ' + formatMoney(cacheWriteCost));
  if (outputCost > 0) parts.push('Output ' + formatMoney(outputCost));
  if (searchCost > 0) parts.push('Web search ' + formatMoney(searchCost));
  const suffix = rates.mode === 'custom' ? ' (custom)' : ' (auto)';
  return {
    total,
    inputCost,
    cacheReadCost,
    cacheWriteCost,
    outputCost,
    searchCost,
    source: rates.source,
    mode: rates.mode,
    detail: (parts.length ? parts.join(' · ') : 'Estimated from rates') + suffix,
  };
}

export function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.0001) return '<$0.0001';
  const digits = n >= 0.01 ? 4 : 6;
  return '$' + n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatRatePerMillion(perToken) {
  const n = posNum(perToken) * 1e6;
  if (!n) return '';
  const digits = n >= 1 ? 2 : n >= 0.01 ? 3 : 4;
  return '$' + n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '') + ' / 1M';
}

export function formatRatePerThousand(perQuery) {
  const n = posNum(perQuery) * 1e3;
  if (!n) return '';
  const digits = n >= 1 ? 2 : 3;
  return '$' + n.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '') + ' / 1k';
}

export function formatRefreshAge(fetchedAt, now = Date.now()) {
  const ts = Number(fetchedAt) || 0;
  if (!ts) return 'offline snapshot';
  const mins = Math.max(0, Math.floor((now - ts) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 48) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

// ------------------------------------------------------------------ Background worker catalog cache
let cachedSnapshot = null;
let inflightRefresh = null;

export async function loadOfflineSnapshot() {
  if (cachedSnapshot) return cachedSnapshot;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      const res = await fetch(chrome.runtime.getURL('pricing-snapshot.json'));
      if (res.ok) {
        cachedSnapshot = await res.json();
        return cachedSnapshot;
      }
    }
  } catch {}
  return null;
}

async function readStoredCatalog() {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return null;
    const stored = await chrome.storage.local.get(PRICING_STORAGE_KEY);
    const cat = stored?.[PRICING_STORAGE_KEY];
    return cat && typeof cat === 'object' ? cat : null;
  } catch {
    return null;
  }
}

async function writeStoredCatalog(catalog) {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [PRICING_STORAGE_KEY]: catalog });
    }
  } catch {}
}

export async function mergeOpenRouterPricing(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return;
  const overrides = Object.create(null);
  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (!id) continue;
    const entry = extractOpenRouterPricing(row);
    if (entry) overrides[id] = entry;
  }
  if (!Object.keys(overrides).length) return;
  const existing = (await readStoredCatalog()) || { fetchedAt: 0, source: 'litellm', models: {} };
  await writeStoredCatalog({
    ...existing,
    openRouterModels: overrides,
    openRouterFetchedAt: Date.now(),
  });
}

async function fetchLiveLiteLlmCatalog(existing = null) {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    const res = await fetch(LITELLM_PRICING_URL, {
      credentials: 'omit',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('LiteLLM pricing HTTP ' + res.status);
    const raw = await res.json();
    const models = pruneLiteLlmCatalog(raw);
    const catalog = {
      fetchedAt: Date.now(),
      source: 'litellm',
      models,
      ...(existing?.openRouterModels ? {
        openRouterModels: existing.openRouterModels,
        openRouterFetchedAt: existing.openRouterFetchedAt || 0,
      } : {}),
    };
    await writeStoredCatalog(catalog);
    return catalog;
  })().finally(() => {
    inflightRefresh = null;
  });
  return inflightRefresh;
}

export async function ensurePricingCatalog({ force = false, maxAgeMs = PRICING_TTL_MS } = {}) {
  const existing = await readStoredCatalog();
  const age = existing?.fetchedAt ? (Date.now() - existing.fetchedAt) : Infinity;
  const stale = force || !existing?.models || !Object.keys(existing.models).length || age > maxAgeMs;
  if (!stale) return { catalog: existing, refreshed: false, error: '' };
  try {
    const fresh = await fetchLiveLiteLlmCatalog(existing);
    return { catalog: fresh, refreshed: true, error: '' };
  } catch (err) {
    const snapshot = await loadOfflineSnapshot();
    return {
      catalog: existing || (snapshot ? { fetchedAt: 0, source: 'snapshot', models: snapshot.models } : null),
      refreshed: false,
      error: String(err?.message || err),
    };
  }
}

export async function lookupPricingInWorker({ provider, model, force = false, maxAgeMs = PRICING_TTL_MS } = {}) {
  const [{ catalog, refreshed, error }, snapshot] = await Promise.all([
    ensurePricingCatalog({ force, maxAgeMs }),
    loadOfflineSnapshot(),
  ]);
  const entry = lookupModelPricing(provider, model, catalog, snapshot, catalog?.openRouterModels || null);
  return {
    entry,
    fetchedAt: entry?.fetchedAt || catalog?.fetchedAt || 0,
    source: entry?.source || catalog?.source || (snapshot ? 'snapshot' : ''),
    refreshed,
    error,
  };
}
