import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {checkpointIdentity, readCheckpoint, writeCheckpoint} from '../src/search-checkpoint.mjs';

const pages = [
  {path: 'books/b-1/s-1.html', bookId: 'b-1', bytes: 220, category: 'תנ״ך', contentSha256: 'a'.repeat(64)},
  {path: 'books/b-1/s-2.html', bookId: 'b-1', bytes: 310, category: 'תנ״ך', contentSha256: 'b'.repeat(64)},
];

async function bundleFixture(directory, count = pages.length) {
  const files = {
    'pagefind.js': 'runtime',
    'pagefind-worker.js': 'worker',
    'pagefind-entry.json': JSON.stringify({version: '1.6.0', languages: {he: {page_count: count}}}),
    'index/he.pf_meta': 'metadata',
    'fragment/first.pagefind': 'first complete fragment',
    'fragment/second.pagefind': 'second complete fragment',
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), {recursive: true});
    await fs.writeFile(target, content);
  }
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-checkpoint-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const bundle = path.join(directory, 'dist', 'pagefind');
  await bundleFixture(bundle);
  const options = {
    outputDir: path.join(directory, 'dist'), basePath: '/library/',
    builtAt: '2026-11-22T11:00:00Z', indexerSource: 'indexer revision one',
    pages, key: '000', cacheDir: path.join(directory, 'receipts'),
  };
  return {directory, bundle, options, identity: checkpointIdentity(options)};
}

test('portable reuse ignores output directory and build time but requires actual content, URLs and indexer', async t => {
  const {bundle, options, identity} = await fixture(t);
  await writeCheckpoint(identity, bundle);
  assert.equal(await readCheckpoint(identity, bundle), true);
  const changes = [
    {basePath: '/other/'},
    {indexerSource: 'indexer revision two'},
    {pages: [pages[0], {...pages[1], path: 'books/b-1/s-3.html'}]},
    {pages: [pages[0], {...pages[1], contentSha256: 'c'.repeat(64)}]},
    {options: {maxFragments: 16}},
    {key: '001'},
  ];
  for (const change of changes) {
    assert.equal(await readCheckpoint(checkpointIdentity({...options, ...change}), bundle), false, JSON.stringify(change));
  }
  assert.equal(await readCheckpoint(identity, bundle), true);
  for (const change of [{outputDir: `${options.outputDir}-other`}, {builtAt: '2026-11-23T00:00:00Z'}, {pages: [...pages].reverse()}]) {
    assert.equal(await readCheckpoint(checkpointIdentity({...options, ...change}), bundle), true);
  }
});

test('a missing, truncated or renamed bundle file and an altered entry invalidate a receipt', async t => {
  const changes = {
    missing: bundle => fs.rm(path.join(bundle, 'fragment/second.pagefind')),
    truncated: bundle => fs.truncate(path.join(bundle, 'fragment/first.pagefind'), 4),
    sameLengthCorruption: bundle => fs.writeFile(path.join(bundle, 'fragment/first.pagefind'), 'first CORRUPT! fragment'),
    renamed: bundle => fs.rename(path.join(bundle, 'fragment/first.pagefind'), path.join(bundle, 'fragment/replaced.pagefind')),
    entry: bundle => fs.writeFile(path.join(bundle, 'pagefind-entry.json'), JSON.stringify({version: '1.6.0', languages: {he: {page_count: pages.length, extra: true}}})),
  };
  for (const [name, change] of Object.entries(changes)) {
    await t.test(name, async t => {
      const {bundle, identity} = await fixture(t);
      await writeCheckpoint(identity, bundle);
      await change(bundle);
      assert.equal(await readCheckpoint(identity, bundle), false);
    });
  }
});

test('an incomplete page count cannot be recorded or reused as a completed index', async t => {
  const {bundle, identity} = await fixture(t);
  await bundleFixture(bundle, pages.length - 1);
  await assert.rejects(writeCheckpoint(identity, bundle), /does not contain every requested page/);
  await assert.rejects(fs.stat(identity.file), {code: 'ENOENT'});
  assert.equal(await readCheckpoint(identity, bundle), false);
  await bundleFixture(bundle);
  await writeCheckpoint(identity, bundle);
  await bundleFixture(bundle, pages.length - 1);
  assert.equal(await readCheckpoint(identity, bundle), false);
});

test('nested independent shards do not invalidate the primary bundle, but retain their own checks', async t => {
  const {bundle, options, identity} = await fixture(t);
  await writeCheckpoint(identity, bundle);
  const nestedBundle = path.join(bundle, 'shard-001');
  await bundleFixture(nestedBundle);
  const nestedIdentity = checkpointIdentity({...options, key: '001'});
  await writeCheckpoint(nestedIdentity, nestedBundle);
  assert.equal(await readCheckpoint(identity, bundle), true);
  assert.equal(await readCheckpoint(nestedIdentity, nestedBundle), true);
  await fs.truncate(path.join(nestedBundle, 'fragment/first.pagefind'), 2);
  assert.equal(await readCheckpoint(identity, bundle), true);
  assert.equal(await readCheckpoint(nestedIdentity, nestedBundle), false);
  await fs.rm(nestedBundle, {recursive: true});
  assert.equal(await readCheckpoint(identity, bundle), true);
  await fs.truncate(path.join(bundle, 'fragment/first.pagefind'), 2);
  assert.equal(await readCheckpoint(identity, bundle), false);
});
