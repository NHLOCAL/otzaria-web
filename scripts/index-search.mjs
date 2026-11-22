import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, getConfig } from '../src/config.mjs';
import { planSearchShards, DEFAULT_MAX_SHARD_BYTES } from '../src/search-plan.mjs';
import { checkpointIdentity, readCheckpoint, writeCheckpoint } from '../src/search-checkpoint.mjs';

const config=getConfig();
const input=JSON.parse(await fs.readFile(path.resolve(ROOT,process.env.SEARCH_INPUT||'.cache/search-pages.json'),'utf8'));
if(input.outputDir!==config.outputDir) throw new Error('Search input belongs to a different output directory. Rebuild HTML first.');
if(!/^dist(?:[-_][a-z0-9_-]+)?$/i.test(path.relative(ROOT,config.outputDir)))throw new Error('Search output must be a dedicated dist directory');
const manifestPath=path.join(config.outputDir,'build-manifest.json');
const build=JSON.parse(await fs.readFile(manifestPath,'utf8'));
const indexerSource=await fs.readFile(path.join(ROOT,'scripts/index-shard.mjs'),'utf8');
const resume=process.env.SEARCH_RESUME==='1';
const batchLimit=process.env.SEARCH_BATCH_LIMIT===undefined?Infinity:Number(process.env.SEARCH_BATCH_LIMIT);
if(batchLimit!==Infinity&&(!Number.isSafeInteger(batchLimit)||batchLimit<1))throw new Error('SEARCH_BATCH_LIMIT must be a positive integer');
if(!resume)await fs.rm(path.join(config.outputDir,'pagefind'),{recursive:true,force:true});
build.search={status:'pending',pages:input.pages.length};
await fs.writeFile(manifestPath,JSON.stringify(build,null,2));
const totalBytes=input.pages.reduce((sum,p)=>sum+p.bytes,0);
// Large libraries are indexed in bounded subprocesses; each releases its
// memory on exit. The browser merges the static Pagefind bundles.
const maxBytes=Number(process.env.SEARCH_SHARD_BYTES || DEFAULT_MAX_SHARD_BYTES);
if(!Number.isSafeInteger(maxBytes)||maxBytes<1_000_000||maxBytes>512*1024*1024)throw new Error('SEARCH_SHARD_BYTES must be between 1,000,000 and 536,870,912 bytes');
const requested=Number(process.env.SEARCH_SHARDS || Math.min(64,Math.max(1,Math.ceil(totalBytes/maxBytes))));
if(!Number.isSafeInteger(requested)||requested<1||requested>128) throw new Error('SEARCH_SHARDS must be an integer from 1 to 128');
const plan=planSearchShards(input.pages,{requested,maxBytes});
console.log(`Search plan: ${input.pages.length} pages in ${plan.length} shards; each body input is at most ${(maxBytes/1024/1024).toFixed(1)} MiB`);
// The root Pagefind bundle owns the directory containing all nested bundles.
// Finish it before indexing independent child bundles concurrently.
const concurrency=Number(process.env.SEARCH_CONCURRENCY ?? 2);
if(!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('SEARCH_CONCURRENCY must be an integer from 1 to 8');
const descriptors=plan.map((shard,index)=>({
  ...shard,
  name:index===0?'pagefind':`pagefind/shard-${shard.key}`,
}));
for(const item of descriptors){
  item.bundle=path.join(config.outputDir,item.name);
  item.checkpoint=checkpointIdentity({outputDir:config.outputDir,basePath:config.basePath,builtAt:build.builtAt,indexerSource,pages:item.pages,key:item.key,cacheDir:path.join(ROOT,'.cache/search-checkpoints')});
  item.complete=resume&&await readCheckpoint(item.checkpoint,item.bundle);
  if(item.complete)console.log(`Reused verified search shard ${item.key}: ${item.pages.length} pages`);
}
const allPending=descriptors.filter(item=>!item.complete);
const selected=allPending.slice(0,batchLimit);
const deferred=selected.length<allPending.length;
async function indexOne(item){
  // Never remove child bundle directories while updating the primary index.
  for(const entry of await fs.readdir(item.bundle,{withFileTypes:true}).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))){
    if(item.name==='pagefind'&&entry.isDirectory()&&entry.name.startsWith('shard-'))continue;
    await fs.rm(path.join(item.bundle,entry.name),{recursive:true,force:true});
  }
  const job=path.join(ROOT,`.cache/search-job-${path.basename(config.outputDir)}-${item.key}.json`);
  try{
    await fs.writeFile(job,JSON.stringify({outputDir:config.outputDir,basePath:config.basePath,bundle:item.name,pages:item.pages}));
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(ROOT,'scripts/index-shard.mjs'),job],{stdio:'inherit',env:process.env});
      child.once('error',reject);
      child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`Search shard ${item.key} failed (${signal||code}); ${item.pages.length} pages, ${(item.bytes/1024/1024).toFixed(1)} MiB input. Search remains unpublished. If memory is constrained, lower SEARCH_CONCURRENCY or SEARCH_SHARD_BYTES.`)));
    });
    await writeCheckpoint(item.checkpoint,item.bundle);
  }finally{
    await fs.rm(job,{force:true});
  }
}
// Bound parallelism to protect memory on small builders. Once one shard fails,
// wait for already-running workers to finish, then leave the manifest pending.
async function runBounded(items,limit,worker){
  let cursor=0, failure=null;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(!failure){
      const index=cursor++;
      if(index>=items.length)return;
      try{await worker(items[index]);}catch(error){failure??=error;}
    }
  }));
  if(failure)throw failure;
}
if(selected[0]?.name==='pagefind')await indexOne(selected[0]);
const remaining=selected.filter(item=>item.name!=='pagefind');
await runBounded(remaining,concurrency,indexOne);
if(deferred){
  console.error('Search batch finished; remaining shards are pending. Run again with SEARCH_RESUME=1. This incomplete build must not be published.');
  process.exit(2);
}
const shards=descriptors.map(shard=>({bundlePath:`${config.basePath}${shard.name}/`,pages:shard.pages.length,bodyBytes:shard.bytes,categories:[...new Set(shard.pages.map(p=>p.category))]}));
if(!shards.length) throw new Error('Refusing to publish an empty search index');
await fs.writeFile(path.join(config.outputDir,'search-manifest.json'),JSON.stringify({schemaVersion:1,engine:'pagefind',version:'1.6.0',language:'he',pages:input.pages.length,shards},null,2));
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
manifest.search={status:'ready',pages:input.pages.length,shards:shards.length,maxShardBytes:maxBytes};
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log(`Search built: ${input.pages.length} complete reading pages in ${shards.length} static index shard(s)`);
