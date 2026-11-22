// Exercise the actual transfer boundary, not just an in-memory plan. Each
// worker's source subset and the final source-free book assembly are real tar
// archives, real HTML and real Pagefind indexes.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT } from '../src/config.mjs';

const workspace=path.join(ROOT,`.cache/partition-test-${process.pid}`);
await fs.mkdir(workspace,{recursive:true});
for(const directory of ['scripts','src','public','data'])await fs.cp(path.join(ROOT,directory),path.join(workspace,directory),{recursive:true,filter:file=>!file.includes('__pycache__')});
for(const file of ['package.json','package-lock.json'])await fs.copyFile(path.join(ROOT,file),path.join(workspace,file));
await fs.symlink(path.join(ROOT,'node_modules'),path.join(workspace,'node_modules'),'dir');
const environment={...process.env,LIBRARY_PROFILE:'starter',SOURCE_CATALOG:'data/starter/catalog.json',EXTERNAL_CATALOG:'data/starter-external/catalog.json',BASE_PATH:process.env.BASE_PATH||'/',SITE_URL:'https://example.org',OUTPUT_DIR:'dist',BUILD_PARTITIONS:'2',BUILD_DATE:'2026-11-22T00:00:00.000Z',SEARCH_CACHE:'0',SEARCH_CONCURRENCY:'1',DEPLOY_TARGET:'cloudflare-r2'};
for(const key of ['BUILD_PARTITION','BUILD_ASSEMBLE','SEARCH_FINALIZE','SEARCH_INPUT','EXTERNAL_SEARCH_INPUT','GITHUB_OUTPUT','GITHUB_SHA'])delete environment[key];
const commands=[];
async function run(command,args=[],extra={},expected=0){
  const start=performance.now();
  const result=await new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:workspace,env:{...environment,...extra},stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
    child.once('error',reject);child.once('close',code=>resolve({code,output}));
  });
  commands.push({command:[command,...args].join(' '),seconds:(performance.now()-start)/1000,exitCode:result.code});
  if(expected===0&&result.code!==0)throw new Error(`${command} ${args.join(' ')} failed:\n${result.output}`);
  if(expected!==0&&result.code===0)throw new Error(`Negative integration check unexpectedly succeeded: ${args.join(' ')}`);
  return result.output;
}
const node=(script,extra={},expected=0)=>run(process.execPath,[script],extra,expected);
const json=async relative=>JSON.parse(await fs.readFile(path.join(workspace,relative),'utf8'));
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
async function htmlInventory(directory){
  const result=new Map();
  async function walk(current){for(const entry of await fs.readdir(current,{withFileTypes:true})){const file=path.join(current,entry.name);if(entry.isDirectory())await walk(file);else if(entry.name.endsWith('.html')||entry.name==='text.txt')result.set(path.relative(directory,file),digest(await fs.readFile(file)));}}
  await walk(directory);return result;
}
let success=false;
try{
  await node('scripts/build.mjs',{OUTPUT_DIR:'dist-reference'});
  const expected=await htmlInventory(path.join(workspace,'dist-reference'));
  await node('scripts/prepare-build-parts.mjs');
  const originalPlan=await json('.cache/build-plan.json');
  for(let index=0;index<2;index++){
    const part=originalPlan.matrix.include[index];
    const listing=await run('tar',['--zstd','-tf',`.cache/transfer/${part.source}`]);
    assert.ok(listing.includes('.cache/build-plan.json'));
    assert.ok(!listing.includes('data/starter-external/records/'),'worker should not receive external catalogue payloads');
    await node('scripts/build.mjs',{BUILD_PARTITION:`${index}/2`});
    assert.equal((await json('dist/build-manifest.json')).partial,true);
    await node('scripts/verify.mjs',{},1);
    await node('scripts/index-search.mjs');
    await node('scripts/package-build-part.mjs',{BUILD_PARTITION:`${index}/2`});
  }
  // Mimic a fresh assembly machine: no book sources, no generated output and
  // no receipts from earlier workers remain outside the archives.
  for(const directory of ['dist','data/starter','data/starter-external','.cache/render-parts','.cache/search-parts','.cache/search-records'])await fs.rm(path.join(workspace,directory),{recursive:true,force:true});
  await run('tar',['--zstd','-xf','.cache/transfer/source-global.tar.zst']);
  assert.equal(await fs.access(path.join(workspace,'data/starter/books')).then(()=>true,()=>false),false);
  await run('tar',['--zstd','-xf','.cache/transfer/result-000.tar.zst']);
  await node('scripts/build.mjs',{BUILD_ASSEMBLE:'1'},1);
  await run('tar',['--zstd','-xf','.cache/transfer/result-001.tar.zst']);
  const receipt=await json('.cache/render-parts/p-000.json');
  const sample=receipt.files.find(file=>file.path.endsWith('.html'));
  assert.ok(sample);
  const target=path.join(workspace,'dist',sample.path),original=await fs.readFile(target),damaged=Buffer.from(original);
  damaged[10]^=1;await fs.writeFile(target,damaged);
  await node('scripts/build.mjs',{BUILD_ASSEMBLE:'1'},1);
  await fs.writeFile(target,original);
  await node('scripts/build.mjs',{BUILD_ASSEMBLE:'1'});
  assert.deepEqual(await htmlInventory(path.join(workspace,'dist')),expected,'all reading/SEO HTML and TXT must match the monolithic build byte-for-byte');
  await node('scripts/index-search.mjs',{SEARCH_FINALIZE:'1'});
  await node('scripts/index-external-search.mjs');
  await node('scripts/check-size.mjs');
  await node('scripts/verify.mjs');
  const manifest=await json('dist/build-manifest.json');
  assert.equal(manifest.counts.books,60);assert.equal(manifest.counts.sections,1545);
  assert.equal(manifest.search.status,'ready');assert.equal(manifest.search.finalizedPartitions,2);
  // New run/global catalogue timestamp, identical book dependencies: both
  // archived partitions are reusable even though global provenance changes.
  await fs.cp(path.join(ROOT,'data/starter'),path.join(workspace,'data/starter'),{recursive:true});
  const catalogue=await json('data/starter/catalog.json');catalogue.generatedAt='2026-11-23T00:00:00.000Z';
  await fs.writeFile(path.join(workspace,'data/starter/catalog.json'),JSON.stringify(catalogue));
  await node('scripts/prepare-build-parts.mjs',{BUILD_DATE:'2026-11-23T00:00:00.000Z'});
  const newPlan=await json('.cache/build-plan.json');
  assert.notEqual(newPlan.sourceFingerprint,originalPlan.sourceFingerprint);
  assert.deepEqual(newPlan.matrix.include.map(item=>item.fingerprint),originalPlan.matrix.include.map(item=>item.fingerprint));
  await node('scripts/build.mjs',{BUILD_ASSEMBLE:'1'});
  await node('scripts/index-search.mjs',{SEARCH_FINALIZE:'1'});
  // Metadata-only edits must invalidate the affected partition too.
  catalogue.books[0].title+=' בדיקה';await fs.writeFile(path.join(workspace,'data/starter/catalog.json'),JSON.stringify(catalogue));
  await node('scripts/prepare-build-parts.mjs');
  assert.ok((await json('.cache/build-plan.json')).matrix.include.some((item,i)=>item.fingerprint!==newPlan.matrix.include[i].fingerprint));
  await node('scripts/build.mjs',{BUILD_ASSEMBLE:'1'},1);
  console.log(JSON.stringify({status:'passed',basePath:environment.BASE_PATH,books:manifest.counts.books,readingPages:manifest.counts.sections,htmlPages:manifest.counts.htmlPages,identicalHtmlAndTextFiles:expected.size,checks:['real partition archives','exact coverage','missing partition rejected','same-size corruption rejected','all HTML/TXT identical','search finalized','all HTML verified','cross-build cache reuse','metadata invalidation'],commands},null,2));
  success=true;
}finally{
  if(success)await fs.rm(workspace,{recursive:true,force:true});
  else console.error(`Integration workspace retained: ${workspace}`);
}
