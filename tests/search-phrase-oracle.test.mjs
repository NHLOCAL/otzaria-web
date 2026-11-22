import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gunzipSync } from 'node:zlib';
import * as pagefind from 'pagefind';
import { hebrewPhraseEvidence } from '../scripts/search-phrase-oracle.mjs';
import { createStaticSearchClient } from '../public/search-client.mjs';
import { createNodeSearchWorkerFactory } from '../scripts/search-worker-node.mjs';

const phrase = 'בראשית ברא';
// Actual source: בת עין, תצוה, /books/b-440/s-420579.html. This result exposed
// the old whitespace-only assertion in full CI run 44990167097. Pagefind strips
// the internal quote in the primary token, while preserving it in raw_content.
const batAyin = 'הנה כתיב (בראשית א א) בראש"ית ברא כו\', ואמרו חז"ל';
const cases = [
  { id: 'plain', text: phrase, expected: true },
  { id: 'pointed', text: 'בְּרֵאשִׁית בָּרָא', expected: true },
  { id: 'bat-ayin', text: batAyin, expected: true },
  { id: 'hebrew-quote', text: 'בראש״ית ברא', expected: true },
  { id: 'hebrew-apostrophe', text: 'בראש׳ית ברא', expected: true },
  { id: 'ascii-apostrophe', text: "בראש'ית ברא", expected: true },
  { id: 'comma-edge', text: 'בראשית, ברא', expected: true },
  { id: 'comma-joined', text: 'בראשית,ברא', expected: false, allWords: true },
  { id: 'comma-gap', text: 'בראשית , ברא', expected: false, allWords: true },
  { id: 'maqaf-edge', text: 'בראשית־ ברא', expected: true },
  { id: 'maqaf-joined', text: 'בראשית־ברא', expected: false },
  { id: 'hyphen-joined', text: 'בראשית-ברא', expected: false, allWords: true },
  { id: 'compound-part', text: 'foo-בראשית ברא-bar', expected: true },
  { id: 'compound-internal-quote', text: 'foo-בראש"ית ברא', expected: false },
  { id: 'dotted-tail', text: 'foo.בראש"ית ברא', expected: true },
  { id: 'nonascii-compound', text: 'foo־בראשית ברא', expected: false },
  { id: 'zero-width', text: 'ברא\u200bשית ברא', expected: true },
  { id: 'zero-width-only', text: 'בראשית \u200b ברא', expected: true },
  { id: 'nbsp', text: 'בראשית\u00a0ברא', expected: true },
  { id: 'nel', text: 'בראשית\u0085ברא', expected: true },
  { id: 'bom', text: 'בראשית\ufeffברא', expected: false },
  { id: 'presentation-form', text: 'ברא\ufb2aית ברא', expected: true },
  { id: 'gap', text: 'בראשית משהו ברא', expected: false, allWords: true },
  { id: 'reversed', text: 'ברא בראשית', expected: false, allWords: true },
  { id: 'concatenated', text: 'בראשיתברא', expected: false },
  { id: 'prefix-only', text: 'בראשית בראתי', expected: false },
];

test('Hebrew phrase oracle preserves native positions and explains the actual Bat Ayin source', () => {
  for (const fixture of cases) {
    assert.equal(hebrewPhraseEvidence(fixture.text, phrase).matched, fixture.expected, fixture.id);
    const eachWord = phrase.split(' ').map(word => hebrewPhraseEvidence(fixture.text, word));
    assert.equal(eachWord.every(evidence => evidence.matched), fixture.allWords ?? fixture.expected, `Independent words: ${fixture.id}`);
  }
  const evidence = hebrewPhraseEvidence(batAyin, phrase);
  assert.equal(batAyin.includes(phrase), false, 'The old substring assertion must reproduce the failure');
  assert.equal(evidence.matchCount, 1);
  assert.deepEqual(evidence.matches[0].words.map(word => word.raw), ['בראש"ית', 'ברא']);
  assert.deepEqual(evidence.matches[0].words.map(word => word.expectedToken), ['בראשית', 'ברא']);
  assert.equal(evidence.matches[0].words[1].position, evidence.matches[0].words[0].position + 1);
  assert(evidence.matches[0].rawExcerpt.includes('בראש"ית ברא'));
  const gap = hebrewPhraseEvidence('בראשית , ברא', phrase);
  assert.equal(gap.wordPositions, 3);
  assert.deepEqual(gap.nearby[0].words[1].hebrewTokens, []);
  assert.throws(() => hebrewPhraseEvidence(batAyin, phrase, { version: '1.7.0' }), /pinned Pagefind/);
  assert.throws(() => hebrewPhraseEvidence(batAyin, 'בראשית, ברא'), /plain Hebrew/);
  assert.throws(() => hebrewPhraseEvidence(batAyin, 'hello world'), /plain Hebrew/);
});

