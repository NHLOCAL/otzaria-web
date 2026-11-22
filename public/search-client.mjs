/* Static Pagefind federation. A query visits every relevant shard, with bounded
 * concurrency. Category/provider selection happens before loading any index. */
function mergeCounts(target, source = {}) {
  for (const [key, values] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) Object.defineProperty(target, key, { value: Object.create(null), enumerable: true });
    for (const [value, count] of Object.entries(values)) target[key][value] = (target[key][value] || 0) + count;
  }
}

export function selectSearchShards(shards, filters, scopeKey, scopeValuesKey) {
  const selected = filters?.[scopeKey];
  // Missing scope metadata must never exclude content from an older manifest.
  // Complex Pagefind filter expressions are evaluated by the engine itself.
  if (typeof selected !== 'string' || !selected) return shards;
  return shards.filter(shard => !Array.isArray(shard[scopeValuesKey]) || !shard[scopeValuesKey].length || shard[scopeValuesKey].includes(selected));
}

export function groupSearchShards(shards, scopeValuesKey, maximum = 4) {
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 8) throw new RangeError('Invalid search group size');
  const byScope = new Map();
  const groups = [];
  for (const shard of shards) {
    const scope = Array.isArray(shard[scopeValuesKey]) && shard[scopeValuesKey].length
      ? JSON.stringify([...new Set(shard[scopeValuesKey])].sort()) : '*';
    let group = byScope.get(scope);
    if (!group || group.shards.length >= maximum) {
      group = { shards: [] };
      byScope.set(scope, group); groups.push(group);
    }
    group.shards.push(shard);
  }
  return groups.map(group => ({ ...group, key: group.shards.map(shard => shard.bundlePath).join('\n') }));
}

