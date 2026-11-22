import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseFragment } from 'parse5';
import { ROOT } from '../src/config.mjs';
import { externalHomePage, externalProviderIndexPage, externalProviderPage, externalSearchPage } from '../src/external-ui.mjs';
import { layout, homePage, catalogPage, aboutPage, developersPage, readingPage, bookPage } from '../src/ui.mjs';
import { normalizeMetadataQuery, safeProviderUrl, safeExternalResultUrl } from '../public/external-search.js';

const baseUrl = '/otzaria-web/';
const directory = path.join(ROOT, 'data/starter-external');
const catalog = JSON.parse(await fs.readFile(path.join(directory, 'catalog.json'), 'utf8'));
const provider = { ...catalog.providers.find(item => item.id === 'otzar'), href: `${baseUrl}external/otzar/index.html` };
const entry = provider.pages[0];
const records = JSON.parse(await fs.readFile(path.join(directory, entry.file), 'utf8')).records;
const sourceRecord = records[0];
const enriched = record => ({ ...record, providerUrl: record.url, url: `${baseUrl}external/${record.provider}/${entry.page}.html#${record.id}` });

function elements(html) {
  const found = [];
  const walk = node => { if (node.tagName) found.push(node); for (const child of node.childNodes || []) walk(child); };
  walk(parseFragment(html));
  return found;
}
const attribute = (element, name) => element.attrs?.find(item => item.name === name)?.value;

test('actual external records retain native URLs, stable anchors and bibliographic data', () => {
  const html = externalProviderPage({ baseUrl, provider, records: records.map(enriched), source: catalog.source });
  const nodes = elements(html);
  for (const record of records) {
    assert(nodes.some(node => attribute(node, 'id') === record.id));
    assert(nodes.some(node => node.tagName === 'a' && attribute(node, 'href') === record.url));
    assert(nodes.some(node => node.tagName === 'a' && attribute(node, 'href') === enriched(record).url));
  }
  assert(html.includes('מקום הדפסה'));
  assert(html.includes('ירושלים'));
  assert(!html.includes('external-search.js'), 'Static catalogue pages should not initialize search');
});

test('untrusted external metadata remains text and cannot replace provider URLs or IDs', () => {
  const malicious = { ...enriched(sourceRecord), title: '<img src=x onerror=alert(1)>', authors: ['<script>alert(1)</script>'], volume: '" onmouseover="alert(1)' };
  const html = externalProviderPage({ baseUrl, provider, records: [malicious] });
  const nodes = elements(html);
  assert(!nodes.some(node => ['img', 'script'].includes(node.tagName)));
  assert(!nodes.some(node => node.attrs.some(attr => attr.name.startsWith('on'))));
  assert(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.throws(() => externalProviderPage({ baseUrl, provider, records: [{ ...malicious, providerUrl: 'javascript:alert(1)' }] }), /Invalid external catalogue record/);
  assert.throws(() => externalProviderPage({ baseUrl, provider, records: [{ ...malicious, id: 'external-otzar-2" onclick="alert(1)' }] }), /Invalid external catalogue record/);
});

test('provider index links every explicit bucket and pagination does not assume consecutive native IDs', () => {
  const pages = [{ number: 1, page: 1, count: 3, url: `${baseUrl}external/otzar/1.html` }, { number: 2, page: 347, count: 2, url: `${baseUrl}external/otzar/347.html` }];
  const html = externalProviderIndexPage({ baseUrl, provider, pages });
  for (const page of pages) assert(elements(html).some(node => attribute(node, 'href') === page.url));
  const recordPage = externalProviderPage({ baseUrl, provider, records: [enriched(sourceRecord)], pagination: { currentPage: 1, totalPages: 2, next: pages[1].url, pages } });
  assert(recordPage.includes('עמוד 1 מתוך 2'));
  assert(recordPage.includes('/external/otzar/347.html'));
});

test('core navigation advertises the external catalogue only when it is included', () => {
  const count = catalog.counts.records;
  for (const render of [homePage, catalogPage, aboutPage, developersPage]) {
    assert(!render({ baseUrl }).includes('external/index.html'));
    assert(render({ baseUrl, stats: { externalRecords: count } }).includes(`${baseUrl}external/index.html`));
  }
  assert(!layout({ title: 'בדיקה', baseUrl }).includes('has-external'));
  assert(layout({ title: 'בדיקה', baseUrl, hasExternal: true }).includes('has-external'));
  const providerLinks = catalog.providers.map(item => ({ ...item, href: `${baseUrl}external/${item.id}/index.html` }));
  const landing = externalHomePage({ baseUrl, providers: providerLinks, counts: catalog.counts });
  assert(landing.includes(`${baseUrl}external/hebrewbooks/index.html`));
  const search = externalSearchPage({ baseUrl, providers: providerLinks, counts: catalog.counts });
  assert(search.includes(`${baseUrl}external-search.js`));
  assert(search.includes('value="hebrewbooks"'));
});

test('source homepages and mapped editions are confined to the book overview', () => {
  const book = { id: 'b-1', title: 'בראשית', categories: ['תנ״ך'], sections: [{ id: 's-1', title: 'פרק א' }] };
  const additional = { ...book, sourceHomepageUrl: 'https://www.sefaria.org/', mappedOtzarReferences: [{ provider: 'otzar', id: 1, title: 'מהדורה מקושרת', url: 'https://tablet.otzar.org/book/book.php?book=1' }] };
  const section = { ...book.sections[0], html: '<p>בראשית ברא</p>' };
  assert.equal(readingPage({ book, section, baseUrl }), readingPage({ book: additional, section, baseUrl }));
  const overview = bookPage({ book: additional, baseUrl });
  assert(overview.includes('אתר המקור'));
  assert(overview.includes('מהדורה מקושרת'));
});

test('external search links remain in their matching catalogue and exact native provider', () => {
  const origin = 'https://example.test';
  const valid = `${baseUrl}external/hebrewbooks/71.html#external-hebrewbooks-14020`;
  assert.equal(safeExternalResultUrl(valid, baseUrl, origin)?.providerId, '14020');
  for (const invalid of ['https://other.test' + valid, `${baseUrl}books/b-1/index.html`, valid.replace('#external-hebrewbooks-', '#external-otzar-'), `${baseUrl}external/hebrewbooks/../index.html#external-hebrewbooks-14020`]) assert.equal(safeExternalResultUrl(invalid, baseUrl, origin), null);
  assert.equal(safeProviderUrl('https://hebrewbooks.org/14020', 'hebrewbooks', '14020'), 'https://hebrewbooks.org/14020');
  assert.equal(safeProviderUrl('https://tablet.otzar.org/book/book.php?book=1', 'otzar', '1'), 'https://tablet.otzar.org/book/book.php?book=1');
  for (const invalid of ['javascript:alert(1)', 'https://evil.test/14020', 'https://hebrewbooks.org/14021', 'https://hebrewbooks.org/14020?redirect=https://evil.test', 'https://user:pass@hebrewbooks.org/14020']) assert.equal(safeProviderUrl(invalid, 'hebrewbooks', '14020'), null);
  assert.equal(normalizeMetadataQuery('בְּרֵאשִׁית'), 'בראשית');
  assert.equal(normalizeMetadataQuery('"בית מאיר"'), '"בית מאיר"');
  assert.equal(normalizeMetadataQuery('"בית מאיר'), 'בית מאיר');
});
