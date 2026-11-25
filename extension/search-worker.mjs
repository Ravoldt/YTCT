// Dedicated Search Web Worker: runs Regex (with parent-side ReDoS timeout protection)
// and opt-in local Semantic Search via vendored @huggingface/transformers (WebGPU / WASM).
import { cosineInt8, quantizeVector, semanticModelSpec, textHash } from './search-engine.mjs';

const DB_NAME = 'ytct-embeddings-v1';
const STORE_NAME = 'vectors';
const MAX_CACHE_BYTES = 50 * 1024 * 1024;
const IDLE_DISPOSE_MS = 180000;

let transformersMod = null;
let wasmBinaryPromise = null;
let activePipeline = null;
let activeModelKey = '';
let activeDevice = '';
let activeBackend = '';
let idleTimer = null;
let indexJobId = 0;
let activeRunPromise = null;
let dbPromise = null;

// In-memory vector index for the currently loaded video/post.
const memoryIndex = new Map(); // id -> { q: Int8Array, scale: number, hash: string }
let memoryModelKey = '';

function closeDb() {
  const current = dbPromise;
  dbPromise = null;
  if (current) {
    current.then((db) => { try { db.close(); } catch {} }).catch(() => {});
  }
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('usedAt', 'usedAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('Embedding database is busy. Close other side panels or reload.'));
    };
  });
  return dbPromise;
}

async function clearVectorsStore() {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Vector cache clear aborted.'));
  });
}

async function idbGetMany(keys) {
  if (!keys.length) return new Map();
  const db = await openDb();
  return new Promise((resolve) => {
    const out = new Map();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    let remaining = keys.length;
    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => {
        if (req.result) out.set(key, req.result);
        if (--remaining === 0) resolve(out);
      };
      req.onerror = () => {
        if (--remaining === 0) resolve(out);
      };
    }
    tx.onabort = () => resolve(out);
  });
}

async function idbPutMany(records) {
  if (!records.length) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const rec of records) store.put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  pruneIdb(db).catch(() => {});
}

async function pruneIdb(db) {
  const rows = await new Promise((resolve) => {
    const out = [];
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).openCursor();
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) { resolve(out); return; }
      const val = cursor.value;
      out.push({ key: val.key, usedAt: val.usedAt || 0, bytes: (val.q?.byteLength || 384) + 96 });
      cursor.continue();
    };
    req.onerror = () => resolve(out);
  });
  let total = rows.reduce((acc, r) => acc + r.bytes, 0);
  if (total <= MAX_CACHE_BYTES) return;
  rows.sort((a, b) => a.usedAt - b.usedAt);
  const remove = [];
  for (const row of rows) {
    if (total <= MAX_CACHE_BYTES * 0.85) break;
    remove.push(row.key);
    total -= row.bytes;
  }
  if (!remove.length) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    for (const k of remove) store.delete(k);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function getCacheStats() {
  let vectorBytes = 0;
  let vectorCount = 0;
  let modelBytes = 0;
  try {
    const db = await openDb();
    await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) { resolve(); return; }
        vectorCount++;
        vectorBytes += (cursor.value?.q?.byteLength || 384) + 96;
        cursor.continue();
      };
      req.onerror = () => resolve();
    });
  } catch {}
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open('transformers-cache');
      const keys = await cache.keys();
      for (const req of keys) {
        const res = await cache.match(req);
        const len = Number(res?.headers?.get('content-length')) || 0;
        if (len > 0) modelBytes += len;
        else if (res) {
          const buf = await res.clone().arrayBuffer();
          modelBytes += buf.byteLength;
        }
      }
    }
  } catch {}
  return { modelBytes, vectorBytes, vectorCount };
}

function pauseIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = null;
}

function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (activeRunPromise) return;
    disposePipeline().catch(() => {});
  }, IDLE_DISPOSE_MS);
}

async function disposePipeline() {
  pauseIdleTimer();
  const pipe = activePipeline;
  activePipeline = null;
  activeModelKey = '';
  activeDevice = '';
  activeBackend = '';
  if (pipe && typeof pipe.dispose === 'function') {
    try { await pipe.dispose(); } catch {}
  }
}

