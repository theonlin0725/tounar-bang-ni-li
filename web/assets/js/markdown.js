/* v1.1.1 lightweight Markdown -> DOM renderer.
   Security rule: never use innerHTML. Every user/model string becomes a Text node. */
import { h } from './util.js';

function safeHref(value) {
  const href = String(value || '').trim();
  if (/^https?:\/\//i.test(href) || /^\/(?!\/)/.test(href)) return href;
  return null;
}

function inlineNodes(text) {
  const nodes = [];
  const source = String(text || '');
  const re = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match;
  while ((match = re.exec(source))) {
    if (match.index > last) nodes.push(document.createTextNode(source.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      const strong = h('strong');
      strong.append(...inlineNodes(token.slice(2, -2)));
      nodes.push(strong);
    } else if (token.startsWith('`')) {
      nodes.push(h('code', { text: token.slice(1, -1) }));
    } else if (token.startsWith('*')) {
      const em = h('em');
      em.append(...inlineNodes(token.slice(1, -1)));
      nodes.push(em);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = safeHref(link?.[2]);
      if (!href) nodes.push(document.createTextNode(token));
      else nodes.push(h('a', {
        href, text: link[1],
        ...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})
      }));
    }
    last = match.index + token.length;
  }
  if (last < source.length) nodes.push(document.createTextNode(source.slice(last)));
  return nodes;
}

function paragraph(text) {
  const node = h('p');
  node.append(...inlineNodes(text));
  return node;
}

export function renderMarkdownNodes(text) {
  const fragment = document.createDocumentFragment();
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let list = null;
  let listType = null;
  const flushList = () => { if (list) { fragment.append(list); list = null; listType = null; } };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (!line.trim()) { flushList(); continue; }
    if (/^```/.test(line)) {
      flushList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i += 1; }
      fragment.append(h('pre', { class: 'tn-md-code' }, h('code', { text: code.join('\n') })));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      const level = Math.min(4, heading[1].length + 1);
      const node = h(`h${level}`, { class: 'tn-md-heading' });
      node.append(...inlineNodes(heading[2]));
      fragment.append(node);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushList();
      const node = h('blockquote', { class: 'tn-md-quote' });
      node.append(...inlineNodes(line.replace(/^>\s?/, '')));
      fragment.append(node);
      continue;
    }
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    const unordered = line.match(/^[-*+]\s+(.+)$/);
    if (ordered || unordered) {
      const nextType = ordered ? 'ol' : 'ul';
      if (!list || listType !== nextType) { flushList(); listType = nextType; list = h(nextType, { class: 'tn-md-list' }); }
      const item = h('li');
      item.append(...inlineNodes((ordered || unordered)[1]));
      list.append(item);
      continue;
    }
    flushList();
    fragment.append(paragraph(line));
  }
  flushList();
  return fragment;
}

export function renderMarkdownInto(container, text) {
  container.replaceChildren(renderMarkdownNodes(text));
  return container;
}
