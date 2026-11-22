import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/config.mjs';

async function fixture({ outsideDist = false } = {}) {
  const parent = outsideDist ? path.join(ROOT, '.cache') : ROOT;
  await fs.mkdir(parent, { recursive: true });
  const output = await fs.mkdtemp(path.join(parent, outsideDist ? 'external-index-guard-' : 'dist-external-index-'));
  const cache = await fs.mkdtemp(path.join(ROOT, '.cache/external-index-input-'));
  await fs.mkdir(path.join(output, 'external/pagefind'), { recursive: true });
  await fs.mkdir(path.join(output, 'pagefind'), { recursive: true });
  await fs.writeFile(path.join(output, 'external/pagefind/stale.txt'), 'old external index');
  await fs.writeFile(path.join(output, 'pagefind/core.txt'), 'preserved core index');
  await fs.writeFile(path.join(output, 'external/records.json'), JSON.stringify({ records: [] }));
  const manifest = { schemaVersion: 1, basePath: '/', search: { status: 'ready', pages: 99 }, externalSearch: { status: 'ready', records: 1 } };
  await fs.writeFile(path.join(output, 'build-manifest.json'), JSON.stringify(manifest));
  const input = { outputDir: output, basePath: '/', records: 1, pages: [{ path: 'external/records.json', records: 1, provider: 'otzar', providerName: 'אוצר החכמה' }] };
  const inputFile = path.join(cache, 'input.json');
  await fs.writeFile(inputFile, JSON.stringify(input));
  return { output, cache, manifest, input, inputFile, async dispose() { await fs.rm(output, { recursive: true, force: true }); await fs.rm(cache, { recursive: true, force: true }); } };
}

function run(value) {
  return spawnSync(process.execPath, ['scripts/index-external-search.mjs'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, OUTPUT_DIR: value.output, BASE_PATH: '/', EXTERNAL_SEARCH_INPUT: value.inputFile } });
}

test('failed external index rebuild stays pending and preserves catalogue data and core search', async () => {
  const value = await fixture();
  try {
    const result = run(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /External catalogue search count mismatch/);
    const manifest = JSON.parse(await fs.readFile(path.join(value.output, 'build-manifest.json'), 'utf8'));
    assert.equal(manifest.externalSearch.status, 'pending');
    assert.deepEqual(manifest.search, value.manifest.search);
    await assert.rejects(fs.access(path.join(value.output, 'external/pagefind/stale.txt')), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(value.output, 'pagefind/core.txt'), 'utf8'), 'preserved core index');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(value.output, 'external/records.json'), 'utf8')), { records: [] });
  } finally { await value.dispose(); }
});

test('external index cleanup refuses a non-dist output before changing existing files', async () => {
  const value = await fixture({ outsideDist: true });
  try {
    const result = run(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dedicated dist directory/);
    assert.equal(await fs.readFile(path.join(value.output, 'external/pagefind/stale.txt'), 'utf8'), 'old external index');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(value.output, 'build-manifest.json'), 'utf8')), value.manifest);
  } finally { await value.dispose(); }
});

test('external index cleanup refuses mismatched input before changing existing files', async () => {
  const value = await fixture();
  try {
    await fs.writeFile(value.inputFile, JSON.stringify({ ...value.input, outputDir: `${value.output}-different` }));
    const result = run(value);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /different output directory/);
    assert.equal(await fs.readFile(path.join(value.output, 'external/pagefind/stale.txt'), 'utf8'), 'old external index');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(value.output, 'build-manifest.json'), 'utf8')), value.manifest);
  } finally { await value.dispose(); }
});
