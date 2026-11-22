/** Native HTML views. Reading and navigation never depend on JavaScript. */
import { sitePath } from './config.mjs';
import { stripMarkup } from './text.mjs';
export { sitePath } from './config.mjs';

export const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const e = escape;
const paths = {
  book: id => `books/${encodeURIComponent(id)}/index.html`,
  section: (id, section) => `books/${encodeURIComponent(id)}/${encodeURIComponent(section)}.html`,
};
export const bookPath = (base, id) => sitePath(base, paths.book(id));
export const sectionPath = (base, id, section) => sitePath(base, paths.section(id, section));
const categoryPath = (base, category) => category.href || sitePath(base, `categories/${encodeURIComponent(category.id)}.html`);
const categoryLabel = category => typeof category === 'string' ? category : category.title || category.name || '';
const categoryTrail = book => (book.categories || []).map(categoryLabel).join(' · ');
const icon = (name, className = '') => {
  const drawings = {
    book: '<path d="M12 6.2C8.8 3.8 5.8 3.4 2 4.5v15c3.8-1.1 6.8-.7 10 1.7 3.2-2.4 6.2-2.8 10-1.7v-15c-3.8-1.1-6.8-.7-10 1.7Z"/><path d="M12 6.2v15"/>',
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
    left: '<path d="M19 12H5m6-6-6 6 6 6"/>',
    right: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    moon: '<path d="M20.8 14a9 9 0 0 1-10.8-10.8A9 9 0 1 0 20.8 14Z"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
    link: '<path d="m10 13 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0m2 2 1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" transform="translate(1 0)"/>',
    external: '<path d="M14 3h7v7m0-7L11 13m-1-8H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  };
  return `<svg class="icon ${e(className)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[name] || drawings.book}</svg>`;
};

function navItem(base, path, label, active = false, className = '') {
  return `<a class="${e(className)}" href="${e(sitePath(base, path))}"${active ? ' aria-current="page"' : ''}>${e(label)}</a>`;
}

export function layout({ title, description, path = 'index.html', baseUrl = '/', siteUrl = 'https://otzaria.org', body = '', breadcrumbs = [], jsonLd = [], active = 'library', noindex = false, hasPdfs = false, hasExternal = false }) {
  const canonical = new URL(sitePath(baseUrl, path), siteUrl).href;
  const structured = [...(Array.isArray(jsonLd) ? jsonLd : [jsonLd])];
  if (breadcrumbs.length && !structured.some(item => item?.['@type'] === 'BreadcrumbList')) {
    structured.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: breadcrumbs.map((crumb, index) => ({
      '@type': 'ListItem', position: index + 1, name: crumb.label || crumb.title || crumb.name,
      item: new URL(crumb.href || crumb.url || (crumb.path ? sitePath(baseUrl, crumb.path) : canonical), siteUrl).href,
    })) });
  }
  const breadcrumbHtml = breadcrumbs.length ? `<nav class="breadcrumbs" aria-label="מיקום באתר"><ol>${breadcrumbs.map((crumb, index) => {
    const text = crumb.label || crumb.title || crumb.name;
    const href = crumb.href || crumb.url || (crumb.path ? sitePath(baseUrl, crumb.path) : null);
    return `<li>${href && index !== breadcrumbs.length - 1 ? `<a href="${e(href)}">${e(text)}</a>` : `<span aria-current="page">${e(text)}</span>`}</li>`;
  }).join('')}</ol></nav>` : '';
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#f8f3ea">
<title>${e(title)}${title === 'אוצריא' ? '' : ' | אוצריא'}</title>
<meta name="description" content="${e(description)}">
<meta name="robots" content="${noindex ? 'noindex,follow' : 'index,follow,max-snippet:-1,max-image-preview:large,max-video-preview:-1'}">
<link rel="canonical" href="${e(canonical)}">
<meta property="og:type" content="website">
<meta property="og:locale" content="he_IL">
<meta property="og:site_name" content="אוצריא">
<meta property="og:title" content="${e(title)}">
<meta property="og:description" content="${e(description)}">
<meta property="og:url" content="${e(canonical)}">
<meta name="twitter:card" content="summary">
<script src="${e(sitePath(baseUrl, 'theme.js'))}"></script>
<link rel="icon" type="image/svg+xml" href="${e(sitePath(baseUrl, 'favicon.svg'))}">
<link rel="stylesheet" href="${e(sitePath(baseUrl, 'styles.css'))}">
<link rel="alternate" type="application/json" href="${e(sitePath(baseUrl, 'catalog.json'))}" title="קטלוג הספרייה">
${structured.filter(Boolean).map(data => `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')}</script>`).join('\n')}
<script type="module" src="${e(sitePath(baseUrl, 'app.js'))}"></script>
</head>
<body data-base="${e(baseUrl)}">
<a class="skip-link" href="#main">דילוג לתוכן</a>
<div class="site-header-wrap" data-pagefind-ignore><header class="site-header shell${hasExternal ? ' has-external' : ''}">
  <a class="brand" href="${e(sitePath(baseUrl, 'index.html'))}" aria-label="אוצריא, דף הבית">${icon('book')}<span>אוצריא</span></a>
  <nav class="primary-nav" aria-label="ניווט ראשי">
    ${navItem(baseUrl, 'catalog/index.html', 'הספרייה', active === 'catalog')}
    ${hasExternal ? navItem(baseUrl, 'external/index.html', 'קטלוגים נוספים', active === 'external') : ''}
    ${navItem(baseUrl, 'about.html', 'אודות', active === 'about')}
  </nav>
  <div class="header-actions">
    ${navItem(baseUrl, 'developers.html', 'למפתחים', active === 'developers', 'developer-link')}
    <a class="icon-button" href="${e(sitePath(baseUrl, 'search.html'))}" aria-label="חיפוש בספרייה"${active === 'search' ? ' aria-current="page"' : ''}>${icon('search')}</a>
    <button class="icon-button theme-toggle" type="button" data-theme-toggle aria-pressed="false" aria-label="מצב כהה" title="מצב כהה" hidden data-enhance>${icon('moon', 'icon-moon')}${icon('sun', 'icon-sun')}</button>
  </div>
