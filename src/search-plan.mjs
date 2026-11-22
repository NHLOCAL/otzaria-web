import {createHash} from 'node:crypto';

export const DEFAULT_MAX_SHARD_BYTES = 128 * 1024 * 1024;

const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const comparePages = (left, right) => compareText(left.path, right.path);

export function searchFamilyId(page) {
  const family = page.editionOf || page.familyId || page.bookId;
  if (typeof family !== 'string' || !family.trim()) throw new Error('Search page requires a book or family identifier');
  return family.replace(/-v-\d+$/, '');
}

function fitDecreasing(items, maximum, compareTies) {
  const ordered = [...items].sort((left, right) => right.bytes - left.bytes || compareTies(left, right));
  const bins = [];
  for (const item of ordered) {
    let bin = bins.find(candidate => candidate.bytes + item.bytes <= maximum);
    if (!bin) {
      bin = {bytes: 0, items: []};
      bins.push(bin);
    }
    bin.items.push(item);
    bin.bytes += item.bytes;
  }
  return bins;
}

/**
 * Keep the original family-hash buckets, splitting only buckets above the hard
 * byte budget. A family remains indivisible whenever it fits in one shard. An
 * oversized family is divided by complete reading pages; no page is omitted.
 * Sorting uses code-point comparisons, independent of locale and input order.
 * The input array and page records are never changed, and no plan is cached.
 */
export function planSearchShards(pages, {requested = 1, maxBytes = DEFAULT_MAX_SHARD_BYTES} = {}) {
  if (!Array.isArray(pages)) throw new TypeError('Search pages must be an array');
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > 128) throw new RangeError('Requested search buckets must be an integer from 1 to 128');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('Search shard byte budget must be a positive safe integer');
  const buckets = Array.from({length: requested}, () => new Map());
  const paths = new Set();
  for (const page of pages) {
    if (!page || typeof page.path !== 'string' || !page.path) throw new Error('Search page requires a unique path');
    if (paths.has(page.path)) throw new Error(`Duplicate search page: ${page.path}`);
    paths.add(page.path);
    if (!Number.isSafeInteger(page.bytes) || page.bytes < 0) throw new Error(`Invalid rendered byte count: ${page.path}`);
    if (page.bytes > maxBytes) throw new RangeError(`Reading page exceeds the search shard byte budget: ${page.path} (${page.bytes} > ${maxBytes})`);
    const familyId = searchFamilyId(page);
    const bucket = createHash('sha256').update(familyId).digest().readUInt32BE(0) % requested;
    let family = buckets[bucket].get(familyId);
    if (!family) {
      family = {id: familyId, bytes: 0, pages: []};
      buckets[bucket].set(familyId, family);
    }
    family.pages.push(page);
    family.bytes += page.bytes;
    if (!Number.isSafeInteger(family.bytes)) throw new RangeError('Search family byte total exceeds the safe integer range');
  }

  const shards = [];
  for (let bucket = 0; bucket < buckets.length; bucket++) {
    const families = [...buckets[bucket].values()];
    if (!families.length) continue;
    const bytes = families.reduce((total, family) => total + family.bytes, 0);
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Search bucket byte total exceeds the safe integer range');
    const key = String(bucket).padStart(3, '0');
    if (bytes <= maxBytes) {
      shards.push({key, bucket, bytes, pages: families.flatMap(family => family.pages).sort(comparePages)});
      continue;
    }

    const units = [];
    for (const family of families) {
      if (family.bytes <= maxBytes) {
        units.push({...family, part: 0});
        continue;
      }
      const pieces = fitDecreasing(family.pages, maxBytes, comparePages);
      for (let part = 0; part < pieces.length; part++) {
        units.push({id: family.id, part, bytes: pieces[part].bytes, pages: pieces[part].items});
      }
    }
    const partitions = fitDecreasing(units, maxBytes, (left, right) => compareText(left.id, right.id) || left.part - right.part);
    for (let part = 0; part < partitions.length; part++) {
      const partition = partitions[part];
      shards.push({key: `${key}-${String(part).padStart(2, '0')}`, bucket, bytes: partition.bytes, pages: partition.items.flatMap(unit => unit.pages).sort(comparePages)});
    }
  }
  return shards;
}
