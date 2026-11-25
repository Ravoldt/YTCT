// Pure search, structured filtering, regex validation, RRF hybrid ranking,
// and Int8 vector quantization helpers shared by the side panel, worker, and tests.

export const SEMANTIC_MODELS = Object.freeze({
  'arctic-xs': Object.freeze({
    key: 'arctic-xs',
    id: 'Snowflake/snowflake-arctic-embed-xs',
    label: 'Fast English · arctic-embed-xs (~23 MB)',
    sizeMB: 23,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    docPrefix: '',
    pooling: 'cls',
    minScore: 0.36,
  }),
  'bge-small': Object.freeze({
    key: 'bge-small',
    id: 'Xenova/bge-small-en-v1.5',
    label: 'Higher Quality English · bge-small-en (~33 MB)',
    sizeMB: 33,
    queryPrefix: 'Represent this sentence for searching relevant passages: ',
    docPrefix: '',
    pooling: 'cls',
    minScore: 0.48,
  }),
  'e5-multi': Object.freeze({
    key: 'e5-multi',
    id: 'Xenova/multilingual-e5-small',
    label: 'Multilingual · multilingual-e5-small (~118 MB)',
    sizeMB: 118,
    queryPrefix: 'query: ',
    docPrefix: 'passage: ',
    pooling: 'mean',
    minScore: 0.72,
  }),
});

export function semanticModelSpec(key) {
  return SEMANTIC_MODELS[key] || SEMANTIC_MODELS['arctic-xs'];
}

export function defaultFilters() {
  return {
    hasLikes: false,
    hasReplies: false,
    hearted: false,
    byCreator: false,
    creatorReplied: false,
    mentionsCreator: false,
    edited: false,
    minLikes: '',
    maxLikes: '',
    minReplies: '',
    maxReplies: '',
    author: '',
  };
}

