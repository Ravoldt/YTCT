import './common.js';
import { DEFAULT_MODEL, loadedModel, unloadModel } from './ollama.mjs';
import { connectLoopback, relayLoopback } from './loopback-worker.mjs';
import {
  activateLlmProfile, activeOllamaModel, connectLlmChat, deleteLlmProfile,
  getLlmConfig, listLlmModels, revealLlmKey, saveLlmProfile, testLlmConnection,
} from './llm-worker.mjs';

const { settingsDefaults, sourceKey, isMediaSource } = YTCT;
const hour = 3600000;
const entryKey = (key) => 'export:' + key;
const panelPath = (tabId) => 'sidepanel.html?tab=' + tabId;
const youtube = 'https://www.youtube.com';

// API keys and profile data are only available to extension contexts, never to content scripts or pages.
try { chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch {}
try { chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch {}

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
    return sender.frameId === 0 && new URL(sender.url).origin === youtube && sender.tab?.id > 0 ? sender.tab.id : null;
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
  return {
    format: s.format === 'json' ? 'json' : 'markdown',
    includeTranscript: !!s.includeTranscript,
    debugOllama: !!s.debugOllama,
    contextWindow: bounded(s.contextWindow, 32768, 1024, 262144),
    highlightOffset: bounded(s.highlightOffset, -3, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
    cacheDays: bounded(s.cacheDays, 7, 1, 3650),
    cacheMB: bounded(s.cacheMB, 100, 1, 1000),
    unusedCacheHours: bounded(s.unusedCacheHours, 24, 1, 8760),
    replyBatch: bounded(s.replyBatch, 10, 1, 10000),
    allReplies: !!s.allReplies,
    fontScale: bounded(s.fontScale, 100, 70, 160),
    highlightDuration: bounded(s.highlightDuration, 6, 0, 120),
    stackWindow: bounded(s.stackWindow, 3, 0, 60),
  };
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
  return { saved: index[key] || null, settings };
}

function verifyEntry(key, entry) {
  if (entry?.snapshot) {
    const data = entry.snapshot;
    return sourceKey(data.source) === key && Array.isArray(data.comments) && data.comments.length > 0
      && data.comments.every((comment) => typeof comment?.id === 'string' && typeof comment?.text === 'string')
      && !!data.metadata && !!data.collection && Array.isArray(data.stats?.errors);
  }
  return typeof entry?.markdown === 'string' && YTCT.markdownSourceKey(entry.markdown) === key;
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
      return { settings: saved, bytes: result.bytes, limit: result.limit };
    }
    if (common.removed.length) await persistCache(index, common.removed);
    return { settings, bytes: common.bytes, limit: common.limit };
  }
  if (visits[tabId]?.key !== key) throw new Error('The YouTube source changed. Reopen the side panel.');
  if (message.type === 'read-cache') {
    if (common.removed.length) await persistCache(index, common.removed);
    return index[key] ? (await chrome.storage.local.get(entryKey(key)))[entryKey(key)] || null : null;
  }
  if (message.type === 'mark-used') {
    visits[tabId].used = true;
    if (index[key]) index[key].used = true;
    await chrome.storage.session.set({ visits });
    await persistCache(index, common.removed);
    return;
  }
  const entry = message.entry;
  if (!verifyEntry(key, entry)) throw new Error('Choose a matching YouTube comment export.');
  const bytes = new Blob([JSON.stringify(entry)]).size;
  if (bytes > common.limit) {
    if (common.removed.length) await persistCache(index, common.removed);
    return { saved: false, reason: 'This export exceeds the cache limit. Increase it in Settings to keep this export.' };
  }
  const prior = index[key];
  index[key] = {
    savedAt: message.keepAge && prior ? prior.savedAt : Date.now(),
    used: !!prior?.used || Object.values(visits).some((visit) => visit.key === key && visit.used),
    bytes,
    status: entry.snapshot?.collection?.status || 'imported',
  };
  const result = prune(index, settings, visits, key);
  await persistCache(index, [...common.removed, ...result.removed].filter((removed) => removed !== entryKey(key)), { [entryKey(key)]: entry });
  return { saved: true };
}

