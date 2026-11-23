const { commentTimestamps, parseLikes, timelineFor, activeTimestamp, sidebarPreview, sourceLink } = YTCT;
const PAGE_SIZE = 45;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

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

function appendCommentText(node, text, key, duration, seek) {
  if (!key.startsWith('video:')) {
    node.append(text);
    return;
  }
  const hits = commentTimestamps(text, duration).sort((a, b) => a.index - b.index);
  let start = 0;
  for (const hit of hits) {
    node.append(text.slice(start, hit.index), timestampAnchor(key, hit.seconds, seek, hit.label));
    start = hit.index + hit.label.length;
  }
  node.append(text.slice(start));
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

export class CommentsView {
  constructor({ list, count, follow, timestampOnly, seek }) {
    Object.assign(this, { list, count, follow, timestampOnly, seek });
    this.settings = YTCT.settingsDefaults;
    this.reset('');
    // Timestamp-only mode is the one place playback following is on by default.
    timestampOnly.addEventListener('change', () => {
      this.setFollow(timestampOnly.checked);
      this.filter();
    });
    follow.addEventListener('click', () => {
      this.focused = null;
      this.setFollow(true);
      this.tick(this.media, true);
    });
    this.breakSyncOnScroll();
  }

  // Only the user's own scrolling stops the sync; seek-driven scrollIntoView calls do not.
  breakSyncOnScroll() {
    const stop = () => {
      if (this.following) this.setFollow(false);
    };
    this.list.addEventListener('wheel', stop, { passive: true });
    this.list.addEventListener('touchmove', stop, { passive: true });
    this.list.addEventListener('scroll', () => {
      if (performance.now() < (this.scrollGuard || 0)) return;
      if (this.expectedScrollTop !== null && Math.abs(this.list.scrollTop - this.expectedScrollTop) <= 2) {
        this.expectedScrollTop = null;
        return;
      }
      stop();
    }, { passive: true });
    this.list.addEventListener('keydown', (event) => {
      if (SCROLL_KEYS.has(event.key)) stop();
    });
    this.list.addEventListener('pointerdown', (event) => {
      const box = this.list.getBoundingClientRect();
      const onScrollbar = event.clientX - box.left >= this.list.clientWidth
        || event.clientY - box.top >= this.list.clientHeight;
      if (onScrollbar) stop();
    });
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
    this.clearHighlight();
    Object.assign(this, { key, records: [], byId: new Map(), threads: [], owners: new Map(), visible: [], timeline: [], syncTimeline: [],
      query: '', media: null, active: null, focused: null, jumpReply: null, first: 0, last: PAGE_SIZE, entry: null,
      scrollGuard: 0, expectedScrollTop: null });
    this.expanded = new Map();
    this.expandedStacks = new Set();
    this.full = new Set();
    this.nodes = new Map();
    this.timestampOnly.checked = false;
    this.setFollow(false);
    this.follow.disabled = true;
    this.setScale(this.settings.fontScale);
    this.count.textContent = '';
    this.list.replaceChildren();
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
    this.follow.disabled = !this.timeline.length;
    if (!this.timeline.length) this.setFollow(false);
    this.filter();
  }

  setQuery(query) {
    const next = query.trim().toLocaleLowerCase();
    if (this.query === next) return;
    this.query = next;
    if (next) this.setFollow(false);
    this.filter();
  }

  setSettings(settings) {
    const previous = this.settings;
    this.settings = settings;
    this.setScale(settings.fontScale);
    if (this.timestampOnly.checked && previous.stackWindow !== settings.stackWindow) this.filter();
    else {
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
    clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.group = null;
    this.active = null;
  }

  filter() {
    this.clearHighlight();
    const query = this.query;
    const timestamped = this.timestampOnly.checked;
    const matches = (record) => (!timestamped || record.timestamps.length > 0) &&
      (!query || (record.text + '\n@' + record.author).toLocaleLowerCase().includes(query));
    const entries = [];
    for (const thread of this.threads) {
      const rootMatch = matches(thread.root);
      // Timestamped-only mode keeps every reply under a matching timestamped root,
      // even when the replies themselves do not mention a timestamp.
      let replies;
      if (query) replies = thread.replies.filter(matches);
      else if (timestamped) replies = rootMatch ? thread.replies : thread.replies.filter(matches);
      else replies = thread.replies;
      if (!rootMatch && !replies.length) continue;
      const item = { ...thread, replies, matchedReplies: !rootMatch && replies.length > 0 };
      if (!timestamped) {
        entries.push({ kind: 'thread', thread: item });
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
      entries.push({ kind: 'thread', thread: item, seconds, stackable: rootSeconds !== null });
    }

    if (!timestamped) {
      this.visible = entries;
    } else {
      entries.sort((a, b) => a.seconds - b.seconds
        || likesOf(b.thread) - likesOf(a.thread)
        || String(a.thread.root.id).localeCompare(String(b.thread.root.id)));
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

    const syncRecords = [];
    for (const item of this.visible) {
      // For timestamp stacks, only track the front comment; ignore comments stacked behind it.
      const thread = item.kind === 'stack' ? item.threads[0] : item.thread;
      syncRecords.push(thread.root, ...thread.replies);
    }
    this.syncTimeline = timelineFor(syncRecords);

    const count = (!query && !timestamped) ? this.records.length : this.records.filter(matches).length;
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
  }

  pickTarget(group) {
    if (!group) return null;
    const threadsOf = (item) => (item.kind === 'stack' ? item.threads : [item.thread]);
    let fallback = null;
    for (const id of group.keys()) {
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

  tick(media, force = false) {
    this.media = media;
    if (!this.following) return;
    const group = media ? activeTimestamp(this.syncTimeline, media.currentTime, this.settings.highlightOffset) : null;
    if (!force && group === this.group) return;
    this.group = group;
    const changed = group !== this.active;
    clearTimeout(this.highlightTimer);
    this.highlightTimer = null;
    this.active = group;
    if (group && (changed || force)) {
      const target = this.pickTarget(group);
      if (target) this.jump(target, false);
    }
    this.updateMarks();
    this.startHighlightTimer(group);
  }

  startHighlightTimer(group) {
    const seconds = Math.max(0, Number(this.settings.highlightDuration) || 0);
    if (!group || !seconds) return;
    const timer = setTimeout(() => {
      if (this.highlightTimer !== timer) return;
      this.highlightTimer = null;
      if (this.active !== group) return;
      this.active = null;
      this.updateMarks();
    }, seconds * 1000);
    this.highlightTimer = timer;
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
    this.updateMarks();
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
    const batch = this.settings.replyBatch;
    const expansion = this.query || this.timestampOnly.checked ? this.filteredExpanded : this.expanded;
    const expanded = expansion.get(root.id) ?? (matchedReplies ? batch : 0);
    const jumpIndex = this.jumpReply ? replies.findIndex((reply) => reply.id === this.jumpReply) + 1 : 0;
    const visibleCount = Math.min(count, Math.max(expanded, jumpIndex));
    const amount = visibleCount && this.settings.allReplies ? count : visibleCount;
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
      for (const reply of replies.slice(0, amount)) list.append(this.renderRecord(reply).element);
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

  renderRecord(record, { stackRole = null, stackKey = null, stackExpanded = false, stackCount = 0 } = {}) {
    const element = document.createElement('article');
    element.className = 'entry';
    element.dataset.commentId = record.id;
    if (stackRole) element.classList.add('stacked', stackRole === 'top' ? 'stack-top' : 'stack-member');
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
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
    author.className = 'author';
    author.textContent = '@' + (record.author || 'unknown');
    const published = document.createElement('span');
    published.className = 'published';
    published.textContent = record.published || '';
    byline.append(author, published);
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
    const long = record.text.length > 195 || record.text.split('\n').length > 4;
    const more = button('Read more', 'text-button', () => {
      if (this.full.has(record.id)) this.full.delete(record.id);
      else {
        this.full.add(record.id);
        this.setFollow(false);
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

    const row = { element, text, actions, more, record, long, displayed: null, clamped: false };
    this.nodes.set(record.id, row);
    return row;
  }

  updateMarks() {
    let changed = false;
    for (const row of this.nodes.values()) {
      const { record, long, element, text } = row;
      const hit = this.active?.get(record.id);
      const full = this.full.has(record.id);
      // Timestamp-only mode always starts at the top of the comment and cuts it to four lines.
      const cut = this.timestampOnly.checked && !full;
      const preview = !!hit && !full && !cut;
      const value = preview ? sidebarPreview(record.text, hit) : record.text || '(No text)';
      const clamp = !full && !preview && (cut || long);
      element.classList.toggle('marked', !!hit || this.focused === record.id);
      if (row.clamp !== clamp) {
        row.clamp = clamp;
        changed = true;
      }
      text.classList.toggle('clamped', clamp);
      if (row.displayed !== value) {
        row.displayed = value;
        text.replaceChildren();
        appendCommentText(text, value, this.key, this.duration, this.seek);
        changed = true;
      }
    }
    if (changed) this.syncReadMore();
  }

  // Show "Read more" only when the cut actually hides text (or when expanded, to collapse it).
  syncReadMore() {
    for (const row of this.nodes.values()) {
      const full = this.full.has(row.record.id);
      const clipped = row.text.classList.contains('clamped')
        && row.text.scrollHeight > row.text.clientHeight + 1;
      row.more.hidden = !full && !clipped && row.displayed === row.record.text;
      row.more.textContent = full ? 'Show less' : 'Read more';
      row.more.setAttribute('aria-expanded', String(full));
    }
  }
}
