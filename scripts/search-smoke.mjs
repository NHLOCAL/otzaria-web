/**
 * Exercise the actual generated Pagefind JS + WebAssembly with file-backed
 * fetch. No browser, HTTP listener, or outbound network is used.
 *
 * node scripts/search-smoke.mjs [--directory dist] [--mode lazy|eager]
 *   [--merge-concurrency 4] [--query "בראשית ברא"] [--latency-ms 0]
 *
 * Byte counts describe the generated response bodies (Pagefind already uses
 * gzip internally), not an estimate of HTML/CSS transfers or CDN billing.
 * A nonzero latency is an explicitly labelled synthetic per-request delay.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { parse } from 'parse5';
import { ROOT } from '../src/config.mjs';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert(process.argv[index].startsWith('--') && process.argv[index + 1], 'Options require explicit values');
  args.set(process.argv[index], process.argv[index + 1]);
}
const directory = path.resolve(ROOT, args.get('--directory') || process.env.OUTPUT_DIR || 'dist');
const mode = args.get('--mode') || 'lazy';
assert(['eager', 'lazy'].includes(mode), 'mode must be eager or lazy');
const concurrency = Number(args.get('--merge-concurrency') || 4);
const latencyMs = Number(args.get('--latency-ms') || 0);
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16, 'Merge concurrency must be 1..16');
assert(Number.isFinite(latencyMs) && latencyMs >= 0 && latencyMs <= 1000, 'Latency must be 0..1000 ms');
const query = args.get('--query') || 'בראשית ברא';
const normalize = text => String(text || '').normalize('NFKD').replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '').replace(/\s+/g, ' ').trim();
const manifest = JSON.parse(await fs.readFile(path.join(directory, 'search-manifest.json'), 'utf8'));
const build = JSON.parse(await fs.readFile(path.join(directory, 'build-manifest.json'), 'utf8'));
assert(Array.isArray(manifest.shards) && manifest.shards.length, 'No search shards');
const basePath = build.basePath;
const requests = [];
let phase = 'initialization';
let activeFetches = 0;
let peakFetches = 0;
const report = { startedAt: new Date().toISOString(), directory, mode, concurrency, latencyMs, noNetwork: true, engine: manifest.engine, engineVersion: manifest.version, pages: manifest.pages, shards: manifest.shards.length, phases: [], checks: [], fetched: [] };
const outputDir = path.join(ROOT, '.cache/search-results');
await fs.mkdir(outputDir, { recursive: true });

function fileFor(value) {
  const raw = value instanceof Request ? value.url : String(value);
  let file;
  if (raw.startsWith('file:')) file = fileURLToPath(new URL(raw));
  else {
    const url = new URL(raw, 'https://local-static.invalid');
    assert.equal(url.origin, 'https://local-static.invalid', `Outbound URL forbidden in file-backed test: ${url.origin}`);
    assert(url.pathname.startsWith(basePath), `Fetch has wrong base: ${url.pathname}`);
    file = path.resolve(directory, decodeURIComponent(url.pathname.slice(basePath.length)));
  }
  assert(file.startsWith(`${directory}${path.sep}`), `Fetch escapes build directory: ${file}`);
  return file;
}

const originalFetch = globalThis.fetch;
const originalDocument = globalThis.document;
globalThis.document = { currentScript: null, querySelector: selector => selector === 'html' ? { getAttribute: attribute => attribute === 'lang' ? 'he' : null } : null };
globalThis.fetch = async value => {
  const file = fileFor(value);
  activeFetches++; peakFetches = Math.max(peakFetches, activeFetches);
  const start = performance.now();
  try {
    if (latencyMs) await delay(latencyMs);
    const data = await fs.readFile(file);
    requests.push({ phase, file: path.relative(directory, file), bytes: data.length, milliseconds: Number((performance.now() - start).toFixed(2)) });
    return new Response(data, { status: 200, headers: { 'content-type': file.endsWith('.json') ? 'application/json' : 'application/octet-stream' } });
  } finally { activeFetches--; }
};

let api;
let failure;
async function measure(name, action) {
  phase = name;
  const start = performance.now();
  const requestStart = requests.length;
  const result = await action();
  const fetched = requests.slice(requestStart);
  report.phases.push({ name, milliseconds: Number((performance.now() - start).toFixed(2)), requests: fetched.length, bytes: fetched.reduce((sum, request) => sum + request.bytes, 0), rssBytes: process.memoryUsage().rss, ...(result?.metrics ? result.metrics : {}) });
  return result;
}

function sourceText(node) {
  if (node.attrs?.some(attribute => attribute.name === 'data-pagefind-ignore')) return '';
  if (node.nodeName === '#text') return node.value;
  if (node.tagName === 'br') return ' ';
  return (node.childNodes || []).map(sourceText).join('');
}

function readingParagraphs(html) {
  const pending = [parse(html)];
  while (pending.length) {
    const node = pending.pop();
    if (node.attrs?.some(attribute => attribute.name === 'id' && attribute.value === 'reading-text')) {
      return (node.childNodes || []).filter(child => child.tagName === 'p').map(sourceText);
    }
    pending.push(...(node.childNodes || []));
  }
  throw new Error('Known source has no reading-text region');
}

function knownSourceRanks(response, sources) {
  const positions = new Map(response.results.map((item, index) => [item.id, index]));
  return sources.map(source => {
    const position = positions.get(source.fragmentId);
    return { bookId: source.bookId, url: source.url, title: source.title, containsPhrase: source.containsPhrase, rank: position === undefined ? null : position + 1, score: position === undefined ? null : response.results[position].score };
  });
}

async function discoverGenesisSources(genesis) {
  const sources = [];
  const probes = new Map();
  for (const bookId of [genesis.id, ...(genesis.editions || []).map(edition => edition.id)]) {
    const book = bookId === genesis.id ? genesis : JSON.parse(await fs.readFile(path.join(directory, 'books', bookId, 'book.json'), 'utf8'));
    const section = book.sections?.[0];
    assert(section?.url, `Known source has no first section: ${bookId}`);
    const url = new URL(section.url, 'https://local-static.invalid');
    assert(url.pathname.startsWith(`${basePath}books/${bookId}/`), 'Known source URL has an unexpected base');
    const paragraphs = readingParagraphs(await fs.readFile(fileFor(section.url), 'utf8'));
    assert(paragraphs.length, `Known source needs a reading paragraph: ${bookId}`);
    // A six-word source phrase identifies the passage independently of broad
    // query ranking. Stay within one paragraph: Pagefind adds punctuation at
    // paragraph boundaries, and a longer probe fetches unnecessary term chunks.
    const passage = normalize(paragraphs[0]).split(/\s+/).slice(0, 6).join(' ');
    assert(passage.split(/\s+/).length === 6, `Known source needs a six-word passage: ${bookId}`);
    const probe = `"${passage}"`;
    const source = { bookId, url: url.pathname, title: book.title, containsPhrase: normalize(paragraphs[0]).includes(query), probe };
    sources.push(source);
    if (!probes.has(probe)) probes.set(probe, []);
    probes.get(probe).push(source);
  }
  report.sourceProbes = [];
  for (const [probe, expected] of probes) {
    const found = await measure(`known-source-probe-${report.sourceProbes.length + 1}`, async () => {
      const response = await api.search(probe);
      const data = [];
      // Inspect the complete targeted result set in bounded batches. No rank
      // threshold decides whether a known source is considered indexed.
      for (let start = 0; start < response.results.length; start += 16) {
        const batch = response.results.slice(start, start + 16);
        data.push(...await Promise.all(batch.map(async item => ({ id: item.id, data: await item.data() }))));
      }
      for (const source of expected) {
        const match = data.find(item => new URL(item.data.url, 'https://local-static.invalid').pathname === source.url);
        assert(match, `Source-derived phrase did not retrieve ${source.url}`);
        assert(normalize(match.data.raw_content || match.data.content).includes(normalize(source.probe.slice(1, -1))), `Retrieved source lacks its probe passage: ${source.url}`);
        source.fragmentId = match.id;
      }
      return { metrics: { query: probe, results: response.results.length, expectedSources: expected.length } };
    });
    report.sourceProbes.push({ ...found.metrics, sources: expected.map(({ bookId, url, fragmentId }) => ({ bookId, url, fragmentId })) });
  }
  assert(sources.some(source => source.containsPhrase), 'No source chapter contains the expected opening phrase');
  report.checks.push({ name: 'known-source-retrieval-from-public-paragraphs', passed: true });
  return sources;
}

try {
  const bundlePaths = manifest.shards.map(shard => {
    assert(shard.bundlePath.startsWith(basePath), `Bundle is outside base path: ${shard.bundlePath}`);
    const relative = shard.bundlePath.slice(basePath.length);
    const directoryPath = path.resolve(directory, relative);
    assert(directoryPath.startsWith(`${directory}${path.sep}`), 'Bundle escapes output directory');
    return `${pathToFileURL(directoryPath).href}/`;
  });
  const modulePath = new URL('pagefind.js', bundlePaths[0]);
  const moduleBytes = (await fs.stat(fileURLToPath(modulePath))).size;
  const workerBytes = (await fs.stat(fileURLToPath(new URL('pagefind-worker.js', bundlePaths[0])))).size;
  report.scriptBytes = { primaryModule: moduleBytes, browserWorker: workerBytes, note: 'Node imports the module directly. Browser transfer additionally includes these scripts.' };

  await measure('initialize-and-merge', async () => {
    api = await import(modulePath.href);
    await api.options({ baseUrl: '/', basePath: bundlePaths[0], language: 'he', noWorker: true, excerptLength: 34, highlightParam: 'highlight', metaCacheTag: build.builtAt });
    // Empty search waits for metadata/WebAssembly without fetching term chunks.
    await api.search('');
    for (let start = 1; start < bundlePaths.length; start += concurrency) {
      await Promise.all(bundlePaths.slice(start, start + concurrency).map(bundle => api.mergeIndex(bundle, { baseUrl: '/', language: 'he', highlightParam: 'highlight', metaCacheTag: build.builtAt })));
    }
  });

  let filters;
  if (mode === 'eager') {
    await measure('prefetch-all-filters', async () => {
      filters = await api.filters();
      return { metrics: { categoryValues: Object.keys(filters.category || {}).length } };
    });
  }

  const first = await measure('first-query', async () => {
    const result = await api.search(query);
    return { result, metrics: { query, results: result.results.length } };
  });
  const fragments = await measure('first-15-result-snippets', async () => {
    const data = await Promise.all(first.result.results.slice(0, 15).map(result => result.data()));
    return { data, metrics: { snippets: data.length } };
  });
  assert(first.result.results.length > 0, `No results for ${query}`);
  const paths = fragments.data.map(result => {
    const url = new URL(result.url, 'https://local-static.invalid');
    assert.equal(url.origin, 'https://local-static.invalid');
    assert(url.pathname.startsWith(`${basePath}books/`), `Incorrect result base path: ${url.pathname}`);
    assert(url.pathname.endsWith('.html'));
    assert(url.searchParams.has('highlight'), 'Missing reader highlighting parameter');
    assert(result.meta?.book && result.meta?.section, 'Book or section metadata missing');
    return url.pathname;
  });
  report.checks.push({ name: 'results-paths-metadata-highlights', passed: true });
  report.firstResults = fragments.data.map((result, index) => ({ rank: index + 1, score: first.result.results[index].score, url: result.url, title: result.meta.title, book: result.meta.book, section: result.meta.section, excerpt: result.plain_excerpt }));

  if (query === 'בראשית ברא') {
    const genesis = JSON.parse(await fs.readFile(path.join(directory, 'books/b-1/book.json'), 'utf8'));
    const sources = await discoverGenesisSources(genesis);
    const assertSourceCoverage = (response, label, exact = false) => {
      const ids = new Set(response.results.map(item => item.id));
      for (const source of sources) {
        if (source.containsPhrase) assert(ids.has(source.fragmentId), `${label} lost known matching source ${source.url}`);
        else if (exact) assert(!ids.has(source.fragmentId), `${label} included a known source without the exact phrase: ${source.url}`);
      }
    };
    assertSourceCoverage(first.result, 'Ordinary query');
    report.genesisRanks = { ordinary: knownSourceRanks(first.result, sources) };
    report.primaryGenesisRank = report.genesisRanks.ordinary.find(source => source.bookId === genesis.id)?.rank ?? null;
    report.primaryGenesisFirstPageRank = paths.findIndex(url => url.includes('/books/b-1/')) + 1 || null;
    report.checks.push({ name: 'all-known-matching-genesis-sources-present', passed: true });
    await measure('repeat-query-with-niqqud', async () => {
      const pointed = 'בְּרֵאשִׁית בָּרָא';
      const native = await api.search(pointed);
      const unpointedIds = first.result.results.map(item => item.id);
      const nativeIds = native.results.map(item => item.id);
      // Pagefind can boost an exact written form, changing ranking while
      // returning the same matching set. Our UI normalizes before searching.
      assert.equal([...nativeIds].sort().join('|'), [...unpointedIds].sort().join('|'), 'Niqqud changed the native matching set');
      const normalized = pointed.normalize('NFKD').replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '');
      assert.equal(normalized, query);
      const result = await api.search(normalized);
      assert(result.results.map(item => item.id).join('|') === unpointedIds.join('|'), 'UI-normalized query changed result ordering');
      report.genesisRanks.nativePointed = knownSourceRanks(native, sources);
      report.genesisRanks.uiNormalized = knownSourceRanks(result, sources);
      report.checks.push({ name: 'niqqud-matching-set-and-ui-normalized-ranking', passed: true });
      return { metrics: { results: result.results.length, nativeRankingChanged: nativeIds.join('|') !== unpointedIds.join('|'), normalizedRankingIdentical: true } };
    });
    await measure('category-filtered-query', async () => {
      const result = await api.search(query, { filters: { category: 'תנ״ך' } });
      assert(result.results.length > 0 && result.results.length <= first.result.results.length, 'Category filtering failed');
      assertSourceCoverage(result, 'Category query');
      report.genesisRanks.category = knownSourceRanks(result, sources);
      report.checks.push({ name: 'category-filter-preserves-matching-source', passed: true });
      return { metrics: { results: result.results.length } };
    });
    await measure('exact-phrase-query', async () => {
      const result = await api.search('"בראשית ברא"');
      assert(result.results.length > 0, 'Exact phrase query has no results');
      const data = await Promise.all(result.results.slice(0, 15).map(item => item.data()));
      assert(data.every(item => normalize(item.raw_content || item.content).includes(query)), 'Exact phrase search returned full content without the phrase');
      assertSourceCoverage(result, 'Exact phrase query', true);
      report.genesisRanks.quoted = knownSourceRanks(result, sources);
      report.checks.push({ name: 'quoted-phrase-search', passed: true });
      return { metrics: { results: result.results.length } };
    });
  }
  await measure('no-match-query', async () => {
    // Pagefind's prefix fallback legitimately matches זז for an unquoted
    // Hebrew nonce. Quotes request exact matching and make absence testable.
    const result = await api.search('"זזזזבדיקתמילהשאינהקיימתזזזז"');
    assert.equal(result.results.length, 0, 'Unique no-match query returned results');
    report.checks.push({ name: 'no-match-query', passed: true });
    return { metrics: { results: result.results.length } };
  });
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
  console.error(error.stack || error.message);
} finally {
  if (api) await api.destroy().catch(() => {});
  globalThis.fetch = originalFetch;
  if (originalDocument === undefined) delete globalThis.document; else globalThis.document = originalDocument;
  report.finishedAt = new Date().toISOString();
  report.status = failure ? 'failed' : 'passed';
  report.fetched = requests;
  report.totalRequests = requests.length;
  report.totalBytes = requests.reduce((sum, request) => sum + request.bytes, 0);
  report.peakConcurrentFetches = peakFetches;
  const file = path.join(outputDir, `${path.basename(directory)}-${mode}-c${concurrency}-latency${latencyMs}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, pages: report.pages, shards: report.shards, checks: report.checks, phases: report.phases, totalRequests: report.totalRequests, totalBytes: report.totalBytes, peakConcurrentFetches: peakFetches, report: path.relative(ROOT, file) }, null, 2));
  process.exitCode = failure ? 1 : 0;
}
