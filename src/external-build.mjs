/** Render the complete metadata catalogue shipped with the native installer. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ROOT,absoluteUrl,sitePath,safeId} from './config.mjs';
import * as ui from './external-ui.mjs';

export async function loadExternalSnapshot(config){
  const file=path.resolve(ROOT,process.env.EXTERNAL_CATALOG||(config.profile==='full'?'.cache/external/catalog.json':'data/starter-external/catalog.json'));
  let catalog;
  try{catalog=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){throw new Error(`The ${config.profile} application profile requires its external metadata catalogue. Run npm run sync. ${error.message}`);}
  if(catalog.schemaVersion!==1||!Array.isArray(catalog.providers)||!catalog.providers.length||!Array.isArray(catalog.mappings))throw new Error('Invalid external catalogue manifest');
  if(config.profile==='full'&&!catalog.scope?.complete)throw new Error('A full build cannot use a sample external catalogue');
  if(catalog.source?.id!=='otzaria-external-catalog'||!Number.isSafeInteger(catalog.counts?.records)||catalog.counts.records<1)throw new Error('Incomplete external catalogue provenance or counts');
  if(catalog.paging?.strategy!=='native-id-buckets'||!Number.isSafeInteger(catalog.paging.size)||catalog.paging.size<1||catalog.paging.size>500)throw new Error('Unsupported external catalogue paging rule');
  const ids=new Set();
  for(const provider of catalog.providers){
    if(!['otzar','hebrewbooks'].includes(provider.id)||ids.has(provider.id)||!Array.isArray(provider.pages)||!provider.pages.length)throw new Error('Invalid external provider manifest');
    ids.add(provider.id);
    let previous=0;
    for(const entry of provider.pages){
      if(!Number.isSafeInteger(entry.page)||entry.page<=previous)throw new Error('External catalogue buckets must have increasing native IDs');
      previous=entry.page;
    }
  }
  return {catalog,directory:path.dirname(file)};
}

async function readVerified(snapshot,entry){
  const file=path.resolve(snapshot.directory,entry.file);
  if(!file.startsWith(snapshot.directory+path.sep)||!/^(records|mappings)\/[a-z0-9_-]+\.json$/.test(entry.file))throw new Error('External snapshot page escapes its directory');
  const bytes=await fs.readFile(file);
  if(bytes.length!==entry.bytes||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error(`External catalogue checksum mismatch: ${entry.file}`);
  const payload=JSON.parse(bytes);
  if(payload.schemaVersion!==1||!Array.isArray(payload.records)||payload.records.length!==entry.count)throw new Error(`External catalogue page count mismatch: ${entry.file}`);
  return payload;
}

/** `page` and `write` use the same canonical/size/sitemap checks as core books. */
export async function renderExternalCatalogue({snapshot,config,books,write,page}){
  const {catalog}=snapshot;
  const pathFor=relative=>sitePath(config.basePath,relative);
  const byId=new Map(books.map(book=>[book.id,book]));
  const mappingsByRecord=new Map();
  const publicMappings=[];
  let mappingCount=0,matchedMappings=0;
  for(const group of catalog.mappings){
    const pages=[];let groupCount=0;
    for(let i=0;i<group.pages.length;i++){
      const entry=group.pages[i];const payload=await readVerified(snapshot,entry);
      const records=payload.records.map(mapping=>{
        if(mapping.provider!==group.provider||!Number.isSafeInteger(mapping.providerId)||!Number.isSafeInteger(mapping.otzariaId))throw new Error('Invalid external source mapping');
        const key=`${mapping.provider}:${mapping.providerId}`;
        const list=mappingsByRecord.get(key)||[];list.push(mapping);mappingsByRecord.set(key,list);
        const local=byId.get(`b-${mapping.otzariaId}`);
        if(local)matchedMappings++;
        return {...mapping,...(local?{localBookUrl:pathFor(`books/${local.id}/index.html`)}:{})};
      });
      const relative=`external/${entry.file}`;
      const body=JSON.stringify({...payload,sourceId:catalog.source.id,records,next:group.pages[i+1]?pathFor(`external/${group.pages[i+1].file}`):null});
      await write(relative,body);
      pages.push({page:entry.page,count:records.length,url:pathFor(relative),sha256:createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body)});
      groupCount+=records.length;
    }
    if(groupCount!==group.count)throw new Error('Incomplete external mapping export');
    mappingCount+=groupCount;publicMappings.push({...group,pages});
  }
  if(mappingCount!==catalog.counts.mappings)throw new Error('External source mapping total disagrees with manifest');

  const providers=catalog.providers.map(provider=>({...provider,href:pathFor(`external/${provider.id}/index.html`)}));
  const publicProviders=[];const searchPages=[];
  let totalRecords=0;
  for(const provider of providers){
    const publicPages=[];let count=0;let previousId=0;
    for(let i=0;i<provider.pages.length;i++){
      const entry=provider.pages[i];const payload=await readVerified(snapshot,entry);
      const relative=`external/${provider.id}/${entry.page}.html`;
      if(payload.provider!==provider.id||payload.page!==entry.page)throw new Error('External catalogue page is in the wrong provider bucket');
      const records=payload.records.map(record=>{
        safeId(record.id);
        const expectedId=`external-${provider.id}-${record.providerId}`;
        const expectedUrl=(provider.id==='otzar'?'https://tablet.otzar.org/book/book.php?book=':'https://hebrewbooks.org/')+record.providerId;
        if(record.id!==expectedId||record.provider!==provider.id||!Number.isSafeInteger(record.providerId)||record.providerId<=previousId||Math.floor((record.providerId-1)/catalog.paging.size)+1!==entry.page||record.url!==expectedUrl)throw new Error('External record identity or native URL is inconsistent');
        previousId=record.providerId;
        const links=mappingsByRecord.get(`${provider.id}:${record.providerId}`)||[];
        const localIds=[...new Set(links.map(mapping=>`b-${mapping.otzariaId}`))];
        const localBooks=localIds.map(id=>byId.get(id)).filter(Boolean).map(book=>({id:book.id,title:book.title,url:pathFor(`books/${book.id}/index.html`)}));
        return {...record,author:(record.authors||[]).join(' · '),providerUrl:record.url,url:`${pathFor(relative)}#${record.id}`,localBooks};
      });
      const jsonRelative=`external/${provider.id}/${entry.page}.json`;
      const body=JSON.stringify({...payload,sourceId:catalog.source.id,records,next:provider.pages[i+1]?pathFor(`external/${provider.id}/${provider.pages[i+1].page}.json`):null});
      await write(jsonRelative,body);
      publicPages.push({page:entry.page,number:i+1,count:records.length,url:pathFor(jsonRelative),htmlUrl:pathFor(relative),sha256:createHash('sha256').update(body).digest('hex'),bytes:Buffer.byteLength(body),firstTitle:records[0]?.title,lastTitle:records.at(-1)?.title});
      const pageLinks=provider.pages.map((item,n)=>({number:n+1,url:pathFor(`external/${provider.id}/${item.page}.html`)})).filter((_,n)=>n===0||n===provider.pages.length-1||Math.abs(n-i)<=2);
      const pagination={currentPage:i+1,totalPages:provider.pages.length,totalRecords:provider.count,previous:i?pathFor(`external/${provider.id}/${provider.pages[i-1].page}.html`):null,next:provider.pages[i+1]?pathFor(`external/${provider.id}/${provider.pages[i+1].page}.html`):null,pages:pageLinks,jsonUrl:pathFor(jsonRelative)};
      const structured={'@context':'https://schema.org','@type':'CollectionPage',name:`${provider.name}: רשומות הספרים ${entry.page}`,url:absoluteUrl(config,relative),mainEntity:{'@type':'ItemList',numberOfItems:records.length,itemListElement:records.map((record,n)=>({'@type':'ListItem',position:count+n+1,item:{'@type':'Book','@id':absoluteUrl(config,`${relative}#${record.id}`),name:record.title,url:absoluteUrl(config,`${relative}#${record.id}`),sameAs:record.providerUrl,...(record.authors?.length?{author:record.authors.map(name=>({'@type':'Person',name}))}:{})}}))}};
      await page(relative,`${provider.name} | רשומות הספרים ${entry.page}`,`פרטי הספרים, המחברים והמהדורות בקטלוג ${provider.name} המופץ עם אוצריא. קישורים למקור ולספרים מקבילים בספרייה.`,ui.externalProviderPage({baseUrl:config.basePath,provider,records,pagination,source:catalog.source}),{active:'external',lastmod:catalog.source.publishedAt,breadcrumbs:[{name:'קטלוגים חיצוניים',url:pathFor('external/index.html')},{name:provider.name,url:provider.href},{name:`רשומות ${entry.page}`,url:pathFor(relative)}],jsonLd:[structured]});
      searchPages.push({path:jsonRelative,provider:provider.id,providerName:provider.name,records:records.length});
      count+=records.length;
    }
    if(count!==provider.count)throw new Error(`External provider coverage mismatch: ${provider.id}`);
    const publicProvider={id:provider.id,name:provider.name,count,href:provider.href,pages:publicPages};
    publicProviders.push(publicProvider);totalRecords+=count;
    await page(`external/${provider.id}/index.html`,`כל הרשומות ב${provider.name}`,`כל ${count.toLocaleString('he-IL')} רשומות הספרים של ${provider.name} בקטלוג הרשמי המופץ עם אוצריא.`,ui.externalProviderIndexPage({baseUrl:config.basePath,provider,pages:publicPages.map(item=>({...item,url:item.htmlUrl})),source:catalog.source}),{active:'external',lastmod:catalog.source.publishedAt,breadcrumbs:[{name:'קטלוגים חיצוניים',url:pathFor('external/index.html')},{name:provider.name,url:provider.href}]});
  }
  if(totalRecords!==catalog.counts.records)throw new Error('External catalogue coverage disagrees with its source manifest');
  await page('external/index.html','קטלוגים חיצוניים','קטלוגי אוצר החכמה והיברובוקס המופצים עם אוצריא: פרטי ספרים, מחברים, מהדורות וקישורים למקור.',ui.externalHomePage({baseUrl:config.basePath,providers:publicProviders,counts:catalog.counts,source:catalog.source}),{active:'external',lastmod:catalog.source.publishedAt});
  await page('external/search.html','חיפוש בקטלוגים החיצוניים','חיפוש לפי שם ספר ומחבר בקטלוגי אוצר החכמה והיברובוקס המופצים עם אוצריא.',ui.externalSearchPage({baseUrl:config.basePath,providers:publicProviders,counts:catalog.counts}),{active:'external',noindex:true});
  await write('external/catalog.json',JSON.stringify({schemaVersion:1,source:catalog.source,scope:catalog.scope,paging:catalog.paging,databaseMetadata:catalog.databaseMetadata,counts:{...catalog.counts,matchedMappings,unmatchedMappings:mappingCount-matchedMappings},providers:publicProviders,mappings:publicMappings},null,2));
  await fs.writeFile(path.resolve(ROOT,process.env.EXTERNAL_SEARCH_INPUT||'.cache/external-search-pages.json'),JSON.stringify({outputDir:config.outputDir,basePath:config.basePath,records:totalRecords,pages:searchPages}));
  return {records:totalRecords,providers:publicProviders.length,htmlPages:2+publicProviders.length+publicProviders.reduce((sum,provider)=>sum+provider.pages.length,0),mappings:mappingCount,matchedMappings,unmatchedMappings:mappingCount-matchedMappings};
}
