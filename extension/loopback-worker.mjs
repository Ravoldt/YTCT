import { ensureOffscreen } from './offscreen-worker.mjs';

export const OLLAMA_ORIGIN = 'http://127.0.0.1:11434/*';
const LOOPBACK_SCRIPT_ID = 'ytct-ollama-loopback';
let bridge;
let opening;
let ready;
const operations = new Map();

export async function hasOllamaAccess() {
  try {
    return await chrome.permissions.contains({ origins: [OLLAMA_ORIGIN] });
  } catch {
    return false;
  }
}

async function ensureLoopbackScript() {
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [LOOPBACK_SCRIPT_ID] });
  if (existing.length) return false;
  const spec = {
    id: LOOPBACK_SCRIPT_ID,
    matches: [OLLAMA_ORIGIN],
    js: ['loopback-frame.js'],
    allFrames: true,
    runAt: 'document_start',
    persistAcrossSessions: false,
  };
  try {
    await chrome.scripting.registerContentScripts([spec]);
  } catch {
    await chrome.scripting.registerContentScripts([{ ...spec, matches: ['http://127.0.0.1/*'] }]);
  }
  return true;
}

export async function teardownLoopback() {
  if (await hasOllamaAccess()) return;
  await chrome.scripting.unregisterContentScripts({ ids: [LOOPBACK_SCRIPT_ID] }).catch(() => {});
  if (bridge) {
    const active = bridge;
    bridge = null;
    try { active.disconnect(); } catch {}
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL('loopback.html')],
  }).catch(() => []);
  if (contexts.length) await chrome.runtime.sendMessage({ type: 'ytct-loopback-close' }).catch(() => {});
}

export function connectLoopback(port) {
  if (port.sender?.id !== chrome.runtime.id || port.sender.url !== 'http://127.0.0.1:11434/' || port.sender.tab) {
    try { port.disconnect(); } catch {}
    return;
  }
  bridge = port;
  port.onMessage.addListener((message) => {
    const operation = operations.get(message.id);
    if (operation?.port !== port || message.type === 'working') return;
    if (message.type === 'end' || message.type === 'error') operations.delete(message.id);
    operation.receive(message);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (bridge === port) bridge = null;
    for (const [id, operation] of operations) {
      if (operation.port !== port) continue;
      operations.delete(id);
      operation.receive({ type: 'error', error: 'The local Ollama connection closed. Try again.' });
    }
  });
  ready?.(port);
}

function ensureBridge() {
  if (bridge) return Promise.resolve(bridge);
  if (opening) return opening;
  const connected = Promise.withResolvers();
  ready = connected.resolve;
  opening = (async () => {
    const timer = setTimeout(() => connected.reject(new Error('Chrome could not connect to Ollama on port 11434.')), 8000);
    // The document can outlive a suspended worker. Wake its existing iframe in that case.
    const setup = (async () => {
      if (!await hasOllamaAccess()) {
        const error = new Error('Host access is missing for http://127.0.0.1:11434. Open “Grant network access” in Settings → LLM, then try again.');
        error.code = 'HOST_ACCESS';
        throw error;
      }
      const registeredNow = await ensureLoopbackScript();
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ type: 'ytct-loopback-wake', reset: registeredNow });
    })();
    setup.catch(connected.reject);
    try {
      return await connected.promise;
    } finally {
      clearTimeout(timer);
      ready = null;
      opening = null;
    }
  })();
  return opening;
}

export function relayLoopback(path, payload, receive) {
  const id = crypto.randomUUID();
  let canceled = false;
  ensureBridge().then((port) => {
    if (canceled) return;
    operations.set(id, { port, receive });
    port.postMessage({ id, type: 'start', path, payload });
  }).catch((error) => {
    operations.delete(id);
    if (!canceled) receive({ type: 'error', error: error.message });
  });
  return () => {
    canceled = true;
    const operation = operations.get(id);
    if (!operation) return;
    operations.delete(id);
    if (operation.port === bridge) {
      try { operation.port.postMessage({ id, type: 'cancel' }); } catch {}
    }
  };
}
