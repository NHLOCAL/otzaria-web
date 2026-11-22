import { createHash } from 'node:crypto';
import { parseFragment, serializeOuter } from 'parse5';

const dropped = new Set(['script','style','iframe','object','embed','template','noscript','svg','math','form','input','button','textarea','select','link','meta','audio','video']);
const allowed = new Set(['b','strong','i','em','u','s','small','sup','sub','abbr','br']);
const blocks = new Set(['p','div','li','blockquote','section','article','ul','ol','table','tr','td']);

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const hash = (value, length=12) => createHash('sha256').update(value).digest('hex').slice(0,length);
export const normalizeHebrew = value => String(value).normalize('NFKD').replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, '').replace(/[\u05BE–-]/g, ' ').replace(/[׳״'"“”‘’]/g, '').replace(/\s+/g, ' ').trim();

function sourceImage(node, images) {
  if (!images) return null;
  const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name,a.value]));
  const asset = attrs.src ? images.get(hash(attrs.src,64)) : null;
  if (attrs.src && !asset) throw new Error('Source image is absent from the verified media manifest');
  const alt = attrs.alt || attrs.title || (asset ? 'איור מתוך הספר' : 'האיור חסר בקובץ המקור');
  return { asset, alt };
}

function textOf(node, images) {
  if (node.nodeName === '#text') return node.value;
  if (dropped.has(node.tagName)) return '';
  if (node.tagName === 'img') {
    const image = sourceImage(node,images);
    return image ? `[${image.alt}${image.asset ? `: ${image.asset.url}` : ''}]` : '';
  }
  if (node.tagName === 'br') return '\n';
  return (node.childNodes || []).map(child => textOf(child,images)).join('');
}

function safeNode(node, images) {
  if (node.nodeName === '#text') return escapeHtml(node.value);
  if (dropped.has(node.tagName) || node.nodeName === '#comment') return '';
  if (node.tagName === 'img') {
    const image = sourceImage(node,images);
    if (!image) return '';
    if (!image.asset) return `<span class="missing-illustration">[${escapeHtml(image.alt)}]</span>`;
    const {url,width,height}=image.asset;
    return `<img class="book-illustration" src="${escapeHtml(url)}" alt="${escapeHtml(image.alt)}" width="${width}" height="${height}" loading="lazy" decoding="async">`;
  }
  const inner = (node.childNodes || []).map(child => safeNode(child,images)).join('');
  if (node.tagName === 'br') return '<br>';
  if (allowed.has(node.tagName)) return `<${node.tagName}>${inner}</${node.tagName}>`;
  return inner;
}

export function stripMarkup(value) {
  return textOf(parseFragment(String(value))).replace(/\s+/g, ' ').trim();
}

export function sanitizeInline(value, {images=null}={}) {
  return parseFragment(String(value)).childNodes.map(node => safeNode(node,images)).join('');
}

function incompleteTag(value) {
  let tag=false,quote='',expectValue=false,unquoted=false;
  for(let i=0;i<value.length;i++){
    const char=value[i];
    if(!tag){if(char==='<'&&/[a-z/!]/i.test(value[i+1]||'')){tag=true;expectValue=false;unquoted=false;}}
    else if(quote){if(char===quote)quote='';}
    else if(unquoted){if(char==='>'){tag=false;unquoted=false;}else if(/\s/.test(char))unquoted=false;}
    else if(char==='>')tag=false;
    else if(expectValue){if(!/\s/.test(char)){if(char==='"'||char==="'")quote=char;else unquoted=true;expectValue=false;}}
    else if(char==='=')expectValue=true;
  }
  return tag;
}

// Upstream TXT is line-oriented text with a small set of HTML heading/inline tags.
// A real HTML parser removes executable markup, including malformed/nested markup.
export function tokenize(source, {images=null}={}) {
  const tokens=[];
  const lines=source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '').split('\n');
  for(let index=0;index<lines.length;index++){
    const sourceLine=index+1;
    let line=lines[index];
    // Some official database rows split an HTML start tag from its attributes.
    // Parse the complete tag while retaining the first original line's anchor.
    while(incompleteTag(line)&&index+1<lines.length&&/^\s*(?:[a-z_:][\w:.-]*\s*=|\/?>)/i.test(lines[index+1]))line+='\n'+lines[++index];
    if (!line.trim()) continue;
    let pending=[];
    const flush=()=>{
      if (!pending.length) return;
      const html=pending.map(node => safeNode(node,images)).join('').trim();
      const text=pending.map(node => textOf(node,images)).join('').trim();
      if (text) tokens.push({kind:'paragraph', html, text, line:sourceLine});
      pending=[];
    };
    const consume=node=>{
      if (dropped.has(node.tagName)) return;
      if (/^h[1-6]$/.test(node.tagName || '')) {
        flush();
        const text=textOf(node,images).trim();
        if (text) tokens.push({kind:'heading',level:Number(node.tagName[1]),text,html:escapeHtml(text),line:sourceLine});
      } else if (blocks.has(node.tagName)) {
        flush();
        for (const child of node.childNodes || []) consume(child);
        flush();
      } else pending.push(node);
    };
    for(const node of parseFragment(line).childNodes) consume(node);
    flush();
  }
  return tokens;
}

