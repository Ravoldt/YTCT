import {
  computeDatasetStats, countActiveFilters, defaultFilters, diagnoseFilters, fuseSearchResults,
  fuzzyMatchScore, isCreatorRecord, recordPassesFilters, semanticModelSpec, threadPassesThreadFilters,
  validateRegex,
} from './search-engine.mjs';

const { commentTimestamps, parseLikes, timelineFor, activeTimestamps, sidebarPreview, sourceLink, formatDuration } = YTCT;
const PAGE_SIZE = 45;

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHighlightRegex(query, isRegex) {
  const q = String(query || '').trim();
  if (!q) return null;
  if (isRegex) {
    const check = validateRegex(q);
    if (!check.ok || !check.regex) return null;
    try { return new RegExp(check.regex.source, 'gi'); } catch { return null; }
  }
  const words = q.match(/[\p{L}\p{N}_@]+/gu) || q.split(/\s+/).filter(Boolean);
  const terms = [...new Set(words.filter((w) => w.length >= 2))].slice(0, 12);
  if (!terms.length) return null;
  try { return new RegExp('(' + terms.map(escapeRegExp).join('|') + ')', 'gi'); } catch { return null; }
}

function appendHighlightedChunk(node, chunk, highlightRegex) {
  if (!chunk) return;
  if (!highlightRegex) {
    node.append(chunk);
    return;
  }
  highlightRegex.lastIndex = 0;
  let last = 0;
  let marks = 0;
  let match;
  while ((match = highlightRegex.exec(chunk)) !== null && marks < 40) {
    if (match[0].length === 0) {
      highlightRegex.lastIndex++;
      continue;
    }
    if (match.index > last) node.append(chunk.slice(last, match.index));
    const mark = document.createElement('mark');
    mark.textContent = match[0];
    node.append(mark);
    last = match.index + match[0].length;
    marks++;
  }
  if (last < chunk.length) node.append(chunk.slice(last));
}

export function commentThreads(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  const owners = new Map();
  const threads = new Map();
  for (const record of records) {
    let current = record;
    const visited = new Set();
    while (byId.has(current.parent) && !visited.has(current.parent)) {
      visited.add(current.id);
      if (owners.has(current.parent)) {
        current = byId.get(owners.get(current.parent));
        break;
      }
      current = byId.get(current.parent);
    }
    owners.set(record.id, current.id);
    if (!threads.has(current.id)) threads.set(current.id, { root: current, replies: [] });
    if (record.id !== current.id) threads.get(current.id).replies.push(record);
  }
  return { owners, threads: [...threads.values()].sort((a, b) => parseLikes(b.root.likes) - parseLikes(a.root.likes)) };
}

export function timestampAnchor(key, seconds, seek, label) {
  const location = sourceLink(key);
  location.searchParams.set('t', seconds + 's');
  const link = document.createElement('a');
  link.href = location.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  if (label) link.textContent = label;
  link.addEventListener('click', async (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    try { if (await seek(seconds)) return; } catch {}
    await chrome.tabs.create({ url: location.href }).catch(() => {});
  });
  return link;
}

function appendCommentText(node, text, key, duration, seek, highlightRegex = null) {
  if (!key.startsWith('video:')) {
    appendHighlightedChunk(node, text, highlightRegex);
    return;
  }
  const hits = commentTimestamps(text, duration).sort((a, b) => a.index - b.index);
  let start = 0;
  for (const hit of hits) {
    appendHighlightedChunk(node, text.slice(start, hit.index), highlightRegex);
    node.append(timestampAnchor(key, hit.seconds, seek, hit.label));
    start = hit.index + hit.label.length;
  }
  appendHighlightedChunk(node, text.slice(start), highlightRegex);
}

function svg(path) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  node.setAttribute('viewBox', '0 0 24 24');
  node.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(node.namespaceURI, 'path');
  line.setAttribute('d', path);
  node.append(line);
  return node;
}

function button(label, style, action) {
  const node = document.createElement('button');
  node.className = style;
  node.type = 'button';
  node.textContent = label;
  node.addEventListener('click', action);
  return node;
}

function safeAvatar(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password
      && ['yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname)) return url.href;
  } catch {}
  return '';
}

function likesOf(thread) {
  return parseLikes(thread.root?.likes ?? thread.likes);
}

function exceedsClampLines(node) {
  if (!node || !node.clientHeight) return true;
  if (typeof getComputedStyle !== 'function') return true;
  const style = getComputedStyle(node);
  let lineHeight = parseFloat(style.lineHeight);
  if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
    const fontSize = parseFloat(style.fontSize) || 14;
    lineHeight = fontSize * 1.45;
  }
  return node.scrollHeight > lineHeight * 4 + 2;
}

