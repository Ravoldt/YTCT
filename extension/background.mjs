import './common.js';
import { loadedModel, modelName, unloadModel } from './ollama.mjs';
import { connectLoopback, hasOllamaAccess, relayLoopback, teardownLoopback } from './loopback-worker.mjs';
import { connectOffscreen, saveDownload } from './offscreen-worker.mjs';
import { normalizeEntry } from './export-entry.mjs';
import {
  activateLlmProfile, activeOllamaModel, connectLlmChat, deleteLlmProfile,
  getLlmConfig, getLlmModelInfo, listLlmModels, revealLlmKey, saveLlmProfile, testLlmConnection,
} from './llm-worker.mjs';
import { lookupPricingInWorker, PRICING_TTL_MS } from './pricing.mjs';

const { settingsDefaults, sourceKey, isMediaSource } = YTCT;
const hour = 3600000;
const entryKey = (key) => 'export:' + key;
const panelPath = (tabId) => 'sidepanel.html?tab=' + tabId;
const youtube = 'https://www.youtube.com';

// API keys and profile data are only available to extension contexts, never to content scripts or pages.
const protectStorage = Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
]);
protectStorage.catch(() => {});

let cacheQueue = Promise.resolve();
let modelQueue = Promise.resolve();
const activeChats = new Map();

function cacheTask(action) {
  const task = cacheQueue.then(action);
  cacheQueue = task.catch(() => {});
  return task;
}

function modelTask(action) {
  const task = modelQueue.then(action);
  modelQueue = task.catch(() => {});
  return task;
}

function tabFromPanel(sender) {
  try {
    if (sender.id !== chrome.runtime.id || sender.tab) return null;
    const url = new URL(sender.url);
    if (url.origin !== new URL(chrome.runtime.getURL('')).origin || url.pathname !== '/sidepanel.html') return null;
    const tabId = Number(url.searchParams.get('tab'));
    return Number.isInteger(tabId) && tabId > 0 ? tabId : null;
  } catch { return null; }
}

async function panelDocument(sender) {
  // Chrome gives side panels a document ID in getContexts even when MessageSender omits it.
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'], documentUrls: [sender.url] });
  return contexts.find((context) => !sender.documentId || context.documentId === sender.documentId)?.documentId;
}

function tabFromContent(sender) {
  try {
    return sender.id === chrome.runtime.id && sender.frameId === 0 && !sender.tab?.incognito
      && new URL(sender.url).origin === youtube && sender.tab?.id > 0 ? sender.tab.id : null;
  } catch { return null; }
}

async function sessionValue(key, fallback) {
  return (await chrome.storage.session.get(key))[key] ?? fallback;
}

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.trunc(number))) : fallback;
}

function normalizeSettings(raw = {}) {
  const s = { ...settingsDefaults, ...raw };
  const legacyBefore = raw.highlightBefore === undefined && raw.highlightOffset !== undefined
    ? Math.max(0, -Number(raw.highlightOffset)) : s.highlightBefore;
  const before = bounded(legacyBefore, 3, 0, 120);
  const legacyAfter = raw.highlightAfter === undefined && raw.highlightDuration !== undefined
    ? Math.max(0, Number(raw.highlightDuration) - before) : s.highlightAfter;
  const rawReplyBatch = raw.allReplies === true ? 0 : s.replyBatch;
  return {
    format: s.format === 'json' ? 'json' : 'markdown',
    shareTranscript: s.shareTranscript === true,
    autoCollect: s.autoCollect === true,
    cacheEnabled: s.cacheEnabled === true,
    debugOllama: !!s.debugOllama,
    contextWindow: bounded(s.contextWindow, 32768, 1024, 2097152),
    highlightBefore: before,
    highlightAfter: bounded(legacyAfter, 3, 0, 120),
    cacheDays: bounded(s.cacheDays, 7, 1, 3650),
    cacheMB: bounded(s.cacheMB, 100, 1, 1000),
    unusedCacheHours: bounded(s.unusedCacheHours, 24, 1, 8760),
    replyBatch: bounded(rawReplyBatch, 10, 0, 10000),
    fontScale: bounded(s.fontScale, 100, 70, 160),
    stackComments: s.stackComments !== false,
    stackWindow: bounded(s.stackWindow, 3, 0, 60),
    linkTheater: s.linkTheater === true,
    defaultSearchMode: s.defaultSearchMode === 'exact' ? 'exact' : 'fuzzy',
    semanticSearchEnabled: s.semanticSearchEnabled === true,
    semanticModel: ['arctic-xs', 'bge-small', 'e5-multi'].includes(s.semanticModel) ? s.semanticModel : 'arctic-xs',
    semanticDevice: s.semanticDevice === 'wasm' ? 'wasm' : 'auto',
  };
}

