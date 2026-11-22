import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as pagefind from 'pagefind';
import { createStaticSearchClient } from '../public/search-client.mjs';
import { createNodeSearchWorkerFactory } from '../scripts/search-worker-node.mjs';

async function writeFixture(directory, records, partitions) {
  const manifest = { engine: 'pagefind', version: '1.6.0', shards: [] };
  for (const [number, members] of partitions.entries()) {
    const bundlePath = `/pagefind/p-${number}/`;
    const { index, errors } = await pagefind.createIndex({ forceLanguage: 'he', keepIndexUrl: true });
    assert(index && !errors?.length);
    try {
      for (const member of members) {
        const record = records[member];
        const response = await index.addHTMLFile({ url: record.url, content: `<html lang="he"><body><article data-pagefind-body>${record.body}</article></body></html>` });
        assert(!response.errors?.length);
      }
      const response = await index.writeFiles({ outputPath: path.join(directory, bundlePath.slice(1)) });
      assert(!response.errors?.length);
    } finally { await index.deleteIndex(); }
    manifest.shards.push({ bundlePath, categories: ['בדיקה'], pages: members.length });
  }
  await fs.writeFile(path.join(directory, 'search-manifest.json'), JSON.stringify(manifest));
  return manifest;
}

function clientFor(directory, downloads, worker = true) {
  return createStaticSearchClient({
    manifestUrl: '/search-manifest.json', bundlePrefix: '/pagefind/', origin: 'https://fixture.invalid',
    indexOptions: { noWorker: true, highlightParam: 'highlight' },
    importPagefind: url => import(pathToFileURL(path.join(directory, url.slice(1))).href),
    workerFactory: worker ? createNodeSearchWorkerFactory({ directory, onFetch: request => downloads.push(request) }) : null,
  });
}
const pathsFor = async response => (await Promise.all(response.results.map(async result => new URL((await result.data()).url, 'https://fixture.invalid').pathname))).sort();

