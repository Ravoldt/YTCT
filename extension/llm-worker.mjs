// Connection flow and provider metadata adapted from Cline (Apache-2.0).
// See licenses/LICENSE-CLINE.txt and THIRD_PARTY_NOTICES.md for attribution and changes.
import {
  activeProfile, canonicalEndpoint, chatEndpoint, maskKey, modelsEndpoint, normalizeLlmConfig,
  normalizeProfile, originPattern, profileDestination, providerHeaders, providerKeyRequired, providerOrigin,
  providerSpecFor, reasoningEffort,
} from './llm-config.mjs';
import { relayOffscreen } from './offscreen-worker.mjs';

const CONFIG_KEY = 'llmConfig';
const KEYS_KEY = 'llmKeys';
let pendingWrite = Promise.resolve();

function configWrite(action) {
  const task = pendingWrite.then(action);
  pendingWrite = task.catch(() => {});
  return task;
}

function cleanKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateKey(value) {
  const key = cleanKey(value);
  if (/[\x00-\x1f\x7f]/.test(key)) throw new Error('API keys cannot contain line breaks or control characters.');
  return key;
}

function credentialScope(profile) {
  try { return JSON.stringify([profile.provider, canonicalEndpoint(profile.endpoint)]); }
  catch { return ''; }
}

function keyFor(keys, profile) {
  const record = keys[profile.id];
  return record?.scope && record.scope === credentialScope(profile) ? record.value : '';
}

async function readState() {
  const stored = await chrome.storage.local.get([CONFIG_KEY, KEYS_KEY]);
  const config = normalizeLlmConfig(stored[CONFIG_KEY]);
  const oldKeys = stored[KEYS_KEY] || {};
  const keys = Object.create(null);
  for (const profile of config.profiles) {
    if (!Object.hasOwn(oldKeys, profile.id)) continue;
    const record = oldKeys[profile.id];
    const scope = credentialScope(profile);
    if (!scope) continue;
    if (record?.scope === scope && cleanKey(record.value)) keys[profile.id] = record;
    // Old keys had no destination binding. Preserve only keys on the built-in endpoint.
    else if (cleanKey(record) && scope === credentialScope({ ...profile, endpoint: providerSpecFor(profile).defaultEndpoint })) {
      keys[profile.id] = { scope, value: cleanKey(record) };
    }
  }
  return { config, keys, needsMigration: !stored[CONFIG_KEY] || JSON.stringify(oldKeys) !== JSON.stringify(keys) };
}

function sanitize(config, keys) {
  return {
    ...config,
    profiles: config.profiles.map((profile) => ({
      ...profile,
      hasKey: !!keyFor(keys, profile),
      keyHint: keyFor(keys, profile).slice(-4),
    })),
  };
}

async function persist(config, keys) {
  const view = sanitize(config, keys);
  await chrome.storage.local.set({ [CONFIG_KEY]: view, [KEYS_KEY]: keys });
  return view;
}

export function getLlmConfig() {
  return configWrite(async () => {
    const { config, keys, needsMigration } = await readState();
    return needsMigration ? persist(config, keys) : sanitize(config, keys);
  });
}

export function saveLlmProfile(message = {}) {
  return configWrite(() => saveProfile(message));
}

async function saveProfile(message) {
  const { config, keys } = await readState();
  const draft = message.profile && typeof message.profile === 'object' ? message.profile : {};
  const profile = normalizeProfile(draft, config.profiles.length);
  if (profile.provider === 'ollama') profile.endpoint = 'http://127.0.0.1:11434';
  profile.endpoint = canonicalEndpoint(profile.endpoint);
  if (!profile.model) throw new Error('Enter a model name.');
  if (config.profiles.some((row) => row.id === profile.id && row.id !== draft.id)) profile.id = crypto.randomUUID();
  const key = validateKey(message.key);
  if (message.clearKey || !keyFor(keys, profile)) delete keys[profile.id];
  if (key) keys[profile.id] = { scope: credentialScope(profile), value: key };
  profile.lastUsedAt = Date.now();
  const index = config.profiles.findIndex((row) => row.id === profile.id);
  if (index >= 0) config.profiles[index] = profile;
  else config.profiles.push(profile);
  if (config.profiles.length > 50) delete keys[config.profiles.shift().id];
  config.activeProfileId = profile.id;
  if (message.assistantName !== undefined) {
    profile.name = String(message.assistantName || '').trim().slice(0, 32);
  }
  const saved = await persist(config, keys);
  return { config: saved, profileId: profile.id };
}