test('phrase oracle agrees with real Pagefind 1.6.0 and production worker on Hebrew punctuation and gaps', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-phrase-oracle-'));
  const basePath = '/otzaria-web/';
  const bundlePath = `${basePath}pagefind/shard/`;
  const bundleDirectory = path.join(directory, 'pagefind/shard');
  const manifest = { engine: 'pagefind', version: '1.6.0', shards: [{ bundlePath, categories: ['בדיקה'], pages: cases.length }] };
  const { index, errors } = await pagefind.createIndex({ forceLanguage: 'he', keepIndexUrl: true });
  assert(!errors?.length && index);
  let client;
  try {
    for (const fixture of cases) {
      const added = await index.addHTMLFile({
        url: `${basePath}books/${fixture.id}.html`,
        content: `<html lang="he"><body><article data-pagefind-body><p>${fixture.text}</p></article></body></html>`,
      });
      assert(!added.errors?.length);
    }
    const written = await index.writeFiles({ outputPath: bundleDirectory });
    assert(!written.errors?.length);
    await index.deleteIndex();
    await pagefind.close();

    client = createStaticSearchClient({
      manifestUrl: `${basePath}search-manifest.json`, bundlePrefix: `${basePath}pagefind/`, origin: 'https://fixture.invalid',
      fetchManifest: async () => Response.json(manifest),
      workerFactory: createNodeSearchWorkerFactory({ directory, basePath }),
    });
    const response = await client.search(`"${phrase}"`);
    const nativeData = await Promise.all(response.results.map(result => result.data()));
    const nativePaths = new Set(nativeData.map(item => new URL(item.url, 'https://fixture.invalid').pathname));
    const allWords = await client.search(phrase);
    const allWordData = await Promise.all(allWords.results.map(result => result.data()));
    const allWordPaths = new Set(allWordData.map(item => new URL(item.url, 'https://fixture.invalid').pathname));
    const fragments = new Map();
    for (const file of await fs.readdir(path.join(bundleDirectory, 'fragment'))) {
      const decoded = gunzipSync(await fs.readFile(path.join(bundleDirectory, 'fragment', file))).toString('utf8');
      assert(decoded.startsWith('pagefind_dcd'));
      const payload = JSON.parse(decoded.slice('pagefind_dcd'.length));
      for (const fragment of payload.url ? [payload] : Object.values(payload)) fragments.set(fragment.url, fragment);
    }
    assert.equal(fragments.size, cases.length);
    for (const fixture of cases) {
      const url = `${basePath}books/${fixture.id}.html`;
      const fragment = fragments.get(url);
      assert(fragment, `Missing native fragment for ${fixture.id}`);
      const evidence = hebrewPhraseEvidence(fragment.content, phrase);
      assert.equal(nativePaths.has(url), fixture.expected, `Native phrase semantics changed for ${fixture.id}: ${fragment.content}`);
      assert.equal(evidence.matched, nativePaths.has(url), `Oracle/native disagreement for ${fixture.id}: ${JSON.stringify(evidence)}`);
      const wordEvidence = phrase.split(' ').map(word => hebrewPhraseEvidence(fragment.content, word));
      assert.equal(allWordPaths.has(url), fixture.allWords ?? fixture.expected, `Native AND semantics changed for ${fixture.id}`);
      assert.equal(wordEvidence.every(item => item.matched), allWordPaths.has(url), `Independent word oracle disagreement for ${fixture.id}: ${JSON.stringify(wordEvidence)}`);
    }
    const actual = nativeData.find(item => item.url.includes('/bat-ayin.html'));
    assert(actual && !actual.raw_content.includes(phrase), 'The native regression must preserve the actual quote in displayed content');
    assert.equal(hebrewPhraseEvidence(actual.raw_content, phrase).matched, true);
  } finally {
    await client?.destroy();
    await pagefind.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
