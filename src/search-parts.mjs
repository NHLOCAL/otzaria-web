import path from 'node:path';
import {digest, validateReceipt} from './search-checkpoint.mjs';
import {searchCoverage, pathInside} from './search-input.mjs';

/** Verify the whole matrix contract before exposing any global ready manifest. */
export async function validateSearchParts(parts, {partitionCount, partitionFingerprints, basePath, configFingerprint, pages, outputDir}) {
  if (!Number.isSafeInteger(partitionCount) || partitionCount < 1 || partitionCount > 64) throw new Error('Invalid expected search partition count');
  if (parts.length !== partitionCount) throw new Error('Missing or extra search partitions');
  if (!Array.isArray(partitionFingerprints) || partitionFingerprints.length !== partitionCount || partitionFingerprints.some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Missing expected search partition fingerprints');
  const indices = new Set();
  const bundlePaths = new Set();
  const coverage = [];
  const shards = [];
  for (const part of parts) {
    const partition = part.partition;
    if (part.schemaVersion !== 1 || !partition || partition.total !== partitionCount || !Number.isSafeInteger(partition.index) || partition.index < 0 || partition.index >= partitionCount || indices.has(partition.index)) throw new Error('Invalid or duplicate search partition identity');
    indices.add(partition.index);
    if (part.basePath !== basePath || part.inputFingerprint !== partitionFingerprints[partition.index] || part.configFingerprint !== configFingerprint) throw new Error('Search partition belongs to a different source or index configuration');
    const partCoverage = searchCoverage(part.pages);
    if (digest(JSON.stringify(partCoverage)) !== part.coverageSha256) throw new Error('Search partition coverage digest mismatch');
    // A full partition can contain more pages than V8's argument-count limit.
    // Append entries without expanding the whole corpus onto the call stack.
    for (const page of partCoverage) coverage.push(page);
    if (!Array.isArray(part.shards) || (!part.shards.length && partCoverage.length)) throw new Error('Search partition has no completed shards');
    let shardPages = 0;
    const shardCoverage = [];
    for (const shard of part.shards) {
      const prefix = `pagefind/shard-p-${String(partition.index).padStart(3, '0')}-`;
      if (typeof shard.name !== 'string' || !shard.name.startsWith(prefix) || path.dirname(shard.name) !== 'pagefind' || bundlePaths.has(shard.name)) throw new Error('Invalid or duplicate partition bundle path');
      bundlePaths.add(shard.name);
      const indexedPages = searchCoverage(shard.coverage);
      if (indexedPages.length !== shard.pages) throw new Error('Shard coverage count does not match its index');
      for (const page of indexedPages) shardCoverage.push(page);
      const identity = {fingerprint: shard.fingerprint, pages: shard.pages, inputCoverageSha256: digest(JSON.stringify(indexedPages))};
      if (!await validateReceipt(shard.receipt, identity, pathInside(outputDir, shard.name))) throw new Error(`Incomplete or corrupt search bundle: ${shard.name}`);
      if (!Number.isSafeInteger(shard.pages) || shard.pages < 1 || !Array.isArray(shard.categories) || shard.categories.some(category => typeof category !== 'string')) throw new Error('Invalid shard manifest');
      shardPages += shard.pages;
      shards.push(shard);
    }
    if (shardPages !== partCoverage.length) throw new Error('Search partition page counts do not match');
    if (digest(JSON.stringify(searchCoverage(shardCoverage))) !== part.coverageSha256) throw new Error('Search shard coverage does not match its partition');
  }
  const expected = searchCoverage(pages);
  const actual = searchCoverage(coverage);
  if (digest(JSON.stringify(expected)) !== digest(JSON.stringify(actual))) throw new Error('Search partitions do not cover exactly the current reading pages and content');
  return shards.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}
