import fs from 'node:fs/promises';
import path from 'node:path';
import * as pagefind from 'pagefind';

const job=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const {index,errors}=await pagefind.createIndex({forceLanguage:'he',keepIndexUrl:true,writePlayground:false,verbose:false,maxFragments:256});
if(errors?.length||!index)throw new Error(`External Pagefind create: ${JSON.stringify(errors)}`);
try{
  for(const record of job.records){
    const result=await index.addCustomRecord(record);
    if(result.errors?.length)throw new Error(`External Pagefind record ${record.url}: ${JSON.stringify(result.errors)}`);
  }
  const result=await index.writeFiles({outputPath:path.join(job.outputDir,job.bundle)});
  if(result.errors?.length)throw new Error(`External Pagefind write: ${JSON.stringify(result.errors)}`);
  console.log(`Indexed ${job.records.length} external catalogue records into ${job.bundle}`);
}finally{await index.deleteIndex();await pagefind.close();}
