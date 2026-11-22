import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {checkpointIdentity, createReceipt, digest} from '../src/search-checkpoint.mjs';
import {searchCoverage} from '../src/search-input.mjs';
import {validateSearchParts} from '../src/search-parts.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-search-parts-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const pages = [0, 1].map(index => ({path: 'books/b-' + index + '/s-1.html', contentSha256: String(index).repeat(64), category: 'תנ״ך'}));
  const partitionFingerprints = [digest('first inputs'), digest('second inputs')];
  const parts = [];
  for (let index = 0; index < 2; index++) {
    const name = 'pagefind/shard-p-' + String(index).padStart(3, '0') + '-fixture';
    const bundle = path.join(root, name);
    const files = {'pagefind.js': 'runtime', 'pagefind-worker.js': 'worker', 'pagefind-entry.json': JSON.stringify({version: '1.6.0', languages: {he: {page_count: 1}}}), 'index/he.pf_meta': 'meta', 'fragment/one.pagefind': 'full'};
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(bundle, file)), {recursive: true});
      await fs.writeFile(path.join(bundle, file), content);
    }
    const identity = checkpointIdentity({basePath: '/', indexerSource: 'code', pages: [pages[index]], key: 'p-' + index, cacheDir: path.join(root, 'cache')});
    const coverage = searchCoverage([pages[index]]);
    const shard = {name, pages: 1, bodyBytes: 64, categories: ['תנ״ך'], fingerprint: identity.fingerprint, coverage, receipt: await createReceipt(identity, bundle)};
    parts.push({schemaVersion: 1, partition: {index, total: 2}, basePath: '/', sourceFingerprint: digest('old global source'), inputFingerprint: partitionFingerprints[index], configFingerprint: 'config', coverageSha256: digest(JSON.stringify(coverage)), pages: coverage, shards: [shard]});
  }
  return {parts, options: {partitionCount: 2, partitionFingerprints, basePath: '/', configFingerprint: 'config', pages, outputDir: root}};
}

test('independent partitions combine only when every page and content hash is covered exactly once', async t => {
  const {parts, options} = await fixture(t);
  assert.equal((await validateSearchParts(parts, options)).length, 2);
  await assert.rejects(validateSearchParts(parts.slice(0, 1), options), /Missing or extra/);
  await assert.rejects(validateSearchParts([parts[0], parts[0]], options), /duplicate search partition/);
  await assert.rejects(validateSearchParts(parts, {...options, basePath: '/wrong/'}), /different source or index/);
  await assert.rejects(validateSearchParts(parts, {...options, configFingerprint: 'wrong-code'}), /different source or index/);
  await assert.rejects(validateSearchParts(parts, {...options, pages: [options.pages[0]]}), /exactly the current reading pages/);
  await assert.rejects(validateSearchParts(parts, {...options, pages: [options.pages[0], {...options.pages[1], contentSha256: 'c'.repeat(64)}]}), /exactly the current reading pages/);
});

test('unchanged cached partition can combine with a newer global source but changed partition inputs cannot', async t => {
  const {parts, options} = await fixture(t);
  parts[1].sourceFingerprint = digest('new global source');
  assert.equal((await validateSearchParts(parts, options)).length, 2);
  await assert.rejects(validateSearchParts(parts, {...options, partitionFingerprints: [options.partitionFingerprints[0], digest('changed second inputs')]}), /different source or index/);
});

test('matching counts do not hide wrong shard coverage or same-length corrupt index data', async t => {
  const {parts, options} = await fixture(t);
  const altered = structuredClone(parts);
  altered[1].shards[0].coverage = altered[1].shards[0].coverage.map(page => ({...page, contentSha256: 'f'.repeat(64)}));
  await assert.rejects(validateSearchParts(altered, options), /Incomplete or corrupt/);
  await fs.writeFile(path.join(options.outputDir, parts[0].shards[0].name, 'fragment/one.pagefind'), 'oops');
  await assert.rejects(validateSearchParts(parts, options), /Incomplete or corrupt/);
});

test('an empty partition is valid only as one member of a complete nonempty matrix', async t => {
  const {parts, options} = await fixture(t);
  parts[1] = {...parts[1], pages: [], coverageSha256: digest('[]'), shards: []};
  assert.equal((await validateSearchParts(parts, {...options, pages: [options.pages[0]]})).length, 1);
});

test('a partition exceeding the JavaScript argument limit finalizes without expanding its page array', async t => {
  const {parts, options} = await fixture(t);
  const pages = Array.from({length: 160000}, (_, index) => ({path: 'books/b-0/s-' + index + '.html', contentSha256: '0'.repeat(64)}));
  const coverage = searchCoverage(pages);
  const part = parts[0], shard = part.shards[0];
  part.pages = coverage; part.coverageSha256 = digest(JSON.stringify(coverage));
  shard.coverage = coverage; shard.pages = pages.length;
  const bundle = path.join(options.outputDir, shard.name);
  await fs.writeFile(path.join(bundle, 'pagefind-entry.json'), JSON.stringify({version: '1.6.0', languages: {he: {page_count: pages.length}}}));
  const identity = checkpointIdentity({basePath: '/', indexerSource: 'code', pages, key: 'large', cacheDir: path.join(options.outputDir, 'cache')});
  shard.fingerprint = identity.fingerprint; shard.receipt = await createReceipt(identity, bundle);
  assert.equal((await validateSearchParts(parts, {...options, pages: pages.concat(options.pages[1])})).length, 2);
});