async function loadCachedWasmBinary(wasmUrl, onProgress) {
  let cache = null;
  try {
    if (typeof caches !== 'undefined') {
      cache = await caches.open('transformers-cache');
      const hit = await cache.match(wasmUrl);
      if (hit) return await hit.arrayBuffer();
    }
  } catch {}

  onProgress?.({ stage: 'downloading', pct: 0, file: 'ONNX WebAssembly runtime' });
  const res = await fetch(wasmUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch ONNX WebAssembly runtime (HTTP ${res.status}).`);
  }
  const cacheClone = cache ? res.clone() : null;
  const total = Number(res.headers.get('content-length')) || 0;
  let buffer;
  if (total > 0 && res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.({
        stage: 'downloading',
        pct: Math.min(99, Math.round((loaded / total) * 100)),
        file: 'ONNX WebAssembly runtime',
        loaded,
        total,
      });
    }
    const merged = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    buffer = merged.buffer;
  } else {
    buffer = await res.arrayBuffer();
  }
  if (cache && cacheClone) {
    try { await cache.put(wasmUrl, cacheClone); } catch {}
  }
  return buffer;
}

async function loadTransformers(onProgress) {
  if (!transformersMod) {
    const mod = await import('./vendor/transformers/transformers.min.js');
    const { env } = mod;
    env.allowLocalModels = false;
    env.useBrowserCache = true;
    // Suppress Transformers.js internal console.error spam (e.g. "Inputs given to model:"
    // during handled WebGPU -> WASM fallback); real failures are surfaced in the UI banner.
    env.logLevel = 50;
    // Disable Transformers.js's built-in WASM factory blob cache: inside a Dedicated
    // Web Worker `globalThis.chrome` is undefined, so it would wrap the factory in a
    // `blob:` URL which Chrome MV3 CSP (`script-src 'self' 'wasm-unsafe-eval'`) blocks.
    // Instead, omit `wasmPaths.mjs` (using the factory bundled inside transformers.min.js)
    // and pre-load + cache the `.wasm` binary directly into `transformers-cache`.
    env.useWasmCache = false;
    if (env.backends?.onnx?.webgpu) {
      // Avoid Chromium Windows warning (crbug.com/369219127) from powerPreference option.
      env.backends.onnx.webgpu.powerPreference = undefined;
    }
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.numThreads = 1;
      env.backends.onnx.wasm.proxy = false;
      const ortVer = env.backends.onnx.versions?.web || '1.31.0-dev.20260914-8d85527a0';
      const wasmUrl = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ortVer}/dist/ort-wasm-simd-threaded.asyncify.wasm`;
      env.backends.onnx.wasm.wasmPaths = { wasm: wasmUrl };
    }
    transformersMod = mod;
  }
  const wasmCfg = transformersMod.env?.backends?.onnx?.wasm;
  if (wasmCfg && !wasmCfg.wasmBinary && wasmCfg.wasmPaths?.wasm) {
    if (!wasmBinaryPromise) {
      wasmBinaryPromise = loadCachedWasmBinary(wasmCfg.wasmPaths.wasm, onProgress).catch((err) => {
        wasmBinaryPromise = null;
        throw err;
      });
    }
    wasmCfg.wasmBinary = await wasmBinaryPromise;
  }
  return transformersMod;
}

