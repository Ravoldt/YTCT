let connection;
let ollamaFrame;
const active = new Map();

function connect() {
  if (connection) return;
  const port = chrome.runtime.connect({ name: 'ytct-offscreen' });
  connection = port;
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (connection === port) connection = null;
    for (const stop of active.values()) stop();
  });
  port.onMessage.addListener(({ id, type, payload }) => {
    if (type === 'cancel') return active.get(id)?.();
    const send = (message) => {
      if (connection === port) port.postMessage({ id, ...message });
    };
    try {
      if (type === 'download') {
        download(payload);
        send({ type: 'done' });
      }
      if (type === 'provider-chat') {
        const worker = new Worker('provider-network.mjs', { type: 'module' });
        const heartbeat = setInterval(() => send({ type: 'working' }), 10000);
        function stop() {
          clearInterval(heartbeat);
          worker.terminate();
          active.delete(id);
        }
        active.set(id, stop);
        worker.onmessage = ({ data }) => {
          if (data.type === 'done' || data.type === 'error') stop();
          send(data);
        };
        worker.onerror = () => {
          stop();
          send({ type: 'error', error: 'The provider worker stopped. Try again.' });
        };
        worker.postMessage(payload);
      }
    } catch (error) {
      active.get(id)?.();
      send({ type: 'error', error: error.message });
    }
  });
}

function download({ entry, format }) {
  if (format === 'json' && !entry.snapshot) throw new Error('Collect the comments to download them as JSON.');
  const content = format === 'json' ? YTCT.buildJson(entry.snapshot) : entry.markdown || YTCT.buildMarkdown(entry.snapshot);
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = (entry.stem || 'youtube-comments') + (format === 'json' ? '.json' : '.md');
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab ||
    (sender.url && sender.url !== chrome.runtime.getURL('background.mjs'))) return;
  if (message?.type === 'ytct-offscreen-wake') {
    connect();
    reply(true);
  }
  if (message?.type === 'ytct-loopback-close') {
    ollamaFrame?.remove();
    ollamaFrame = null;
    reply(true);
    return;
  }
  if (message?.type !== 'ytct-loopback-wake') return;
  if (message.reset && ollamaFrame) {
    ollamaFrame.remove();
    ollamaFrame = null;
  }
  if (!ollamaFrame) {
    ollamaFrame = document.createElement('iframe');
    ollamaFrame.title = 'Local Ollama';
    ollamaFrame.src = 'http://127.0.0.1:11434/';
    document.body.append(ollamaFrame);
  } else {
    ollamaFrame.contentWindow.postMessage({ type: 'ytct-loopback-connect' }, 'http://127.0.0.1:11434');
  }
  reply(true);
});
connect();
