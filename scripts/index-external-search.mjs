import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {ROOT,getConfig} from '../src/config.mjs';

const config=getConfig();
const input=JSON.parse(await fs.readFile(path.resolve(ROOT,process.env.EXTERNAL_SEARCH_INPUT||'.cache/external-search-pages.json'),'utf8'));
if(input.outputDir!==config.outputDir)throw new Error('External search input belongs to a different output directory. Rebuild HTML first.');
if(!/^dist(?:[-_][a-z0-9_-]+)?$/i.test(path.relative(ROOT,config.outputDir)))throw new Error('External search output must be a dedicated dist directory');
if(input.basePath!==config.basePath||!Array.isArray(input.pages)||!input.pages.length||!Number.isSafeInteger(input.records)||input.records<1)throw new Error('External search input does not match the built site');
const realRoot=await fs.realpath(ROOT);
const realOutput=await fs.realpath(config.outputDir);
if(realOutput!==path.join(realRoot,path.basename(config.outputDir))||await fs.realpath(path.join(config.outputDir,'external'))!==path.join(realOutput,'external'))throw new Error('External search output must not redirect through a symbolic link');
const manifestPath=path.join(config.outputDir,'build-manifest.json');
const build=JSON.parse(await fs.readFile(manifestPath,'utf8'));
build.externalSearch={status:'pending',records:input.records};
await fs.writeFile(manifestPath,JSON.stringify(build,null,2));
// Remove only generated metadata-search files. Retain catalogue data, core
// search, and reading pages; an interrupted rebuild stays explicitly pending.
await fs.rm(path.join(config.outputDir,'external/pagefind'),{recursive:true,force:true});
// Metadata records are small but numerous. Bound both count and content, then
// release the native index process between batches. Bundled fragments avoid
// creating one CDN object for each bibliographic record.
const maxRecords=5000,maxBytes=16*1024*1024;
const shards=[];let records=[],bytes=0,total=0;
async function flush(){
  if(!records.length)return;
  const bundle=shards.length?`external/pagefind/shard-${String(shards.length).padStart(3,'0')}`:'external/pagefind';
  const job=path.join(ROOT,`.cache/external-search-job-${path.basename(config.outputDir)}-${shards.length}.json`);
  await fs.writeFile(job,JSON.stringify({outputDir:config.outputDir,bundle,records}));
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(ROOT,'scripts/index-external-shard.mjs'),job],{stdio:'inherit',env:process.env});
    child.on('error',reject);
    child.on('exit',(code,signal)=>code===0?resolve():reject(new Error(`External search shard failed (${signal||code}); publication remains incomplete.`)));
  });
  await fs.rm(job,{force:true});
  shards.push({bundlePath:`${config.basePath}${bundle}/`,records:records.length,providers:[...new Set(records.map(record=>record.meta.provider))]});
  total+=records.length;records=[];bytes=0;
}
for(const page of input.pages){
  const file=path.resolve(config.outputDir,page.path);
  if(!file.startsWith(config.outputDir+path.sep))throw new Error('External search page escapes output');
  const data=JSON.parse(await fs.readFile(file,'utf8'));
  if(data.records.length!==page.records)throw new Error('External catalogue search count mismatch');
  for(const item of data.records){
    const originalContent=[item.title,item.author,item.volume,item.year,item.yearEnd,item.place,item.subjects].flat().filter(value=>value!==undefined&&value!==null&&value!=='').join(' ');
    // Pagefind retains a positional gap for standalone punctuation tokens.
    // Removing those from search content lets quoted titles cross a separator
    // such as "מקראות גדולות - בראשית". Display metadata stays verbatim.
    const content=originalContent.split(/\s+/u).filter(token=>!/^\p{P}+$/u.test(token)).join(' ')||originalContent||'ללא כותרת במקור';
    const record={url:item.url,language:'he',content,meta:{title:String(item.title||'ללא כותרת במקור'),author:String(item.author||''),provider:page.provider,provider_name:page.providerName,provider_url:item.providerUrl},filters:{provider:[page.provider]}};
    if(typeof record.url!=='string'||!record.url.startsWith(`${config.basePath}external/`)||typeof record.meta.provider_url!=='string')throw new Error('External search record has invalid URLs');
    const size=Buffer.byteLength(JSON.stringify(record));
    if(size>maxBytes)throw new Error(`External metadata record exceeds search input budget: ${item.id}`);
    if(records.length&&(records.length>=maxRecords||bytes+size>maxBytes))await flush();
    records.push(record);bytes+=size;
  }
}
await flush();
if(!total||total!==input.records)throw new Error('Refusing to publish incomplete external catalogue search');
await fs.writeFile(path.join(config.outputDir,'external/search-manifest.json'),JSON.stringify({schemaVersion:1,engine:'pagefind',version:'1.6.0',language:'he',records:total,shards},null,2));
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
manifest.externalSearch={status:'ready',records:total,shards:shards.length};
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log(`External search complete: ${total} metadata records in ${shards.length} static index shard(s)`);