async function ensurePipeline(modelKey, devicePreference, onProgress) {
  pauseIdleTimer();
  const spec = semanticModelSpec(modelKey);
  const wantDevice = devicePreference === 'wasm' ? 'wasm' : 'auto';
  if (activePipeline && activeModelKey === spec.key && activeDevice === wantDevice) {
    return { pipe: activePipeline, spec, backend: activeBackend };
  }
  await disposePipeline();
  const { pipeline } = await loadTransformers(onProgress);

  const fileProgress = new Map();
  const progress_callback = (info) => {
    if (!info) return;
    if (info.file && Number.isFinite(info.loaded) && Number.isFinite(info.total) && info.total > 0) {
      fileProgress.set(info.file, { loaded: info.loaded, total: info.total });
      let loaded = 0;
      let total = 0;
      for (const p of fileProgress.values()) {
        loaded += p.loaded;
        total += p.total;
      }
      const pct = total > 0 ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      onProgress({ stage: 'downloading', pct, file: info.file, loaded, total });
    } else if (info.status === 'initiate' && info.file) {
      onProgress({ stage: 'downloading', pct: 0, file: info.file });
    }
  };

  let pipe = null;
  let backend = 'CPU (WASM)';
  const canTryWebGpu = wantDevice === 'auto' && typeof navigator !== 'undefined' && !!navigator.gpu;
  if (canTryWebGpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        if (transformersMod?.env?.backends?.onnx?.webgpu) {
          transformersMod.env.backends.onnx.webgpu.powerPreference = undefined;
          transformersMod.env.backends.onnx.webgpu.adapter = adapter;
        }
        pipe = await pipeline('feature-extraction', spec.id, { dtype: 'q8', device: 'webgpu', progress_callback });
        backend = 'WebGPU';
      }
    } catch {
      pipe = null;
    }
  }
  if (!pipe) {
    pipe = await pipeline('feature-extraction', spec.id, { dtype: 'q8', device: 'wasm', progress_callback });
    backend = 'CPU (WASM)';
  }
  activePipeline = pipe;
  activeModelKey = spec.key;
  activeDevice = wantDevice;
  activeBackend = backend;
  return { pipe, spec, backend };
}

function normalizeFloat32(data) {
  let normSq = 0;
  for (let i = 0; i < data.length; i++) normSq += data[i] * data[i];
  const norm = Math.sqrt(normSq);
  const out = new Float32Array(data.length);
  if (norm > 0) {
    const inv = 1 / norm;
    for (let i = 0; i < data.length; i++) out[i] = data[i] * inv;
  }
  return out;
}