function splitLargeParagraph(token, maxBytes) {
  if(Buffer.byteLength(token.html) <= maxBytes) return [token];
  // Split already-sanitized HTML, closing/reopening inline formatting at page
  // boundaries. Images are indivisible and never disappear from long passages.
  const result=[];const stack=[];let html='';let text='';let content=false;
  const closing=()=>[...stack].reverse().map(tag=>`</${tag}>`).join('');
  const flush=()=>{
    if(content) result.push({...token,html:(html+closing()).trim(),text:text.trim()});
    html=stack.map(tag=>`<${tag}>`).join('');text='';content=false;
  };
  const append=(fragment,plain)=>{
    if(content&&Buffer.byteLength(html+fragment+closing())>maxBytes)flush();
    html+=fragment;text+=plain;if(plain.trim()||fragment.startsWith('<img'))content=true;
  };
  const visit=node=>{
    if(node.nodeName==='#text'){
      for(const word of node.value.split(/(\s+)/)){
        if(Buffer.byteLength(escapeHtml(word))>maxBytes/2){
          for(const char of word)append(escapeHtml(char),char);
        }else append(escapeHtml(word),word);
      }
    }else if(node.tagName==='img'){
      const attrs=Object.fromEntries(node.attrs.map(a=>[a.name,a.value]));
      append(serializeOuter(node),`[${attrs.alt}: ${attrs.src}]`);
    }else if(node.tagName==='br')append('<br>','\n');
    else if(node.tagName==='span')append(serializeOuter(node),textOf(node));
    else if(allowed.has(node.tagName)){
      if(content&&Buffer.byteLength(html+`<${node.tagName}></${node.tagName}>`+closing())>maxBytes)flush();
      html+=`<${node.tagName}>`;stack.push(node.tagName);
      for(const child of node.childNodes||[])visit(child);
      stack.pop();html+=`</${node.tagName}>`;
    }
  };
  for(const node of parseFragment(token.html).childNodes)visit(node);
  flush();
  return result;
}

export function parseBook(source, book, {maxBytes=120_000,lineIds=null,images=null}={}) {
  if(!Number.isSafeInteger(maxBytes) || maxBytes<512 || maxBytes>500_000) throw new Error('Section size must be between 512 and 500,000 bytes');
  const tokens=tokenize(source,{images});
  if(!tokens.length) throw new Error(`Book ${book.id} has no readable text`);
  const first=tokens[0];
  if(first.kind==='heading' && first.level===1) tokens.shift();
  const headingLevels=tokens.filter(t=>t.kind==='heading').map(t=>Math.max(2,t.level));
  const sectionLevel=headingLevels.length?Math.min(...headingLevels):2;
  const headingCounts=new Map();const anchorCounts=new Map();const sections=[];
  let group='פתיחה';let groupKey='intro';let part=1;let items=[];let bytes=0;
  const flush=()=>{
    if(!items.length) return;
    const id=part===1?groupKey:`${groupKey}-${part}`;
    const title=part===1?group:`${group} (המשך ${part})`;
    const html=items.map(t=>{
      const sourceId=lineIds?.[t.line-1];
      const plainKey=sourceId!=null?`l${sourceId}`:hash(normalizeHebrew(t.text));
      const seen=(anchorCounts.get(plainKey)||0)+1;anchorCounts.set(plainKey,seen);
      const anchor=`p-${plainKey}${seen>1?`-${seen}`:''}`;
      if(t.kind==='heading') return `<h${Math.min(4,Math.max(2,t.level))} id="${anchor}">${escapeHtml(t.text)}</h${Math.min(4,Math.max(2,t.level))}>`;
      return `<p id="${anchor}" data-source-line="${t.line}"${sourceId!=null?` data-upstream-line="${sourceId}"`:''}>${t.html}</p>`;
    }).join('\n');
    sections.push({id,title,index:sections.length,html,text:items.map(t=>t.text).join('\n\n'),sourceLine:items[0].line});
    items=[];bytes=0;part++;
  };
  for(const original of tokens){
    if(original.kind==='heading' && original.level<=sectionLevel){
      flush();group=original.text;const sourceId=lineIds?.[original.line-1];const key=sourceId!=null?`s-${sourceId}`:`s-${hash(normalizeHebrew(group))}`;
      const count=(headingCounts.get(key)||0)+1;headingCounts.set(key,count);groupKey=count===1?key:`${key}-${count}`;part=1;
      // Page title displays this heading; do not duplicate it in the passage.
      continue;
    }
    for(const token of (original.kind==='paragraph'?splitLargeParagraph(original,Math.max(256,Math.floor(maxBytes/2))):[original])){
      const size=Buffer.byteLength(token.html)+160;
      if(bytes+size>maxBytes && items.length) flush();
      items.push(token);bytes+=size;
    }
  }
  flush();
  if(!sections.length) throw new Error(`Book ${book.id} has headings but no text`);
  return sections;
}
