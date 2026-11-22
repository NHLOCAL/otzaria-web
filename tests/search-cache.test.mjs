import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkpointIdentity, createReceipt} from '../src/search-checkpoint.mjs';
import {restoreSearchCache, storeSearchCache, pruneSearchCache} from '../src/search-cache.mjs';

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

test('a smaller restored-cache budget is enforced even when every shard is reused', async t => {
  const {root, source, identity} = await fixture(t);
  const first = identity('a'), second = identity('b');
  const receipt = await createReceipt(first, source);
  await storeSearchCache(first, source, receipt, 100_000);
  await storeSearchCache(second, source, await createReceipt(second, source), 100_000);
  const firstOutput = path.join(root, 'output-a'), secondOutput = path.join(root, 'output-b');
  await restoreSearchCache(first, firstOutput);
  await restoreSearchCache(second, secondOutput);
  await fs.utimes(first.file, 1, 1);
  const cap = receipt.bytes + (await fs.stat(second.file)).size;
  const result = await pruneSearchCache(path.dirname(first.file), cap);
  assert.equal(result.bytes, cap);
  assert.equal(result.removedEntries, 1);
  await assert.rejects(fs.access(first.bundle), {code: 'ENOENT'});
  assert.equal(await fs.readFile(path.join(firstOutput, 'fragment/one.pagefind'), 'utf8'), 'full');
  assert.equal(await fs.readFile(path.join(secondOutput, 'fragment/one.pagefind'), 'utf8'), 'full');
  assert.deepEqual(await pruneSearchCache(path.dirname(first.file), 0), {bytes: 0, removedEntries: 1});
  assert.equal(await fs.readFile(path.join(secondOutput, 'fragment/one.pagefind'), 'utf8'), 'full');
});

test('actual bytes, failed writes and an individually oversized replacement cannot bypass the cap', async t => {
  const {source, identity} = await fixture(t);
  const old = identity('old'), replacement = identity('new');
  const receipt = await createReceipt(old, source);
  await storeSearchCache(old, source, receipt, 100_000);
  await fs.writeFile(path.join(old.bundle, 'unexpected.pagefind'), 'extra bytes absent from the old receipt');
  assert.equal(await storeSearchCache(replacement, source, await createReceipt(replacement, source), 1), false);
  const incomplete = `${replacement.bundle}.tmp-123`;
  await fs.mkdir(incomplete);
  await fs.writeFile(path.join(incomplete, 'partial'), 'incomplete cache copy');
  const result = await pruneSearchCache(path.dirname(old.file), 0);
  assert.equal(result.bytes, 0);
  assert.equal(result.removedEntries, 2);
  assert.deepEqual(await fs.readdir(path.dirname(old.file)), []);
});

test('cache cleanup counts but preserves unrecognized files and rejects an impossible cap', async t => {
  const {root} = await fixture(t);
  const directory = path.join(root, 'cache');
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'keep.txt'), 'unrelated');
  await assert.rejects(pruneSearchCache(directory, 0), /unrecognized files/);
  assert.equal(await fs.readFile(path.join(directory, 'keep.txt'), 'utf8'), 'unrelated');
});