async function indexComments({ requestId, modelKey, device, items }) {
  pauseIdleTimer();
  const job = ++indexJobId;
  const spec = semanticModelSpec(modelKey);
  if (memoryModelKey !== spec.key) {
    memoryIndex.clear();
    memoryModelKey = spec.key;
  }

  const total = items.length;
  const missing = [];
  const lookupKeys = [];
  const itemByKey = new Map();

  for (const item of items) {
    const hash = textHash(item.text);
    const mem = memoryIndex.get(item.id);
    if (mem && mem.hash === hash) continue;
    const dbKey = spec.key + ':' + item.id + ':' + hash;
    lookupKeys.push(dbKey);
    itemByKey.set(dbKey, { ...item, hash, dbKey });
  }

  const cached = await idbGetMany(lookupKeys);
  if (job !== indexJobId) {
    self.postMessage({ type: 'semantic-cancelled', requestId, done: total - itemByKey.size, total });
    return;
  }

  for (const [dbKey, item] of itemByKey.entries()) {
    const hit = cached.get(dbKey);
    if (hit?.q && Number.isFinite(hit.scale)) {
      memoryIndex.set(item.id, {
        q: hit.q instanceof Int8Array ? hit.q : new Int8Array(hit.q),
        scale: hit.scale,
        hash: item.hash,
      });
    } else {
      missing.push(item);
    }
  }

  let done = total - missing.length;
  let backend = activeBackend || (device === 'wasm' ? 'CPU (WASM)' : 'WebGPU');
  if (missing.length > 0) {
    // Group similarly sized comments together to avoid padding short comments to
    // the length of an occasional long comment in the same Transformer batch.
    missing.sort((a, b) => a.text.length - b.text.length);

    let loaded = await ensurePipeline(spec.key, device, (prog) => {
      if (job === indexJobId) {
        self.postMessage({ type: 'semantic-progress', requestId, ...prog, modelLabel: spec.label });
      }
    });
    if (job !== indexJobId) {
      self.postMessage({ type: 'semantic-cancelled', requestId, done, total });
      return;
    }
    backend = loaded.backend;
    let pipe = loaded.pipe;
    self.postMessage({ type: 'semantic-progress', requestId, stage: 'indexing', done, total, backend });

    const toStore = [];
    const now = Date.now();
    let i = 0;
    while (i < missing.length) {
      if (job !== indexJobId) {
        if (toStore.length) await idbPutMany(toStore.splice(0)).catch(() => {});
        self.postMessage({ type: 'semantic-cancelled', requestId, done, total });
        return;
      }
      // Keep batches snappy so progress updates smoothly and cancellation responds quickly.
      const probeLen = missing[i].text.length;
      const batchSize = probeLen > 450 ? 6 : probeLen > 180 ? 10 : 16;
      const batch = missing.slice(i, i + batchSize);
      const texts = batch.map((it) => (spec.docPrefix || '') + it.text.slice(0, 1200));
      let output;
      try {
        output = await pipe(texts, { pooling: spec.pooling, normalize: true });
      } catch (err) {
        // If WebGPU fails mid-run in Auto mode (e.g. device lost / buffer map error),
        // flush completed batches and transparently finish on CPU (WASM).
        if (backend === 'WebGPU' && device !== 'wasm' && job === indexJobId) {
          if (toStore.length) await idbPutMany(toStore.splice(0)).catch(() => {});
          await disposePipeline();
          loaded = await ensurePipeline(spec.key, 'wasm', (prog) => {
            if (job === indexJobId) {
              self.postMessage({ type: 'semantic-progress', requestId, ...prog, modelLabel: spec.label });
            }
          });
          if (job !== indexJobId) {
            self.postMessage({ type: 'semantic-cancelled', requestId, done, total });
            return;
          }
          backend = loaded.backend;
          pipe = loaded.pipe;
          self.postMessage({ type: 'semantic-progress', requestId, stage: 'indexing', done, total, backend });
          output = await pipe(texts, { pooling: spec.pooling, normalize: true });
        } else {
          if (toStore.length) await idbPutMany(toStore.splice(0)).catch(() => {});
          throw err;
        }
      }
      i += batch.length;
      const dims = output.dims[output.dims.length - 1];
      const raw = output.data;
      for (let b = 0; b < batch.length; b++) {
        const slice = raw.subarray(b * dims, (b + 1) * dims);
        const unit = normalizeFloat32(slice);
        const { q, scale } = quantizeVector(unit);
        const item = batch[b];
        memoryIndex.set(item.id, { q, scale, hash: item.hash });
        toStore.push({ key: item.dbKey, q, scale, usedAt: now });
      }
      done += batch.length;
      if (job !== indexJobId) {
        if (toStore.length) await idbPutMany(toStore.splice(0)).catch(() => {});
        self.postMessage({ type: 'semantic-cancelled', requestId, done, total });
        return;
      }
      self.postMessage({ type: 'semantic-progress', requestId, stage: 'indexing', done, total, backend });
      if (toStore.length >= 48) {
        await idbPutMany(toStore.splice(0));
      }
    }
    if (toStore.length) await idbPutMany(toStore);
  } else {
    // Ensure pipeline is warm for upcoming query embedding even if all vectors were cached.
    const loaded = await ensurePipeline(spec.key, device, (prog) => {
      if (job === indexJobId) {
        self.postMessage({ type: 'semantic-progress', requestId, ...prog, modelLabel: spec.label });
      }
    });
    if (job !== indexJobId) {
      self.postMessage({ type: 'semantic-cancelled', requestId, done, total });
      return;
    }
    backend = loaded.backend;
  }

  self.postMessage({ type: 'semantic-indexed', requestId, count: memoryIndex.size, backend, modelKey: spec.key });
}

