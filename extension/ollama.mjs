import { relayPanelChat, relayResponse } from './loopback-stream.mjs';

const base = 'http://127.0.0.1:11434';
const keepAlive = '5m';

export function modelName(model) {
  const value = String(model || '').trim();
  if (!value) return '';
  return value.slice(value.lastIndexOf('/') + 1).includes(':') ? value : value + ':latest';
}

async function boundedText(response, maxBytes = 1024 * 1024) {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Ollama response exceeded the size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function boundedJson(response, maxBytes = 1024 * 1024) {
  return JSON.parse(await boundedText(response, maxBytes));
}

async function request(path, payload, signal, relay = relayPanelChat) {
  let response;
  try {
    response = payload
      ? await relayResponse((receive) => relay(path, payload, receive), signal)
      : await fetch(base + path, { signal, credentials: 'omit', redirect: 'error' });
  } catch (error) {
    signal?.throwIfAborted();
    if (payload) throw error;
    throw new Error('Could not reach Ollama on port 11434. Start Ollama and try again.', { cause: error });
  }
  if (!response.ok) {
    const text = await boundedText(response, 65536).catch(() => '');
    let reason = text;
    try { reason = JSON.parse(text).error || text; } catch {}
    throw new Error('Ollama HTTP ' + response.status + ' · ' + reason.slice(0, 400));
  }
  return response;
}

export async function loadedModel(model) {
  const target = modelName(model);
  if (!target) return null;
  const response = await request('/api/ps', null, AbortSignal.timeout(7000));
  const { models } = await boundedJson(response, 1024 * 1024);
  return models?.find((entry) => [entry.name, entry.model].some((name) =>
    typeof name === 'string' && modelName(name) === target)) || null;
}

export async function unloadModel(model, relay) {
  if (!model) return;
  const response = await request('/api/generate', { model, keep_alive: 0, stream: false }, AbortSignal.timeout(15000), relay);
  await boundedJson(response, 65536);
}

export function parseOllamaShow(data) {
  let contextLength = 0;
  if (data?.model_info && typeof data.model_info === 'object') {
    for (const [key, value] of Object.entries(data.model_info)) {
      if (key.endsWith('.context_length') && Number.isFinite(Number(value)) && Number(value) >= 1024) {
        contextLength = Math.max(contextLength, Math.floor(Number(value)));
      }
    }
  }
  if (!contextLength && typeof data?.parameters === 'string') {
    const match = /\bnum_ctx\s+(\d+)/i.exec(data.parameters);
    if (match && Number(match[1]) >= 1024) contextLength = Math.floor(Number(match[1]));
  }
  let thinking = null;
  if (Array.isArray(data?.capabilities)) {
    const supported = data.capabilities.includes('thinking');
    thinking = supported
      ? { supported: true, levels: ['default', 'off', 'on', 'low', 'medium', 'high'] }
      : { supported: false, levels: ['default'] };
  }
  return { contextLength, thinking };
}

export async function showModel(model, relay) {
  if (!model) return { contextLength: 0, thinking: null };
  const response = await request('/api/show', { model }, AbortSignal.timeout(10000), relay);
  const data = await boundedJson(response, 1024 * 1024);
  return parseOllamaShow(data);
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
    if (typeof data.message?.content === 'string') {
      content += data.message.content;
      if (content.length > 1048576) throw new Error('The local model answer exceeded the display limit.');
    }
    if (data.done === true) metrics = data;
  }
  try {
    while (!metrics) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      buffer += value || '';
      const lines = buffer.split('\n');
      buffer = lines.pop();
      if (buffer.length > 512 * 1024) throw new Error('Ollama returned an oversized stream event.');
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
  model = '', thinking = 'default',
} = {}) {
  if (!model) throw new Error('Select an Ollama model in Settings → LLM.');
  let budgetScale = 1;
  let think = thinking === 'default' ? undefined
    : thinking === 'off' ? false
      : thinking === 'on' ? true : thinking;
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
        options: { num_ctx: session.contextWindow, num_predict: -1 },
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
