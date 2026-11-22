export function relayResponse(start, signal) {
  signal.throwIfAborted();
  const response = Promise.withResolvers();
  const encoder = new TextEncoder();
  let reader;
  let cancel;
  let finished = false;
  function stop(error) {
    if (finished) return;
    finished = true;
    signal.removeEventListener('abort', abort);
    cancel?.();
    if (error) {
      response.reject(error);
      reader.error(error);
    }
  }
  function abort() { stop(signal.reason); }
  const body = new ReadableStream({
    start(controller) { reader = controller; },
    cancel() { stop(); },
  });
  signal.addEventListener('abort', abort, { once: true });
  try {
    cancel = start(({ type, status, text, error }) => {
      if (finished) return;
      if (type === 'head') response.resolve(new Response(body, { status }));
      else if (type === 'chunk') reader.enqueue(encoder.encode(text));
      else if (type === 'end') {
        reader.close();
        stop();
      } else if (type === 'error') stop(new Error(error));
    });
  } catch (error) { stop(error); }
  return response.promise;
}

export function relayPanelChat(_path, payload, receive) {
  const port = chrome.runtime.connect({ name: 'ytct-ollama-chat' });
  port.onMessage.addListener(receive);
  port.onDisconnect.addListener(() => receive({
    type: 'error', error: chrome.runtime.lastError?.message || 'The side panel lost its Ollama connection.',
  }));
  port.postMessage(payload);
  return () => port.disconnect();
}