export class CommentsView {
  constructor({ list, count, follow, timestampOnly, playhead = null, seek, onFilterChange = null }) {
    Object.assign(this, { list, count, follow, timestampOnly, playhead, seek, onFilterChange });
    this.settings = YTCT.settingsDefaults;
    this.lastWidth = 0;
    this.resizeFrame = 0;
    this.reset('');
    // Timestamp-only mode is the one place playback following is on by default.
    timestampOnly.addEventListener('change', () => {
      this.setFollow(timestampOnly.checked);
      this.updatePlayhead();
      this.filter();
    });
    follow.addEventListener('click', () => {
      this.focused = null;
      this.setFollow(true);
      this.tick(this.media, true);
    });
    this.breakSyncOnScroll();
    this.watchResize();
  }

  watchResize() {
    const schedule = () => {
      const width = this.list.clientWidth;
      if (!width || width === this.lastWidth) return;
      this.lastWidth = width;
      if (typeof requestAnimationFrame === 'function') {
        if (this.resizeFrame) cancelAnimationFrame(this.resizeFrame);
        this.resizeFrame = requestAnimationFrame(() => {
          this.resizeFrame = 0;
          if (this.nodes?.size) this.syncReadMore();
        });
      } else if (this.nodes?.size) {
        this.syncReadMore();
      }
    };
    if (typeof ResizeObserver === 'function') {
      this.resizeObserver = new ResizeObserver(schedule);
      this.resizeObserver.observe(this.list);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', schedule, { passive: true });
    }
  }

  // Only break sync when the user scrolls the last highlighted comment completely off-screen.
  breakSyncOnScroll() {
    this.list.addEventListener('scroll', () => {
      if (!this.following) return;
      if (performance.now() < (this.scrollGuard || 0)) return;
      if (this.expectedScrollTop !== null && Math.abs(this.list.scrollTop - this.expectedScrollTop) <= 2) {
        this.expectedScrollTop = null;
        return;
      }
      if (this.lastHighlightedId && !this.isVisibleInList(this.lastHighlightedId)) {
        this.setFollow(false);
      }
    }, { passive: true });
  }

  isVisibleInList(id) {
    const row = this.nodes.get(id);
    if (!row) return false;
    const listRect = this.list.getBoundingClientRect();
    const itemRect = row.element.getBoundingClientRect();
    return itemRect.bottom > listRect.top && itemRect.top < listRect.bottom;
  }

  updatePlayhead() {
    if (!this.playhead) return;
    const show = this.timestampOnly.checked && !!this.media && Number.isFinite(this.media.currentTime);
    this.playhead.hidden = !show;
    if (show) this.playhead.textContent = formatDuration(this.media.currentTime);
  }

  holdScroll() {
    this.scrollGuard = performance.now() + 500;
  }

  scrollTo(element) {
    if (!element) return;
    const target = element.closest?.('.thread.stack-collapsed') || element;
    const listRect = this.list.getBoundingClientRect();
    const itemRect = target.getBoundingClientRect();
    const margin = 8;
    let next = this.list.scrollTop;
    if (itemRect.top < listRect.top + margin) {
      next += itemRect.top - listRect.top - margin;
    } else if (itemRect.bottom > listRect.bottom - margin) {
      next += itemRect.height > listRect.height - margin * 2
        ? itemRect.top - listRect.top - margin
        : itemRect.bottom - listRect.bottom + margin;
    } else {
      return;
    }
    const max = Math.max(0, this.list.scrollHeight - this.list.clientHeight);
    const clamped = Math.max(0, Math.min(max, next));
    if (Math.abs(clamped - this.list.scrollTop) < 1) return;
    this.holdScroll();
    this.list.scrollTop = clamped;
    this.expectedScrollTop = this.list.scrollTop;
  }

  reset(key) {
    this.activeTimers ||= new Map();
    this.clearHighlight();
    Object.assign(this, {
      key, records: [], byId: new Map(), threads: [], owners: new Map(), visible: [], timeline: [], syncTimeline: [],
      query: '', searchMode: this.settings?.defaultSearchMode === 'exact' ? 'exact' : 'fuzzy', isRegex: false,
      filters: defaultFilters(), sort: 'likes', sortPinned: false, regexHitIds: null, semanticScores: null,
      matchInfo: new Map(), datasetStats: null, lastDiagnosis: null, highlightRegex: null, highlightKey: '',
      media: null, active: new Map(), lastHighlightedId: null, focused: null, jumpReply: null, first: 0, last: PAGE_SIZE,
      entry: null, scrollGuard: 0, expectedScrollTop: null,
    });
    this.expanded = new Map();
    this.expandedStacks = new Set();
    this.full = new Set();
    this.nodes = new Map();
    this.timestampOnly.checked = false;
    this.setFollow(false);
    this.updatePlayhead();
    this.follow.disabled = true;
    this.setScale(this.settings.fontScale);
    this.count.textContent = '';
    this.list.replaceChildren();
    this.onFilterChange?.({
      total: 0, matchedThreads: 0, matchedRecords: 0, diagnosis: null,
      effectiveSort: 'likes', hasQuery: false, hasFilters: false, stats: null,
    });
  }

