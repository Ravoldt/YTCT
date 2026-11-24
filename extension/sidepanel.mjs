import { CommentsView } from './comments-view.mjs';
import { renderAnswer } from './answer-view.mjs';
import { askOllama, loadedModel } from './ollama.mjs';
import { askRemote, messageTokens } from './remote.mjs';
import { normalizeEntry, normalizeTranscript } from './export-entry.mjs';
// Provider presets and model discovery adapted from Cline (Apache-2.0).
// See licenses/LICENSE-CLINE.txt and THIRD_PARTY_NOTICES.md for attribution and changes.
import {
  PROVIDER_GROUPS, PROVIDERS, activeProfile, assistantLabel, defaultLlmConfig, defaultProfile,
  canonicalEndpoint, contextSteps, effectiveContextWindow, endpointUrl, formatContextLabel,
  isCloudManagedProvider, isLoopback, maskKey, originPattern, profileDestination, providerOrigin,
  providerSpec, resolveModelCapabilities,
} from './llm-config.mjs';

const byId = (id) => document.getElementById(id);
const tabId = Number(new URLSearchParams(location.search).get('tab'));
const query = byId('query');
const askField = byId('ask-field');
const askInput = byId('ask-input');
const expandAskBtn = byId('expand-ask');
const expandAskPath = byId('expand-ask-path');
const footerEl = document.querySelector('footer');
const chat = byId('chat');
const config = byId('settings-form');
const dialog = byId('settings');
const pending = new Map();
let port;
let modelPort;
let state;
let job;
let leaseRequested = false;
let releasePending = Promise.resolve();
let mode = 'search';
let askExpanded = false;
let searchDraft = '';
let questionDraft = '';
let searchTimer;
let settings = YTCT.settingsDefaults;
let llm = defaultLlmConfig();
let llmEditingId = null;
let llmNewDraft = null;
let llmDirty = false;
let llmKeyClear = false;
let llmProviderChanged = false;
let llmTesting = false;
let llmGrantOrigin = '';
let llmRevealTimer;
const llmModelsByProvider = new Map();
const llmModelMetaByProvider = new Map();
let llmCurrentSteps = contextSteps(262144, 7);
let llmCurrentCaps = resolveModelCapabilities('cloud', '');
let llmCapSeq = 0;
let llmLocalFetchSeq = 0;
let llmModelDebounce = null;
let newCommentsCount = 0;
let countPollTimer = null;
let countCheckInFlight = false;
let settingsTab = 'general';
let history = [];
let historyDestination = '';
let historyHasTranscript = false;
const approvedScopes = new Set();
let closing = false;
let reconnect;

const activeLlm = () => activeProfile(llm);

function destinationOf(profile) {
  try { return profileDestination(profile); } catch { return ''; }
}

function setLlmConfig(next) {
  const before = destinationOf(activeLlm());
  llm = next;
  if (destinationOf(activeLlm()) === before) return;
  if (job || history.length || leaseRequested) clearChat();
  approvedScopes.clear();
}

const viewer = new CommentsView({
  list: byId('comments'), count: byId('count'), follow: byId('follow'),
  timestampOnly: byId('timestamp-only'), playhead: byId('playhead-time'),
  seek: (seconds) => tab('seek', { seconds }),
});
const actions = {
  seek: (seconds) => tab('seek', { seconds }),
  jump(id) { if (!viewer.jump(id)) notice('That comment is unavailable in the current export.'); },
};

function notice(text) {
  byId('notice').textContent = text || '';
  byId('notice').hidden = !text;
}

function applyAssistantName() {
  const name = assistantLabel(llm);
  const label = 'Ask ' + name;
  byId('ai-mode-label').textContent = label;
  byId('ai-heading').textContent = label;
  byId('ai').setAttribute('aria-label', label);
  byId('ai-resize').setAttribute('aria-label', 'Resize ' + label);
  byId('ai-mode').setAttribute('aria-label', label);
  byId('ai-mode').title = label;
  const placeholder = 'Ask ' + name;
  askInput.placeholder = placeholder;
  askInput.setAttribute('aria-label', placeholder);
  if (mode === 'ai' && !job) {
    byId('ai-status').textContent = activeLlm() ? 'Ready' : 'Configure an LLM in Settings → LLM';
  }
}

async function loadLlmConfig() {
  try {
    setLlmConfig(await worker('llm-config'));
  } catch {
    return;
  }
  applyAssistantName();
  if (dialog.open && settingsTab === 'llm' && !llmDirty) {
    llmEditingId = activeLlm()?.id || null;
    renderLlmSettings();
  }
}

async function worker(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) throw Object.assign(new Error(response?.error || 'The extension worker is unavailable.'), {
    status: response?.status, code: response?.code,
  });
  return response.value;
}

function tab(action, payload = {}) {
  if (!port || !state?.key) return Promise.reject(new Error('Open a YouTube video or post first.'));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('YouTube did not respond. Reload the page and try again.'));
    }, action === 'collect' ? 92 * 60000 : 35000);
    pending.set(id, { resolve, reject, timer });
    try { port.postMessage({ action, id, key: state.key, ...payload }); }
    catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function release() {
  if (!leaseRequested) return releasePending;
  leaseRequested = false;
  releasePending = worker('model-release').catch((error) => {
    if (!closing) notice('Local model cleanup will retry. ' + error.message);
  });
  return releasePending;
}

function stopAsking() {
  job?.controller.abort(new Error('Question stopped.'));
  job = null;
  byId('confirm').hidden = true;
  clearCost();
  return release();
}

function clearChat() {
  stopAsking();
  history = [];
  historyDestination = '';
  historyHasTranscript = false;
  chat.replaceChildren();
  byId('ai-status').textContent = activeLlm() ? 'Ready' : 'Configure an LLM in Settings → LLM';
  chrome.storage.session.remove('chat:' + tabId).catch(() => { });
  updateComposer();
}

function resizeAskInput() {
  if (askExpanded || mode !== 'ai') return;
  askInput.style.height = 'auto';
  const style = getComputedStyle(askInput);
  const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 14) * 1.45;
  const paddingY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const borderY = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  const maxHeight = Math.ceil(lineHeight * 4 + paddingY + borderY);
  const scrollHeight = askInput.scrollHeight;
  askInput.style.height = Math.min(scrollHeight, maxHeight) + 'px';
  askInput.style.overflowY = scrollHeight > maxHeight + 1 ? 'auto' : 'hidden';
}

function setAskExpanded(expanded) {
  askExpanded = !!expanded && mode === 'ai';
  footerEl.classList.toggle('ask-expanded', askExpanded);
  expandAskBtn.setAttribute('aria-pressed', String(askExpanded));
  const label = askExpanded ? 'Collapse input' : 'Expand input to full height';
  expandAskBtn.title = label;
  expandAskBtn.setAttribute('aria-label', label);
  expandAskPath.setAttribute('d', askExpanded
    ? 'M4 14h6v6M20 10h-6V4M14 10l6-6M10 14l-6 6'
    : 'M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6');
  if (!askExpanded) resizeAskInput();
}

function setMode(next) {
  if (next === mode) return;
  if (mode === 'search') searchDraft = query.value;
  else questionDraft = askInput.value;
  clearTimeout(searchTimer);
  mode = next;
  const ai = mode === 'ai';
  if (!ai) setAskExpanded(false);
  byId('ai').hidden = !ai;
  query.hidden = ai;
  askField.hidden = !ai;
  byId('send').hidden = !ai;
  byId('search-mode').setAttribute('aria-pressed', String(!ai));
  byId('ai-mode').setAttribute('aria-pressed', String(ai));
  if (ai) askInput.value = questionDraft;
  else query.value = searchDraft;
  viewer.setQuery(ai ? '' : searchDraft);
  if (!ai) stopAsking();
  else {
    applyAssistantName();
    chat.scrollTop = chat.scrollHeight;
    resizeAskInput();
    requestAnimationFrame(resizeAskInput);
  }
  updateComposer();
}

function updateComposer() {
  const value = mode === 'ai' ? askInput.value : query.value;
  byId('send').disabled = !state?.entry || !!job || !value.trim();
}

function stopCountPolling() {
  clearInterval(countPollTimer);
  countPollTimer = null;
  newCommentsCount = 0;
  countCheckInFlight = false;
}

function countBaseline(entry) {
  if (!entry) return 0;
  const reported = Number(entry.snapshot?.reportedCount) || 0;
  const loaded = YTCT.commentsFromExport(entry).length;
  return Math.max(reported, loaded);
}

async function checkNewComments(current) {
  if (!current || state !== current || !current.entry || current.progress?.running || countCheckInFlight) return;
  countCheckInFlight = true;
  try {
    const result = await tab('check-count');
    if (state !== current || !current.entry || current.progress?.running) return;
    const live = Number(typeof result === 'number' ? result : result?.count) || 0;
    const baseline = countBaseline(current.entry);
    const diff = live > baseline ? live - baseline : 0;
    if (diff !== newCommentsCount) {
      newCommentsCount = diff;
      updatePageHeader();
    }
  } catch {
    // Ignore transient errors while checking reported comment count.
  } finally {
    countCheckInFlight = false;
  }
}

function startCountPolling(current, checkImmediately = false) {
  clearInterval(countPollTimer);
  countPollTimer = null;
  if (!current || state !== current || !current.entry) return;
  if (checkImmediately) checkNewComments(current);
  countPollTimer = setInterval(() => checkNewComments(current), 60000);
}

