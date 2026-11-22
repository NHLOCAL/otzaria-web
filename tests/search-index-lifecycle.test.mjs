import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {ROOT} from '../src/config.mjs';
import {digest} from '../src/search-checkpoint.mjs';

async function fixture(t) {
  const suffix = randomUUID();
  const outputName = 'dist-search-test-' + suffix;
  const output = path.join(ROOT, outputName);
  const cache = '.cache/search-test-' + suffix;
  const inputFile = '.cache/search-input-' + suffix + '.json';
  await fs.mkdir(path.dirname(path.join(ROOT, inputFile)), {recursive: true});
  const pages = [
    {path: 'books/b-1/s-1.html', bookId: 'b-1', category: 'תנ״ך', text: 'בראשית ברא אלהים'},
    {path: 'books/b-2/s-1.html', bookId: 'b-2', category: 'הלכה', text: 'שלום עולם של הלכה'},
  ];
  async function render() {
    await fs.rm(output, {recursive: true, force: true});
    await fs.mkdir(output, {recursive: true});
    for (const page of pages) {
      const html = '<html lang="he"><body><article data-pagefind-body data-category="' + page.category + '" data-pagefind-filter="category[data-category]"><h1 data-pagefind-meta="title">ספר</h1><p>' + page.text + '</p></article></body></html>';
      await fs.mkdir(path.dirname(path.join(output, page.path)), {recursive: true});
      await fs.writeFile(path.join(output, page.path), html);
      page.contentSha256 = digest(html);
      page.bytes = Buffer.byteLength(html);
    }
    await fs.writeFile(path.join(output, 'build-manifest.json'), JSON.stringify({builtAt: new Date().toISOString(), search: {status: 'pending'}}));
    await fs.writeFile(path.join(ROOT, inputFile), JSON.stringify({outputDir: output, basePath: '/', pages}));
  }
  t.after(async () => {
    await Promise.all([fs.rm(output, {recursive: true, force: true}), fs.rm(path.join(ROOT, cache), {recursive: true, force: true}), fs.rm(path.join(ROOT, inputFile), {force: true}), fs.rm(path.join(ROOT, '.cache/search-checkpoints', outputName), {recursive: true, force: true})]);
  });
  const run = (extra = {}) => spawnSync(process.execPath, ['scripts/index-search.mjs'], {cwd: ROOT, encoding: 'utf8', timeout: 120000, env: {...process.env, OUTPUT_DIR: outputName, BASE_PATH: '/', SEARCH_INPUT: inputFile, SEARCH_CACHE_DIR: cache, SEARCH_CONCURRENCY: '1', ...extra}});
  const manifest = () => fs.readFile(path.join(output, 'build-manifest.json'), 'utf8').then(JSON.parse);
  return {output, pages, render, run, manifest};
}

test('real Pagefind cold build, new-build reuse and single-category content invalidation', async t => {
  const f = await fixture(t);
  await f.render();
  let result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((await f.manifest()).search.builtShards, 2);
  await f.render();
  result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal((await f.manifest()).search.reusedShards, 2);
  f.pages[0].text = 'בראשית ברא שמים';
  await f.render();
  result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const search = (await f.manifest()).search;
  assert.equal(search.builtShards, 1);
  assert.equal(search.reusedShards, 1);
  await fs.access(path.join(f.output, 'pagefind/pagefind-highlight.js'));
});

test('batch interruption never exposes ready search, then verified progress resumes', async t => {
  const f = await fixture(t);
  await f.render();
  const first = f.run({SEARCH_BATCH_LIMIT: '1', SEARCH_CACHE: '0'});
  assert.equal(first.status, 2, first.stdout + first.stderr);
  assert.equal((await f.manifest()).search.status, 'pending');
  await assert.rejects(fs.access(path.join(f.output, 'search-manifest.json')), {code: 'ENOENT'});
  const resumed = f.run({SEARCH_RESUME: '1', SEARCH_CACHE: '0'});
  assert.equal(resumed.status, 0, resumed.stdout + resumed.stderr);
  const search = (await f.manifest()).search;
  assert.equal(search.status, 'ready');
  assert.equal(search.reusedShards, 1);
  assert.equal(search.builtShards, 1);
});