export function activateLlmProfile(id) {
  return configWrite(() => activateProfile(id));
}

async function activateProfile(id) {
  const { config, keys } = await readState();
  const profile = config.profiles.find((row) => row.id === id);
  if (!profile) throw new Error('That saved LLM profile no longer exists.');
  config.activeProfileId = profile.id;
  profile.lastUsedAt = Date.now();
  return { config: await persist(config, keys), profileId: profile.id };
}

export function deleteLlmProfile(id) {
  return configWrite(() => deleteProfile(id));
}

async function deleteProfile(id) {
  const { config, keys } = await readState();
  const before = config.profiles.length;
  config.profiles = config.profiles.filter((row) => row.id !== id);
  delete keys[id];
  if (config.profiles.length === before) throw new Error('That saved LLM profile no longer exists.');
  if (config.activeProfileId === id || !config.profiles.some((row) => row.id === config.activeProfileId)) {
    config.activeProfileId = config.profiles[0]?.id || '';
  }
  return { config: await persist(config, keys), profileId: config.activeProfileId };
}

export async function revealLlmKey(id) {
  const { config, keys } = await readState();
  const profile = config.profiles.find((row) => row.id === id);
  const key = profile ? keyFor(keys, profile) : '';
  if (!key) throw new Error('No API key is saved for this profile.');
  return { key, hint: maskKey(key.slice(-4)) };
}

export async function activeOllamaModel(profileId, destination) {
  const { config } = await readState();
  const profile = config.profiles.find((row) => row.id === profileId);
  if (profile?.provider !== 'ollama' || profileDestination(profile) !== destination) {
    throw new Error('The Ollama profile changed. Review the destination and try again.');
  }
  return profile.model;
}

async function chatProfile(profileId, destination) {
  const { config, keys } = await readState();
  const profile = profileId
    ? config.profiles.find((row) => row.id === profileId)
    : activeProfile(config);
  if (!profile) throw new Error('Configure an LLM profile in Settings → LLM.');
  if (profileDestination(profile) !== destination) {
    throw new Error('The LLM profile changed. Review the destination and try again.');
  }
  return { profile, key: keyFor(keys, profile) };
}

function friendlyFetchError(error, endpoint, profile, key = '') {
  if (error?.name === 'AbortError') return error;
  let origin = endpoint;
  try { origin = new URL(endpoint).origin; } catch {}
  const label = profile?.label || 'the provider';
  if (error?.name === 'TimeoutError' || /timed out/i.test(error?.message || '')) {
    return new Error('The request to ' + origin + ' timed out. Check the endpoint and try again.');
  }
  if (error instanceof TypeError) {
    return new Error('Could not reach ' + origin + '. Check the base URL and grant host access for custom domains.');
  }
  return new Error(label + ': ' + scrubKey(error?.message || String(error), key));
}

async function ensureHostAccess(profile) {
  const pattern = originPattern(profile);
  if (!pattern) throw new Error('Enter a valid http(s) base URL.');
  let granted = false;
  try { granted = await chrome.permissions.contains({ origins: [pattern] }); } catch {}
  if (granted) return;
  const error = new Error('Host access is missing for ' + providerOrigin(profile)
    + '. Open “Grant network access” in Settings → LLM, then try again.');
  error.code = 'HOST_ACCESS';
  throw error;
}

function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (typeof part?.content === 'string') return part.content;
    return '';
  }).join('');
  if (typeof value?.text === 'string') return value.text;
  return '';
}

function usageFor(value) {
  if (!value || typeof value !== 'object') return null;
  const prompt = Number(value.prompt_tokens ?? value.input_tokens);
  const completion = Number(value.completion_tokens ?? value.output_tokens);
  if (!Number.isFinite(prompt) && !Number.isFinite(completion)) return null;
  return {
    prompt_tokens: Number.isFinite(prompt) ? prompt : 0,
    completion_tokens: Number.isFinite(completion) ? completion : 0,
    total_tokens: Number.isFinite(Number(value.total_tokens))
      ? Number(value.total_tokens)
      : (Number.isFinite(prompt) ? prompt : 0) + (Number.isFinite(completion) ? completion : 0),
  };
}

function scrubKey(text, key) {
  let out = String(text);
  if (!key) return out;
  out = out.split(key).join('[API key]');
  const encoded = encodeURIComponent(key);
  if (encoded !== key) out = out.split(encoded).join('[API key]');
  return out;
}