  load(entry) {
    if (this.entry === entry) return;
    this.entry = entry;
    this.duration = entry?.snapshot?.metadata?.lengthSeconds || this.media?.duration;
    this.records = entry ? YTCT.commentsFromExport(entry).map((record) => ({
      ...record, text: String(record.text || '').replace(/\r\n?/g, '\n'),
      timestamps: this.key.startsWith('video:') ? commentTimestamps(String(record.text || ''), this.duration) : [],
    })) : [];
    this.byId = new Map(this.records.map((record) => [record.id, record]));
    const { owners, threads } = commentThreads(this.records);
    this.owners = owners;
    this.threads = threads;
    this.timeline = timelineFor(this.records);
    this.datasetStats = computeDatasetStats(
      this.threads,
      entry?.snapshot?.metadata || null,
      !entry?.snapshot && !!entry?.markdown,
      parseLikes,
    );
    this.follow.disabled = !this.timeline.length;
    if (!this.timeline.length) this.setFollow(false);
    this.filter();
  }

  setQuery(query) {
    const next = String(query || '').trim();
    if (this.query === next) return;
    this.query = next;
    this.sortPinned = false;
    this.regexHitIds = null;
    if (next) this.setFollow(false);
    this.filter();
  }

  setSearchState(partial = {}) {
    if ('query' in partial) this.query = String(partial.query || '').trim();
    if ('searchMode' in partial) this.searchMode = partial.searchMode;
    if ('isRegex' in partial) this.isRegex = !!partial.isRegex;
    if ('filters' in partial) this.filters = { ...defaultFilters(), ...partial.filters };
    if ('sort' in partial) this.sort = partial.sort === 'relevance' ? 'relevance' : 'likes';
    if ('sortPinned' in partial) this.sortPinned = !!partial.sortPinned;
    if ('regexHitIds' in partial) this.regexHitIds = partial.regexHitIds;
    if ('semanticScores' in partial) this.semanticScores = partial.semanticScores;
    if (this.query) this.setFollow(false);
    this.filter();
  }

  getCandidateRecords() {
    const timestamped = this.timestampOnly.checked;
    const out = [];
    for (const thread of this.threads) {
      if (!threadPassesThreadFilters(thread, this.filters, this.datasetStats)) continue;
      for (const rec of [thread.root, ...thread.replies]) {
        if (timestamped && !rec.timestamps.length) continue;
        if (!recordPassesFilters(rec, this.filters, this.datasetStats, parseLikes)) continue;
        out.push({ id: rec.id, blob: rec.text + '\n@' + rec.author, text: rec.text });
      }
    }
    return out;
  }

  getAllIndexableRecords() {
    return this.records.map((rec) => ({ id: rec.id, text: (rec.author ? '@' + rec.author + ': ' : '') + rec.text }));
  }

  getDatasetStats() {
    return this.datasetStats;
  }

  setSettings(settings) {
    const previous = this.settings;
    this.settings = settings;
    this.setScale(settings.fontScale);
    if (this.timestampOnly.checked && (previous.stackComments !== settings.stackComments || previous.stackWindow !== settings.stackWindow)) {
      this.filter();
    } else {
      this.render();
      this.tick(this.media, true);
    }
  }

  setScale(percent) {
    const scale = Math.min(160, Math.max(70, Number(percent) || 100)) / 100;
    document.documentElement.style.setProperty('--ui-scale', String(scale));
    if (this.nodes?.size) this.syncReadMore();
  }

  setFollow(enabled) {
    const changed = this.following !== enabled;
    this.following = enabled;
    if (!enabled) {
      this.clearHighlight();
      this.jumpReply = null;
      if (changed) this.updateMarks();
    }
    this.follow.textContent = enabled ? 'Synced to video' : 'Sync to video time';
    this.follow.setAttribute('aria-pressed', String(enabled));
  }

  clearHighlight() {
    if (this.activeTimers) {
      for (const timer of this.activeTimers.values()) clearTimeout(timer);
      this.activeTimers.clear();
    }
    this.active = new Map();
    this.lastHighlightedId = null;
  }

