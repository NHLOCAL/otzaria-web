import fs from 'node:fs/promises';
import path from 'node:path';
import * as pagefind from 'pagefind';

const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const {index,errors}=await pagefind.createIndex({forceLanguage:'he',keepIndexUrl:true,writePlayground:false,verbose:false});
if(errors?.length||!index) throw new Error(`Pagefind create: ${JSON.stringify(errors)}`);
try{
  for(const page of job.pages){
    const content=await fs.readFile(path.join(job.outputDir,page.path),'utf8');
    const response=await index.addHTMLFile({url:`${job.basePath}${page.path}`,content});
    if(response.errors?.length) throw new Error(`Pagefind ${page.path}: ${JSON.stringify(response.errors)}`);
  }
  const written=await index.writeFiles({outputPath:path.join(job.outputDir,job.bundle)});
  if(written.errors?.length) throw new Error(`Pagefind write: ${JSON.stringify(written.errors)}`);
  console.log(`Indexed ${job.pages.length} pages into ${job.bundle}`);
}finally{await index.deleteIndex();await pagefind.close();}
