import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const PAGEFIND_VERSION = '1.6.0';
export const digest = value => createHash('sha256').update(value).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function fileDigest(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return {bytes, sha256: hash.digest('hex')};
}

/** Check every byte, not only file sizes: a same-length corrupt fragment is invalid. */
export async function inspectBundle(bundle) {
  const names = [];
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      // Kept for compatibility with old root bundles during a local resume.
      if (!relative && entry.isDirectory() && entry.name.startsWith('shard-')) continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), name);
      else if (entry.isFile()) names.push(name);
      else throw new Error('Unsupported file in search checkpoint');
    }
  }
  await walk(bundle);
  if (!names.includes('pagefind.js') || !names.includes('pagefind-worker.js') || !names.some(name => name.endsWith('.pf_meta')) || !names.some(name => name.endsWith('.pagefind'))) throw new Error('Incomplete search bundle');
  names.sort(compare);
  const files = [];
  for (let i = 0; i < names.length; i += 16) {
    files.push(...await Promise.all(names.slice(i, i + 16).map(async name => [name, await fileDigest(path.join(bundle, name))])));
  }
  const entryBytes = await fs.readFile(path.join(bundle, 'pagefind-entry.json'));
  const entry = JSON.parse(entryBytes);
  if (entry.version !== PAGEFIND_VERSION || !entry.languages?.he || Object.keys(entry.languages).length !== 1) throw new Error('Unexpected checkpoint index version or language');
  return {
    files: files.length,
    bytes: files.reduce((sum, [, file]) => sum + file.bytes, 0),
    inventorySha256: digest(JSON.stringify(files)),
    entrySha256: digest(entryBytes),
    pages: entry.languages.he.page_count,
  };
}

/**
 * Output location and wall-clock build time are deliberately absent.
 * Content digests are computed/verified against actual input before use.
 */
export function checkpointIdentity({basePath, indexerSource, pages, key, cacheDir, options = {}}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error('Unsafe search checkpoint key');
  const contents = pages.map(page => {
    if (!/^[a-f0-9]{64}$/.test(page.contentSha256 || '')) throw new Error(`Missing content fingerprint: ${page.path}`);
    return {path: page.path, contentSha256: page.contentSha256, category: page.category ?? ''};
  }).sort((a, b) => compare(a.path, b.path));
  const fingerprint = digest(JSON.stringify({version: PAGEFIND_VERSION, basePath, indexer: digest(indexerSource), options, contents}));
  const inputCoverageSha256 = digest(JSON.stringify(contents.map(({path, contentSha256}) => ({path, contentSha256}))));
  return {file: path.join(cacheDir, `${key}.json`), bundle: path.join(cacheDir, key), fingerprint, inputCoverageSha256, pages: pages.length, key};
}

export async function validateReceipt(receipt, identity, bundle) {
  if (!receipt || receipt.schemaVersion !== 2 || receipt.fingerprint !== identity.fingerprint || receipt.pages !== identity.pages || receipt.inputCoverageSha256 !== identity.inputCoverageSha256) return false;
  try {
    const actual = await inspectBundle(bundle);
    return ['pages', 'files', 'bytes', 'inventorySha256', 'entrySha256'].every(key => actual[key] === receipt[key]);
  } catch { return false; }
}
export async function loadCheckpoint(identity, bundle) {
  try {
    const receipt = JSON.parse(await fs.readFile(identity.file, 'utf8'));
    return await validateReceipt(receipt, identity, bundle) ? receipt : null;
  } catch { return null; }
}
export async function readCheckpoint(identity, bundle) { return Boolean(await loadCheckpoint(identity, bundle)); }
export async function createReceipt(identity, bundle) {
  const actual = await inspectBundle(bundle);
  if (actual.pages !== identity.pages) throw new Error('Completed search shard does not contain every requested page');
  return {schemaVersion: 2, fingerprint: identity.fingerprint, inputCoverageSha256: identity.inputCoverageSha256, ...actual};
}
export async function writeCheckpoint(identity, bundle, receipt) {
  const value = receipt ?? await createReceipt(identity, bundle);
  await fs.mkdir(path.dirname(identity.file), {recursive: true});
  const temporary = `${identity.file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value));
  await fs.rename(temporary, identity.file);
  return value;
}
