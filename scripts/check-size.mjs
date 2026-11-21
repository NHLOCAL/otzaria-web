import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOST_LIMITS = Object.freeze({
  'github-pages': { totalBytes: 1_000_000_000 },
  'cloudflare-pages': { files: 20_000, fileBytes: 25 * 1024 * 1024 },
  'cloudflare-r2': {},
  unrestricted: {},
});

/** Measure actual output, including search fragments and downloadable text. */
export async function measureOutput(directory) {
  const root = resolve(directory);
  const pending = [root];
  const stats = { files: 0, totalBytes: 0, maxFileBytes: 0, htmlFiles: 0, maxHtmlBytes: 0, largestFiles: [] };
  while (pending.length) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Static output must not contain symlinks: ${relative(root, path)}`);
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported output entry: ${relative(root, path)}`);
      const { size } = await lstat(path);
      const name = relative(root, path).split('\\').join('/');
      stats.files += 1;
      stats.totalBytes += size;
      stats.maxFileBytes = Math.max(stats.maxFileBytes, size);
      if (/\.html?$/i.test(name)) {
        stats.htmlFiles += 1;
        stats.maxHtmlBytes = Math.max(stats.maxHtmlBytes, size);
      }
      stats.largestFiles.push({ path: name, bytes: size });
      stats.largestFiles.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
      if (stats.largestFiles.length > 10) stats.largestFiles.pop();
    }
  }
  return stats;
}

/** Pure validation, exported so quota boundaries can be tested without huge fixtures. */
export function validateBudget(stats, {
  target = 'cloudflare-r2',
  cloudflareFileLimit = 20_000,
  maxHtmlBytes = 1_000_000,
} = {}) {
  if (!Object.hasOwn(HOST_LIMITS, target)) throw new Error(`Unknown DEPLOY_TARGET: ${target}`);
  if (![20_000, 100_000].includes(cloudflareFileLimit)) {
    throw new Error('CF_PAGES_FILE_LIMIT must be 20000 (Free) or 100000 (paid plan).');
  }
  if (!Number.isSafeInteger(maxHtmlBytes) || maxHtmlBytes < 1 || maxHtmlBytes >= 2_000_000) {
    throw new Error('MAX_HTML_BYTES must be a positive integer below 2000000.');
  }
  const limits = { ...HOST_LIMITS[target], htmlBytes: maxHtmlBytes };
  if (target === 'cloudflare-pages') limits.files = cloudflareFileLimit;
  const errors = [];
  if (!stats.files || !stats.htmlFiles) errors.push('Output must contain generated HTML pages.');
  if (limits.totalBytes && stats.totalBytes > limits.totalBytes) {
    errors.push(`Site is ${stats.totalBytes} bytes; ${target} budget is ${limits.totalBytes} bytes. Choose a smaller explicit collection or suitable static hosting. No books were silently removed.`);
  }
  if (limits.files && stats.files > limits.files) {
    errors.push(`Site contains ${stats.files} files; ${target} budget is ${limits.files}. Search fragments and text exports count too.`);
  }
  if (limits.fileBytes && stats.maxFileBytes > limits.fileBytes) {
    errors.push(`Largest asset is ${stats.maxFileBytes} bytes; ${target} allows ${limits.fileBytes} bytes per asset.`);
  }
  if (stats.maxHtmlBytes > maxHtmlBytes) {
    errors.push(`Largest HTML page is ${stats.maxHtmlBytes} bytes; split it at natural reading boundaries to stay under the ${maxHtmlBytes}-byte crawlability budget.`);
  }
  return { target, limits, errors, ok: errors.length === 0 };
}

async function main() {
  const directory = resolve(process.env.OUTPUT_DIR || 'dist');
  const stats = await measureOutput(directory);
  const result = validateBudget(stats, {
    target: process.env.DEPLOY_TARGET || 'cloudflare-r2',
    cloudflareFileLimit: Number(process.env.CF_PAGES_FILE_LIMIT || 20_000),
    maxHtmlBytes: Number(process.env.MAX_HTML_BYTES || 1_000_000),
  });
  const report = { ...result, ...stats };
  const reportPath = resolve(process.env.SIZE_REPORT || '.cache/build-size.json');
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Static output: ${stats.files.toLocaleString('en-US')} files, ${(stats.totalBytes / 1024 / 1024).toFixed(2)} MiB; largest HTML ${(stats.maxHtmlBytes / 1024).toFixed(1)} KiB.`);
  console.log(`Hosting target: ${result.target}. Budget report: ${reportPath}`);
  if (!result.ok) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(`Size check failed: ${error.message}`); process.exitCode = 1; });
}
