import test from 'node:test';
import assert from 'node:assert/strict';
import { bookPartition, parsePartition, partitionFingerprint, relativeFile } from '../src/build-parts.mjs';
import { readingArticle, readingPage } from '../src/ui.mjs';
import { parseFragment, serializeOuter } from 'parse5';

test('build partition contracts reject ambiguous input and preserve complete edition families',()=>{
  assert.deepEqual(parsePartition('0/8'),{index:0,total:8});
  for(const value of ['1/1','-1/8','1/0','0/17','0.1/8','0/8/3']) assert.throws(()=>parsePartition(value));
  for(const total of [1,2,8,16]) for(let id=1;id<100;id++){
    const original=bookPartition({id:`b-${id}`},total);
    assert.equal(bookPartition({id:`b-${id}-v-300`,editionOf:`b-${id}`},total),original);
    assert.ok(original>=0&&original<total);
  }
  assert.throws(()=>relativeFile('../outside'));
  assert.throws(()=>relativeFile('file\nname'));
});
test('empty partition result caches cannot alias different archive names and identities',()=>{
  const inputs={context:{partitions:8},books:[],sources:[]};
  assert.notEqual(partitionFingerprint({...inputs,index:0}),partitionFingerprint({...inputs,index:7}));
});
test('compact search input is the identical full reading article, preserving metadata and anchors',()=>{
  const book={id:'b-1',title:'ספר "בדיקה"',categories:['תנ״ך'],license:{name:'Public Domain'},sourceUrl:'https://example.org',sections:[]};
  const section={id:'s-1',title:'פרק א',html:'<p id="p-l2">בְּרֵאשִׁית <b>ברא</b> אלהים</p>'};
  const tree=parseFragment(readingPage({book,section}));
  const find=node=>node.tagName==='article'?node:(node.childNodes||[]).map(find).find(Boolean);
  const compact=parseFragment(readingArticle({book,section})).childNodes[0];
  assert.equal(serializeOuter(find(tree)),serializeOuter(compact));
});
