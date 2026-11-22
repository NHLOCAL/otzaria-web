import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseSearchConcurrency, runBounded} from '../src/search-resources.mjs';

const GiB = 1024 ** 3;
test('memory and CPU budgets constrain parallelism even with an aggressive override', () => {
  assert.equal(chooseSearchConcurrency({cpus: 4, availableBytes: 15 * GiB, shardBytes: 128 * 1024 ** 2}), 2);
  assert.equal(chooseSearchConcurrency({cpus: 4, availableBytes: 7 * GiB, shardBytes: 128 * 1024 ** 2}), 1);
  assert.equal(chooseSearchConcurrency({requested: 8, cpus: 16, availableBytes: 2 * GiB, shardBytes: 128 * 1024 ** 2}), 1);
  assert.equal(chooseSearchConcurrency({requested: 1, cpus: 16, availableBytes: 32 * GiB, shardBytes: 128 * 1024 ** 2}), 1);
  assert.throws(() => chooseSearchConcurrency({requested: 0, cpus: 4, availableBytes: 8 * GiB, shardBytes: 128 * 1024 ** 2}), /SEARCH_CONCURRENCY/);
});

test('a failed worker stops new launches and waits for its running sibling', async () => {
  const started = [], finished = [];
  let release;
  const sibling = new Promise(resolve => { release = resolve; });
  const run = runBounded([0, 1, 2, 3], 2, async value => {
    started.push(value);
    if (value === 0) throw new Error('intentional index failure');
    await sibling;
    finished.push(value);
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, [0, 1]);
  assert.deepEqual(finished, []);
  release();
  await assert.rejects(run, /intentional index failure/);
  assert.deepEqual(finished, [1]);
  assert.deepEqual(started, [0, 1]);
});