function normalizeSearchPreset(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim().slice(0, 60);
  if (!name) return null;
  const id = typeof raw.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.id)
    ? raw.id : 'preset-' + Date.now() + '-' + index;
  const f = raw.filters && typeof raw.filters === 'object' ? raw.filters : {};
  const optNum = (v) => {
    if (v === '' || v === null || v === undefined) return '';
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= 0 ? String(Math.min(1000000000, n)) : '';
  };
  return {
    id,
    name,
    query: String(raw.query || '').slice(0, 1000),
    isRegex: f.isRegex === true || raw.isRegex === true,
    mode: ['exact', 'fuzzy', 'semantic'].includes(raw.mode) ? raw.mode : 'fuzzy',
    filters: {
      hasLikes: f.hasLikes === true,
      hasReplies: f.hasReplies === true,
      hearted: f.hearted === true,
      byCreator: f.byCreator === true,
      creatorReplied: f.creatorReplied === true,
      mentionsCreator: f.mentionsCreator === true,
      edited: f.edited === true,
      minLikes: optNum(f.minLikes),
      maxLikes: optNum(f.maxLikes),
      minReplies: optNum(f.minReplies),
      maxReplies: optNum(f.maxReplies),
      author: String(f.author || '').trim().slice(0, 120),
    },
  };
}

async function telemetryPinsAction(message) {
  const stored = (await chrome.storage.local.get('telemetryPins')).telemetryPins;
  let pins = Array.isArray(stored) ? stored.filter((k) => typeof k === 'string' && k.length > 0 && k.length <= 80).slice(0, 60) : [];
  if (message.action === 'set' && Array.isArray(message.pins)) {
    pins = [...new Set(message.pins.filter((k) => typeof k === 'string' && k.length > 0 && k.length <= 80))].slice(0, 60);
    await chrome.storage.local.set({ telemetryPins: pins });
  }
  return pins;
}

async function llmApprovalsAction(message) {
  const stored = (await chrome.storage.local.get('approvedLlmDestinations')).approvedLlmDestinations;
  let list = Array.isArray(stored) ? stored.filter((k) => typeof k === 'string' && k.length > 0 && k.length <= 600).slice(0, 100) : [];
  if (message.action === 'approve' && typeof message.key === 'string' && message.key.trim()) {
    const key = message.key.trim().slice(0, 600);
    if (!list.includes(key)) {
      list.push(key);
      list = list.slice(-100);
      await chrome.storage.local.set({ approvedLlmDestinations: list });
    }
  } else if (message.action === 'remove' && typeof message.key === 'string') {
    list = list.filter((k) => k !== message.key);
    await chrome.storage.local.set({ approvedLlmDestinations: list });
  }
  return list;
}

async function searchPresetsAction(message) {
  const stored = (await chrome.storage.local.get('searchPresets')).searchPresets;
  let presets = Array.isArray(stored) ? stored.map(normalizeSearchPreset).filter(Boolean).slice(0, 50) : [];
  if (message.action === 'save' && message.preset) {
    const clean = normalizeSearchPreset(message.preset, presets.length);
    if (!clean) throw new Error('Enter a preset name.');
    const idx = presets.findIndex((p) => p.id === clean.id);
    if (idx >= 0) presets[idx] = clean;
    else presets.push(clean);
    presets = presets.slice(-50);
    await chrome.storage.local.set({ searchPresets: presets });
  } else if (message.action === 'delete' && typeof message.id === 'string') {
    presets = presets.filter((p) => p.id !== message.id);
    await chrome.storage.local.set({ searchPresets: presets });
  }
  return presets;
}

async function cacheState() {
  const { cacheIndex = {}, settings } = await chrome.storage.local.get(['cacheIndex', 'settings']);
  const visits = await sessionValue('visits', {});
  return { index: cacheIndex, settings: normalizeSettings(settings), visits };
}

