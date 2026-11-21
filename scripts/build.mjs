import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, getConfig, absoluteUrl, sitePath, safeId } from '../src/config.mjs';
import { parseBook, escapeHtml, hash } from '../src/text.mjs';
import { sitemapDocuments, sitemapIndex } from '../src/sitemap.mjs';
import * as ui from '../src/ui.mjs';

const config=getConfig();
const exists=async p=>fs.access(p).then(()=>true,()=>false);
let sourceCatalog=config.sourceCatalog;
if(!sourceCatalog){
  const live=path.join(ROOT,'.cache/library/catalog.json');
  if(await exists(live)){
    const liveData=JSON.parse(await fs.readFile(live,'utf8'));
    if(liveData.profile===config.profile) sourceCatalog=live;
  }
  if(!sourceCatalog && config.profile==='starter') sourceCatalog=path.join(ROOT,'data/starter/catalog.json');
}
if(!sourceCatalog || !(await exists(sourceCatalog))) throw new Error(`No ${config.profile} source catalogue. Run LIBRARY_PROFILE=${config.profile} npm run sync. A full build never falls back to the development sample.`);
const sourceDir=path.dirname(sourceCatalog);
const catalog=JSON.parse(await fs.readFile(sourceCatalog,'utf8'));
if(catalog.schemaVersion!==1 || !Array.isArray(catalog.books) || !catalog.books.length) throw new Error('Unsupported or empty source catalogue');
if(catalog.profile!==config.profile) throw new Error(`Catalogue profile ${catalog.profile} does not match requested ${config.profile}`);
if(config.outputDir===ROOT || !config.outputDir.startsWith(ROOT+path.sep) || config.outputDir===sourceDir || sourceDir.startsWith(config.outputDir+path.sep)) throw new Error('Output directory must be a dedicated project subdirectory, outside source data');
if(!/^dist(?:[-_][a-z0-9_-]+)?$/i.test(path.relative(ROOT,config.outputDir)))throw new Error('OUTPUT_DIR must be dist or a dist-name sibling; refusing to erase another project directory');
const sourceById=new Map(catalog.books.map(book=>[book.id,book]));
const companionPath=path.resolve(ROOT,process.env.COMPANION_CATALOG||'.cache/companions/catalog.json');
let companions=null;
if(config.profile==='full'){
  if(!(await exists(companionPath))) throw new Error('Full application library requires the bundled Talmud PDFs. Run npm run sync, including companion synchronization.');
  companions=JSON.parse(await fs.readFile(companionPath,'utf8'));
  if(companions.schemaVersion!==1||!Array.isArray(companions.pdfs)||!companions.pdfs.length)throw new Error('Invalid or empty companion PDF catalogue');
}

const ids=new Set();
for(const b of catalog.books){
  safeId(b.id);
  if(ids.has(b.id)) throw new Error(`Duplicate book identifier ${b.id}`);
  ids.add(b.id);
  if(!b.title || !Array.isArray(b.categories) || !b.license?.name || !b.sourceUrl || !b.file) throw new Error(`Incomplete book metadata ${b.id}`);
  const source=path.resolve(sourceDir,b.file);
  if(!source.startsWith(sourceDir+path.sep)) throw new Error(`Book file escapes library: ${b.file}`);
  if(!['https:','http:'].includes(new URL(b.sourceUrl).protocol)) throw new Error('Invalid source URL');
}
const builtAt=process.env.BUILD_DATE || new Date().toISOString();
const output=config.outputDir;
await fs.rm(output,{recursive:true,force:true});
await fs.mkdir(output,{recursive:true});
if(await exists(path.join(ROOT,'public'))) await fs.cp(path.join(ROOT,'public'),output,{recursive:true});
await fs.writeFile(path.join(output,'.nojekyll'),'');
await fs.mkdir(path.join(ROOT,'.cache'),{recursive:true});

