import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT, getConfig} from '../src/config.mjs';
import {planSearchShards, DEFAULT_MAX_SHARD_BYTES, SEARCH_PLAN_VERSION} from '../src/search-plan.mjs';
import {checkpointIdentity, loadCheckpoint, writeCheckpoint, createReceipt, digest, PAGEFIND_VERSION} from '../src/search-checkpoint.mjs';
import {fingerprintSearchPages, searchCoverage} from '../src/search-input.mjs';
import {chooseSearchConcurrency, searchResources, runBounded} from '../src/search-resources.mjs';
import {restoreSearchCache, storeSearchCache, pruneSearchCache} from '../src/search-cache.mjs';
import {validateSearchParts} from '../src/search-parts.mjs';

const config = getConfig();
const input = JSON.parse(await fs.readFile(path.resolve(ROOT, process.env.SEARCH_INPUT || '.cache/search-pages.json'), 'utf8'));
if (input.outputDir !== config.outputDir || input.basePath !== config.basePath) throw new Error('Search input belongs to a different output directory or base path. Rebuild HTML first.');
if (!/^dist(?:[-_][a-z0-9_-]+)?$/i.test(path.relative(ROOT, config.outputDir))) throw new Error('Search output must be a dedicated dist directory');
if (!Array.isArray(input.pages)) throw new Error('Search input has no page list');
const manifestPath = path.join(config.outputDir, 'build-manifest.json');
const build = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const sourceFiles = ['scripts/index-shard.mjs', 'src/search-input.mjs', 'src/search-plan.mjs'];
const indexerSource = (await Promise.all(sourceFiles.map(file => fs.readFile(path.join(ROOT, file), 'utf8')))).join('\n');
function integer(name, fallback, minimum, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(name + ' must be an integer from ' + minimum + ' to ' + maximum);
  return value;
}
// Validate all configuration before deleting an old result or touching readiness.
const maxBytes = integer('SEARCH_SHARD_BYTES', DEFAULT_MAX_SHARD_BYTES, 1_000_000, 512 * 1024 * 1024);
const requested = integer('SEARCH_SHARDS', 1, 1, 128);
const fragmentTargetBytes = integer('SEARCH_FRAGMENT_TARGET_BYTES', 65536, 0, 1024 * 1024);
const fragmentMaxPages = integer('SEARCH_FRAGMENT_MAX_PAGES', 2, 1, 32);
const timeoutSeconds = integer('SEARCH_SHARD_TIMEOUT_SECONDS', 1200, 1, 21600);
const cacheMaximum = integer('SEARCH_CACHE_MAX_BYTES', 512 * 1024 * 1024, 0, Number.MAX_SAFE_INTEGER);
const batchLimit = process.env.SEARCH_BATCH_LIMIT === undefined ? Infinity : integer('SEARCH_BATCH_LIMIT', 1, 1, Number.MAX_SAFE_INTEGER);
const explicitConcurrency = process.env.SEARCH_CONCURRENCY === undefined ? undefined : integer('SEARCH_CONCURRENCY', 1, 1, 8);
const settings = {plan: SEARCH_PLAN_VERSION, maxBytes, requested, fragmentTargetBytes, fragmentMaxPages};
const configFingerprint = digest(JSON.stringify({version: PAGEFIND_VERSION, basePath: config.basePath, indexer: digest(indexerSource), ...settings}));
const cacheDir = path.resolve(ROOT, process.env.SEARCH_CACHE_DIR || '.cache/search-cache');
if (!cacheDir.startsWith(path.join(ROOT, '.cache') + path.sep)) throw new Error('SEARCH_CACHE_DIR must be inside the project .cache directory');
const partDirectory = path.join(ROOT, '.cache/search-parts');
const started = performance.now();
const activeChildren = new Map();
let interrupted = false;
function signalChild(child, group, signal) {
  try { if (group && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error(error.message); }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = true;
  for (const [child, group] of activeChildren) signalChild(child, group, signal);
  if (!activeChildren.size) process.exit(signal === 'SIGINT' ? 130 : 143);
  const timeout = setTimeout(() => {
    for (const [child, group] of activeChildren) signalChild(child, group, 'SIGKILL');
  }, 3000);
  timeout.unref();
});

