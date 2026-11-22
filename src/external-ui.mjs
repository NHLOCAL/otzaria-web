/** Crawlable views of the optional external metadata catalogues. */
import { escape as e, sitePath } from './ui.mjs';

const names = { otzar: 'אוצר החכמה', hebrewbooks: 'HebrewBooks' };
const number = value => Number(value || 0).toLocaleString('he-IL');
const icon = direction => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${direction === 'external' ? '<path d="M14 3h7v7m0-7L11 13m-1-8H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>' : direction === 'search' ? '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>' : '<path d="M19 12H5m6-6-6 6 6 6"/>'}</svg>`;

function localUrl(value, baseUrl, scope = 'external/') {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value, 'https://otzaria.invalid');
    return url.origin === 'https://otzaria.invalid' && url.pathname.startsWith(sitePath(baseUrl, scope)) ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch { return null; }
}

function nativeUrl(record) {
  const value = record.providerUrl || record.url;
  if (!Number.isSafeInteger(Number(record.providerId)) || Number(record.providerId) <= 0) return null;
  const expected = record.provider === 'otzar'
    ? `https://tablet.otzar.org/book/book.php?book=${Number(record.providerId)}`
    : record.provider === 'hebrewbooks' ? `https://hebrewbooks.org/${Number(record.providerId)}` : null;
  return expected && value === expected ? expected : null;
}

function providerName(provider) {
  return provider.name || names[provider.id] || provider.id;
}

function externalSearchForm(baseUrl, { enhanced = false } = {}) {
  return `<form id="external-search-form" class="search-form external-search-form" action="${e(sitePath(baseUrl, 'external/search.html'))}" method="get" role="search" aria-label="חיפוש בקטלוגים החיצוניים"${enhanced ? ' data-external-search-form' : ''}>
<label class="visually-hidden" for="external-query">שם ספר או מחבר בקטלוגים החיצוניים</label><div class="search-input-wrap">${icon('search')}<input id="external-query" name="q" type="search" placeholder="חפשו שם ספר או מחבר..." maxlength="250" autocomplete="off" required${enhanced ? ' data-external-search-input' : ''}></div><button class="button button-primary" type="submit">חיפוש</button></form>`;
}

function sourceDetails(source, baseUrl, jsonUrl = null) {
  const release = typeof source?.release === 'string' ? source.release : source?.release?.tag || '';
  let sourceUrl = null;
  try {
    const candidate = new URL(source?.url || '');
    if (candidate.protocol === 'https:' && candidate.hostname === 'github.com' && candidate.pathname.startsWith('/Otzaria/otzar-HB_catalog/')) sourceUrl = candidate.href;
  } catch { /* Source metadata can omit a release link. */ }
  const pageJson = localUrl(jsonUrl, baseUrl);
  return `<aside class="external-source-note" aria-label="מקור פרטי הספרים"><p>פרטי הספרים מובאים מקטלוגי אוצריא. העיון בספרים מתבצע באתרי המקור.${release ? ` גרסת המקור: ${sourceUrl ? `<a href="${e(sourceUrl)}" rel="external">${e(release)}</a>` : e(release)}.` : ''}</p><p><a href="${e(sitePath(baseUrl, 'external/catalog.json'))}">הקטלוג המובנה למפתחים</a>${pageJson ? ` · <a href="${e(pageJson)}">רשומות העמוד בקובץ JSON</a>` : ''}</p></aside>`;
}

function bibliography(record) {
  const year = [record.year, record.yearEnd && record.yearEnd !== record.year ? record.yearEnd : null].filter(Boolean).join(' עד ');
  const entries = [['כרך', record.volume], ['מקום הדפסה', record.place], ['שנה', year], ['עמודים', record.pages ? number(record.pages) : null]];
  const values = entries.filter(([, value]) => value !== null && value !== undefined && String(value).trim());
  return values.length ? `<dl class="external-bibliography">${values.map(([label, value]) => `<div><dt>${e(label)}</dt><dd>${e(value)}</dd></div>`).join('')}</dl>` : '';
}

