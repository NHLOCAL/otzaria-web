import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve,relative,sep,join} from 'node:path';
import {spawn} from 'node:child_process';

export const sha256 = value => createHash('sha256').update(value).digest('hex');
export function safePath(root,path) {
  if(typeof path!=='string'||!path||path.includes('\0')||path.includes('\\')||path.startsWith('/')||path.split('/').some(x=>x==='.'||x==='..')) throw new Error(`Unsafe relative path: ${path}`);
  const candidate=resolve(root,path),rel=relative(resolve(root),candidate);
  if(!rel||rel.startsWith(`..${sep}`)) throw new Error(`Unsafe relative path: ${path}`);
  return candidate;
}
export async function verifySnapshot(directory) {
  const catalog=JSON.parse(await readFile(join(directory,'catalog.json'),'utf8'));
  if(catalog.schemaVersion!==1||!Array.isArray(catalog.books)||!catalog.books.length||!Array.isArray(catalog.sources)) throw new Error('Invalid or empty library catalog.');
  const ids=new Set();
  const sidecars=new Set();
  for(const book of catalog.books) {
    if(!/^b-\d+(?:-v-\d+)?$/.test(book.id)||ids.has(book.id)) throw new Error(`Invalid or duplicate book ID: ${book.id}`);
    ids.add(book.id);
    if(book.file!==`books/${book.id}.txt`||!book.license?.attribution||!book.sourceUrl) throw new Error(`Missing source metadata: ${book.id}`);
    const bytes=await readFile(safePath(directory,book.file));
    new TextDecoder('utf-8',{fatal:true}).decode(bytes);
    if(sha256(bytes)!==book.contentSha256) throw new Error(`Snapshot integrity check failed: ${book.id}`);
    for(const [field,digest] of [['lineIdsFile','lineIdsSha256'],['linksFile','linksSha256']]) {
      if(book[field]&&!sidecars.has(book[field])) {
        const content=await readFile(safePath(directory,book[field]));
        if(sha256(content)!==book[digest]) throw new Error(`Snapshot sidecar integrity check failed: ${book[field]}`);
        sidecars.add(book[field]);
      }
    }
  }
  if(catalog.media) {
    const bytes=await readFile(safePath(directory,catalog.media.file));
    if(sha256(bytes)!==catalog.media.sha256) throw new Error('Media manifest integrity check failed.');
    const media=JSON.parse(bytes);
    const checked=new Set();
    for(const item of media.images) {
      if(checked.has(item.file)) continue;
      const data=await readFile(safePath(directory,item.file));
      if(data.byteLength!==item.bytes||sha256(data)!==item.sha256) throw new Error(`Media integrity check failed: ${item.file}`);
      checked.add(item.file);
    }
  }
  return catalog;
}
function runImporter(options,check=false) {
  return new Promise((resolveResult,reject)=>{
    const args=[join(options.root,'scripts/sync_library.py'),'--root',options.root,'--profile',options.profile||'full'];
    if(options.output) args.push('--output',options.output);
    if(options.offline) args.push('--offline');
    if(check) args.push('--check');
    const process=spawn('python3',args,{stdio:['ignore','pipe','inherit']});
    let output='';process.stdout.setEncoding('utf8');process.stdout.on('data',chunk=>output+=chunk);
    process.on('error',reject);process.on('close',code=>{
      if(code!==0) reject(new Error(`Library synchronization failed (exit ${code}). The previous snapshot was preserved.`));
      else {try{resolveResult(JSON.parse(output.trim()));}catch(error){reject(new Error(`Invalid importer summary: ${error.message}`));}}
    });
  });
}
export const syncLibrary=options=>runImporter(options);
export const checkUpstream=options=>runImporter(options,true);