</header></div>
<main id="main" class="shell" tabindex="-1">${breadcrumbHtml}${body}</main>
<footer class="site-footer shell" data-pagefind-ignore>
  <a class="brand brand-small" href="${e(sitePath(baseUrl, 'index.html'))}">${icon('book')}<span>אוצריא</span></a>
  <nav aria-label="קישורים נוספים">${navItem(baseUrl, 'catalog/index.html', 'הספרייה')}${hasExternal ? navItem(baseUrl, 'external/index.html', 'קטלוגים נוספים') : ''}${hasPdfs ? navItem(baseUrl, 'talmud-pdfs.html', 'התלמוד המצולם') : ''}${navItem(baseUrl, 'about.html', 'אודות')}${navItem(baseUrl, 'accessibility.html', 'נגישות')}${navItem(baseUrl, 'developers.html', 'למפתחים')}</nav>
  <p class="footer-note"><a href="https://www.otzaria.org/">אתר פרויקט אוצריא</a> · <a href="https://github.com/NHLOCAL/otzaria-web">קוד האתר</a></p>
</footer>
<div class="toast" role="status" aria-live="polite" hidden></div>
</body></html>`;
}

function searchForm(baseUrl, { compact = false, value = '', id = 'library-query', searchPage = false, filter = false } = {}) {
  return `<form class="search-form${compact ? ' compact-search' : ''}" action="${e(sitePath(baseUrl, 'search.html'))}" method="get" role="search"${searchPage ? ' data-search-form' : ''}>
  <label class="visually-hidden" for="${e(id)}">חיפוש בספרייה</label>
  <div class="search-input-wrap">${icon('search')}<input id="${e(id)}" name="q" type="search" value="${e(value)}" placeholder="${filter ? 'חיפוש בספרייה או סינון הספרים בעמוד' : 'שם ספר, מילה או ציטוט'}" autocomplete="off" maxlength="250" required${searchPage ? ' data-search-input' : ''}${filter ? ' data-title-filter aria-describedby="filter-hint"' : ''}></div>
  <button class="button button-primary" type="submit">חיפוש</button>