function recordRow(record, provider, baseUrl) {
  const outbound = nativeUrl(record);
  const expectedId = `external-${provider.id}-${Number(record.providerId)}`;
  if (record.id !== expectedId || record.provider !== provider.id || !outbound) throw new Error(`Invalid external catalogue record: ${record.id}`);
  const ownUrl = localUrl(record.url, baseUrl) || `#${record.id}`;
  const authors = (Array.isArray(record.authors) ? record.authors : []).filter(author => typeof author === 'string' && author.trim());
  const localBooks = (Array.isArray(record.localBooks) ? record.localBooks : []).map(book => ({ ...book, href: localUrl(book.url, baseUrl, 'books/') })).filter(book => book.href && book.title);
  const subjects = (Array.isArray(record.subjects) ? record.subjects : []).filter(subject => typeof subject === 'string' && subject.trim());
  return `<li class="external-record" id="${e(record.id)}" tabindex="-1" itemscope itemtype="https://schema.org/Book"><div class="external-record-heading"><h2 itemprop="name"><a href="${e(outbound)}" rel="external">${e(record.title)}</a></h2><a class="external-permalink" href="${e(ownUrl)}" aria-label="קישור לרשומה: ${e(record.title)}">#</a></div>${authors.length ? `<p class="external-author" itemprop="author">${authors.map(e).join(' · ')}</p>` : ''}${bibliography(record)}${subjects.length ? `<p class="external-subjects">${subjects.map(e).join(' · ')}</p>` : ''}<div class="external-record-links"><a href="${e(outbound)}" rel="external">לעיון ב־<bdi>${e(providerName(provider))}</bdi> ${icon('external')}</a>${localBooks.map(book => `<a class="external-local-reader" href="${e(book.href)}">קריאה באוצריא: ${e(book.title)} <span class="external-local-arrow" aria-hidden="true">←</span></a>`).join('')}</div></li>`;
}

function paginationNav(pagination, baseUrl) {
  if (!pagination) return '';
  const previous = localUrl(pagination.previous, baseUrl);
  const next = localUrl(pagination.next, baseUrl);
  const pages = (Array.isArray(pagination.pages) ? pagination.pages : []).map(page => ({ ...page, href: localUrl(page.url, baseUrl) })).filter(page => page.href);
  return `<nav class="pagination external-pagination" aria-label="עמודי רשומות הספרים">${previous ? `<a href="${e(previous)}" rel="prev">העמוד הקודם</a>` : '<span></span>'}<span>עמוד ${e(pagination.currentPage || 1)} מתוך ${e(pagination.totalPages || 1)}</span>${next ? `<a href="${e(next)}" rel="next">העמוד הבא ${icon('left')}</a>` : '<span></span>'}${pages.length ? `<ol class="external-page-links">${pages.map(page => `<li><a href="${e(page.href)}"${page.number === pagination.currentPage ? ' aria-current="page"' : ''}>${e(page.number)}</a></li>`).join('')}</ol>` : ''}</nav>`;
}

export function externalHomePage({ baseUrl = '/', providers = [], counts = {}, source = {} } = {}) {
  return `<section class="page-heading external-heading"><p class="external-eyebrow">קטלוגי הספרים של אוצריא</p><h1>קטלוגים חיצוניים</h1><p>פרטי ספרים מאוצר החכמה ומ־<bdi>HebrewBooks</bdi>, עם קישורים לעיון באתרי המקור.</p>${externalSearchForm(baseUrl)}<p class="external-search-hint">חיפוש בשמות הספרים ובמחברים. <a href="${e(sitePath(baseUrl, 'search.html'))}">לחיפוש בטקסט המלא של ספרי אוצריא</a>.</p></section><section class="external-provider-section" aria-labelledby="external-providers-heading"><div class="section-heading"><h2 id="external-providers-heading">בחירת קטלוג</h2><span class="muted">${number(counts.records)} רשומות</span></div><ul class="external-provider-list">${providers.map(provider => { const href = localUrl(provider.href, baseUrl); return href ? `<li><a class="external-provider-row" href="${e(href)}"><span><strong><bdi>${e(providerName(provider))}</bdi></strong><span>${number(provider.count)} רשומות ספרים</span></span><span class="external-provider-action">לכל הרשומות ${icon('left')}</span></a></li>` : ''; }).join('')}</ul></section><section class="external-explanation"><h2>מהרשומה אל הספר</h2><p>כל רשומה מציגה את פרטי הספר וקישור לאתר שבו הוא מופיע. כאשר קיימת התאמה מפורשת לספר בספריית אוצריא, מופיע גם קישור לקריאת הטקסט כאן באתר.</p></section>${sourceDetails(source, baseUrl)}`;
}

