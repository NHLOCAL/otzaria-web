import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHtml } from '../src/verify-html.mjs';
const options = { relative: 'books/b-1/s-1.html', origin: 'https://example.org', basePath: '/library/', files: new Set(['index.html', 'books/b-1/index.html']) };
const html = '<!doctype html><html lang="he" dir="rtl"><head><link rel="canonical" href="https://example.org/library/books/b-1/s-1.html"><script type="application/ld+json">{"name":"ספר"}</script></head><body><h1>ספר</h1><article data-pagefind-body><p id="p-1">טקסט</p><a href="#p-1">פסקה</a><a href="./index.html">תוכן</a><a href="/library/">בית</a></article></body></html>';
test('one-pass verifier retains canonical, RTL, schema, source-body and link coverage',()=>{
  assert.deepEqual(verifyHtml(html,options),[]);
  for(const [before,after,expected] of [
    ['dir="rtl"','dir="ltr"','RTL'],['<h1>','<h2>','H1'],['"name":"ספר"','invalid','JSON-LD'],
    ['data-pagefind-body','data-other','full-text'],['#p-1','#missing','broken fragment'],
    ['id="p-1"','id="p-1" onclick="bad()"','event handler'],['./index.html','../missing.html','broken href'],
    ['/library/">בית','/elsewhere/">בית','escapes'],['#p-1','#%ZZ','invalid href'],
  ]) assert.ok(verifyHtml(html.replace(before,after),options).some(error=>error.includes(expected)),expected);
  assert.ok(verifyHtml(html.replace('</article>','<p id="p-1">שכפול</p></article>'),options).some(error=>error.includes('duplicate')));
  assert.ok(verifyHtml(html.replace('href="https://example.org/library/books/b-1/s-1.html"','href="https://example.org/wrong"'),options).some(error=>error.includes('canonical')));
});
