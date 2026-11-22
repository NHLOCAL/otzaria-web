import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {loadCheckpoint, writeCheckpoint} from './search-checkpoint.mjs';

async function cacheEntryBytes(file, stat = null) {
  stat ??= await fs.lstat(file);
  if (!stat.isDirectory()) return stat.size;
  let bytes = 0;
  const entries = await fs.readdir(file);
  for (let start = 0; start < entries.length; start += 32) {
    const sizes = await Promise.all(entries.slice(start, start + 32).map(name => cacheEntryBytes(path.join(file, name))));
    for (const size of sizes) bytes += size;
  }
  return bytes;
}

/**
 * Reapply the current cap after restoring a cache made under an older budget.
 * Count actual files, including receipts and incomplete copies. Call only once
 * all bundles needed by this build have been copied to the output directory.
 */
export async function pruneSearchCache(directory, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error('Search cache budget must be a non-negative safe integer');
  let names;
  try {
    if (!(await fs.lstat(directory)).isDirectory()) throw new Error('Search cache must be a real directory');
    names = await fs.readdir(directory);
  } catch (error) { if (error.code === 'ENOENT') return {bytes: 0, removedEntries: 0}; throw error; }
  const entries = new Map();
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    entries.set(name, {file, stat, bytes: await cacheEntryBytes(file, stat)});
  }
  let bytes = [...entries.values()].reduce((sum, item) => sum + item.bytes, 0);
  const candidates = [], grouped = new Set();
  for (const [name, entry] of entries) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name) || !entry.stat.isFile()) continue;
    const key = name.slice(0, -5), bundle = entries.get(key);
    let recognized = false;
    try { const receipt = JSON.parse(await fs.readFile(entry.file, 'utf8')); recognized = receipt.schemaVersion === 2 && /^[a-f0-9]{64}$/.test(receipt.fingerprint); } catch { /* A corrupt receipt may still have a recognizable bundle. */ }
    if (!recognized && bundle?.stat.isDirectory()) recognized = await fs.lstat(path.join(bundle.file, 'pagefind-entry.json')).then(stat => stat.isFile(), () => false);
    if (!recognized) continue;
    const files = [entry, ...(bundle ? [bundle] : [])];
    candidates.push({files, used: entry.stat.mtimeMs, bytes: files.reduce((sum, item) => sum + item.bytes, 0)});
    grouped.add(name); grouped.add(key);
  }
  for (const [name, entry] of entries) {
    if (grouped.has(name) || !entry.stat.isDirectory()) continue;
    const incomplete = /^[a-zA-Z0-9_-]+\.tmp-\d+$/.test(name);
    const orphan = await fs.lstat(path.join(entry.file, 'pagefind-entry.json')).then(stat => stat.isFile(), () => false);
    if (incomplete || orphan) candidates.push({files: [entry], used: entry.stat.mtimeMs, bytes: entry.bytes});
  }
  let removedEntries = 0;
  for (const entry of candidates.sort((a, b) => a.used - b.used)) {
    if (bytes <= maximumBytes) break;
    for (const file of entry.files) await fs.rm(file.file, {recursive: true, force: true});
    bytes -= entry.bytes; removedEntries++;
  }
  // Unknown files are counted but never deleted by cache cleanup. A wrongly
  // configured shared directory must not be uploaded as an oversized fallback.
  if (bytes > maximumBytes) throw new Error('Search cache contains unrecognized files above its byte budget');
  return {bytes, removedEntries};
}

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
