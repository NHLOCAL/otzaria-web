import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateBuildCaches, partitionCacheBudget, DEFAULT_PARTITION_CACHE_BYTES, MAX_SEARCH_CACHE_BYTES, TOTAL_BUILD_CACHE_BYTES } from '../src/build-cache-plan.mjs';

test('allocation stays within one total budget and bounds the fallback', () => {
  const plan = allocateBuildCaches([1, 2, 3], 10);
  assert.deepEqual(plan.allocations.map(item => item.partitionCacheBytes), [1, 3, 5]);
  assert.equal(plan.allocatedBytes, 9);
  assert.equal(plan.unusedBytes, 1);
  assert(plan.allocations.every(item => item.searchCacheBytes <= item.partitionCacheBytes));
  const large = allocateBuildCaches([1, 1]);
  assert.equal(large.allocatedBytes, TOTAL_BUILD_CACHE_BYTES);
  assert(large.allocations.every(item => item.searchCacheBytes === MAX_SEARCH_CACHE_BYTES));
});

test('integer allocation cannot exceed the budget when multiplication exceeds 2^53', () => {
  const plan = allocateBuildCaches([Number.MAX_SAFE_INTEGER - 1, 1]);
  assert.deepEqual(plan.allocations.map(item => item.partitionCacheBytes), [TOTAL_BUILD_CACHE_BYTES - 1, 0]);
  assert.equal(plan.allocatedBytes + plan.unusedBytes, TOTAL_BUILD_CACHE_BYTES);
});

test('zero source weight or disabled cache receives no allocation', () => {
  assert.equal(allocateBuildCaches([0, 4]).allocations[0].partitionCacheBytes, 0);
  const disabled = allocateBuildCaches([10, 20], 0);
  assert(disabled.allocations.every(item => item.partitionCacheBytes === 0 && item.searchCacheBytes === 0));
  assert.equal(partitionCacheBudget('0'), 0);
});

test('invalid weights and budgets fail instead of creating unbounded caches', () => {
  for (const sizes of [[], [0, 0], [1, -1], [1, 0.5], [1, Infinity], ['1'], [Number.MAX_SAFE_INTEGER, 1], null]) assert.throws(() => allocateBuildCaches(sizes));
  for (const budget of [-1, 0.5, Infinity, TOTAL_BUILD_CACHE_BYTES + 1, '100']) assert.throws(() => allocateBuildCaches([1], budget));
  for (const budget of ['', '-1', '1.5', 'Infinity', '1e9', TOTAL_BUILD_CACHE_BYTES + 1, null, true]) assert.throws(() => partitionCacheBudget(budget));
  assert.equal(partitionCacheBudget(undefined), DEFAULT_PARTITION_CACHE_BYTES);
  assert.equal(partitionCacheBudget('123456'), 123456);
});

test('the measured full-library partitions fit a bounded compressed-source allocation', () => {
  // Run 44986830561 artifact byte counts. Tiny transport ZIP overhead affects
  // both observations negligibly; production weights use the actual tar.zst.
  const sources = [237887952, 314393806, 244736635, 292454698, 191721709, 174517196, 177895363, 184870713];
  const results = [1149437818, 1490558887, 1159737895, 1438594140, 942929705, 851249707, 876382223, 797698919];
  const plan = allocateBuildCaches(sources);
  assert.equal(results.filter(bytes => bytes <= 1024 ** 3).length, 4);
  assert(results.every((bytes, index) => bytes <= plan.allocations[index].partitionCacheBytes));
  assert(plan.allocatedBytes <= TOTAL_BUILD_CACHE_BYTES);
});