function resetView(info) {
  stopAsking();
  stopCountPolling();
  setAskExpanded(false);
  setMode('search');
  searchDraft = '';
  questionDraft = '';
  query.value = '';
  askInput.value = '';
  history = [];
  historyDestination = '';
  historyHasTranscript = false;
  approvedScopes.clear();
  chat.replaceChildren();
  byId('telemetry').hidden = true;
  clearCost();
  notice('');
  viewer.reset(info?.key || '');
  state = info ? { ...info, entry: null } : null;
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('YouTube source changed.'));
  }
  pending.clear();
  updatePageHeader();
  updateComposer();
  if (!state) viewer.showEmpty('Open a YouTube video or community post.');
  else viewer.showEmpty('Preparing the comments…');
}

function formatCollectedTime(entry) {
  const date = YTCT.exportTimestamp(entry);
  if (!date) return null;
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const sameYear = date.getFullYear() === now.getFullYear();
  const formatted = sameDay
    ? date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleString([], {
      ...(sameYear ? {} : { year: 'numeric' }),
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  return { text: 'Collected ' + formatted, full: date.toLocaleString() };
}

function updatePageHeader() {
  byId('source-title').textContent = state?.title || 'Open a YouTube video or post';
  byId('video-tools').hidden = !state?.key.startsWith('video:');
  byId('ai-mode').disabled = !state;
  if (state) document.documentElement.dataset.theme = state.dark ? 'dark' : 'light';
  const progress = state?.progress || {};
  const partial = state?.entry?.snapshot?.collection?.status === 'partial';
  const limitReached = !!state?.entry?.snapshot?.collection?.limitReached;
  byId('collection').hidden = !state;
  const collectButton = byId('collect');
  collectButton.textContent = progress.running ? 'Stop' : state?.entry ? 'Refresh' : 'Collect';
  collectButton.title = progress.running ? 'Stop collecting comments'
    : state?.entry ? 'Check for and collect new comments' : 'Collect comments';
  const newBadge = byId('new-comments-badge');
  const showNew = !progress.running && !!state?.entry && newCommentsCount > 0;
  newBadge.hidden = !showNew;
  newBadge.textContent = showNew
    ? '+' + newCommentsCount.toLocaleString() + (newCommentsCount === 1 ? ' New Comment' : ' New Comments')
    : '';
  const statusEl = byId('collection-status');
  if (progress.running) {
    statusEl.textContent = 'Collecting' + (progress.count ? ' · ' + progress.count.toLocaleString() : '') + '…';
    statusEl.removeAttribute('title');
  } else if (state?.entry) {
    const collected = formatCollectedTime(state.entry);
    const base = collected ? collected.text : 'Imported comments';
    const suffix = limitReached ? ' · size limit reached' : partial ? ' · partial' : '';
    statusEl.textContent = base + suffix;
    if (collected) statusEl.title = 'Collected ' + collected.full;
    else statusEl.removeAttribute('title');
  } else {
    statusEl.textContent = progress.status === 'error' && progress.reason ? progress.reason : 'Not collected yet';
    statusEl.removeAttribute('title');
  }
}

function adoptEntry(entry, { checkNow = false } = {}) {
  if (!state || !entry) return;
  const previous = state.entry;
  state.entry = entry;
  newCommentsCount = 0;
  if (entry.snapshot?.exportedAt !== previous?.snapshot?.exportedAt || entry.markdown !== previous?.markdown || !previous) {
    viewer.load(entry);
  }
  updatePageHeader();
  updateComposer();
  const collectedAt = YTCT.exportTimestamp(entry)?.getTime() || Date.now();
  startCountPolling(state, checkNow || Date.now() - collectedAt >= 60000);
}

function bubble(role, content = '') {
  const node = document.createElement('div');
  node.className = 'bubble ' + role;
  node.textContent = content;
  chat.append(node);
  chat.scrollTop = chat.scrollHeight;
  return node;
}

function linksForTurn(turn) {
  return { key: state.key, duration: turn.duration, comments: new Map(turn.comments || []), authors: new Map(turn.authors || []) };
}

async function preparePage(current) {
  try {
    const identity = { key: current.key, pageId: current.pageId };
    const [cached, collected] = await Promise.all([worker('read-cache', identity), tab('load-collected')]);
    if (state !== current) return;
    if (!current.entry) {
      if (collected && collected.snapshot?.exportedAt !== cached?.snapshot?.exportedAt && !cached?.markdown) {
        await receiveEntry(current, collected);
      } else if (cached) {
        adoptEntry(cached, { checkNow: true });
      }
    }
    if (cached) await worker('mark-used', identity);
    if (state !== current) return;
    await loadLlmConfig();
    const { ['chat:' + tabId]: saved } = await chrome.storage.session.get('chat:' + tabId);
    if (state === current && saved?.pageId === current.pageId && saved.key === current.key
      && saved.destination && saved.destination === destinationOf(activeLlm())
      && saved.shareTranscript === (settings.shareTranscript && current.key.startsWith('video:'))
      && Array.isArray(saved.history) && !history.length && !job) {
      historyDestination = saved.destination;
      historyHasTranscript = saved.shareTranscript;
      history = saved.history;
      for (const turn of history) {
        if (turn.role === 'assistant') renderAnswer(bubble('assistant'), turn.content, linksForTurn(turn), actions);
        else bubble('user', turn.content);
      }
    }
    if (state === current && !current.entry) viewer.showEmpty('Use Collect to load comments from this YouTube page.');
  } catch (error) {
    if (state === current) notice(error.message);
  }
}

function accept(message) {
  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error));
    else request.resolve(message.value);
    return;
  }
  if (message.event === 'page') {
    if (!YTCT.isMediaSource(message.key) || !message.pageId) {
      if (state) resetView(null);
      return;
    }
    if (state?.pageId !== message.pageId || state.key !== message.key) {
      resetView(message);
      viewer.tick(message.media);
      preparePage(state);
    } else {
      state.title = message.title;
      state.progress = message.progress;
      state.dark = message.dark;
      updatePageHeader();
    }
    return;
  }
  if (message.event === 'panel-close') {
    // The side panel can close itself. The background fallback handles a browser that ignores it.
    window.close();
    setTimeout(() => { worker('close-panel').catch(() => { }); }, 300);
    return;
  }
  if (!state || message.key !== state.key) return;
  if (message.event === 'time') viewer.tick(message.media, !!message.seek);
  if (message.event === 'notice') notice(message.text);
  if (message.event === 'export' && message.pageId === state.pageId) {
    receiveEntry(state, message.entry).catch((error) => notice(error.message));
    if (message.notice) notice(message.notice);
  }
  if (message.event === 'export-delta' && message.pageId === state.pageId) {
    mergeDeltaEntry(state, message.delta).catch((error) => notice(error.message));
  }
}

function connect() {
  if (closing || port || !tabId) return;
  clearTimeout(reconnect);
  const connected = chrome.tabs.connect(tabId, { name: 'ytct-tab' });
  port = connected;
  connected.onMessage.addListener(accept);
  connected.onDisconnect.addListener(() => {
    // Reading lastError also suppresses Chrome's warning when a tab is reloading.
    void chrome.runtime.lastError;
    if (port !== connected) return;
    port = null;
    if (!closing) {
      resetView(null);
      reconnect = setTimeout(connect, 750);
    }
  });
}

function connectModel() {
  if (closing || modelPort || !tabId) return;
  const connection = chrome.runtime.connect({ name: 'ytct-model' });
  modelPort = connection;
  connection.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    modelPort = null;
    if (!closing) setTimeout(connectModel, 500);
  });
}

function updateTelemetry(metrics, requested, model, profile) {
  const box = byId('telemetry');
  box.hidden = !settings.debugOllama;
  if (box.hidden) return;
  const target = profile || activeLlm();
  const info = [];
  if (target) info.push((PROVIDERS[target.provider]?.label || target.provider) + ' · ' + target.model);
  info.push(requested.toLocaleString() + ' ctx requested');
  if (target?.provider === 'ollama') {
    if (model?.context_length) info.push(model.context_length.toLocaleString() + ' ctx loaded');
    if (Number.isFinite(model?.size_vram)) {
      const vram = (model.size_vram / 1073741824).toFixed(1);
      const total = model.size > 0 ? ' of ' + (model.size / 1073741824).toFixed(1) : '';
      info.push(vram + total + ' GiB in VRAM');
    }
  }
  if (metrics?.prompt_eval_count) info.push(metrics.prompt_eval_count.toLocaleString() + ' input tokens');
  if (metrics?.eval_count) info.push(metrics.eval_count.toLocaleString() + ' generated tokens');
  if (metrics?.eval_duration > 0 && metrics?.eval_count) info.push((metrics.eval_count * 1e9 / metrics.eval_duration).toFixed(1) + ' tok/s');
  if (metrics?.prompt_eval_duration > 0) info.push((metrics.prompt_eval_duration / 1e9).toFixed(1) + ' s prompt');
  box.textContent = info.join(' · ');
}

function money(value) {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  const digits = value >= 0.01 ? 4 : 6;
  return '$' + value.toFixed(digits).replace(/0+$/, '').replace(/\.$/, '');
}

