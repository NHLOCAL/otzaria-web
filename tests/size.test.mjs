import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measureOutput, validateBudget } from '../scripts/check-size.mjs';

const small = { files: 10, totalBytes: 1000, maxFileBytes: 300, htmlFiles: 3, maxHtmlBytes: 300 };

test('GitHub rejects the complete output above 1 GB, accepting the boundary', () => {
  assert.equal(validateBudget({ ...small, totalBytes: 1_000_000_000 }, { target: 'github-pages' }).ok, true);
  assert.equal(validateBudget({ ...small, totalBytes: 1_000_000_001 }, { target: 'github-pages' }).ok, false);
});

test('Cloudflare budgets include generated fragments and all other files', () => {
  assert.equal(validateBudget({ ...small, files: 20_000 }, { target: 'cloudflare-pages' }).ok, true);
  assert.equal(validateBudget({ ...small, files: 20_001 }, { target: 'cloudflare-pages' }).ok, false);
  assert.equal(validateBudget({ ...small, files: 20_001 }, { target: 'cloudflare-pages', cloudflareFileLimit: 100_000 }).ok, true);
  assert.equal(validateBudget({ ...small, maxFileBytes: 25 * 1024 * 1024 + 1 }, { target: 'cloudflare-pages' }).ok, false);
});

test('unrestricted hosting still enforces readable HTML size and valid output', () => {
  assert.equal(validateBudget({ ...small, files: 1_000_000, totalBytes: 50_000_000_000 }, { target: 'cloudflare-r2' }).ok, true);
  assert.equal(validateBudget({ ...small, totalBytes: 3_000_000_000 }, { target: 'unrestricted' }).ok, true);
  assert.equal(validateBudget({ ...small, maxHtmlBytes: 1_000_001 }, { target: 'unrestricted' }).ok, false);
  assert.equal(validateBudget({ ...small, files: 0, htmlFiles: 0 }).ok, false);
});

test('unknown targets and invalid budgets fail closed', () => {
  assert.throws(() => validateBudget(small, { target: 'github-page' }), /Unknown/);
  assert.throws(() => validateBudget(small, { cloudflareFileLimit: 1_000_000 }), /CF_PAGES_FILE_LIMIT/);
  assert.throws(() => validateBudget(small, { maxHtmlBytes: 2_000_000 }), /MAX_HTML_BYTES/);
});

test('measurement counts UTF-8 bytes and nested files, rather than character lengths', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'otzaria-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'books'));
  await writeFile(join(dir, 'index.html'), 'שלום');
  await writeFile(join(dir, 'books', 'one.txt'), 'abc');
  const stats = await measureOutput(dir);
  assert.equal(stats.files, 2);
  assert.equal(stats.totalBytes, Buffer.byteLength('שלום') + 3);
  assert.equal(stats.htmlFiles, 1);
  assert.equal(stats.maxHtmlBytes, Buffer.byteLength('שלום'));
  assert.equal(stats.largestFiles[0].path, 'index.html');
});

test('measurement rejects symbolic links before packaging a deployment', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'otzaria-size-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'index.html'), '<h1>Book</h1>');
  await symlink(join(dir, 'index.html'), join(dir, 'copy.html'));
  await assert.rejects(measureOutput(dir), /symlinks/);
});
