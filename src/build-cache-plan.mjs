// New cache entries requested by one build stay below GitHub's default free
// 10 GB repository allowance, leaving 1 decimal GB for npm/pip and metadata.
// Older entries still share that allowance and may be evicted by GitHub.
export const TOTAL_BUILD_CACHE_BYTES = 9_000_000_000;
export const DEFAULT_PARTITION_CACHE_BYTES = 512 * 1024 ** 2;
export const MAX_SEARCH_CACHE_BYTES = 512 * 1024 ** 2;

export function partitionCacheBudget(value) {
  if (value === undefined) return DEFAULT_PARTITION_CACHE_BYTES;
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) throw new Error('PARTITION_CACHE_MAX_BYTES must be a non-negative integer');
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes > TOTAL_BUILD_CACHE_BYTES) throw new Error(`PARTITION_CACHE_MAX_BYTES must be at most ${TOTAL_BUILD_CACHE_BYTES}`);
  return bytes;
}

export function allocateBuildCaches(sourceArchiveBytes, totalBudgetBytes = TOTAL_BUILD_CACHE_BYTES) {
  if (!Array.isArray(sourceArchiveBytes) || !sourceArchiveBytes.length || sourceArchiveBytes.some(bytes => !Number.isSafeInteger(bytes) || bytes < 0)) throw new Error('Source archive sizes must be a non-empty array of non-negative safe integers');
  if (!Number.isSafeInteger(totalBudgetBytes) || totalBudgetBytes < 0 || totalBudgetBytes > TOTAL_BUILD_CACHE_BYTES) throw new Error('Invalid total build cache budget');
  const sourceBytes = sourceArchiveBytes.reduce((sum, bytes) => sum + BigInt(bytes), 0n);
  if (sourceBytes === 0n) throw new Error('At least one source archive must contain bytes');
  if (sourceBytes > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Combined source archive size exceeds safe integer range');
  const allocations = sourceArchiveBytes.map(bytes => {
    // Integer arithmetic and rounding down keep the sum within the total even
    // when sourceBytes * totalBudgetBytes exceeds Number's exact integer range.
    const partitionCacheBytes = Number(BigInt(totalBudgetBytes) * BigInt(bytes) / sourceBytes);
    return { sourceArchiveBytes: bytes, partitionCacheBytes, searchCacheBytes: Math.min(MAX_SEARCH_CACHE_BYTES, partitionCacheBytes) };
  });
  const allocatedBytes = allocations.reduce((sum, item) => sum + item.partitionCacheBytes, 0);
  return { totalBudgetBytes, sourceArchiveBytes: Number(sourceBytes), allocatedBytes, unusedBytes: totalBudgetBytes - allocatedBytes, allocations };
}
