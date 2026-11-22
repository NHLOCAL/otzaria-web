import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import * as pagefind from 'pagefind';
import { createStaticSearchClient } from '../public/search-client.mjs';
import { createNodeSearchWorkerFactory } from '../scripts/search-worker-node.mjs';

test('actual Pagefind worker preserves Hebrew phrases, all results, bounded downloads and scoped loading', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-static-search-'));
  const basePath = '/otzaria-web/';
  const manifest = { engine: 'pagefind', version: '1.6.0', shards: [] };
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  let client;
  try {
    for (let number = 0; number < 9; number++) {
      const category = number < 4 ? 'תנך' : number < 8 ? 'משנה' : 'הלכה';
      const body = number < 4 ? 'בְּרֵאשִׁית בָּרָא אלהים' : number < 8 ? 'ברא בראשית אלהים' : 'בראשית משהו ברא אלהים';
      const bundlePath = `${basePath}pagefind/shard-${number}/`;
      const { index, errors } = await pagefind.createIndex({ forceLanguage: 'he' });
      assert(!errors?.length && index);
      try {
        const added = await index.addHTMLFile({ url: `${basePath}books/b-${number}/s-1.html`, content: `<html lang="he"><body><article data-pagefind-body data-category="${category}" data-pagefind-filter="category[data-category]"><h1>ספר ${number}</h1><p>${body}</p></article></body></html>` });
        assert(!added.errors?.length);
        const written = await index.writeFiles({ outputPath: path.join(directory, bundlePath.slice(basePath.length)) });
        assert(!written.errors?.length);
      } finally { await index.deleteIndex(); }
      manifest.shards.push({ bundlePath, categories: [category], pages: 1, fingerprint: `fixture-${number}` });
    }
    await pagefind.close();
    await fs.writeFile(path.join(directory, 'search-manifest.json'), JSON.stringify(manifest));
    globalThis.document = { currentScript: null, querySelector: () => ({ getAttribute: () => 'he' }) };
    const requestedEntries = new Set();
    const downloaded = [];
    let failUrlPattern = '';
    let notifyFetch;
    globalThis.fetch = async value => {
      const url = new URL(String(value), 'https://fixture.invalid');
      assert.equal(url.origin, 'https://fixture.invalid');
      if (url.pathname.endsWith('/pagefind-entry.json')) requestedEntries.add(url.pathname);
      const content = await fs.readFile(path.join(directory, url.pathname.slice(basePath.length)));
      return new Response(content, { status: 200 });
    };
    client = createStaticSearchClient({
      manifestUrl: `${basePath}search-manifest.json`, bundlePrefix: `${basePath}pagefind/`, origin: 'https://fixture.invalid',
      indexOptions: { noWorker: true, highlightParam: 'highlight' },
      importPagefind: url => import(pathToFileURL(path.join(directory, url.slice(basePath.length))).href),
      workerFactory: createNodeSearchWorkerFactory({ directory, basePath, latencyMs: 2, failUrlPattern: () => failUrlPattern, onFetch: request => {
        downloaded.push(request);
        if (request.file.endsWith('/pagefind-entry.json')) requestedEntries.add(`${basePath}${request.file}`);
        notifyFetch?.(request);
      } }),
    });
    // Cold global initialization exercises independent index instances, real
    // metadata, token chunks and the shared WebAssembly runtime.
    const all = await client.search('בראשית ברא');
    assert.equal(all.results.length, 9);
    assert.equal(requestedEntries.size, 9);
    assert.equal(downloaded.filter(request => request.file.includes('/wasm.')).length, 1, 'All shards share one WASM download');
    assert(Math.max(...downloaded.map(request => request.concurrency)) <= 8, 'Downloads must respect the worker queue');
    const exact = await client.search('"בראשית ברא"');
    assert.equal(exact.results.length, 4, 'Phrase mode must reject reversed and separated words');
    const snippets = await Promise.all(exact.results.map(result => result.data()));
    assert(snippets.every(item => new URL(item.url, 'https://fixture.invalid').searchParams.has('highlight')));
    assert(snippets.every(item => new URL(item.url, 'https://fixture.invalid').pathname.startsWith(`${basePath}books/`)), 'Worker results preserve a project deployment path');
    const scope = await client.search('בראשית ברא', { filters: { category: 'משנה' } });
    assert.equal(scope.results.length, 4);
    await client.destroy();
    requestedEntries.clear();
    const coldScope = await client.search('"בראשית ברא"', { filters: { category: 'תנך' } });
    assert.equal(coldScope.results.length, 4);
    assert.deepEqual([...requestedEntries].sort(), manifest.shards.slice(0, 4).map(shard => `${shard.bundlePath}pagefind-entry.json`).sort());
    await client.destroy();
    failUrlPattern = '.pf_index';
    await assert.rejects(client.search('בראשית ברא'), /HTTP 503/, 'A failed term chunk must not silently become partial results');
    failUrlPattern = '';
    assert.equal((await client.search('בראשית ברא')).results.length, 9, 'A retry recreates the failed worker');
    const superseded = client.search('בראשית ברא', { filters: { category: 'משנה' } });
    client.cancel();
    const latest = client.search('בראשית ברא', { filters: { category: 'תנך' } });
    assert.equal(await superseded, null);
    assert.equal((await latest).results.length, 4);
    const expired = await client.search('בראשית ברא');
    client.cancel();
    await assert.rejects(expired.results[0].data(), /no longer active/);
    await client.destroy();
    failUrlPattern = '/fragment/';
    const failedFragment = await client.search('בראשית ברא');
    await assert.rejects(failedFragment.results[0].data(), /HTTP 503/);
    failUrlPattern = '';
    const retriedFragment = await client.search('בראשית ברא');
    assert((await retriedFragment.results[0].data()).url, 'A failed snippet must be retried in a fresh worker');
    await client.destroy();
    const indexDirectory = path.join(directory, 'pagefind/shard-0/index');
    const corruptFile = path.join(indexDirectory, (await fs.readdir(indexDirectory))[0]);
    const originalChunk = await fs.readFile(corruptFile);
    await fs.writeFile(corruptFile, 'HTTP 200 with corrupt Pagefind data');
    await assert.rejects(client.search('בראשית ברא'), /gzip|chunk/i, 'HTTP200 corrupt data must not become incomplete results');
    await fs.writeFile(corruptFile, originalChunk);
    assert.equal((await client.search('בראשית ברא')).results.length, 9);
    await client.destroy();
    const beganDownload = new Promise(resolve => { notifyFetch = resolve; });
    const activeSearch = client.search('בראשית ברא');
    await beganDownload;
    notifyFetch = null;
    client.cancel();
    const afterCancellation = client.search('בראשית ברא', { filters: { category: 'משנה' } });
    assert.equal(await activeSearch, null, 'An active worker is terminated when superseded');
    assert.equal((await afterCancellation).results.length, 4);
  } finally {
    await client?.destroy();
    await pagefind.close();
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