test('native whole-word membership survives repartitioning and prefix-chunk warmup', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-whole-words-'));
  const originalFetch = globalThis.fetch;
  let client;
  try {
    const records = [
      ['plain', 'בראשית ברא אלהים'], ['internal', 'בראש"ית ברא'],
      ['gap', 'בראשית דברים ברא'], ['reverse', 'ברא בראשית'],
      ['maqaf', 'בראשית־ברא אלהים'], ['hyphen', 'בראשית-ברא אלהים'],
      ['acronym', 'רמב"ם תורה'], ['prefix', 'בראשיתה של תורה'],
      ...['ברא', 'בראשית', 'בראשיתא', 'בראשיתב', 'בראשיתג'].map((word, number) => [`chunk-${number}`, Array(20010).fill(word).join(' ')]),
    ].map(([name, body]) => ({ url: `/books/${name}/s-1.html`, body }));
    const all = records.map((_, index) => index);
    const expected = ['plain', 'internal', 'gap', 'reverse', 'hyphen'].map(name => `/books/${name}/s-1.html`).sort();
    for (const [name, partitions] of [['one', [all]], ['two', [all.slice(0, 8), all.slice(8)]]]) {
      const output = path.join(directory, name);
      await writeFixture(output, records, partitions);
      let manifestRequests = 0;
      globalThis.fetch = async value => {
        const url = new URL(String(value), 'https://fixture.invalid');
        if (url.pathname === '/search-manifest.json') manifestRequests++;
        return new Response(await fs.readFile(path.join(output, url.pathname.slice(1))));
      };
      const downloads = [];
      client = clientFor(output, downloads);
      for (const empty of ['', '   ', '""', '---']) assert.deepEqual((await client.search(empty)).results, []);
      assert.equal(manifestRequests, 0);
      assert.equal(downloads.length, 0);
      const cold = await client.search('בראשית ברא');
      assert.deepEqual(await pathsFor(cold), expected, `${name}: reject prefix-only and one-word-only documents`);
      assert(!Object.hasOwn(cold, 'filters') && !Object.hasOwn(cold, 'unfilteredResultCount'));
      const details = await Promise.all(cold.results.map(result => result.data()));
      assert(details.every(item => item.excerpt.includes('<mark>')));
      assert(details.every(item => new URL(item.url, 'https://fixture.invalid').searchParams.getAll('highlight').join(' ') === 'בראשית ברא'), 'Native broad-query handles retain both highlight terms');
      assert.equal(downloads.filter(item => item.file.includes('/wasm.')).length, 1);
      assert(Math.max(...downloads.map(item => item.concurrency)) <= 8);
      await client.search('"בראשיתא"');
      assert.deepEqual(await pathsFor(await client.search('בראשית ברא')), expected, 'Unrelated loaded prefix chunks cannot change document membership');
      assert.deepEqual(await pathsFor(await client.search('"בראשית ברא"')), ['/books/internal/s-1.html', '/books/plain/s-1.html']);
      assert.deepEqual(await pathsFor(await client.search('"בראש"ית ברא"')), ['/books/internal/s-1.html', '/books/plain/s-1.html']);
      for (const query of ['רמב"ם', '"רמב"ם תורה"']) assert.deepEqual(await pathsFor(await client.search(query)), ['/books/acronym/s-1.html']);
      for (const query of ['"בראשית־ברא אלהים"', '"בראשית-ברא אלהים"']) assert.deepEqual(await pathsFor(await client.search(query)), ['/books/hyphen/s-1.html', '/books/maqaf/s-1.html']);
      await client.destroy();
      // Node's nonworker compatibility path must use the same per-index AND.
      client = clientFor(output, downloads, false);
      assert.deepEqual(await pathsFor(await client.search('בראשית ברא')), expected);
      await client.destroy();
    }
  } finally {
    await client?.destroy(); await pagefind.close(); globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('two actual native seven-hex fragment collisions cannot manufacture an AND match', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-id-collision-'));
  const originalFetch = globalThis.fetch;
  let client;
  try {
    // Exact source/URLs intentionally produce the same shortened SHA1 ID in
    // Pagefind 1.6.0. Neither document contains both requested words.
    const records = [
      { url: '/books/collision-a-8532.html', body: 'בראשית' },
      { url: '/books/collision-b-738.html', body: 'ברא' },
    ];
    await writeFixture(directory, records, [[0], [1]]);
    for (let number = 0; number < 2; number++) {
      const fragments = await fs.readdir(path.join(directory, `pagefind/p-${number}/fragment`));
      assert(fragments.includes('he_fb3efe5.pf_fragment'), 'Fixture must exercise a real native collision');
    }
    globalThis.fetch = async value => new Response(await fs.readFile(path.join(directory, new URL(String(value), 'https://fixture.invalid').pathname.slice(1))));
    for (const worker of [true, false]) {
      const downloads = [];
      client = clientFor(directory, downloads, worker);
      assert.deepEqual((await client.search('בראשית ברא')).results, []);
      const first = await client.search('"בראשית"');
      const firstId = first.results[0].id;
      assert.deepEqual(await pathsFor(first), [records[0].url]);
      const second = await client.search('"ברא"');
      assert.deepEqual(await pathsFor(second), [records[1].url]);
      assert.notEqual(firstId, second.results[0].id, 'Public handles must include index provenance');
      assert(firstId.endsWith('/he_fb3efe5') && second.results[0].id.endsWith('/he_fb3efe5'));
      if (worker) assert.equal(downloads.filter(item => item.file.includes('/wasm.')).length, 1);
      await client.destroy();
    }
  } finally {
    await client?.destroy(); await pagefind.close(); globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('native phrase relevance uses varied scores while retaining exact excerpts and locations', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-phrase-ranking-'));
  const originalFetch = globalThis.fetch;
  let client;
  let native;
  try {
    const records = [
      { url: '/books/short/s-1.html', body: 'בראשית ברא אלהים' },
      { url: '/books/long/s-1.html', body: `בראשית דברים ברא ${Array(200).fill('לימוד').join(' ')} בראשית ברא` },
      { url: '/books/gap/s-1.html', body: 'בראשית דברים ברא' },
    ];
    await writeFixture(directory, records, [[0, 1, 2]]);
    globalThis.fetch = async value => new Response(await fs.readFile(path.join(directory, new URL(String(value), 'https://fixture.invalid').pathname.slice(1))));
    const module = await import(pathToFileURL(path.join(directory, 'pagefind/p-0/pagefind.js')).href);
    native = module.createInstance({ basePath: '/pagefind/p-0/', baseUrl: '/', noWorker: true, highlightParam: 'highlight', excerptLength: 34 });
    await native.search('');
    const exact = await native.search('"בראשית ברא"');
    assert.equal(exact.results.length, 2);
    assert(exact.results.every(result => result.score === 1), 'Fixture must exercise the native constant phrase score');
    const original = new Map();
    for (const result of exact.results) {
      const data = await result.data();
      original.set(new URL(data.url, 'https://fixture.invalid').pathname, structuredClone(data));
    }
    const downloads = [];
    client = clientFor(directory, downloads);
    const ranked = await client.search('"בראשית ברא"');
    assert.equal(ranked.results.length, 2);
    assert(new Set(ranked.results.map(result => result.score)).size > 1, 'Phrase relevance must not be an all-score-one ID sort');
    assert(ranked.results[0].score > ranked.results[1].score);
    for (const result of ranked.results) {
      const data = await result.data();
      const expected = original.get(new URL(data.url, 'https://fixture.invalid').pathname);
      assert(expected, 'Ranking cannot introduce a nonphrase candidate');
      assert.deepEqual(data.locations, expected.locations);
      assert.deepEqual(data.weighted_locations, expected.weighted_locations);
      assert.equal(data.excerpt, expected.excerpt);
      assert.equal(data.url, expected.url);
    }
    assert.equal(downloads.filter(item => item.file.includes('/wasm.')).length, 1);
  } finally {
    await client?.destroy(); await native?.destroy(); await pagefind.close(); globalThis.fetch = originalFetch;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