function providerError(status, raw, profile, endpoint, key) {
  let detail = raw;
  try {
    const data = JSON.parse(raw);
    detail = data?.error?.message || data?.error || data?.message || raw;
  } catch {}
  detail = scrubKey(detail || '', key).replace(/\s+/g, ' ').trim().slice(0, 300);
  const label = profile?.label || providerSpecFor(profile).label || 'The provider';
  let message;
  if (status === 401) message = 'API key rejected by ' + label + ' (401). Check the key and try again.';
  else if (status === 403) message = label + ' denied access (403). Check the key permissions and model access.';
  else if (status === 404) message = label + ' returned 404. Check the base URL, API path, and model.';
  else if (status === 429) message = label + ' is rate-limiting requests (429). Wait and try again.';
  else if (status >= 500) message = label + ' had a server error (' + status + '). Try again shortly.';
  else message = label + ' returned HTTP ' + status + '.';
  if (detail && !message.toLocaleLowerCase().includes(detail.toLocaleLowerCase())) message += ' ' + detail;
  const error = new Error(message);
  error.status = status;
  error.endpoint = endpoint;
  return error;
}

function boundedResponse(response, maxBytes = 4 * 1024 * 1024) {
  if (!response.body) throw new Error('The provider returned an empty response.');
  let bytes = 0;
  return new Response(response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw new Error('The provider response exceeded the size limit.');
      controller.enqueue(chunk);
    },
  })), { headers: response.headers });
}

function parseModelIds(data) {
  const rows = Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.models) ? data.models
      : Array.isArray(data) ? data : [];
  const ids = rows.map((row) => {
    if (typeof row === 'string') return row;
    return row?.id || row?.name || row?.model || '';
  }).filter((id) => typeof id === 'string' && id.trim()).map((id) => id.trim());
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, 500);
}

async function requestChat(profile, key, messages, thinking, signal) {
  if (providerKeyRequired(profile) && !key) {
    throw new Error('Add an API key for ' + profile.label + ' in Settings → LLM.');
  }
  const endpoint = chatEndpoint(profile);
  if (!endpoint) throw new Error('Enter a valid base URL in Settings → LLM.');
  const spec = providerSpecFor(profile);
  const body = { model: profile.model, messages, stream: true };
  body.max_tokens = 4096;
  if (!spec.local) body.stream_options = { include_usage: true };
  const effort = reasoningEffort(thinking || profile.thinking);
  if (effort) body.reasoning_effort = effort;
  const headers = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    ...providerHeaders(profile, key, 'chat'),
  };
  const send = async () => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), signal, credentials: 'omit', redirect: 'error',
      });
      if (response.ok) return { response };
      return { status: response.status, raw: await boundedResponse(response, 65536).text() };
    } catch (error) {
      signal.throwIfAborted();
      throw friendlyFetchError(error, endpoint, profile, key);
    }
  };
  let result = await send();
  if (result.status === 400 && body.stream_options && /stream_options|include_usage/i.test(result.raw)) {
    delete body.stream_options;
    result = await send();
  }
  if (result.status === 400 && body.reasoning_effort && /reasoning_effort/i.test(result.raw)) {
    delete body.reasoning_effort;
    result = await send();
  }
  if (result.status === 400 && /max_completion_tokens|unsupported.{0,60}max_tokens/i.test(result.raw)) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    result = await send();
  }
  if (result.response) return result.response;
  throw providerError(result.status, result.raw, profile, endpoint, key);
}

async function fetchProviderModels(profile, key, signal) {
  if (providerKeyRequired(profile) && !key) {
    throw new Error('Add an API key for ' + profile.label + ' in Settings → LLM.');
  }
  await ensureHostAccess(profile);
  const endpoint = modelsEndpoint(profile);
  if (!endpoint) throw new Error('Enter a valid base URL in Settings → LLM.');
  const headers = { Accept: 'application/json', ...providerHeaders(profile, key, 'models') };
  const started = Date.now();
  let response;
  try {
    response = await fetch(endpoint, { headers, signal, credentials: 'omit', redirect: 'error' });
  } catch (error) {
    signal.throwIfAborted();
    throw friendlyFetchError(error, endpoint, profile, key);
  }
  if (!response.ok) {
    const raw = await boundedResponse(response, 65536).text();
    throw providerError(response.status, raw, profile, endpoint, key);
  }
  const data = await boundedResponse(response).json();
  return { models: parseModelIds(data), endpoint, latency: Date.now() - started };
}

