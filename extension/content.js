// Isolated-world controls and the fixed collector bridge.
(() => {
  'use strict';
  const { sourceKey, isMediaSource, maxEntryBytes, sanitizeName, stamp } = YTCT;
  const svgNS = 'http://www.w3.org/2000/svg';
  const documentId = crypto.randomUUID();
  const downloaderId = 'ytct-download';
  const openerId = 'ytct-side-panel';
  const toolbarId = 'ytct-toolbar';
  const pending = new Map();
  const panels = new Set();
  const pendingPorts = new Set();
  const bridgeQueue = [];
  let bridgePort = null;
  let source = null;
  let counter = 0;
  let mountTimer;
  let mediaTimer;
  let media = null;

  async function worker(message) {
    const reply = await chrome.runtime.sendMessage(message);
    if (!reply?.ok) throw new Error(reply?.error || 'The extension is unavailable. Reload this tab.');
    return reply.value;
  }

  function onBridgeMessage(port, { data: message }) {
    if (message?.event === 'ready') {
      if (!bridgePort) {
        bridgePort = port;
        for (const other of pendingPorts) {
          if (other !== port) other.close();
        }
        pendingPorts.clear();
        window.removeEventListener('message', onBridgeReady);
        for (const payload of bridgeQueue.splice(0)) {
          if (pending.has(payload.id)) bridgePort.postMessage(payload);
        }
      }
      return;
    }
    if (port !== bridgePort || !source || !message || message.key !== source.key || sourceKey(location.href) !== source.key) return;
    if (message.event === 'progress' && message.progress && typeof message.progress.running === 'boolean') {
      const { running, ratio, count, status, reason } = message.progress;
      source.progress = {
        running, ratio: Number.isFinite(ratio) ? Math.min(100, Math.max(0, ratio)) : 0,
        count: Number.isSafeInteger(count) && count > 0 ? count : 0,
        status: typeof status === 'string' ? status.slice(0, 24) : '',
        reason: typeof reason === 'string' ? reason.slice(0, 512) : '',
      };
      refreshDownloads();
      sendAll(stateForPanel());
      if (source.waitingForTokens && source.autoCollect && !source.stopped && !source.export && !source.job
        && message.progress.count > 0 && document.visibilityState === 'visible') {
        source.waitingForTokens = false;
        source.retried = true;
        collect(source, { background: true }).catch(() => {});
      }
      return;
    }
    const request = pending.get(message.id);
    if (!request || request.key !== message.key) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) {
      request.reject(new Error(typeof message.error === 'string' ? message.error.slice(0, 512) : 'YouTube request failed.'));
    } else request.resolve(message.value);
  }

  function offerBridge() {
    if (bridgePort || pendingPorts.size >= 4) return;
    const channel = new MessageChannel();
    const port = channel.port1;
    pendingPorts.add(port);
    port.onmessage = (event) => onBridgeMessage(port, event);
    window.postMessage({ channel: 'ytct-page-init' }, location.origin, [channel.port2]);
  }

  function onBridgeReady(event) {
    if (bridgePort || event.source !== window || event.origin !== location.origin || event.data?.channel !== 'ytct-page-ready') return;
    offerBridge();
  }
  window.addEventListener('message', onBridgeReady);
  offerBridge();

  function page(action, current, extra) {
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('YouTube did not answer the ' + action + ' request. Reload this tab and try again.'));
      }, action === 'collect' ? 91 * 60000 : 30000);
      pending.set(id, { key: current.key, resolve, reject, timer });
      const payload = { id, key: current.key, action, ...extra };
      if (bridgePort) bridgePort.postMessage(payload);
      else {
        bridgeQueue.push(payload);
        offerBridge();
      }
    });
  }

  function sendAll(message) {
    for (const port of panels) {
      try { port.postMessage(message); } catch {}
    }
  }

  function video() {
    if (!source?.key.startsWith('video:')) return null;
    const watch = document.querySelector('ytd-watch-flexy[video-id]');
    if (watch?.getAttribute('video-id') !== source.key.slice(6)) return null;
    const player = watch.querySelector('#movie_player');
    if (player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting')) return null;
    return player?.querySelector('video.html5-main-video, video') || null;
  }

  function mediaTime() {
    const player = video();
    if (!player) return null;
    return {
      currentTime: player.currentTime,
      duration: Number.isFinite(player.duration) ? player.duration : null,
      playbackRate: Number.isFinite(player.playbackRate) && player.playbackRate > 0 ? player.playbackRate : 1,
      paused: !!player.paused,
    };
  }

  function sendTime(event) {
    sendAll({ event: 'time', key: source?.key, media: mediaTime(), seek: !!event && event.type === 'seeked' });
  }

  function bindVideo() {
    const found = panels.size ? video() : null;
    if (found === media) return;
    for (const event of ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange', 'ratechange', 'play', 'pause']) {
      media?.removeEventListener(event, sendTime);
      found?.addEventListener(event, sendTime);
    }
    media = found;
    if (panels.size) sendTime();
  }

  function seek(seconds) {
    const player = video();
    if (!player || player.readyState === 0 || !Number.isFinite(seconds) || seconds < 0) return false;
    if (Number.isFinite(player.duration)) {
      if (seconds > player.duration) return false;
    } else {
      let inRange = false;
      for (let i = 0; i < player.seekable.length; i++) inRange ||= player.seekable.start(i) <= seconds && seconds <= player.seekable.end(i);
      if (!inRange) return false;
    }
    try { player.currentTime = seconds; } catch { return false; }
    return true;
  }

  function title() {
    return document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
  }

  // ---- theater mode while the side panel is open
  // The comments replace the recommendations visually, without changing YouTube's layout.
  const theater = { owned: false };
  let linkTheater = false;
  let skipEnsureTheaterUntil = 0;
  let theaterTimer = null;
  let alignTimer = null;
  let headerObserver = null;
  window.addEventListener('resize', () => {
    clearTimeout(alignTimer);
    alignTimer = setTimeout(alignToolbar, 120);
  });

  function theaterActive() {
    return !!document.querySelector('ytd-watch-flexy[theater]');
  }

  function theaterButton() {
    const watch = document.querySelector('ytd-watch-flexy');
    const player = watch?.querySelector('#movie_player') || document.querySelector('#movie_player');
    return player?.querySelector('.ytp-size-button') || null;
  }

  function markTheaterOwned(owned) {
    theater.owned = owned;
    try {
      if (owned) sessionStorage.setItem('ytct-theater-owned', '1');
      else sessionStorage.removeItem('ytct-theater-owned');
    } catch {}
  }

  function isEditableTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!node || node.nodeType !== 1) continue;
      const tag = node.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable) return true;
      const editable = node.getAttribute?.('contenteditable');
      if (editable === '' || editable === 'true' || editable === 'plaintext-only') return true;
    }
    return false;
  }

  function armTheaterOpen(current) {
    if (!linkTheater || !current?.mounted || !current.key.startsWith('video:')
      || panels.size || current.theaterOpened || current.pendingTheaterOpen) return;
    if (theaterActive()) current.pendingTheaterOpen = true;
  }

  function openPanelFromTheaterGesture(enteringViaControl) {
    if (!source || panels.size) return;
    source.pendingTheaterOpen = false;
    source.theaterOpened = true;
    markTheaterOwned(false);
    if (enteringViaControl) skipEnsureTheaterUntil = Date.now() + 900;
    chrome.runtime.sendMessage({ type: 'open-panel' }).catch(() => {});
  }

  function ensureTheater(attempt = 0) {
    clearTimeout(theaterTimer);
    if (!panels.size || !source?.mounted || !source.key.startsWith('video:')) return;
    if (Date.now() < skipEnsureTheaterUntil) return;
    if (theaterActive()) {
      // A previous document may have turned theater on for this panel.
      try { if (sessionStorage.getItem('ytct-theater-owned') === '1') theater.owned = true; } catch {}
      return;
    }
    const button = theaterButton();
    if (!button) {
      if (attempt < 12) theaterTimer = setTimeout(() => ensureTheater(attempt + 1), 500);
      return;
    }
    button.click();
    markTheaterOwned(true);
    setTimeout(alignToolbar, 350);
  }

  function restoreTheater() {
    clearTimeout(theaterTimer);
    if (!theater.owned) return;
    markTheaterOwned(false);
    if (!source?.key.startsWith('video:') || !theaterActive()) return;
    theaterButton()?.click();
    setTimeout(alignToolbar, 350);
  }

  function refreshOpener() {
    const button = document.getElementById(openerId);
    if (!button) return;
    const label = panels.size ? 'Close comments side panel' : 'Open comments side panel';
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function stateForPanel() {
    return { event: 'page', key: source?.mounted ? source.key : '', pageId: source?.pageId, title: title(),
      progress: source?.progress, media: mediaTime(), dark: document.documentElement?.hasAttribute('dark') };
  }

  function scanSource() {
    const key = sourceKey(location.href);
    if (source?.key === key) return source;
    clearTimeout(mountTimer);
    mountTimer = null;
    clearTimeout(source?.scheduleTimer);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('YouTube source changed.'));
    }
    pending.clear();
    const current = source = { key, pageId: documentId + ':' + ++counter, progress: {}, mounted: false, autoCollect: false };
    async function bindVisit() {
      for (let attempt = 0; source === current; attempt++) {
        try { return await worker({ type: 'visit', key, pageId: current.pageId }); }
        catch (error) {
          if (attempt === 3 || error.message !== 'The page changed.') throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
    current.bound = bindVisit().then((binding) => {
      if (source === current) {
        current.mounted = true;
        current.autoCollect = binding?.autoCollect === true;
        linkTheater = binding?.linkTheater === true;
        armTheaterOpen(current);
        refresh();
        sendAll(stateForPanel());
        scheduleCollection(current);
        if (panels.size) ensureTheater();
      }
    });
    current.bound.catch((error) => {
      if (source === current) {
        current.progress = { status: 'error', reason: error.message };
        sendAll(stateForPanel());
      }
    });
    sendAll(stateForPanel());
    bindVideo();
    return current;
  }

  function scheduleCollection(current) {
    if (!current?.mounted || !current.autoCollect || current.scheduled || current.export || current.job || current.stopped
      || !isMediaSource(current.key) || document.readyState !== 'complete' || document.visibilityState !== 'visible') return;
    current.scheduled = true;
    const measure = () => {
      const element = document.querySelector(current.key.startsWith('video:') ? '#movie_player' : 'ytd-post-renderer');
      return element ? element.offsetWidth + 'x' + element.offsetHeight : '';
    };
    const size = measure();
    current.scheduleTimer = setTimeout(() => {
      current.scheduleTimer = null;
      if (source !== current || current.stopped || current.export || current.job) return;
      if (document.visibilityState !== 'visible') {
        current.scheduled = false;
        return;
      }
      if (measure() !== size && (current.measureChecks || 0) < 8) {
        current.measureChecks = (current.measureChecks || 0) + 1;
        current.scheduled = false;
        scheduleCollection(current);
      } else collect(current, { background: true }).catch(() => {});
    }, 3200);
  }

  function mergeIncrementalSnapshot(baseSnapshot, deltaSnapshot) {
    const updatedCounts = deltaSnapshot.updatedReplyCounts || {};
    const byId = new Map();
    for (const comment of deltaSnapshot.comments || []) byId.set(comment.id, comment);
    for (const comment of baseSnapshot.comments || []) {
      if (!byId.has(comment.id)) {
        const nextReplyCount = updatedCounts[comment.id];
        byId.set(comment.id, nextReplyCount ? { ...comment, replyCount: nextReplyCount } : comment);
      }
    }
    const comments = [...byId.values()].slice(0, 50000);
    return {
      ...baseSnapshot,
      metadata: deltaSnapshot.metadata?.title ? { ...baseSnapshot.metadata, ...deltaSnapshot.metadata } : baseSnapshot.metadata,
      exportedAt: deltaSnapshot.exportedAt || new Date().toISOString(),
      reportedCount: Math.max(deltaSnapshot.reportedCount || 0, baseSnapshot.reportedCount || 0, comments.length),
      collection: {
        ...baseSnapshot.collection,
        status: deltaSnapshot.collection?.status === 'complete' && baseSnapshot.collection?.status === 'complete' ? 'complete' : 'partial',
        limitReached: !!baseSnapshot.collection?.limitReached || !!deltaSnapshot.collection?.limitReached || comments.length >= 50000,
      },
      comments,
    };
  }

  function collect(current, { background = false, fresh = false, refresh = false, knownIds = null, knownAllIds = null, knownReplyCounts = null, baselineCount = 0 } = {}) {
    if (current.job) return current.job;
    if (!background) {
      current.stopped = false;
      clearTimeout(current.scheduleTimer);
      current.scheduleTimer = null;
    }
    const action = async () => {
      if (source !== current) return null;
      await current.bound;
      if (source !== current) return null;
      current.progress = { running: true, ratio: 0 };
      refreshDownloads();
      sendAll(stateForPanel());
      const { snapshot, result, incremental } = await page('collect', current, {
        background, fresh, refresh, knownIds, knownAllIds, knownReplyCounts, baselineCount,
      });
      if (source !== current) return null;
      if (!snapshot) {
        if (result?.status === 'stopped') return null;
        if (background && !current.retried) {
          // Some videos only expose the first continuation after their comment section initializes.
          current.waitingForTokens = true;
          current.progress = {};
          return null;
        }
        throw new Error(result?.reason || 'YouTube returned no comments.');
      }
      if (!snapshot.metadata || !Array.isArray(snapshot.comments)
        || new Blob([JSON.stringify(snapshot)]).size > maxEntryBytes - 1024) {
        throw new Error('YouTube returned an invalid or oversized comment export.');
      }
      if (incremental) {
        if (current.export?.snapshot) {
          const merged = mergeIncrementalSnapshot(current.export.snapshot, snapshot);
          if (new Blob([JSON.stringify(merged)]).size <= maxEntryBytes - 1024) {
            current.export = { ...current.export, snapshot: merged };
          }
        }
        sendAll({ event: 'export-delta', key: current.key, pageId: current.pageId, delta: snapshot });
        return { incremental: true, delta: snapshot };
      }
      const meta = snapshot.metadata;
      const stem = sanitizeName([meta.channel, meta.title, stamp(new Date(snapshot.startedAt || Date.now()))].filter(Boolean).join(' '), 180).replace(/\s+/g, '_');
      const entry = current.export = { snapshot, stem };
      sendAll({ event: 'export', key: current.key, pageId: current.pageId, entry, notice: current.notice });
      return entry;
    };
    const locks = window.navigator?.locks;
    current.job = (locks ? locks.request('ytct-extension:' + current.key, action) : action()).catch((error) => {
      if (source === current) {
        if (background && !current.retried && /no comment tokens found/i.test(error.message)) {
          current.waitingForTokens = true;
          current.progress = {};
        } else {
          current.progress = { ...current.progress, running: false, status: 'error', reason: error.message };
        }
      }
      throw error;
    }).finally(() => {
      current.job = null;
      current.progress.running = false;
      if (source === current) {
        refreshDownloads();
        sendAll(stateForPanel());
      }
    });
    return current.job;
  }

  async function download() {
    const current = source;
    if (!current?.mounted || current.download) return;
    current.download = true;
    refreshDownloads();
    try {
      const identity = { key: current.key, pageId: current.pageId };
      if (current.job) await current.job;
      if (!current.export && await worker({ type: 'download-cache', ...identity })) return;
      const entry = current.export || await collect(current);
      if (entry && !entry.incremental && current === source) await worker({ type: 'download-export', ...identity, entry });
    } finally {
      current.download = false;
      if (current === source) refreshDownloads();
    }
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function anchor() {
    const header = [...document.querySelectorAll('ytd-comments-header-renderer')].find(visible);
    return header?.querySelector('#sort-menu, yt-sort-filter-sub-menu-renderer') || header?.querySelector('#count')?.parentElement
      || [...document.querySelectorAll('yt-sort-filter-sub-menu-renderer, #sort-menu')].find(visible);
  }

  function svg(name, attributes = {}) {
    const element = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  }

  const darkTheme = () => document.documentElement.hasAttribute('dark');

  function parseColor(value) {
    const match = /rgba?\(([^)]+)\)/.exec(String(value || ''));
    if (!match) return null;
    const parts = match[1].split(',').map(Number);
    return parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite) ? parts : null;
  }

  function luminance(parts) {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(parts[0]) + 0.7152 * channel(parts[1]) + 0.0722 * channel(parts[2]);
  }

  // Page text tokens can resolve to the hidden comment header's colour, so sample what is
  // actually painted behind the controls and fall back to the theme attribute.
  function backdropIsDark(element) {
    for (let node = element; node; node = node.parentElement) {
      const color = parseColor(getComputedStyle(node).backgroundColor);
      if (color && (color[3] ?? 1) > 0.5) return luminance(color) < 0.5;
    }
    return darkTheme();
  }

  function applyToolbarColors() {
    const downloadButton = document.getElementById(downloaderId);
    if (!downloadButton) return;
    const dark = backdropIsDark(downloadButton);
    for (const button of [downloadButton, document.getElementById(openerId)]) {
      if (!button) continue;
      button.style.color = dark ? '#f1f1f1' : '#0f0f0f';
      const circle = button.querySelector('.ytct-progress');
      if (circle) circle.style.stroke = dark ? '#3ea6ff' : '#065fd4';
    }
  }

  // #sort-menu is a block whose inline children baseline-align, and YouTube lifts its sort trigger
  // with a negative margin. Line our buttons and the Sort by control up with the count heading.
  function alignToolbar() {
    const slot = document.getElementById(toolbarId);
    const place = slot?.parentElement;
    if (!slot || !place) return;
    const header = place.closest('ytd-comments-header-renderer') || place;
    const count = header.querySelector('#count');
    const sort = place.querySelector('yt-sort-filter-sub-menu-renderer')
      || place.closest('yt-sort-filter-sub-menu-renderer');
    const label = sort?.querySelector('#label') || sort;
    slot.style.top = '0px';
    if (sort) {
      sort.style.position = 'relative';
      sort.style.top = '0px';
    }
    const slotBox = slot.getBoundingClientRect();
    if (!slotBox.height) return;
    const countBox = count?.getBoundingClientRect();
    const labelBox = label?.getBoundingClientRect();
    const target = countBox?.height
      ? countBox.top + countBox.height / 2
      : labelBox?.height ? labelBox.top + labelBox.height / 2 : null;
    if (target === null) return;
    if (sort && labelBox?.height) {
      const sortOffset = target - (labelBox.top + labelBox.height / 2);
      sort.style.top = sortOffset.toFixed(2) + 'px';
    }
    const slotOffset = target - (slotBox.top + slotBox.height / 2);
    slot.style.top = slotOffset.toFixed(2) + 'px';
  }

  function toolbarButton(id, label, callback) {
    const button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.style.cssText = 'width:36px;height:36px;position:relative;display:inline-flex;align-items:center;justify-content:center;' +
      'padding:0;border:0;border-radius:50%;background:transparent;cursor:pointer;flex:0 0 auto;line-height:0;vertical-align:middle';
    button.addEventListener('mouseenter', () => { button.style.backgroundColor = darkTheme() ? '#ffffff1f' : '#0000000f'; });
    button.addEventListener('mouseleave', () => { button.style.backgroundColor = 'transparent'; });
    button.addEventListener('click', (event) => { if (event.isTrusted) callback(); });
    return button;
  }

  function refreshDownloads() {
    const button = document.getElementById(downloaderId);
    if (!button) return;
    const current = source;
    const ratio = current?.progress?.ratio || 0;
    const running = current?.progress?.running;
    const label = running ? (current.download ? 'Download queued' : 'Download comments when ready') + ' (' + ratio + '%)'
      : current?.notice || 'Download comments';
    button.title = label;
    button.setAttribute('aria-label', label);
    const ring = button.querySelector('.ytct-progress');
    if (!ring) return;
    ring.setAttribute('stroke-dasharray', ratio + ' 100');
    // A round cap renders a dot for a zero-length dash, so wait for real progress.
    ring.style.opacity = running && ratio > 0 ? '1' : '0';
  }

  function refresh() {
    if (!source?.mounted || !document.body) return;
    bindVideo();
    const currentTitle = title();
    if (source.title !== currentTitle) {
      source.title = currentTitle;
      sendAll(stateForPanel());
    }
    const place = isMediaSource(source.key) ? anchor() : null;
    const slot = document.getElementById(toolbarId);
    const dl = document.getElementById(downloaderId);
    const open = document.getElementById(openerId);
    if (!place) {
      slot?.remove();
      dl?.remove();
      open?.remove();
      return;
    }
    if (slot?.parentElement !== place) {
      slot?.remove();
      dl?.remove();
      open?.remove();
      const bar = document.createElement('span');
      bar.id = toolbarId;
      bar.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;gap:2px;flex:0 0 auto;' +
        'margin-inline-end:4px;line-height:0;vertical-align:middle;position:relative';
      const downloadButton = toolbarButton(downloaderId, 'Download comments', () => download().catch((error) => {
        source.notice = error.message;
        refreshDownloads();
        sendAll({ event: 'notice', key: source.key, text: error.message });
      }));
      const downloadIcon = svg('svg', { viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': true });
      downloadIcon.append(svg('path', { fill: 'currentColor', d: 'M12 2a1 1 0 00-1 1v11.586l-4.293-4.293a1 1 0 10-1.414 1.414L12 18.414l6.707-6.707a1 1 0 00-1.414-1.414L13 14.586V3a1 1 0 00-1-1Zm7 18H5a1 1 0 000 2h14a1 1 0 000-2Z' }));
      const ring = svg('svg', { viewBox: '0 0 36 36', width: 36, height: 36, 'aria-hidden': true });
      ring.setAttribute('class', 'ytct-ring');
      ring.style.cssText = 'position:absolute;inset:0;transform:rotate(-90deg);pointer-events:none;overflow:visible';
      const progress = svg('circle', { class: 'ytct-progress', cx: 18, cy: 18, r: 16, pathLength: 100, fill: 'none', 'stroke-width': 2.5, 'stroke-linecap': 'round' });
      progress.setAttribute('stroke-dasharray', '0 100');
      progress.style.cssText = 'opacity:0;transition:opacity .2s';
      ring.append(progress);
      downloadButton.append(downloadIcon, ring);
      const opener = toolbarButton(openerId, 'Open comments side panel', () => {
        if (panels.size) sendAll({ event: 'panel-close' });
        else worker({ type: 'open-panel' }).catch((error) => { opener.title = error.message; });
      });
      const icon = document.createElement('span');
      icon.setAttribute('aria-hidden', 'true');
      icon.style.cssText = 'display:block;width:24px;height:24px;background:currentColor;mask:url(' +
        chrome.runtime.getURL('icons/comments.svg') + ') center / contain no-repeat';
      opener.append(icon);
      bar.append(downloadButton, opener);
      place.insertBefore(bar, place.firstChild);
    }
    refreshDownloads();
    applyToolbarColors();
    alignToolbar();
    const header = place.closest('ytd-comments-header-renderer');
    if (header && typeof ResizeObserver === 'function') {
      headerObserver?.disconnect();
      headerObserver = new ResizeObserver(() => alignToolbar());
      headerObserver.observe(header);
    }
    refreshOpener();
  }

  // ------------------------------------------------------------------ image viewer
  // Community post images have no close-up view on YouTube. A full-screen button opens a
  // borderless overlay: scroll wheel or click to zoom, drag to pan, Esc to close.
  const decoratedImages = new WeakSet();
  let imageViewer = null;

  function isGoogleImageHost(hostname) {
    return /^yt\d+\.ggpht\.com$/.test(hostname)
      || /^lh\d+\.googleusercontent\.com$/.test(hostname)
      || hostname === 'yt3.googleusercontent.com'
      || hostname === 'i.ytimg.com';
  }

  function safeImageUrl(raw) {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      return url.href;
    } catch {
      return '';
    }
  }

  function originalImageUrl(raw) {
    const safe = safeImageUrl(raw);
    if (!safe) return '';
    try {
      const url = new URL(safe);
      if (!isGoogleImageHost(url.hostname)) return safe;
      // Google's image CDN keeps its resize/crop directive at the end of the path.
      const match = /=(?:w\d+-h\d+|s\d+)[^/]*$/.exec(url.pathname);
      if (match) url.pathname = url.pathname.slice(0, match.index) + '=s0';
      return url.href;
    } catch {
      return safe;
    }
  }

  function createImageViewer() {
    const root = document.createElement('div');
    root.id = 'ytct-image-viewer';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Image viewer');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:none;overflow:hidden;' +
      'background:rgba(11,11,11,0.82);backdrop-filter:blur(2px);touch-action:none;user-select:none;-webkit-user-select:none;cursor:default';
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.draggable = false;
    image.hidden = true;
    image.style.cssText = 'position:absolute;left:0;top:0;display:block;max-width:none;max-height:none;' +
      'transform-origin:0 0;pointer-events:none;user-select:none;-webkit-user-drag:none;will-change:transform';
    const close = document.createElement('button');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', 'Close image');
    close.style.cssText = 'position:absolute;right:14px;top:14px;z-index:1;width:38px;height:38px;display:grid;' +
      'place-items:center;padding:0;border:0;border-radius:50%;background:#ffffff24;color:#fff;cursor:pointer;' +
      'opacity:.8;transition:background .15s,opacity .15s';
    const closeIcon = svg('svg', { viewBox: '0 0 24 24', width: 22, height: 22, 'aria-hidden': true });
    closeIcon.append(svg('path', { d: 'm6 6 12 12M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' }));
    close.append(closeIcon);
    close.addEventListener('mouseenter', () => { close.style.background = '#ffffff3d'; close.style.opacity = '1'; });
    close.addEventListener('mouseleave', () => { close.style.background = '#ffffff24'; close.style.opacity = '.8'; });
    close.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      closeViewer();
    });
    root.append(image, close);
    document.documentElement.append(root);

    const state = {
      open: false, width: 0, height: 0, fit: 1, scale: 1, x: 0, y: 0,
      drag: null, backdropClick: null, lastPointer: null, previousOverflow: '',
    };
    const zoomed = () => state.scale > state.fit + 0.001;

    function stage() {
      return { width: root.clientWidth, height: root.clientHeight };
    }

    function pointOnImage(clientX, clientY) {
      if (image.hidden || !state.width || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
      const rect = image.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    function fitScale(box = stage()) {
      if (!state.width || !state.height || !box.width || !box.height) return 1;
      return Math.min(box.width / state.width, box.height / state.height) || 1;
    }

    function canPan(box = stage()) {
      return state.width * state.scale > box.width + 0.5 || state.height * state.scale > box.height + 0.5;
    }

    function updateCursor(clientX = state.lastPointer?.x, clientY = state.lastPointer?.y) {
      if (state.drag && canPan()) {
        root.style.cursor = 'grabbing';
        return;
      }
      if (!pointOnImage(clientX, clientY)) {
        root.style.cursor = 'default';
        return;
      }
      root.style.cursor = canPan() ? 'grab' : 'zoom-in';
    }

    function applyTransform() {
      image.style.transform = 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')';
    }

    function clampPan() {
      const box = stage();
      const width = state.width * state.scale;
      const height = state.height * state.scale;
      state.x = width <= box.width ? (box.width - width) / 2 : Math.min(0, Math.max(box.width - width, state.x));
      state.y = height <= box.height ? (box.height - height) / 2 : Math.min(0, Math.max(box.height - height, state.y));
    }

    function fitView() {
      const box = stage();
      state.fit = fitScale(box);
      state.scale = state.fit;
      state.x = (box.width - state.width * state.fit) / 2;
      state.y = (box.height - state.height * state.fit) / 2;
      updateCursor();
      applyTransform();
    }

    function zoomAt(nextScale, clientX, clientY) {
      if (!state.width) return;
      const box = stage();
      const cx = clientX ?? box.width / 2;
      const cy = clientY ?? box.height / 2;
      const min = state.fit;
      const max = Math.max(state.fit * 8, 8);
      const clamped = Math.min(max, Math.max(min, nextScale));
      if (Math.abs(clamped - state.scale) < 0.0001) return;
      const ratio = clamped / state.scale;
      state.x = cx - (cx - state.x) * ratio;
      state.y = cy - (cy - state.y) * ratio;
      state.scale = clamped;
      clampPan();
      updateCursor();
      applyTransform();
    }

    function toggleZoom(clientX, clientY) {
      if (!state.width) return;
      if (zoomed()) {
        fitView();
        return;
      }
      zoomAt(Math.max(1, state.fit * 2), clientX, clientY);
    }

    function closeViewer() {
      state.open = false;
      state.drag = null;
      state.backdropClick = null;
      state.lastPointer = null;
      image.hidden = true;
      image.removeAttribute('src');
      root.style.display = 'none';
      document.documentElement.style.overflow = state.previousOverflow || '';
      document.removeEventListener('keydown', onKey, true);
    }

    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeViewer();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        event.stopPropagation();
        zoomAt(state.scale * 1.25);
      } else if (event.key === '-') {
        event.preventDefault();
        event.stopPropagation();
        zoomAt(state.scale / 1.25);
      } else if (event.key === '0') {
        event.preventDefault();
        event.stopPropagation();
        fitView();
      }
    }

    function open(url, fallback) {
      const safeUrl = safeImageUrl(url);
      const safeFallback = safeImageUrl(fallback);
      if (!safeUrl) return;
      if (!state.open) state.previousOverflow = document.documentElement.style.overflow;
      state.open = true;
      state.width = 0;
      state.height = 0;
      state.fit = 1;
      state.scale = 1;
      state.x = 0;
      state.y = 0;
      image.hidden = true;
      image.style.width = '0px';
      image.style.height = '0px';
      image.dataset.fallback = safeFallback && safeFallback !== safeUrl ? safeFallback : '';
      root.style.display = 'block';
      root.style.cursor = 'zoom-in';
      document.documentElement.style.overflow = 'hidden';
      image.src = safeUrl;
      document.addEventListener('keydown', onKey, true);
    }

    image.addEventListener('load', () => {
      if (!state.open || !image.naturalWidth) return;
      state.width = image.naturalWidth;
      state.height = image.naturalHeight;
      image.style.width = state.width + 'px';
      image.style.height = state.height + 'px';
      image.hidden = false;
      fitView();
    });
    image.addEventListener('error', () => {
      if (!state.open) return;
      const fallback = image.dataset.fallback;
      if (fallback) {
        image.dataset.fallback = '';
        image.src = fallback;
        return;
      }
      closeViewer();
    });

    root.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target === close || close.contains(event.target)) return;
      state.lastPointer = { x: event.clientX, y: event.clientY };
      if (!pointOnImage(event.clientX, event.clientY)) {
        state.backdropClick = { id: event.pointerId, x: event.clientX, y: event.clientY };
        return;
      }
      state.backdropClick = null;
      state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: state.x, top: state.y, moved: false };
      try { root.setPointerCapture(event.pointerId); } catch {}
      updateCursor(event.clientX, event.clientY);
    });
    root.addEventListener('pointermove', (event) => {
      state.lastPointer = { x: event.clientX, y: event.clientY };
      const drag = state.drag;
      if (!drag || drag.id !== event.pointerId) {
        updateCursor(event.clientX, event.clientY);
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (!drag.moved || !canPan()) return;
      state.x = drag.left + dx;
      state.y = drag.top + dy;
      clampPan();
      applyTransform();
    });
    function endDrag(event) {
      if (state.backdropClick && (!event || event.pointerId === state.backdropClick.id)) {
        const click = state.backdropClick;
        state.backdropClick = null;
        if (event?.type === 'pointerup'
          && Math.abs(event.clientX - click.x) + Math.abs(event.clientY - click.y) <= 6
          && !pointOnImage(event.clientX, event.clientY)) {
          closeViewer();
        }
        return;
      }
      const drag = state.drag;
      if (!drag || (event && event.pointerId !== drag.id)) return;
      state.drag = null;
      try { root.releasePointerCapture(drag.id); } catch {}
      if (event && event.type === 'pointerup' && !drag.moved && pointOnImage(event.clientX, event.clientY)) {
        toggleZoom(event.clientX, event.clientY);
      } else {
        updateCursor(event?.clientX, event?.clientY);
      }
    }
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);
    root.addEventListener('wheel', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!state.open || !state.width || !pointOnImage(event.clientX, event.clientY)) return;
      state.lastPointer = { x: event.clientX, y: event.clientY };
      const scale = event.deltaMode === 1 ? 32 : event.deltaMode === 2 ? 240 : 1;
      const dy = Math.max(-240, Math.min(240, event.deltaY * scale));
      if (!dy) return;
      zoomAt(state.scale * Math.exp(-dy * 0.0022), event.clientX, event.clientY);
    }, { passive: false });
    window.addEventListener('resize', () => {
      if (!state.open || !state.width) return;
      const wasZoomed = zoomed();
      const box = stage();
      state.fit = fitScale(box);
      if (wasZoomed) {
        state.scale = Math.max(state.fit, state.scale);
        clampPan();
        updateCursor();
        applyTransform();
      } else {
        fitView();
      }
    });

    return { open, close: closeViewer };
  }

  function openImageViewer(url, fallback) {
    imageViewer ||= createImageViewer();
    imageViewer.open(url, fallback);
  }

  function decoratePostImages() {
    for (const image of document.querySelectorAll('ytd-backstage-image-renderer img:not([data-ytct-image])')) {
      if (decoratedImages.has(image)) continue;
      const host = image.closest('ytd-backstage-image-renderer') || image.parentElement;
      if (!host || host.querySelector(':scope > .ytct-image-button')) continue;
      decoratedImages.add(image);
      image.dataset.ytctImage = '1';
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'ytct-image-button';
      trigger.title = 'View image full screen';
      trigger.setAttribute('aria-label', 'View image full screen');
      trigger.style.cssText = 'position:absolute;right:8px;bottom:8px;z-index:2;width:34px;height:34px;display:grid;' +
        'place-items:center;padding:0;border:0;border-radius:8px;background:#0000009e;color:#fff;cursor:zoom-in;' +
        'opacity:.9;transition:background .15s,opacity .15s;box-shadow:0 1px 4px #00000059';
      const icon = svg('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true });
      icon.append(svg('path', { d: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      trigger.append(icon);
      trigger.addEventListener('mouseenter', () => { trigger.style.background = '#000000c9'; trigger.style.opacity = '1'; });
      trigger.addEventListener('mouseleave', () => { trigger.style.background = '#0000009e'; trigger.style.opacity = '.9'; });
      trigger.addEventListener('pointerdown', (event) => event.stopPropagation());
      trigger.addEventListener('click', (event) => {
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        const current = host.querySelector('img') || image;
        const src = safeImageUrl(current.currentSrc || current.src);
        if (src) openImageViewer(originalImageUrl(src), src);
      });
      host.append(trigger);
    }
  }

  function scheduleMount() {
    if (mountTimer) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      const current = scanSource();
      armTheaterOpen(current);
      refresh();
      decoratePostImages();
    }, 250);
  }

  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'ytct-settings') return;
    if (typeof message.linkTheater === 'boolean') {
      linkTheater = message.linkTheater;
      if (linkTheater) armTheaterOpen(source);
      else if (source) source.pendingTheaterOpen = false;
    }
  });

  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.repeat || !linkTheater || !source?.mounted || !source.key.startsWith('video:')) return;
    if (isEditableTarget(event)) return;
    const isTheaterKey = (event.key === 't' || event.key === 'T') && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
    if (isTheaterKey) {
      if (theaterActive()) {
        source.pendingTheaterOpen = false;
        source.theaterOpened = true;
        return;
      }
      if (!panels.size) openPanelFromTheaterGesture(true);
      return;
    }
    if (source.pendingTheaterOpen && !panels.size && theaterActive()
      && !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape'].includes(event.key)) {
      openPanelFromTheaterGesture(false);
    }
  }, true);

  document.addEventListener('click', (event) => {
    if (!event.isTrusted || !linkTheater || !source?.mounted || !source.key.startsWith('video:')) return;
    const target = event.target;
    if (target?.closest?.('#' + toolbarId)) return;
    if (target?.closest?.('.ytp-size-button')) {
      if (theaterActive()) {
        source.pendingTheaterOpen = false;
        source.theaterOpened = true;
        return;
      }
      if (!panels.size) openPanelFromTheaterGesture(true);
      return;
    }
    if (source.pendingTheaterOpen && !panels.size && theaterActive() && !target?.closest?.('a[href]')) {
      openPanelFromTheaterGesture(false);
    }
  }, true);

  chrome.runtime.onConnect.addListener((port) => {
    const extensionOrigin = chrome.runtime.getURL('').slice(0, -1);
    let fromPanel = false;
    try {
      const url = new URL(port.sender?.url || '');
      fromPanel = url.origin === extensionOrigin && url.pathname === '/sidepanel.html';
    } catch {}
    if (port.name !== 'ytct-tab' || port.sender?.id !== chrome.runtime.id || !fromPanel) {
      try { port.disconnect(); } catch {}
      return;
    }
    panels.add(port);
    if (source) {
      source.pendingTheaterOpen = false;
      source.theaterOpened = true;
    }
    port.postMessage(stateForPanel());
    bindVideo();
    refreshOpener();
    ensureTheater();
    if (!mediaTimer) mediaTimer = setInterval(bindVideo, 1300);
    port.onDisconnect.addListener(() => {
      panels.delete(port);
      bindVideo();
      refreshOpener();
      if (!panels.size) {
        restoreTheater();
        clearInterval(mediaTimer);
        mediaTimer = null;
      }
    });
    port.onMessage.addListener((message) => {
      const current = source;
      if (!current || message.key !== current.key || typeof message.id !== 'string') return;
      async function handle() {
        if (message.action === 'seek') return seek(message.seconds);
        if (message.action === 'load-collected') return current.export || null;
        if (message.action === 'check-count') return page('check-count', current);
        if (message.action === 'collect') {
          return collect(current, {
            fresh: !!message.fresh,
            refresh: !!message.refresh,
            knownIds: Array.isArray(message.knownIds) ? message.knownIds : null,
            knownAllIds: Array.isArray(message.knownAllIds) ? message.knownAllIds : null,
            knownReplyCounts: message.knownReplyCounts && typeof message.knownReplyCounts === 'object' ? message.knownReplyCounts : null,
            baselineCount: Number(message.baselineCount) || 0,
          });
        }
        if (message.action === 'stop') {
          current.stopped = true;
          clearTimeout(current.scheduleTimer);
          current.scheduleTimer = null;
          return page('stop', current);
        }
        if (message.action === 'transcript') {
          const value = await page('transcript', current);
          if (value?.ok === true && typeof value.text === 'string' && value.text.length <= 512 * 1024) {
            return { ok: true, text: value.text, segments: Number.isSafeInteger(value.segments) ? value.segments : 0 };
          }
          return { ok: false, reason: typeof value?.reason === 'string' ? value.reason.slice(0, 512) : '' };
        }
        throw new Error('Unsupported panel action.');
      }
      const respond = (reply) => {
        try { port.postMessage({ id: message.id, key: current.key, pageId: current.pageId, ...reply }); } catch {}
      };
      handle().then((value) => respond({ value }), (error) => respond({ error: error.message }));
    });
  });

  function start() {
    scanSource();
    refresh();
    decoratePostImages();
    new MutationObserver(scheduleMount).observe(document.documentElement, { subtree: true, childList: true });
    new MutationObserver(() => { applyToolbarColors(); sendAll(stateForPanel()); }).observe(document.documentElement, { attributes: true, attributeFilter: ['dark'] });
  }
  for (const event of ['yt-navigate-finish', 'yt-page-data-updated']) document.addEventListener(event, () => {
    const current = scanSource();
    scheduleMount();
    scheduleCollection(current);
    sendAll(stateForPanel());
  });
  window.addEventListener('load', () => scheduleCollection(scanSource()), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleCollection(source);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
