import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {loadCheckpoint, writeCheckpoint} from './search-checkpoint.mjs';

export async function restoreSearchCache(identity, destination) {
  const receipt = await loadCheckpoint(identity, identity.bundle);
  if (!receipt) return null;
  await fs.rm(destination, {recursive: true, force: true});
  await fs.cp(identity.bundle, destination, {recursive: true, mode: constants.COPYFILE_FICLONE});
  const now = new Date();
  await fs.utimes(identity.file, now, now);
  return receipt;
}

/** Call serially within a job, so eviction cannot race another cache restore. */
export async function storeSearchCache(identity, source, receipt, maximumBytes) {
  if (maximumBytes <= 0 || receipt.bytes > maximumBytes) return false;
  await fs.mkdir(path.dirname(identity.file), {recursive: true});
  const temporary = `${identity.bundle}.tmp-${process.pid}`;
  await fs.rm(temporary, {recursive: true, force: true});
  try {
    await fs.cp(source, temporary, {recursive: true, mode: constants.COPYFILE_FICLONE});
    await fs.rm(identity.bundle, {recursive: true, force: true});
    await fs.rename(temporary, identity.bundle);
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
  await writeCheckpoint(identity, source, receipt);
  const directory = path.dirname(identity.file);
  const entries = [];
  for (const name of await fs.readdir(directory)) {
    if (!name.endsWith('.json')) continue;
    try {
      const file = path.join(directory, name);
      const [value, stat] = await Promise.all([fs.readFile(file, 'utf8').then(JSON.parse), fs.stat(file)]);
      if (value.schemaVersion === 2 && Number.isSafeInteger(value.bytes) && value.bytes >= 0) entries.push({file, bundle: file.slice(0, -5), bytes: value.bytes, used: stat.mtimeMs});
    } catch { /* A missing or incomplete receipt is never a reusable cache hit. */ }
  }
  let bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of entries.sort((a, b) => a.used - b.used)) {
    if (bytes <= maximumBytes) break;
    if (entry.file === identity.file) continue;
    await fs.rm(entry.bundle, {recursive: true, force: true});
    await fs.rm(entry.file, {force: true});
    bytes -= entry.bytes;
  }
  return true;
}