async function querySemantic({ requestId, modelKey, device, query, candidateIds }) {
  pauseIdleTimer();
  const spec = semanticModelSpec(modelKey);
  const { pipe, backend } = await ensurePipeline(spec.key, device, (prog) => {
    self.postMessage({ type: 'semantic-progress', requestId, ...prog, modelLabel: spec.label });
  });
  const input = (spec.queryPrefix || '') + String(query || '').trim().slice(0, 512);
  const output = await pipe(input, { pooling: spec.pooling, normalize: true });
  const qNorm = normalizeFloat32(output.data);

  const scores = [];
  const ids = Array.isArray(candidateIds) && candidateIds.length ? candidateIds : [...memoryIndex.keys()];
  for (const id of ids) {
    const entry = memoryIndex.get(id);
    if (!entry) continue;
    const sim = cosineInt8(qNorm, entry.q, entry.scale);
    if (sim >= spec.minScore) scores.push([id, sim]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  self.postMessage({ type: 'semantic-result', requestId, scores: scores.slice(0, 400), backend });
}

async function waitForActiveRun() {
  if (activeRunPromise) {
    try { await activeRunPromise; } catch {}
  }
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  const { type, requestId } = msg;
  try {
    if (type === 'regex-search') {
      const regex = new RegExp(msg.pattern, 'i');
      const hitIds = [];
      for (const item of msg.items || []) {
        if (regex.test(item.blob)) hitIds.push(item.id);
      }
      self.postMessage({ type: 'regex-result', requestId, hitIds });
      return;
    }
    if (type === 'semantic-index') {
      const ticket = ++indexJobId;
      await waitForActiveRun();
      if (ticket !== indexJobId) {
        self.postMessage({ type: 'semantic-cancelled', requestId, done: 0, total: msg.items?.length || 0 });
        return;
      }
      const run = indexComments(msg);
      activeRunPromise = run;
      try { await run; } finally {
        if (activeRunPromise === run) activeRunPromise = null;
        if (activePipeline) resetIdleTimer();
      }
      return;
    }
    if (type === 'semantic-query') {
      await waitForActiveRun();
      const run = querySemantic(msg);
      activeRunPromise = run;
      try { await run; } finally {
        if (activeRunPromise === run) activeRunPromise = null;
        if (activePipeline) resetIdleTimer();
      }
      return;
    }
    if (type === 'semantic-cancel') {
      indexJobId++;
      await waitForActiveRun();
      self.postMessage({ type: 'semantic-cancel-ack', requestId });
      return;
    }
    if (type === 'semantic-reset-memory') {
      indexJobId++;
      await waitForActiveRun();
      memoryIndex.clear();
      return;
    }
    if (type === 'semantic-clear-vectors') {
      indexJobId++;
      await waitForActiveRun();
      memoryIndex.clear();
      await clearVectorsStore();
      self.postMessage({ type: 'semantic-cleared-vectors', requestId });
      return;
    }
    if (type === 'semantic-clear-models') {
      indexJobId++;
      await waitForActiveRun();
      wasmBinaryPromise = null;
      if (transformersMod?.env?.backends?.onnx?.wasm) {
        transformersMod.env.backends.onnx.wasm.wasmBinary = undefined;
      }
      await disposePipeline();
      if (typeof caches !== 'undefined') await caches.delete('transformers-cache').catch(() => {});
      self.postMessage({ type: 'semantic-cleared-models', requestId });
      return;
    }
    if (type === 'semantic-clear') {
      indexJobId++;
      await waitForActiveRun();
      memoryIndex.clear();
      wasmBinaryPromise = null;
      if (transformersMod?.env?.backends?.onnx?.wasm) {
        transformersMod.env.backends.onnx.wasm.wasmBinary = undefined;
      }
      await disposePipeline();
      if (typeof caches !== 'undefined') await caches.delete('transformers-cache').catch(() => {});
      await clearVectorsStore();
      closeDb();
      self.postMessage({ type: 'semantic-cleared', requestId });
      return;
    }
    if (type === 'semantic-cache-info') {
      const stats = await getCacheStats();
      self.postMessage({ type: 'semantic-cache-info', requestId, stats });
      return;
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, error: String(error?.message || error) });
  }
};
