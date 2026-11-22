import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';
import { ROOT, getConfig } from '../src/config.mjs';

const htmlOnly = process.argv.includes('--html-only');
if (process.argv.slice(2).some(arg => arg !== '--html-only')) throw new Error('Unknown verification option');
const config = getConfig(), root = config.outputDir;
const failures = [], files = new Set(), htmlFiles = [];
let failureCount = 0, count = 0;
const started = performance.now();
function fail(message) { failureCount++; if (failures.length < 50) failures.push(message); }
async function inventory(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Static output must not contain symlinks');
    if (entry.isDirectory()) await inventory(file);
    else if (entry.isFile()) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      files.add(relative);
      if (relative.endsWith('.html')) htmlFiles.push(relative);
    } else throw new Error('Static output contains unsupported filesystem entries');
  }
}
await inventory(root);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'build-manifest.json'), 'utf8'));
if (manifest.partial) throw new Error('A partial build cannot pass publication verification');
if (!htmlOnly && manifest.search?.status !== 'ready') fail('Search index is not complete');
if (!htmlOnly && manifest.counts.externalRecords && manifest.externalSearch?.status !== 'ready') fail('External catalogue search index is not complete');
const catalogue = JSON.parse(await fs.readFile(path.join(root, 'catalog.json'), 'utf8'));
const cataloguePages = new Set(), catalogueIds = new Set();
let nextCatalogue = catalogue.firstPage;
while (nextCatalogue) {
  if (cataloguePages.has(nextCatalogue) || !nextCatalogue.startsWith(`${config.basePath}catalog/`)) throw new Error('Invalid public catalogue pagination');
  cataloguePages.add(nextCatalogue);
  const data = JSON.parse(await fs.readFile(path.join(root, nextCatalogue.slice(config.basePath.length)), 'utf8'));
  for (const book of data.books) {
    if (catalogueIds.has(book.id)) fail(`Duplicate public catalogue book: ${book.id}`);
    catalogueIds.add(book.id);
    if (['file', 'lineIdsFile', 'linksFile'].some(key => Object.hasOwn(book, key))) fail(`Public catalogue exposes unpublished snapshot paths: ${book.id}`);
    for (const key of ['url', 'textUrl', 'jsonUrl', 'linksUrl', 'pdfUrl', 'primaryUrl']) {
      if (book[key] && (!book[key].startsWith(config.basePath) || !files.has(book[key].slice(config.basePath.length)))) fail(`Broken public catalogue ${key}: ${book.id}`);
    }
  }
  nextCatalogue = data.next;
}
if (catalogueIds.size !== manifest.counts.books) fail('Public catalogue does not enumerate every book exactly once');
const concurrency = Number(process.env.VERIFY_CONCURRENCY || Math.min(4, os.availableParallelism()));
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('VERIFY_CONCURRENCY must be 1..8');
let cursor = 0, nextProgress = 25000;
const workers = [];
try {
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, htmlFiles.length)) }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./verify-worker.mjs', import.meta.url), { workerData: { root, origin: config.origin, basePath: config.basePath, files: [...files] } });
    workers.push(worker);
    let done = false;
    const send = () => {
      const batch = htmlFiles.slice(cursor, cursor + 128); cursor += batch.length;
      if (!batch.length) { done = true; resolve(); return; }
      worker.postMessage(batch);
    };
    worker.on('error', reject);
    worker.on('exit', code => { if (!done) reject(new Error(`HTML verifier stopped unexpectedly (${code})`)); });
    worker.on('message', message => {
      if (message.error) { reject(new Error(message.error)); return; }
      count += message.count; failureCount += message.failureCount;
      if (failures.length < 50) failures.push(...message.failures.slice(0, 50 - failures.length));
      if (count >= nextProgress) { console.log(`Verified structure and links in ${count} HTML documents`); nextProgress += 25000; }
      send();
    });
    send();
  })));
} finally { await Promise.all(workers.map(worker => worker.terminate())); }
if (count !== manifest.counts.htmlPages) fail('HTML count does not match build manifest');
const report = { schemaVersion: 1, status: failureCount ? 'failed' : 'passed', htmlOnly, documents: count, files: files.size, workers: workers.length, durationSeconds: (performance.now() - started) / 1000, failureCount, failures };
const reportPath = path.resolve(ROOT, process.env.VERIFY_REPORT || '.cache/verification.json');
await fs.mkdir(path.dirname(reportPath), { recursive: true });
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
if (failureCount) { console.error(failures.join('\n')); throw new Error(`${failureCount} static verification failure(s)`); }
console.log(`Verified ${count} HTML documents: Hebrew/RTL, canonical URLs, internal links, anchors, structured data, complete search bodies, and deployment base. ${workers.length} workers, ${report.durationSeconds.toFixed(2)}s.${htmlOnly ? ' HTML-only mode: search readiness must be checked separately.' : ''}`);