function updateCost(profile, response) {
  const box = byId('ai-cost');
  if (!profile || providerSpec(profile.provider).local) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  const pricing = profile.pricing || { input: 0, output: 0 };
  if (!pricing.input && !pricing.output) {
    box.hidden = false;
    box.textContent = 'Cost estimate unavailable — set token prices in Settings → LLM.';
    return;
  }
  const usage = response?.usage;
  const prompt = Number(usage?.prompt_tokens) || messageTokens(response?.context?.messages || []);
  const completion = Number(usage?.completion_tokens) || YTCT.estimatedTokens(String(response?.content || ''));
  const promptCost = prompt / 1e6 * pricing.input;
  const answerCost = completion / 1e6 * pricing.output;
  box.hidden = false;
  box.textContent = 'Estimated cost for ' + profile.model + ' · prompt ≈ ' + money(promptCost)
    + ' · answer ≈ ' + money(answerCost)
    + ' · total ≈ ' + money(promptCost + answerCost)
    + ' · ' + prompt.toLocaleString() + ' in / ' + completion.toLocaleString() + ' out tokens';
}

function beginCost(profile) {
  const box = byId('ai-cost');
  if (!profile || providerSpec(profile.provider).local) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  const pricing = profile.pricing || { input: 0, output: 0 };
  box.hidden = false;
  box.textContent = pricing.input || pricing.output
    ? 'Estimating request cost for ' + profile.model + '…'
    : 'Cost estimate unavailable — set token prices in Settings → LLM.';
}

function clearCost() {
  const box = byId('ai-cost');
  box.hidden = true;
  box.textContent = '';
}


function confirmAction(text, label, signal) {
  byId('confirm-description').textContent = text;
  byId('confirm-load').textContent = label;
  byId('confirm').hidden = false;
  return new Promise((resolve) => {
    const accept = () => finish(true);
    const cancel = () => finish(false);
    function finish(value) {
      byId('confirm').hidden = true;
      byId('confirm-load').removeEventListener('click', accept);
      byId('cancel-load').removeEventListener('click', cancel);
      signal.removeEventListener('abort', cancel);
      resolve(value);
    }
    if (signal.aborted) cancel();
    else {
      byId('confirm-load').addEventListener('click', accept);
      byId('cancel-load').addEventListener('click', cancel);
      signal.addEventListener('abort', cancel, { once: true });
      byId('confirm-load').focus();
    }
  });
}

async function confirmSharing(profile, destination, includeTranscript, signal) {
  const scope = JSON.stringify([destination, includeTranscript]);
  if (approvedScopes.has(scope)) return true;
  const endpoint = endpointUrl(profile.endpoint);
  const text = 'Send to ' + canonicalEndpoint(profile.endpoint) + ' (' + profile.model + ')? Ask sends your question, earlier turns for this profile, and source details such as the YouTube link, commenter names, and comment text, including from loaded exports.'
    + (includeTranscript ? ' It may include video captions.' : '')
    + (profile.provider === 'ollama' ? ' It may include a thumbnail or post images.' : '')
    + (isLoopback(endpoint) ? ' Your local server may forward requests to a cloud model.' : ' The provider handles the request under its own terms.');
  if (!await confirmAction(text, 'Send for this visit', signal)) return false;
  approvedScopes.add(scope);
  return true;
}

async function boundedImageBlob(response, maxBytes = 5 * 1024 * 1024) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) return null;
  const type = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) return null;
  if (!response.body) {
    const blob = await response.blob();
    return blob.size > 0 && blob.size <= maxBytes && blob.type.startsWith('image/') ? blob : null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => { });
    reader.releaseLock();
  }
  const blob = new Blob(chunks, { type });
  return blob.size > 0 && blob.size <= maxBytes ? blob : null;
}

async function sourceImages(meta, signal) {
  const urls = meta.kind === 'post' ? (Array.isArray(meta.images) ? meta.images.slice(0, 2) : []) : [meta.thumbnail];
  const images = [];
  for (const raw of urls) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.port || url.username || url.password
        || !['i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname)) continue;
      const response = await fetch(url, {
        credentials: 'omit', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) continue;
      const blob = await boundedImageBlob(response);
      if (!blob) continue;
      const encoded = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
      images.push(encoded);
    } catch { signal.throwIfAborted(); }
  }
  return images;
}

async function ask(question) {
  if (!state?.entry || job || mode !== 'ai' || !question) return;
  const current = state;
  const task = job = { controller: new AbortController() };
  const signal = task.controller.signal;
  const isCurrent = () => job === task && state === current && mode === 'ai' && !signal.aborted;
  const status = (text) => { if (isCurrent()) byId('ai-status').textContent = text; };
  const options = settings;
  let timer;
  let answerNode;
  let asked;
  let success = false;
  setAskExpanded(false);
  askInput.value = '';
  questionDraft = '';
  resizeAskInput();
  updateComposer();
  const profile = activeLlm();
  try {
    await releasePending;
    signal.throwIfAborted();
    if (!profile) throw new Error('Configure an LLM profile in Settings → LLM.');
    const destination = profileDestination(profile);
    if (!await hasHostAccess(profile.endpoint)) throw new Error('Allow network access for this endpoint in Settings → LLM.');
    signal.throwIfAborted();
    const includeTranscript = options.shareTranscript && current.key.startsWith('video:');
    if (!await confirmSharing(profile, destination, includeTranscript, signal)) return;
    signal.throwIfAborted();
    if (historyDestination !== destination || historyHasTranscript !== includeTranscript) {
      history = [];
      chat.replaceChildren();
      historyDestination = destination;
      historyHasTranscript = includeTranscript;
    }
    const contextWindow = effectiveContextWindow(profile, options.contextWindow);
    beginCost(profile);
    let acquired = { resident: null };
    if (profile.provider === 'ollama') {
      status('Checking Ollama…');
      leaseRequested = true;
      acquired = await worker('model-acquire', { profileId: profile.id, destination });
      signal.throwIfAborted();
      status(acquired.resident ? 'Waiting for Ollama…' : 'Loading ' + profile.model + '…');
      updateTelemetry(null, contextWindow, acquired.resident, profile);
    } else {
      if (leaseRequested) await release();
      leaseRequested = false;
      status('Connecting to ' + (PROVIDERS[profile.provider]?.label || profile.provider) + '…');
      updateTelemetry(null, contextWindow, null, profile);
    }
    const entry = current.entry;
    if (includeTranscript && !current.transcript && !current.transcriptTried) {
      current.transcriptTried = true;
      status('Fetching transcript…');
      try {
        const transcript = await tab('transcript');
        signal.throwIfAborted();
        current.transcript = normalizeTranscript(transcript);
        if (!current.transcript) bubble('note', 'Transcript unavailable. ' + (transcript?.reason || ''));
      } catch (error) {
        signal.throwIfAborted();
        bubble('note', 'Transcript unavailable. ' + error.message);
      }
    }
    const meta = entry.snapshot?.metadata || { title: current.title, kind: current.key.split(':')[0] };
    const wantsImages = profile.provider === 'ollama' && contextWindow >= 4096;
    const images = wantsImages ? current.images || await sourceImages(meta, signal) : [];
    signal.throwIfAborted();
    if (wantsImages) current.images = images;
    const session = {
      entry: { ...entry, transcript: includeTranscript ? current.transcript : null },
      meta, key: current.key, contextWindow, commentRows: YTCT.commentRows(entry), images,
    };
    await worker('mark-used', { key: current.key, pageId: current.pageId });
    signal.throwIfAborted();
    asked = bubble('user', question);
    answerNode = bubble('assistant');
    let latest = '';
    let links;
    function display() {
      timer = undefined;
      if (!isCurrent() || !links || !latest) return;
      const atBottom = chat.scrollHeight - chat.clientHeight - chat.scrollTop < 35;
      renderAnswer(answerNode, latest, links, actions);
      if (atBottom) chat.scrollTop = chat.scrollHeight;
    }
    const thinking = profile.thinkingCapabilities?.supported === false ? 'default' : profile.thinking;
    const response = profile.provider === 'ollama'
      ? await askOllama(session, history, question, options, (update) => {
        if (!isCurrent()) return;
        if (update.status) status(update.status);
        if (!update.content) {
          if (update.thinking) status('Thinking…');
          return;
        }
        latest = update.content;
        links = update.links;
        status('Writing answer…');
        if (timer === undefined) timer = setTimeout(display, 75);
      }, signal, { model: profile.model, thinking })
      : await askRemote(session, history, question, options, profile, (update) => {
        if (!isCurrent()) return;
        if (update.status) status(update.status);
        if (!update.content) {
          if (update.thinking) status('Thinking…');
          return;
        }
        latest = update.content;
        links = update.links;
        status('Writing answer…');
        if (timer === undefined) timer = setTimeout(display, 75);
      }, signal);
    if (!isCurrent()) return;
    clearTimeout(timer);
    links = response.context.links;
    latest = response.content;
    display();
    const citations = [...links.comments].filter(([ref]) => latest.includes(ref));
    history.push({ role: 'user', content: question }, {
      role: 'assistant', content: latest,
      duration: links.duration, comments: citations.slice(0, 300),
      authors: [...links.authors].filter(([author]) => latest.toLowerCase().includes('@' + author)).slice(0, 300)
    });
    history = history.slice(-40);
    success = true;
    await chrome.storage.session.set({
      ['chat:' + tabId]: { pageId: current.pageId, key: current.key, destination, shareTranscript: includeTranscript, history },
    }).catch(() => { });
    if (!isCurrent()) return;
    const scope = [];
    if (response.context.truncated) scope.push(response.context.included.toLocaleString() + ' of ' + response.context.total.toLocaleString() + ' source rows sent');
    if (response.context.transcriptTruncated) scope.push('Transcript shortened to fit');
    if (response.context.trimmed) scope.push('Older chat turns omitted from the prompt');
    if (response.metrics?.done_reason === 'length') scope.push('Answer reached the output limit');
    if (scope.length) bubble('note', scope.join(' · '));
    updateCost(profile, response);
    updateTelemetry(response.metrics, contextWindow, acquired.resident, profile);
    if (settings.debugOllama && profile.provider === 'ollama') {
      const model = await loadedModel(profile.model).catch(() => acquired.resident);
      if (isCurrent()) updateTelemetry(response.metrics, contextWindow, model, profile);
    }
    status('Ready');
  } catch (error) {
    if (isCurrent()) {
      if (!answerNode?.textContent) answerNode?.remove();
      bubble('error', error.message);
      status('Couldn’t complete the answer');
      if (profile) clearCost();
      release();
    }
  } finally {
    clearTimeout(timer);
    if (job === task) {
      job = null;
      if (!success && !askInput.value && mode === 'ai') {
        askInput.value = question;
        resizeAskInput();
      }
      updateComposer();
    }
  }
}

