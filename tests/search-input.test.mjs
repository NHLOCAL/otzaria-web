import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fingerprintSearchPages, pathInside} from '../src/search-input.mjs';
import {digest} from '../src/search-checkpoint.mjs';

test('book containers are fingerprinted from actual content and stale same-length changes fail', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-search-input-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const record = {path: 'books/b-1/s-1.html', content: '<p>שלום</p>'};
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify([record]));
  const pages = [{path: record.path, recordFile: 'book.json', contentSha256: digest(record.content), bytes: 1}];
  const actual = await fingerprintSearchPages(pages, {root, outputDir: path.join(root, 'dist')});
  assert.equal(actual[0].bytes, Buffer.byteLength(record.content));
  assert.equal(actual[0].contentSha256, pages[0].contentSha256);
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify([{...record, content: '<p>עולם</p>'}]));
  await assert.rejects(fingerprintSearchPages(pages, {root, outputDir: path.join(root, 'dist')}), /checksum mismatch/);
});

test('missing, duplicate and escaping search inputs are rejected', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-search-input-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  assert.throws(() => pathInside(root, '../outside.json'), /escapes/);
  assert.throws(() => pathInside(root, '/absolute.json'), /Unsafe/);
  await fs.writeFile(path.join(root, 'book.json'), JSON.stringify([{path: 'same', content: ''}, {path: 'same', content: ''}]));
  await assert.rejects(fingerprintSearchPages([{path: 'same', recordFile: 'book.json'}], {root, outputDir: root}), /duplicate search record/);
  await fs.writeFile(path.join(root, 'book.json'), '[]');
  await assert.rejects(fingerprintSearchPages([{path: 'missing', recordFile: 'book.json'}], {root, outputDir: root}), /Missing search record/);
});
