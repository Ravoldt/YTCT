const documentPath = 'loopback.html';
let bridge;
let opening;
let ready;
const operations = new Map();

export function connectLoopback(port) {
  if (port.sender.id !== chrome.runtime.id || port.sender.url !== 'http://127.0.0.1:11434/' || port.sender.tab) return;
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
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(documentPath)],
      });
      if (contexts.length) await chrome.runtime.sendMessage({ type: 'ytct-loopback-wake' });
      else await chrome.offscreen.createDocument({
        url: documentPath,
        reasons: ['IFRAME_SCRIPTING'],
        justification: 'Contact the local Ollama API from its own loopback origin.',
      });
    })();
    setup.catch(connected.reject);
    try {
      return await connected.promise;
    } catch (error) {
      await chrome.offscreen.closeDocument().catch(() => {});
      throw error;
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
    if (operation.port === bridge) operation.port.postMessage({ id, type: 'cancel' });
  };
}