async function collect(fresh = false) {
  const current = state;
  if (!current) return;
  try {
    if (current.progress?.running) return await tab('stop');
    const snap = current.entry?.snapshot;
    const partial = snap?.collection?.status === 'partial';
    const limitReached = !!snap?.collection?.limitReached;
    const canIncremental = !fresh && !!snap?.comments?.length && !partial && !limitReached;
    if (canIncremental) {
      const knownIds = [];
      const knownAllIds = [];
      const storedReplies = Object.create(null);
      for (const comment of snap.comments) {
        knownAllIds.push(comment.id);
        if (comment.parent) storedReplies[comment.parent] = (storedReplies[comment.parent] || 0) + 1;
        else knownIds.push(comment.id);
      }
      const knownReplyCounts = Object.create(null);
      for (const comment of snap.comments) {
        if (comment.parent) continue;
        const count = Math.max(storedReplies[comment.id] || 0, YTCT.parseLikes(comment.replyCount));
        if (count > 0) knownReplyCounts[comment.id] = count;
      }
      await tab('collect', {
        refresh: true,
        knownIds,
        knownAllIds,
        knownReplyCounts,
        baselineCount: countBaseline(current.entry),
      });
      return;
    }
    const startFresh = fresh || (!!current.entry && (!partial || limitReached));
    await tab('collect', { fresh: startFresh });
  } catch (error) { if (current === state) notice(error.message); }
}

async function mergeDeltaEntry(current, delta) {
  if (state !== current || !current.entry?.snapshot || !delta) return;
  const base = current.entry.snapshot;
  const updatedCounts = delta.updatedReplyCounts || {};
  const existing = new Set((base.comments || []).map((comment) => comment.id));
  const additions = (delta.comments || []).filter((comment) => comment?.id && !existing.has(comment.id));
  const updatedBase = (base.comments || []).map((comment) => {
    const nextReplyCount = updatedCounts[comment.id];
    return nextReplyCount ? { ...comment, replyCount: nextReplyCount } : comment;
  });
  const comments = [...additions, ...updatedBase].slice(0, 50000);
  const mergedSnapshot = {
    ...base,
    metadata: delta.metadata?.title ? { ...base.metadata, ...delta.metadata } : base.metadata,
    exportedAt: delta.exportedAt || new Date().toISOString(),
    reportedCount: Math.max(Number(delta.reportedCount) || 0, Number(base.reportedCount) || 0, comments.length),
    collection: {
      ...base.collection,
      status: delta.collection?.status === 'complete' && base.collection?.status === 'complete' ? 'complete' : 'partial',
      limitReached: !!base.collection?.limitReached || !!delta.collection?.limitReached || comments.length >= 50000,
    },
    comments,
  };
  const mergedRaw = { ...current.entry, snapshot: mergedSnapshot };
  newCommentsCount = 0;
  if (additions.length > 0) {
    await receiveEntry(current, mergedRaw);
    if (state === current) {
      notice(additions.length === 1 ? 'Added 1 new comment.' : 'Added ' + additions.length.toLocaleString() + ' new comments.');
    }
  } else {
    const normalized = normalizeEntry(current.key, mergedRaw);
    if (state !== current) return;
    current.entry = normalized;
    updatePageHeader();
    startCountPolling(current, false);
    worker('write-cache', { key: current.key, pageId: current.pageId, entry: normalized }).catch(() => { });
    notice('No new comments found.');
  }
}

async function receiveEntry(current, raw) {
  const entry = normalizeEntry(current.key, raw);
  if (state !== current) return;
  adoptEntry(entry);
  const { reason } = await worker('write-cache', { key: current.key, pageId: current.pageId, entry });
  if (reason && state === current) notice(reason);
}

async function loadSavedExport() {
  const current = state;
  if (!current) return;
  try {
    const identity = { key: current.key, pageId: current.pageId, explicit: true };
    const entry = await worker('read-cache', identity);
    if (state !== current) return;
    if (!entry) return settingsError('There is no saved export for this source.');
    adoptEntry(entry, { checkNow: true });
    await worker('mark-used', identity);
    closeSettings();
  } catch (error) { settingsError(error.message); }
}

async function clearSavedExports() {
  if (!window.confirm('Delete all saved comment exports from this browser profile?')) return;
  try {
    await worker('clear-cache');
    byId('cache-usage').textContent = 'Saved exports cleared.';
  } catch (error) { settingsError(error.message); }
}

async function showSettings() {
  try {
    const value = await worker('settings');
    settings = value.settings;
    for (const [name, setting] of Object.entries(settings)) {
      const input = config.elements.namedItem(name);
      if (!input) continue;
      if (input.type === 'checkbox') input.checked = setting;
      else input.value = setting;
    }
    const mb = value.bytes / 1000000;
    byId('cache-usage').textContent = (mb > 0 && mb < .1 ? '<0.1' : mb.toFixed(1)) + ' MB of ' + settings.cacheMB + ' MB used';
    byId('font-scale-value').textContent = settings.fontScale + '%';
    config.elements.namedItem('stackWindow').disabled = !settings.stackComments;
    byId('settings-error').hidden = true;
    await loadLlmConfig();
    llmEditingId = activeLlm()?.id || null;
    llmNewDraft = null;
    llmDirty = false;
    llmKeyClear = false;
    clearLlmKeyReveal();
    setLlmStatus('');
    renderLlmSettings();
    setSettingsTab(settingsTab);
    byId('open-settings').setAttribute('aria-expanded', 'true');
    dialog.showModal();
  } catch (error) { notice(error.message); }
}

async function saveSettings(event) {
  event.preventDefault();
  const values = { ...settings };
  for (const name of Object.keys(YTCT.settingsDefaults)) {
    const input = config.elements.namedItem(name);
    if (!input) continue;
    values[name] = input.type === 'checkbox' ? input.checked : input.value;
  }
  try {
    settings = (await worker('settings', { values })).settings;
    viewer.setSettings(settings);
    byId('telemetry').hidden = !settings.debugOllama;
    closeSettings();
  } catch (error) { settingsError(error.message); }
}

function settingsError(text) {
  byId('settings-error').textContent = text;
  byId('settings-error').hidden = false;
}

// ------------------------------------------------------------------ settings tabs and LLM profiles
function setSettingsTab(name) {
  settingsTab = name === 'llm' ? 'llm' : 'general';
  const llmActive = settingsTab === 'llm';
  if (!llmActive) clearLlmKeyReveal();
  for (const [tab, panel, active] of [
    [byId('settings-tab-general'), byId('settings-general'), !llmActive],
    [byId('settings-tab-llm'), byId('settings-llm'), llmActive],
  ]) {
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
  }
  if (llmActive) renderLlmSettings();
}

function profileOptionLabel(profile) {
  const spec = PROVIDERS[profile.provider] || { label: profile.provider };
  return profile.label + ' — ' + spec.label + ' · ' + (profile.model || 'no model')
    + (profile.hasKey ? ' · ' + maskKey(profile.keyHint) : '');
}

function fillLlmSelect() {
  const select = byId('llm-profile-select');
  const options = [new Option('New profile…', '')];
  for (const profile of [...llm.profiles].sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
    options.push(new Option(profileOptionLabel(profile), profile.id));
  }
  select.replaceChildren(...options);
  select.value = llmEditingId || '';
  byId('llm-delete').disabled = !llmEditingId;
}

function populateProviderSelect() {
  const select = byId('llm-provider');
  const current = select.value;
  const groups = [];
  for (const group of PROVIDER_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = group.label;
    for (const id of group.ids) {
      const spec = PROVIDERS[id];
      if (spec) optgroup.append(new Option(spec.label, id));
    }
    if (optgroup.children.length) groups.push(optgroup);
  }
  select.replaceChildren(...groups);
  if (PROVIDERS[current]) select.value = current;
}

function updateModelDatalist(provider = byId('llm-provider').value) {
  const spec = providerSpec(provider);
  const ids = [...new Set([...(spec.models || []), ...(llmModelsByProvider.get(provider) || [])])];
  const list = byId('llm-model-options');
  list.replaceChildren(...ids.map((id) => {
    const option = document.createElement('option');
    option.value = id;
    return option;
  }));
}