</form>`;
}

function categoryNav(baseUrl, categories, selected = null) {
  return `<aside class="category-rail"><h2 class="rail-title">תחומי לימוד</h2><nav aria-label="תחומי לימוד"><ul>
  <li><a href="${e(sitePath(baseUrl, 'catalog/index.html'))}"${selected === null ? ' aria-current="page"' : ''}>הכול</a></li>
  ${categories.map(category => `<li><a href="${e(categoryPath(baseUrl, category))}"${selected === category.id ? ' aria-current="page"' : ''}><span>${e(categoryLabel(category))}</span>${Number.isFinite(category.count) ? `<span class="category-count">${category.count.toLocaleString('he-IL')}</span>` : ''}</a></li>`).join('')}
  </ul></nav></aside>`;
}

function bookRows(books, baseUrl) {
  return `<ul class="book-list">${books.map(book => `<li data-book-row data-title="${e(book.title)}"><a class="book-row" href="${e(bookPath(baseUrl, book.id))}"><span><span class="book-title">${e(book.title)}</span><span class="book-category">${e(categoryTrail(book))}${book.author ? ` · ${e(book.author)}` : ''}</span></span>${icon('left')}</a></li>`).join('')}</ul>`;
}

function savedPages() {
  return '<details class="saved-pages" data-saved-pages hidden><summary>העמודים ששמרתי</summary><ul data-saved-pages-list></ul></details>';
}

function externalDiscovery(baseUrl, stats) {
  if (!(Number(stats.externalRecords) > 0)) return '';
  return `<aside class="external-discovery"><div><h2>קטלוגים נוספים</h2><p>${Number(stats.externalRecords).toLocaleString('he-IL')} רשומות ספרים מאוצר החכמה ומ־<bdi>HebrewBooks</bdi>, עם קישור לעיון באתר המקור.</p></div><a class="button button-outline" href="${e(sitePath(baseUrl, 'external/index.html'))}">לקטלוגים ${icon('left')}</a></aside>`;
}

function externalExplanation(baseUrl, stats, developer = false) {
  if (!(Number(stats.externalRecords) > 0)) return '';
  return `<h2>קטלוגים חיצוניים</h2><p>לצד הספרייה זמינות ${Number(stats.externalRecords).toLocaleString('he-IL')} רשומות ספרים מאוצר החכמה ומ־<bdi>HebrewBooks</bdi>. <a href="${e(sitePath(baseUrl, 'external/index.html'))}">הקטלוגים החיצוניים</a> מציגים פרטי ספרים, מחברים ומהדורות, עם חיפוש נפרד וקישורים לעיון באתרי המקור. התאמות מפורשות לספרים באוצריא מאפשרות להגיע גם לטקסט הזמין כאן.</p>${developer ? `<p><a href="${e(sitePath(baseUrl, 'external/catalog.json'))}"><code dir="ltr">external/catalog.json</code></a> מפנה לכל עמודי הרשומות ולקובצי מיפוי המקורות. לכל רשומה כתובת HTML עם עוגן קבוע, כתובת מקור ופרטי המטא־דאטה המקוריים. נתונים אלה מתארים את הספרים; הטקסטים והסריקות החיצוניים נמצאים באתרי המקור.</p>` : ''}`;
}

export function homePage({ books = [], categories = [], stats = {}, baseUrl = '/' } = {}) {
  const facts = [stats.books ? `${Number(stats.books).toLocaleString('he-IL')} ספרים` : '', stats.sections ? `${Number(stats.sections).toLocaleString('he-IL')} חלקי טקסט` : '', 'חיפוש בטקסט המלא'].filter(Boolean).join(' · ');
  return `<section class="home-intro">
  <h1>ספריית אוצריא</h1>
  <p class="home-facts">${e(facts)}</p>
  ${searchForm(baseUrl)}
  <nav class="suggestions" aria-label="חיפושים לדוגמה"><span>לדוגמה:</span>${['בראשית', 'פרקי אבות', 'תהילים'].map(term => `<a href="${e(sitePath(baseUrl, `search.html?q=${encodeURIComponent(term)}`))}">${e(term)}</a>`).join('')}</nav>