async function testChat(profile, key, signal) {
  if (!profile.model) throw new Error('Enter or select a model first.');
  await ensureHostAccess(profile);
  const endpoint = chatEndpoint(profile);
  if (!endpoint) throw new Error('Enter a valid base URL in Settings → LLM.');
  const body = {
    model: profile.model,
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    stream: false,
    max_tokens: 16,
  };
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...providerHeaders(profile, key, 'chat'),
  };
  const send = async () => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers, body: JSON.stringify(body), signal, credentials: 'omit', redirect: 'error',
      });
      if (response.ok) return { response };
      return { status: response.status, raw: await boundedResponse(response, 65536).text() };
    } catch (error) {
      signal.throwIfAborted();
      throw friendlyFetchError(error, endpoint, profile, key);
    }
  };
  let result = await send();
  if (result.status === 400 && body.max_tokens && /max_tokens|max_completion_tokens/i.test(result.raw)) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
    result = await send();
  }
  if (!result.response) throw providerError(result.status, result.raw, profile, endpoint, key);
  const data = await boundedResponse(result.response).json();
  if (!Array.isArray(data?.choices) || !data.choices.length) throw new Error('The selected model did not return a chat response.');
}

async function requestProfile(message = {}) {
  const { config, keys } = await readState();
  const saved = message.profileId ? config.profiles.find((row) => row.id === message.profileId) : null;
  const source = message.profile && typeof message.profile === 'object' ? message.profile : saved;
  if (!source) throw new Error('Configure an LLM profile in Settings → LLM.');
  const profile = normalizeProfile(source);
  profile.endpoint = canonicalEndpoint(profile.endpoint);
  let key = validateKey(message.key);
  if (!key && saved && credentialScope(saved) === credentialScope(profile)) key = keyFor(keys, saved);
  return { profile, key, savedId: saved?.id || null };
}

export async function listLlmModels(message = {}) {
  const { profile, key } = await requestProfile(message);
  try {
    const result = await fetchProviderModels(profile, key, AbortSignal.timeout(15000));
    return {
      provider: profile.provider,
      endpoint: result.endpoint,
      models: result.models,
      latency: result.latency,
    };
  } catch (error) {
    error.message = scrubKey(error.message || String(error), key);
    throw error;
  }
}

export async function testLlmConnection(message = {}) {
  const { profile, key } = await requestProfile(message);
  if (providerKeyRequired(profile) && !key) {
    throw new Error('Enter an API key for ' + profile.label + ' before testing.');
  }
  const started = Date.now();
  let models = [];
  let modelError;
  try {
    try {
      const listed = await fetchProviderModels(profile, key, AbortSignal.timeout(15000));
      models = listed.models;
      if (profile.provider === 'ollama') {
        if (!profile.model) {
          if (!models.length) throw new Error('Ollama is reachable, but no models are installed.');
          return {
            ok: true, mode: 'models', provider: profile.provider, models,
            latency: listed.latency,
          };
        }
        if (!models.some((model) => model === profile.model || model === profile.model + ':latest')) {
          throw new Error('Ollama is reachable, but it does not list the selected model.');
        }
        return {
          ok: true, mode: 'models', provider: profile.provider, models,
          latency: listed.latency,
        };
      }
    } catch (error) {
      modelError = error;
      if (profile.provider === 'ollama' || error.code === 'HOST_ACCESS' || [401, 403, 429].includes(error.status)
        || (error.status >= 500 && error.status < 600) || (!error.status && !/404|405/.test(error.message))) {
        throw error;
      }
    }
    if (!profile.model) {
      if (modelError) throw modelError;
      throw new Error('The provider returned no models. Enter a model ID and test again.');
    }
    await testChat(profile, key, AbortSignal.timeout(12000));
    return {
      ok: true, mode: 'chat', provider: profile.provider, models,
      latency: Date.now() - started,
    };
  } catch (error) {
    error.message = scrubKey(error.message || String(error), key);
    throw error;
  }
}


