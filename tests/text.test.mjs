import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize,parseBook,sanitizeInline,normalizeHebrew,hash } from '../src/text.mjs';
import { normalizeBase,getConfig } from '../src/config.mjs';
import { sitemapDocuments } from '../src/sitemap.mjs';
import { parseFragment } from 'parse5';

test('plain text fast path retains parser-equivalent Unicode, escaping and source lines',()=>{
  const samples=['  בְּרֵאשִׁית בָּרָא  ', 'אב > גד', '"quoted" and \'apostrophe\'', 'שלום\tעולם', 'A 😀 Z', '\u00a0טקסט\u00a0', '  '];
  for(const value of samples){
    const tree=parseFragment(value);
    const expected=tree.childNodes.map(node=>node.value||'').join('').trim();
    const tokens=tokenize(`\n${value}\n`);
    assert.equal(tokens.length,expected?1:0);
    if(expected){assert.equal(tokens[0].text,expected);assert.equal(tokens[0].line,2);assert.equal(parseFragment(tokens[0].html).childNodes.map(node=>node.value||'').join(''),expected);}
  }
  assert.equal(tokenize('א &amp; ב')[0].text,'א & ב');
  assert.equal(tokenize('<b>א</b>')[0].html,'<b>א</b>');
});

test('upstream markup cannot execute scripts or inject unsafe attributes',()=>{
  const input='<b onclick="alert(1)">טקסט</b><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">קישור</a><svg><script>attack</script></svg>';
  assert.equal(sanitizeInline(input),'<b>טקסט</b>קישור');
  assert.equal(tokenize(input)[0].text,'טקסטקישור');
});
test('natural chapter URLs survive edits and earlier different chapters',()=>{
  const a=parseBook('<h1>ספר</h1>\n<h2>פרק א</h2>\nטקסט ראשון\n<h2>פרק ב</h2>\nטקסט שני',{id:'book'});
  const b=parseBook('<h1>ספר</h1>\n<h2>הקדמה</h2>\nחדש\n<h2>פרק א</h2>\nטקסט מתוקן\n<h2>פרק ב</h2>\nטקסט שני',{id:'book'});
  assert.equal(a[0].id,b[1].id);assert.equal(a[1].id,b[2].id);
  assert.match(a[0].html,/data-source-line="3"/);
});
test('canonical source line identifiers survive heading and paragraph edits',()=>{
  const a=parseBook('<h1>ספר</h1>\n<h2>פרק א</h2>\nטקסט',{id:'book'},{lineIds:[100,101,102]});
  const b=parseBook('<h1>ספר</h1>\n<h2>כותרת מתוקנת</h2>\nטקסט מתוקן',{id:'book'},{lineIds:[100,101,102]});
  assert.equal(a[0].id,'s-101');assert.equal(b[0].id,'s-101');
  assert.match(a[0].html,/id="p-l102"/);assert.match(b[0].html,/id="p-l102"/);
});
test('large paragraphs are bounded without losing Hebrew words',()=>{
  const text=Array.from({length:2000},(_,i)=>`מילה${i}`).join(' ');
  const sections=parseBook(`<h1>ספר</h1>\n<h2>פרק א</h2>\n${text}`,{id:'book'},{maxBytes:2000});
  assert.ok(sections.length>3);
  assert.equal(sections.map(s=>s.text).join(' ').replace(/\s+/g,' '),text);
  assert.ok(sections.every(s=>Buffer.byteLength(s.html)<2400));
});
test('verified source images survive image-only lines without executable attributes',()=>{
  const source='data:image/png;base64,fixture ';
  const images=new Map([[hash(source,64),{url:'/otzaria-web/media/example.png',width:40,height:30}]]);
  const sections=parseBook(`<h1>ספר</h1>\n<img src="${source}" alt="תרשים &amp; פירוש" onerror="attack()">\n<img>`,{id:'book'},{images});
  assert.match(sections[0].html,/src="\/otzaria-web\/media\/example.png"/);
  assert.match(sections[0].html,/alt="תרשים &amp; פירוש"/);
  assert.match(sections[0].html,/missing-illustration/);
  assert.doesNotMatch(sections[0].html,/onerror|data:image/);
  assert.match(sections[0].text,/media\/example.png/);
});
test('HTML image tags split across database rows retain the image and original starting line',()=>{
  const source='data:image/png;base64,fixture';
  const images=new Map([[hash(source,64),{url:'/media/image.png',width:40,height:30}]]);
  const sections=parseBook(`<h1>ספר</h1>\n<img\nsrc="${source}" alt="איור > פירוש" >\nהמשך`,{id:'book'},{images,lineIds:[10,11,12,13]});
  assert.match(sections[0].html,/<img class="book-illustration"/);
  assert.match(sections[0].html,/id="p-l11" data-source-line="2"/);
  assert.match(sections[0].html,/id="p-l13" data-source-line="4"/);
  assert.doesNotMatch(sections[0].html,/data:image|base64|src=&quot;/);
});
test('orphan tag endings cannot consume the next database paragraph or heading',()=>{
  const result=tokenize('<h1>ספר</h1>\nפתיח <b\n<b>תשובה</b>\nסיום</small\n<h2>המשך</h2>\nטקסט');
  assert.deepEqual(result.map(t=>[t.text,t.line]),[['ספר',1],['פתיח',2],['תשובה',3],['סיום',4],['המשך',5],['טקסט',6]]);
});
test('long rich paragraphs retain inline formatting, images and every word across pages',()=>{
  const source='data:image/png;base64,fixture';
  const images=new Map([[hash(source,64),{url:'/media/image.png',width:40,height:30}]]);
  const first=Array.from({length:1000},(_,i)=>`מילה${i}`).join(' ');
  const last=Array.from({length:1000},(_,i)=>`סוף${i}`).join(' ');
  const sections=parseBook(`<h1>ספר</h1>\n<b>${first}<img src="${source}" alt="איור"> ${last}</b>`,{id:'book'},{images,maxBytes:2000});
  const html=sections.map(s=>s.html).join('');
  assert.equal((html.match(/<img /g)||[]).length,1);
  assert.equal((html.match(/<b>/g)||[]).length,(html.match(/<\/b>/g)||[]).length);
  const text=sections.map(s=>s.text).join(' ').replace(/\s+/g,' ');
  assert.equal(text,`${first}[איור: /media/image.png] ${last}`);
  assert.ok(sections.every(s=>Buffer.byteLength(s.html)<2500));
});
test('h3-only sources get real sections and repeated headings unique IDs',()=>{
  const result=parseBook('<h1>ספר</h1>\n<h3>פתיחה</h3>\nא\n<h3>פתיחה</h3>\nב',{id:'b'});
  assert.equal(result.length,2);assert.notEqual(result[0].id,result[1].id);
});
test('niqqud and maqaf normalize while HTML source remains untouched',()=>{
  assert.equal(normalizeHebrew('בְּרֵאשִׁית־בָּרָא'),'בראשית ברא');
  const result=parseBook('<h1>ספר</h1>\nבְּרֵאשִׁית בָּרָא',{id:'book'});
  assert.match(result[0].html,/בְּרֵאשִׁית/);
});
test('deployment paths work at root and project subpath and reject escapes',()=>{
  assert.equal(normalizeBase('/'),'/');assert.equal(normalizeBase('otzaria-web'),'/otzaria-web/');
  assert.throws(()=>normalizeBase('../bad'));assert.throws(()=>normalizeBase('//other.test/'));
  assert.throws(()=>getConfig({SITE_URL:'https://site.test/path'}));
});
test('sitemaps split cleanly and reject external canonicals',()=>{
  const entries=Array.from({length:5},(_,i)=>({url:`https://site.test/p${i}.html`}));
  const docs=sitemapDocuments(entries,'https://site.test',{maxUrls:2});
  assert.equal(docs.length,3);assert.ok(docs.every(s=>s.endsWith('</urlset>\n')));
  assert.throws(()=>sitemapDocuments([{url:'https://other.test/'}],'https://site.test'));
});