export function externalProviderIndexPage({ baseUrl = '/', provider, pages = [], source = {} } = {}) {
  const links = pages.map(page => ({ ...page, href: localUrl(page.url, baseUrl) })).filter(page => page.href);
  return `<section class="page-heading external-heading"><p class="external-eyebrow">קטלוג חיצוני</p><h1>כל הרשומות ב־<bdi>${e(providerName(provider))}</bdi></h1><p>${number(provider.count)} רשומות ספרים, מחולקות ל־${number(links.length)} עמודים.</p><a class="external-inline-action" href="${e(sitePath(baseUrl, `external/search.html?provider=${encodeURIComponent(provider.id)}`))}">חיפוש בקטלוג ${icon('search')}</a></section><nav aria-label="כל עמודי הקטלוג"><ol class="external-page-index">${links.map(page => `<li><a href="${e(page.href)}"><strong>עמוד ${e(page.number)}</strong><span class="external-page-count">${number(page.count)} רשומות</span>${page.firstTitle ? `<span class="external-page-preview">${e(page.firstTitle)}</span>` : ''}</a></li>`).join('')}</ol></nav>${sourceDetails(source, baseUrl)}`;
}

export function externalProviderPage({ baseUrl = '/', provider, records = [], pagination = null, source = {} } = {}) {
  const indexUrl = localUrl(provider.href, baseUrl);
  return `<section class="page-heading external-heading"><p class="external-eyebrow">קטלוג חיצוני</p><h1>ספרים ב־<bdi>${e(providerName(provider))}</bdi></h1><p>${number(provider.count)} רשומות בקטלוג${pagination ? ` · עמוד ${e(pagination.currentPage)} מתוך ${e(pagination.totalPages)}` : ''}.</p><div class="external-heading-links"><a href="${e(sitePath(baseUrl, `external/search.html?provider=${encodeURIComponent(provider.id)}`))}">חיפוש בקטלוג ${icon('search')}</a>${indexUrl ? `<a href="${e(indexUrl)}">כל עמודי הקטלוג ${icon('left')}</a>` : ''}</div></section>${paginationNav(pagination, baseUrl)}<ol class="external-record-list" aria-label="רשומות ספרים">${records.map(record => recordRow(record, provider, baseUrl)).join('')}</ol>${paginationNav(pagination, baseUrl)}${sourceDetails(source, baseUrl, pagination?.jsonUrl)}`;
}

export function externalSearchPage({ baseUrl = '/', providers = [], counts = {} } = {}) {
  return `<section class="page-heading search-heading external-heading"><p class="external-eyebrow">קטלוגים חיצוניים</p><h1>חיפוש ספרים בקטלוגים</h1><p>חיפוש בשמות הספרים, במחברים ובפרטי המהדורות.</p>${externalSearchForm(baseUrl, { enhanced: true })}<p class="external-search-hint">${number(counts.records)} רשומות מקטלוגי המקור. <a href="${e(sitePath(baseUrl, 'search.html'))}">לחיפוש בטקסט המלא של ספרי אוצריא</a>.</p></section><section class="search-results-region external-search-region" data-external-search aria-label="תוצאות חיפוש בקטלוגים"><noscript><div class="notice"><p>החיפוש דורש JavaScript. אפשר לעיין בכל רשומות הספרים דרך עמודי הקטלוג.</p><a href="${e(sitePath(baseUrl, 'external/index.html'))}">לבחירת קטלוג</a></div></noscript><div class="search-controls" data-external-search-controls hidden><label for="external-provider">קטלוג</label><select id="external-provider" name="provider" form="external-search-form" data-external-search-provider><option value="">כל הקטלוגים</option>${providers.map(provider => `<option value="${e(provider.id)}">${e(providerName(provider))}</option>`).join('')}</select></div><p class="search-status" data-external-search-status role="status" aria-live="polite">הקלידו שם ספר או מחבר כדי להתחיל.</p><ol class="search-results" data-external-search-results></ol><button class="button button-outline load-more" type="button" data-external-search-more hidden>תוצאות נוספות</button></section><script type="module" src="${e(sitePath(baseUrl, 'external-search.js'))}"></script>`;
}