</section>
${savedPages()}
<section aria-labelledby="categories-heading" class="home-section">
  <div class="section-heading"><h2 id="categories-heading">תחומי לימוד</h2><a href="${e(sitePath(baseUrl, 'catalog/index.html'))}">כל הספרים ${icon('left')}</a></div>
  <ul class="category-grid">${categories.map(category => `<li><a href="${e(categoryPath(baseUrl, category))}"><span>${e(categoryLabel(category))}</span>${Number.isFinite(category.count) ? `<span class="category-count">${category.count.toLocaleString('he-IL')}</span>` : ''}</a></li>`).join('')}</ul>
</section>
<section aria-labelledby="library-heading" class="home-section">
  <div class="section-heading"><h2 id="library-heading">ספרים נבחרים</h2></div>
  ${bookRows(books.slice(0, 6), baseUrl)}
</section>${externalDiscovery(baseUrl, stats)}`;
}

export function catalogPage({ books = [], categories = [], category = null, title, baseUrl = '/', pagination = null, total, stats = {} } = {}) {
  const heading = title || category?.title || 'הספרייה';
  return `<section class="page-heading"><h1>${e(heading)}</h1><p>${Number(total ?? stats.books ?? books.length).toLocaleString('he-IL')} ספרים לקריאה וללימוד${category ? ` בתחום ${e(category.title)}` : ''}.</p>${searchForm(baseUrl, { compact: true, filter: true })}<p class="filter-hint" id="filter-hint" hidden data-enhance data-filter-hint>הקלדה מסננת את הספרים בעמוד. <kbd>Enter</kbd> מחפש בכל הספרייה.</p></section>
${externalDiscovery(baseUrl, stats)}${savedPages()}<div class="library-layout catalog-layout">${categoryNav(baseUrl, categories, category?.id ?? null)}<section class="book-list-region" aria-label="ספרים">
  ${bookRows(books, baseUrl)}
  <p class="empty-message" data-filter-empty hidden role="status">לא נמצאו ספרים בשם הזה בעמוד. אפשר לחפש בכל הספרייה בשדה החיפוש למעלה.</p>
  ${pagination ? `<nav class="pagination" aria-label="עמודי הקטלוג">${pagination.previous ? `<a href="${e(pagination.previous)}">${icon('right')} העמוד הקודם</a>` : '<span></span>'}<span>עמוד ${e(pagination.current || pagination.page || 1)}${pagination.total ? ` מתוך ${e(pagination.total)}` : ''}</span>${pagination.next ? `<a href="${e(pagination.next)}">העמוד הבא ${icon('left')}</a>` : '<span></span>'}</nav>` : ''}
