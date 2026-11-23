(() => {
  const extensionOrigin = chrome.runtime.getURL('').slice(0, -1);
  if (location.href !== 'http://127.0.0.1:11434/'
    || window.parent !== window.top
    || location.ancestorOrigins?.length !== 1
    || location.ancestorOrigins[0] !== extensionOrigin) return;

  let connection;
  const active = new Map();

  function connect() {
    if (connection) return;
    const port = chrome.runtime.connect({ name: 'ytct-loopback' });
    connection = port;
    port.onMessage.addListener((message) => {
      if (message.type === 'cancel') active.get(message.id)?.abort();
      if (message.type === 'start') run(port, message);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      connection = null;
      for (const controller of active.values()) controller.abort();
    });
  }

  async function run(port, { id, path, payload }) {
    if (active.has(id) || !['/api/chat', '/api/generate', '/api/show'].includes(path)) return;
    const controller = new AbortController();
    active.set(id, controller);
    function send(type, data) {
      if (connection === port && !controller.signal.aborted) port.postMessage({ id, type, ...data });
    }
    // A model may take longer to start than Chrome's service worker idle timeout.
    const keepWorkerAwake = setInterval(() => send('working'), 15000);
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      send('head', { status: response.status });
      if (!response.body) {
        send('end');
        return;
      }
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > 4 * 1024 * 1024) throw new Error('The local model response exceeded the size limit.');
          send('chunk', { text: value });
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      send('end');
    } catch (error) {
      send('error', { error: error.message });
    } finally {
      clearInterval(keepWorkerAwake);
      active.delete(id);
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source === parent && event.origin === extensionOrigin && event.data?.type === 'ytct-loopback-connect') connect();
  });
  connect();
})();