  filter() {
    this.clearHighlight();
    const q = this.query.trim();
    const qLow = q.toLocaleLowerCase();
    const timestamped = this.timestampOnly.checked;
    const filters = this.filters || defaultFilters();
    const hasFilters = countActiveFilters(filters) > 0;
    const stats = this.datasetStats;
    this.lastDiagnosis = diagnoseFilters(filters, stats);
    this.matchInfo = new Map();
    this.highlightRegex = q ? buildHighlightRegex(q, this.isRegex) : null;
    this.highlightKey = q ? (this.isRegex ? 're:' : 'q:') + q : '';

    // Stage 1: Evaluate structured filters (and timestamped-only) before text search.
    const survivingThreads = [];
    const survivingRecords = [];
    for (const thread of this.threads) {
      if (!threadPassesThreadFilters(thread, filters, stats)) continue;
      const rootPass = (!timestamped || thread.root.timestamps.length > 0)
        && recordPassesFilters(thread.root, filters, stats, parseLikes);
      const passedReplies = thread.replies.filter((reply) =>
        (!timestamped || reply.timestamps.length > 0)
        && recordPassesFilters(reply, filters, stats, parseLikes));
      // Timestamped-only mode without filters/query keeps all replies under a timestamped root.
      const keepAllReplies = !q && !hasFilters && timestamped && rootPass;
      if (!rootPass && !passedReplies.length) continue;
      survivingThreads.push({
        thread,
        rootPass,
        replies: keepAllReplies ? thread.replies : (hasFilters || q || timestamped ? passedReplies : thread.replies),
      });
      if (rootPass) survivingRecords.push(thread.root);
      for (const reply of passedReplies) survivingRecords.push(reply);
    }

    // Stage 2: Text matching on surviving candidates.
    if (q) {
      if (this.isRegex) {
        if (this.regexHitIds instanceof Set) {
          for (const rec of survivingRecords) {
            if (this.regexHitIds.has(rec.id)) {
              this.matchInfo.set(rec.id, { score: 1, matchType: 'regex', semanticPct: 0 });
            }
          }
        } else {
          const checked = validateRegex(q);
          if (checked.ok && checked.regex) {
            for (const rec of survivingRecords) {
              if (checked.regex.test(rec.text + '\n@' + rec.author)) {
                this.matchInfo.set(rec.id, { score: 1, matchType: 'regex', semanticPct: 0 });
              }
            }
          }
        }
      } else if (this.searchMode === 'exact') {
        for (const rec of survivingRecords) {
          if ((rec.text + '\n@' + rec.author).toLocaleLowerCase().includes(qLow)) {
            this.matchInfo.set(rec.id, { score: 1, matchType: 'exact', semanticPct: 0 });
          }
        }
      } else {
        const exactIds = [];
        const fuzzyScores = new Map();
        const likesById = new Map();
        for (const rec of survivingRecords) {
          const blob = rec.text + '\n@' + rec.author;
          likesById.set(rec.id, parseLikes(rec.likes));
          if (blob.toLocaleLowerCase().includes(qLow)) exactIds.push(rec.id);
          const fScore = fuzzyMatchScore(blob, q);
          if (fScore > 0) fuzzyScores.set(rec.id, fScore);
        }
        const semMap = this.searchMode === 'semantic' && this.semanticScores instanceof Map
          ? new Map(survivingRecords.filter((rec) => this.semanticScores.has(rec.id)).map((rec) => [rec.id, this.semanticScores.get(rec.id)]))
          : new Map();
        const minSemanticScore = semanticModelSpec(this.settings?.semanticModel).minScore;
        this.matchInfo = fuseSearchResults({ exactIds, fuzzyScores, semanticScores: semMap, likesById, minSemanticScore });
      }
    }

    // Stage 3: Build visible threads and sort.
    const entries = [];
    let matchedRecords = 0;
    for (const { thread, rootPass, replies: candidateReplies } of survivingThreads) {
      let rootMatch = rootPass;
      let replies = candidateReplies;
      let threadScore = 0;
      if (q) {
        rootMatch = rootPass && this.matchInfo.has(thread.root.id);
        replies = candidateReplies.filter((reply) => this.matchInfo.has(reply.id));
        if (!rootMatch && !replies.length) continue;
        if (rootMatch) {
          matchedRecords++;
          threadScore = Math.max(threadScore, this.matchInfo.get(thread.root.id)?.score || 0);
        }
        for (const reply of replies) {
          matchedRecords++;
          threadScore = Math.max(threadScore, this.matchInfo.get(reply.id)?.score || 0);
        }
      } else {
        if (rootMatch) matchedRecords++;
        matchedRecords += replies.length;
      }
      const expandForCreatorReply = !q && filters.creatorReplied && replies.some((r) =>
        isCreatorRecord(r, stats?.metadata, stats?.creatorHandle));
      const item = {
        ...thread,
        replies,
        matchedReplies: (!rootMatch && replies.length > 0) || expandForCreatorReply,
        searchScore: threadScore,
      };
      if (!timestamped) {
        entries.push({ kind: 'thread', thread: item, score: threadScore });
        continue;
      }
      const rootSeconds = thread.root.timestamps[0]?.seconds ?? null;
      let seconds = rootSeconds;
      if (seconds === null) {
        const all = [];
        for (const record of [thread.root, ...replies]) for (const hit of record.timestamps) all.push(hit.seconds);
        seconds = all.length ? Math.min(...all) : null;
      }
      if (seconds === null) continue;
      entries.push({ kind: 'thread', thread: item, seconds, stackable: rootSeconds !== null, score: threadScore });
    }

    const effectiveSort = q && !timestamped && !this.sortPinned ? 'relevance' : (q && !timestamped ? this.sort : 'likes');
    if (!timestamped) {
      if (effectiveSort === 'relevance' && q) {
        entries.sort((a, b) => b.score - a.score
          || likesOf(b.thread) - likesOf(a.thread)
          || String(a.thread.root.id).localeCompare(String(b.thread.root.id)));
      }
      this.visible = entries;
    } else {
      entries.sort((a, b) => a.seconds - b.seconds
        || likesOf(b.thread) - likesOf(a.thread)
        || String(a.thread.root.id).localeCompare(String(b.thread.root.id)));
      if (this.settings.stackComments === false) {
        this.visible = entries.map((entry) => ({ kind: 'thread', thread: entry.thread }));
      } else {
        const windowSeconds = Math.max(0, Number(this.settings.stackWindow) || 0);
        const groups = [];
        for (const entry of entries) {
          if (!entry.stackable) {
            groups.push(entry);
            continue;
          }
          const last = groups[groups.length - 1];
          if (last?.kind === 'stack' && entry.seconds - last.anchor <= windowSeconds) last.threads.push(entry.thread);
          else groups.push({ kind: 'stack', anchor: entry.seconds, threads: [entry.thread] });
        }
        this.visible = groups.map((group) => {
          if (group.kind !== 'stack') return group;
          const threads = [...group.threads].sort((a, b) => likesOf(b) - likesOf(a)
            || String(a.root.id).localeCompare(String(b.root.id)));
          if (threads.length === 1) return { kind: 'thread', thread: threads[0] };
          return {
            kind: 'stack',
            key: 'stack:' + threads.map((thread) => thread.root.id).sort().join('|'),
            anchor: group.anchor,
            threads,
          };
        });
      }
    }

    const syncRecords = [];
    for (const item of this.visible) {
      // For timestamp stacks, only track the front comment; ignore comments stacked behind it.
      const thread = item.kind === 'stack' ? item.threads[0] : item.thread;
      syncRecords.push(thread.root, ...thread.replies);
    }
    this.syncTimeline = timelineFor(syncRecords);

    const count = (!q && !timestamped && !hasFilters) ? this.records.length : matchedRecords;
    this.count.textContent = this.entry ? count.toLocaleString() : '';
    this.first = 0;
    this.last = PAGE_SIZE;
    this.filteredExpanded = new Map();
    this.expandedStacks = new Set();
    this.holdScroll();
    this.list.scrollTop = 0;
    this.expectedScrollTop = this.list.scrollTop;
    this.render(false);
    if (this.following) this.tick(this.media, true);
    this.onFilterChange?.({
      total: this.records.length,
      matchedThreads: this.visible.length,
      matchedRecords,
      diagnosis: this.lastDiagnosis,
      effectiveSort,
      hasQuery: !!q,
      hasFilters,
      stats,
    });
  }