function prune(index, settings, visits, protectedKey = '') {
  const open = new Set(Object.values(visits).map((visit) => visit.key));
  const now = Date.now();
  const limit = settings.cacheMB * 1000000;
  const removed = [];
  function remove(key) {
    removed.push(entryKey(key));
    delete index[key];
  }
  for (const [key, row] of Object.entries(index)) {
    if (key === protectedKey) continue;
    if (now - row.savedAt >= settings.cacheDays * 24 * hour ||
      (!row.used && !open.has(key) && now - (row.leftAt || row.savedAt) >= settings.unusedCacheHours * hour)) remove(key);
  }
  let bytes = Object.values(index).reduce((sum, row) => sum + row.bytes, 0);
  for (const [key, row] of Object.entries(index).sort(([, a], [, b]) => a.savedAt - b.savedAt)) {
    if (bytes <= limit) break;
    if (key === protectedKey) continue;
    bytes -= row.bytes;
    remove(key);
  }
  return { bytes, limit, removed };
}

async function persistCache(index, removed, values = {}) {
  await chrome.storage.local.set({ cacheIndex: index, ...values });
  if (removed.length) await chrome.storage.local.remove(removed);
}

async function removeOrphanedExports(index) {
  const keys = (await chrome.storage.local.getKeys()).filter((key) =>
    key.startsWith('export:') && !Object.hasOwn(index, key.slice(7)));
  if (keys.length) await chrome.storage.local.remove(keys);
}

async function setVisit(tabId, key, pageId = '') {
  const { index, settings, visits } = await cacheState();
  const prior = visits[tabId];
  const { removed } = prune(index, settings, visits);
  if (isMediaSource(key)) visits[tabId] = { key, pageId, used: prior?.key === key && !!prior.used };
  else delete visits[tabId];
  if (prior?.key && prior.key !== key && index[prior.key] && !Object.values(visits).some((visit) => visit.key === prior.key)) {
    index[prior.key].leftAt = Date.now();
  }
  await chrome.storage.session.set({ visits });
  if (prior && (prior.pageId !== pageId || prior.key !== key)) await chrome.storage.session.remove('chat:' + tabId);
  await persistCache(index, removed);
  const hasSaved = settings.cacheEnabled === true && isMediaSource(key) && !!index[key];
  return {
    autoCollect: settings.autoCollect === true && isMediaSource(key) && !hasSaved,
    linkTheater: settings.linkTheater === true,
  };
}

async function cacheAction(message, tabId) {
  const { index, visits, settings } = await cacheState();
  const key = message.key;
  const common = prune(index, settings, visits);
  if (message.type === 'settings') {
    if (message.values) {
      const saved = normalizeSettings(message.values);
      const result = prune(index, saved, visits);
      await persistCache(index, [...common.removed, ...result.removed], { settings: saved });
      for (const visitedTabId of Object.keys(visits)) {
        const numericId = Number(visitedTabId);
        if (Number.isInteger(numericId) && numericId > 0) {
          chrome.tabs.sendMessage(numericId, { type: 'ytct-settings', linkTheater: saved.linkTheater }).catch(() => {});
        }
      }
      return { settings: saved, bytes: result.bytes, limit: result.limit };
    }
    if (common.removed.length) await persistCache(index, common.removed);
    return { settings, bytes: common.bytes, limit: common.limit };
  }
  if (message.type === 'clear-cache') {
    await removeOrphanedExports({});
    await persistCache({}, []);
    return;
  }
  if (!isMediaSource(key) || visits[tabId]?.key !== key || visits[tabId].pageId !== message.pageId) {
    throw new Error('The YouTube source changed. Reopen the side panel.');
  }
  if (message.type === 'read-cache') {
    if (common.removed.length) await persistCache(index, common.removed);
    if (!index[key] || (!message.explicit && !settings.cacheEnabled)) return null;
    const entry = (await chrome.storage.local.get(entryKey(key)))[entryKey(key)];
    return entry ? normalizeEntry(key, entry) : null;
  }
  if (message.type === 'mark-used') {
    visits[tabId].used = true;
    if (index[key] && (settings.cacheEnabled || index[key].pageId === message.pageId || message.explicit)) index[key].used = true;
    await chrome.storage.session.set({ visits });
    await persistCache(index, common.removed);
    return;
  }
  if (message.type !== 'write-cache') throw new Error('Unknown extension action.');
  const entry = normalizeEntry(key, message.entry);
  if (!settings.cacheEnabled) {
    if (common.removed.length) await persistCache(index, common.removed);
    return { saved: false };
  }
  const bytes = new Blob([JSON.stringify(entry)]).size;
  if (bytes > common.limit) {
    if (common.removed.length) await persistCache(index, common.removed);
    return { saved: false, reason: 'This export exceeds the cache limit. Increase it in Settings to keep this export.' };
  }
  index[key] = {
    savedAt: Date.now(),
    pageId: message.pageId,
    used: visits[tabId].used,
    bytes,
    status: entry.snapshot?.collection?.status || 'imported',
  };
  const result = prune(index, settings, visits, key);
  await persistCache(index, [...common.removed, ...result.removed].filter((removed) => removed !== entryKey(key)), { [entryKey(key)]: entry });
  return { saved: true };
}

