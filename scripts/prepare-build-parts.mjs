import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, getConfig } from '../src/config.mjs';
import { archiveFiles, bookInputs, bookPartition, codeFingerprint, fileHash, listFiles, partKey, partitionFingerprint, relativeFile, sha256 } from '../src/build-parts.mjs';

const config = getConfig();
const total = Number(process.env.BUILD_PARTITIONS || 8);
if (!Number.isSafeInteger(total) || total < 1 || total > 16) throw new Error('BUILD_PARTITIONS must be 1..16');
const source = config.sourceCatalog || path.join(ROOT, config.profile === 'full' ? '.cache/library/catalog.json' : 'data/starter/catalog.json');
const directory = path.dirname(source);
const catalog = JSON.parse(await fs.readFile(source, 'utf8'));
if (catalog.schemaVersion !== 1 || catalog.profile !== config.profile || !catalog.books?.length) throw new Error('Invalid source catalogue for partition build');
const external = path.resolve(ROOT, process.env.EXTERNAL_CATALOG || (config.profile === 'full' ? '.cache/external/catalog.json' : 'data/starter-external/catalog.json'));
const companions = path.resolve(ROOT, process.env.COMPANION_CATALOG || '.cache/companions/catalog.json');
const shared = [relativeFile(source), relativeFile(external)];
if (config.profile === 'full') shared.push(relativeFile(companions));
if (catalog.media) shared.push(relativeFile(path.resolve(directory, catalog.media.file)));
const code = await codeFingerprint();
const categoryBytes = new Map();
for (const book of catalog.books) {
  const category = book.categories?.[0] || 'ספרים נוספים';
  categoryBytes.set(category, (categoryBytes.get(category) || 0) + (book.bytes || 0));
}
// Keep small categories together. Only large categories fan out over book
// families; assigning every category to every worker multiplies browser costs.
const categoryFanout = Object.fromEntries([...categoryBytes].map(([category, bytes]) => [category,
  Math.min(total, 2 ** Math.ceil(Math.log2(Math.max(1, bytes / (128 * 1024 * 1024))))),
]));
const context = {
  schemaVersion: 1, code, siteUrl: config.siteUrl, profile: config.profile, sectionBytes: config.targetSectionBytes,
  partitions: total, outputDir: relativeFile(config.outputDir), sourceCatalog: relativeFile(source), externalCatalog: relativeFile(external),
  companion: config.profile === 'full' ? await fileHash(companions) : null,
  media: catalog.media?.sha256 || null,
  // Include all knobs that change the cached search bytes or shard plan.
  search: Object.fromEntries(['SEARCH_SHARDS', 'SEARCH_SHARD_BYTES', 'SEARCH_MAX_FRAGMENTS', 'SEARCH_FRAGMENT_TARGET_BYTES', 'SEARCH_FRAGMENT_MAX_PAGES'].map(key => [key, process.env[key] || null])),
};
const groups = Array.from({ length: total }, () => ({ books: [], files: [...shared], sources: [] }));
for (const book of catalog.books) {
  const group = groups[bookPartition(book, total, categoryFanout)];
  group.books.push(book);
}
for (const group of groups) {
  const inputs = await bookInputs(group.books, directory);
  group.files.push(...inputs.files); group.sources = inputs.sources;
}
const builtAt = process.env.BUILD_DATE || new Date().toISOString();
const plan = {
  schemaVersion: 1, partitions: total, builtAt, context, categoryFanout,
  sourceFingerprint: sha256(JSON.stringify({ context, catalog })),
  matrix: { include: groups.map((group, index) => {
    const suffix = String(index).padStart(3, '0');
    return { index, key: partKey(index), source: `source-${suffix}.tar.zst`, result: `result-${suffix}.tar.zst`,
      books: group.books.length, fingerprint: partitionFingerprint({ context, index, books: group.books, sources: group.sources }) };
  }) },
};
await fs.mkdir(path.join(ROOT, '.cache/transfer'), { recursive: true });
const planFile = '.cache/build-plan.json';
await fs.writeFile(path.join(ROOT, planFile), JSON.stringify(plan));
for (const [index, group] of groups.entries()) {
  const item = plan.matrix.include[index];
  const bytes = await archiveFiles(path.join(ROOT, '.cache/transfer', item.source), [...group.files, planFile]);
  console.log(`${item.key}: ${item.books} books, ${(bytes / 1024 / 1024).toFixed(1)} MiB compressed source`);
}
const global = [...shared, planFile];
const externalCatalog = JSON.parse(await fs.readFile(external, 'utf8'));
for (const group of [...externalCatalog.providers, ...externalCatalog.mappings]) for (const page of group.pages) {
  const file = path.resolve(path.dirname(external), page.file);
  if (!file.startsWith(path.dirname(external) + path.sep)) throw new Error('External payload escapes snapshot');
  global.push(relativeFile(file));
}
if (catalog.media) global.push(...await listFiles(path.resolve(directory, 'media')));
if (config.profile === 'full') global.push(...await listFiles(path.dirname(companions)));
await archiveFiles(path.join(ROOT, '.cache/transfer/source-global.tar.zst'), global);
if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(plan.matrix)}\npartitions=${total}\nbuilt_at=${builtAt}\n`);
console.log(`Prepared ${total} independent build parts; every family and its editions share a worker.`);