export function parseOptInt(value) {
  if (value === '' || value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const n = Math.floor(Number(trimmed));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function activeFilterList(filters = {}, channelName = '') {
  const list = [];
  if (filters.hasLikes) list.push(['hasLikes', 'Has likes']);
  if (filters.hasReplies) list.push(['hasReplies', 'Has replies']);
  if (filters.hearted) list.push(['hearted', '♥ Creator liked']);
  if (filters.byCreator) list.push(['byCreator', 'By creator']);
  if (filters.creatorReplied) list.push(['creatorReplied', 'Creator replied']);
  if (filters.mentionsCreator) list.push(['mentionsCreator', channelName ? 'Mentions ' + channelName : 'Mentions creator']);
  if (filters.edited) list.push(['edited', 'Edited']);
  const minLikes = parseOptInt(filters.minLikes);
  const maxLikes = parseOptInt(filters.maxLikes);
  const minReplies = parseOptInt(filters.minReplies);
  const maxReplies = parseOptInt(filters.maxReplies);
  if (minLikes !== null) list.push(['minLikes', 'Likes ≥ ' + minLikes.toLocaleString()]);
  if (maxLikes !== null) list.push(['maxLikes', 'Likes ≤ ' + maxLikes.toLocaleString()]);
  if (minReplies !== null) list.push(['minReplies', 'Replies ≥ ' + minReplies.toLocaleString()]);
  if (maxReplies !== null) list.push(['maxReplies', 'Replies ≤ ' + maxReplies.toLocaleString()]);
  const author = String(filters.author || '').trim().replace(/^@+/, '');
  if (author) list.push(['author', '@' + author]);
  return list;
}

export function countActiveFilters(filters = {}) {
  return activeFilterList(filters).length;
}

export function validateRegex(pattern) {
  const source = String(pattern || '');
  if (!source) return { ok: true, regex: null, error: '' };
  if (source.length > 1000) {
    return { ok: false, regex: null, error: 'Pattern is too long (maximum 1,000 characters).' };
  }
  try {
    const regex = new RegExp(source, 'i');
    return { ok: true, regex, error: '' };
  } catch (err) {
    const raw = String(err?.message || 'Invalid regular expression');
    const cleaned = raw.replace(/^Invalid regular expression:\s*\/[\s\S]*?\/[a-z]*:\s*/i, '').trim() || raw;
    return { ok: false, regex: null, error: cleaned };
  }
}

function damerauLevenshtein(a, b, limit = 2) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const al = a.length;
  const bl = b.length;
  const prev2 = new Int32Array(bl + 1);
  const prev1 = new Int32Array(bl + 1);
  const curr = new Int32Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev1[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= bl; j++) {
      const bc = b.charCodeAt(j - 1);
      const cost = ac === bc ? 0 : 1;
      let val = Math.min(prev1[j] + 1, curr[j - 1] + 1, prev1[j - 1] + cost);
      if (i > 1 && j > 1 && ac === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bc) {
        val = Math.min(val, prev2[j - 2] + 1);
      }
      curr[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > limit) return limit + 1;
    prev2.set(prev1);
    prev1.set(curr);
  }
  return prev1[bl];
}

// Token-aware typo-tolerant fuzzy match: exact substring (1.0), word prefix (0.86),
// or bounded Damerau-Levenshtein (0 edits for <=3 chars, 1 for 4-6 chars, 2 for 7+).
export function fuzzyMatchScore(text, query) {
  const q = String(query || '').trim().toLocaleLowerCase();
  if (!q) return 0;
  const hay = String(text || '').toLocaleLowerCase();
  if (hay.includes(q)) return 1.0;
  const qWords = q.match(/[\p{L}\p{N}_@]+/gu) || q.split(/\s+/).filter(Boolean);
  if (!qWords.length) return 0;
  const tWords = hay.match(/[\p{L}\p{N}_@]+/gu) || [];
  if (!tWords.length) return 0;
  let sum = 0;
  for (const qw of qWords) {
    let best = 0;
    const maxDist = qw.length <= 3 ? 0 : qw.length <= 6 ? 1 : 2;
    for (const tw of tWords) {
      if (tw === qw) { best = 1.0; break; }
      if (tw.startsWith(qw)) {
        if (0.86 > best) best = 0.86;
        continue;
      }
      if (maxDist > 0) {
        const dist = damerauLevenshtein(qw, tw, maxDist);
        if (dist <= maxDist) {
          const score = 0.74 - dist * 0.14;
          if (score > best) best = score;
        }
      }
    }
    if (best === 0) return 0;
    sum += best;
  }
  const avg = sum / qWords.length;
  return avg >= 0.55 ? avg : 0;
}

export function isCreatorRecord(record, metadata = null, creatorHandle = '') {
  if (!record) return false;
  if (record.isCreator === true) return true;
  if (metadata?.channelId && record.authorChannelId && record.authorChannelId === metadata.channelId) return true;
  if (creatorHandle && record.author && record.author.toLocaleLowerCase() === creatorHandle) return true;
  return false;
}

export function computeDatasetStats(threads = [], metadata = null, isLegacyMarkdown = false, parseLikesFn = (v) => Number(v) || 0) {
  let maxLikes = 0;
  let maxReplies = 0;
  let heartedCount = 0;
  let creatorCount = 0;
  let creatorRepliedCount = 0;
  let editedCount = 0;
  let totalRecords = 0;
  let detectedHandle = '';

  const channelName = String(metadata?.channel || '').trim();
  const channelSlug = channelName.toLocaleLowerCase().replace(/\s+/g, '');

  // First pass: detect creator's exact @handle if they commented/replied.
  for (const thread of threads) {
    for (const rec of [thread.root, ...thread.replies]) {
      if (rec.isCreator === true || (metadata?.channelId && rec.authorChannelId && rec.authorChannelId === metadata.channelId)) {
        if (rec.author) {
          detectedHandle = rec.author.toLocaleLowerCase();
          break;
        }
      }
    }
    if (detectedHandle) break;
  }
  const creatorHandle = detectedHandle || channelSlug;

  for (const thread of threads) {
    if (thread.replies.length > maxReplies) maxReplies = thread.replies.length;
    let threadHasCreatorReply = false;
    for (const rec of [thread.root, ...thread.replies]) {
      totalRecords++;
      const likes = parseLikesFn(rec.likes);
      if (likes > maxLikes) maxLikes = likes;
      if (rec.hearted === true) heartedCount++;
      if (rec.edited === true || /\(edited\)/i.test(rec.published || '')) editedCount++;
      const byCreator = isCreatorRecord(rec, metadata, creatorHandle);
      if (byCreator) {
        creatorCount++;
        if (rec !== thread.root) threadHasCreatorReply = true;
      }
    }
    if (threadHasCreatorReply) creatorRepliedCount++;
  }

  return {
    totalThreads: threads.length,
    totalRecords,
    maxLikes,
    maxReplies,
    heartedCount,
    creatorCount,
    creatorRepliedCount,
    editedCount,
    channelName,
    creatorHandle,
    metadata,
    isLegacyMarkdown: !!isLegacyMarkdown,
  };
}

export function diagnoseFilters(filters = {}, stats = null) {
  if (!stats) return null;
  const minLikes = parseOptInt(filters.minLikes);
  const maxLikes = parseOptInt(filters.maxLikes);
  const minReplies = parseOptInt(filters.minReplies);
  const maxReplies = parseOptInt(filters.maxReplies);

  if (minLikes !== null && maxLikes !== null && minLikes > maxLikes) {
    return {
      kind: 'warn',
      code: 'conflict-likes',
      text: 'Conflicting filters: Min likes (' + minLikes.toLocaleString() + ') is greater than Max likes (' + maxLikes.toLocaleString() + ').',
      clearKeys: ['minLikes', 'maxLikes'],
    };
  }
  if (minReplies !== null && maxReplies !== null && minReplies > maxReplies) {
    return {
      kind: 'warn',
      code: 'conflict-replies',
      text: 'Conflicting filters: Min replies (' + minReplies.toLocaleString() + ') is greater than Max replies (' + maxReplies.toLocaleString() + ').',
      clearKeys: ['minReplies', 'maxReplies'],
    };
  }
  if (filters.hearted && stats.isLegacyMarkdown) {
    return {
      kind: 'warn',
      code: 'legacy-hearted',
      text: 'Creator ♥ data isn’t stored in Markdown imports. Collect live or import a JSON export to filter creator-liked comments.',
      clearKeys: ['hearted'],
    };
  }
  if (filters.hearted && !stats.isLegacyMarkdown && stats.totalRecords > 0 && stats.heartedCount === 0) {
    return {
      kind: 'warn',
      code: 'no-hearted',
      text: 'No creator-liked (♥) comments were found in this export.',
      clearKeys: ['hearted'],
    };
  }
  if (filters.byCreator && stats.totalRecords > 0 && stats.creatorCount === 0) {
    return {
      kind: 'warn',
      code: 'no-creator',
      text: 'No comments from the channel creator were found in this export.',
      clearKeys: ['byCreator'],
    };
  }
  if (filters.creatorReplied && stats.totalThreads > 0 && stats.creatorRepliedCount === 0) {
    return {
      kind: 'warn',
      code: 'no-creator-reply',
      text: 'The channel creator hasn’t replied to any threads in this export.',
      clearKeys: ['creatorReplied'],
    };
  }
  if (minLikes !== null && stats.totalRecords > 0 && minLikes > stats.maxLikes) {
    return {
      kind: 'warn',
      code: 'oob-likes',
      text: 'Out of bounds: no comment has ' + minLikes.toLocaleString() + '+ likes (highest in this export is ' + stats.maxLikes.toLocaleString() + ').',
      clearKeys: ['minLikes'],
    };
  }
  if (minReplies !== null && stats.totalThreads > 0 && minReplies > stats.maxReplies) {
    return {
      kind: 'warn',
      code: 'oob-replies',
      text: 'Out of bounds: no thread has ' + minReplies.toLocaleString() + '+ replies (most replied has ' + stats.maxReplies.toLocaleString() + ').',
      clearKeys: ['minReplies'],
    };
  }
  return null;
}

export function recordPassesFilters(record, filters = {}, stats = null, parseLikesFn = (v) => Number(v) || 0) {
  const likes = parseLikesFn(record.likes);
  if (filters.hasLikes && likes <= 0) return false;
  const minLikes = parseOptInt(filters.minLikes);
  const maxLikes = parseOptInt(filters.maxLikes);
  if (minLikes !== null && likes < minLikes) return false;
  if (maxLikes !== null && likes > maxLikes) return false;
  if (filters.hearted && (stats?.isLegacyMarkdown || record.hearted !== true)) return false;
  if (filters.byCreator && !isCreatorRecord(record, stats?.metadata, stats?.creatorHandle)) return false;
  if (filters.mentionsCreator) {
    const low = String(record.text || '').toLocaleLowerCase();
    const channelLow = (stats?.channelName || '').toLocaleLowerCase();
    const handleLow = (stats?.creatorHandle || '').toLocaleLowerCase();
    const mentionsName = channelLow.length >= 2 && low.includes(channelLow);
    const mentionsHandle = handleLow.length >= 2 && (low.includes('@' + handleLow) || low.includes(handleLow));
    if (!mentionsName && !mentionsHandle) return false;
  }
  if (filters.edited && record.edited !== true && !/\(edited\)/i.test(record.published || '')) return false;
  const authorQuery = String(filters.author || '').trim().replace(/^@+/, '').toLocaleLowerCase();
  if (authorQuery && !String(record.author || '').toLocaleLowerCase().includes(authorQuery)) return false;
  return true;
}

export function threadPassesThreadFilters(thread, filters = {}, stats = null) {
  const replyCount = thread.replies.length;
  if (filters.hasReplies && replyCount <= 0) return false;
  const minReplies = parseOptInt(filters.minReplies);
  const maxReplies = parseOptInt(filters.maxReplies);
  if (minReplies !== null && replyCount < minReplies) return false;
  if (maxReplies !== null && replyCount > maxReplies) return false;
  if (filters.creatorReplied) {
    const hasCreatorReply = thread.replies.some((reply) => isCreatorRecord(reply, stats?.metadata, stats?.creatorHandle));
    if (!hasCreatorReply) return false;
  }
  return true;
}

// Reciprocal Rank Fusion combining Exact, Fuzzy, and Semantic matches.
export function fuseSearchResults({
  exactIds = [],
  fuzzyScores = new Map(),
  semanticScores = new Map(),
  likesById = new Map(),
  minSemanticScore = 0.36,
} = {}) {
  const exactSet = new Set(exactIds);
  const exactOrdered = [...exactSet].sort((a, b) => (likesById.get(b) || 0) - (likesById.get(a) || 0));
  const exactRank = new Map(exactOrdered.map((id, idx) => [id, idx + 1]));

  const fuzzyOrdered = [...fuzzyScores.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1] || (likesById.get(b[0]) || 0) - (likesById.get(a[0]) || 0));
  const fuzzyRank = new Map(fuzzyOrdered.map(([id], idx) => [id, idx + 1]));

  const semanticOrdered = [...semanticScores.entries()]
    .filter(([, score]) => score >= minSemanticScore)
    .sort((a, b) => b[1] - a[1] || (likesById.get(b[0]) || 0) - (likesById.get(a[0]) || 0));
  const semanticRank = new Map(semanticOrdered.map(([id], idx) => [id, idx + 1]));

  const allIds = new Set([...exactRank.keys(), ...fuzzyRank.keys(), ...semanticRank.keys()]);
  const fused = new Map();
  const K = 60;
  for (const id of allIds) {
    const rExact = exactRank.get(id);
    const rFuzzy = fuzzyRank.get(id);
    const rSem = semanticRank.get(id);
    const semRaw = semanticScores.get(id) || 0;
    const score = (rExact ? 2.0 / (K + rExact) : 0)
      + (rFuzzy ? 1.2 / (K + rFuzzy) : 0)
      + (rSem ? 1.0 / (K + rSem) : 0);
    const semanticPct = rSem ? Math.max(1, Math.min(99, Math.round(semRaw * 100))) : 0;
    let matchType = 'fuzzy';
    if (rExact && rSem) matchType = 'exact+semantic';
    else if (rExact) matchType = 'exact';
    else if (rFuzzy && rSem) matchType = 'fuzzy+semantic';
    else if (rSem) matchType = 'semantic';
    fused.set(id, { score, matchType, semanticPct, semanticScore: rSem ? semRaw : 0 });
  }
  return fused;
}

// Quantize a unit-normalized Float32Array to Int8Array (4x smaller in IndexedDB, >99.9% cosine accuracy).
export function quantizeVector(vec) {
  let maxAbs = 0;
  for (let i = 0; i < vec.length; i++) {
    const a = Math.abs(vec[i]);
    if (a > maxAbs) maxAbs = a;
  }
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const inv = scale > 0 ? 1 / scale : 0;
  const q = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    q[i] = Math.max(-127, Math.min(127, Math.round(vec[i] * inv)));
  }
  return { q, scale };
}

export function cosineInt8(queryNorm, int8Vec, scale) {
  let dot = 0;
  const len = Math.min(queryNorm.length, int8Vec.length);
  for (let i = 0; i < len; i++) dot += queryNorm[i] * int8Vec[i];
  return dot * scale;
}

export function textHash(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
