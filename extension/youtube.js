// YouTube's main world. This code uses YouTube's own data and has no extension API access.
(() => {
  'use strict';
  if (window.__ytctCollector) return;
  window.__ytctCollector = true;
  const pageWin = window;
  const pageDoc = document;

  function sourceKey() {
    const video = location.pathname === '/watch' && new URLSearchParams(location.search).get('v');
    const post = /\/post\/([^/]+)/.exec(location.pathname);
    if (video) return 'video:' + video;
    if (post) return 'post:' + post[1];
    return location.pathname;
  }

  function formatDuration(total) {
    const s = Math.max(0, Math.floor(total));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return (h ? h + ':' + two(m) : String(m)) + ':' + two(sec);
  }

  function parseTimestampToSeconds(ts) {
    const value = String(ts || '').trim();
    if (!/^\d+:(?:[0-5]\d:)?[0-5]\d$/.test(value)) return null;
    return value.split(':').reduce((sec, part) => sec * 60 + Number(part), 0);
  }

  function cleanLabel(text, limit) {
    return String(text || '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit).trim();
  }

  const DELAY_MS = 110;
  const MAX_PAGE_ATTEMPTS = 3;
  const PAGE_TIMEOUT_MS = 30000;
  const DEADLINE_MINUTES = 90; // hard wall-clock guard for very large sections
  const MAX_CEILING = 25000; // absolute request ceiling, even if YouTube keeps yielding
  const MAX_COMMENT_BYTES = 6 * 1024 * 1024;
  const encoder = new TextEncoder();

  function createCollectionState() {
    return {
      running: false,
      aborted: false,
      comments: new Map(),
      commentBytes: 0,
      limitReached: false,
      queue: [],
      queuedKeys: new Set(),
      seenTokens: new Set(),
      requests: 0,
      attempts: 0,
      maxRequests: 2000,
      stats: { topPages: 0, replyPages: 0 },
      topStreak: 0,
      sortRequested: false,
      sortApplied: '',
      sortConfirmed: false,
      switchedFromTop: false,
      reported: 0,
      startedAt: null,
      lastGainAt: 0,
      statusText: 'idle',
      errors: [],
      incremental: false,
      knownTopIds: null,
      knownAllIds: null,
      knownReplyCounts: null,
      baselineCount: 0,
      overlapStreak: 0,
      overlapReached: false,
      replyScanPages: 0,
      updatedReplyCounts: null,
      result: { status: 'idle', reason: 'collection has not run' },
    };
  }

  const state = createCollectionState();
  let collectionSource = sourceKey();
  let sourceGeneration = 0;
  let activeCollection = null;
  let savedSeedToken = null;

  function sleep(ms, signal) {
    if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, ms);
      function cancel() {
        clearTimeout(timer);
        reject(signal.reason);
      }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  const waitFor = async (fn, timeoutMs, intervalMs, signal) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (signal) signal.throwIfAborted();
      const v = fn();
      if (v) return v;
      await sleep(intervalMs || 250, signal);
    }
    return null;
  };

  const tokenKey = (endpoint, token) => endpoint + '|' + token;

  function endpointFromUrl(url) {
    if (!url) return defaultEndpoint();
    if (url.indexOf('/youtubei/v1/browse') !== -1) return 'browse';
    if (url.indexOf('/youtubei/v1/next') !== -1) return 'next';
    return defaultEndpoint();
  }

  function defaultEndpoint() {
    return /^\/watch/.test(location.pathname) ? 'next' : 'browse';
  }

  function endpointOf(contEndpoint, fallback) {
    const u =
      contEndpoint &&
      contEndpoint.commandMetadata &&
      contEndpoint.commandMetadata.webCommandMetadata &&
      contEndpoint.commandMetadata.webCommandMetadata.apiUrl;
    if (typeof u === 'string') {
      if (u.indexOf('/next') !== -1) return 'next';
      if (u.indexOf('/browse') !== -1) return 'browse';
    }
    return fallback || defaultEndpoint();
  }

  let transcriptController = null;
  let lastProgress = 0;
  const pageFetch = window.fetch.bind(window);
  function syncCollectionSource() {
    const key = sourceKey();
    if (key === collectionSource) return;
    activeCollection?.controller.abort(new Error('Source changed.'));
    transcriptController?.abort(new Error('Source changed.'));
    activeCollection = null;
    collectionSource = key;
    sourceGeneration++;
    savedSeedToken = null;
    Object.assign(state, createCollectionState());
    resetMetadata();
    updateProgressUI(true);
  }

  // ------------------------------------------------------------------ capture
  const nativeFetch = pageFetch;

  pageWin.fetch = function () {
    const promise = nativeFetch.apply(pageWin, arguments);
    try {
      const input = arguments[0];
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const endpoint = url && new URL(url, location.href);
      if (endpoint?.origin === location.origin && /^\/youtubei\/v1\/(browse|next)$/.test(endpoint.pathname)) {
        syncCollectionSource();
        const generation = sourceGeneration;
        promise.then(async (res) => {
          const json = await res.clone().json();
          if (generation !== sourceGeneration || collectionSource !== sourceKey()) return;
          const items = continuationItems(json);
          const isTopPage = items.some((item) => item.commentThreadRenderer || item.commentsHeaderRenderer)
            || commentMutations(json).some((m) => {
              const properties = m?.payload?.commentEntityPayload?.properties;
              return properties?.commentId && !properties.replyLevel;
            });
          // Replies opened by the page lack a trusted parent. The crawler follows the thread's token.
          if (!isTopPage) return;
          ingest(json, null, endpointFromUrl(url), true, items);
          updateProgressUI();
        }).catch(() => {});
      }
    } catch (e) {}
    return promise;
  };

  // ------------------------------------------------------------------ parsing
  function continuationItems(data) {
    const items = [];
    for (const ep of data.onResponseReceivedEndpoints || []) {
      for (const k of Object.keys(ep)) {
        const ci = ep[k] && ep[k].continuationItems;
        if (Array.isArray(ci)) items.push.apply(items, ci);
      }
    }
    return items;
  }

  function isEmptyReplyPage(data, parent) {
    // YouTube sometimes omits continuationItems for a thread with no visible replies.
    return !!parent && (data.onResponseReceivedEndpoints || []).some((endpoint) => {
      const action = endpoint?.appendContinuationItemsAction;
      return action?.targetId === 'comment-replies-item-' + parent
        && (action.continuationItems === undefined
          || (Array.isArray(action.continuationItems) && action.continuationItems.length === 0));
    });
  }

  function commentMutations(data) {
    return data.frameworkUpdates?.entityBatchUpdate?.mutations || [];
  }

  function harvestEntities(data, parentId, fromCapture) {
    let added = 0;
    for (const m of commentMutations(data)) {
      const p = m?.payload?.commentEntityPayload;
      if (!p?.properties || (fromCapture && p.properties.replyLevel > 0)) continue;
      const cid = p.properties.commentId;
      if (!cid || state.comments.has(cid)) continue;
      if (state.incremental) {
        if (!parentId && state.knownTopIds?.has(cid)) continue;
        if (parentId && state.knownAllIds?.has(cid)) continue;
      }
      const comment = {
        id: cid,
        parent: parentId || null,
        author: String(p.author?.displayName || '').replace(/^@+/, '').trim(),
        authorChannelId: p.author?.channelId || '',
        avatar: p.author?.avatarThumbnailUrl || '',
        text: String(p.properties.content?.content || '').slice(0, 32768),
        published: p.properties.publishedTime || '',
        likes: p.toolbar?.likeCountNotliked || p.toolbar?.likeCountLiked || '0',
        replyCount: p.toolbar?.replyCount || '',
      };
      const bytes = encoder.encode(JSON.stringify(comment)).byteLength + 1;
      if (state.comments.size >= 50000 || state.commentBytes + bytes > MAX_COMMENT_BYTES) {
        state.limitReached = true;
        break;
      }
      state.commentBytes += bytes;
      state.comments.set(cid, comment);
      added++;
    }
    return added;
  }

  function threadIdOf(thread) {
    if (!thread) return null;
    const cv = thread.commentViewModel;
    if (cv && cv.commentViewModel && cv.commentViewModel.commentId) return cv.commentViewModel.commentId;
    if (cv && cv.commentId) return cv.commentId;
    if (thread.comment && thread.comment.commentRenderer && thread.comment.commentRenderer.commentId) return thread.comment.commentRenderer.commentId;
    return null;
  }

  function collectTokens(items, inheritedParent, endpoint) {
    const found = [];
    for (const it of items) {
      if (it.commentThreadRenderer) {
        const tid = threadIdOf(it.commentThreadRenderer);
        const subs = it.commentThreadRenderer.replies;
        if (subs) {
          (function walk(node, parent) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
              for (const x of node) walk(x, parent);
              return;
            }
            const cc = (node.continuationEndpoint && node.continuationEndpoint.continuationCommand) || node.continuationCommand;
            if (cc && typeof cc.token === 'string') {
              found.push({ token: cc.token, parent: parent || null, endpoint: endpointOf(node.continuationEndpoint || node, endpoint) });
            }
            for (const k in node) if (k !== 'continuationEndpoint' && k !== 'continuationCommand') walk(node[k], parent);
          })(subs, tid);
        }
      } else if (it.continuationItemRenderer) {
        const ce = it.continuationItemRenderer.continuationEndpoint;
        const cc = ce && ce.continuationCommand;
        if (cc && typeof cc.token === 'string') {
          found.push({ token: cc.token, parent: inheritedParent || null, endpoint: endpointOf(ce, endpoint) });
        }
      }
    }
    return found;
  }

  function pushToken(token, parent, endpoint) {
    if (!token) return;
    const ep = endpoint || defaultEndpoint();
    const key = tokenKey(ep, token);
    if (state.seenTokens.has(key)) return;
    if (state.queuedKeys.has(key)) return;
    state.queuedKeys.add(key);
    state.queue.push({ key: key, token: token, parent: parent || null, endpoint: ep });
  }

  // ---- reported count ----
  function parseCountText(text) {
    const m = /([\d.,]+)\s*([KMB])?/i.exec(String(text || '').replace(/\s+/g, ' '));
    if (!m) return 0;
    let n = parseFloat(m[1].replace(/,/g, ''));
    const u = (m[2] || '').toUpperCase();
    if (u === 'K') n *= 1e3;
    else if (u === 'M') n *= 1e6;
    else if (u === 'B') n *= 1e9;
    return Math.round(n);
  }

  function readReportedCount() {
    const nodes = Array.from(document.querySelectorAll('ytd-comments-header-renderer #count'));
    const visible = nodes.filter(isVisible)[0] || nodes[0];
    if (!visible) return 0;
    return parseCountText(visible.textContent);
  }

  // Request budget scales with the section size YouTube advertises: ~20 comments per page,
  // plus reply pages. 4x the page count covers reply-heavy sections; hard-capped.
  function computeBudget(reported) {
    if (!reported || reported < 20) return 2000;
    const est = Math.ceil(reported / 20) * 4;
    return Math.min(Math.max(est, 400), 25000);
  }

  // ---- sort switching ----
  function detectSort(data, endpoint) {
    let header = null;
    (function find(node, depth) {
      if (header || !node || typeof node !== 'object' || depth > 60) return;
      const candidate = node.commentsHeaderRenderer;
      if (candidate?.sortMenu?.sortFilterSubMenuRenderer?.subMenuItems?.length) {
        header = candidate;
        return;
      }
      for (const k in node) find(node[k], depth + 1);
    })(data, 0);

    const sm = header && header.sortMenu && header.sortMenu.sortFilterSubMenuRenderer;
    if (!sm || !Array.isArray(sm.subMenuItems)) return null;

    const opts = [];
    for (const it of sm.subMenuItems) {
      const se = it.serviceEndpoint;
      const tok = se && se.continuationCommand && se.continuationCommand.token;
      if (!tok) continue;
      opts.push({ title: String(it.title || ''), selected: !!it.selected, token: tok, endpoint: endpointOf(se, endpoint || defaultEndpoint()) });
    }
    return opts.length ? opts : null;
  }

  function applySortSwitch(opts) {
    if (!opts || state.sortRequested) return;
    const newest = opts.filter((o) => /new/i.test(o.title))[0];
    if (!newest) return;
    state.sortRequested = true;
    if (newest.selected) {
      state.sortApplied = newest.title;
      state.sortConfirmed = true;
      return;
    }
    for (const q of state.queue) {
      if (q.parent) continue;
      state.seenTokens.add(q.key);
      state.queuedKeys.delete(q.key);
    }
    state.queue = state.queue.filter((q) => q.parent);
    const key = tokenKey(newest.endpoint, newest.token);
    state.seenTokens.delete(key);
    state.queuedKeys.add(key);
    state.switchedFromTop = true;
    state.queue.unshift({ key: key, token: newest.token, parent: null, endpoint: newest.endpoint, isSort: true });
    state.sortApplied = newest.title;
  }

  function extractHeaderCount(data) {
    let count = 0;
    (function find(node, depth) {
      if (count > 0 || !node || typeof node !== 'object' || depth > 50) return;
      const header = node.commentsHeaderRenderer;
      if (header) {
        const text = runsToText(header.countText) || runsToText(header.commentsCount);
        const parsed = parseCountText(text);
        if (parsed > 0) { count = parsed; return; }
      }
      const entryPoint = node.commentsEntryPointHeaderRenderer;
      if (entryPoint) {
        const parsed = parseCountText(runsToText(entryPoint.commentCount));
        if (parsed > 0) { count = parsed; return; }
      }
      for (const k in node) find(node[k], depth + 1);
    })(data, 0);
    return count;
  }

  function extractCommentTokensFromData(data, endpoint) {
    const tokens = [];
    (function walk(node, depth) {
      if (!node || typeof node !== 'object' || depth > 80) return;
      const section = node.itemSectionRenderer;
      if (Array.isArray(section?.contents) && (
        /comments?/.test(section.targetId || section.sectionIdentifier || '')
        || section.contents.some((item) => item?.commentThreadRenderer)
      )) {
        for (const token of collectTokens(section.contents, null, endpoint)) {
          tokens.push(token);
        }
      }
      for (const value of Object.values(node)) walk(value, depth + 1);
    })(data, 0);
    return tokens;
  }

  function findInitialSeedTokens() {
    const key = collectionSource;
    const id = key.startsWith('video:') ? key.slice(6) : '';
    const data = !id || pageWin.ytInitialPlayerResponse?.videoDetails?.videoId === id
      ? watchResponseFor(id) || pageWin.ytInitialData : watchResponseFor(id);
    const endpoint = defaultEndpoint();
    const tokens = extractCommentTokensFromData(data, endpoint);
    if (tokens.length && !savedSeedToken) savedSeedToken = tokens[0];
    return { tokens, data, endpoint };
  }

  function purgeTopQueue() {
    for (const queued of state.queue) {
      if (!queued.parent) state.queuedKeys.delete(queued.key);
    }
    state.queue = state.queue.filter((queued) => queued.parent);
  }

  function expectedNewComments() {
    return state.baselineCount > 0 && state.reported > state.baselineCount
      ? state.reported - state.baselineCount : 0;
  }

  function ingest(data, parentId, endpoint, fromCapture, items = continuationItems(data)) {
    const ep = endpoint || defaultEndpoint();
    if (!parentId) {
      const headerCount = extractHeaderCount(data);
      if (headerCount > 0) state.reported = headerCount;
      if (!state.sortRequested) applySortSwitch(detectSort(data, ep));
      if (state.incremental && state.switchedFromTop && !state.sortConfirmed) return 0;
    }
    const updatedReplyIds = new Set();
    if (state.incremental && !parentId && state.knownTopIds) {
      const liveReplyCounts = new Map();
      for (const m of commentMutations(data)) {
        const p = m?.payload?.commentEntityPayload;
        const cid = p?.properties?.commentId;
        if (cid && !p.properties.replyLevel) {
          const raw = String(p.toolbar?.replyCount || '').trim();
          liveReplyCounts.set(cid, { count: parseCountText(raw), raw });
        }
      }
      for (const item of items) {
        const thread = item.commentThreadRenderer;
        if (!thread) continue;
        const tid = threadIdOf(thread);
        if (!tid || !state.knownTopIds.has(tid)) continue;
        let info = liveReplyCounts.get(tid);
        if (!info || !info.count) {
          const rep = thread.replies?.commentRepliesRenderer;
          const label = runsToText(rep?.viewReplies?.buttonRenderer?.text) || runsToText(rep?.moreText) || '';
          const parsed = parseCountText(label);
          if (parsed > 0) info = { count: parsed, raw: String(parsed) };
        }
        const knownCount = state.knownReplyCounts?.get(tid) || 0;
        if (info && info.count > knownCount) {
          updatedReplyIds.add(tid);
          if (state.updatedReplyCounts && info.raw) state.updatedReplyCounts[tid] = info.raw;
        }
      }
    }
    const added = harvestEntities(data, parentId, fromCapture);
    if (items.length) {
      if (parentId) state.stats.replyPages++;
      else state.stats.topPages++;
      let stopTop = false;
      if (state.incremental && !parentId && state.knownTopIds) {
        if (!state.overlapReached) {
          for (const item of items) {
            if (!item.commentThreadRenderer) continue;
            const tid = threadIdOf(item.commentThreadRenderer);
            if (!tid) continue;
            if (state.knownTopIds.has(tid)) {
              state.overlapStreak++;
              if (state.overlapStreak >= 5) {
                state.overlapReached = true;
                break;
              }
            } else {
              state.overlapStreak = 0;
            }
          }
        }
        const expected = expectedNewComments();
        const satisfied = expected === 0 || state.comments.size >= expected;
        if (state.overlapReached && !satisfied) state.replyScanPages++;
        stopTop = state.overlapReached && (satisfied || state.replyScanPages > 25);
        if (stopTop) purgeTopQueue();
      }
      for (const t of collectTokens(items, parentId, ep)) {
        if (fromCapture && !parentId && !t.parent && state.switchedFromTop) continue;
        if (state.incremental && !parentId) {
          if (!t.parent && stopTop) continue;
          if (t.parent && state.knownTopIds?.has(t.parent) && !updatedReplyIds.has(t.parent)) continue;
        }
        pushToken(t.token, parentId || t.parent, t.endpoint);
      }
    }
    return added;
  }

  function seedFromInitialData() {
    const { tokens, data, endpoint } = findInitialSeedTokens();
    let count = 0;
    for (const token of tokens) {
      pushToken(token.token, token.parent, token.endpoint);
      count++;
    }
    if (!state.sortRequested && data) applySortSwitch(detectSort(data, endpoint));
    return count;
  }

  async function checkReportedCount() {
    const key = collectionSource;
    const cfg = getConfig();
    if (!cfg) return { count: readReportedCount() };
    const signal = AbortSignal.timeout(10000);
    const seed = savedSeedToken || findInitialSeedTokens().tokens[0];
    if (seed) {
      try {
        const data = await fetchPage(cfg, seed.token, seed.endpoint, signal);
        if (sourceKey() !== key) return { count: 0 };
        const count = extractHeaderCount(data);
        if (count > 0) return { count };
      } catch {}
    }
    if (key.startsWith('video:')) {
      try {
        const data = await youtubePost(cfg, 'next', { videoId: key.slice(6) }, signal);
        if (sourceKey() !== key) return { count: 0 };
        const freshTokens = extractCommentTokensFromData(data, 'next');
        if (freshTokens.length) {
          savedSeedToken = freshTokens[0];
          try {
            const headerData = await fetchPage(cfg, freshTokens[0].token, freshTokens[0].endpoint, signal);
            if (sourceKey() !== key) return { count: 0 };
            const exact = extractHeaderCount(headerData);
            if (exact > 0) return { count: exact };
          } catch {}
        }
        const count = extractHeaderCount(data);
        if (count > 0) return { count };
      } catch {}
    }
    return { count: readReportedCount() };
  }

  function getConfig() {
    const y = pageWin.ytcfg;
    const get = (k) => (y && typeof y.get === 'function' ? y.get(k) : y && y.data_ ? y.data_[k] : undefined);
    const ctx = get('INNERTUBE_CONTEXT');
    const key = get('INNERTUBE_API_KEY');
    if (!ctx || !key) return null;
    return { ctx: ctx, key: key, version: (ctx.client && ctx.client.clientVersion) || '2.20250101.00.00' };
  }

  async function youtubePost(cfg, endpoint, payload, signal) {
    const res = await nativeFetch(location.origin + '/youtubei/v1/' + endpoint +
      '?key=' + encodeURIComponent(cfg.key) + '&prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      redirect: 'error',
      signal,
      headers: { 'Content-Type': 'application/json', 'X-Youtube-Client-Name': '1', 'X-Youtube-Client-Version': cfg.version },
      body: JSON.stringify({ context: cfg.ctx, ...payload }),
    });
    if (!res.ok) {
      const error = new Error('HTTP ' + res.status + ' on /' + endpoint);
      error.status = res.status;
      throw error;
    }
    return res.json();
  }

  function fetchPage(cfg, token, endpoint, signal) {
    return youtubePost(cfg, endpoint || defaultEndpoint(), { continuation: token }, signal);
  }

  function run(background) {
    syncCollectionSource();
    if (activeCollection) return activeCollection.promise;
    const job = { controller: new AbortController(), reason: '', source: collectionSource, background };
    activeCollection = job;
    job.promise = collectComments(job).finally(() => {
      if (activeCollection === job) activeCollection = null;
    });
    return job.promise;
  }

  function stopCollection(reason = 'stopped') {
    if (!activeCollection || activeCollection.controller.signal.aborted) return;
    activeCollection.reason = reason;
    state.aborted = reason === 'stopped';
    state.statusText = reason === 'stopped' ? 'stopping…' : reason;
    activeCollection.controller.abort(new Error(reason));
    updateProgressUI();
  }

  function isCurrentCollection(job) {
    return activeCollection === job && job.source === sourceKey();
  }

  function nextJob() {
    let index = state.queue.findIndex((entry) => entry.isSort);
    if (index >= 0) {
      state.topStreak = 0;
    } else {
      const top = state.queue.findIndex((entry) => !entry.parent);
      const reply = state.queue.findIndex((entry) => entry.parent);
      const takeTop = state.incremental && state.overlapReached
        ? (reply < 0 && top >= 0)
        : (top >= 0 && (reply < 0 || state.topStreak < 6));
      index = takeTop ? top : reply;
      state.topStreak = takeTop ? state.topStreak + 1 : 0;
    }
    return state.queue.splice(index, 1)[0];
  }

  function extendBudget() {
    if (state.attempts < state.maxRequests) return true;
    if (state.attempts - state.lastGainAt >= 20 || state.maxRequests >= MAX_CEILING) return false;
    state.maxRequests = Math.min(state.maxRequests + 200, MAX_CEILING);
    return true;
  }

  async function fetchContinuation(cfg, entry, signal) {
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      if (!extendBudget()) throw new Error('request budget reached');
      state.attempts++;
      const controller = new AbortController();
      const cancel = () => controller.abort(signal.reason);
      signal.addEventListener('abort', cancel, { once: true });
      const timeout = setTimeout(() => controller.abort(new Error('page request timed out')), PAGE_TIMEOUT_MS);
      try {
        const data = await fetchPage(cfg, entry.token, entry.endpoint, controller.signal);
        controller.signal.throwIfAborted();
        return data;
      } catch (failure) {
        signal.throwIfAborted();
        const error = controller.signal.aborted ? controller.signal.reason : failure;
        const retryable = !error.status || error.status === 408 || error.status === 429 || error.status >= 500;
        if (!retryable || attempt >= MAX_PAGE_ATTEMPTS) throw error;
        state.errors.push('Retry ' + attempt + ' on /' + entry.endpoint + ': ' + error.message);
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', cancel);
      }
      await sleep(400 * 2 ** (attempt - 1), signal);
    }
  }

  function queueReplyFallback(data, entry) {
    (function sweep(node, depth) {
      if (!node || typeof node !== 'object' || depth > 60) return;
      const endpoint = node.continuationEndpoint || node.buttonRenderer?.command || node;
      const continuation = endpoint.continuationCommand;
      if (continuation && typeof continuation.token === 'string') {
        pushToken(continuation.token, entry.parent, endpointOf(endpoint, entry.endpoint));
      }
      for (const key in node) {
        if (key !== 'continuationEndpoint' && key !== 'continuationCommand') sweep(node[key], depth + 1);
      }
    })(data, 0);
  }

  async function collectComments(job) {
    if (state.limitReached) {
      state.result = { status: 'partial', reason: 'Comment export reached its size limit' };
      return state.result;
    }
    if (state.result.status === 'complete' && !state.queue.length) return state.result;

    const signal = job.controller.signal;
    const deadline = setTimeout(() => {
      if (isCurrentCollection(job)) stopCollection('time limit reached');
    }, DEADLINE_MINUTES * 60000);
    state.running = true;
    state.aborted = false;
    state.requests = 0;
    state.attempts = 0;
    state.lastGainAt = 0;
    state.errors = [];
    state.startedAt = new Date();
    state.result = { status: 'running', reason: 'collection in progress' };
    state.statusText = 'starting…';
    resetMetadata();
    state.reported = readReportedCount();
    state.maxRequests = computeBudget(state.reported);

    let entry = null;
    let stopReason = '';
    let idle = 0;
    try {
      const cfg = getConfig();
      if (!cfg) throw new Error('could not read ytcfg — reload the page');

      // Seed tokens without scrolling the YouTube page whenever initial data or a cached seed is available.
      if (!state.queue.length) seedFromInitialData();
      if (!state.queue.length && savedSeedToken) {
        pushToken(savedSeedToken.token, savedSeedToken.parent, savedSeedToken.endpoint);
      }
      if (!state.queue.length && collectionSource.startsWith('video:')) {
        try {
          const freshData = await youtubePost(cfg, 'next', { videoId: collectionSource.slice(6) }, signal);
          if (!isCurrentCollection(job)) return;
          const freshTokens = extractCommentTokensFromData(freshData, 'next');
          if (freshTokens.length) {
            savedSeedToken = freshTokens[0];
            for (const token of freshTokens) pushToken(token.token, token.parent, token.endpoint);
            if (!state.sortRequested) applySortSwitch(detectSort(freshData, 'next'));
          }
        } catch (error) {
          signal.throwIfAborted();
        }
      }
      if (!job.background && !state.queue.length && !state.comments.size) {
        const section = document.querySelector('ytd-comment-section-renderer, #comments');
        if (section) section.scrollIntoView({ block: 'center' });
        else window.scrollTo(0, document.body.scrollHeight);
        await sleep(2500, signal);
        if (!isCurrentCollection(job)) return;
        if (!state.queue.length) {
          window.scrollBy(0, 600);
          await sleep(2500, signal);
        }
        if (!state.queue.length) seedFromInitialData();
      }

      if (!isCurrentCollection(job)) return;
      if (!state.queue.length) throw new Error('no comment tokens found — scroll to the comments, then retry');

      while (state.queue.length) {
        signal.throwIfAborted();
        if (!isCurrentCollection(job)) return;
        entry = nextJob();
        const alreadySwitched = state.switchedFromTop;
        const data = await fetchContinuation(cfg, entry, signal);
        signal.throwIfAborted();
        if (!isCurrentCollection(job)) return;
        const items = continuationItems(data);
        const hasComments = commentMutations(data).some((m) => m?.payload?.commentEntityPayload?.properties?.commentId);
        const hasCommentItems = items.some((item) => item?.commentThreadRenderer || item?.commentViewModel
          || item?.commentRenderer || item?.commentsHeaderRenderer || item?.continuationItemRenderer);
        const hasCommentTarget = (data.onResponseReceivedEndpoints || []).some((response) =>
          Object.values(response).some((action) => Array.isArray(action?.continuationItems)
            && /comment/i.test(action.targetId || ''))
        );
        const emptyReply = isEmptyReplyPage(data, entry.parent);
        if (!hasComments && !hasCommentItems && !hasCommentTarget && !emptyReply) {
          throw new Error('unexpected ' + (entry.parent ? 'reply' : 'comment') + ' response on /' + entry.endpoint);
        }

        if (entry.isSort) state.sortConfirmed = true;
        const previousSort = !entry.parent && !entry.isSort && !alreadySwitched && state.switchedFromTop;
        const added = ingest(data, entry.parent, entry.endpoint, previousSort, items);
        if (entry.parent) queueReplyFallback(data, entry);
        state.requests++;
        state.seenTokens.add(entry.key);
        state.queuedKeys.delete(entry.key);
        entry = null;

        if (added) state.lastGainAt = state.attempts;
        if (state.incremental && state.overlapReached) {
          const expected = expectedNewComments();
          if (expected === 0 || state.comments.size >= expected) purgeTopQueue();
        }
        idle = added || emptyReply ? 0 : idle + 1;
        updateProgressUI();
        if (state.limitReached) {
          stopReason = 'Comment export reached its size limit';
          break;
        }
        const idleLimit = state.incremental && state.overlapReached ? 30 : 15;
        if (idle > idleLimit && state.queue.length) {
          stopReason = 'no new comments in ' + (idleLimit + 1) + ' consecutive pages';
          break;
        }
        if (state.queue.length) await sleep(DELAY_MS, signal);
      }
    } catch (error) {
      if (!isCurrentCollection(job)) return;
      stopReason = job.reason || error.message || String(error);
      if (entry && !state.seenTokens.has(entry.key)) state.queue.unshift(entry);
      if (!job.reason) state.errors.push(stopReason);
    } finally {
      clearTimeout(deadline);
      if (isCurrentCollection(job)) {
        state.running = false;
        const status = job.reason === 'stopped' ? 'stopped' : stopReason
          ? (state.comments.size ? 'partial' : 'error')
          : 'complete';
        state.result = { status, reason: stopReason || 'continuations exhausted' };
        state.statusText = status + ' · ' + summary()
          + (stopReason ? ' · ' + stopReason : '')
          + (state.sortConfirmed ? ' · sorted by ' + state.sortApplied : '');
        updateProgressUI(true);
      }
    }
    return isCurrentCollection(job) ? state.result : undefined;
  }

  function collectionReport() {
    const pendingPages = state.queuedKeys.size;
    const result = state.result;
    if (result.status === 'complete' && pendingPages) {
      return { status: 'partial', reason: 'additional continuations are queued', pendingPages };
    }
    const status = result.status === 'running' || result.status === 'idle' ? 'partial' : result.status;
    return { ...result, status, pendingPages, limitReached: state.limitReached };
  }

  function counts() {
    let tops = 0;
    state.comments.forEach((c) => {
      if (!c.parent) tops++;
    });
    return { top: tops, replies: state.comments.size - tops, total: state.comments.size };
  }

  function summary() {
    const c = counts();
    return c.top + ' comments · ' + c.replies + ' replies · ' + state.requests + ' pages';
  }

  function progressPercent() {
    if (!state.reported) return 0;
    const pct = Math.round((state.comments.size / state.reported) * 100);
    if (state.running) return Math.max(0, Math.min(99, pct));
    return state.comments.size ? Math.min(100, Math.max(1, pct)) : 0;
  }

  // ------------------------------------------------------------------ metadata
  function runsToText(o) {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (o.simpleText) return o.simpleText;
    if (o.runs) return o.runs.map((r) => r.text || '').join('');
    return '';
  }

  function toInt(v) {
    const n = parseInt(String(v == null ? '' : v).replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }

  function readVideoLikeCount() {
    const nodes = Array.from(
      document.querySelectorAll('like-button-view-model button, #segmented-like-button button, ytd-segmented-like-dislike-button-renderer button, ytd-toggle-button-renderer button')
    );
    for (const b of nodes) {
      const label = b.getAttribute('aria-label') || b.getAttribute('title') || '';
      const m = /(?:along with|with)\s+([\d,.]+\s*[KMB]?)/i.exec(label);
      if (m) return parseCountText(m[1]);
      const t = (b.textContent || '').trim();
      if (/^[\d,.]+\s*[KMB]?$/.test(t)) return parseCountText(t);
    }
    return 0;
  }

  function findPostData() {
    const key = sourceKey();
    let found = null;
    (function walk(node, depth) {
      if (found || !node || typeof node !== 'object' || depth > 40) return;
      const post = node.backstagePostRenderer || node.postRenderer;
      if (post && (post.contentText || post.backstageAttachment || post.postAttachment)
        && (!key.startsWith('post:') || 'post:' + post.postId === key)) {
        found = post;
        return;
      }
      for (const k in node) walk(node[k], depth + 1);
    })(pageWin.ytInitialData, 0);
    return found;
  }

  function watchResponseFor(videoId) {
    if (!videoId) return null;
    const app = pageDoc.querySelector('ytd-app')?.data;
    const watch = pageDoc.querySelector('ytd-watch-flexy[video-id]')?.data;
    return [app?.response, watch, pageWin.ytInitialData].find((response) =>
      response?.currentVideoEndpoint?.watchEndpoint?.videoId === videoId
    );
  }

  function playerResponseFor(videoId) {
    if (!videoId) return null;
    return [pageDoc.querySelector('ytd-app')?.data?.playerResponse, pageWin.ytInitialPlayerResponse].find(
      (response) => response?.videoDetails?.videoId === videoId
    );
  }

  function watchTitleFor(videoId) {
    const title = playerResponseFor(videoId)?.videoDetails?.title;
    if (title) return title;
    const response = watchResponseFor(videoId);
    const contents = response?.contents?.twoColumnWatchNextResults?.results?.results?.contents;
    const fromResponse = runsToText(contents?.find((item) => item.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer?.title);
    if (fromResponse) return fromResponse;
    try {
      const player = pageDoc.querySelector('ytd-watch-flexy #movie_player')?.getVideoData?.();
      if (player?.video_id === videoId) return player.title || '';
    } catch (e) {}
    const watch = document.querySelector('ytd-watch-flexy[video-id]');
    if (watch?.getAttribute('video-id') !== videoId) return '';
    return watch.querySelector('ytd-watch-metadata h1')?.textContent?.trim() || '';
  }

  function collectMetadata() {
    const isVideo = /^\/watch/.test(location.pathname);
    const meta = {
      kind: isVideo ? 'video' : 'post',
      url: canonicalSource(),
      id: '',
      channel: getChannel(),
      channelId: '',
      title: getTitle(),
      collectedAt: new Date().toISOString(),
    };

    try {
      if (isVideo) {
        meta.id = new URLSearchParams(location.search).get('v') || '';
        const pr = playerResponseFor(meta.id) || {};
        const vd = pr.videoDetails || {};
        const mf = (pr.microformat && pr.microformat.playerMicroformatRenderer) || {};

        if (vd.title) meta.title = vd.title;
        if (vd.author) meta.channel = String(vd.author).replace(/^@+/, '');
        meta.channelId = vd.channelId || mf.externalChannelId || '';
        meta.description = vd.shortDescription || '';
        if (!meta.description) {
          const d = document.querySelector('#description-inline-expander yt-attributed-string, #description yt-formatted-string, #description');
          if (d) meta.description = (d.textContent || '').trim();
        }
        meta.viewCount = toInt(vd.viewCount);
        meta.lengthSeconds = toInt(vd.lengthSeconds);
        meta.keywords = Array.isArray(vd.keywords) ? vd.keywords : [];
        meta.isLive = !!vd.isLiveContent;
        meta.category = mf.category || '';
        meta.uploadDate = mf.uploadDate || mf.publishDate || '';
        meta.publishDate = mf.publishDate || '';
        const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
        meta.thumbnail = thumbs.length ? thumbs[thumbs.length - 1].url : '';
        meta.likeCount = readVideoLikeCount();
        if (!meta.publishDate) {
          const info = document.querySelector('#info-strings yt-formatted-string, #info-strings');
          if (info) meta.publishDateText = (info.textContent || '').trim();
        }
      } else {
        const post = findPostData();
        if (post) {
          meta.id = post.postId || '';
          const author = runsToText(post.authorText).replace(/^@+/, '').trim();
          if (author) meta.channel = author;
          meta.text = runsToText(post.contentText);
          meta.publishedTime = runsToText(post.publishedTimeText);
          meta.likeCount = parseCountText(runsToText(post.voteCount));
          meta.images = [];
          meta.poll = null;

          const att = post.backstageAttachment || post.postAttachment || {};
          const single = att.backstageImageRenderer && att.backstageImageRenderer.image;
          if (single && single.thumbnails && single.thumbnails.length) {
            meta.images.push(single.thumbnails[single.thumbnails.length - 1].url);
          }
          const multi = att.postMultiImageRenderer;
          if (multi && Array.isArray(multi.images)) {
            for (const img of multi.images) {
              const th = img.image && img.image.thumbnails;
              if (th && th.length) meta.images.push(th[th.length - 1].url);
            }
          }
          const poll = att.backstagePollRenderer || att.pollRenderer;
          if (poll) {
            meta.poll = {
              totalVotes: parseCountText(runsToText(poll.totalVotes)),
              choices: (poll.choices || []).map((c) => ({
                text: runsToText(c.text),
                votes: parseCountText(runsToText(c.voteCount)),
              })),
            };
          }
          if (att.videoRenderer) {
            meta.video = {
              id: att.videoRenderer.videoId || '',
              title: runsToText(att.videoRenderer.title),
            };
          }
        }
        // DOM fallbacks (post data sometimes arrives after the initial payload)
        if (!meta.text) {
          const t = document.querySelector('ytd-post-renderer #content-text, #content-text');
          if (t) meta.text = (t.textContent || '').trim();
        }
        if (!meta.likeCount) {
          const v = document.querySelector('ytd-post-renderer #vote-count-middle, #vote-count-middle');
          if (v) meta.likeCount = parseCountText(v.textContent);
        }
        if (!meta.images) meta.images = [];
        if (!meta.images.length) {
          const imgs = Array.from(document.querySelectorAll('ytd-post-renderer img[src], ytd-backstage-image-renderer img[src]'))
            .map((i) => i.getAttribute('src'))
            .filter((u) => u && /^https?:/.test(u));
          meta.images = imgs.slice(0, 10);
        }
      }
    } catch (e) {
      meta.error = String((e && e.message) || e);
    }

    return meta;
  }

  let metadataCache = null;
  function metadataForExport() {
    syncCollectionSource();
    if (!metadataCache) metadataCache = collectMetadata();
    return metadataCache;
  }

  function resetMetadata() {
    metadataCache = null;
  }

  function canonicalSource() {
    const key = sourceKey();
    return 'https://www.youtube.com/' + (key.startsWith('video:') ? 'watch?v=' : 'post/') +
      encodeURIComponent(key.slice(key.indexOf(':') + 1));
  }

  function exportData() {
    return {
      source: canonicalSource(),
      metadata: metadataForExport(),
      exportedAt: new Date().toISOString(),
      startedAt: state.startedAt?.toISOString() || null,
      reportedCount: state.reported,
      ...(state.updatedReplyCounts && Object.keys(state.updatedReplyCounts).length
        ? { updatedReplyCounts: state.updatedReplyCounts } : {}),
      collection: collectionReport(),
      stats: { requests: state.requests, attempts: state.attempts, sort: state.sortConfirmed ? state.sortApplied : '', errors: [...state.errors] },
      comments: Array.from(state.comments.values()),
    };
  }

  function getChannel() {
    const candidates = [
      'ytd-video-owner-renderer #channel-name a',
      '#owner #channel-name a',
      'ytd-channel-name a',
      'ytd-post-renderer #author-text',
      '#author-text',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      const t = el && el.textContent ? el.textContent.trim() : '';
      if (t) return cleanLabel(t.replace(/^@+/, ''), 60);
    }
    return 'youtube';
  }

  function getTitle() {
    const key = sourceKey();
    const watchTitle = key.startsWith('video:') && watchTitleFor(key.slice(6));
    if (watchTitle) return cleanLabel(watchTitle, 90);
    const h1 = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1 yt-formatted-string, h1.title, h1');
    if (h1 && h1.textContent && h1.textContent.trim()) return cleanLabel(h1.textContent, 90);
    const og = document.querySelector('meta[property="og:title"]');
    if (og && og.content) return cleanLabel(og.content, 90);
    const doc = cleanLabel(document.title.replace(/\s*-\s*YouTube\s*$/, ''), 90);
    return doc || 'comments';
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function segmentsToTranscript(items) {
    const blocks = [];
    let current = null;
    for (const it of items || []) {
      const sec = parseTimestampToSeconds(it && it.time);
      if (sec === null) continue;
      const text = String((it && it.text) || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (!current || sec - current.start >= 30) {
        if (current) blocks.push(current);
        current = { start: sec, text: [text] };
      } else {
        current.text.push(text);
      }
    }
    if (current) blocks.push(current);
    return blocks
      .map((b) => {
        const m = Math.floor(b.start / 60);
        const sec = String(b.start % 60).padStart(2, '0');
        return '[' + m + ':' + sec + '] ' + b.text.join(' ');
      })
      .join('\n');
  }

  function findTranscriptButton() {
    const nodes = Array.from(document.querySelectorAll('button, ytd-button-renderer'));
    for (const el of nodes) {
      const label = ((el.textContent || '') + ' ' + ((el.getAttribute && el.getAttribute('aria-label')) || '')).trim();
      if (!/show transcript/i.test(label)) continue;
      // the control often sits in a collapsed description: hidden but still clickable
      return el.querySelector && el.querySelector('button') ? el.querySelector('button') : el;
    }
    return null;
  }

  function transcriptPanelEl() {
    return document.querySelector('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]');
  }

  function readTranscriptSegments(panel) {
    return Array.from(panel.querySelectorAll('transcript-segment-view-model')).map((seg) => {
      const timeEl =
        seg.querySelector('.ytwTranscriptSegmentViewModelTimestamp') ||
        seg.querySelector('[class*="Timestamp"]') ||
        seg.querySelector('div');
      const textEl = seg.querySelector('span[role="text"]') || seg.querySelector('span') || seg;
      return {
        time: ((timeEl && timeEl.textContent) || '').trim(),
        text: ((textEl && textEl.textContent) || '').trim(),
      };
    });
  }

  function transcriptRequestFor(videoId) {
    const watch = pageDoc.querySelector('ytd-watch-flexy[video-id]');
    const responseId = watch?.data?.currentVideoEndpoint?.watchEndpoint?.videoId;
    if (watch?.getAttribute('video-id') === videoId && (!responseId || responseId === videoId)) {
      for (const button of watch.querySelectorAll('yt-button-view-model, ytd-button-renderer')) {
        const command = button.data?.command;
        if (!command) continue;
        for (const item of command.commandExecutorCommand?.commands || [command]) {
          const update = item?.updateEngagementPanelContentCommand;
          const panelId = update?.contentSourcePanelIdentifier?.tag;
          const params = update?.globalConfiguration?.params;
          if (typeof panelId === 'string' && /transcript/i.test(panelId) && typeof params === 'string' && params) {
            return { endpoint: 'get_panel', payload: { panelId, params } };
          }
        }
      }
    }

    const panels = watchResponseFor(videoId)?.engagementPanels || [];
    const panel = panels.map((item) => item.engagementPanelSectionListRenderer)
      .find((renderer) => renderer?.panelIdentifier === 'engagement-panel-searchable-transcript');
    const endpoint = panel?.content?.continuationItemRenderer?.continuationEndpoint?.getTranscriptEndpoint;
    return endpoint?.params ? { endpoint: 'get_transcript', payload: { params: endpoint.params } } : null;
  }

  function transcriptFromResponse(data) {
    const items = [];
    function visit(node, depth = 0) {
      if (!node || typeof node !== 'object' || depth > 25) return;
      const modern = node.transcriptSegmentViewModel;
      if (modern) {
        items.push({ time: modern.timestamp, text: runsToText(modern) });
        return;
      }
      const legacy = node.transcriptSegmentRenderer;
      if (legacy) {
        const time = runsToText(legacy.startTimeText) || formatDuration(Number(legacy.startMs) / 1000);
        items.push({ time, text: runsToText(legacy.snippet) });
        return;
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    }
    visit(data.content || data.actions || data.onResponseReceivedEndpoints);
    const text = segmentsToTranscript(items);
    return text ? { ok: true, text, segments: items.length } : null;
  }

  // Read the same data YouTube puts in its panel without opening it.
  // The DOM path is a fallback for watch pages using the older transcript UI.
  const transcriptSources = new WeakMap();

  async function fetchTranscript(signal) {
    signal?.throwIfAborted();
    const key = sourceKey();
    const initialPanel = transcriptPanelEl();
    const previous = initialPanel?.getAttribute('visibility');
    const previousSource = initialPanel && transcriptSources.get(initialPanel);
    const staleText = previousSource && previousSource !== key ? initialPanel.textContent : null;
    let concealment;
    let retry;
    try {
      function read() {
        if (sourceKey() !== key) throw new Error('video changed');
        const panel = transcriptPanelEl();
        if (!panel || (staleText !== null && panel === initialPanel && panel.textContent === staleText)) return null;
        const items = readTranscriptSegments(panel);
        const text = segmentsToTranscript(items);
        if (text) transcriptSources.set(panel, key);
        return text ? { ok: true, text, segments: items.length } : null;
      }
      const existing = read();
      if (existing) return existing;
      const cfg = getConfig();
      const request = key.startsWith('video:') && cfg && transcriptRequestFor(key.slice(6));
      if (request) {
        let result;
        let failure;
        try {
          const timeout = AbortSignal.timeout(10000);
          const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
          const data = await youtubePost(cfg, request.endpoint, request.payload, requestSignal);
          result = transcriptFromResponse(data);
        } catch (e) {
          signal?.throwIfAborted();
          failure = String(e.message || e);
        }
        if (sourceKey() !== key) return { ok: false, reason: 'video changed' };
        if (result) return result;
        if (request.endpoint === 'get_panel') return { ok: false, reason: failure || 'YouTube’s transcript request returned no captions' };
      }
      if (previous !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
        const button = await waitFor(findTranscriptButton, 8000, 400, signal);
        if (signal) signal.throwIfAborted();
        if (!button) return { ok: false, reason: 'no transcript available for this video' };
        if (sourceKey() !== key) return { ok: false, reason: 'video changed' };
        concealment = document.createElement('style');
        concealment.textContent = 'ytd-engagement-panel-section-list-renderer[target-id*="transcript"] {' +
          'position:absolute!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important}';
        document.head.appendChild(concealment);
        button.click();
        retry = setTimeout(() => {
          if (signal?.aborted || sourceKey() !== key) return;
          if (transcriptPanelEl()?.getAttribute('visibility') !== 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') {
            button.closest?.('ytd-button-renderer')?.click();
          }
        }, 700);
      }
      return await waitFor(read, 12000, 250, signal) || { ok: false, reason: 'transcript panel produced no segments' };
    } catch (e) {
      if (signal) signal.throwIfAborted();
      return { ok: false, reason: String(e.message || e) };
    } finally {
      clearTimeout(retry);
      if (concealment) {
        const panel = sourceKey() === key ? transcriptPanelEl() : initialPanel;
        const close = panel?.querySelector('#visibility-button button, #close-button button, #visibility-button yt-icon-button')
          || panel?.querySelector('#visibility-button, #close-button');
        if (panel?.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED') close?.click();
        if (panel) {
          const restored = previous || 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN';
          if ('visibility' in panel) panel.visibility = restored;
          panel.setAttribute('visibility', restored);
        }
        concealment.remove();
      }
    }
  }

  let bridgePort = null;

  function send(message) {
    try { bridgePort?.postMessage(message); } catch {}
  }

  function updateProgressUI(force = false) {
    const now = Date.now();
    if (!force && state.running && now - lastProgress < 250) return;
    lastProgress = now;
    send({ event: 'progress', key: collectionSource, progress: { running: state.running, ratio: progressPercent(),
      requests: state.requests, count: state.comments.size, reported: state.reported, status: state.result.status, reason: state.result.reason } });
  }

  async function handle(message) {
    syncCollectionSource();
    if (message.key !== collectionSource || !/^(video|post):/.test(collectionSource)) throw new Error('YouTube source changed.');
    if (message.action === 'stop') return stopCollection();
    if (message.action === 'check-count') return checkReportedCount();
    if (message.action === 'collect') {
      const incremental = message.refresh === true && Array.isArray(message.knownIds) && message.knownIds.length > 0;
      if ((message.fresh === true || incremental) && !activeCollection) {
        Object.assign(state, createCollectionState());
        if (incremental) {
          state.incremental = true;
          state.knownTopIds = new Set(message.knownIds.filter((id) => typeof id === 'string').slice(0, 50000));
          const allIds = Array.isArray(message.knownAllIds) ? message.knownAllIds : message.knownIds;
          state.knownAllIds = new Set(allIds.filter((id) => typeof id === 'string').slice(0, 50000));
          state.knownReplyCounts = new Map();
          if (message.knownReplyCounts && typeof message.knownReplyCounts === 'object') {
            for (const [id, count] of Object.entries(message.knownReplyCounts)) {
              const n = Math.floor(Number(count));
              if (Number.isFinite(n) && n > 0) state.knownReplyCounts.set(id, n);
            }
          }
          const baseline = Math.floor(Number(message.baselineCount));
          state.baselineCount = Number.isFinite(baseline) && baseline > 0 ? baseline : state.knownAllIds.size;
          state.updatedReplyCounts = Object.create(null);
        }
        resetMetadata();
      }
      const result = await run(message.background === true);
      if (message.key !== sourceKey()) throw new Error('YouTube source changed.');
      const hasExport = (state.comments.size > 0 || state.incremental) && result?.status !== 'stopped';
      return { result, incremental: state.incremental, snapshot: hasExport ? exportData() : null };
    }
    if (message.action === 'transcript') {
      transcriptController?.abort();
      const controller = new AbortController();
      transcriptController = controller;
      try { return await fetchTranscript(controller.signal); }
      finally { if (transcriptController === controller) transcriptController = null; }
    }
    throw new Error('Unknown collector action.');
  }

  function onBridgeInit(event) {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'ytct-page-init') return;
    const port = event.ports?.[0];
    if (!(port instanceof MessagePort)) return;
    window.removeEventListener('message', onBridgeInit);
    bridgePort = port;
    bridgePort.onmessage = ({ data: message }) => {
      if (!message || typeof message.id !== 'string') return;
      handle(message).then((value) => send({ id: message.id, key: message.key, value }),
        (error) => send({ id: message.id, key: message.key, error: String(error?.message || error).slice(0, 512) }));
    };
    bridgePort.postMessage({ event: 'ready' });
  }
  window.addEventListener('message', onBridgeInit);
  window.postMessage({ channel: 'ytct-page-ready' }, location.origin);
  for (const event of ['yt-navigate-finish', 'yt-page-data-updated']) document.addEventListener(event, syncCollectionSource);
})();