const THINKING_LABELS = {
  default: 'Default (model setting)',
  off: 'Off',
  on: 'On',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

function storeModelMeta(provider, modelMeta) {
  if (!provider || !modelMeta || typeof modelMeta !== 'object') return;
  let map = llmModelMetaByProvider.get(provider);
  if (!map) {
    map = new Map();
    llmModelMetaByProvider.set(provider, map);
  }
  for (const [id, meta] of Object.entries(modelMeta)) {
    if (id && meta) map.set(id, meta);
  }
}

function cachedModelMeta(provider, modelId) {
  const map = llmModelMetaByProvider.get(provider);
  if (!map || !modelId) return null;
  return map.get(modelId) || map.get(modelId + ':latest') || null;
}

function nearestStepIndex(steps, value) {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < steps.length; i++) {
    const diff = Math.abs(steps[i] - value);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

function renderThinkingControls(caps, preferredValue = null) {
  const select = byId('llm-thinking');
  const hint = byId('llm-thinking-hint');
  const previous = preferredValue ?? select.value ?? 'default';
  const thinking = caps?.thinking || { supported: null, levels: ['default', 'off', 'low', 'medium', 'high'] };
  const levels = thinking.levels?.length ? thinking.levels : ['default'];
  select.replaceChildren(...levels.map((level) => new Option(THINKING_LABELS[level] || level, level)));
  select.value = levels.includes(previous) ? previous : 'default';
  select.disabled = thinking.supported === false || levels.length <= 1;
  if (thinking.supported === false) {
    hint.textContent = 'This model does not support configurable thinking.';
    hint.hidden = false;
  } else if (thinking.supported === true && levels.length <= 1) {
    hint.textContent = 'Thinking is controlled automatically by this model.';
    hint.hidden = false;
  } else {
    hint.textContent = '';
    hint.hidden = true;
  }
}

function renderContextControls(provider, caps, preferredValue = null) {
  const autoBox = byId('llm-context-auto');
  const manualBox = byId('llm-context-manual');
  const slider = byId('llm-context-slider');
  const input = byId('llm-context');
  const ticks = byId('llm-context-ticks');
  const hint = byId('llm-context-hint');
  const maxCtx = caps?.contextLength || 0;
  if (isCloudManagedProvider(provider)) {
    manualBox.hidden = true;
    autoBox.hidden = false;
    autoBox.textContent = maxCtx
      ? 'Context limit: automatic from model capabilities (' + formatContextLabel(maxCtx) + ' / ' + maxCtx.toLocaleString() + ' tokens).'
      : 'Context limit: automatic from model capabilities.';
    return;
  }
  autoBox.hidden = true;
  manualBox.hidden = false;
  const sliderTop = maxCtx || 262144;
  llmCurrentSteps = contextSteps(sliderTop, 7);
  const maxBound = maxCtx || 2097152;
  const raw = preferredValue ?? Number(input.value) ?? 32768;
  const clamped = Math.max(1024, Math.min(maxBound, Math.floor(Number(raw) || 32768)));
  input.min = '1024';
  input.max = String(maxBound);
  input.value = String(clamped);
  slider.min = '0';
  slider.max = String(Math.max(0, llmCurrentSteps.length - 1));
  slider.disabled = llmCurrentSteps.length <= 1;
  slider.value = String(nearestStepIndex(llmCurrentSteps, clamped));
  const count = llmCurrentSteps.length;
  ticks.replaceChildren(...llmCurrentSteps.map((step, index) => {
    const span = document.createElement('span');
    span.textContent = formatContextLabel(step);
    span.title = step.toLocaleString() + ' tokens';
    span.style.left = (count > 1 ? (index / (count - 1)) * 100 : 50) + '%';
    span.addEventListener('click', () => {
      slider.value = String(index);
      input.value = String(step);
      llmDirty = true;
    });
    return span;
  }));
  hint.textContent = maxCtx
    ? 'Model maximum: ' + formatContextLabel(maxCtx) + ' (' + maxCtx.toLocaleString() + ' tokens). Drag the slider or enter an exact token limit.'
    : 'Drag the slider for power-of-two stops or enter an exact token limit.';
}

async function refreshModelCapabilities({ queryApi = true, preferredContext = null, preferredThinking = null, fallbackCaps = null } = {}) {
  const provider = byId('llm-provider').value || 'cloud';
  const model = byId('llm-model').value.trim();
  const endpoint = byId('llm-endpoint').value.trim();
  const cached = cachedModelMeta(provider, model);
  const resolved = resolveModelCapabilities(provider, model, cached || fallbackCaps);
  llmCurrentCaps = resolved;
  renderThinkingControls(resolved, preferredThinking);
  renderContextControls(provider, resolved, preferredContext);
  if (!queryApi || !model || !endpoint) return;
  const needsDetail = provider === 'ollama' || provider === 'gemini' || provider === 'llamacpp' || provider === 'lmstudio';
  if (!needsDetail) return;
  const seq = ++llmCapSeq;
  if (!await hasHostAccess(endpoint)) return;
  if (seq !== llmCapSeq) return;
  try {
    const values = readLlmForm();
    const result = await worker('llm-model-info', testPayload(values));
    if (seq !== llmCapSeq || byId('llm-provider').value !== provider || byId('llm-model').value.trim() !== model) return;
    if (result?.capabilities) {
      storeModelMeta(provider, { [model]: result.capabilities });
      llmCurrentCaps = result.capabilities;
      renderThinkingControls(result.capabilities);
      renderContextControls(provider, result.capabilities);
    }
  } catch {
    // Keep resolved fallback capabilities if the optional detail query fails.
  }
}

async function autoPopulateLocalModels(provider = byId('llm-provider').value) {
  const spec = providerSpec(provider);
  if (!spec.local) return;
  const endpoint = byId('llm-endpoint').value.trim() || spec.defaultEndpoint;
  if (!endpoint) return;
  const seq = ++llmLocalFetchSeq;
  if (!await hasHostAccess(endpoint)) return;
  if (seq !== llmLocalFetchSeq || byId('llm-provider').value !== provider) return;
  const values = readLlmForm();
  const saved = llmEditingId ? llm.profiles.find((row) => row.id === llmEditingId) : null;
  const hasKey = !!values.key.trim() || (!!saved?.hasKey && !llmKeyClear && !llmProviderChanged);
  if (spec.keyRequired && !hasKey) return;
  setModelStatus('Loading local models…');
  try {
    const result = await worker('llm-models', testPayload(values));
    if (seq !== llmLocalFetchSeq || byId('llm-provider').value !== provider) return;
    const models = applyModels(result.models, result.provider || provider, result.modelMeta);
    const modelInput = byId('llm-model');
    if (!modelInput.value.trim() && models.length) modelInput.value = models[0];
    if (!noteModelChoice(models)) {
      setModelStatus(models.length
        ? 'Found ' + models.length + ' local model' + (models.length === 1 ? '' : 's') + '.'
        : 'No local models reported yet.');
    }
    await refreshModelCapabilities({ queryApi: true });
  } catch {
    if (seq === llmLocalFetchSeq && byId('llm-provider').value === provider) setModelStatus('');
  }
}

function applyModels(models, provider, modelMeta = null) {
  if (modelMeta) storeModelMeta(provider, modelMeta);
  const list = [...new Set((models || []).filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim()))];
  if (list.length) llmModelsByProvider.set(provider, list);
  updateModelDatalist();
  return list;
}

function noteModelChoice(models) {
  const chosen = byId('llm-model').value.trim();
  if (!models?.length || !chosen || models.includes(chosen)) return false;
  setModelStatus('Connected · ' + models.length + ' models. “' + chosen + '” is not in the provider’s list; select one.', true);
  return true;
}

function setModelStatus(text, error = false) {
  const box = byId('llm-model-status');
  box.textContent = text || '';
  box.classList.toggle('error', !!error);
}

function hideGrant() {
  llmGrantOrigin = '';
  byId('llm-grant').hidden = true;
}

function showGrant(origin) {
  if (!origin) return;
  llmGrantOrigin = origin;
  byId('llm-grant-text').textContent = 'The browser needs one-time network access to ' + origin
    + ' for this endpoint. This grants access to that host only.';
  byId('llm-grant').hidden = false;
}

async function hasHostAccess(endpoint) {
  const pattern = originPattern({ endpoint });
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function ensureFormHost(endpoint) {
  if (!endpoint) {
    setLlmStatus('Enter a base URL first.', true);
    return false;
  }
  let url;
  try {
    url = endpointUrl(endpoint);
  } catch (error) {
    setLlmStatus(error.message, true);
    return false;
  }
  if (await hasHostAccess(endpoint)) {
    hideGrant();
    return true;
  }
  showGrant(url.origin);
  setLlmStatus('Network access is needed for ' + url.origin + '. Use “Grant network access”, then test again.', true);
  return false;
}

function updateLlmProviderUi() {
  const provider = byId('llm-provider').value || 'cloud';
  const spec = providerSpec(provider);
  const endpoint = byId('llm-endpoint');
  endpoint.readOnly = provider === 'ollama';
  endpoint.placeholder = spec.defaultEndpoint || 'https://api.example.com/v1';
  byId('llm-model').placeholder = spec.defaultModel || 'model-id';
  byId('llm-pricing').hidden = spec.local;
  byId('llm-key').placeholder = spec.keyRequired ? 'API key' : 'Optional API key';
  if (provider === 'ollama') endpoint.value = spec.defaultEndpoint;
  byId('llm-provider-hint').textContent = spec.help || '';
  byId('llm-endpoint-hint').textContent = spec.defaultEndpoint
    ? 'Default endpoint for ' + spec.label + ': ' + spec.defaultEndpoint
    : '';
  const signup = byId('llm-signup');
  if (spec.signupUrl) {
    signup.href = spec.signupUrl;
    signup.textContent = 'Get an API key for ' + spec.label;
    signup.hidden = false;
  } else {
    signup.removeAttribute('href');
    signup.hidden = true;
  }
  updateModelDatalist(provider);
}

function fillLlmForm(profile, isNew = false) {
  const draft = profile || defaultProfile('cloud');
  const provider = PROVIDERS[draft.provider] ? draft.provider : 'cloud';
  const spec = providerSpec(provider);
  byId('llm-form-title').textContent = isNew ? 'New profile' : 'Profile details';
  byId('llm-label').value = isNew ? '' : (draft.label || '');
  byId('llm-provider').value = provider;
  byId('llm-endpoint').value = draft.endpoint || spec.defaultEndpoint;
  byId('llm-model').value = draft.model || '';
  byId('llm-input-price').value = draft.pricing?.input ?? 0;
  byId('llm-output-price').value = draft.pricing?.output ?? 0;
  byId('llm-assistant-name').value = draft.name || '';
  const derived = assistantLabel({ version: 1, activeProfileId: draft.id, profiles: [{ ...draft, name: '' }] });
  byId('llm-assistant-name').placeholder = derived || 'LLM';
  byId('llm-key').value = '';
  llmKeyClear = false;
  llmProviderChanged = false;
  const sameGrantOrigin = llmGrantOrigin
    && providerOrigin({ endpoint: draft.endpoint || spec.defaultEndpoint }) === llmGrantOrigin;
  if (!sameGrantOrigin) hideGrant();
  clearLlmKeyReveal();
  setModelStatus('');
  const saved = !isNew && !!draft.hasKey;
  byId('llm-key-mask').textContent = saved ? 'Saved key ' + maskKey(draft.keyHint) : 'No saved key';
  byId('llm-reveal').disabled = !saved;
  byId('llm-copy').disabled = !saved;
  byId('llm-clear-key').disabled = !saved;
  updateLlmProviderUi();
  if (saved) byId('llm-key').placeholder = 'Leave blank to keep ' + maskKey(draft.keyHint);
  refreshModelCapabilities({
    queryApi: !isNew || spec.local,
    preferredContext: draft.contextWindow || 32768,
    preferredThinking: draft.thinking || 'default',
    fallbackCaps: {
      contextLength: draft.maxContext || 0,
      thinking: draft.thinkingCapabilities || null,
    },
  });
  const endpoint = byId('llm-endpoint').value;
  if (endpoint && (!isNew || spec.local)) {
    hasHostAccess(endpoint).then((allowed) => {
      if (byId('llm-provider').value !== provider || byId('llm-endpoint').value !== endpoint) return;
      if (!allowed) {
        if (isNew || llmEditingId === draft.id) showGrant(providerOrigin({ endpoint }));
      } else if (spec.local) {
        autoPopulateLocalModels(provider);
      }
    });
  }
  llmDirty = false;
}

function renderLlmSettings() {
  fillLlmSelect();
  if (llmDirty) return;
  const profile = llmEditingId ? llm.profiles.find((row) => row.id === llmEditingId) : null;
  if (profile) {
    fillLlmForm(profile);
    return;
  }
  if (llmEditingId === null) {
    llmNewDraft ||= defaultProfile('cloud');
    llmNewDraft.label = '';
    fillLlmForm(llmNewDraft, true);
  }
}

function newLlmProfile() {
  llmEditingId = null;
  llmNewDraft = defaultProfile('cloud');
  llmNewDraft.label = '';
  llmKeyClear = false;
  llmProviderChanged = false;
  fillLlmForm(llmNewDraft, true);
  fillLlmSelect();
  setLlmStatus('New profile. Pick a provider, enter its details, then save or test.');
}

async function activateLlmProfileById(id) {
  try {
    setLlmStatus('Switching profile…');
    const result = await worker('llm-activate', { id });
    setLlmConfig(result.config);
    llmEditingId = result.profileId;
    llmNewDraft = null;
    llmDirty = false;
    llmKeyClear = false;
    llmProviderChanged = false;
    applyAssistantName();
    fillLlmSelect();
    const profile = llm.profiles.find((row) => row.id === result.profileId);
    if (profile) fillLlmForm(profile);
    clearCost();
    setLlmStatus('Using ' + (profile?.label || 'saved profile') + '.');
    if (activeLlm()?.provider !== 'ollama' && leaseRequested && !job) release();
  } catch (error) {
    setLlmStatus(error.message, true);
    fillLlmSelect();
  }
}

function applyProviderChange() {
  clearLlmKeyReveal();
  const provider = byId('llm-provider').value || 'cloud';
  const spec = providerSpec(provider);
  const saved = llmEditingId ? llm.profiles.find((row) => row.id === llmEditingId) : null;
  llmProviderChanged = !!saved && saved.provider !== provider;
  byId('llm-endpoint').value = spec.defaultEndpoint;
  byId('llm-model').value = spec.defaultModel;
  byId('llm-key').value = '';
  if (llmProviderChanged) {
    llmKeyClear = true;
    byId('llm-key-mask').textContent = 'Enter a key for ' + spec.label + '; the previous key is removed on save';
    byId('llm-key').placeholder = 'API key for ' + spec.label;
    byId('llm-reveal').disabled = true;
    byId('llm-copy').disabled = true;
    byId('llm-clear-key').disabled = true;
  } else if (saved) {
    llmKeyClear = false;
    byId('llm-key-mask').textContent = saved.hasKey ? 'Saved key ' + maskKey(saved.keyHint) : 'No saved key';
    byId('llm-key').placeholder = saved.hasKey ? 'Leave blank to keep ' + maskKey(saved.keyHint) : 'API key';
    byId('llm-reveal').disabled = !saved.hasKey;
    byId('llm-copy').disabled = !saved.hasKey;
    byId('llm-clear-key').disabled = !saved.hasKey;
  } else {
    llmKeyClear = false;
    byId('llm-key-mask').textContent = 'No saved key';
    byId('llm-key').placeholder = spec.keyRequired ? 'API key' : 'Optional API key';
    byId('llm-reveal').disabled = true;
    byId('llm-copy').disabled = true;
    byId('llm-clear-key').disabled = true;
  }
  if (!byId('llm-label').value.trim()) byId('llm-label').value = spec.label;
  updateLlmProviderUi();
  setModelStatus('');
  hideGrant();
  refreshModelCapabilities({ queryApi: false, preferredContext: 32768, preferredThinking: 'default' });
  if (spec.local && spec.defaultEndpoint) {
    hasHostAccess(spec.defaultEndpoint).then((allowed) => {
      if (byId('llm-provider').value !== provider) return;
      if (allowed) autoPopulateLocalModels(provider);
      else showGrant(providerOrigin({ endpoint: spec.defaultEndpoint }));
    });
  } else if (spec.defaultEndpoint && byId('llm-model').value.trim()) {
    refreshModelCapabilities({ queryApi: true });
  }
  llmDirty = true;
}

function draftProfileForTest(values) {
  const spec = providerSpec(values.provider);
  return {
    id: llmEditingId || undefined,
    label: values.label || spec.label,
    name: values.assistantName,
    provider: values.provider,
    endpoint: values.endpoint,
    model: values.model || spec.defaultModel,
    thinking: values.thinking,
    contextWindow: values.contextWindow,
    maxContext: values.maxContext,
    thinkingCapabilities: values.thinkingCapabilities,
    pricing: values.pricing,
  };
}

function testPayload(values) {
  return {
    profile: draftProfileForTest(values),
    key: values.key.trim() || undefined,
    profileId: llmEditingId && !llmKeyClear && !llmProviderChanged ? llmEditingId : undefined,
  };
}

async function loadModels() {
  if (llmTesting) return;
  const values = readLlmForm();
  if (!await ensureFormHost(values.endpoint)) return;
  const button = byId('llm-load-models');
  const old = button.textContent;
  llmTesting = true;
  button.disabled = true;
  button.textContent = 'Loading…';
  setModelStatus('Loading models…');
  try {
    const result = await worker('llm-models', testPayload(values));
    const models = applyModels(result.models, result.provider || values.provider, result.modelMeta);
    if (!byId('llm-model').value && models.length) byId('llm-model').value = models[0];
    const warned = noteModelChoice(models);
    if (!warned) {
      setModelStatus(models.length
        ? 'Loaded ' + models.length + ' model' + (models.length === 1 ? '' : 's') + '.'
        : 'No models returned. Enter a model ID manually.');
    }
    setLlmStatus('Model list loaded from ' + providerSpec(values.provider).label + '.');
    await refreshModelCapabilities({ queryApi: true });
  } catch (error) {
    setModelStatus(error.message, true);
    setLlmStatus(error.message, true);
    if (/host access/i.test(error.message)) showGrant(providerOrigin({ endpoint: values.endpoint }));
  } finally {
    llmTesting = false;
    button.disabled = false;
    button.textContent = old;
  }
}

async function testConnection() {
  if (llmTesting) return;
  const values = readLlmForm();
  if (!await ensureFormHost(values.endpoint)) return;
  const button = byId('llm-test');
  const old = button.textContent;
  llmTesting = true;
  button.disabled = true;
  button.textContent = 'Testing…';
  setLlmStatus('Testing ' + providerSpec(values.provider).label + '…');
  try {
    const result = await worker('llm-test', testPayload(values));
    applyModels(result.models, result.provider || values.provider, result.modelMeta);
    if (!byId('llm-model').value && result.models?.length) byId('llm-model').value = result.models[0];
    setModelStatus(result.mode === 'chat'
      ? 'The selected model answered a test request.'
      : 'Ollama is reachable and lists the selected model.');
    setLlmStatus('Connected to ' + providerSpec(values.provider).label + '.');
    await refreshModelCapabilities({ queryApi: true });
  } catch (error) {
    setLlmStatus(error.message, true);
    if (/host access/i.test(error.message)) showGrant(providerOrigin({ endpoint: values.endpoint }));
  } finally {
    llmTesting = false;
    button.disabled = false;
    button.textContent = old;
  }
}

async function showSavedStatus(profile) {
  if (!await hasHostAccess(profile.endpoint)) {
    showGrant(providerOrigin(profile));
    setLlmStatus('Saved ' + profile.label + '. Grant network access for ' + providerOrigin(profile) + ' to connect.', true);
    return;
  }
  setLlmStatus('Saved ' + profile.label + '. Choose Test to check the connection.');
}

function readLlmForm() {
  const provider = byId('llm-provider').value;
  let endpoint = byId('llm-endpoint').value.trim();
  if (provider === 'ollama') endpoint = 'http://127.0.0.1:11434';
  const contextWindow = isCloudManagedProvider(provider)
    ? 0
    : Math.max(1024, Math.floor(Number(byId('llm-context').value) || 32768));
  return {
    provider,
    endpoint,
    label: byId('llm-label').value.trim(),
    model: byId('llm-model').value.trim(),
    thinking: byId('llm-thinking').value || 'default',
    contextWindow,
    maxContext: llmCurrentCaps?.contextLength || 0,
    thinkingCapabilities: llmCurrentCaps?.thinking || undefined,
    pricing: {
      input: Math.max(0, Number(byId('llm-input-price').value) || 0),
      output: Math.max(0, Number(byId('llm-output-price').value) || 0),
    },
    key: byId('llm-key').value,
    assistantName: byId('llm-assistant-name').value,
  };
}

async function saveLlm() {
  const values = readLlmForm();
  const spec = providerSpec(values.provider);
  if (!values.model) {
    setLlmStatus('Enter or load a model name.', true);
    return;
  }
  try {
    values.endpoint = canonicalEndpoint(values.endpoint);
  } catch (error) {
    setLlmStatus(error.message, true);
    return;
  }
  try {
    setLlmStatus('Saving…');
    const result = await worker('llm-save-profile', {
      profile: {
        id: llmEditingId || undefined,
        label: values.label || spec.label,
        provider: values.provider,
        endpoint: values.endpoint,
        model: values.model,
        thinking: values.thinking,
        contextWindow: values.contextWindow,
        maxContext: values.maxContext,
        thinkingCapabilities: values.thinkingCapabilities,
        pricing: values.pricing,
      },
      key: values.key.trim() || undefined,
      clearKey: llmKeyClear || (llmProviderChanged && !values.key.trim()),
      assistantName: values.assistantName,
    });
    setLlmConfig(result.config);
    llmEditingId = result.profileId;
    llmNewDraft = null;
    llmDirty = false;
    llmKeyClear = false;
    llmProviderChanged = false;
    applyAssistantName();
    fillLlmSelect();
    const profile = llm.profiles.find((row) => row.id === result.profileId);
    if (profile) fillLlmForm(profile);
    clearCost();
    if (activeLlm()?.provider !== 'ollama' && leaseRequested && !job) release();
    if (!profile) {
      setLlmStatus('Saved profile.');
      return;
    }
    await showSavedStatus(profile);
  } catch (error) {
    setLlmStatus(error.message, true);
  }
}

async function deleteLlmProfile() {
  if (!llmEditingId) {
    setLlmStatus('Select a saved profile first.', true);
    return;
  }
  const profile = llm.profiles.find((row) => row.id === llmEditingId);
  if (!profile) return;
  if (!window.confirm('Delete the saved LLM profile “' + profile.label + '”?')) return;
  try {
    const result = await worker('llm-delete', { id: llmEditingId });
    setLlmConfig(result.config);
    llmEditingId = result.profileId || null;
    llmNewDraft = llmEditingId ? null : defaultProfile('cloud');
    if (llmNewDraft) llmNewDraft.label = '';
    llmDirty = false;
    llmKeyClear = false;
    applyAssistantName();
    fillLlmSelect();
    const active = result.profileId ? llm.profiles.find((row) => row.id === result.profileId) : null;
    if (active) fillLlmForm(active);
    else fillLlmForm(llmNewDraft, true);
    clearCost();
    setLlmStatus('Deleted the profile.');
    if (activeLlm()?.provider !== 'ollama' && leaseRequested && !job) release();
  } catch (error) {
    setLlmStatus(error.message, true);
  }
}

function clearLlmKeyReveal() {
  clearTimeout(llmRevealTimer);
  llmRevealTimer = null;
  const value = byId('llm-key-value');
  if (!value) return;
  value.textContent = '';
  value.hidden = true;
}

async function revealLlmKey() {
  if (!llmEditingId) {
    setLlmStatus('Save the profile before revealing its key.', true);
    return;
  }
  const id = llmEditingId;
  try {
    const result = await worker('llm-reveal-key', { id });
    if (llmEditingId !== id || !dialog.open || settingsTab !== 'llm' || byId('llm-reveal').disabled) return;
    const value = byId('llm-key-value');
    value.textContent = result.key;
    value.hidden = false;
    clearTimeout(llmRevealTimer);
    llmRevealTimer = setTimeout(clearLlmKeyReveal, 30000);
    setLlmStatus('Key revealed for 30 seconds. Hide it when you are done.');
  } catch (error) {
    setLlmStatus(error.message, true);
  }
}

async function copyLlmKey() {
  if (!llmEditingId) {
    setLlmStatus('Save the profile before copying its key.', true);
    return;
  }
  const id = llmEditingId;
  try {
    const result = await worker('llm-reveal-key', { id });
    if (llmEditingId !== id || !dialog.open || settingsTab !== 'llm' || byId('llm-copy').disabled) return;
    await navigator.clipboard.writeText(result.key);
    setLlmStatus('API key copied to the clipboard.');
  } catch (error) {
    setLlmStatus(error.message, true);
  }
}

function setLlmStatus(text, error = false) {
  const box = byId('llm-status');
  box.textContent = text || '';
  box.classList.toggle('error', !!error);
}

function closeSettings() {
  clearLlmKeyReveal();
  hideGrant();
  byId('llm-key').value = '';
  dialog.close();
}


async function importFile(file) {
  if (!file || !state) return;
  const current = state;
  try {
    if (file.size > YTCT.maxEntryBytes) throw new Error('Choose an export up to 8 MiB.');
    const text = await file.text();
    const stem = YTCT.sanitizeName(file.name.replace(/\.(md|markdown|json)$/i, ''), 180) || 'youtube-comments';
    const rawEntry = /\.json$/i.test(file.name)
      ? { stem, snapshot: JSON.parse(text.replace(/^\uFEFF/, '')) } : { stem, markdown: text };
    await receiveEntry(current, rawEntry);
    if (state === current) closeSettings();
  } catch (error) { settingsError(error.message); }
}

// ---- Ask panel height ----
const askSection = byId('ai');
const askHandle = byId('ai-resize');
const ASK_MIN = 110;
const askMax = () => Math.max(ASK_MIN, Math.min(window.innerHeight - 290, window.innerHeight * 0.85));
let askHeight = Math.min(window.innerHeight * 0.41, 310);
let askDrag = null;

function setAskHeight(height, persist = false) {
  askHeight = Math.round(Math.min(askMax(), Math.max(ASK_MIN, Number(height) || ASK_MIN)));
  askSection.style.height = askHeight + 'px';
  askHandle.setAttribute('aria-valuenow', String(askHeight));
  askHandle.setAttribute('aria-valuemax', String(Math.round(askMax())));
  if (persist) {
    try { localStorage.setItem('ytct-ask-height', String(askHeight)); } catch { }
  }
  return askHeight;
}

try {
  const stored = Number(localStorage.getItem('ytct-ask-height'));
  if (Number.isFinite(stored) && stored > 0) askHeight = stored;
} catch { }
setAskHeight(askHeight);

askHandle.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  askDrag = { id: event.pointerId, y: event.clientY, height: askSection.getBoundingClientRect().height || askHeight };
  try { askHandle.setPointerCapture(event.pointerId); } catch { }
  event.preventDefault();
});
askHandle.addEventListener('pointermove', (event) => {
  if (!askDrag || event.pointerId !== askDrag.id) return;
  setAskHeight(askDrag.height + askDrag.y - event.clientY);
});
function endAskDrag(event) {
  if (!askDrag || (event && event.pointerId !== askDrag.id)) return;
  askDrag = null;
  try { askHandle.releasePointerCapture(event.pointerId); } catch { }
  setAskHeight(askHeight, true);
}
askHandle.addEventListener('pointerup', endAskDrag);
askHandle.addEventListener('pointercancel', endAskDrag);
askHandle.addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 48 : 16;
  if (event.key === 'ArrowUp') { setAskHeight(askHeight + step, true); event.preventDefault(); }
  else if (event.key === 'ArrowDown') { setAskHeight(askHeight - step, true); event.preventDefault(); }
});
window.addEventListener('resize', () => {
  setAskHeight(askHeight);
  resizeAskInput();
});

