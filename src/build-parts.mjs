import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ROOT, safeId } from './config.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const partKey = index => `p-${String(index).padStart(3, '0')}`;
export const partitionFingerprint = ({ context, index, books, sources }) => sha256(JSON.stringify({ context, index, books, sources }));
export function parsePartition(value) {
  if (!value) return null;
  if (!/^\d+\/\d+$/.test(value)) throw new Error('BUILD_PARTITION must be a zero-based index/count');
  const [index, total] = value.split('/').map(Number);
  if (!Number.isSafeInteger(total) || total < 1 || total > 16 || index < 0 || index >= total) throw new Error('Invalid build partition; count must be 1..16');
  return { index, total };
}
export function bookPartition(book, total, categoryFanout = null) {
  const family = book.editionOf || book.id;
  safeId(family);
  const familyHash = createHash('sha256').update(family).digest().readUInt32BE(0);
  if (!categoryFanout) return familyHash % total;
  const category = book.categories?.[0] || 'ספרים נוספים';
  const fanout = categoryFanout[category];
  if (!Number.isSafeInteger(fanout) || fanout < 1 || fanout > total) throw new Error(`Missing category partition rule: ${category}`);
  const categoryHash = createHash('sha256').update(category).digest().readUInt32BE(0);
  return (categoryHash % total + familyHash % fanout) % total;
}
export function relativeFile(file, root = ROOT) {
  const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || relative === '..' || path.isAbsolute(relative) || /[\0\r\n]/.test(relative)) throw new Error(`File escapes workspace: ${file}`);
  return relative;
}
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function bookInputs(books, directory) {
  const sources = [], files = [], hashes = new Map();
  for (const book of books) for (const [key, hashKey] of [['file', 'contentSha256'], ['lineIdsFile', 'lineIdsSha256'], ['linksFile', 'linksSha256']]) {
    if (!book[key]) continue;
    const file = path.resolve(directory, book[key]);
    if (!file.startsWith(directory + path.sep)) throw new Error(`Source path escapes snapshot: ${book.id}`);
    if (!hashes.has(file)) hashes.set(file, await fileHash(file));
    const actual = hashes.get(file);
    if (book[hashKey] && actual !== book[hashKey]) throw new Error(`Source checksum mismatch: ${book.id} ${key}`);
    files.push(relativeFile(file)); sources.push([relativeFile(file), actual]);
  }
  return { sources, files };
}
export async function codeFingerprint() {
  const files = [];
  // Public JS/CSS/fonts are copied afresh by assembly and are never inside a
  // partition archive. Frontend-only edits must not rebuild every book/index.
  // All renderer/indexer modules remain covered, including future src imports.
  for (const directory of ['scripts', 'src']) {
    async function walk(relative) {
      for (const entry of await fs.readdir(path.join(ROOT, relative), { withFileTypes: true })) {
        const item = `${relative}/${entry.name}`;
        if (entry.isDirectory() && entry.name !== '__pycache__') await walk(item);
        else if (entry.isFile() && !entry.name.endsWith('.pyc')) files.push(item);
      }
    }
    await walk(directory);
  }
  files.push('package-lock.json');
  const hashes = [];
  for (const file of files.sort()) hashes.push([file, await fileHash(path.join(ROOT, file))]);
  return sha256(JSON.stringify(hashes));
}
export async function readBuildPlan() {
  const plan = JSON.parse(await fs.readFile(path.join(ROOT, '.cache/build-plan.json'), 'utf8'));
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.matrix?.include) || plan.matrix.include.length !== plan.partitions) throw new Error('Missing or invalid prepared build plan');
  return plan;
}
export async function archiveFiles(destination, files, { root = ROOT } = {}) {
  const unique = [...new Set(files.map(file => relativeFile(file, root)))].sort();
  if (!unique.length) throw new Error('Cannot archive an empty build part');
  // Only regular files are admitted. Do not archive source symlinks, devices,
  // credentials, or directory trees accidentally selected by a broad glob.
  for (const file of unique) if (!(await fs.lstat(path.join(root, file))).isFile()) throw new Error(`Archive member is not a regular file: ${file}`);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const list = `${destination}.files`;
  await fs.writeFile(list, `${unique.join('\0')}\0`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['--zstd', '-cf', `${destination}.tmp`, '--null', '--verbatim-files-from', '-T', list], {
        cwd: root, stdio: 'inherit', env: { ...process.env, ZSTD_CLEVEL: '3', ZSTD_NBTHREADS: '2' },
      });
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Archive failed: ${signal || code}`)));
    });
    await fs.rename(`${destination}.tmp`, destination);
  } finally { await fs.rm(list, { force: true }); await fs.rm(`${destination}.tmp`, { force: true }); }
  return (await fs.stat(destination)).size;
}
export async function listFiles(directory) {
  const result = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) result.push(relativeFile(file));
      else throw new Error(`Unsupported build artifact: ${file}`);
    }
  }
  await walk(directory);
  return result;
}
