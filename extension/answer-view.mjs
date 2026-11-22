import { timestampAnchor } from './comments-view.mjs';

const { TIMESTAMP_PATTERN, parseTimestampToSeconds, sourceKey } = YTCT;
const markdown = window.markdownit?.({ html: false });
const linkPattern = new RegExp(String.raw`\[(C[1-9]\d*)\]|(?<![\p{L}\p{N}_])@([\p{L}\p{N}\p{M}_.-]{2,30})|` + TIMESTAMP_PATTERN, 'gu');
const safeTags = new Set('p h1 h2 h3 h4 h5 h6 ul ol li blockquote hr br table thead tbody tr th td em strong s code'.split(' '));

function commentLink(id, jump) {
  const link = document.createElement('a');
  link.href = '#comment-' + encodeURIComponent(id);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    jump(id);
  });
  return link;
}

function externalLink(href) {
  if (!/^https?:\/\//i.test(href)) return document.createElement('span');
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function inRange(links, seconds) {
  return links.key.startsWith('video:') && seconds !== null && (!links.duration || seconds <= links.duration);
}

function appendText(node, text, links, actions) {
  let end = 0;
  for (const match of text.matchAll(linkPattern)) {
    let label = match[0];
    let link;
    if (match[1] && links.comments.has(match[1])) link = commentLink(links.comments.get(match[1]), actions.jump);
    if (match[2]) {
      const handle = match[2].replace(/[.-]+$/, '');
      const url = links.authors.get(handle.toLowerCase());
      if (url) {
        link = externalLink(url);
        label = '@' + handle;
      }
    }
    if (match[3]) {
      const seconds = parseTimestampToSeconds(match[3]);
      if (inRange(links, seconds)) link = timestampAnchor(links.key, seconds, actions.seek);
    }
    if (!link) continue;
    node.append(text.slice(end, match.index));
    link.textContent = label;
    node.append(link);
    end = match.index + label.length;
  }
  node.append(text.slice(end));
}

function makeLink(href, label, links, actions) {
  const reference = /^\[?(C[1-9]\d*)\]?$/.exec(label)?.[1];
  if (reference && links.comments.has(reference)) return commentLink(links.comments.get(reference), actions.jump);
  if (sourceKey(href) === links.key) {
    const url = new URL(href);
    const id = url.searchParams.get('lc');
    if (id && [...links.comments.values()].includes(id)) return commentLink(id, actions.jump);
    const value = url.searchParams.get('t') || url.searchParams.get('start') || '';
    const time = /^\d+s?$/.test(value) ? parseInt(value, 10) : parseTimestampToSeconds(label);
    if (inRange(links, time)) return timestampAnchor(links.key, time, actions.seek);
  }
  return externalLink(href);
}

function renderTokens(root, tokens, links, actions) {
  const stack = [root];
  let linkDepth = 0;
  for (const [index, token] of tokens.entries()) {
    const parent = stack.at(-1);
    if (token.type === 'inline') renderTokens(parent, token.children || [], links, actions);
    else if (token.nesting === -1) {
      if (token.tag === 'a') linkDepth--;
      stack.pop();
    } else if (token.type === 'text') {
      if (linkDepth) parent.append(token.content);
      else appendText(parent, token.content, links, actions);
    } else if (token.type === 'softbreak') parent.append(' ');
    else if (token.type === 'image') parent.append(token.content || '');
    else if (token.type === 'fence' || token.type === 'code_block') {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = token.content;
      pre.append(code);
      parent.append(pre);
    } else if (token.tag === 'a') {
      const link = makeLink(token.attrGet('href') || '', tokens[index + 1]?.content || '', links, actions);
      parent.append(link);
      stack.push(link);
      linkDepth++;
    } else if (safeTags.has(token.tag) && !token.hidden) {
      const child = document.createElement(token.tag);
      const start = token.attrGet('start');
      if (token.tag === 'ol' && /^\d+$/.test(start || '')) child.start = Number(start);
      if (token.content) child.textContent = token.content;
      parent.append(child);
      if (token.nesting === 1) stack.push(child);
    } else if (token.nesting === 1) stack.push(parent);
  }
}

export function renderAnswer(node, text, links, actions) {
  const fragment = document.createDocumentFragment();
  try {
    if (markdown) renderTokens(fragment, markdown.parse(text, {}), links, actions);
    else appendText(fragment, text, links, actions);
  } catch {
    // Keep a completed answer readable even if a particular Markdown token fails to render.
    node.textContent = text;
    return;
  }
  node.replaceChildren(fragment);
}