</section></div>`;
}

function validLink(value) {
  if (!value || typeof value !== 'string') return null;
  try { const parsed = new URL(value, 'https://otzaria.invalid/'); return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? value : null; } catch { return null; }
}

function editionNavigation(book, baseUrl, { compact = false } = {}) {
  const editions = Array.isArray(book.editions) ? book.editions.filter(edition => edition.id !== book.id && validLink(edition.url)) : [];
  const primary = validLink(book.primaryUrl || (book.editionOf ? bookPath(baseUrl, book.editionOf) : null));
  const pdf = validLink(book.pdfUrl);
  if (!editions.length && !primary && !pdf) return '';
  return `<div class="edition-navigation${compact ? ' compact-editions' : ''}" aria-label="מהדורות הספר">${primary || pdf ? `<div class="edition-direct-links">${primary ? `<a href="${e(primary)}">למהדורה הראשית ${icon('right')}</a>` : ''}${pdf ? `<a href="${e(pdf)}" rel="external">המהדורה המצולמת ${icon('external')}</a>` : ''}</div>` : ''}${editions.length ? `<details class="edition-disclosure"><summary>מהדורות נוספות <span class="muted">(${editions.length.toLocaleString('he-IL')})</span></summary><ul>${editions.map(edition => `<li><a href="${e(edition.url)}">${e(edition.title)}</a></li>`).join('')}</ul></details>` : ''}</div>`;
}

function sourceNote(book, baseUrl, { detailed = false } = {}) {
  const license = book.license || {};
  const banners = (Array.isArray(book.banners) ? book.banners : []).map(banner => stripMarkup(typeof banner === 'string' ? banner : banner?.text || banner?.content || '')).filter(Boolean);
  const externalReferences = detailed && Array.isArray(book.mappedOtzarReferences) ? book.mappedOtzarReferences.filter(reference => reference.provider === 'otzar' && Number.isSafeInteger(reference.id) && reference.id > 0 && reference.url === `https://tablet.otzar.org/book/book.php?book=${reference.id}`) : [];
  return `<section class="source-note" aria-label="מקור הטקסט"><div class="source-links"><span>מקור הטקסט: ${book.sourceUrl ? `<a href="${e(book.sourceUrl)}" rel="external">${e(book.sourceName || book.source || 'מאגר אוצריא')}</a>` : 'מאגר אוצריא'}</span><a href="${e(sitePath(baseUrl, `books/${encodeURIComponent(book.id)}/text.txt`))}">טקסט מלא ${icon('download')}</a><a href="${e(sitePath(baseUrl, `books/${encodeURIComponent(book.id)}/book.json`))}">פרטי המקור</a></div>
  ${detailed && license.attribution ? `<p>${e(license.attribution)}</p>` : ''}
  ${detailed && validLink(book.sourceHomepageUrl) ? `<p><a href="${e(book.sourceHomepageUrl)}" rel="external">אתר המקור ${icon('external')}</a></p>` : ''}
  ${detailed && license.name ? `<p>רישיון הטקסט: ${license.url ? `<a href="${e(license.url)}" rel="external">${e(license.name)}</a>` : e(license.name)}</p>` : ''}
  ${banners.map(banner => `<p class="source-banner">${e(banner)}</p>`).join('')}
  ${externalReferences.length ? `<div class="mapped-references"><p>מהדורות מקושרות באוצר החכמה:</p><ul>${externalReferences.map(reference => `<li><a href="${e(reference.url)}" rel="external">${e(reference.title || book.title)}${reference.volume ? ` · ${e(reference.volume)}` : ''} ${icon('external')}</a>${validLink(reference.catalogUrl) ? ` · <a href="${e(reference.catalogUrl)}">פרטי הרשומה</a>` : ''}</li>`).join('')}</ul></div>` : ''}
  ${!detailed ? editionNavigation(book, baseUrl, { compact: true }) : ''}
  </section>`;
}

export function bookPage({ book, sections = book?.sections || [], baseUrl = '/' } = {}) {
  const firstSection = book.sections?.[0] || sections[0];
  return `<div class="book-overview"><header class="book-heading"><p class="book-category">${e(categoryTrail(book))}</p><h1>${e(book.title)}</h1>${book.author ? `<p class="book-author">${e(book.author)}</p>` : ''}<div class="book-actions">${firstSection ? `<a class="button button-primary" href="${e(sectionPath(baseUrl, book.id, firstSection.id))}">פתיחת הספר ${icon('left')}</a>` : ''}<a class="button button-outline" data-continue-book="${e(book.id)}" hidden>המשך הקריאה ${icon('left')}</a></div></header>
${editionNavigation(book, baseUrl)}
<section class="book-toc" aria-labelledby="toc-heading"><div class="section-heading"><h2 id="toc-heading">תוכן העניינים</h2><span class="muted">${Number(book.sectionCount ?? sections.length).toLocaleString('he-IL')} חלקים</span></div><ol>${sections.map(section => `<li><a href="${e(sectionPath(baseUrl, book.id, section.id))}"><span>${e(section.title)}</span>${icon('left')}</a></li>`).join('')}</ol></section>
${sourceNote(book, baseUrl, { detailed: true })}</div>`;
}

