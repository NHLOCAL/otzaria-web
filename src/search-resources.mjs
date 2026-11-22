import fs from 'node:fs/promises';
import os from 'node:os';

const MiB = 1024 * 1024;
export function chooseSearchConcurrency({requested, cpus, availableBytes, shardBytes}) {
  if (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1 || requested > 8)) throw new Error('SEARCH_CONCURRENCY must be an integer from 1 to 8');
  // The measured 128MiB shard peaked near 4.8GiB. Reserve extra for Node,
  // Pagefind's output phase and the OS; this is a heuristic, not an RSS limit.
  const estimatedWorkerBytes = Math.max(768 * MiB, shardBytes * 48);
  const memoryWorkers = Math.max(1, Math.floor((availableBytes - 768 * MiB) / estimatedWorkerBytes));
  const cpuWorkers = Math.max(1, Math.floor(cpus / 2));
  return Math.max(1, Math.min(requested ?? 2, cpuWorkers, memoryWorkers));
}

export async function searchResources() {
  const available = [os.freemem(), process.availableMemory?.() ?? Infinity];
  // On Linux, os.totalmem() may describe the host rather than the container.
  for (const [limitFile, usageFile] of [
    ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory.current'],
    ['/sys/fs/cgroup/memory/memory.limit_in_bytes', '/sys/fs/cgroup/memory/memory.usage_in_bytes'],
  ]) {
    try {
      const [limitText, usageText] = await Promise.all([fs.readFile(limitFile, 'utf8'), fs.readFile(usageFile, 'utf8')]);
      const limit = Number(limitText), used = Number(usageText);
      if (Number.isFinite(limit) && limit > 0 && Number.isFinite(used)) available.push(Math.max(0, limit - used));
    } catch { /* Native hosts and other operating systems need no cgroup cap. */ }
  }
  return {cpus: os.availableParallelism(), availableBytes: Math.min(...available)};
}

export async function runBounded(items, limit, worker) {
  let cursor = 0, failure = null;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (!failure) {
      const index = cursor++;
      if (index >= items.length) return;
      try { await worker(items[index]); } catch (error) { failure ??= error; }
    }
  }));
  if (failure) throw failure;
}