  pickTarget(ids) {
    if (!ids?.length) return null;
    const threadsOf = (item) => (item.kind === 'stack' ? item.threads : [item.thread]);
    let fallback = null;
    for (const id of ids) {
      const root = this.owners.get(id);
      const item = this.visible.find((entry) => threadsOf(entry).some((thread) => thread.root.id === root));
      if (!item) continue;
      const topId = item.kind === 'stack' ? item.threads[0].root.id : item.thread.root.id;
      if (id === topId) return id;
      fallback ||= id;
    }
    return fallback;
  }

  jump(id, citation = true) {
    if (!this.byId.has(id)) return false;
    if (citation) {
      this.setFollow(false);
      this.focused = id;
      this.full.add(id);
    }
    const root = this.owners.get(id);
    const threadsOf = (item) => (item.kind === 'stack' ? item.threads : [item.thread]);
    let index = this.visible.findIndex((item) => threadsOf(item).some((thread) => thread.root.id === root));
    if (index < 0 && citation) {
      this.timestampOnly.checked = false;
      this.query = '';
      this.updatePlayhead();
      this.filter();
      index = this.visible.findIndex((item) => threadsOf(item).some((thread) => thread.root.id === root));
    }
    if (index < 0) return false;
    const item = this.visible[index];
    let needsRender = false;
    if (citation && item.kind === 'stack' && item.threads[0].root.id !== root && !this.expandedStacks.has(item.key)) {
      // Reveal a cited comment hidden inside a timestamp stack.
      this.expandedStacks.add(item.key);
      needsRender = true;
    }
    if (index < this.first || index >= this.last) {
      this.first = Math.max(0, index - 8);
      this.last = this.first + PAGE_SIZE;
      this.jumpReply = id === root ? null : id;
      this.render(false);
    } else if (needsRender || (id !== root && !this.nodes.has(id)) || citation) {
      this.jumpReply = id === root ? null : id;
      this.render();
    }
    this.updateMarks();
    this.scrollTo(this.nodes.get(id)?.element);
    return true;
  }