byId('search-mode').addEventListener('click', () => setMode('search'));
byId('ai-mode').addEventListener('click', () => setMode('ai'));
expandAskBtn.addEventListener('click', () => {
  setAskExpanded(!askExpanded);
  askInput.focus();
});
byId('collect').addEventListener('click', () => collect());
byId('clear-chat').addEventListener('click', () => { approvedScopes.clear(); clearChat(); });
byId('load-saved-export').addEventListener('click', loadSavedExport);
byId('clear-cache').addEventListener('click', clearSavedExports);
byId('collect-fresh').addEventListener('click', () => { closeSettings(); collect(true); });
byId('open-settings').addEventListener('click', showSettings);
byId('close-settings').addEventListener('click', closeSettings);
dialog.addEventListener('close', () => {
  byId('open-settings').setAttribute('aria-expanded', 'false');
  // Undo any unsaved scale preview.
  byId('font-scale-value').textContent = settings.fontScale + '%';
  viewer.setScale(settings.fontScale);
  resizeAskInput();
  // Never leave a revealed key in the DOM after the dialog closes.
  clearLlmKeyReveal();
  byId('llm-key').value = '';
});
config.elements.namedItem('fontScale').addEventListener('input', (event) => {
  byId('font-scale-value').textContent = event.target.value + '%';
  viewer.setScale(Number(event.target.value));
  resizeAskInput();
});
config.elements.namedItem('stackComments').addEventListener('change', (event) => { config.elements.namedItem('stackWindow').disabled = !event.target.checked; });
config.addEventListener('submit', (event) => {
  if (settingsTab === 'llm') {
    event.preventDefault();
    saveLlm();
  } else {
    saveSettings(event);
  }
});

