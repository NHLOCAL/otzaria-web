/* External catalogue metadata only. The core full-text index is independent. */
export function normalizeMetadataQuery(value) {
  const normalized = String(value || '').normalize('NFKD').replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '').replace(/[׳״'“”‘’]/g, '').replace(/[\u05be–-]/g, ' ').replace(/\s+/g, ' ').trim();
  return (normalized.match(/"/g) || []).length % 2 ? normalized.replace(/"/g, '') : normalized;
}

export function safeProviderUrl(value, provider, providerId = null) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return null;
    let id;
    if (provider === 'otzar' && url.hostname === 'tablet.otzar.org' && url.pathname === '/book/book.php' && [...url.searchParams.keys()].join() === 'book') id = url.searchParams.get('book');
    else if (provider === 'hebrewbooks' && url.hostname === 'hebrewbooks.org' && !url.search) id = url.pathname.slice(1);
    else return null;
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || (providerId !== null && String(providerId) !== id)) return null;
    return url.href;
  } catch { return null; }
}

export function safeExternalResultUrl(value, base, origin) {
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || !url.pathname.startsWith(`${base}external/`) || url.search) return null;
    const match = url.pathname.slice(`${base}external/`.length).match(/^(otzar|hebrewbooks)\/[0-9]+\.html$/);
    const anchor = url.hash.match(/^#external-(otzar|hebrewbooks)-([1-9]\d*)$/);
    return match && anchor && match[1] === anchor[1] ? { url: url.href, provider: anchor[1], providerId: anchor[2] } : null;
  } catch { return null; }
}

async function initializeExternalSearch(region) {
  const base = `/${(document.body.dataset.base || '/').replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
  const one = selector => document.querySelector(selector);
  const form = one('[data-external-search-form]');
  const input = one('[data-external-search-input]');
  const providerSelect = one('[data-external-search-provider]');
  const status = one('[data-external-search-status]');
  const list = one('[data-external-search-results]');
  const more = one('[data-external-search-more]');
  const controls = one('[data-external-search-controls]');
  const providers = new Map([...providerSelect.options].filter(option => option.value).map(option => [option.value, option.textContent]));
  const batchSize = 20;
  let loading;
  let request = 0;
  let timer;
  let results = [];
  let shown = 0;
  controls.hidden = providers.size === 0;

  function readLocation() {
    const params = new URLSearchParams(location.search);
    input.value = (params.get('q') || '').slice(0, 250);
    providerSelect.value = providers.has(params.get('provider')) ? params.get('provider') : '';
  }

  function loadIndex() {
    if (!loading) {
      loading = (async () => {
        const response = await fetch(`${base}external/search-manifest.json`);
        if (!response.ok) throw new Error('External search manifest unavailable');
        const manifest = await response.json();
        if (!Array.isArray(manifest.shards) || !manifest.shards.length) throw new Error('External search has no shards');
        const bundles = manifest.shards.map(shard => {
          const url = new URL(shard.bundlePath, location.href);
          if (url.origin !== location.origin || !url.pathname.startsWith(`${base}external/pagefind/`) || !url.pathname.endsWith('/') || url.search || url.hash) throw new Error('Invalid external index path');
          return url.pathname;
        });
        const api = await import(`${bundles[0]}pagefind.js`);
        try {
          await api.options({ baseUrl: '/' });
          for (let start = 1; start < bundles.length; start += 4) {
            const merged = await Promise.allSettled(bundles.slice(start, start + 4).map(bundle => api.mergeIndex(bundle, { baseUrl: '/', language: 'he' })));
            const failed = merged.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
          }
          return api;
        } catch (error) {
          await api.destroy().catch(() => {});
          throw error;
        }
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  async function displayMore(token) {
    more.disabled = true;
    const data = await Promise.all(results.slice(shown, shown + batchSize).map(result => result.data()));
    if (token !== request) return;
    const fragment = document.createDocumentFragment();
    for (const result of data) {
      const target = safeExternalResultUrl(result.url, base, location.origin);
      const native = target && safeProviderUrl(result.meta?.provider_url, target.provider, target.providerId);
      if (!target || !native || result.meta?.provider !== target.provider) throw new Error('Invalid external result link');
      const item = document.createElement('li'); item.className = 'search-result external-result';
      const heading = document.createElement('h2');
      const link = document.createElement('a'); link.href = target.url; link.textContent = result.meta?.title || 'רשומת ספר';
      heading.append(link); item.append(heading);
      if (result.meta?.author) {
        const author = document.createElement('p'); author.className = 'external-author'; author.textContent = result.meta.author; item.append(author);
      }
      const links = document.createElement('div'); links.className = 'external-result-links';
      const provider = document.createElement('span'); provider.className = 'external-provider-tag'; provider.textContent = providers.get(target.provider) || result.meta?.provider_name || target.provider;
      const outbound = document.createElement('a'); outbound.href = native; outbound.rel = 'external'; outbound.textContent = 'לעיון באתר המקור';
      links.append(provider, outbound); item.append(links); fragment.append(item);
    }
    list.append(fragment); shown += data.length;
    more.hidden = shown >= results.length; more.disabled = false;
    status.textContent = `נמצאו ${results.length.toLocaleString('he-IL')} רשומות${shown < results.length ? `, מוצגות ${shown.toLocaleString('he-IL')}` : ''}.`;
  }

  async function search({ updateUrl = true } = {}) {
    const token = ++request;
    clearTimeout(timer);
    const raw = input.value.trim();
    const query = normalizeMetadataQuery(raw);
    if (updateUrl) {
      const url = new URL(location.href);
      if (raw) url.searchParams.set('q', raw); else url.searchParams.delete('q');
      if (providerSelect.value) url.searchParams.set('provider', providerSelect.value); else url.searchParams.delete('provider');
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
    list.replaceChildren(); more.hidden = true; results = []; shown = 0;
    if (!query) { status.textContent = 'הקלידו שם ספר או מחבר כדי להתחיל.'; region.removeAttribute('aria-busy'); return; }
    status.textContent = 'מחפשים בקטלוגים...'; region.setAttribute('aria-busy', 'true');
    try {
      const api = await loadIndex();
      if (token !== request) return;
      const response = await api.search(query, providerSelect.value ? { filters: { provider: providerSelect.value } } : {});
      if (token !== request) return;
      results = response.results || [];
      if (!results.length) status.textContent = 'לא נמצאו רשומות. נסו שם קצר יותר, כתיב אחר או קטלוג נוסף.';
      else await displayMore(token);
    } catch {
      if (token === request) status.textContent = 'לא ניתן לטעון את החיפוש כרגע. אפשר לנסות שוב או לעיין בעמודי הקטלוג.';
    } finally { if (token === request) region.removeAttribute('aria-busy'); }
  }

  form.addEventListener('submit', event => { event.preventDefault(); search(); });
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => search(), 300); });
  providerSelect.addEventListener('change', () => search());
  more.addEventListener('click', async () => {
    try { await displayMore(request); }
    catch { more.disabled = false; status.textContent = 'טעינת רשומות נוספות נכשלה. אפשר לנסות שוב.'; }
  });
  addEventListener('popstate', () => { readLocation(); search({ updateUrl: false }); });
  readLocation();
  if (input.value.trim()) search({ updateUrl: false });
}

if (typeof document !== 'undefined') {
  const region = document.querySelector('[data-external-search]');
  if (region) initializeExternalSearch(region);
}
