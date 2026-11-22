import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticSearchClient, selectSearchShards, groupSearchShards } from '../public/search-client.mjs';

const prefix = '/library/pagefind/';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const makeShard = (id, categories = ['תנך']) => ({ bundlePath: `${prefix}${id}/`, categories, fingerprint: `hash-${id}` });
const result = (id, score = 1) => ({ id, score, data: async () => ({ url: `/library/books/${id}/s-1.html` }) });
const response = results => ({ results, unfilteredResultCount: results.length, filters: { category: { תנך: results.length } }, totalFilters: { category: { תנך: results.length } } });

function fixture(shards, { search = async ({ path }) => response([result(path)]), concurrency = 2, fetchManifest, ...extra } = {}) {
  const calls = { fetches: 0, imports: [], instances: [], merges: [], searches: [], warmups: [], destroyed: [] };
  const manifest = { schemaVersion: 1, engine: 'pagefind', version: '1.6.0', shards };
  const client = createStaticSearchClient({
    manifestUrl: '/library/search-manifest.json', bundlePrefix: prefix, origin: 'https://example.test', concurrency, groupSize: 1, workerFactory: null,
    fetchManifest: async () => { calls.fetches++; return fetchManifest ? fetchManifest() : { ok: true, json: async () => manifest }; },
    importPagefind: async url => {
      calls.imports.push(url);
      return { createInstance: options => {
        calls.instances.push(options);
        const paths = [options.basePath];
        return {
          mergeIndex: async (path, opts) => { paths.push(path); calls.merges.push({ path, opts }); },
          search: (query, opts) => {
            if (query === '') { calls.warmups.push(options.basePath); return Promise.resolve(response([])); }
            calls.searches.push({ path: options.basePath, query, opts, paths }); return search({ path: options.basePath, query, opts, paths });
          },
          destroy: async () => { calls.destroyed.push(options.basePath); },
        };
      } };
    }, ...extra,
  });
  return { client, calls, manifest };
}

test('an empty query does not fetch a manifest or initialize an index', async () => {
  const { client, calls } = fixture([makeShard('a')]);
  for (const query of ['', '   ', null]) assert.deepEqual((await client.search(query)).results, []);
  assert.equal(calls.fetches, 0);
  assert.deepEqual(calls.imports, []);
});

test('production default rejects unavailable Worker support without initializing the native fallback', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = undefined;
  const { client, calls } = fixture([makeShard('a')], { workerFactory: undefined });
  try {
    await assert.rejects(client.search('בראשית'), /requires Web Worker support/);
    assert.equal(calls.fetches, 1);
    assert.deepEqual(calls.imports, []);
    assert.deepEqual(calls.instances, []);
    assert.deepEqual(calls.searches, []);
  } finally {
    await client.destroy();
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  }
});

