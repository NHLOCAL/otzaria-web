import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'parse5';
import { getConfig } from '../src/config.mjs';

const config=getConfig();const root=config.outputDir;const failures=[];const cache=new Map();let count=0;
async function* walk(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const item=path.join(dir,entry.name);if(entry.isDirectory())yield*walk(item);else yield item;}}
function nodes(node,out=[]){if(node.tagName)out.push(node);for(const child of node.childNodes||[])nodes(child,out);return out;}
const attr=(node,name)=>node.attrs?.find(a=>a.name===name)?.value;
const memoFile=async p=>{if(!cache.has(p))cache.set(p,await fs.access(p).then(()=>true,()=>false));return cache.get(p);};
const manifest=JSON.parse(await fs.readFile(path.join(root,'build-manifest.json'),'utf8'));
if(manifest.search.status!=='ready') failures.push('Search index is not complete');
for await(const file of walk(root)){
  if(!file.endsWith('.html'))continue;
  const relative=path.relative(root,file);const content=await fs.readFile(file,'utf8');const all=nodes(parse(content));count++;
  const html=all.find(n=>n.tagName==='html');
  if(attr(html,'lang')!=='he'||attr(html,'dir')!=='rtl') failures.push(`${relative}: missing Hebrew RTL document attributes`);
  if(all.filter(n=>n.tagName==='h1').length!==1)failures.push(`${relative}: expected exactly one H1`);
  const canonical=all.find(n=>n.tagName==='link'&&attr(n,'rel')==='canonical');
  const expected=`${config.origin}${config.basePath}${relative.split(path.sep).join('/')}`;
  if(attr(canonical,'href')!==expected)failures.push(`${relative}: canonical mismatch (${attr(canonical,'href')})`);
  const ownIds=all.map(n=>attr(n,'id')).filter(Boolean);if(new Set(ownIds).size!==ownIds.length)failures.push(`${relative}: duplicate element IDs`);
  const schemas=all.filter(n=>n.tagName==='script'&&attr(n,'type')==='application/ld+json');
  for(const schema of schemas){try{JSON.parse(schema.childNodes.map(n=>n.value||'').join(''));}catch{failures.push(`${relative}: invalid JSON-LD`);}}
  for(const node of all){
    if(node.attrs?.some(a=>/^on/i.test(a.name)))failures.push(`${relative}: inline event handler`);
    for(const name of ['href','src']){
      const link=attr(node,name);if(!link||/^(?:https?:|mailto:|data:|tel:)/i.test(link))continue;
      if(link.startsWith('#')){if(link.length>1&&!ownIds.includes(decodeURIComponent(link.slice(1))))failures.push(`${relative}: broken fragment ${link}`);continue;}
      const url=new URL(link,expected);
      if(!url.pathname.startsWith(config.basePath)){failures.push(`${relative}: link escapes deployment base ${link}`);continue;}
      const target=path.join(root,decodeURIComponent(url.pathname.slice(config.basePath.length))||'index.html');
      if(!(await memoFile(target)))failures.push(`${relative}: broken ${name} ${link}`);
    }
  }
  if(relative.startsWith(`books${path.sep}`)&&!relative.endsWith(`${path.sep}index.html`)&&!relative.includes('contents-')){
    const body=all.find(n=>n.attrs?.some(a=>a.name==='data-pagefind-body'));
    if(!body)failures.push(`${relative}: no full-text search body`);
  }
}
if(count!==manifest.counts.htmlPages)failures.push('HTML count does not match build manifest');
if(failures.length){console.error(failures.slice(0,50).join('\n'));throw new Error(`${failures.length} static verification failure(s)`);}
console.log(`Verified ${count} HTML documents: Hebrew/RTL, canonical URLs, internal links, anchors, structured data, complete search bodies, and deployment base.`);