  scheduleCommentExpiry(id, endVideoTime, currentTime, rate, paused) {
    const existing = this.activeTimers.get(id);
    if (existing) {
      clearTimeout(existing);
      this.activeTimers.delete(id);
    }
    if (paused) return;
    const remainingMs = Math.max(0, Math.round(((endVideoTime - currentTime) / rate) * 1000));
    const timer = setTimeout(() => {
      if (this.activeTimers.get(id) !== timer) return;
      this.activeTimers.delete(id);
      if (this.active.delete(id)) this.updateMarks();
    }, remainingMs + 25);
    this.activeTimers.set(id, timer);
  }

  tick(media, force = false) {
    this.media = media;
    this.updatePlayhead();
    if (!this.following) return;
    if (!media || !Number.isFinite(media.currentTime)) {
      if (this.active.size) {
        this.clearHighlight();
        this.updateMarks();
      }
      return;
    }
    const rate = Number.isFinite(media.playbackRate) && media.playbackRate > 0 ? media.playbackRate : 1;
    const before = this.settings.highlightBefore ?? 3;
    const after = this.settings.highlightAfter ?? 3;
    const next = activeTimestamps(this.syncTimeline, media.currentTime, before, after, rate);
    let changed = false;
    for (const id of [...this.active.keys()]) {
      if (!next.has(id)) {
        const timer = this.activeTimers.get(id);
        if (timer) clearTimeout(timer);
        this.activeTimers.delete(id);
        this.active.delete(id);
        changed = true;
      }
    }
    const newlyEntered = [];
    for (const [id, entry] of next.entries()) {
      if (!this.active.has(id)) {
        newlyEntered.push(id);
        changed = true;
      }
      this.active.set(id, entry.hit);
      this.scheduleCommentExpiry(id, entry.endVideoTime, media.currentTime, rate, !!media.paused);
    }
    if (newlyEntered.length) {
      const target = this.pickTarget(newlyEntered);
      if (target) {
        this.lastHighlightedId = target;
        this.jump(target, false);
        return;
      }
    } else if (force && next.size) {
      const target = this.pickTarget([...next.keys()]);
      if (target) {
        this.lastHighlightedId = target;
        this.jump(target, false);
        return;
      }
    }
    if (changed) this.updateMarks();
  }

  showEmpty(message) {
    const label = document.createElement('p');
    label.className = 'empty';
    label.textContent = message;
    this.list.replaceChildren(label);
  }