export function createStaticSearchClient({
  manifestUrl,
  bundlePrefix,
  origin,
  concurrency = 2,
  groupSize = 4,
  scopeKey = 'category',
  scopeValuesKey = 'categories',
  indexOptions = {},
  manifestTimeoutMs = 30_000,
  onManifest = () => {},
  fetchManifest = (url, options) => fetch(url, options),
  importPagefind = url => import(url),
  workerFactory = typeof Worker === 'undefined' ? null : url => new Worker(url, { type: 'module' }),
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new RangeError('Invalid search concurrency');
  if (!Number.isFinite(manifestTimeoutMs) || manifestTimeoutMs < 1 || manifestTimeoutMs > 120_000) throw new RangeError('Invalid manifest timeout');
  groupSearchShards([], scopeValuesKey, groupSize);
  const expectedOrigin = new URL(origin).origin;
  const prefix = new URL(bundlePrefix, expectedOrigin);
  if (prefix.origin !== expectedOrigin || !prefix.pathname.endsWith('/') || prefix.search || prefix.hash) throw new Error('Invalid search bundle prefix');
  let manifestPromise;
  let modulePromise;
  let runtimeReady;
  let generation = 0;
  let tail = Promise.resolve();
  const instances = new Map();
  let transport;
  let transportKey;
  let rpcSequence = 0;

  function stopTransport(error = new Error('Search superseded')) {
    if (!transport) return;
    const old = transport;
    transport = null; transportKey = null;
    old.worker.terminate();
    for (const pending of old.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    old.pending.clear();
  }
  function rpc(current, message) {
    return new Promise((resolve, reject) => {
      const id = ++rpcSequence;
      const timer = setTimeout(() => {
        const error = new Error('Search download timed out; please retry');
        if (transport === current) stopTransport(error);
      }, 90_000);
      current.pending.set(id, { resolve, reject, timer });
      try { current.worker.postMessage({ ...message, id }); }
      catch (error) { clearTimeout(timer); current.pending.delete(id); reject(error); }
    });
  }
  async function workerSearch(shards, manifest, query, options, token) {
    if (!shards.length) return { results: [], unfilteredResultCount: 0, filters: {}, totalFilters: {}, timings: [] };
    const key = shards.map(shard => shard.bundlePath).join('\n');
    if (!transport || transportKey !== key) {
      stopTransport();
      const current = { worker: workerFactory(new URL('./search-worker.mjs', import.meta.url)), pending: new Map() };
      transport = current; transportKey = key;
      current.worker.addEventListener('message', event => {
        const pending = current.pending.get(event.data?.id);
        if (!pending) return;
        current.pending.delete(event.data.id); clearTimeout(pending.timer);
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.result);
      });
      current.worker.addEventListener('error', event => {
        if (transport === current) stopTransport(new Error(event.message || 'Search worker failed'));
      });
      current.ready = rpc(current, { op: 'init', config: { shards, origin: expectedOrigin, bundlePrefix: prefix.pathname,
        indexOptions, fingerprint: manifest.fingerprint, builtAt: manifest.builtAt } });
      current.ready.catch(() => {});
    }
    const current = transport;
    try {
      await current.ready;
      if (token !== generation) return null;
      const response = await rpc(current, { op: 'search', query, options });
      if (token !== generation) return null;
      response.results = response.results.map(result => ({ id: result.id, score: result.score,
        data: () => {
          if (transport !== current || token !== generation) return Promise.reject(new Error('Search result is no longer active'));
          return rpc(current, { op: 'data', resultEpoch: response.resultEpoch, dataKey: result.dataKey }).catch(error => {
            // Drop failed snippet work so submitting the query again starts
            // from a fresh runtime and retries all required downloads.
            if (transport === current) stopTransport(error);
            throw error;
          });
        } }));
      return response;
    } catch (error) {
      if (transport === current) stopTransport(error);
      if (token !== generation) return null;
      throw error;
    }
  }

  async function loadManifest() {
    if (!manifestPromise) {
      manifestPromise = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('Search manifest download timed out')), manifestTimeoutMs);
        try {
          const response = await fetchManifest(manifestUrl, { signal: controller.signal });
          if (!response.ok) throw new Error('Search manifest unavailable');
          const manifest = await response.json();
          if (manifest.engine !== 'pagefind' || manifest.partial || !Array.isArray(manifest.shards) || !manifest.shards.length) throw new Error('Invalid or incomplete search manifest');
          const paths = new Set();
          const shards = manifest.shards.map(shard => {
            if (!shard || typeof shard.bundlePath !== 'string') throw new Error('Invalid search shard');
            const url = new URL(shard.bundlePath, expectedOrigin);
            if (url.origin !== expectedOrigin || !url.pathname.startsWith(prefix.pathname) || !url.pathname.endsWith('/') || url.search || url.hash || url.username || url.password || paths.has(url.pathname)) throw new Error('Invalid search bundle path');
            paths.add(url.pathname);
            return { ...shard, bundlePath: url.pathname };
          });
          const validated = { ...manifest, shards };
          onManifest(validated);
          return validated;
        } finally { clearTimeout(timer); }
      })();
      manifestPromise.catch(() => { manifestPromise = null; });
    }
    return manifestPromise;
  }

  async function loadModule(manifest) {
    if (!modulePromise) {
      // Import the shared runtime once. Importing it does not load its root
      // index: each independently selected instance has an explicit basePath.
      modulePromise = importPagefind(`${manifest.shards[0].bundlePath}pagefind.js`).then(api => {
        if (typeof api.createInstance !== 'function') throw new Error('Pagefind 1.6 instance API unavailable');
        return api;
      });
      modulePromise.catch(() => { modulePromise = null; });
    }
    return modulePromise;
  }

  function optionsFor(shard, manifest) {
    const cacheTag = shard.fingerprint || manifest.fingerprint || manifest.builtAt;
    return {
      baseUrl: '/', excerptLength: 34, ...indexOptions,
      ...(typeof cacheTag === 'string' ? { metaCacheTag: cacheTag } : {}),
    };
  }

  async function instanceFor(group, manifest) {
    if (!instances.has(group.key)) {
      const api = await loadModule(manifest);
      // The shared WASM bootstrap must finish once before another primary is
      // created. Pagefind's init() waits for its wrapper, not its WASM pointer;
      // an empty search waits for the pointer without loading any term chunks.
      // Concurrent first primaries can otherwise overwrite the WASM backend.
      if (runtimeReady) await runtimeReady;
      const [first, ...additional] = group.shards;
      const instance = api.createInstance({
        ...optionsFor(first, manifest), basePath: first.bundlePath,
      });
      instances.set(group.key, instance);
      if (!runtimeReady) {
        runtimeReady = instance.search('').then(() => {});
        runtimeReady.catch(() => { runtimeReady = null; });
        await runtimeReady;
      }
      // Pagefind fetches WASM for each primary instance. A small group shares
      // one primary download, while still bounding active shard searches.
      const merged = await Promise.allSettled(additional.map(shard => {
        const { noWorker, ...options } = optionsFor(shard, manifest);
        return instance.mergeIndex(shard.bundlePath, { ...options, language: 'he' });
      }));
      const failed = merged.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    }
    return instances.get(group.key);
  }

  async function run(query, options, token) {
    if (token !== generation) return null;
    if (query === null || !String(query).trim()) return { results: [], unfilteredResultCount: 0, filters: {}, totalFilters: {}, timings: [] };
    const manifest = await loadManifest();
    if (token !== generation) return null;
    const shards = selectSearchShards(manifest.shards, options.filters, scopeKey, scopeValuesKey);
    if (workerFactory) return workerSearch(shards, manifest, query, options, token);
    const groups = groupSearchShards(shards, scopeValuesKey, groupSize);
    const responses = new Array(groups.length);
    let next = 0;
    let failure;
    const worker = async () => {
      while (!failure && token === generation) {
        const position = next++;
        if (position >= groups.length) return;
        const group = groups[position];
        try {
          const api = await instanceFor(group, manifest);
          if (token !== generation || failure) return;
          const response = await api.search(query, options);
          if (!response || !Array.isArray(response.results)) throw new Error('Invalid search response');
          responses[position] = response;
        } catch (error) {
          failure ||= error;
          const broken = instances.get(group.key);
          instances.delete(group.key);
          await Promise.resolve().then(() => broken?.destroy()).catch(() => {});
          if (!instances.size) runtimeReady = null;
        }
      }
    };
    // All started calls settle before a new query is admitted. The engine does
    // not offer abort, so cancellation skips queued shards and stale results.
    await Promise.all(Array.from({ length: Math.min(concurrency, groups.length) }, worker));
    if (token !== generation) return null;
    if (failure) throw failure; // A rejected group cannot become a partial success.
    const results = responses.flatMap(response => response.results);
    // Same score merge as Pagefind's multisite API, with a stable ID tie-break
    // independent of group size, scope selection or network completion order.
    results.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const filters = {};
    const totalFilters = {};
    let unfilteredResultCount = 0;
    for (const response of responses) {
      mergeCounts(filters, response.filters);
      mergeCounts(totalFilters, response.totalFilters);
      unfilteredResultCount += response.unfilteredResultCount ?? response.results.length;
    }
    return { results, filters, totalFilters, unfilteredResultCount, timings: responses.flatMap(response => response.timings || []) };
  }

  return {
    search(query, options = {}) {
      const token = ++generation;
      if (transport?.pending.size) stopTransport();
      const result = tail.then(() => run(query, options, token));
      tail = result.then(() => {}, () => {});
      return result;
    },
    cancel() { generation++; if (transport?.pending.size) stopTransport(); },
    async destroy() {
      generation++;
      stopTransport();
      await tail;
      const active = [...instances.values()];
      instances.clear();
      await Promise.allSettled(active.map(instance => instance.destroy()));
      runtimeReady = null;
    },
  };
}
