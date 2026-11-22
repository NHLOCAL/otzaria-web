import fs from 'node:fs/promises';
import path from 'node:path';
import * as pagefind from 'pagefind';
import {contentReader} from '../src/search-input.mjs';

const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const started=performance.now();
const {index,errors}=await pagefind.createIndex({forceLanguage:'he',keepIndexUrl:true,writePlayground:false,verbose:false,...(job.maxFragments?{maxFragments:job.maxFragments}:{})});
if(errors?.length||!index) throw new Error(`Pagefind create: ${JSON.stringify(errors)}`);
try{
  let processed=0;
  const read=contentReader({root:job.root,outputDir:job.outputDir});
  for(const page of job.pages){
    const {content}=await read(page);
    const response=await index.addHTMLFile({url:`${job.basePath}${page.path}`,content});
    if(response.errors?.length) throw new Error(`Pagefind ${page.path}: ${JSON.stringify(response.errors)}`);
    if(++processed%1000===0)console.log(`${job.bundle}: indexed ${processed}/${job.pages.length} pages in ${((performance.now()-started)/1000).toFixed(1)}s`);
  }
  const written=await index.writeFiles({outputPath:path.join(job.outputDir,job.bundle)});
  if(written.errors?.length) throw new Error(`Pagefind write: ${JSON.stringify(written.errors)}`);
  console.log(`Indexed ${job.pages.length} pages into ${job.bundle} in ${((performance.now()-started)/1000).toFixed(1)}s`);
}finally{await index.deleteIndex();await pagefind.close();}
