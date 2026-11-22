const { maxEntryBytes, markdownSourceKey, sanitizeName, sourceKey, sourceLink } = YTCT;
const cdn = new Set(['i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com']);
const text = (value, limit = 4096) => typeof value === 'string' ? value.slice(0, limit) : '';
const count = (value) => Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
const size = (value) => new Blob([JSON.stringify(value)]).size;

function mediaUrl(value) {
  try {
    const url = new URL(text(value, 2048));
    if (url.protocol !== 'https:' || !cdn.has(url.hostname) || url.port || url.username || url.password) return '';
    return url.origin + url.pathname;
  } catch { return ''; }
}

function metadata(input, key) {
  const result = { kind: key.split(':')[0], id: key.split(':')[1], url: sourceLink(key).href };
  for (const name of ['title', 'channel', 'channelId', 'collectedAt', 'uploadDate', 'publishDate',
    'publishDateText', 'publishedTime', 'category']) result[name] = text(input[name], 512);
  for (const name of ['lengthSeconds', 'likeCount', 'viewCount']) result[name] = count(input[name]);
  for (const name of ['description', 'text']) result[name] = text(input[name], 32768);
  if (typeof input.isLive === 'boolean') result.isLive = input.isLive;
  if (Array.isArray(input.keywords)) result.keywords = input.keywords.slice(0, 100).map((word) => text(word, 256));
  if (input.video && typeof input.video === 'object') {
    result.video = { id: text(input.video.id, 80), title: text(input.video.title, 512) };
  }
  if (input.poll && Array.isArray(input.poll.choices)) {
    result.poll = {
      totalVotes: count(input.poll.totalVotes),
      choices: input.poll.choices.slice(0, 20).map((choice) => ({ text: text(choice?.text), votes: count(choice?.votes) })),
    };
  }
  result.thumbnail = mediaUrl(input.thumbnail);
  result.images = Array.isArray(input.images) ? input.images.slice(0, 10).map(mediaUrl).filter(Boolean) : [];
  return result;
}

export function normalizeTranscript(input) {
  return input?.ok === true && typeof input.text === 'string' && input.text.length <= 512 * 1024
    ? { ok: true, text: input.text, segments: count(input.segments) } : null;
}

export function normalizeEntry(key, input) {
  if (!YTCT.isMediaSource(key) || !input || typeof input !== 'object' || size(input) > maxEntryBytes) {
    throw new Error('This export exceeds the 8 MiB limit or is invalid.');
  }
  const stem = sanitizeName(text(input.stem, 180), 180);
  const transcript = normalizeTranscript(input.transcript);
  if (!input.snapshot) {
    if (typeof input.markdown !== 'string' || markdownSourceKey(input.markdown) !== key) {
      throw new Error('Choose an export for the current YouTube video or post.');
    }
    const markdown = input.markdown.replace(/^(\uFEFF?# YouTube comments export\r?\n\r?\n- Source: )\S+/,
      (_, prefix) => prefix + sourceLink(key).href);
    return { stem, markdown, ...(transcript && { transcript }) };
  }
  const snapshot = input.snapshot;
  if (sourceKey(snapshot.source) !== key || !Array.isArray(snapshot.comments) || !snapshot.comments.length
    || snapshot.comments.length > 50000 || !snapshot.metadata || typeof snapshot.metadata !== 'object'
    || !snapshot.collection || !Array.isArray(snapshot.stats?.errors)) {
    throw new Error('Choose a valid export for the current YouTube video or post.');
  }
  const seen = new Set();
  const comments = snapshot.comments.map((comment) => {
    const id = text(comment?.id, 256);
    if (!id || seen.has(id) || typeof comment.text !== 'string') throw new Error('The export has invalid or duplicate comments.');
    seen.add(id);
    return {
      id, parent: text(comment.parent, 256) || null, text: text(comment.text, 32768),
      author: text(comment.author, 512), authorChannelId: text(comment.authorChannelId, 128),
      avatar: mediaUrl(comment.avatar), published: text(comment.published, 512),
      likes: Number.isFinite(comment.likes) ? String(comment.likes) : text(comment.likes, 64),
      replyCount: Number.isFinite(comment.replyCount) ? String(comment.replyCount) : text(comment.replyCount, 64),
    };
  });
  const result = {
    stem,
    snapshot: {
      source: sourceLink(key).href,
      metadata: metadata(snapshot.metadata, key),
      exportedAt: text(snapshot.exportedAt, 64),
      startedAt: text(snapshot.startedAt, 64) || null,
      reportedCount: count(snapshot.reportedCount),
      collection: {
        status: snapshot.collection.status === 'complete' ? 'complete' : 'partial',
        reason: text(snapshot.collection.reason, 512),
        pendingPages: count(snapshot.collection.pendingPages),
        limitReached: snapshot.collection.limitReached === true,
      },
      stats: {
        requests: count(snapshot.stats.requests), attempts: count(snapshot.stats.attempts),
        sort: text(snapshot.stats.sort, 128), errors: snapshot.stats.errors.slice(0, 20).map((error) => text(error, 512)),
      },
      comments,
    },
    ...(transcript && { transcript }),
  };
  if (size(result) > maxEntryBytes) throw new Error('This export exceeds the 8 MiB limit.');
  return result;
}