async function reconcileModel({ acquire, release, tabId } = {}) {
  const state = await sessionValue('model', { leases: {}, ownedModels: [] });
  state.ownedModels ??= state.owned && state.model ? [modelName(state.model)] : [];
  for (const lease of Object.values(state.leases)) lease.model = modelName(lease.model || state.model || '');
  const live = new Set((await chrome.runtime.getContexts({})).map((context) => context.documentId));
  for (const [document, lease] of Object.entries(state.leases)) {
    if (document === release || (tabId && lease.tabId === tabId) || !live.has(document)
      || (document === acquire?.document && lease.model !== acquire.model)) {
      activeChats.get(document)?.();
      delete state.leases[document];
    }
  }
  let result;
  if (acquire) {
    if (!live.has(acquire.document)) throw new Error('The side panel has closed.');
    if (!await hasOllamaAccess()) {
      const error = new Error('Host access is missing for http://127.0.0.1:11434. Open “Grant network access” in Settings → LLM, then try again.');
      error.code = 'HOST_ACCESS';
      throw error;
    }
    const { model } = acquire;
    const resident = await loadedModel(model);
    if (!resident && !state.ownedModels.includes(model)) state.ownedModels.push(model);
    state.leases[acquire.document] = { tabId: acquire.tabId, model };
    result = { resident, model };
  }
  delete state.owned;
  delete state.model;
  await chrome.storage.session.set({ model: state });
  if (state.ownedModels.length && await hasOllamaAccess()) {
    for (const model of [...state.ownedModels]) {
      if (Object.values(state.leases).some((lease) => lease.model === model)) continue;
      try {
        if (await loadedModel(model)) await unloadModel(model, relayLoopback);
        state.ownedModels = state.ownedModels.filter((name) => name !== model);
      } catch {
        // Maintenance will retry a failed unload.
      }
    }
    await chrome.storage.session.set({ model: state });
  }
  return result;
}

function releaseTab(tabId) {
  return modelTask(() => reconcileModel({ tabId })).catch(() => {});
}

