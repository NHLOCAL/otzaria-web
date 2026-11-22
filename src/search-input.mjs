import fs from 'node:fs/promises';
import path from 'node:path';
import {digest} from './search-checkpoint.mjs';

export function pathInside(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('Unsafe search input path');
  const file = path.resolve(root, relative);
  if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error('Search input path escapes its directory');
  return file;
}

/** One book container in memory at a time; no second tree of reading-page files. */
export function contentReader({root, outputDir}) {
  let loadedFile = null, records = null;
  return async page => {
    let content;
    if (page.recordFile) {
      const file = pathInside(root, page.recordFile);
      if (file !== loadedFile) {
        const data = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!Array.isArray(data)) throw new Error(`Invalid search record container: ${page.recordFile}`);
        records = new Map();
        for (const record of data) {
          if (!record || typeof record.path !== 'string' || typeof record.content !== 'string' || records.has(record.path)) throw new Error(`Invalid or duplicate search record: ${page.recordFile}`);
          records.set(record.path, record.content);
        }
        loadedFile = file;
      }
      content = records.get(page.path);
      if (typeof content !== 'string') throw new Error(`Missing search record: ${page.path}`);
    } else content = await fs.readFile(pathInside(outputDir, page.path), 'utf8');
    const contentSha256 = digest(content);
    if (page.contentSha256 && contentSha256 !== page.contentSha256) throw new Error(`Search input checksum mismatch: ${page.path}`);
    return {content, contentSha256, bytes: Buffer.byteLength(content)};
  };
}

export async function fingerprintSearchPages(pages, directories) {
  const read = contentReader(directories);
  const result = [];
  const ordered = [...pages].sort((a, b) => (a.recordFile || a.path).localeCompare(b.recordFile || b.path, 'en') || a.path.localeCompare(b.path, 'en'));
  for (const page of ordered) {
    const {contentSha256, bytes} = await read(page);
    result.push({...page, contentSha256, bytes});
  }
  return result;
}

export function searchCoverage(pages) {
  const paths = new Set();
  return pages.map(page => {
    if (paths.has(page.path) || typeof page.path !== 'string' || !/^[a-f0-9]{64}$/.test(page.contentSha256 || '')) throw new Error('Invalid or duplicate search coverage');
    paths.add(page.path);
    return {path: page.path, contentSha256: page.contentSha256};
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
