const ollamaFrame = document.getElementById('ollama');

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'ytct-loopback-wake') return;
  ollamaFrame.contentWindow.postMessage({ type: 'ytct-loopback-connect' }, 'http://127.0.0.1:11434');
  reply(true);
});