async function handle(message, sender) {
  const contentTab = tabFromContent(sender);
  const panelTab = tabFromPanel(sender);
  const tabId = contentTab || panelTab;
  if (!tabId) throw new Error('Unsupported extension context.');
  await protectStorage;
  switch (message.type) {
    case 'visit': {
      if (!contentTab || typeof message.pageId !== 'string' || message.pageId.length > 80) throw new Error('Unsupported visit.');
      return cacheTask(async () => {
        const tab = await chrome.tabs.get(tabId);
        const key = sourceKey(tab.url || sender.url);
        if (!key || tab.incognito || message.key !== key) throw new Error('The page changed.');
        await chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: isMediaSource(key) });
        return await setVisit(tabId, key, message.pageId);
      });
    }
    case 'read-cache':
    case 'mark-used':
    case 'write-cache':
    case 'clear-cache':
      if (!panelTab) throw new Error('Open the side panel to manage exports.');
      return cacheTask(() => cacheAction(message, tabId));
    case 'settings':
      if (!panelTab) throw new Error('Open the side panel to manage settings.');
      return cacheTask(() => cacheAction(message, tabId));
    case 'search-presets':
      if (!panelTab) throw new Error('Open the side panel to manage search presets.');
      return cacheTask(() => searchPresetsAction(message));
    case 'telemetry-pins':
      if (!panelTab) throw new Error('Open the side panel to manage telemetry settings.');
      return cacheTask(() => telemetryPinsAction(message));
    case 'llm-approvals':
      if (!panelTab) throw new Error('Open the side panel to manage assistant approvals.');
      return cacheTask(() => llmApprovalsAction(message));
    case 'pricing-lookup':
      if (!panelTab) throw new Error('Open the side panel to check model pricing.');
      return lookupPricingInWorker({
        provider: String(message.provider || ''),
        model: String(message.model || ''),
        force: message.force === true,
        maxAgeMs: Number.isFinite(Number(message.maxAgeMs)) && Number(message.maxAgeMs) >= 0
          ? Number(message.maxAgeMs) : PRICING_TTL_MS,
      });
    case 'download-cache':
    case 'download-export': {
      if (!contentTab) throw new Error('Use the download button on YouTube to save a file.');
      const { entry, format } = await cacheTask(async () => {
        const { key, pageId } = message;
        const { visits, settings } = await cacheState();
        const tab = await chrome.tabs.get(tabId);
        if (tab.incognito || sourceKey(tab.url) !== key || visits[tabId]?.key !== key || visits[tabId].pageId !== pageId) {
          throw new Error('The YouTube source changed.');
        }
        const entry = message.type === 'download-cache' ? await cacheAction({ ...message, type: 'read-cache', explicit: false }, tabId)
          : normalizeEntry(key, message.entry);
        return { entry, format: settings.format };
      });
      if (!entry || (message.type === 'download-cache' && format === 'json' && !entry.snapshot)) return false;
      return saveDownload(entry, format);
    }
    case 'close-panel':
      if (!panelTab) throw new Error('Open the side panel first.');
      if (typeof chrome.sidePanel.close === 'function') {
        await chrome.sidePanel.close({ tabId });
        return true;
      }
      // Older Chrome releases have no close API; disabling closes the panel, then make it available again.
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
      await new Promise((resolve) => setTimeout(resolve, 200));
      await chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: true });
      return true;
    case 'llm-config':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return getLlmConfig();
    case 'llm-save-profile':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return saveLlmProfile(message);
    case 'llm-activate':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return activateLlmProfile(message.id);
    case 'llm-delete':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return deleteLlmProfile(message.id);
    case 'llm-reveal-key':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return revealLlmKey(message.id);
    case 'llm-models':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return listLlmModels(message);
    case 'llm-model-info':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return getLlmModelInfo(message);
    case 'llm-test':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return testLlmConnection(message);
    case 'model-acquire':
    case 'model-release':
      if (!panelTab) throw new Error('Open the assistant panel in the side panel.');
      return modelTask(async () => {
        const document = await panelDocument(sender);
        if (!document) throw new Error('Open the assistant panel in the side panel.');
        if (message.type === 'model-release') return reconcileModel({ release: document });
        const model = modelName(await activeOllamaModel(message.profileId, message.destination));
        return reconcileModel({ acquire: { document, tabId, model } });
      });
    default:
      throw new Error('Unknown extension action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  // Preserve the page button's user gesture. The visit registered tab options before it became clickable.
  if (message?.type === 'open-panel' && tabFromContent(sender)) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).then(() => reply({ ok: true }),
      (error) => reply({ ok: false, error: error.message }));
    return true;
  }
  if (!message?.type || ['ytct-loopback-wake', 'ytct-loopback-close', 'ytct-offscreen-wake'].includes(message.type)) return false;
  handle(message, sender).then((value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: error.message || String(error), code: error.code, status: error.status }));
  return true;
});

