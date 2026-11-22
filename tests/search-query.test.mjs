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

test('quoted phrases pass directly and cancellation skips remaining token queries', async () => {
  const queries = [];
  let current = true;
  const native = { results: [{ id: 'one' }] };
  const api = { search: async query => { queries.push(query); current = false; return native; } };
  assert.equal(await searchWholeWords(api, '"בראשית ברא"'), native);
  current = true;
  assert.equal(await searchWholeWords(api, 'בראשית ברא', {}, () => current), null);
  assert.deepEqual(queries, ['"בראשית ברא"', '"בראשית"']);
});
