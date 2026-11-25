// Dynamic response-driven telemetry collector for Ask (both cloud and local LLMs).
// Captures canonical metrics AND dynamically discovers any extra scalar fields returned
// by providers so unexpected telemetry (e.g. cloud tok/s, queue time, audio tokens) is never lost.

import { estimatePromptCost, formatMoney } from './pricing.mjs';
import { formatContextLabel, providerSpecFor } from './llm-config.mjs';

function fmtCompactTokens(n) {
  const v = Math.floor(Number(n) || 0);
  if (v >= 1000000) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (v >= 10000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return v.toLocaleString();
}

function fmtSeconds(sec) {
  const v = Number(sec);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 0.01) return Math.round(v * 1000) + ' ms';
  if (v < 10) return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') + ' s';
  return v.toFixed(1).replace(/\.0$/, '') + ' s';
}

function safeWebUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.href;
  } catch {
    return '';
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ''); } catch { return ''; }
}

function humanizeKey(key) {
  const clean = String(key || '')
    .replace(/^(prompt_tokens_details|completion_tokens_details|input_tokens_details|output_tokens_details)\./i, '')
    .replace(/[._-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  if (!clean) return 'Metric';
  return clean[0].toUpperCase() + clean.slice(1);
}

function formatDynamicValue(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'string') return value.trim().slice(0, 60);
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  const k = key.toLowerCase();
  if (k.endsWith('_duration') && n >= 1e5) return fmtSeconds(n / 1e9);
  if (k.endsWith('_ms') || k.endsWith('ms')) return fmtSeconds(n / 1000);
  if (k.endsWith('_time') || k.endsWith('_seconds') || k.endsWith('_sec')) return fmtSeconds(n);
  if (k.includes('per_second') || k.includes('tok_s') || k.includes('tokens_per_s')) return n.toFixed(1) + ' tok/s';
  if (k.includes('cost') || k.includes('price') || k.includes('usd')) return formatMoney(n);
  if (Number.isInteger(n)) return n.toLocaleString();
  return Number(n.toFixed(3)).toString();
}

// Keys already represented by canonical structured items (or non-telemetry structural fields).
const HANDLED_KEYS = new Set([
  'prompt_tokens', 'input_tokens', 'completion_tokens', 'output_tokens', 'total_tokens',
  'prompt_eval_count', 'eval_count', 'prompt_eval_duration', 'eval_duration', 'total_duration',
  'load_duration', 'done', 'done_reason', 'model', 'created_at', 'message', 'choices', 'id',
  'object', 'created', 'context', 'finish_reason', 'service_tier', 'system_fingerprint',
  'cost', 'total_cost', 'num_sources_used',
  'cache_read_input_tokens', 'cache_creation_input_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens',
  'prompt_tokens_details.cached_tokens', 'prompt_tokens_details.cache_write_tokens',
  'completion_tokens_details.reasoning_tokens', 'output_tokens_details.reasoning_tokens',
  'reasoning_tokens',
  'prompt_time', 'completion_time', 'total_time', 'queue_time',
  'predicted_per_second', 'tokens_per_second', 'prompt_ms', 'predicted_ms',
  'predicted_n', 'prompt_n', 'cache_n',
]);

export function normalizeSourcesAndTools(raw = {}) {
  const queries = [];
  const querySet = new Set();
  const addQuery = (q) => {
    const clean = String(q || '').trim().slice(0, 200);
    if (clean && !querySet.has(clean.toLowerCase())) {
      querySet.add(clean.toLowerCase());
      queries.push(clean);
    }
  };

  const sources = [];
  const urlSet = new Set();
  const addSource = (rawUrl, rawTitle = '') => {
    const url = safeWebUrl(rawUrl);
    if (!url || urlSet.has(url)) return;
    urlSet.add(url);
    const host = hostOf(url);
    const title = String(rawTitle || '').trim().slice(0, 140) || host || url;
    sources.push({ url, title, host });
  };

  const tools = [];
  const toolSet = new Set();
  const addTool = (name) => {
    const clean = String(name || '').trim().slice(0, 80);
    if (clean && !toolSet.has(clean.toLowerCase())) {
      toolSet.add(clean.toLowerCase());
      tools.push(clean);
    }
  };

  for (const q of raw.queries || []) addQuery(q);
  for (const s of raw.sources || []) {
    if (typeof s === 'string') addSource(s);
    else if (s && typeof s === 'object') addSource(s.url || s.uri || s.link, s.title || s.name);
  }
  for (const t of raw.tools || []) addTool(t);

  const webSearchUsed = !!(raw.webSearchUsed || queries.length || sources.length
    || tools.some((t) => /search|web|browse/i.test(t)));

  return {
    webSearchUsed,
    queries: queries.slice(0, 12),
    sources: sources.slice(0, 20),
    tools: tools.slice(0, 16),
  };
}

export function buildTelemetryReport({
  profile = null,
  response = null,
  contextWindow = 0,
  resident = null,
  pricingEntry = null,
  allowWebSearch = false,
} = {}) {
  if (!response) return { model: profile?.model || '', items: [] };

  const spec = providerSpecFor(profile);
  const rawUsage = (response.rawUsage && typeof response.rawUsage === 'object')
    ? response.rawUsage
    : (response.usage && typeof response.usage === 'object' ? response.usage : {});
  const rawMetrics = (response.metrics && typeof response.metrics === 'object') ? response.metrics : {};
  const rawTimings = (response.rawTimings && typeof response.rawTimings === 'object') ? response.rawTimings : {};

  const items = [];
  const push = (item) => {
    if (item && item.key && item.value !== '' && item.value !== undefined && item.value !== null) {
      items.push(item);
    }
  };

  const modelId = String(response.model || rawMetrics.model || profile?.model || '').trim();
  if (modelId) {
    const shortModel = modelId.includes('/') ? modelId.split('/').pop() : modelId;
    push({ key: 'model', label: 'Model', shortLabel: 'Model', value: modelId, shortValue: shortModel });
  }

  const promptTokens = Number(rawUsage.prompt_tokens ?? rawUsage.input_tokens ?? rawMetrics.prompt_eval_count) || 0;
  const outputTokens = Number(rawUsage.completion_tokens ?? rawUsage.output_tokens ?? rawMetrics.eval_count) || 0;
  const maxCtx = Math.floor(Number(resident?.context_length || contextWindow || 0)) || 0;

  if (maxCtx > 0 || promptTokens > 0) {
    const pct = maxCtx > 0 && promptTokens > 0 ? Math.min(100, Math.round((promptTokens / maxCtx) * 100)) : null;
    const sentStr = promptTokens > 0 ? fmtCompactTokens(promptTokens) : '—';
    const availStr = maxCtx > 0 ? formatContextLabel(maxCtx) : '—';
    push({
      key: 'context',
      label: 'Context window',
      shortLabel: 'Context',
      value: maxCtx > 0 && promptTokens > 0
        ? `${sentStr} / ${availStr} (${pct}%)`
        : maxCtx > 0 ? availStr : sentStr,
      shortValue: maxCtx > 0 && promptTokens > 0 ? `${sentStr} / ${availStr}` : availStr,
    });
  }

  // Local Ollama VRAM (only when reported by /api/ps)
  if (Number.isFinite(resident?.size_vram) && resident.size_vram > 0) {
    const vramGiB = (resident.size_vram / 1073741824).toFixed(1);
    const totalGiB = resident.size > 0 ? (resident.size / 1073741824).toFixed(1) : '';
    const pct = resident.size > 0 ? Math.round((resident.size_vram / resident.size) * 100) : null;
    push({
      key: 'vram',
      label: 'GPU VRAM',
      shortLabel: 'VRAM',
      value: totalGiB ? `${vramGiB} / ${totalGiB} GiB${pct !== null ? ` (${pct}%)` : ''}` : `${vramGiB} GiB`,
      shortValue: `${vramGiB} GiB`,
    });
  }

  if (promptTokens > 0) {
    push({
      key: 'input_tokens',
      label: 'Input tokens',
      shortLabel: 'Input',
      value: promptTokens.toLocaleString(),
      shortValue: fmtCompactTokens(promptTokens),
    });
  }

  const cacheRead = Number(
    rawUsage.prompt_tokens_details?.cached_tokens
    ?? rawUsage.cache_read_input_tokens
    ?? rawUsage.prompt_cache_hit_tokens
    ?? rawTimings.cache_n
    ?? 0,
  ) || 0;
  if (cacheRead > 0) {
    const pct = promptTokens > 0 ? ` (${Math.round((cacheRead / promptTokens) * 100)}%)` : '';
    push({
      key: 'cache_read',
      label: 'Prompt cache hit',
      shortLabel: 'Cache hit',
      value: cacheRead.toLocaleString() + pct,
      shortValue: fmtCompactTokens(cacheRead) + pct,
      tone: 'accent',
    });
  }

  const cacheWrite = Number(
    rawUsage.cache_creation_input_tokens
    ?? rawUsage.prompt_tokens_details?.cache_write_tokens
    ?? 0,
  ) || 0;
  if (cacheWrite > 0) {
    push({
      key: 'cache_write',
      label: 'Prompt cache write',
      shortLabel: 'Cache write',
      value: cacheWrite.toLocaleString(),
      shortValue: fmtCompactTokens(cacheWrite),
    });
  }

  if (outputTokens > 0) {
    const maxOut = Number(pricingEntry?.maxOutputTokens || profile?.maxOutputTokens || 0) || 0;
    push({
      key: 'output_tokens',
      label: 'Output tokens',
      shortLabel: 'Output',
      value: maxOut > 0 ? `${outputTokens.toLocaleString()} / ${formatContextLabel(maxOut)} max` : outputTokens.toLocaleString(),
      shortValue: fmtCompactTokens(outputTokens),
    });
  }

  const reasoningTokens = Number(
    rawUsage.completion_tokens_details?.reasoning_tokens
    ?? rawUsage.output_tokens_details?.reasoning_tokens
    ?? rawUsage.reasoning_tokens
    ?? 0,
  ) || 0;
  if (reasoningTokens > 0) {
    push({
      key: 'reasoning_tokens',
      label: 'Reasoning tokens',
      shortLabel: 'Reasoning',
      value: reasoningTokens.toLocaleString(),
      shortValue: fmtCompactTokens(reasoningTokens),
    });
  }

  // Tools & web search info from actual response
  const toolsData = normalizeSourcesAndTools(response.toolsInfo || {});
  const searchCount = toolsData.queries.length || Number(rawUsage.num_sources_used) || (toolsData.webSearchUsed ? 1 : 0);

  // Cloud cost estimation (only for non-local providers)
  if (profile && !spec.local) {
    const costInfo = estimatePromptCost({
      profile,
      usage: { ...rawUsage, prompt_tokens: promptTokens, completion_tokens: outputTokens },
      webSearchCount: toolsData.webSearchUsed ? searchCount : 0,
      catalogEntry: pricingEntry,
    });
    if (costInfo) {
      const formatted = formatMoney(costInfo.total);
      push({
        key: 'cost',
        label: 'Est. prompt cost',
        shortLabel: 'Cost',
        value: formatted,
        shortValue: formatted,
        tone: 'accent',
        detail: costInfo.detail,
      });
    }
  }

  // Generation speed (Ollama eval_duration, llama.cpp timings, Groq completion_time, or provider tok/s)
  let tokPerSec = 0;
  if (rawMetrics.eval_duration > 0 && rawMetrics.eval_count > 0) {
    tokPerSec = (rawMetrics.eval_count * 1e9) / rawMetrics.eval_duration;
  } else if (Number(rawTimings.predicted_per_second) > 0) {
    tokPerSec = Number(rawTimings.predicted_per_second);
  } else if (Number(rawUsage.tokens_per_second) > 0) {
    tokPerSec = Number(rawUsage.tokens_per_second);
  } else if (Number(rawUsage.completion_time) > 0 && outputTokens > 0) {
    tokPerSec = outputTokens / Number(rawUsage.completion_time);
  }
  if (tokPerSec > 0) {
    const s = tokPerSec.toFixed(1) + ' tok/s';
    push({ key: 'speed', label: 'Generation speed', shortLabel: 'Speed', value: s, shortValue: s, tone: 'accent' });
  }

  // Prompt eval time (Ollama, llama.cpp, Groq, or any provider returning prompt_time)
  let promptSec = 0;
  if (rawMetrics.prompt_eval_duration > 0) promptSec = rawMetrics.prompt_eval_duration / 1e9;
  else if (Number(rawUsage.prompt_time) > 0) promptSec = Number(rawUsage.prompt_time);
  else if (Number(rawTimings.prompt_ms) > 0) promptSec = Number(rawTimings.prompt_ms) / 1000;
  if (promptSec > 0) {
    const s = fmtSeconds(promptSec);
    push({ key: 'prompt_time', label: 'Prompt eval time', shortLabel: 'Prompt', value: s, shortValue: s });
  }

  // Model load duration (Ollama)
  if (rawMetrics.load_duration > 0) {
    const s = fmtSeconds(rawMetrics.load_duration / 1e9);
    push({ key: 'load_time', label: 'Model load time', shortLabel: 'Load', value: s, shortValue: s });
  }

  // Queue time (Groq / cloud queues)
  if (Number(rawUsage.queue_time) > 0) {
    const s = fmtSeconds(Number(rawUsage.queue_time));
    push({ key: 'queue_time', label: 'Queue time', shortLabel: 'Queue', value: s, shortValue: s });
  }

  // Total duration (Ollama / Groq / provider total_time)
  let totalSec = 0;
  if (rawMetrics.total_duration > 0) totalSec = rawMetrics.total_duration / 1e9;
  else if (Number(rawUsage.total_time) > 0) totalSec = Number(rawUsage.total_time);
  else if (Number(rawTimings.predicted_ms) > 0 && Number(rawTimings.prompt_ms) >= 0) {
    totalSec = (Number(rawTimings.predicted_ms) + Number(rawTimings.prompt_ms)) / 1000;
  }
  if (totalSec > 0) {
    const s = fmtSeconds(totalSec);
    push({ key: 'total_time', label: 'Total time', shortLabel: 'Total', value: s, shortValue: s });
  }

  // Web search / tools rows (only when used, or when search-capable provider ran with search enabled/disabled)
  if (toolsData.webSearchUsed) {
    const qSuffix = toolsData.queries.length ? ` (${toolsData.queries.length} ${toolsData.queries.length === 1 ? 'query' : 'queries'})` : '';
    push({
      key: 'web_search',
      label: 'Web search',
      shortLabel: 'Search',
      value: 'Used' + qSuffix,
      shortValue: toolsData.queries.length ? `Used · ${toolsData.queries.length}` : 'Used',
      tone: 'accent',
    });
  } else if (spec.webSearchCapable || pricingEntry?.supportsWebSearch) {
    push({
      key: 'web_search',
      label: 'Web search',
      shortLabel: 'Search',
      value: allowWebSearch ? 'Not used' : 'Off',
      shortValue: allowWebSearch ? 'Not used' : 'Off',
      tone: 'muted',
    });
  }

  if (toolsData.tools.length) {
    const list = toolsData.tools.join(', ');
    push({
      key: 'tools_called',
      label: 'Tools called',
      shortLabel: 'Tools',
      value: list,
      shortValue: toolsData.tools.length > 1 ? `${toolsData.tools[0]} +${toolsData.tools.length - 1}` : toolsData.tools[0],
    });
  }

  if (toolsData.sources.length || toolsData.queries.length) {
    const countLabel = toolsData.sources.length
      ? `${toolsData.sources.length} ${toolsData.sources.length === 1 ? 'link' : 'links'}`
      : `${toolsData.queries.length} ${toolsData.queries.length === 1 ? 'query' : 'queries'}`;
    push({
      key: 'web_sources',
      label: 'Web searches & links',
      shortLabel: 'Sources',
      value: countLabel,
      shortValue: countLabel,
      tone: 'accent',
      queries: toolsData.queries,
      sources: toolsData.sources,
    });
  }

  if (typeof response.serviceTier === 'string' && response.serviceTier.trim()) {
    push({
      key: 'service_tier',
      label: 'Service tier',
      shortLabel: 'Tier',
      value: response.serviceTier.trim(),
      shortValue: response.serviceTier.trim(),
      tone: 'muted',
    });
  }

  const finish = String(response.finish || rawMetrics.done_reason || '').trim();
  if (finish) {
    push({ key: 'finish_reason', label: 'Finish reason', shortLabel: 'Finish', value: finish, shortValue: finish, tone: 'muted' });
  }

  // Dynamic capture of ANY unexpected/extra scalar telemetry fields from usage/timings/metrics!
  const extraSources = [
    { obj: rawUsage, prefix: '' },
    { obj: rawTimings, prefix: '' },
    { obj: rawMetrics, prefix: '' },
  ];
  const seenExtra = new Set();
  let extraCount = 0;
  const inspectExtra = (obj, pathPrefix = '', depth = 0) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 1) return;
    for (const [k, v] of Object.entries(obj)) {
      if (extraCount >= 24) return;
      if (v === null || v === undefined || v === '') continue;
      const fullKey = pathPrefix ? `${pathPrefix}.${k}` : k;
      const lowerKey = fullKey.toLowerCase();
      if (HANDLED_KEYS.has(lowerKey) || HANDLED_KEYS.has(k.toLowerCase())) continue;
      if (typeof v === 'object' && !Array.isArray(v)) {
        inspectExtra(v, fullKey, depth + 1);
        continue;
      }
      if (Array.isArray(v)) continue;
      if (typeof v === 'number' && v === 0) continue; // skip zero-valued unused counters like audio_tokens: 0
      const canonical = 'extra:' + lowerKey;
      if (seenExtra.has(canonical)) continue;
      const formatted = formatDynamicValue(fullKey, v);
      if (!formatted) continue;
      seenExtra.add(canonical);
      extraCount++;
      const label = humanizeKey(fullKey);
      push({
        key: canonical,
        label,
        shortLabel: label.length > 16 ? label.slice(0, 15) + '…' : label,
        value: formatted,
        shortValue: formatted,
      });
    }
  };
  for (const src of extraSources) inspectExtra(src.obj, src.prefix, 0);

  return { model: modelId, items };
}
