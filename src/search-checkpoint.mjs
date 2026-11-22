import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

const digest=value=>createHash('sha256').update(value).digest('hex');
async function inventory(bundle){
  const files=[];
  async function walk(directory,relative=''){
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      // Other completed shards live below the primary bundle.
      if(!relative&&entry.isDirectory()&&entry.name.startsWith('shard-'))continue;
      const name=relative?`${relative}/${entry.name}`:entry.name;
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(file,name);
      else if(entry.isFile())files.push([name,(await fs.stat(file)).size]);
      else throw new Error('Unsupported file in search checkpoint');
    }
  }
  await walk(bundle);
  if(!files.some(([name])=>name==='pagefind.js')||!files.some(([name])=>name==='pagefind-worker.js')||!files.some(([name])=>name.endsWith('.pf_meta'))||!files.some(([name])=>name.endsWith('.pagefind')))throw new Error('Incomplete search bundle');
  files.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);
  return {files:files.length,inventorySha256:digest(JSON.stringify(files))};
}
export function checkpointIdentity({outputDir,basePath,builtAt,indexerSource,pages,key,cacheDir}){
  const scope=digest(JSON.stringify({outputDir,basePath,builtAt,indexer:digest(indexerSource)}));
  return {file:path.join(cacheDir,scope,`${key}.json`),fingerprint:digest(JSON.stringify(pages)),pages:pages.length};
}
async function entryIdentity(bundle){
  const bytes=await fs.readFile(path.join(bundle,'pagefind-entry.json'));
  const entry=JSON.parse(bytes);
  if(entry.version!=='1.6.0'||!entry.languages?.he||Object.keys(entry.languages).length!==1)throw new Error('Unexpected checkpoint index version or language');
  return {entrySha256:digest(bytes),pages:entry.languages.he.page_count};
}
export async function readCheckpoint(identity,bundle){
  try{
    const receipt=JSON.parse(await fs.readFile(identity.file,'utf8'));
    if(receipt.fingerprint!==identity.fingerprint||receipt.pages!==identity.pages)return false;
    const entry=await entryIdentity(bundle);
    if(entry.pages!==identity.pages||entry.entrySha256!==receipt.entrySha256)return false;
    const actual=await inventory(bundle);
    return actual.files===receipt.files&&actual.inventorySha256===receipt.inventorySha256;
  }catch{return false;}
}
export async function writeCheckpoint(identity,bundle){
  const entry=await entryIdentity(bundle);
  if(entry.pages!==identity.pages)throw new Error('Completed search shard does not contain every requested page');
  await fs.mkdir(path.dirname(identity.file),{recursive:true});
  const temporary=`${identity.file}.tmp`;
  await fs.writeFile(temporary,JSON.stringify({...entry,...await inventory(bundle),fingerprint:identity.fingerprint}));
  await fs.rename(temporary,identity.file);
}