const sitemap=[];const pages=[];const books=[];const searchPages=[];
const pathFor=relative=>sitePath(config.basePath,relative);
async function write(relative,content){
  const file=path.join(output,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
}
async function readSidecar(book,key,hashKey){
  if(!book[key])return null;
  const file=path.resolve(sourceDir,book[key]);
  if(!file.startsWith(sourceDir+path.sep))throw new Error(`Sidecar escapes source directory: ${book.id}`);
  const content=await fs.readFile(file);
  if(book[hashKey]&&createHash('sha256').update(content).digest('hex')!==book[hashKey])throw new Error(`Sidecar checksum mismatch: ${book.id} ${key}`);
  return content;
}
async function page(relative,title,description,body,{jsonLd=[],breadcrumbs=[],active='library',noindex=false,lastmod}={}){
  const html=ui.layout({title,description,path:relative,baseUrl:config.basePath,siteUrl:config.origin,body,breadcrumbs,jsonLd,active,noindex,hasPdfs:!!companions});
  if(Buffer.byteLength(html)>1_000_000) throw new Error(`HTML page exceeds crawl budget: ${relative}`);
  await write(relative,html);pages.push(relative);
  if(!noindex) sitemap.push({url:absoluteUrl(config,relative),lastmod});
}
function bookSchema(book){
  return {'@context':'https://schema.org','@type':'Book','@id':absoluteUrl(config,`books/${book.id}/index.html`),name:book.title,inLanguage:'he',url:absoluteUrl(config,`books/${book.id}/index.html`),isAccessibleForFree:true,...(book.author?{author:{'@type':'Person',name:book.author}}:{}),...(book.license.url?{license:book.license.url}:{}),isBasedOn:book.sourceUrl};
}
function pagination(current,total,href){
  if(total<2) return '';
  return `<nav class="pagination" aria-label="דפדוף ברשימה">${current>1?`<a href="${href(current-1)}">לעמוד הקודם</a>`:''}<span>עמוד ${current} מתוך ${total}</span>${current<total?`<a href="${href(current+1)}">לעמוד הבא</a>`:''}</nav>`;
}

let totalTextBytes=0;let sectionCount=0;
const images=new Map();
let mediaManifest=null;
if(catalog.media){
  const data=await readSidecar(catalog.media,'file','sha256');
  mediaManifest=JSON.parse(data);
  if(mediaManifest.schemaVersion!==1||!Array.isArray(mediaManifest.images))throw new Error('Invalid image manifest');
  for(const asset of mediaManifest.images){
    if(!/^[a-f0-9]{64}$/.test(asset.sourceHash)||!/^media\/[a-f0-9]{64}\.(png|jpg)$/.test(asset.file)||!['image/png','image/jpeg'].includes(asset.mime))throw new Error('Unsafe source image entry');
    if(!Number.isSafeInteger(asset.width)||!Number.isSafeInteger(asset.height)||asset.width<1||asset.height<1)throw new Error('Invalid image dimensions');
    const content=await fs.readFile(path.resolve(sourceDir,asset.file));
    if(content.byteLength!==asset.bytes||createHash('sha256').update(content).digest('hex')!==asset.sha256)throw new Error(`Image checksum mismatch: ${asset.file}`);
    await write(asset.file,content);
    images.set(asset.sourceHash,{...asset,url:pathFor(asset.file)});
  }
  await write('media/catalog.json',JSON.stringify({...mediaManifest,images:mediaManifest.images.map(asset=>({...asset,file:undefined,url:pathFor(asset.file)}))}));
}
if(companions){
  for(const pdf of companions.pdfs){
    safeId(pdf.id);
    const file=path.resolve(path.dirname(companionPath),pdf.file);
    if(!file.startsWith(path.dirname(companionPath)+path.sep))throw new Error('PDF path escapes snapshot');
    const content=await fs.readFile(file);
    if(content.byteLength!==pdf.bytes||createHash('sha256').update(content).digest('hex')!==pdf.sha256)throw new Error(`PDF checksum mismatch: ${pdf.id}`);
    await write(`pdfs/${pdf.id}.pdf`,content);
  }
}
for(const sourceBook of catalog.books){
  const book={...sourceBook,categories:sourceBook.categories.length?sourceBook.categories:['ספרים נוספים']};
  const raw=await fs.readFile(path.resolve(sourceDir,book.file),'utf8');
  const actualHash=createHash('sha256').update(raw).digest('hex');
  if(book.contentSha256 && actualHash!==book.contentSha256) throw new Error(`Content integrity check failed for ${book.id}`);
  totalTextBytes+=Buffer.byteLength(raw);
  const lineIdsData=await readSidecar(book,'lineIdsFile','lineIdsSha256');
  const lineIds=lineIdsData?JSON.parse(lineIdsData):null;
  if(lineIds&&(!Array.isArray(lineIds)||lineIds.some(id=>!Number.isSafeInteger(id)||id<0)))throw new Error(`Invalid source line identifiers: ${book.id}`);
  if(lineIds&&book.sourceLineCount!==lineIds.length)throw new Error(`Source line identifier count mismatch: ${book.id}`);
  const sections=parseBook(raw,book,{maxBytes:config.targetSectionBytes,lineIds,images});
  const brief=sections.map(({id,title,index,sourceLine})=>({id,title,index,sourceLine,url:pathFor(`books/${book.id}/${id}.html`)}));
  const description=`${book.title}: ${sections[0].text.replace(/\s+/g,' ').slice(0,140)}`;
  const primary=book.editionOf?sourceById.get(book.editionOf):book;
  const editions=(primary?.versions||[]).filter(v=>v.editionBookId&&v.editionBookId!==book.id&&sourceById.has(v.editionBookId)).map(v=>({id:v.editionBookId,title:v.heVersionTitle||v.versionTitle,url:pathFor(`books/${v.editionBookId}/index.html`)}));
  const pdf=companions&&!book.editionOf&&book.categories[0]==='תלמוד בבלי'&&(!book.categories[1]||book.categories[1].startsWith('סדר '))?companions.pdfs.find(p=>p.title===book.title):null;
  const enriched={...book,description,sectionCount:sections.length,sections:brief,url:pathFor(`books/${book.id}/index.html`),textUrl:pathFor(`books/${book.id}/text.txt`),jsonUrl:pathFor(`books/${book.id}/book.json`),editions,primaryUrl:book.editionOf?pathFor(`books/${book.editionOf}/index.html`):undefined,pdfUrl:pdf?pathFor(`pdfs/${pdf.id}.pdf`):undefined,linksUrl:book.linksFile?pathFor(`books/${book.editionOf||book.id}/links.json`):undefined};
  const crumb=[{name:'הספרייה',url:pathFor('catalog/index.html')},{name:book.title,url:enriched.url}];
  const tocSize=200;const tocPages=Math.ceil(brief.length/tocSize);
  for(let n=1;n<=tocPages;n++){
    const rel=n===1?`books/${book.id}/index.html`:`books/${book.id}/contents-${n}.html`;
    const pager=pagination(n,tocPages,p=>pathFor(p===1?`books/${book.id}/index.html`:`books/${book.id}/contents-${p}.html`));
    await page(rel,n===1?book.title:`${book.title} | תוכן העניינים ${n}`,description,ui.bookPage({book:enriched,sections:brief.slice((n-1)*tocSize,n*tocSize),baseUrl:config.basePath})+pager,{jsonLd:[bookSchema(book)],breadcrumbs:crumb,lastmod:book.updatedAt});
  }
  const plain=[book.title,book.author||'',`מקור: ${book.sourceUrl}`,`רישיון: ${book.license.name}${book.license.url?' '+book.license.url:''}`,book.license.attribution||'', '',...sections.flatMap(s=>[s.title,'',s.text,''])].join('\n');
  await write(`books/${book.id}/text.txt`,plain);
  if(book.linksFile&&!book.editionOf){
    const links=await readSidecar(book,'linksFile','linksSha256');
    await write(`books/${book.id}/links.json`,links);
  }
  await write(`books/${book.id}/book.json`,JSON.stringify({schemaVersion:1,...enriched,file:undefined,lineIdsFile:undefined,linksFile:undefined,description:undefined,contentSha256:actualHash},null,2));
  for(let i=0;i<sections.length;i++){
    const section=sections[i];
    const relative=`books/${book.id}/${section.id}.html`;
    const neighbours=brief.slice(Math.max(0,i-35),i+36);
    await page(relative,`${book.title} | ${section.title}`,`${book.title}, ${section.title}. ${section.text.replace(/\s+/g,' ').slice(0,145)}`,ui.readingPage({book:enriched,section,sections:neighbours,previous:brief[i-1]||null,next:brief[i+1]||null,baseUrl:config.basePath}),{breadcrumbs:[...crumb,{name:section.title,url:pathFor(relative)}],lastmod:book.updatedAt,jsonLd:[{'@context':'https://schema.org','@type':'Chapter',name:section.title,inLanguage:'he',url:absoluteUrl(config,relative),isPartOf:{'@id':absoluteUrl(config,`books/${book.id}/index.html`),'@type':'Book',name:book.title},isAccessibleForFree:true}]});
    searchPages.push({path:relative,bookId:book.id,familyId:book.editionOf||book.id,category:book.categories[0],bytes:Buffer.byteLength(section.html)});
  }
  sectionCount+=sections.length;
  books.push({...enriched,sections:undefined,file:undefined});
  if(books.length%100===0) console.log(`Rendered ${books.length}/${catalog.books.length} books, ${sectionCount} reading pages`);
}
books.sort((a,b)=>a.title.localeCompare(b.title,'he'));
const categories=[...new Set(books.map(b=>b.categories[0]))].map(title=>({id:`c-${hash(title,10)}`,title,count:books.filter(b=>b.categories[0]===title).length})).sort((a,b)=>a.title.localeCompare(b.title,'he'));
categories.forEach(c=>c.href=pathFor(`categories/${c.id}.html`));
const stats={books:books.length,sections:sectionCount,categories:categories.length,pdfs:companions?.pdfs.length||0,updatedAt:catalog.generatedAt||builtAt,profile:catalog.profile,scope:catalog.scope};
const upstream=catalog.sources||[];
if(companions)upstream.push({...companions.source,id:'talmud-pdfs'});
const pageSize=120;
const catalogPageCount=Math.ceil(books.length/pageSize);
for(let n=1;n<=catalogPageCount;n++){
  const relative=n===1?'catalog/index.html':`catalog/page-${n}.html`;
  const slice=books.slice((n-1)*pageSize,n*pageSize);
  const pager=pagination(n,catalogPageCount,p=>pathFor(p===1?'catalog/index.html':`catalog/page-${p}.html`));
    await page(relative,n===1?'כל הספרים':`כל הספרים | עמוד ${n}`,'עיון בספריית אוצריא לפי ספרים ותחומי לימוד. כל הטקסט זמין לקריאה, לחיפוש ולהורדה.',ui.catalogPage({books:slice,categories,stats,total:books.length,baseUrl:config.basePath})+pager,{active:'catalog',breadcrumbs:[{name:'הספרייה',url:pathFor(relative)}]});
  await write(`catalog/page-${n}.json`,JSON.stringify({schemaVersion:1,page:n,totalPages:catalogPageCount,books:slice,next:n<catalogPageCount?pathFor(`catalog/page-${n+1}.json`):null}));
}
for(const category of categories){
  const list=books.filter(b=>b.categories[0]===category.title);const count=Math.ceil(list.length/pageSize);
  for(let n=1;n<=count;n++){
    const relative=n===1?`categories/${category.id}.html`:`categories/${category.id}-${n}.html`;
    const pager=pagination(n,count,p=>pathFor(p===1?`categories/${category.id}.html`:`categories/${category.id}-${p}.html`));
    await page(relative,n===1?category.title:`${category.title} | עמוד ${n}`,`כל ספרי ${category.title} בספריית אוצריא. קריאה וחיפוש בטקסט המלא.`,ui.catalogPage({books:list.slice((n-1)*pageSize,n*pageSize),categories,category,stats,total:list.length,baseUrl:config.basePath})+pager,{active:'catalog',breadcrumbs:[{name:'הספרייה',url:pathFor('catalog/index.html')},{name:category.title,url:pathFor(relative)}]});
  }
}
const preferred=['בראשית','שמות','תהילים','משנה אבות','משלי','קהלת'];
const featured=preferred.map(title=>books.find(book=>book.title===title)).filter(Boolean);
for(const book of books){if(featured.length>=6)break;if(!featured.includes(book))featured.push(book);}
await page('index.html','אוצריא','אוצריא ברשת: ספרייה תורנית לחיפוש, לימוד וקריאה. ספרים במלואם, מקורות מדויקים וגישה פתוחה מכל מכשיר.',ui.homePage({books:featured,categories,stats,upstream,baseUrl:config.basePath}),{jsonLd:[{'@context':'https://schema.org','@type':'WebSite',name:'אוצריא',url:absoluteUrl(config,'index.html'),inLanguage:'he',potentialAction:{'@type':'SearchAction',target:{'@type':'EntryPoint',urlTemplate:`${absoluteUrl(config,'search.html')}?q={search_term_string}`},'query-input':'required name=search_term_string'}}]});
await page('search.html','חיפוש בספרים','חיפוש בטקסט המלא של ספרי אוצריא, לפי ספר ותחום לימוד.',ui.searchPage({baseUrl:config.basePath,categories}),{active:'search',noindex:true});
await page('about.html','אודות אוצריא ברשת','הספרייה התורנית של אוצריא באינטרנט. מקורות, קרדיטים ועדכוני הספרים.',ui.aboutPage({baseUrl:config.basePath,upstream,provenance:catalog,stats}),{active:'about'});
await page('accessibility.html','נגישות','אפשרויות הנגישות והקריאה באתר אוצריא.',ui.accessibilityPage({baseUrl:config.basePath}),{});
await page('developers.html','גישה למפתחים ולסוכני AI','קטלוג סטטי, טקסט מלא, כתובות קבועות ומקורות. תיעוד הממשקים הפתוחים של אוצריא.',ui.developersPage({baseUrl:config.basePath,stats,upstream}),{active:'developers'});
if(companions){
  const rows=companions.pdfs.map(pdf=>`<li><a href="${pathFor(`pdfs/${pdf.id}.pdf`)}">${escapeHtml(pdf.title)} <span dir="ltr">PDF</span></a></li>`).join('');
  await page('talmud-pdfs.html','התלמוד המצולם','כל קובצי התלמוד הבבלי המצולמים המצורפים לתוכנת אוצריא.',`<article class="prose-page"><h1>התלמוד המצולם</h1><p>המהדורות המצולמות המצורפות לספריית אוצריא. לצד מסכתות שלהן טקסט מקביל מופיע גם קישור מתוך עמוד הספר.</p><ul>${rows}</ul><p>${escapeHtml(companions.source.attribution||'')}</p><p><a href="${escapeHtml(companions.source.url)}">חבילת המקור</a></p></article>`,{lastmod:companions.source.publishedAt});
  await write('pdfs/catalog.json',JSON.stringify({schemaVersion:1,source:companions.source,pdfs:companions.pdfs.map(p=>({...p,file:undefined,url:pathFor(`pdfs/${p.id}.pdf`)}))}));
}
await page('404.html','העמוד לא נמצא','העמוד המבוקש אינו קיים בספריית אוצריא.',ui.notFoundPage({baseUrl:config.basePath}),{noindex:true});
await write('catalog.json',JSON.stringify({schemaVersion:1,profile:catalog.profile,generatedAt:catalog.generatedAt,sources:upstream,scope:catalog.scope,counts:stats,categories,firstPage:pathFor('catalog/page-1.json'),books:books.map(({id,title,author,categories,url,textUrl,jsonUrl,sectionCount})=>({id,title,author,categories,url,textUrl,jsonUrl,sectionCount}))}));
await write('sources.json',JSON.stringify({schemaVersion:1,sources:upstream,scope:catalog.scope,counts:catalog.counts},null,2));
await write('connection-types.json',JSON.stringify({schemaVersion:1,types:catalog.connectionTypes||{}}));
const mapDocuments=sitemapDocuments(sitemap,config.origin);
const mapUrls=[];
for(let i=0;i<mapDocuments.length;i++){const name=`sitemap-${i+1}.xml`;await write(name,mapDocuments[i]);mapUrls.push(absoluteUrl(config,name));}
await write('sitemap.xml',sitemapIndex(mapUrls));
await write('robots.txt',`User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(config,'sitemap.xml')}\n`);
await write('llms.txt',`# אוצריא\n\n> The official Otzaria Torah library. Hebrew primary sources, complete static reading pages, no authentication or JavaScript required to read.\n\n## Discovery\n- [Catalogue](${absoluteUrl(config,'catalog.json')}): machine-readable book catalogue with stable URLs and text exports.\n- [Paginated catalogue](${absoluteUrl(config,'catalog/page-1.json')}): follow the next links for bounded responses.\n- [Source revisions](${absoluteUrl(config,'sources.json')}): upstream repositories, releases, provenance and coverage.\n- [Sitemaps](${absoluteUrl(config,'sitemap.xml')}): all canonical HTML reading pages.\n- [Developer guide](${absoluteUrl(config,'developers.html')}): formats and citation guidance.\n\n## Reading and citation\nEach book has /books/{id}/index.html, /books/{id}/book.json and /books/{id}/text.txt. Each reading section has its own .html URL and paragraph fragment IDs. Preserve Hebrew exactly when quoting; cite the visible book and section with its canonical URL. Attribute Otzaria and the source named in the book metadata. HTML is authoritative; browser search is a convenience, not an external API.\n\n## Current build\nProfile: ${catalog.profile}. Books: ${books.length}. Reading sections: ${sectionCount}. Coverage: ${catalog.scope?.description || catalog.profile}. Check sources.json for exact revisions.\n`);
await write('_headers',`/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'\n\n/pagefind/*\n  Cache-Control: public, max-age=3600\n`);
const manifest={schemaVersion:1,builtAt,codeRevision:process.env.GITHUB_SHA||null,sourceGeneratedAt:catalog.generatedAt,profile:catalog.profile,scope:catalog.scope,siteUrl:config.siteUrl,basePath:config.basePath,sources:upstream,counts:{books:books.length,baseBooks:books.filter(b=>!b.editionOf).length,editions:books.filter(b=>b.editionOf).length,pdfs:companions?.pdfs.length||0,images:mediaManifest?.images.length||0,missingSourceImages:mediaManifest?.missing?.reduce((n,entry)=>n+entry.count,0)||0,sourceLinks:catalog.counts.links||0,sections:sectionCount,htmlPages:pages.length,sourceBytes:totalTextBytes},search:{status:'pending',pages:searchPages.length}};
await write('build-manifest.json',JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(ROOT,'.cache/search-pages.json'),JSON.stringify({outputDir:output,basePath:config.basePath,pages:searchPages}));
console.log(JSON.stringify({message:'Static HTML built',...manifest.counts,profile:catalog.profile,output},null,2));
