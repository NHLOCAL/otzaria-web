import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, getConfig } from '../src/config.mjs';
import { archiveFiles, listFiles, parsePartition, partKey, readBuildPlan } from '../src/build-parts.mjs';
import { partitionCacheBudget } from '../src/build-cache-plan.mjs';

const maximumCacheBytes = partitionCacheBudget(process.env.PARTITION_CACHE_MAX_BYTES);
const part = parsePartition(process.env.BUILD_PARTITION);
if (!part) throw new Error('Packaging requires BUILD_PARTITION');
const config = getConfig();
const plan = await readBuildPlan();
const item = plan.matrix.include[part.index];
const key = partKey(part.index);
const manifest = JSON.parse(await fs.readFile(path.join(config.outputDir, 'build-manifest.json'), 'utf8'));
if (!manifest.partial || manifest.partition?.index !== part.index || manifest.partition.total !== part.total || manifest.search?.status !== 'ready' || manifest.inputFingerprint !== item.fingerprint) throw new Error('Refusing to package an incomplete or mismatched build part');
const files = [`.cache/render-parts/${key}.json`, `.cache/search-parts/${key}.json`];
for (const directory of ['books', 'pagefind']) {
  try { for(const file of await listFiles(path.join(config.outputDir, directory)))files.push(file); }
  catch (error) { if (error.code !== 'ENOENT' || manifest.counts.books) throw error; }
}
// Top-level manifests/runtime are created by the assembler. An artifact cannot
// overwrite another worker's entry points or supply a stale build plan.
const scoped = files.filter(file => !file.startsWith(`${path.relative(ROOT, config.outputDir)}/pagefind/`) || file.includes('/pagefind/shard-'));
const bytes = await archiveFiles(path.join(ROOT, '.cache/transfer', item.result), scoped);
const cacheable = bytes <= maximumCacheBytes;
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `cacheable=${cacheable}\narchive_bytes=${bytes}\n`);
console.log(`${item.result}: ${(bytes / 1024 / 1024).toFixed(1)} MiB; within ${(maximumCacheBytes / 1024 / 1024).toFixed(1)} MiB result cache budget (${maximumCacheBytes} bytes): ${cacheable}`);