  render(preserve = true) {
    const top = this.list.scrollTop;
    const fragment = document.createDocumentFragment();
    this.nodes.clear();
    if (!this.entry) return;
    if (!this.visible.length) {
      this.showEmpty(this.query ? 'No comments match this search.' : this.timestampOnly.checked ? 'No comments mention a timestamp.' : 'This export contains no comment records.');
      return;
    }
    if (this.first > 0) fragment.append(button('Show earlier comments', 'pill more-roots', () => {
      this.first = Math.max(0, this.first - PAGE_SIZE);
      this.render(false);
      this.holdScroll();
      this.list.scrollTop = 0;
      this.expectedScrollTop = this.list.scrollTop;
    }));
    for (const item of this.visible.slice(this.first, this.last)) {
      fragment.append(item.kind === 'stack' ? this.renderStack(item) : this.renderThread(item.thread));
    }
    if (this.last < this.visible.length) fragment.append(button('Show more comments', 'pill more-roots', () => {
      this.last += PAGE_SIZE;
      this.render();
    }));
    this.holdScroll();
    this.list.replaceChildren(fragment);
    if (preserve) this.list.scrollTop = top;
    this.expectedScrollTop = this.list.scrollTop;
    this.lastWidth = this.list.clientWidth || this.lastWidth;
    this.updateMarks();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { if (this.nodes?.size) this.syncReadMore(); });
    }
  }

  // Keep the clicked top-level comment fixed in the viewport when replies open or stacks expand.
  renderKeeping(id) {
    const before = this.nodes.get(id)?.element.getBoundingClientRect().top;
    this.render();
    if (before == null) return;
    const element = this.nodes.get(id)?.element;
    if (!element) return;
    const delta = element.getBoundingClientRect().top - before;
    if (!delta) return;
    this.holdScroll();
    this.list.scrollTop += delta;
    this.expectedScrollTop = this.list.scrollTop;
  }

  renderStack(item) {
    const expanded = this.expandedStacks.has(item.key);
    if (!expanded) {
      return this.renderThread(item.threads[0], {
        stackRole: 'top', stackKey: item.key, stackExpanded: false, stackCount: item.threads.length,
      });
    }
    const group = document.createElement('div');
    group.className = 'stack-group';
    item.threads.forEach((thread, index) => {
      group.append(this.renderThread(thread, {
        stackRole: index === 0 ? 'top' : 'member', stackKey: item.key, stackExpanded: true, stackCount: item.threads.length,
      }));
    });
    return group;
  }

  renderThread({ root, replies, matchedReplies }, {
    stackRole = null, stackKey = null, stackExpanded = false, stackCount = 0,
  } = {}) {
    const thread = document.createElement('section');
    thread.className = 'thread';
    if (stackRole) thread.classList.add('stacked-thread');
    if (stackRole === 'top' && stackCount > 1 && !stackExpanded) {
      const depth = Math.min(3, stackCount - 1);
      thread.classList.add('stack-collapsed');
      thread.style.setProperty('--stack-depth', String(depth));
      for (let layer = 1; layer <= depth; layer++) {
        const card = document.createElement('span');
        card.className = 'stack-layer';
        card.style.setProperty('--layer', String(layer));
        card.setAttribute('aria-hidden', 'true');
        thread.append(card);
      }
    }
    const count = replies.length;
    const rawBatch = Number(this.settings.replyBatch);
    const loadAll = rawBatch === 0;
    const batch = loadAll ? count : (rawBatch > 0 ? rawBatch : 10);
    const hasActive = !!this.query || countActiveFilters(this.filters) > 0 || this.timestampOnly.checked;
    const expansion = hasActive ? this.filteredExpanded : this.expanded;
    const expanded = expansion.get(root.id) ?? (matchedReplies ? batch : 0);
    const jumpIndex = this.jumpReply ? replies.findIndex((reply) => reply.id === this.jumpReply) + 1 : 0;
    const visibleCount = Math.min(count, Math.max(expanded, jumpIndex));
    const amount = visibleCount && loadAll ? count : visibleCount;
    const rootRow = this.renderRecord(root, { stackRole, stackKey, stackExpanded, stackCount });
    if (count) {
      const toggle = button(amount ? 'Hide replies' : count.toLocaleString() + (count === 1 ? ' reply' : ' replies'), 'text-button', () => {
        if (amount) {
          expansion.set(root.id, 0);
          if (jumpIndex) this.jumpReply = null;
        } else expansion.set(root.id, batch);
        this.renderKeeping(root.id);
      });
      toggle.classList.add('reply-toggle');
      toggle.setAttribute('aria-expanded', String(!!amount));
      toggle.prepend(svg(amount ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'));
      rootRow.actions.append(toggle);
    }
    thread.append(rootRow.element);
    if (amount) {
      const list = document.createElement('div');
      list.className = 'reply-list';
      for (const reply of replies.slice(0, amount)) list.append(this.renderRecord(reply, { isReply: true }).element);
      if (amount < count) {
        const next = Math.min(batch, count - amount);
        list.append(button('Show ' + next + ' more ' + (next === 1 ? 'reply' : 'replies'), 'text-button', () => {
          expansion.set(root.id, amount + batch);
          this.renderKeeping(root.id);
        }));
      }
      thread.append(list);
    }
    return thread;
  }

  renderRecord(record, { stackRole = null, stackKey = null, stackExpanded = false, stackCount = 0, isReply = false } = {}) {
    const element = document.createElement('article');
    element.className = 'entry';
    element.dataset.commentId = record.id;
    if (stackRole) element.classList.add('stacked', stackRole === 'top' ? 'stack-top' : 'stack-member');
    const match = this.query ? this.matchInfo?.get(record.id) : null;
    if (isReply && match) element.classList.add('search-reply-hit');
    const byCreator = isCreatorRecord(record, this.datasetStats?.metadata, this.datasetStats?.creatorHandle);
    const avatar = document.createElement('span');
    avatar.className = byCreator ? 'avatar creator-avatar' : 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = (record.author || '?').slice(0, 1).toUpperCase();
    const avatarUrl = safeAvatar(record.avatar);
    if (avatarUrl) {
      const image = document.createElement('img');
      image.referrerPolicy = 'no-referrer';
      image.alt = '';
      image.loading = 'lazy';
      image.src = avatarUrl;
      image.addEventListener('error', () => image.remove(), { once: true });
      avatar.append(image);
    }
    const body = document.createElement('div');
    body.className = 'entry-body';
    const byline = document.createElement('div');
    byline.className = 'byline';
    const author = document.createElement('span');
    author.className = byCreator ? 'author creator-author' : 'author';
    author.textContent = '@' + (record.author || 'unknown');
    const published = document.createElement('span');
    published.className = 'published';
    published.textContent = record.published || '';
    byline.append(author, published);
    if (match) {
      const badge = document.createElement('span');
      badge.className = 'match-badge' + (match.matchType === 'exact' || match.matchType === 'regex' ? ' exact' : match.semanticPct ? ' semantic' : '');
      if (match.matchType === 'regex') badge.textContent = 'Regex';
      else if (match.matchType === 'exact+semantic') badge.textContent = 'Exact · ' + match.semanticPct + '%';
      else if (match.matchType === 'exact') badge.textContent = 'Exact';
      else if (match.matchType === 'fuzzy+semantic') badge.textContent = 'Fuzzy · ' + match.semanticPct + '%';
      else if (match.matchType === 'semantic') badge.textContent = 'Semantic ' + match.semanticPct + '%';
      else badge.textContent = 'Fuzzy';
      byline.append(badge);
    }
    const text = document.createElement('div');
    text.className = 'comment-text';
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    if (parseLikes(record.likes) > 0) {
      const likes = document.createElement('span');
      likes.className = 'likes';
      likes.title = record.likes + ' likes';
      likes.append(svg('M7 10v10M7 10l5-7c2 0 2 2 2 3l-.5 4H19a2 2 0 0 1 2 2l-1.5 6a2 2 0 0 1-2 2H3v-9h4Z'), String(record.likes));
      actions.append(likes);
    }
    if (record.hearted === true) {
      const heart = document.createElement('span');
      heart.className = 'creator-heart';
      heart.title = 'Hearted by the channel creator';
      const icon = svg('M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z');
      icon.classList.add('heart-fill');
      heart.append(icon, 'Creator');
      actions.append(heart);
    }
    const more = button('Read more', 'text-button', () => {
      if (this.full.has(record.id)) this.full.delete(record.id);
      else {
        this.full.add(record.id);
        this.focused = record.id;
      }
      this.updateMarks();
    });
    actions.prepend(more);
    body.append(byline, text, actions);
    element.append(avatar, body);

    if (stackRole === 'top' && stackKey) {
      const arrow = document.createElement('button');
      arrow.type = 'button';
      arrow.className = 'stack-arrow';
      arrow.setAttribute('aria-expanded', String(stackExpanded));
      arrow.title = stackExpanded
        ? 'Collapse the ' + stackCount + ' comments in this time range'
        : stackCount + ' comments are within the stack window — expand';
      arrow.setAttribute('aria-label', arrow.title);
      arrow.append(svg(stackExpanded ? 'm7 14 5-5 5 5' : 'm7 10 5 5 5-5'));
      arrow.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (this.expandedStacks.has(stackKey)) this.expandedStacks.delete(stackKey);
        else this.expandedStacks.add(stackKey);
        this.renderKeeping(record.id);
      });
      element.prepend(arrow);
    } else if (stackRole === 'member') {
      const spacer = document.createElement('span');
      spacer.className = 'stack-arrow-spacer';
      spacer.setAttribute('aria-hidden', 'true');
      element.prepend(spacer);
    }

    const row = { element, text, actions, more, record, displayed: null, highlightKey: '', clamp: null };
    this.nodes.set(record.id, row);
    return row;
  }

  updateMarks() {
    let changed = false;
    for (const row of this.nodes.values()) {
      const { record, element, text } = row;
      const hit = this.active?.get(record.id);
      const full = this.full.has(record.id);
      // Timestamp-only mode always starts at the top of the comment and cuts it to four lines.
      const cut = this.timestampOnly.checked && !full;
      const preview = !!hit && !full && !cut;
      const value = preview ? sidebarPreview(record.text, hit) : record.text || '(No text)';
      const clamp = !full && !preview;
      element.classList.toggle('marked', !!hit || this.focused === record.id);
      if (row.clamp !== clamp) {
        row.clamp = clamp;
        changed = true;
      }
      text.classList.toggle('clamped', clamp);
      const nextHighlightKey = this.highlightKey || '';
      if (row.displayed !== value || row.highlightKey !== nextHighlightKey) {
        row.displayed = value;
        row.highlightKey = nextHighlightKey;
        text.replaceChildren();
        appendCommentText(text, value, this.key, this.duration, this.seek, this.highlightRegex);
        changed = true;
      }
    }
    if (changed) this.syncReadMore();
  }

  // Show "Read more" only when clamping actually hides text at the current panel width.
  syncReadMore() {
    for (const row of this.nodes.values()) {
      const full = this.full.has(row.record.id);
      const original = row.record.text || '(No text)';
      const isPreview = row.displayed !== original;
      if (full) {
        const needsToggle = exceedsClampLines(row.text);
        row.more.hidden = !needsToggle;
        row.more.textContent = 'Show less';
        row.more.setAttribute('aria-expanded', 'true');
      } else {
        const clipped = row.text.classList.contains('clamped')
          && row.text.scrollHeight > row.text.clientHeight + 1;
        row.more.hidden = !clipped && !isPreview;
        row.more.textContent = 'Read more';
        row.more.setAttribute('aria-expanded', 'false');
      }
    }
  }
}