export function readingPage({ book, section, sections = book?.sections || [], previous = null, next = null, baseUrl = '/' } = {}) {
  const current = sections.findIndex(item => item.id === section.id);
  const nearby = sections.length > 40 ? sections.slice(Math.max(0, current - 8), current + 10) : sections;
  const category = categoryLabel(book.categories?.[0] || 'ספרים');
  return `<div class="reader-layout" data-reader data-book-id="${e(book.id)}" data-book-title="${e(book.title)}" data-section-title="${e(section.title)}">
<aside class="reader-sidebar"><details class="toc-disclosure" open><summary><span>תוכן העניינים</span>${icon('down')}</summary><nav aria-label="תוכן העניינים"><ol>${nearby.map(item => `<li><a href="${e(sectionPath(baseUrl, book.id, item.id))}"${item.id === section.id ? ' aria-current="page"' : ''}>${e(item.title)}</a></li>`).join('')}</ol><a class="full-toc-link" href="${e(bookPath(baseUrl, book.id))}">תוכן עניינים מלא</a></nav></details></aside>
<div class="reading-column">
<div class="reader-toolbar" aria-label="אפשרויות קריאה" data-enhance hidden>
  <div class="type-controls" role="group" aria-label="גודל האותיות"><button class="tool-button" type="button" data-font-size="decrease" aria-label="הקטנת אותיות">א−</button><button class="tool-button" type="button" data-font-size="increase" aria-label="הגדלת אותיות">א+</button></div>
  <button class="tool-button" type="button" data-bookmark aria-pressed="false">${icon('bookmark')}<span>שמירה</span></button>
  <button class="tool-button" type="button" data-copy-link>${icon('link')}<span>העתקת קישור</span></button>
</div>
<article class="reading-article" data-pagefind-body data-category="${e(category)}" data-book-title="${e(book.title)}" data-section-title="${e(section.title)}" data-pagefind-filter="category[data-category]" data-pagefind-meta="book[data-book-title], section[data-section-title]">
  <header class="reading-heading"><h1 data-pagefind-meta="title">${e(book.title)} <span class="reading-chapter">${e(section.title)}</span></h1></header>
  <div class="reading-text" id="reading-text">${section.html}</div>
</article>
<nav class="chapter-navigation" aria-label="מעבר בין חלקי הספר">${previous ? `<a href="${e(sectionPath(baseUrl, book.id, previous.id))}" rel="prev">${icon('right')}<span><small>הקודם</small>${e(previous.title)}</span></a>` : `<a href="${e(bookPath(baseUrl, book.id))}">${icon('right')}<span>לתוכן העניינים</span></a>`}${next ? `<a href="${e(sectionPath(baseUrl, book.id, next.id))}" rel="next"><span><small>הבא</small>${e(next.title)}</span>${icon('left')}</a>` : `<a href="${e(bookPath(baseUrl, book.id))}"><span>לתוכן העניינים</span>${icon('left')}</a>`}</nav>
${sourceNote(book, baseUrl)}
</div></div>`;
}

export function searchPage({ baseUrl = '/', categories = [] } = {}) {
  const searchCategories = [...new Set(categories.map(category => category.title).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'he'));
  return `<section class="page-heading search-heading"><h1>חיפוש בספרייה</h1><p>שם ספר, מילה או ציטוט. אפשר לחפש גם בלי ניקוד.</p>${searchForm(baseUrl, { searchPage: true, id: 'search-query' })}</section>
<section class="search-results-region" data-search-region aria-label="תוצאות חיפוש">
<noscript><div class="notice"><p>החיפוש המלא פועל בדפדפן ודורש JavaScript. כל הספרים והטקסטים פתוחים לקריאה גם בלעדיו.</p><a href="${e(sitePath(baseUrl, 'catalog/index.html'))}">לגלישה בספרייה לפי נושא</a></div></noscript>
<div class="search-controls" data-search-controls hidden><label for="search-category">תחום לימוד</label><select id="search-category" data-search-category><option value="">כל התחומים</option>${searchCategories.map(category => `<option value="${e(category)}">${e(category)}</option>`).join('')}</select></div>
<p class="search-status" data-search-status role="status" aria-live="polite">הקלידו בשדה החיפוש כדי להתחיל.</p>
<ol class="search-results" data-search-results></ol>
<button class="button button-outline load-more" type="button" data-search-more hidden>תוצאות נוספות</button>
</section>`;
}