async function reconcileModel({ acquire, release, tabId } = {}) {
  const state = await sessionValue('model', { owned: false, leases: {}, model: '' });
  const live = new Set((await chrome.runtime.getContexts({})).map((context) => context.documentId));
  for (const [document, lease] of Object.entries(state.leases)) {
    if (document === release || (tabId && lease.tabId === tabId) || !live.has(document)) {
      activeChats.get(document)?.();
      delete state.leases[document];
    }
  }
  if (acquire) {
    if (!live.has(acquire.document)) throw new Error('The side panel has closed.');
    const model = await activeOllamaModel();
    const resident = model ? await loadedModel(model) : null;
    if (!Object.keys(state.leases).length && !resident && model) state.owned = true;
    if (model) state.model = model;
    state.leases[acquire.document] = { tabId: acquire.tabId };
    await chrome.storage.session.set({ model: state });
    return { resident, owned: state.owned, model: model || '' };
  }
  if (!Object.keys(state.leases).length && state.owned) {
    await chrome.storage.session.set({ model: state });
    await unloadModel(state.model || DEFAULT_MODEL, relayLoopback);
    state.owned = false;
  }
  await chrome.storage.session.set({ model: state });
}

function releaseTab(tabId) {
  return modelTask(() => reconcileModel({ tabId })).catch(() => {});
}

async function handle(message, sender) {
  const contentTab = tabFromContent(sender);
  const panelTab = tabFromPanel(sender);
  const tabId = contentTab || panelTab;
  if (!tabId) throw new Error('Unsupported extension context.');
  switch (message.type) {
    case 'visit': {
      if (!contentTab || typeof message.pageId !== 'string') throw new Error('Unsupported visit.');
      // sender.url keeps the URL the content script was injected into, so it is stale after
      // YouTube's SPA navigations. The content script's own href is current.
      const href = typeof message.href === 'string' && message.href ? message.href : sender.tab?.url || sender.url;
      const key = sourceKey(href);
      if (!key || message.key !== key) throw new Error('The page changed.');
      await chrome.sidePanel.setOptions({ tabId, path: panelPath(tabId), enabled: isMediaSource(message.key) });
      return cacheTask(() => setVisit(tabId, message.key, message.pageId));
    }
    case 'read-cache':
    case 'mark-used':
    case 'write-cache':
      return cacheTask(() => cacheAction(message, tabId));
    case 'settings':
      if (!panelTab && message.values) throw new Error('Open the side panel to change settings.');
      return cacheTask(() => cacheAction(message, tabId));
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
    case 'llm-test':
      if (!panelTab) throw new Error('Open the side panel to configure the LLM.');
      return testLlmConnection(message);
    case 'model-acquire':
    case 'model-release':
      if (!panelTab) throw new Error('Open the assistant panel in the side panel.');
      return modelTask(async () => {
        const document = await panelDocument(sender);
        if (!document) throw new Error('Open the assistant panel in the side panel.');
        return message.type === 'model-acquire'
          ? reconcileModel({ acquire: { document, tabId } })
          : reconcileModel({ release: document });
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
  if (!message?.type || message.type === 'ytct-loopback-wake') return false;
  handle(message, sender).then((value) => reply({ ok: true, value }),
    (error) => reply({ ok: false, error: error.message || String(error) }));
  return true;
});

function connectChat(port) {
  if (!tabFromPanel(port.sender)) return;
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
      const state = await sessionValue('model', { leases: {}, model: '' });
      if (!connected) return;
      const leasedModel = state.model || DEFAULT_MODEL;
      if (!state.leases[documentId] || payload?.model !== leasedModel || !Array.isArray(payload.messages)) {
        throw new Error('Start a question from the side panel to connect to Ollama.');
      }
      activeChats.get(documentId)?.();
      activeChats.set(documentId, finish);
      cancel = relayLoopback('/api/chat', payload, receive);
    }).catch((error) => receive({ type: 'error', error: error.message }));
  });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'ytct-loopback') { connectLoopback(port); return; }
  if (port.name === 'ytct-ollama-chat') { connectChat(port); return; }
  if (port.name === 'ytct-llm-chat') {
    if (tabFromPanel(port.sender)) connectLlmChat(port);
    return;
  }
  if (port.name !== 'ytct-model' || !tabFromPanel(port.sender)) return;
  const document = panelDocument(port.sender).catch(() => null);
  port.onDisconnect.addListener(() => {
    document.then((release) => release && modelTask(() => reconcileModel({ release }))).catch(() => {});
  });
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
  chrome.alarms.create('maintenance', { periodInMinutes: 30 });
});
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('maintenance', { periodInMinutes: 30 }));
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'maintenance') return;
  cacheTask(async () => {
    const { index, settings, visits } = await cacheState();
    const { removed } = prune(index, settings, visits);
    if (removed.length) await persistCache(index, removed);
  }).catch(() => {});
  modelTask(() => reconcileModel()).catch(() => {});
});
