import fs from 'node:fs/promises';
import path from 'node:path';
import { resourceSnapshot } from './profile-command.mjs';

const label = process.argv[2] || 'build';
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error('Invalid resource report label');
const minimumDiskGiB = Number(process.env.MIN_FREE_DISK_GIB || 0);
const minimumMemoryGiB = Number(process.env.MIN_MEMORY_GIB || 0);
if (![minimumDiskGiB, minimumMemoryGiB].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Resource thresholds must be non-negative GiB values');
const resources = await resourceSnapshot();
const gib = 1024 ** 3;
const report = { schemaVersion: 1, label, recordedAt: new Date().toISOString(), minimumDiskGiB, minimumMemoryGiB, ...resources };
await fs.mkdir('.cache/performance', { recursive: true });
await fs.writeFile(path.join('.cache/performance', `resources-${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
console.log(`${label}: ${resources.cpuCount} available CPUs, ${(resources.memoryTotalBytes / gib).toFixed(1)} GiB RAM, ${resources.diskAvailableBytes === null ? 'unknown' : (resources.diskAvailableBytes / gib).toFixed(1)} GiB free disk`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `## ${label}\n\n${resources.cpuCount} available CPUs; ${(resources.memoryTotalBytes / gib).toFixed(1)} GiB RAM; ${resources.diskAvailableBytes === null ? 'unknown' : (resources.diskAvailableBytes / gib).toFixed(1)} GiB free disk at start.\n\nThe RSS figures below sample all child processes and can count shared memory twice.\n\n| Phase | Wall time | Sampled peak RSS | Exit code |\n| --- | ---: | ---: | ---: |\n`);
}
if (resources.diskAvailableBytes === null || resources.diskAvailableBytes < minimumDiskGiB * gib) throw new Error(`${label} requires at least ${minimumDiskGiB} GiB free disk. Available space was measured on this runner; the documented runner capacity is not assumed to be its actual free space.`);
if (resources.memoryTotalBytes < minimumMemoryGiB * gib) throw new Error(`${label} requires at least ${minimumMemoryGiB} GiB RAM. Reduce partition input size or indexing concurrency.`);