export function aboutPage({ baseUrl = '/', stats = {}, upstream = [], provenance = null } = {}) {
  const sources = Array.isArray(upstream) ? upstream : upstream.sources || [upstream];
  return `<article class="prose-page"><h1>אודות אוצריא</h1><p>אוצריא היא ספרייה תורנית דיגיטלית. באתר אפשר לחפש ספר או ציטוט, לקרוא בטקסט המלא ולהגיע ישירות למקור, במחשב ובטלפון.</p><h2>קריאה וקישורים</h2><p>לכל ספר ולכל חלק בספר יש כתובת משלו. אפשר לשתף פרק, להעתיק קישור לפסקה, לשמור את מקום הקריאה ולהתאים את גודל האותיות. הטקסט זמין גם ללא JavaScript.</p><h2>מאגר חי ומתעדכן</h2><p>הספרייה נבנית ממאגרי המקור של אוצריא. עדכוני ספרים ותיקוני טקסט נכנסים לאתר באמצעות תהליך סנכרון ובנייה אוטומטי. פרטי המקור והגרסה זמינים בכל ספר.</p>${stats.books ? `<p>בגרסה זו של האתר: ${Number(stats.books).toLocaleString('he-IL')} ספרים${stats.sections ? ` ו־${Number(stats.sections).toLocaleString('he-IL')} חלקי טקסט` : ''}.</p>` : ''}${stats.pdfs ? `<h2>התלמוד המצולם</h2><p>לצד הטקסטים זמינות ${Number(stats.pdfs).toLocaleString('he-IL')} מהדורות מצולמות. <a href="${e(sitePath(baseUrl, 'talmud-pdfs.html'))}">לכל קובצי התלמוד המצולם</a>.</p>` : ''}${externalExplanation(baseUrl, stats)}<h2>קרדיט ומקורות</h2><p>התכנים שלפניכם נאספו, מוינו, סוננו ונערכו בעמל רב ובמסירות על ידי צוות פרויקט <a href="https://www.otzaria.org/">אוצריא</a>. רישיונות הטקסטים ופרטי הייחוס של המקורות מוצגים לצד כל ספר.</p><p><a href="https://github.com/Otzaria/otzaria-library">מאגר ספריית אוצריא ${icon('external')}</a></p><h2>גישה למפתחים ולסוכני AI</h2><p>הטקסט המלא זמין כעמודי HTML וכקובצי טקסט. קטלוג מובנה, כתובות קבועות ומפות אתר מאפשרים להגיע לכל ספר ולציין את המקור במדויק.</p><p><a href="${e(sitePath(baseUrl, 'developers.html'))}">תיעוד הגישה לספרייה ${icon('left')}</a></p></article>`;
}

export function accessibilityPage({ baseUrl = '/' } = {}) {
  return `<article class="prose-page"><h1>נגישות וקריאה נוחה</h1><p>האתר נבנה עם ניווט במקלדת, כותרות מסודרות, קישור לדילוג לתוכן ותמיכה בכיווניות עברית. אפשר לקרוא ולנווט בין כל הספרים גם כאשר JavaScript כבוי.</p><h2>אפשרויות הקריאה</h2><p>בראש עמודי הטקסט אפשר להגדיל ולהקטין את האותיות ולהחליף בין מצב בהיר לכהה. ההעדפות ומקום הקריאה נשמרים בדפדפן שלכם. אפשר גם להשתמש בהגדלת התצוגה של הדפדפן.</p><h2>ניווט במקלדת</h2><p>מקש Tab עובר בין קישורים ופקדים, Enter מפעיל אותם. בתחילת כל עמוד מופיע קישור לדילוג לתוכן כאשר מגיעים אליו במקלדת. בעמודי חיפוש אפשר להשתמש ב־Ctrl+K או ב־⌘+K כדי להגיע לשדה החיפוש.</p><h2>פנייה בנושא נגישות</h2><p>אם נתקלתם בקושי, אפשר <a href="https://github.com/NHLOCAL/otzaria-web/issues">לפתוח פנייה במאגר האתר</a>. כדאי לצרף את כתובת העמוד, תיאור הקושי, הדפדפן וטכנולוגיית העזר שבה השתמשתם. אין צורך לכלול מידע אישי.</p><p><a href="${e(sitePath(baseUrl, 'catalog/index.html'))}">בחזרה לספרייה ${icon('left')}</a></p></article>`;
}

