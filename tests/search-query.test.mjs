import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSearchQuery, searchWholeWords } from '../public/search-query.mjs';

test('query normalization preserves outer phrase quotes and compound positions', () => {
  const examples = [
    ['בְּרֵאשִׁית בָּרָא', 'בראשית ברא'],
    ['רמב"ם', 'רמבם'], ['בראש"ית', 'בראשית'],
    [' "בראש"ית ברא" ', '"בראשית ברא"'],
    ['"רמב״ם תורה"', '"רמבם תורה"'],
    ['"בְּרֵאשִׁית־בָּרָא אלהים"', '"בראשית־ברא אלהים"'],
    ['"בראשית-ברא אלהים"', '"בראשית-ברא אלהים"'],
    ['בראשית־ברא', 'בראשית ברא'], ['בראשית-ברא', 'בראשית ברא'],
    ['"בראשית ברא', 'בראשית ברא'], ['""', ''], ['---', ''],
    [null, ''], ['', ''], ['  ', ''], ['ְּ', ''],
  ];
  for (const [input, expected] of examples) assert.equal(normalizeSearchQuery(input), expected, String(input));
});

test('whole-word intersection preserves native ranking handles and omits prefix counts', async () => {
  const queries = [];
  const handles = ['only-first', 'both', 'prefix-only'].map(id => ({ id, score: id === 'both' ? 7 : 1, data: async () => ({ id }) }));
  const api = { search: async query => {
    queries.push(query);
    const results = query === '"בראשית"' ? handles.slice(0, 2) : query === '"ברא"' ? handles.slice(1, 2) : handles;
    return { results, filters: { category: { test: 3 } }, unfilteredResultCount: 3, timings: [1] };
  } };
  const actual = await searchWholeWords(api, 'בראשית ברא בראשית');
  assert.deepEqual(queries, ['"בראשית"', '"ברא"', 'בראשית ברא בראשית']);
  assert.deepEqual(actual.results, [handles[1]]);
  assert.equal(actual.results[0].data, handles[1].data);
  assert.deepEqual(await actual.results[0].data(), { id: 'both' });
  assert.deepEqual(Object.keys(actual), ['results']);
});

test('an incomplete native candidate set fails with shard and missing IDs', async () => {
  const api = { search: async query => ({ results: query.startsWith('"') ? [{ id: 'he_missing' }] : [] }) };
  await assert.rejects(searchWholeWords(api, 'בראשית ברא', {}, undefined, '/pagefind/shard/'), /shard\/.*he_missing/);
});

test('phrase ranking changes only scores, preserving exact membership and positional handles', async () => {
  const queries = [];
  const options = { filters: { category: 'תנך' } };
  const exact = [
    { id: 'first', score: 1, words: [4, 5], data: async () => ({ locations: [4, 5], excerpt: 'exact first' }) },
    { id: 'second', score: 1, words: [8, 9], data: async () => ({ locations: [8, 9], excerpt: 'exact second' }) },
  ];
  const api = { search: async (query, passedOptions) => {
    queries.push(query);
    assert.equal(passedOptions, options);
    return { results: query.startsWith('"') ? exact : [
      { id: 'unrelated-prefix', score: 100, data: async () => { throw new Error('Wrong handle'); } },
      { id: 'second', score: 12 }, { id: 'first', score: 3 },
    ] };
  } };
  const actual = await searchWholeWords(api, '"בראשית ברא"', options);
  assert.deepEqual(queries, ['"בראשית ברא"', 'בראשית ברא']);
  assert.deepEqual(actual.results.map(result => [result.id, result.score]), [['first', 3], ['second', 12]]);
  for (const [index, result] of actual.results.entries()) {
    assert.equal(result.data, exact[index].data);
    assert.equal(result.words, exact[index].words);
    assert.deepEqual(await result.data(), await exact[index].data());
  }
  assert(exact.every(result => result.score === 1), 'Ranking must not mutate the native phrase response');
});

test('phrase ranking rejects missing candidates and skips ranking when no phrase matches', async () => {
  const incomplete = { search: async query => ({ results: query.startsWith('"') ? [{ id: 'he_missing', score: 1 }] : [] }) };
  await assert.rejects(searchWholeWords(incomplete, '"בראשית ברא"', {}, undefined, '/pagefind/shard/'), /exact-phrase rank.*shard\/.*he_missing/);
  let calls = 0;
  assert.deepEqual(await searchWholeWords({ search: async () => { calls++; return { results: [] }; } }, '"absent phrase"'), { results: [] });
  assert.equal(calls, 1);
});

test('cancellation skips remaining word queries and phrase ranking', async () => {
  const queries = [];
  let current = true;
  const native = { results: [{ id: 'one' }] };
  const api = { search: async query => { queries.push(query); current = false; return native; } };
  assert.equal(await searchWholeWords(api, '"בראשית ברא"', {}, () => current), null);
  current = true;
  assert.equal(await searchWholeWords(api, 'בראשית ברא', {}, () => current), null);
  assert.deepEqual(queries, ['"בראשית ברא"', '"בראשית"']);
});
