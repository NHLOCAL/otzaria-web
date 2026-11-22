import {createHash} from 'node:crypto';

export const DEFAULT_MAX_SHARD_BYTES = 128 * 1024 * 1024;
export const SEARCH_PLAN_VERSION = 'category-prefix-v1';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const digest = value => createHash('sha256').update(value).digest('hex');

export function searchFamilyId(page) {
  const family = page.editionOf || page.familyId || page.bookId;
  if (typeof family !== 'string' || !family.trim()) throw new Error('Search page requires a book or family identifier');
  return family.replace(/-v-\d+$/, '');
}

/**
 * A category has independent, stable hash buckets. Overfull buckets split by
 * successive hash bits, never by a corpus-wide bin pack. A changed category or
 * prefix therefore cannot invalidate unrelated shards. Editions stay together
 * unless their complete family exceeds the byte budget. Oversized families use
 * the same partition rule on complete pages, preserving every reading URL.
 */
export function planSearchShards(pages, {requested = 1, maxBytes = DEFAULT_MAX_SHARD_BYTES} = {}) {
  if (!Array.isArray(pages)) throw new TypeError('Search pages must be an array');
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 128) throw new RangeError('Requested search buckets must be an integer from 1 to 128');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Search shard byte budget must be a positive safe integer');
  const categories = new Map();
  const paths = new Set();
  for (const page of pages) {
    if (!page || typeof page.path !== 'string' || !/^books\/[a-z0-9_-]+\/[a-z0-9_-]+\.html$/.test(page.path)) throw new Error('Search page requires a safe reading path');
    if (paths.has(page.path)) throw new Error(`Duplicate search page: ${page.path}`);
    paths.add(page.path);
    if (!Number.isSafeInteger(page.bytes) || page.bytes < 0) throw new Error(`Invalid rendered byte count: ${page.path}`);
    if (page.bytes > maxBytes) throw new RangeError(`Reading page exceeds the search shard byte budget: ${page.path} (${page.bytes} > ${maxBytes})`);
    const category = page.category ?? '';
    if (typeof category !== 'string') throw new Error(`Invalid search category: ${page.path}`);
    const familyId = searchFamilyId(page);
    if (!categories.has(category)) categories.set(category, new Map());
    const families = categories.get(category);
    if (!families.has(familyId)) families.set(familyId, {id: familyId, hash: digest(familyId), bytes: 0, pages: []});
    const family = families.get(familyId);
    family.pages.push(page);
    family.bytes += page.bytes;
    if (!Number.isSafeInteger(family.bytes)) throw new RangeError('Search family byte total exceeds the safe integer range');
  }
  const shards = [];
  function split(items, key, bucket, category, depth = 0) {
    const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Search bucket byte total exceeds the safe integer range');
    if (bytes <= maxBytes) {
      shards.push({key, bucket, category, bytes, pages: items.flatMap(item => item.pages).sort((a, b) => compare(a.path, b.path))});
      return;
    }
    if (depth >= 256) throw new Error('Unable to split search hash collision within byte budget');
    const branches = [[], []];
    for (const item of items) branches[(parseInt(item.hash[Math.floor(depth / 4)], 16) >> (3 - depth % 4)) & 1].push(item);
    for (let bit = 0; bit < 2; bit++) if (branches[bit].length) split(branches[bit], `${key}${bit}`, bucket, category, depth + 1);
  }
  for (const [category, families] of [...categories].sort(([a], [b]) => compare(a, b))) {
    const categoryKey = `c-${digest(category).slice(0, 16)}`;
    const buckets = Array.from({length: requested}, () => []);
    for (const family of [...families.values()].sort((a, b) => compare(a.id, b.id))) {
      const bucket = parseInt(family.hash.slice(0, 8), 16) % requested;
      if (family.bytes <= maxBytes) buckets[bucket].push(family);
      else {
        const items = family.pages.map(page => ({hash: digest(page.path), bytes: page.bytes, pages: [page]}));
        split(items, `${categoryKey}-f-${family.hash.slice(0, 16)}-`, bucket, category);
      }
    }
    for (let bucket = 0; bucket < requested; bucket++) if (buckets[bucket].length) split(buckets[bucket], `${categoryKey}-b-${String(bucket).padStart(3, '0')}-`, bucket, category);
  }
  shards.sort((a, b) => compare(a.key, b.key));
  if (new Set(shards.map(shard => shard.key)).size !== shards.length) throw new Error('Search shard key collision');
  return shards;
}
