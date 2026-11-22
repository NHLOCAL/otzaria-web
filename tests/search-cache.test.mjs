import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkpointIdentity, createReceipt} from '../src/search-checkpoint.mjs';
import {restoreSearchCache, storeSearchCache} from '../src/search-cache.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-search-cache-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const source = path.join(root, 'source');
  const files = {'pagefind.js': 'runtime', 'pagefind-worker.js': 'worker', 'pagefind-entry.json': JSON.stringify({version: '1.6.0', languages: {he: {page_count: 1}}}), 'index/he.pf_meta': 'meta', 'fragment/one.pagefind': 'full'};
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, name)), {recursive: true});
    await fs.writeFile(path.join(source, name), content);
  }
  const identity = key => checkpointIdentity({basePath: '/', indexerSource: 'indexer', pages: [{path: 'books/b-1/s-1.html', contentSha256: 'a'.repeat(64)}], key, cacheDir: path.join(root, 'cache')});
  return {root, source, identity};
}

test('cached output is portable and isolated from mutations to restored files', async t => {
  const {root, source, identity} = await fixture(t);
  const item = identity('a');
  const receipt = await createReceipt(item, source);
  assert.equal(await storeSearchCache(item, source, receipt, receipt.bytes * 2), true);
  const restored = path.join(root, 'restored');
  assert.deepEqual(await restoreSearchCache(item, restored), receipt);
  await fs.writeFile(path.join(restored, 'fragment/one.pagefind'), 'oops');
  assert.equal(await fs.readFile(path.join(item.bundle, 'fragment/one.pagefind'), 'utf8'), 'full');
  await fs.writeFile(path.join(item.bundle, 'fragment/one.pagefind'), 'oops');
  assert.equal(await restoreSearchCache(item, restored), null);
});

test('cache budget evicts older complete bundles and skips an individually oversized bundle', async t => {
  const {source, identity} = await fixture(t);
  const first = identity('a'), second = identity('b');
  const receipt = await createReceipt(first, source);
  assert.equal(await storeSearchCache(first, source, receipt, receipt.bytes - 1), false);
  await assert.rejects(fs.access(first.bundle), {code: 'ENOENT'});
  await storeSearchCache(first, source, receipt, receipt.bytes);
  await storeSearchCache(second, source, await createReceipt(second, source), receipt.bytes);
  await assert.rejects(fs.access(first.bundle), {code: 'ENOENT'});
  await assert.rejects(fs.access(first.file), {code: 'ENOENT'});
  await fs.access(second.bundle);
  await fs.access(second.file);
});
