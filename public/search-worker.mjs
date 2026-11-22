/* One owned worker contains one Pagefind runtime. Its fetch queue applies only
 * inside this worker, so search cannot change the page's networking behavior. */
export function createSearchWorkerHandler({
  postMessage,
  fetchResource = globalThis.fetch.bind(globalThis),
  importPagefind = url => import(url),
  maximumRequests = 8,
}) {
  let api;
  let scope;
  let resultEpoch = 0;
  let results = [];
  let serial = Promise.resolve();
  let failureCount = 0;
  let lastFailure;
  const queued = [];
  const stats = { requests: 0, bytes: 0, active: 0, peak: 0, failures: 0 };

  function failure(error) {
    failureCount++;
    stats.failures++;
    lastFailure = error instanceof Error ? error : new Error(String(error));
    return lastFailure;
  }
  // Pagefind 1.6 also logs and swallows corrupt gzip/backend chunk errors.
  // This private worker contains only the search engine, so an engine error
  // makes the operation fail rather than returning an incomplete hit set.
  // Keep its original diagnostic available to browser developer tools.
  const reportError = console.error.bind(console);
  console.error = (...values) => {
    failure(new Error(values.map(value => value instanceof Error ? value.message : String(value)).join(' ')));
    reportError(...values);
  };
  async function download(job) {
    stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    try {
      const url = new URL(String(job.input), scope.origin);
      if (url.origin !== scope.origin || !url.pathname.startsWith(scope.bundlePrefix) || url.hash || url.username || url.password) throw new Error('Search resource outside the static index');
      stats.requests++;
      const response = await fetchResource(url.href, job.options);
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Search resource returned HTTP ${response.status}`); }
      // Hold the slot until the body has arrived, not merely until headers.
      const body = await response.arrayBuffer();
      stats.bytes += body.byteLength;
      job.resolve(new Response(body, { status: response.status, headers: response.headers }));
    } catch (error) { job.reject(failure(error)); }
    finally { stats.active--; pump(); }
  }
  function pump() {
    while (queued.length && stats.active < maximumRequests) download(queued.shift());
  }
  globalThis.fetch = (input, options) => new Promise((resolve, reject) => {
    queued.push({ input, options, resolve, reject }); pump();
  });

  async function checked(action) {
    const before = failureCount;
    const result = await action();
    // Pagefind catches some chunk-fetch failures internally. Treat any failed
    // request during an operation as an error, never as an empty/partial hit set.
    if (failureCount !== before) throw lastFailure;
    return result;
  }
  function optionsFor(shard, config) {
    const cacheTag = shard.fingerprint || config.fingerprint || config.builtAt;
    return { baseUrl: '/', excerptLength: 34, ...config.indexOptions,
      ...(typeof cacheTag === 'string' ? { metaCacheTag: cacheTag } : {}) };
  }
  async function perform(message) {
    if (message.op === 'init') {
      if (api) throw new Error('Search worker is already initialized');
      scope = message.config;
      if (!Array.isArray(scope.shards) || !scope.shards.length || !scope.bundlePrefix?.endsWith('/')) throw new Error('Invalid search worker scope');
      for (const shard of scope.shards) {
        const url = new URL(shard.bundlePath, scope.origin);
        if (url.origin !== scope.origin || !url.pathname.startsWith(scope.bundlePrefix) || !url.pathname.endsWith('/') || url.search || url.hash) throw new Error('Invalid worker index path');
      }
      const [first, ...additional] = scope.shards;
      const module = await importPagefind(new URL(`${first.bundlePath}pagefind.js`, scope.origin).href);
      api = module.createInstance({ ...optionsFor(first, scope), basePath: first.bundlePath, noWorker: true });
      await checked(() => api.search(''));
      // There is one WASM primary. Every additional index shares it, and the
      // worker's download queue independently bounds actual network activity.
      for (let start = 0; start < additional.length; start += 4) {
        await checked(async () => {
          const merged = await Promise.allSettled(additional.slice(start, start + 4).map(shard => {
            const { noWorker, ...options } = optionsFor(shard, scope);
            return api.mergeIndex(shard.bundlePath, { ...options, language: 'he' });
          }));
          const failed = merged.find(item => item.status === 'rejected');
          if (failed) throw failed.reason;
        });
      }
      return true;
    }
    if (!api) throw new Error('Search worker is not initialized');
    if (message.op === 'search') {
      const response = await checked(() => api.search(message.query, message.options || {}));
      results = response.results;
      results.sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
      resultEpoch++;
      return { results: results.map((result, index) => ({ id: result.id, score: result.score, dataKey: index })),
        resultEpoch, unfilteredResultCount: response.unfilteredResultCount,
        filters: response.filters, totalFilters: response.totalFilters, timings: response.timings };
    }
    if (message.op === 'data') {
      if (message.resultEpoch !== resultEpoch || !Number.isSafeInteger(message.dataKey) || !results[message.dataKey]) throw new Error('Search result is no longer active');
      return checked(() => results[message.dataKey].data());
    }
    if (message.op === 'stats') return { ...stats };
    throw new Error('Unknown search worker request');
  }
  return message => {
    if (!message || !Number.isSafeInteger(message.id)) return;
    const send = promise => promise.then(result => postMessage({ id: message.id, result }), error => postMessage({ id: message.id, error: error?.message || String(error) }));
    // Snippets may download together, through the same eight-request queue.
    // Query/init operations stay serial so one query never corrupts another.
    if (message.op === 'data' || message.op === 'stats') return send(perform(message));
    const pending = serial.then(() => perform(message));
    serial = pending.then(() => {}, () => {});
    return send(pending);
  };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  const handle = createSearchWorkerHandler({ postMessage: value => globalThis.postMessage(value) });
  globalThis.addEventListener('message', event => handle(event.data));
}