test('a stalled manifest download is aborted and permits retry', async () => {
  let attempts = 0;
  const client = createStaticSearchClient({
    manifestUrl: '/library/search-manifest.json', bundlePrefix: prefix, origin: 'https://example.test', manifestTimeoutMs: 10,
    fetchManifest: (url, { signal }) => {
      attempts++;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  await assert.rejects(client.search('בראשית'), /timed out/);
  await assert.rejects(client.search('בראשית'), /timed out/);
  assert.equal(attempts, 2);
  await client.destroy();
});

test('category and provider scopes select before index loading, preserving unknown manifests', async () => {
  const shards = [makeShard('first', ['משנה']), makeShard('second', ['תנך']), { bundlePath: `${prefix}legacy/` }];
  const { client, calls } = fixture(shards, { indexOptions: { highlightParam: 'highlight' } });
  const actual = await client.search('"בראשית ברא"', { filters: { category: 'תנך' } });
  assert.equal(actual.results.length, 2);
  assert.deepEqual(calls.instances.map(item => item.basePath), [`${prefix}second/`, `${prefix}legacy/`]);
  assert(calls.searches.every(item => item.opts.filters.category === 'תנך' && item.query === '"בראשית ברא"'));
  assert.equal(calls.instances[0].metaCacheTag, 'hash-second');
  assert.equal(calls.instances[0].highlightParam, 'highlight');
  assert.equal(calls.imports.length, 1);
  const external = [{ providers: ['otzar'] }, { providers: ['hebrewbooks'] }, {}];
  assert.deepEqual(selectSearchShards(external, { provider: 'hebrewbooks' }, 'provider', 'providers'), external.slice(1));
  assert.deepEqual(selectSearchShards(shards, { category: { any: ['תנך'] } }, 'category', 'categories'), shards);
});

test('fallback bounds independent shard instances and skips unrelated scopes', async () => {
  const shards = Array.from({ length: 12 }, (_, index) => makeShard(String(index), index < 8 ? ['תנך'] : ['משנה']));
  const groups = groupSearchShards(shards, 'categories', 4);
  assert.deepEqual(groups.map(group => group.shards.length), [4, 4, 4]);
  assert(groups.every(group => new Set(group.shards.flatMap(shard => shard.categories)).size === 1));
  const gate = deferred(), started = deferred();
  let activeShards = 0, peak = 0;
  const { client, calls } = fixture(shards, { groupSize: 4, concurrency: 2, search: async ({ paths }) => {
    activeShards += paths.length; peak = Math.max(peak, activeShards);
    if (activeShards === 8) started.resolve();
    await gate.promise;
    activeShards -= paths.length;
    return response(paths.map(path => result(path)));
  } });
  const pending = client.search('"בראשית"', { filters: { category: 'תנך' } });
  await started.promise;
  assert.equal(calls.instances.length, 8);
  assert.equal(calls.merges.length, 0);
  assert(calls.searches.every(call => call.paths.every(path => shards.slice(0, 8).some(shard => shard.bundlePath === path))));
  gate.resolve();
  assert.equal((await pending).results.length, 8);
  assert.equal((await client.search('"בראשית"')).results.length, 12);
  assert.equal(calls.instances.length, 12, 'Existing scope instances should be reused');
  assert.equal(peak, 8, 'No more than eight shard searches may be active by default');
});

test('global search visits all shards with bounded work and deterministic score ties', async () => {
  const shards = ['a', 'b', 'c', 'd'].map(id => makeShard(id));
  const gates = shards.map(() => deferred());
  const started = shards.map(() => deferred());
  let active = 0, peak = 0;
  const { client, calls } = fixture(shards, { search: async ({ path }) => {
    const index = shards.findIndex(shard => shard.bundlePath === path);
    active++; peak = Math.max(peak, active); started[index].resolve();
    await gates[index].promise;
    active--;
    return response([result(String(index), index === 2 ? 4 : 1)]);
  } });
  const pending = client.search('"בראשית"');
  await Promise.all([started[0].promise, started[1].promise]);
  assert.equal(calls.searches.length, 2);
  gates[1].resolve(); await started[2].promise;
  gates[2].resolve(); await started[3].promise;
  gates[3].resolve(); gates[0].resolve();
  const actual = await pending;
  assert.equal(peak, 2);
  assert.deepEqual(actual.results.map(item => item.id), ['c/2', 'a/0', 'b/1', 'd/3'].map(id => `${prefix}${id}`));
  assert(!Object.hasOwn(actual, 'unfilteredResultCount'));
  assert(!Object.hasOwn(actual, 'filters'), 'Native prefix counts must not describe whole-word membership');
  assert.equal(calls.imports.length, 1);
});

test('a superseding query stops queued shards and skips obsolete queued queries', async () => {
  const gate = deferred(), started = deferred();
  const shards = ['a', 'b', 'c'].map(id => makeShard(id));
  const { client, calls } = fixture(shards, { concurrency: 1, search: async ({ query, path }) => {
    if (query === '"old"') { started.resolve(); await gate.promise; }
    return response([result(`${query}:${path}`)]);
  } });
  const old = client.search('"old"');
  await started.promise;
  const skipped = client.search('"middle"');
  const latest = client.search('"latest"');
  gate.resolve();
  assert.equal(await old, null);
  assert.equal(await skipped, null);
  assert.equal((await latest).results.length, 3);
  assert.equal(calls.searches.filter(item => item.query === '"old"').length, 1);
  assert.equal(calls.searches.filter(item => item.query === '"middle"').length, 0);
});

test('cancel during debounce suppresses old results without starting more shards', async () => {
  const gate = deferred(), started = deferred();
  const { client, calls } = fixture([makeShard('a'), makeShard('b')], { concurrency: 1, search: async () => {
    started.resolve(); await gate.promise; return response([result('old')]);
  } });
  const pending = client.search('"old"');
  await started.promise; client.cancel(); gate.resolve();
  assert.equal(await pending, null);
  assert.equal(calls.searches.length, 1);
});

test('shard failure rejects complete search, drains active work, and retries a fresh instance', async () => {
  let fail = true;
  const { client, calls } = fixture([makeShard('a'), makeShard('b')], { concurrency: 1, search: async ({ path }) => {
    if (fail && path.endsWith('/b/')) throw new Error('metadata unavailable');
    return response([result(path)]);
  } });
  await assert.rejects(client.search('בראשית'), /metadata unavailable/);
  assert.deepEqual(calls.destroyed, [`${prefix}b/`]);
  fail = false;
  assert.equal((await client.search('בראשית')).results.length, 2);
  assert.equal(calls.instances.filter(item => item.basePath === `${prefix}b/`).length, 2);
  assert.equal(calls.instances.filter(item => item.basePath === `${prefix}a/`).length, 1);
  await client.destroy();
  assert.equal(calls.destroyed.length, 3);
});

test('failed searches await in-flight work and never start the remaining queue', async () => {
  const gate = deferred(), started = deferred(), failed = deferred();
  const { client, calls } = fixture(['a', 'b', 'c'].map(id => makeShard(id)), { search: async ({ path }) => {
    if (path.endsWith('/a/')) { started.resolve(); await gate.promise; return response([result('a')]); }
    await started.promise; failed.resolve(); throw new Error('failed shard');
  } });
  let settled = false;
  const pending = client.search('"query"');
  pending.then(() => { settled = true; }, () => { settled = true; });
  await failed.promise;
  assert.equal(settled, false);
  gate.resolve();
  await assert.rejects(pending, /failed shard/);
  assert.equal(calls.searches.length, 2);
});

test('whole-word intersections never conflate equal native IDs in different shards', async () => {
  const { client, calls } = fixture([makeShard('first'), makeShard('second')], { search: async ({ path, query }) => {
    const present = path.endsWith('/first/') ? '"בראשית"' : '"ברא"';
    return response(query === present ? [result('he_shared')] : []);
  } });
  const actual = await client.search('בראשית ברא');
  assert.deepEqual(actual.results, []);
  assert(calls.searches.every(item => item.query.startsWith('"')), 'An empty intersection needs no broad ranking query');
  await client.destroy();
});

test('failed manifest downloads can be retried', async () => {
  let fail = true;
  const { client, calls, manifest } = fixture([makeShard('a')], { fetchManifest: async () => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => manifest };
  } });
  await assert.rejects(client.search('בראשית'), /offline/);
  fail = false;
  assert.equal((await client.search('בראשית')).results.length, 1);
  assert.equal(calls.fetches, 2);
});

test('failed runtime imports can be retried', async () => {
  let imports = 0;
  const { client } = fixture([makeShard('a')], { importPagefind: async () => {
    if (++imports === 1) throw new Error('runtime offline');
    return { createInstance: () => ({ search: async () => response([result('a')]), destroy: async () => {} }) };
  } });
  await assert.rejects(client.search('query'), /runtime offline/);
  assert.equal((await client.search('query')).results.length, 1);
  assert.equal(imports, 2);
});

test('manifest rejects duplicate, remote, and out-of-root bundles before importing code', async () => {
  for (const bundlePath of ['https://evil.test/pagefind/', '/outside/pagefind/', `${prefix}a/?x=1`, `${prefix}a/#fragment`]) {
    const { client, calls } = fixture([{ bundlePath }]);
    await assert.rejects(client.search('בראשית'), /Invalid search bundle path/);
    assert.equal(calls.imports.length, 0);
  }
  const { client } = fixture([makeShard('a'), makeShard('a')]);
  await assert.rejects(client.search('בראשית'), /Invalid search bundle path/);
});

test('a matrix partition manifest cannot masquerade as the complete public search', async () => {
  const { client, calls, manifest } = fixture([makeShard('a')]);
  manifest.partial = true;
  await assert.rejects(client.search('בראשית'), /incomplete search manifest/);
  assert.equal(calls.imports.length, 0);
});