function sanitizeOllamaPayload(payload, leasedModel) {
  if (!payload || typeof payload !== 'object' || typeof payload.model !== 'string' || modelName(payload.model) !== leasedModel
    || !Array.isArray(payload.messages) || !payload.messages.length || payload.messages.length > 200) {
    return null;
  }
  const messages = [];
  for (const item of payload.messages) {
    if (!item || !['system', 'user', 'assistant'].includes(item.role) || typeof item.content !== 'string') return null;
    const clean = { role: item.role, content: item.content };
    if (item.images !== undefined) {
      if (!Array.isArray(item.images) || item.images.length > 4
        || item.images.some((img) => typeof img !== 'string' || img.length > 7 * 1024 * 1024)) return null;
      clean.images = item.images;
    }
    messages.push(clean);
  }
  const result = {
    model: payload.model,
    messages,
    stream: true,
    keep_alive: '5m',
    truncate: false,
    shift: false,
  };
  if (typeof payload.think === 'boolean' || ['low', 'medium', 'high'].includes(payload.think)) {
    result.think = payload.think;
  }
  if (payload.options && typeof payload.options === 'object') {
    const rawPredict = Number(payload.options.num_predict);
    result.options = {
      num_ctx: bounded(payload.options.num_ctx, 32768, 1024, 2097152),
      num_predict: rawPredict === -1 ? -1 : bounded(rawPredict, -1, 1, 2097152),
    };
  }
  return new Blob([JSON.stringify(result)]).size <= 18 * 1024 * 1024 ? result : null;
}

function connectChat(port) {
  if (!tabFromPanel(port.sender)) {
    try { port.disconnect(); } catch {}
    return;
  }
  const document = panelDocument(port.sender).catch(() => null);
  let documentId;
  let connected = true;
  let started = false;
  let cancel;
  function finish() {
    cancel?.();
    if (activeChats.get(documentId) === finish) activeChats.delete(documentId);
  }
  function receive(message) {
    if (connected) port.postMessage(message);
    if (message.type === 'end' || message.type === 'error') finish();
  }
  port.onDisconnect.addListener(() => {
    connected = false;
    finish();
  });
  port.onMessage.addListener((payload) => {
    if (started) return;
    started = true;
    modelTask(async () => {
      documentId = await document;
      const state = await sessionValue('model', { leases: {} });
      if (!connected) return;
      const leasedModel = state.leases[documentId]?.model;
      const cleanPayload = leasedModel ? sanitizeOllamaPayload(payload, leasedModel) : null;
      if (!cleanPayload) {
        throw new Error('Start a question from the side panel to connect to Ollama.');
      }
      activeChats.get(documentId)?.();
      activeChats.set(documentId, finish);
      cancel = relayLoopback('/api/chat', cleanPayload, receive);
    }).catch((error) => receive({ type: 'error', error: error.message }));
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ytct-offscreen') { connectOffscreen(port); return; }
  if (port.name === 'ytct-loopback') { connectLoopback(port); return; }
  if (port.name === 'ytct-ollama-chat') { connectChat(port); return; }
  if (port.name === 'ytct-llm-chat') {
    if (tabFromPanel(port.sender)) connectLlmChat(port);
    else try { port.disconnect(); } catch {}
    return;
  }
  if (port.name !== 'ytct-model' || !tabFromPanel(port.sender)) {
    try { port.disconnect(); } catch {}
    return;
  }
  const document = panelDocument(port.sender).catch(() => null);
  port.onDisconnect.addListener(() => {
    document.then((release) => release && modelTask(() => reconcileModel({ release }))).catch(() => {});
  });
});

chrome.permissions.onRemoved.addListener(() => {
  teardownLoopback().catch(() => {});
});

chrome.sidePanel.onClosed.addListener(({ tabId }) => { if (tabId) releaseTab(tabId); });
chrome.action.onClicked.addListener((tab) => {
  if (tab.id && isMediaSource(sourceKey(tab.url))) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  cacheTask(() => setVisit(tabId, '')).catch(() => {});
  releaseTab(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'complete' || isMediaSource(sourceKey(tab.url))) return;
  cacheTask(async () => {
    const visits = await sessionValue('visits', {});
    if (visits[tabId]) await setVisit(tabId, '');
  }).catch(() => {});
  releaseTab(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});
  chrome.alarms.create('maintenance', { periodInMinutes: 30 });
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('maintenance', { periodInMinutes: 30 }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'maintenance') return;
  cacheTask(async () => {
    const { index, settings, visits } = await cacheState();
    const { removed } = prune(index, settings, visits);
    if (removed.length) await persistCache(index, removed);
    await removeOrphanedExports(index);
  }).catch(() => {});
  modelTask(() => reconcileModel()).catch(() => {});
});