// Settings tabs
for (const tab of [byId('settings-tab-general'), byId('settings-tab-llm')]) {
  tab.addEventListener('click', () => setSettingsTab(tab.id === 'settings-tab-llm' ? 'llm' : 'general'));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = tab.id === 'settings-tab-general' ? byId('settings-tab-llm') : byId('settings-tab-general');
    setSettingsTab(next.id === 'settings-tab-llm' ? 'llm' : 'general');
    next.focus();
  });
}

// LLM profile controls
byId('settings-llm').addEventListener('input', () => { llmDirty = true; });
byId('settings-llm').addEventListener('change', () => { llmDirty = true; });
byId('llm-provider').addEventListener('change', applyProviderChange);
byId('llm-model').addEventListener('input', () => {
  clearTimeout(llmModelDebounce);
  llmModelDebounce = setTimeout(() => refreshModelCapabilities({ queryApi: true }), 250);
});
byId('llm-model').addEventListener('change', () => {
  clearTimeout(llmModelDebounce);
  refreshModelCapabilities({ queryApi: true });
});
byId('llm-context-slider').addEventListener('input', () => {
  const step = llmCurrentSteps[Number(byId('llm-context-slider').value)];
  if (step) byId('llm-context').value = String(step);
  llmDirty = true;
});
byId('llm-context').addEventListener('input', () => {
  const value = Number(byId('llm-context').value);
  if (Number.isFinite(value) && value >= 1024) {
    byId('llm-context-slider').value = String(nearestStepIndex(llmCurrentSteps, value));
  }
  llmDirty = true;
});
byId('llm-context').addEventListener('change', () => {
  const input = byId('llm-context');
  const maxBound = Number(input.max) || 2097152;
  const clamped = Math.max(1024, Math.min(maxBound, Math.floor(Number(input.value) || 32768)));
  input.value = String(clamped);
  byId('llm-context-slider').value = String(nearestStepIndex(llmCurrentSteps, clamped));
});
byId('llm-endpoint').addEventListener('change', () => {
  const provider = byId('llm-provider').value;
  if (providerSpec(provider).local) autoPopulateLocalModels(provider);
});
byId('llm-endpoint').addEventListener('input', () => {
  if (llmGrantOrigin && providerOrigin({ endpoint: byId('llm-endpoint').value }) !== llmGrantOrigin) hideGrant();
  clearLlmKeyReveal();
  if (byId('llm-key').value) {
    byId('llm-key').value = '';
    setLlmStatus('The endpoint changed. Re-enter the key for this destination.');
  }
  const saved = llm.profiles.find((row) => row.id === llmEditingId);
  const endpoint = byId('llm-endpoint').value.trim();
  let changed = true;
  try { changed = canonicalEndpoint(endpoint) !== canonicalEndpoint(saved?.endpoint); } catch { }
  if (saved?.hasKey && !llmProviderChanged) {
    const keep = !changed && !llmKeyClear;
    byId('llm-reveal').disabled = !keep;
    byId('llm-copy').disabled = !keep;
    byId('llm-key-mask').textContent = changed ? 'Enter a key for the new endpoint.' : 'Saved key ' + maskKey(saved.keyHint);
    byId('llm-key').placeholder = keep ? 'Leave blank to keep ' + maskKey(saved.keyHint) : 'API key';
  }
  llmDirty = true;
});
byId('llm-load-models').addEventListener('click', loadModels);
byId('llm-test').addEventListener('click', testConnection);
byId('llm-grant-button').addEventListener('click', () => {
  if (!llmGrantOrigin) return;
  chrome.tabs.create({
    url: chrome.runtime.getURL('permissions.html?origin=' + encodeURIComponent(llmGrantOrigin)),
  }).catch((error) => setLlmStatus('Could not open the permission tab: ' + error.message, true));
  setLlmStatus('Opened a permission tab. Grant access there, then return and test again.');
});
chrome.permissions.onAdded.addListener(async () => {
  const origin = llmGrantOrigin;
  if (!origin || !await hasHostAccess(origin) || llmGrantOrigin !== origin) return;
  hideGrant();
  const provider = byId('llm-provider').value;
  if (providerSpec(provider).local && providerOrigin({ endpoint: byId('llm-endpoint').value }) === origin) {
    setLlmStatus('Access granted for ' + origin + '. Loading local models…');
    autoPopulateLocalModels(provider);
  } else {
    setLlmStatus('Access granted for ' + origin + '. Choose Test to check the connection.');
  }
});
byId('llm-profile-select').addEventListener('change', (event) => {
  if (!event.target.value) newLlmProfile();
  else activateLlmProfileById(event.target.value);
});
byId('llm-new').addEventListener('click', newLlmProfile);
byId('llm-delete').addEventListener('click', deleteLlmProfile);
byId('llm-save').addEventListener('click', saveLlm);
byId('llm-key').addEventListener('input', () => {
  if (byId('llm-key').value.trim()) {
    llmKeyClear = false;
    const profile = llm.profiles.find((row) => row.id === llmEditingId);
    byId('llm-key-mask').textContent = profile?.hasKey && !llmProviderChanged
      ? 'New key will replace ' + maskKey(profile.keyHint)
      : 'New key will be saved';
  }
  llmDirty = true;
});
byId('llm-reveal').addEventListener('click', revealLlmKey);
byId('llm-copy').addEventListener('click', copyLlmKey);
byId('llm-clear-key').addEventListener('click', () => {
  if (!llmEditingId) {
    setLlmStatus('Select a saved profile first.', true);
    return;
  }
  llmKeyClear = true;
  clearLlmKeyReveal();
  byId('llm-key-mask').textContent = 'Key will be removed when saved';
  byId('llm-reveal').disabled = true;
  byId('llm-copy').disabled = true;
  setLlmStatus('The saved key will be removed when you save this profile.');
});
byId('import-export').addEventListener('click', () => byId('import-file').click());
byId('import-file').addEventListener('change', (event) => {
  importFile(event.target.files[0]);
  event.target.value = '';
});
query.addEventListener('input', () => {
  updateComposer();
  if (mode !== 'search') return;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => viewer.setQuery(query.value), 100);
});
askInput.addEventListener('input', () => {
  resizeAskInput();
  updateComposer();
});
askInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && askExpanded) {
    event.preventDefault();
    setAskExpanded(false);
    return;
  }
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!byId('send').disabled) ask(askInput.value.trim());
  }
});
byId('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  if (mode === 'ai') ask(askInput.value.trim());
  else viewer.setQuery(query.value);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings?.newValue) {
    settings = changes.settings.newValue;
    viewer.setSettings(settings);
  }
  if (changes.llmConfig?.newValue) loadLlmConfig();
});
chrome.tabs.onUpdated.addListener((id, change) => { if (id === tabId && change.status === 'complete') connect(); });
chrome.tabs.onRemoved.addListener((id) => { if (id === tabId) window.close(); });
window.addEventListener('pagehide', () => {
  closing = true;
  stopCountPolling();
  clearLlmKeyReveal();
  byId('llm-key').value = '';
  stopAsking();
  modelPort?.disconnect();
  port?.disconnect();
});

populateProviderSelect();
resetView(null);
if (tabId > 0) {
  connect();
  connectModel();
  worker('settings').then((value) => { settings = value.settings; viewer.setSettings(settings); }).catch((error) => notice(error.message));
  loadLlmConfig();
} else {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && YTCT.isMediaSource(YTCT.sourceKey(active.url))) location.replace('sidepanel.html?tab=' + active.id);
}
