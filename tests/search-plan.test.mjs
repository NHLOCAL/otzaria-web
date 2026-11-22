import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DEFAULT_MAX_SHARD_BYTES, planSearchShards, searchFamilyId} from '../src/search-plan.mjs';

const page = (bookId, bytes, section = 'one', extra = {}) => ({path: `books/${bookId}/${section}.html`, bookId, bytes, ...extra});

function assertCompleteAndBounded(input, shards, maximum) {
  const actual = shards.flatMap(shard => shard.pages.map(item => item.path));
  assert.deepEqual([...actual].sort(), input.map(item => item.path).sort());
  assert.equal(new Set(actual).size, input.length);
  assert.equal(new Set(shards.map(shard => shard.key)).size, shards.length);
  for (const shard of shards) {
    assert.equal(shard.bytes, shard.pages.reduce((total, item) => total + item.bytes, 0));
    assert.ok(shard.bytes <= maximum, `${shard.key} exceeds its budget`);
    assert.ok(shard.pages.length > 0);
  }
}

test('unchanged buckets retain their existing family hash and public key', () => {
  const pages = [page('b-1', 20), page('b-1-v-3', 25), page('b-2', 15), page('b-3', 10)];
  const shards = planSearchShards(pages, {requested: 8, maxBytes: 100});
  assertCompleteAndBounded(pages, shards, 100);
  // Compatibility oracle is the previous production bucket assignment.
  for (const shard of shards) {
    assert.equal(shard.key, String(shard.bucket).padStart(3, '0'));
    for (const item of shard.pages) {
      const family = item.bookId.replace(/-v-\d+$/, '');
      assert.equal(shard.bucket, createHash('sha256').update(family).digest().readUInt32BE(0) % 8);
    }
  }
  assert.equal(shards.find(shard => shard.pages.some(item => item.bookId === 'b-1')), shards.find(shard => shard.pages.some(item => item.bookId === 'b-1-v-3')));
});

test('oversized buckets use first-fit decreasing without fragmenting fitting families', () => {
  const pages = [page('b-1', 35), page('b-1-v-3', 25), page('b-2', 50), page('b-3', 40), page('b-4', 30), page('b-5', 20)];
  const shards = planSearchShards(pages, {requested: 1, maxBytes: 100});
  assertCompleteAndBounded(pages, shards, 100);
  assert.deepEqual(shards.map(shard => [shard.key, shard.bytes]), [['000-00', 100], ['000-01', 100]]);
  assert.deepEqual(shards[0].pages.map(item => item.bookId), ['b-1-v-3', 'b-1', 'b-3']);
  assert.deepEqual(shards[1].pages.map(item => item.bookId), ['b-2', 'b-4', 'b-5']);
});

test('one oversized family is split by complete pages, with no omissions or oversized shards', () => {
  const pages = [page('b-1', 70, 'a'), page('b-1-v-3', 60, 'b'), page('b-1', 40, 'c'), page('b-1-v-3', 20, 'd'), page('b-2', 10)];
  const shards = planSearchShards(pages, {requested: 1, maxBytes: 100});
  assertCompleteAndBounded(pages, shards, 100);
  assert.equal(shards.length, 2);
  assert.deepEqual(shards.map(shard => shard.bytes), [100, 100]);
  assert.equal(shards.filter(shard => shard.pages.some(item => searchFamilyId(item) === 'b-1')).length, 2);
});

test('explicit edition relationships and family IDs keep related texts together', () => {
  const pages = [page('b-1', 20), page('different-id', 20, 'one', {editionOf: 'b-1', familyId: 'ignored'}), page('another-id', 20, 'one', {familyId: 'b-1'}), page('b-2', 50)];
  const shards = planSearchShards(pages, {requested: 1, maxBytes: 100});
  assertCompleteAndBounded(pages, shards, 100);
  const related = shards.find(shard => shard.pages.some(item => item.bookId === 'b-1'));
  assert.equal(related.pages.length, 3);
  assert.ok(related.pages.every(item => searchFamilyId(item) === 'b-1'));
});

test('planning is deterministic across input permutations and never changes input records', () => {
  const pages = Array.from({length: 24}, (_, index) => Object.freeze(page(`b-${1 + Math.floor(index / 3)}${index % 3 === 2 ? '-v-4' : ''}`, [60, 40, 25][index % 3], String(index))));
  const frozen = Object.freeze([...pages]);
  const before = JSON.stringify(frozen);
  const plan = planSearchShards(frozen, {requested: 4, maxBytes: 100});
  const reordered = [...pages.filter((_, index) => index % 2), ...pages.filter((_, index) => !(index % 2))].reverse();
  assert.deepEqual(planSearchShards(reordered, {requested: 4, maxBytes: 100}), plan);
  assert.equal(JSON.stringify(frozen), before);
  assertCompleteAndBounded(pages, plan, 100);
  assert.deepEqual(planSearchShards([], {requested: 4, maxBytes: 100}), []);
  assert.deepEqual(planSearchShards(frozen, {requested: 4, maxBytes: 100}), plan);
});

test('hard budget accepts its exact boundary and rejects only individually oversized content', () => {
  assert.equal(DEFAULT_MAX_SHARD_BYTES, 128 * 1024 * 1024);
  const pages = [page('b-1', 100, 'first'), page('b-1', 100, 'second'), page('b-2', 0)];
  const shards = planSearchShards(pages, {maxBytes: 100});
  assertCompleteAndBounded(pages, shards, 100);
  assert.equal(shards.length, 2);
  assert.throws(() => planSearchShards([page('b-1', 101)], {maxBytes: 100}), /Reading page exceeds.*books\/b-1\/one.html/);
  assert.throws(() => planSearchShards([page('b-1', 5), page('b-1', 5)]), /Duplicate search page/);
  assert.throws(() => planSearchShards([page('b-1', -1)]), /Invalid rendered byte count/);
  assert.throws(() => planSearchShards([], {maxBytes: 0}), /byte budget/);
  assert.throws(() => planSearchShards([], {requested: 0}), /Requested search buckets/);
});
