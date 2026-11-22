import { parse } from 'parse5';

/** Validate one complete HTML document in one DOM traversal. */
export function verifyHtml(content, { relative, origin, basePath, files }) {
  const failures = [], ids = new Set(), references = [];
  let html, canonical, headings = 0, searchBody = false;
  const expected = `${origin}${basePath}${relative}`;
  const pending = [parse(content)];
  while (pending.length) {
    const node = pending.pop();
    for (const child of node.childNodes || []) pending.push(child);
    if (!node.tagName) continue;
    const attributes = Object.fromEntries((node.attrs || []).map(item => [item.name, item.value]));
    if (node.tagName === 'html') html = attributes;
    if (node.tagName === 'h1') headings++;
    if (node.tagName === 'link' && attributes.rel === 'canonical') canonical = attributes.href;
    if (Object.hasOwn(attributes, 'data-pagefind-body')) searchBody = true;
    if (attributes.id) { if (ids.has(attributes.id)) failures.push('duplicate element IDs'); ids.add(attributes.id); }
    if (Object.keys(attributes).some(name => /^on/i.test(name))) failures.push('inline event handler');
    if (node.tagName === 'script' && attributes.type === 'application/ld+json') {
      try { JSON.parse(node.childNodes.map(child => child.value || '').join('')); }
      catch { failures.push('invalid JSON-LD'); }
    }
    for (const name of ['href', 'src']) {
      const link = attributes[name];
      if (link && !/^(?:https?:|mailto:|data:|tel:)/i.test(link)) references.push({ name, link });
    }
  }
  if (html?.lang !== 'he' || html?.dir !== 'rtl') failures.push('missing Hebrew RTL document attributes');
  if (headings !== 1) failures.push('expected exactly one H1');
  if (canonical !== expected) failures.push(`canonical mismatch (${canonical})`);
  for (const { name, link } of references) {
    try {
      if (link.startsWith('#')) {
        if (link.length > 1 && !ids.has(decodeURIComponent(link.slice(1)))) failures.push(`broken fragment ${link}`);
        continue;
      }
      const url = new URL(link, expected);
      if (url.origin !== origin || !url.pathname.startsWith(basePath)) { failures.push(`link escapes deployment base ${link}`); continue; }
      let target = decodeURIComponent(url.pathname.slice(basePath.length)) || 'index.html';
      if (target.endsWith('/')) target += 'index.html';
      if (!files.has(target)) failures.push(`broken ${name} ${link}`);
    } catch { failures.push(`invalid ${name} ${link}`); }
  }
  if (/^books\//.test(relative) && !/\/(index|contents-\d+)\.html$/.test(relative) && !searchBody) failures.push('no full-text search body');
  return failures.map(failure => `${relative}: ${failure}`);
}
