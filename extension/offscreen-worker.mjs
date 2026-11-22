const offscreenPath = 'loopback.html';
let creating;
let connection;
const pending = new Map();

export function ensureOffscreen() {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(offscreenPath)],
    });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: offscreenPath,
      reasons: ['IFRAME_SCRIPTING', 'BLOBS', 'WORKERS'],
      justification: 'Connect to Ollama, create download blobs, and run provider requests in a dedicated worker.',
    });
  })().finally(() => { creating = null; });
  return creating;
}

export function connectOffscreen(port) {
  if (port.sender?.id !== chrome.runtime.id || port.sender?.url !== chrome.runtime.getURL(offscreenPath) || port.sender.tab) {
    try { port.disconnect(); } catch {}
    return;
  }
  connection = port;
  port.onMessage.addListener(({ id, ...message }) => {
    const operation = pending.get(id);
    if (!operation || operation.port !== port || message.type === 'working') return;
    if (message.type === 'done' || message.type === 'error') pending.delete(id);
    operation.receive(message);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (connection === port) connection = null;
    for (const [id, operation] of pending) {
      if (operation.port !== port) continue;
      pending.delete(id);
      operation.receive({ type: 'error', error: 'The extension connection closed. Try again.' });
    }
  });
}

export function relayOffscreen(type, payload, receive) {
  const id = crypto.randomUUID();
  let canceled = false;
  (async () => {
    await ensureOffscreen();
    if (!connection) await chrome.runtime.sendMessage({ type: 'ytct-offscreen-wake' });
    for (let attempt = 0; !connection && !canceled && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (canceled) return;
    if (!connection) throw new Error('The extension could not open its background document.');
    const port = connection;
    pending.set(id, { port, receive });
    port.postMessage({ id, type, payload });
  })().catch((error) => {
    pending.delete(id);
    if (!canceled) receive({ type: 'error', error: error.message });
  });
  return () => {
    canceled = true;
    const operation = pending.get(id);
    if (!operation) return;
    pending.delete(id);
    try { operation.port.postMessage({ id, type: 'cancel' }); } catch {}
  };
}

export function saveDownload(entry, format) {
  return new Promise((resolve, reject) => {
    relayOffscreen('download', { entry, format }, (message) => {
      if (message.type === 'done') resolve(true);
      if (message.type === 'error') reject(new Error(message.error));
    });
  });
}
