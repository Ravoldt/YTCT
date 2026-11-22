import './common.js';
import { performLlmChat } from './llm-worker.mjs';

self.onmessage = ({ data }) => {
  performLlmChat(data, (message) => self.postMessage(message)).catch((error) => {
    self.postMessage({ type: 'error', error: error.message || 'The provider request failed.' });
  });
};