export function developersPage({ baseUrl = '/', stats = {} } = {}) {
  return `<article class="prose-page"><h1>הספרייה למפתחים ולסוכני AI</h1><p>כל עמוד קריאה מכיל את הטקסט שלו בתוך HTML סמנטי, ללא תלות בהפעלת JavaScript או בקבלת נתונים משרת. אפשר לסרוק את הקישורים מהקטלוג ועד לפסקה מסוימת.</p><h2>נקודות כניסה</h2><ul class="resource-list"><li><a href="${e(sitePath(baseUrl, 'catalog.json'))}"><code dir="ltr">catalog.json</code><span>קטלוג הספרים וכתובות הגישה</span></a></li><li><a href="${e(sitePath(baseUrl, 'llms.txt'))}"><code dir="ltr">llms.txt</code><span>מדריך קצר לגישה אוטומטית</span></a></li><li><a href="${e(sitePath(baseUrl, 'sitemap.xml'))}"><code dir="ltr">sitemap.xml</code><span>מפות האתר ועמודי הטקסט</span></a></li></ul><h2>לכל ספר</h2><p>עמוד הספר כולל תוכן עניינים וקישורים לכל חלק. הקובץ <code dir="ltr">book.json</code> כולל מטא־דאטה, פרטי מקור, גרסה ורישיון. הקובץ <code dir="ltr">text.txt</code> מכיל את הטקסט המלא.</p><pre dir="ltr"><code>books/{book-id}/index.html
books/{book-id}/{section-id}.html
books/{book-id}/book.json
books/{book-id}/text.txt</code></pre><h2>קשרים בין מקורות ומהדורות</h2><p>כאשר יש לספר קשרים למקורות אחרים, השדה <code dir="ltr">linksUrl</code> בפרטי הספר מפנה לקובץ <code dir="ltr">links.json</code>. הקשרים שומרים את מזהי הספרים והשורות המקוריים. <a href="${e(sitePath(baseUrl, 'connection-types.json'))}">מילון סוגי הקשרים</a> זמין בנפרד. מטא־דאטת הספר כוללת גם מהדורות נוספות וקישור למהדורה מצולמת, אם קיימת.</p>${externalExplanation(baseUrl, stats, true)}<h2>ציטוט וייחוס</h2><p>בציטוט מהספרייה יש לציין את שם הספר, החלק ואת כתובת העמוד. לכל פסקה יש עוגן לשיתוף מדויק. יש לשמור את הייחוס והרישיון שמופיעים בפרטי הספר ולהתייחס לגרסת המקור בעת השוואת עדכונים.</p><h2>חיפוש</h2><p>מנוע החיפוש פועל בדפדפן באמצעות אינדקס סטטי. לגילוי שיטתי של התוכן השתמשו בקטלוג, במפות האתר ובקישורים שבעמודים.</p><p><a href="https://github.com/NHLOCAL/otzaria-web">קוד המקור של האתר ${icon('external')}</a></p></article>`;
}

export function notFoundPage({ baseUrl = '/' } = {}) {
  return `<section class="page-heading not-found"><h1>העמוד לא נמצא</h1><p>ייתכן שהכתובת השתנתה. אפשר לחפש את הספר או להתחיל מהספרייה.</p>${searchForm(baseUrl)}<a href="${e(sitePath(baseUrl, 'catalog/index.html'))}">לכל הספרים ${icon('left')}</a></section>`;
}
