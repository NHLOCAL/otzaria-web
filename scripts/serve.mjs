import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '../src/config.mjs';

const config=getConfig();
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.xml':'application/xml; charset=utf-8','.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.wasm':'application/wasm','.pdf':'application/pdf'};
const port=Number(process.env.PORT||4173);
const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://localhost');
    let pathname=decodeURIComponent(url.pathname);
    if(pathname==='/'&&config.basePath!=='/'){res.writeHead(302,{Location:`${config.basePath}index.html`});res.end();return;}
    if(!pathname.startsWith(config.basePath)) throw Object.assign(new Error('Not found'),{status:404});
    let relative=pathname.slice(config.basePath.length);
    if(!relative) relative='index.html';
    const file=path.resolve(config.outputDir,relative);
    if(!file.startsWith(config.outputDir+path.sep)||relative.split('/').some(p=>p.startsWith('.'))) throw Object.assign(new Error('Not found'),{status:404});
    const contents=await fs.readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(req.method==='HEAD'?undefined:contents);
  }catch(error){
    res.writeHead(error.status||404,{'Content-Type':'text/html; charset=utf-8'});
    res.end(await fs.readFile(path.join(config.outputDir,'404.html'),'utf8').catch(()=>'<h1>Not found</h1>'));
  }
});
server.listen(port,'0.0.0.0',()=>console.log(`Otzaria: http://localhost:${port}${config.basePath}index.html`));