function makeStreamReader() {
  let content = '';
  let thought = false;
  let usage = null;
  let finish = '';
  let done = false;
  function apply(data) {
    if (!data || typeof data !== 'object') return;
    if (data.error) {
      const error = data.error;
      throw new Error(typeof error === 'string' ? error : (error.message || 'The provider returned an error.'));
    }
    if (data.usage) usage = usageFor(data.usage) || usage;
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
      const delta = choice.delta || choice.message || {};
      const next = extractText(delta.content ?? choice.text);
      const reasoning = extractText(delta.reasoning_content) || extractText(delta.reasoning) || extractText(delta.thinking);
      if (next) {
        content += next;
        if (content.length > 262144) throw new Error('The provider answer exceeded the display limit.');
      }
      if (reasoning) thought = true;
      if (choice.finish_reason) finish = String(choice.finish_reason);
    }
    if (data.done === true) done = true;
  }
  function parseLine(raw) {
    const line = String(raw || '').trim();
    if (!line || line.startsWith(':') || line.startsWith('event:') || line.startsWith('id:')) return;
    const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    if (!payload || (payload[0] !== '{' && payload[0] !== '[')) return;
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    apply(data);
  }
  return {
    apply,
    parseLine,
    get content() { return content; },
    get thinking() { return thought; },
    get usage() { return usage; },
    get finish() { return finish; },
    get done() { return done; },
  };
}

async function readStream(response, signal, onUpdate) {
  const reader = makeStreamReader();
  const contentType = response.headers.get('content-type') || '';
  response = boundedResponse(response);
  if (/application\/json/i.test(contentType) && !/event-stream/i.test(contentType)) {
    const raw = await response.text();
    let whole = null;
    try { whole = JSON.parse(raw); } catch {}
    if (whole) {
      reader.apply(whole);
      if (Array.isArray(whole.choices) && whole.choices[0]?.message) reader.apply({ done: true });
    }
    else for (const line of raw.split(/\r?\n/)) reader.parseLine(line);
    onUpdate(reader);
  } else {
    const body = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (!reader.done) {
        signal.throwIfAborted();
        const { value, done } = await body.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        if (buffer.length > 512 * 1024) throw new Error('The provider returned an oversized stream event.');
        for (const line of lines) {
          reader.parseLine(line);
          if (reader.done) break;
        }
        onUpdate(reader);
      }
      if (!reader.done && buffer.trim()) {
        reader.parseLine(buffer);
        onUpdate(reader);
      }
    } finally {
      await body.cancel().catch(() => {});
      body.releaseLock();
    }
  }
  return reader;
}

export async function performLlmChat({ profile, key, messages, thinking }, send) {
  const signal = AbortSignal.timeout(15 * 60000);
  try {
    const response = await requestChat(profile, key, messages, thinking, signal);
    let last = 0;
    const reader = await readStream(response, signal, (state) => {
      if ((!state.content && !state.thinking) || Date.now() - last < 100) return;
      last = Date.now();
      send({ type: 'update', content: state.content, thinking: state.thinking, usage: state.usage });
    });
    signal.throwIfAborted();
    if (!reader.done && !reader.finish) throw new Error('The provider stream ended before the model finished. Try again.');
    if (!reader.content.trim() && !reader.thinking) {
      throw new Error('The model returned no answer text. Check the model name and try again.');
    }
    send({ type: 'done', content: reader.content, thinking: reader.thinking, usage: reader.usage, finish: reader.finish });
  } catch (error) {
    throw new Error(scrubKey(error.message, key));
  }
}

export function connectLlmChat(port) {
  let started = false;
  let connected = true;
  let cancel;
  const send = (message) => {
    if (!connected) return;
    try { port.postMessage(message); } catch {}
  };
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    connected = false;
    cancel?.();
  });
  port.onMessage.addListener((message) => {
    if (started || message?.type !== 'start') return;
    started = true;
    (async () => {
      const { profile, key } = await chatProfile(message.profileId, message.destination);
      if (profile.provider === 'ollama') throw new Error('Ollama uses the local model connection, not the remote API.');
      if (!Array.isArray(message.messages) || !message.messages.length || message.messages.length > 200
        || message.messages.some((item) => !['system', 'user', 'assistant'].includes(item?.role) || typeof item.content !== 'string')
        || new Blob([JSON.stringify(message.messages)]).size > 4 * 1024 * 1024) {
        throw new Error('The prompt is invalid or exceeds the size limit.');
      }
      if (providerKeyRequired(profile) && !key) {
        throw new Error('Add an API key for ' + profile.label + ' in Settings → LLM.');
      }
      await ensureHostAccess(profile);
      if (!connected) return;
      cancel = relayOffscreen('provider-chat', { profile, key, messages: message.messages, thinking: message.thinking }, send);
    })().catch((error) => {
      send({ type: 'error', error: error.message || String(error), code: error.code });
    });
  });
}
