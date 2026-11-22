// Panel-side client for OpenAI-compatible providers. Credentials are handled in extension background contexts.
import { profileDestination } from './llm-config.mjs';
export function isContextError(message) {
  return /maximum context|context.{0,45}(limit|exceed|overflow|too long)|prompt.{0,45}(too long|exceed)|input length/i.test(String(message || ''));
}

export function messageTokens(messages) {
  return (messages || []).reduce((total, message) => total + YTCT.estimatedTokens(String(message?.content || '')), 0);
}

function streamRemote(payload, signal, onUpdate) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    let content = '';
    let thinking = false;
    let usage = null;
    let finish = '';
    let port;
    const timer = setTimeout(() => settleError(new Error('The model took too long to respond.')), 15 * 60000);
    function clean() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      try { port.disconnect(); } catch {}
    }
    function settleError(error) {
      if (settled) return;
      settled = true;
      clean();
      reject(error);
    }
    function settle(value) {
      if (settled) return;
      settled = true;
      clean();
      resolve(value);
    }
    function abort() {
      settleError(signal.reason || new Error('Question stopped.'));
    }
    try {
      port = chrome.runtime.connect({ name: 'ytct-llm-chat' });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    port.onMessage.addListener((message) => {
      if (settled) return;
      if (message?.type === 'update') {
        content = typeof message.content === 'string' ? message.content : content;
        thinking = !!message.thinking;
        usage = message.usage || usage;
        try { onUpdate({ content, thinking, usage }); } catch (error) { settleError(error); }
      } else if (message?.type === 'done') {
        content = typeof message.content === 'string' ? message.content : content;
        thinking = !!message.thinking;
        usage = message.usage || usage;
        finish = message.finish || '';
        settle({ content, thinking, usage, finish });
      } else if (message?.type === 'error') {
        settleError(new Error(message.error || 'The model request failed.'));
      }
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (!settled) settleError(new Error('The model connection closed before an answer arrived.'));
    });
    try {
      port.postMessage({ type: 'start', ...payload });
    } catch (error) {
      settleError(error);
    }
  });
}

export async function askRemote(session, history, question, settings, profile, onChange, signal) {
  let budgetScale = 1;
  let thinking = profile.thinking || 'default';
  let retriedThinking = false;
  for (;;) {
    const context = YTCT.buildAiContext(session, history, question, settings, budgetScale);
    // Ollama accepts inline images; OpenAI-compatible chat requests get text only.
    const messages = context.messages.map((message) => ({ role: message.role, content: message.content }));
    let visible = false;
    let result;
    try {
      result = await streamRemote({ profileId: profile.id, destination: profileDestination(profile), messages, thinking }, signal, (update) => {
        if (String(update.content || '').trim()) visible = true;
        onChange({ content: update.content, thinking: update.thinking, usage: update.usage, links: context.links });
      });
    } catch (error) {
      signal.throwIfAborted();
      if (visible || budgetScale !== 1 || !isContextError(error.message)) throw error;
      budgetScale = 0.65;
      onChange({ status: 'Retrying with less source text…' });
      continue;
    }
    if (result.content.trim()) {
      return {
        content: result.content,
        thinking: result.thinking,
        usage: result.usage,
        finish: result.finish,
        metrics: {
          done_reason: result.finish,
          prompt_eval_count: result.usage?.prompt_tokens,
          eval_count: result.usage?.completion_tokens,
        },
        context,
      };
    }
    if (!retriedThinking && (result.thinking || thinking !== 'off')) {
      retriedThinking = true;
      thinking = 'off';
      onChange({ status: 'Thinking used the response budget. Retrying with thinking off…' });
      continue;
    }
    throw new Error('The model returned no answer text. Check the model name and try again.');
  }
}
