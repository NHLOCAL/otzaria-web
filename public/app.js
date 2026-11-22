/* Progressive enhancements only. The complete library is readable without this file. */
const base = `/${(document.body.dataset.base || '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
const pathFor = path => `${base}${path.replace(/^\/+/, '')}`;
const one = selector => document.querySelector(selector);
const all = selector => [...document.querySelectorAll(selector)];
const normalize = value => String(value).normalize('NFKD').replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '').replace(/[׳״'"“”‘’]/g, '').replace(/[\u05be–-]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const normalizeSearch = value => {
  const normalized = String(value).normalize('NFKD').replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '').replace(/[׳״'“”‘’]/g, '').replace(/[\u05be–-]/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized.match(/"/g) || []).length % 2 ? normalized.replace(/"/g, '') : normalized;
};
const readStored = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(`otzaria:${key}`)) ?? fallback; } catch { return fallback; }
};
const writeStored = (key, value) => {
  try { localStorage.setItem(`otzaria:${key}`, JSON.stringify(value)); return true; } catch { return false; }
};
const safeLocalUrl = value => {
  try { const url = new URL(value, location.href); return url.origin === location.origin && url.pathname.startsWith(base) ? url.href : null; } catch { return null; }
};
let toastTimer;
function notify(message) {
  const toast = one('.toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
}

if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = readStored('theme', 'light') === 'dark' ? 'dark' : 'light';
const themeButton = one('[data-theme-toggle]');
const updateThemeButton = () => themeButton?.setAttribute('aria-pressed', String(document.documentElement.dataset.theme === 'dark'));
updateThemeButton();
themeButton?.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  writeStored('theme', theme); updateThemeButton();
});
let readerSize = Number(readStored('reader-size', 20));
if (!Number.isFinite(readerSize) || readerSize < 16 || readerSize > 32) readerSize = 20;
document.documentElement.style.setProperty('--reader-size', `${readerSize}px`);
all('[data-enhance]').forEach(element => { element.hidden = false; });

document.addEventListener('keydown', event => {
  const search = one('input[name="q"]');
  if (!search) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); search.focus(); search.select();
  } else if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') && !document.activeElement?.isContentEditable) {
    event.preventDefault(); search.focus();
  }
});

const filterInput = one('[data-title-filter]');
if (filterInput) {
  const rows = all('[data-book-row]');
  filterInput.addEventListener('input', () => {
    const query = normalize(filterInput.value);
    let visible = 0;
    rows.forEach(row => { row.hidden = !normalize(row.dataset.title).includes(query); if (!row.hidden) visible++; });
    const empty = one('[data-filter-empty]');
    if (empty) empty.hidden = visible > 0;
    const hint = one('[data-filter-hint]');
    if (hint) hint.firstChild.textContent = query ? `מוצגים ${visible.toLocaleString('he-IL')} מתוך ${rows.length.toLocaleString('he-IL')} ספרים בעמוד. ` : 'הקלדה מסננת את הספרים בעמוד. ';
  });
}

const continuation = one('[data-continue-book]');
if (continuation) {
  const history = readStored('reading', {});
  const last = history && typeof history === 'object' ? history[continuation.dataset.continueBook] : null;
  const href = last?.url && safeLocalUrl(last.url);
  if (href) { continuation.href = href; continuation.hidden = false; }
}

const savedPages = one('[data-saved-pages]');
if (savedPages) {
  const bookmarks = readStored('bookmarks', {});
  if (bookmarks && typeof bookmarks === 'object' && !Array.isArray(bookmarks)) {
    const list = one('[data-saved-pages-list]');
    Object.entries(bookmarks).sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0)).slice(0, 200).forEach(([url, data]) => {
      const href = safeLocalUrl(url);
      if (!href || !data || typeof data.title !== 'string') return;
      const item = document.createElement('li'); const link = document.createElement('a');
      link.href = href; link.textContent = data.title; item.append(link); list.append(item);
    });
    savedPages.hidden = list.children.length === 0;
  }
}

const reader = one('[data-reader]');
if (reader) {
  if (new URLSearchParams(location.search).has('highlight')) {
    import(pathFor('pagefind/pagefind-highlight.js')).then(({ default: PagefindHighlight }) => {
      const niqqud = Array.from({ length: 0x05c7 - 0x0591 + 1 }, (_, index) => String.fromCharCode(0x0591 + index)).filter(character => /[\u0591-\u05bd\u05bf-\u05c7]/.test(character));
      new PagefindHighlight({ highlightParam: 'highlight', markContext: '.reading-text', addStyles: false, markOptions: {
        className: 'pagefind-highlight', ignorePunctuation: niqqud, exclude: ['.paragraph-anchor'],
        done: count => { if (count && !location.hash) one('.reading-text .pagefind-highlight')?.scrollIntoView({ block: 'center' }); },
      } });
    }).catch(() => { /* Highlighting is optional; the complete text remains readable. */ });
  }
  const sizeButtons = all('[data-font-size]');
  const updateSizeButtons = () => sizeButtons.forEach(button => { button.disabled = button.dataset.fontSize === 'decrease' ? readerSize <= 16 : readerSize >= 32; });
  updateSizeButtons();
  sizeButtons.forEach(button => button.addEventListener('click', () => {
    readerSize = Math.max(16, Math.min(32, readerSize + (button.dataset.fontSize === 'increase' ? 2 : -2)));
    document.documentElement.style.setProperty('--reader-size', `${readerSize}px`);
    writeStored('reader-size', readerSize); updateSizeButtons();
  }));
  const bookmarkButton = one('[data-bookmark]');
  const bookmarkKey = () => `${location.pathname}${location.hash}`;
  let bookmarks = readStored('bookmarks', {});
  if (!bookmarks || typeof bookmarks !== 'object' || Array.isArray(bookmarks)) bookmarks = {};
  const updateBookmarkButton = () => {
    const saved = Boolean(bookmarks[bookmarkKey()]);
    bookmarkButton?.setAttribute('aria-pressed', String(saved));
    const label = bookmarkButton?.querySelector('span');
    if (label) label.textContent = saved ? 'נשמר' : 'שמירה';
  };
  updateBookmarkButton();
  addEventListener('hashchange', updateBookmarkButton);
  bookmarkButton?.addEventListener('click', () => {
    const updated = { ...bookmarks };
    const key = bookmarkKey();
    if (updated[key]) delete updated[key];
    else updated[key] = { title: `${reader.dataset.bookTitle}, ${reader.dataset.sectionTitle}`, savedAt: Date.now() };
    const entries = Object.entries(updated).sort((a, b) => Number(b[1]?.savedAt || 0) - Number(a[1]?.savedAt || 0)).slice(0, 200);
    if (writeStored('bookmarks', Object.fromEntries(entries))) {
      bookmarks = Object.fromEntries(entries); updateBookmarkButton();
      notify(bookmarks[key] ? 'העמוד נשמר בדפדפן הזה' : 'העמוד הוסר מהשמורים');
    } else notify('הדפדפן אינו מאפשר שמירה מקומית כרגע');
  });
  one('[data-copy-link]')?.addEventListener('click', async () => {
    const canonical = one('link[rel="canonical"]')?.href || location.href;
    const link = `${canonical}${location.hash}`;
    try { await navigator.clipboard.writeText(link); notify('הקישור הועתק'); }
    catch {
      const field = document.createElement('textarea');
      field.value = link; field.className = 'clipboard-fallback'; field.setAttribute('aria-label', 'קישור לעמוד');
      document.body.append(field); field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch { /* Browser may deny clipboard access. */ }
      field.remove(); notify(copied ? 'הקישור הועתק' : 'אפשר להעתיק את הקישור משורת הכתובת');
    }
  });
  const details = one('.toc-disclosure');
  if (details && matchMedia('(max-width: 720px)').matches) details.open = false;
  const saveReading = () => {
    let readings = readStored('reading', {});
    if (!readings || typeof readings !== 'object' || Array.isArray(readings)) readings = {};
    readings[reader.dataset.bookId] = { url: `${location.pathname}${location.hash}`, title: reader.dataset.sectionTitle, updatedAt: Date.now() };
    writeStored('reading', Object.fromEntries(Object.entries(readings).sort((a, b) => Number(b[1]?.updatedAt || 0) - Number(a[1]?.updatedAt || 0)).slice(0, 200)));
  };
  saveReading();
  addEventListener('hashchange', saveReading);
}

const searchRegion = one('[data-search-region]');
if (searchRegion) {
  const form = one('[data-search-form]');
  const input = one('[data-search-input]');
  const status = one('[data-search-status]');
  const resultsElement = one('[data-search-results]');
  const more = one('[data-search-more]');
  const categorySelect = one('[data-search-category]');
  const controls = one('[data-search-controls]');
  let pagefindPromise;
  let request = 0;
  let pendingTimer;
  let currentResults = [];
  let shown = 0;
  let desiredCategory = new URLSearchParams(location.search).get('category') || '';
  const batchSize = 15;
  const mergeConcurrency = 4;

  function setCategoryOptions(categories) {
    const values = [...new Set(categories.filter(category => typeof category === 'string' && category))].sort((a, b) => a.localeCompare(b, 'he'));
    categorySelect.replaceChildren(new Option('כל התחומים', ''));
    for (const category of values) categorySelect.append(new Option(category, category));
    if (values.includes(desiredCategory)) categorySelect.value = desiredCategory;
    else desiredCategory = '';
    controls.hidden = values.length === 0;
  }

  // Category names are already in the HTML. No index/filter chunks are needed
  // to show the control, and the labels do not imply query-specific counts.
  const initialCategories = [...categorySelect.options].map(option => option.value).filter(Boolean);
  if (initialCategories.length) setCategoryOptions(initialCategories);

  async function loadSearch() {
    if (!pagefindPromise) {
      pagefindPromise = (async () => {
        const response = await fetch(pathFor('search-manifest.json'));
        if (!response.ok) throw new Error('Search manifest unavailable');
        const manifest = await response.json();
        if (!Array.isArray(manifest.shards) || !manifest.shards.length) throw new Error('No search shards');
        const bundlePaths = manifest.shards.map(shard => {
          const url = new URL(shard.bundlePath, location.href);
          if (url.origin !== location.origin || !url.pathname.startsWith(base) || !url.pathname.endsWith('/')) throw new Error('Invalid search bundle path');
          return url.pathname;
        });
        const categories = manifest.shards.flatMap(shard => Array.isArray(shard.categories) ? shard.categories : []);
        if (categories.length) setCategoryOptions(categories);
        const api = await import(`${bundlePaths[0]}pagefind.js`);
        try {
          await api.options({ baseUrl: '/', excerptLength: 34, highlightParam: 'highlight' });
          // Each merge owns a separate index pointer. Bounded parallel loading
          // avoids serial network round trips without flooding large libraries.
          for (let start = 1; start < bundlePaths.length; start += mergeConcurrency) {
            const merges = await Promise.allSettled(bundlePaths.slice(start, start + mergeConcurrency).map(bundlePath => api.mergeIndex(bundlePath, { baseUrl: '/', language: 'he', highlightParam: 'highlight' })));
            const failed = merges.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
          }
          return api;
        } catch (error) {
          await api.destroy().catch(() => {});
          throw error;
        }
      })();
      pagefindPromise.catch(() => { pagefindPromise = null; });
    }
    return pagefindPromise;
  }

  function highlightedExcerpt(html) {
    // Pagefind HTML-escapes source text. Only retain its <mark> highlighting.
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const fragment = document.createDocumentFragment();
    const copy = (node, parent) => {
      if (node.nodeType === Node.TEXT_NODE) parent.append(document.createTextNode(node.textContent));
      else if (node.nodeType === Node.ELEMENT_NODE) {
        const target = node.tagName === 'MARK' ? document.createElement('mark') : parent;
        if (target !== parent) parent.append(target);
        for (const child of node.childNodes) copy(child, target);
      }
    };
    for (const node of template.content.childNodes) copy(node, fragment);
    return fragment;
  }

  async function displayMore(token) {
    more.disabled = true;
    const items = await Promise.all(currentResults.slice(shown, shown + batchSize).map(result => result.data()));
    if (token !== request) return;
    const fragment = document.createDocumentFragment();
    items.forEach(result => {
      const href = safeLocalUrl(result.url);
      if (!href) return;
      const item = document.createElement('li'); item.className = 'search-result';
      const heading = document.createElement('h2');
      const link = document.createElement('a'); link.href = href; link.textContent = result.meta?.title || result.meta?.book || 'מקור בספרייה';
      heading.append(link); item.append(heading);
      const meta = [result.meta?.book, result.meta?.section].filter(Boolean).join(' · ');
      if (meta && meta !== link.textContent) { const line = document.createElement('p'); line.className = 'result-meta'; line.textContent = meta; item.append(line); }
      const excerpt = document.createElement('p'); excerpt.className = 'result-excerpt'; excerpt.append(highlightedExcerpt(result.excerpt)); item.append(excerpt);
      fragment.append(item);
    });
    resultsElement.append(fragment);
    shown += items.length;
    more.hidden = shown >= currentResults.length;
    more.disabled = false;
    status.textContent = `נמצאו ${currentResults.length.toLocaleString('he-IL')} תוצאות${currentResults.length > shown ? `, מוצגות ${shown.toLocaleString('he-IL')}` : ''}.`;
  }

  async function search({ updateUrl = true } = {}) {
    const token = ++request;
    clearTimeout(pendingTimer);
    const rawQuery = input.value.trim();
    const query = normalizeSearch(rawQuery);
    if (updateUrl) {
      const url = new URL(location.href);
      if (rawQuery) url.searchParams.set('q', rawQuery); else url.searchParams.delete('q');
      if (categorySelect.value) url.searchParams.set('category', categorySelect.value); else url.searchParams.delete('category');
      history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
    more.hidden = true; resultsElement.replaceChildren(); currentResults = []; shown = 0;
    if (!query) { status.textContent = 'הקלידו בשדה החיפוש כדי להתחיל.'; searchRegion.removeAttribute('aria-busy'); return; }
    status.textContent = 'מחפשים בספרייה...'; searchRegion.setAttribute('aria-busy', 'true');
    try {
      const api = await loadSearch();
      if (token !== request) return;
      const options = categorySelect.value ? { filters: { category: categorySelect.value } } : {};
      const response = await api.search(query, options);
      if (token !== request) return;
      currentResults = response.results || [];
      if (!currentResults.length) status.textContent = 'לא נמצאו תוצאות. נסו פחות מילים, כתיב אחר או תחום לימוד אחר.';
      else await displayMore(token);
    } catch (error) {
      if (token !== request) return;
      status.textContent = 'לא ניתן לטעון את החיפוש כרגע. אפשר לנסות שוב או לעבור לספרייה דרך התפריט.';
    } finally {
      if (token === request) searchRegion.removeAttribute('aria-busy');
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); search(); });
  input.addEventListener('input', () => { clearTimeout(pendingTimer); pendingTimer = setTimeout(() => search(), 300); });
  categorySelect.addEventListener('change', () => { desiredCategory = categorySelect.value; search(); });
  more.addEventListener('click', async () => {
    try { await displayMore(request); }
    catch { more.disabled = false; status.textContent = 'טעינת התוצאות נוספות נכשלה. אפשר לנסות שוב.'; }
  });
  addEventListener('popstate', () => {
    const params = new URLSearchParams(location.search);
    input.value = params.get('q') || ''; desiredCategory = params.get('category') || ''; categorySelect.value = desiredCategory;
    search({ updateUrl: false });
  });
  input.value = (new URLSearchParams(location.search).get('q') || '').slice(0, 250);
  if (input.value.trim()) search({ updateUrl: false });
}
