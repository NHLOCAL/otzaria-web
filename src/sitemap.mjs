import { escapeHtml } from './text.mjs';

export function sitemapDocuments(entries, origin, {maxUrls=40_000,maxBytes=40_000_000}={}) {
  const header='<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  const footer='</urlset>\n';
  const chunks=[];let lines=[];let bytes=Buffer.byteLength(header+footer);
  for(const entry of entries){
    const parsed=new URL(entry.url);
    if(parsed.origin!==new URL(origin).origin) throw new Error('Sitemap URL is not on the configured origin');
    const modified=entry.lastmod && /^\d{4}-\d{2}-\d{2}/.test(entry.lastmod)?`<lastmod>${escapeHtml(entry.lastmod)}</lastmod>`:'';
    const line=`<url><loc>${escapeHtml(parsed.href)}</loc>${modified}</url>\n`;
    const size=Buffer.byteLength(line);
    if(lines.length && (lines.length>=maxUrls || bytes+size>maxBytes)){chunks.push(header+lines.join('')+footer);lines=[];bytes=Buffer.byteLength(header+footer);}
    lines.push(line);bytes+=size;
  }
  if(lines.length) chunks.push(header+lines.join('')+footer);
  return chunks;
}

export function sitemapIndex(urls){
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(url=>`<sitemap><loc>${escapeHtml(url)}</loc></sitemap>`).join('\n')}\n</sitemapindex>\n`;
}