async function markPending() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.search = {status: 'pending', pages: input.pages.length};
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await fs.rm(path.join(config.outputDir, 'search-manifest.json'), {force: true});
}
async function publish(shards, {partial = false, metrics = {}} = {}) {
  if (!shards.length && !partial) throw new Error('Refusing to publish an empty search index');
  const publicShards = shards.map(shard => ({
    bundlePath: config.basePath + shard.name + '/',
    pages: shard.pages, bodyBytes: shard.bodyBytes,
    categories: shard.categories, fingerprint: shard.fingerprint,
  }));
  const fingerprint = digest(JSON.stringify(publicShards));
  await fs.writeFile(path.join(config.outputDir, 'search-manifest.json'), JSON.stringify({
    schemaVersion: 1, engine: 'pagefind', version: PAGEFIND_VERSION, language: 'he',
    pages: input.pages.length, partial, fingerprint, shards: publicShards,
  }));
  if (!partial && shards.length) {
    // Reading pages retain their stable optional highlighter URL.
    await fs.mkdir(path.join(config.outputDir, 'pagefind'), {recursive: true});
    await fs.copyFile(path.join(config.outputDir, shards[0].name, 'pagefind-highlight.js'), path.join(config.outputDir, 'pagefind/pagefind-highlight.js'));
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  manifest.search = {status: 'ready', pages: input.pages.length, shards: shards.length, maxShardBytes: maxBytes, fingerprint, ...metrics};
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

if (process.env.SEARCH_FINALIZE === '1') {
  if (build.partial) throw new Error('Assemble the full HTML build before finalizing search');
  const partFiles = (await fs.readdir(partDirectory)).filter(name => /^p-\d{3}\.json$/.test(name)).sort();
  const parts = await Promise.all(partFiles.map(file => fs.readFile(path.join(partDirectory, file), 'utf8').then(JSON.parse)));
  await markPending();
  const shards = await validateSearchParts(parts, {
    partitionCount: build.partitionCount, partitionFingerprints: build.partitionFingerprints,
    basePath: config.basePath, configFingerprint, pages: input.pages, outputDir: config.outputDir,
  });
  await publish(shards, {metrics: {finalizedPartitions: parts.length, durationSeconds: (performance.now() - started) / 1000}});
  console.log('Finalized ' + input.pages.length + ' reading pages from ' + parts.length + ' independently verified search partitions');
} else {
  const partition = build.partial ? build.partition : null;
  if (build.partial && !partition) throw new Error('Partial HTML build has no partition identity');
  if (partition && (!Number.isSafeInteger(partition.index) || !Number.isSafeInteger(partition.total) || partition.index < 0 || partition.index >= partition.total || partition.total > 64)) throw new Error('Invalid build partition');
  const pages = await fingerprintSearchPages(input.pages, {root: ROOT, outputDir: config.outputDir});
  const plan = planSearchShards(pages, {requested, maxBytes});
  if (!plan.length && !partition) throw new Error('No complete reading pages to index');
  const resources = await searchResources();
  const concurrency = chooseSearchConcurrency({requested: explicitConcurrency, ...resources, shardBytes: maxBytes});
  console.log('Search plan: ' + pages.length + ' pages in ' + plan.length + ' category-local shards; ' + concurrency + ' worker(s), ' + (resources.availableBytes / 1024 ** 3).toFixed(1) + ' GiB available memory');
  const namespace = partition ? 'p-' + String(partition.index).padStart(3, '0') + '-' : '';
  const progressDir = path.join(ROOT, '.cache/search-checkpoints', path.basename(config.outputDir));
  const descriptors = plan.map(shard => {
    const key = namespace + shard.key;
    // A byte target alone bundles many short paragraphs, inflating the first
    // visible snippets. Also cap the average pages per fragment conservatively.
    const maxFragments = fragmentTargetBytes ? Math.min(shard.pages.length, Math.max(1, Math.ceil(shard.bytes / fragmentTargetBytes), Math.ceil(shard.pages.length / fragmentMaxPages))) : 0;
    const identity = checkpointIdentity({basePath: config.basePath, indexerSource, pages: shard.pages, key, cacheDir, options: {...settings, maxFragments}});
    return {...shard, key, maxFragments, name: 'pagefind/shard-' + key, identity, progress: {...identity, file: path.join(progressDir, key + '.json')}};
  });
  await markPending();
  let reused = 0, built = 0, cacheWrites = Promise.resolve();
  for (const item of descriptors) {
    item.bundle = path.join(config.outputDir, item.name);
    if (process.env.SEARCH_RESUME === '1') item.receipt = await loadCheckpoint(item.progress, item.bundle);
    if (!item.receipt && process.env.SEARCH_CACHE !== '0') item.receipt = await restoreSearchCache(item.identity, item.bundle);
    if (item.receipt) {
      reused++;
      await writeCheckpoint(item.progress, item.bundle, item.receipt);
      console.log('Reused verified search shard ' + item.key + ': ' + item.pages.length + ' pages');
    }
  }
  const pending = descriptors.filter(item => !item.receipt);
  const selected = pending.slice(0, batchLimit);
  async function indexOne(item) {
    if (interrupted) throw new Error('Search indexing was interrupted');
    await fs.rm(item.bundle, {recursive: true, force: true});
    await fs.mkdir(item.bundle, {recursive: true});
    const disk = await fs.statfs(item.bundle);
    const availableDisk = disk.bavail * disk.bsize;
    if (availableDisk < Math.max(128 * 1024 * 1024, item.bytes * 2)) throw new Error('Insufficient free disk before indexing ' + item.key + ': ' + availableDisk + ' bytes available');
    const job = path.join(ROOT, '.cache/search-job-' + path.basename(config.outputDir) + '-' + item.key + '.json');
    try {
      await fs.writeFile(job, JSON.stringify({root: ROOT, outputDir: config.outputDir, basePath: config.basePath, bundle: item.name, pages: item.pages, maxFragments: item.maxFragments}));
      await new Promise((resolve, reject) => {
        // A process group lets the watchdog also stop Pagefind's native child.
        const group = process.platform !== 'win32';
        const child = spawn(process.execPath, [path.join(ROOT, 'scripts/index-shard.mjs'), job], {stdio: 'inherit', env: process.env, detached: group});
        activeChildren.set(child, group);
        let expired = false, hardKill;
        function stop(signal) {
          signalChild(child, group, signal);
        }
        const timer = setTimeout(() => {
          expired = true;
          console.error('Search shard ' + item.key + ' exceeded ' + timeoutSeconds + 's; stopping its entire process group');
          stop('SIGTERM');
          hardKill = setTimeout(() => stop('SIGKILL'), 5000);
          hardKill.unref();
        }, timeoutSeconds * 1000);
        timer.unref();
        const clear = () => { clearTimeout(timer); clearTimeout(hardKill); activeChildren.delete(child); };
        child.once('error', error => { clear(); reject(error); });
        child.once('exit', (code, signal) => {
          clear();
          if (expired) { stop('SIGKILL'); reject(new Error('Search shard ' + item.key + ' timed out after ' + timeoutSeconds + 's; search remains pending')); }
          else if (code === 0) resolve();
          else { stop('SIGKILL'); reject(new Error('Search shard ' + item.key + ' failed (' + (signal || code) + '); search remains pending. Reduce SEARCH_CONCURRENCY or SEARCH_SHARD_BYTES if memory is constrained.')); }
        });
      });
      item.receipt = await createReceipt(item.identity, item.bundle);
      await writeCheckpoint(item.progress, item.bundle, item.receipt);
      built++;
      if (process.env.SEARCH_CACHE !== '0') {
        cacheWrites = cacheWrites.then(() => storeSearchCache(item.identity, item.bundle, item.receipt, cacheMaximum)).catch(error => console.warn('Optional search cache was not saved: ' + error.message));
        await cacheWrites;
      }
    } finally { await fs.rm(job, {force: true}); }
  }
  await runBounded(selected, concurrency, indexOne);
  // A restored cache may have a larger historical cap. This also runs when
  // every shard was reused, no new shard fits, or the current budget is zero.
  if (process.env.SEARCH_CACHE !== '0') await pruneSearchCache(cacheDir, cacheMaximum);
  if (selected.length < pending.length) {
    console.error('Search batch finished; remaining shards are pending. Run again with SEARCH_RESUME=1. This incomplete build must not be published.');
    process.exitCode = 2;
  } else {
    const shards = descriptors.map(item => ({
      name: item.name, pages: item.pages.length, bodyBytes: item.bytes,
      categories: [item.category].filter(Boolean), fingerprint: item.identity.fingerprint,
      receipt: item.receipt, coverage: searchCoverage(item.pages),
    }));
    if (partition) {
      const coverage = searchCoverage(pages);
      const part = {schemaVersion: 1, partition, basePath: config.basePath, sourceFingerprint: build.sourceFingerprint, inputFingerprint: build.inputFingerprint, configFingerprint, coverageSha256: digest(JSON.stringify(coverage)), pages: coverage, shards};
      await fs.mkdir(partDirectory, {recursive: true});
      const filename = path.join(partDirectory, 'p-' + String(partition.index).padStart(3, '0') + '.json');
      await fs.writeFile(filename + '.tmp', JSON.stringify(part));
      await fs.rename(filename + '.tmp', filename);
    }
    const metrics = {builtShards: built, reusedShards: reused, concurrency, durationSeconds: (performance.now() - started) / 1000};
    await publish(shards, {partial: Boolean(partition), metrics});
    console.log('Search complete: ' + pages.length + ' pages; ' + built + ' built, ' + reused + ' reused shards in ' + metrics.durationSeconds.toFixed(1) + 's');
  }
}
