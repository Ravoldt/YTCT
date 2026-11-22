import { relayPanelChat, relayResponse } from './loopback-stream.mjs';

export const DEFAULT_MODEL = 'gemma4:12b';
const base = 'http://127.0.0.1:11434';
const keepAlive = '5m';

async function request(path, payload, signal, relay = relayPanelChat) {
  let response;
  try {
    response = payload
      ? await relayResponse((receive) => relay(path, payload, receive), signal)
      : await fetch(base + path, { signal });
  } catch (error) {
    signal?.throwIfAborted();
    if (payload) throw error;
    throw new Error('Could not reach Ollama on port 11434. Start Ollama and try again.', { cause: error });
  }
  if (!response.ok) {
    const text = await response.text();
    let reason = text;
    try { reason = JSON.parse(text).error || text; } catch {}
    throw new Error('Ollama HTTP ' + response.status + ' · ' + reason.slice(0, 400));
  }
  return response;
}

export async function loadedModel(model = DEFAULT_MODEL) {
  const response = await request('/api/ps', null, AbortSignal.timeout(7000));
  const { models } = await response.json();
  return models?.find((entry) => entry.name === model || entry.model === model) || null;
}

export async function unloadModel(model = DEFAULT_MODEL, relay) {
  const response = await request('/api/generate', { model, keep_alive: 0, stream: false }, AbortSignal.timeout(15000), relay);
  await response.json();
}

export async function availableVram() {
  try {
    const response = await fetch('http://127.0.0.1:11435/vram', { signal: AbortSignal.timeout(3500) });
    if (!response.ok) return null;
    const { gpus } = await response.json();
    const usable = (gpus || []).filter((gpu) => Number.isFinite(gpu?.free_mib));
    return usable.sort((a, b) => b.free_mib - a.free_mib)[0] || null;
  } catch { return null; }
}

export async function readChatStream(response, update, signal) {
  if (!response.body) throw new Error('Ollama returned an empty response.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let content = '';
  let thinking = false;
  let metrics = null;
  function consume(line) {
    if (!line.trim()) return;
    const data = JSON.parse(line);
    if (data.error) throw new Error(data.error);
    if (data.message?.thinking) thinking = true;
    if (data.message?.content) content += data.message.content;
    if (data.done === true) metrics = data;
  }
  try {
    while (!metrics) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += value || '';
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const before = content.length;
      const wasThinking = thinking;
      for (const line of lines) {
        consume(line);
        if (metrics) break;
      }
      if (done && !metrics) consume(buffer);
      if (content.length !== before || thinking !== wasThinking) update({ content, thinking });
      if (done) break;
    }
    signal.throwIfAborted();
    if (!metrics) throw new Error('The Ollama stream ended early. Try the question again.');
    return { content, thinking, metrics };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function askOllama(session, history, question, settings, onChange, signal, {
  model = DEFAULT_MODEL, thinking = 'default',
} = {}) {
  let budgetScale = 1;
  let think = thinking === 'default' ? undefined : thinking === 'off' ? false : thinking;
  let triedThinkFallback = false;
  let retryWithoutThinking = false;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60000)]);
  for (;;) {
    const context = YTCT.buildAiContext(session, history, question, settings, budgetScale);
    let visible = false;
    let result;
    try {
      const response = await request('/api/chat', {
        model,
        messages: context.messages,
        stream: true,
        keep_alive: keepAlive,
        truncate: false,
        shift: false,
        ...(retryWithoutThinking ? { think: false } : think !== undefined ? { think } : {}),
        options: { num_ctx: session.contextWindow, num_predict: YTCT.outputTokenBudget(session.contextWindow) },
      }, requestSignal);
      result = await readChatStream(response, (update) => {
        if (update.content.trim()) visible = true;
        onChange({ ...update, links: context.links });
      }, requestSignal);
    } catch (error) {
      requestSignal.throwIfAborted();
      if (!visible && !retryWithoutThinking && think !== undefined && think !== false && !triedThinkFallback
        && /think|reasoning/i.test(error.message)) {
        triedThinkFallback = true;
        think = true;
        onChange({ status: 'Retrying with the model’s default thinking setting…' });
        continue;
      }
      if (visible || budgetScale !== 1 || !/context.{0,45}(limit|exceed|overflow|too long)|prompt.{0,45}(too long|exceed)|input length|maximum context/i.test(error.message)) throw error;
      budgetScale = 0.65;
      onChange({ status: 'Retrying with less source text…' });
      continue;
    }
    if (result.content.trim()) {
      return {
        ...result,
        usage: {
          prompt_tokens: Number(result.metrics?.prompt_eval_count) || 0,
          completion_tokens: Number(result.metrics?.eval_count) || 0,
        },
        context,
      };
    }
    if (retryWithoutThinking || (!result.thinking && result.metrics?.done_reason !== 'length')) {
      throw new Error('Ollama finished without answer text. Try a shorter question or a larger context window.');
    }
    retryWithoutThinking = true;
    onChange({ status: 'Thinking used the response budget. Retrying with thinking off…' });
  }
}
