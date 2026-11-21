import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { ROOT, getConfig } from '../src/config.mjs';

const config=getConfig();
const input=JSON.parse(await fs.readFile(path.join(ROOT,'.cache/search-pages.json'),'utf8'));
if(input.outputDir!==config.outputDir) throw new Error('Search input belongs to a different output directory. Rebuild HTML first.');
const totalBytes=input.pages.reduce((sum,p)=>sum+p.bytes,0);
// Large libraries are indexed in bounded sequential subprocesses. Memory is
// released between shards. The browser merges the static Pagefind bundles.
const requested=Number(process.env.SEARCH_SHARDS || Math.min(64,Math.max(1,Math.ceil(totalBytes/(160*1024*1024)))));
if(!Number.isSafeInteger(requested)||requested<1||requested>128) throw new Error('SEARCH_SHARDS must be an integer from 1 to 128');
const buckets=Array.from({length:requested},()=>[]);
for(const page of input.pages){
  const value=createHash('sha256').update(page.bookId).digest().readUInt32BE(0);
  buckets[value%requested].push(page);
}
const shards=[];
for(let i=0;i<buckets.length;i++){
  if(!buckets[i].length) continue;
  const name=shards.length===0?'pagefind':`pagefind/shard-${String(i).padStart(3,'0')}`;
  const job=path.join(ROOT,`.cache/search-job-${i}.json`);
  await fs.writeFile(job,JSON.stringify({outputDir:config.outputDir,basePath:config.basePath,bundle:name,pages:buckets[i]}));
  await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.join(ROOT,'scripts/index-shard.mjs'),job],{stdio:'inherit',env:process.env});
    child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(`Search shard ${i} failed (${code})`)));
  });
  await fs.rm(job,{force:true});
  shards.push({bundlePath:`${config.basePath}${name}/`,pages:buckets[i].length,categories:[...new Set(buckets[i].map(p=>p.category))]});
}
if(!shards.length) throw new Error('Refusing to publish an empty search index');
await fs.writeFile(path.join(config.outputDir,'search-manifest.json'),JSON.stringify({schemaVersion:1,engine:'pagefind',version:'1.6.0',language:'he',pages:input.pages.length,shards},null,2));
const manifestPath=path.join(config.outputDir,'build-manifest.json');
const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
manifest.search={status:'ready',pages:input.pages.length,shards:shards.length};
await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2));
console.log(`Search built: ${input.pages.length} complete reading pages in ${shards.length} static index shard(s)`);
