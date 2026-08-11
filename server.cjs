const http = require('http');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36 ReddFlowRSS/16.0';

let redgifsToken = '';
let redgifsTokenAt = 0;

function safeSubreddit(input) {
  const s = String(input || '').trim().replace(/^r\//i, '');
  return /^[A-Za-z0-9_]{2,30}$/.test(s) ? s : null;
}
function decodeEntities(s='') { return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))); }
function stripTags(s='') { return decodeEntities(String(s).replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim(); }
function tagText(block, tag) { const m=String(block).match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,'i')); return m?decodeEntities(m[1]).trim():''; }
function attrFromTag(block, tag, attr) { const m=String(block).match(new RegExp(`<${tag}\\b[^>]*\\b${attr}=(?:"([^"]*)"|'([^']*)')[^>]*>`,'i')); return m?decodeEntities(m[1]||m[2]||''):''; }
function allHrefs(html='') { const out=[]; const re=/href=(?:"([^"]+)"|'([^']+)')/gi; let m; while((m=re.exec(html))) out.push(decodeEntities(m[1]||m[2]||'')); return out; }
function allSrcs(html='') { const out=[]; const re=/src=(?:"([^"]+)"|'([^']+)')/gi; let m; while((m=re.exec(html))) out.push(decodeEntities(m[1]||m[2]||'')); return out; }

function redgifsIdFromUrl(raw) {
  const value=String(raw||'').trim();
  if(!value) return '';
  try {
    // Si viene envuelta por nuestro proxy local, extraer primero la URL real.
    const local=new URL(value,'http://localhost');
    if(local.pathname==='/api/media' && local.searchParams.get('url')) return redgifsIdFromUrl(local.searchParams.get('url'));
  } catch {}
  const watch=value.match(/(?:https?:\/\/)?(?:www\.)?redgifs\.com\/(?:watch|ifr)\/([A-Za-z0-9_-]+)/i);
  if(watch) return watch[1].toLowerCase();
  try {
    const u=new URL(value);
    const host=u.hostname.toLowerCase();
    if(host==='redgifs.com' || host.endsWith('.redgifs.com')) {
      // media.redgifs.com/WelllitPalevioletredXiphias.mp4, thumbs*.redgifs.com/ID-mobile.mp4, etc.
      const file=decodeURIComponent(u.pathname.split('/').filter(Boolean).pop()||'');
      const m=file.match(/^([A-Za-z0-9_-]+?)(?:-(?:mobile|silent))?\.(?:mp4|webm|m4v|gif)$/i);
      if(m) return m[1].toLowerCase();
    }
  } catch {}
  return '';
}

function mediaFromUrls(urls) {
  for (const raw of urls) {
    const id=redgifsIdFromUrl(raw);
    if (id) return { type:'redgifs', category:'video', id, canonicalUrl:`https://www.redgifs.com/watch/${id}`, src:`/api/redgifs?id=${encodeURIComponent(id)}` };
  }
  for (const raw of urls) { const url=String(raw||''); if (/\.(mp4|webm|m4v)(?:\?|$)/i.test(url)) return { type:'video', category:'video', canonicalUrl:url, src:url }; }
  for (const raw of urls) { const url=String(raw||''); if (/\.gif(?:\?|$)/i.test(url)) return { type:'gif', category:'gif', canonicalUrl:url, src:url }; }
  for (const raw of urls) { const url=String(raw||''); if (/\.(jpe?g|png|webp|avif)(?:\?|$)/i.test(url)) return { type:'image', category:'image', canonicalUrl:url, src:url }; }
  return null;
}

function parseAtom(xml, subredditFallback) {
  const entries=String(xml).match(/<entry\b[\s\S]*?<\/entry>/gi)||[];
  const items=[]; let lastRedditId='';
  for (const entry of entries) {
    const title=stripTags(tagText(entry,'title'))||'(sin título)';
    const contentHtml=decodeEntities(tagText(entry,'content'));
    const permalink=attrFromTag(entry,'link','href')||'';
    const subreddit=(permalink.match(/\/r\/([^/]+)\/comments\//i)?.[1]||subredditFallback||'unknown').replace(/^r\//i,'');
    const atomId=stripTags(tagText(entry,'id'));
    const redditId=permalink.match(/\/comments\/([a-z0-9]+)\//i)?.[1]||atomId.match(/t3_([a-z0-9]+)/i)?.[1]||'';
    if (redditId) lastRedditId=redditId;
    const authorBlock=entry.match(/<author\b[\s\S]*?<\/author>/i)?.[0]||'';
    const author=stripTags(tagText(authorBlock,'name')).replace(/^\/?u\//i,'')||'[deleted]';
    const updated=stripTags(tagText(entry,'updated'));
    const createdUtc=updated?Math.floor(Date.parse(updated)/1000)||0:0;
    const urls=[...allHrefs(contentHtml),...allSrcs(contentHtml)];
    const links=[...entry.matchAll(/<link\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>/gi)].map(m=>decodeEntities(m[1]||m[2]||''));
    urls.unshift(...links);
    const media=mediaFromUrls(urls); if (!media) continue;
    const sourceUrl=urls.find(u=>/redgifs\.com|\.(?:mp4|webm|m4v|gif|jpe?g|png|webp|avif)(?:\?|$)/i.test(u))||permalink;
    const over18=/\bNSFW\b|over[_ -]?18|adult/i.test(contentHtml+' '+title);
    items.push({ id:redditId?`t3_${redditId}`:(atomId||permalink||`${subreddit}:${createdUtc}:${title}`),redditId,subreddit,title,author,permalink,sourceUrl,createdUtc,score:0,over18,media });
  }
  return {items,after:lastRedditId?`t3_${lastRedditId}`:null,rawEntryCount:entries.length};
}

const rssCache = new Map();
function cacheGet(key, maxAgeMs=12000){
  const hit=rssCache.get(key);
  if(!hit) return null;
  if(Date.now()-hit.at>maxAgeMs){rssCache.delete(key);return null;}
  return hit.value;
}
function cachePut(key,value){
  rssCache.set(key,{at:Date.now(),value});
  if(rssCache.size>250){
    const oldest=[...rssCache.entries()].sort((a,b)=>a[1].at-b[1].at).slice(0,50);
    for(const [k] of oldest) rssCache.delete(k);
  }
}
function wait(ms){return new Promise(r=>setTimeout(r,ms));}

async function fetchRedditRss(subreddit, sort, t, after, limit, count=0) {
  const sortPath=sort==='hot'?'hot':sort==='top'?'top':'new';
  const params=new URLSearchParams({limit:String(Math.min(Math.max(Number(limit)||100,1),100)),show:'all'});
  if(after) params.set('after',after);
  if(count) params.set('count',String(Math.max(0,Number(count)||0)));
  if(sort==='top'&&t) params.set('t',t);
  const cacheKey=`${subreddit}|${sort}|${t}|${after||''}|${count||0}|${limit||100}`;
  const cached=cacheGet(cacheKey, after?1800:6000);
  if(cached) return {...cached,cached:true};

  // Reddit ha usado ambas formas históricamente. Probar las dos evita que una
  // variante concreta ignore parámetros de listing en una plataforma/región.
  const bases=[
    `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sortPath}.rss`,
    `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sortPath}/.rss`,
    `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/${sortPath}.rss`,
    `https://old.reddit.com/r/${encodeURIComponent(subreddit)}/${sortPath}/.rss`
  ];
  let lastError;
  const delays=[0,450,1100];
  for(let round=0;round<delays.length;round++){
    if(delays[round]) await wait(delays[round]);
    for(const base of bases){
      try{
        const url=`${base}?${params.toString()}`;
        const controller=new AbortController();
        const timeout=setTimeout(()=>controller.abort(),13000);
        const r=await fetch(url,{redirect:'follow',signal:controller.signal,headers:{
          'User-Agent':USER_AGENT,
          'Accept':'application/atom+xml, application/rss+xml, text/xml;q=0.9, */*;q=0.5',
          'Cookie':'over18=1',
          'Cache-Control':'no-cache, no-store',
          'Pragma':'no-cache'
        }}).finally(()=>clearTimeout(timeout));
        const text=await r.text();
        if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,100).replace(/\s+/g,' ')}`);
        if(!/<(?:feed|rss)\b/i.test(text)) throw new Error('Reddit no devolvió RSS/Atom válido');
        const parsed=parseAtom(text,subreddit);
        const ids=(parsed.items||[]).map(x=>x.redditId||x.id).filter(Boolean);
        parsed.count=(Number(count)||0)+(parsed.rawEntryCount||0);
        parsed.source='subreddit-rss';
        parsed.firstId=ids[0]||'';
        parsed.lastId=ids[ids.length-1]||'';
        parsed.signature=ids.length?`${ids[0]}:${ids[ids.length-1]}:${ids.length}`:`empty:${after||'first'}`;
        parsed.requestedAfter=after||'';
        cachePut(cacheKey,parsed);
        return parsed;
      }catch(e){lastError=e;}
    }
  }
  throw lastError||new Error('No se pudo obtener el RSS');
}

async function fetchRedditBatchRss(subreddits, sort, t, state, limit) {
  const clean=[...new Set((Array.isArray(subreddits)?subreddits:[]).map(s=>safeSubreddit(s)).filter(Boolean))];
  if(!clean.length) throw new Error('No hay subreddits válidos');
  const out=[];
  const failures=[];
  const nextState={};
  let cursor=0;

  // V12: UNA sola página por subreddit y ciclo. El frontend decide cuándo pedir
  // la siguiente. Así una carga inicial no se come 20-30 páginas de golpe ni
  // marca un cursor como terminado por un fallo/transitorio repetido.
  async function worker(workerId){
    while(true){
      const i=cursor++;
      if(i>=clean.length) return;
      const sub=clean[i];
      const prev=(state&&state[sub])||{};
      if(prev.exhausted){nextState[sub]={...prev,ok:true};continue;}
      if(i>1) await wait(120+workerId*50);

      const after=prev.after||'';
      const count=Number(prev.count)||0;
      const pages=Number(prev.pages)||0;
      const scannedEntries=Number(prev.scannedEntries)||0;
      const prevSignature=prev.signature||'';
      const prevStall=Number(prev.stallCount)||0;
      const prevEmpty=Number(prev.emptyCount)||0;
      const prevMediaTotal=Number(prev.mediaTotal)||0;

      try{
        const part=await fetchRedditRss(sub,sort,t,after,limit,count);
        const rawCount=Number(part.rawEntryCount)||0;
        const signature=part.signature||'';
        const repeated=!!(prevSignature&&signature&&signature===prevSignature);
        const cursorRepeated=!!(after&&part.after&&part.after===after);
        const stalled=repeated||cursorRepeated;
        let stallCount=stalled?prevStall+1:0;
        let emptyCount=rawCount===0?prevEmpty+1:0;
        let exhausted=false;
        let nextAfter=after;
        let nextCount=count;
        let advanced=false;

        // Solo añadimos la página si no es una repetición literal de la anterior.
        if(!repeated) out.push(...(part.items||[]));

        if(rawCount===0){
          // Dos respuestas vacías consecutivas sí son una señal razonable de fin.
          exhausted=emptyCount>=2;
        }else if(!stalled&&part.after){
          nextAfter=part.after;
          nextCount=count+rawCount;
          advanced=true;
        }else if(stalled){
          // MUY IMPORTANTE: no declarar agotado. Reddit/RSS puede repetir una
          // página por caché o temporalmente. El cliente volverá a intentarlo.
          exhausted=false;
        }else if(!part.after){
          // Si hay contenido pero no conseguimos cursor, tampoco lo damos por
          // agotado inmediatamente: permite reintentos con las otras variantes RSS.
          stallCount=prevStall+1;
        }

        nextState[sub]={
          after:nextAfter,
          count:nextCount,
          pages:pages+(repeated?0:1),
          scannedEntries:scannedEntries+(repeated?0:rawCount),
          exhausted,
          advanced,
          stalled,
          stallCount,
          emptyCount,
          signature:repeated?prevSignature:signature,
          ok:true,
          error:'',
          mediaFound:repeated?0:(part.items||[]).length,
          mediaTotal:prevMediaTotal+(repeated?0:(part.items||[]).length),
          lastSuccessAt:Date.now()
        };
      }catch(e){
        const msg=String(e.message||e);
        failures.push({subreddit:sub,error:msg});
        nextState[sub]={...prev,ok:false,error:msg,stalled:true,stallCount:prevStall+1,exhausted:false};
      }
    }
  }
  await Promise.all([worker(0),worker(1),worker(2)]);
  return {items:out,state:nextState,failures,requestedSubreddits:clean,source:'balanced-single-page-rss-v14'};
}

async function fetchRedditMultiRss(subreddits, sort, t, after, limit) {
  const clean=[...new Set((Array.isArray(subreddits)?subreddits:[]).map(s=>safeSubreddit(s)).filter(Boolean))];
  if(!clean.length) throw new Error('No hay subreddits válidos');
  if(clean.length===1) return fetchRedditRss(clean[0],sort,t,after,limit);
  // Reddit soporta feeds combinados nativos: /r/a+b+c/new.rss
  const sortFile=sort==='hot'?'hot.rss':sort==='top'?'top.rss':'new.rss';
  const params=new URLSearchParams({limit:String(Math.min(Math.max(Number(limit)||100,1),100))});
  if(after) params.set('after',after);
  if(sort==='top'&&t) params.set('t',t);
  const joined=clean.map(encodeURIComponent).join('+');
  const candidates=[
    `https://www.reddit.com/r/${joined}/${sortFile}?${params}`,
    `https://old.reddit.com/r/${joined}/${sortFile}?${params}`
  ];
  let lastError;
  for(const url of candidates){
    try{
      const r=await fetch(url,{redirect:'follow',headers:{'User-Agent':USER_AGENT,'Accept':'application/atom+xml, application/rss+xml, text/xml;q=0.9, */*;q=0.5','Cookie':'over18=1'}});
      const text=await r.text();
      if(!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,120).replace(/\s+/g,' ')}`);
      if(!/<(?:feed|rss)\b/i.test(text)) throw new Error('Reddit no devolvió RSS/Atom válido');
      const parsed=parseAtom(text,clean[0]);
      parsed.requestedSubreddits=clean;
      parsed.source='combined-rss';
      return parsed;
    }catch(e){lastError=e;}
  }
  // Fallback resistente: si el combinado falla, carga uno a uno con pausa amplia y acumula TODO.
  const all=[]; const failures=[]; let lastAfter=null;
  for(let i=0;i<clean.length;i++){
    try{
      const part=await fetchRedditRss(clean[i],sort,t,'',limit);
      all.push(...(part.items||[]));
      if(part.after) lastAfter=part.after;
    }catch(e){failures.push({subreddit:clean[i],error:String(e.message||e)});}
    if(i<clean.length-1) await new Promise(r=>setTimeout(r,900));
  }
  if(!all.length) throw lastError||new Error('No se pudo cargar ningún subreddit');
  return {items:all,after:lastAfter,requestedSubreddits:clean,source:'fallback-merged',failures};
}

async function getRedgifsToken(force=false){
  if(!force && redgifsToken && Date.now()-redgifsTokenAt<45*60*1000) return redgifsToken;
  const r=await fetch('https://api.redgifs.com/v2/auth/temporary',{headers:{'User-Agent':USER_AGENT,'Referer':'https://www.redgifs.com/','Origin':'https://www.redgifs.com'}});
  const data=await r.json().catch(()=>({})); if(!r.ok||!data.token) throw new Error(`Redgifs auth HTTP ${r.status}`);
  redgifsToken=data.token; redgifsTokenAt=Date.now(); return redgifsToken;
}
async function fetchRedgifs(id){
  async function once(force){
    const token=await getRedgifsToken(force);
    return fetch(`https://api.redgifs.com/v2/gifs/${encodeURIComponent(id)}?views=yes`,{headers:{'User-Agent':USER_AGENT,'Referer':'https://www.redgifs.com/','Origin':'https://www.redgifs.com','Content-Type':'application/json','Authorization':`Bearer ${token}`,'x-customheader':`https://www.redgifs.com/watch/${id}`}});
  }
  let r=await once(false); if(r.status===401) r=await once(true);
  const data=await r.json().catch(()=>({}));
  if(!r.ok||!data.gif){
    const err=new Error(data.error||data.message||`Redgifs HTTP ${r.status}`);
    err.status=r.status;
    err.deleted=r.status===404||r.status===410||/not found|deleted|removed|does not exist/i.test(String(data.error||data.message||''));
    throw err;
  }
  const g=data.gif, urls=g.urls||{};
  return {id:g.id||id,hasAudio:!!g.hasAudio,urls:{hd:urls.hd||'',sd:urls.sd||'',gif:urls.gif||''},width:g.width||0,height:g.height||0,duration:g.duration||0};
}

function isAllowedMediaUrl(raw){
  try{
    const u=new URL(raw);
    if(u.protocol!=='https:'&&u.protocol!=='http:') return false;
    const h=u.hostname.toLowerCase();
    return h==='v.redd.it'||h.endsWith('.redd.it')||h==='i.redd.it'||h.endsWith('.redditmedia.com')||h==='redditmedia.com'||h.endsWith('.reddit.com')||h==='reddit.com'||h.endsWith('.redgifs.com')||h==='redgifs.com'||h.endsWith('.imgur.com')||h==='imgur.com'||h.endsWith('.gfycat.com')||h==='gfycat.com';
  }catch{return false;}
}
function proxyHeadersFor(url, req){
  const h={'User-Agent':USER_AGENT,'Accept':'*/*','Referer':'https://www.reddit.com/'};
  if(req.headers.range) h.Range=req.headers.range;
  try{const host=new URL(url).hostname.toLowerCase(); if(host.endsWith('redgifs.com')){h.Referer='https://www.redgifs.com/';h.Origin='https://www.redgifs.com';}}catch{}
  return h;
}
async function proxyMedia(req,res,url){
  if(!isAllowedMediaUrl(url)) return sendJson(res,400,{error:'Host multimedia no permitido'});
  const upstream=await fetch(url,{redirect:'follow',headers:proxyHeadersFor(url,req)});
  if(!upstream.ok && upstream.status!==206){
    const text=await upstream.text().catch(()=>'');
    return sendJson(res,upstream.status===404||upstream.status===410?upstream.status:502,{error:`El host devolvió HTTP ${upstream.status}`,deleted:upstream.status===404||upstream.status===410,detail:text.slice(0,180)});
  }
  const ct=(upstream.headers.get('content-type')||'').toLowerCase();
  if(ct.includes('text/html')||ct.includes('application/json')){
    const text=await upstream.text().catch(()=>'');
    return sendJson(res,502,{error:'La URL multimedia devolvió una página en vez de un archivo reproducible',detail:text.slice(0,180)});
  }
  const headers={
    'Content-Type':upstream.headers.get('content-type')||'application/octet-stream',
    'Accept-Ranges':upstream.headers.get('accept-ranges')||'bytes',
    'Cache-Control':'public, max-age=1800',
    'Access-Control-Allow-Origin':'*',
    'X-Content-Type-Options':'nosniff'
  };
  for(const name of ['content-length','content-range','etag','last-modified']){const v=upstream.headers.get(name);if(v)headers[name.split('-').map(x=>x[0].toUpperCase()+x.slice(1)).join('-')]=v;}
  res.writeHead(upstream.status,headers);
  if(!upstream.body){res.end();return;}
  Readable.fromWeb(upstream.body).on('error',()=>{try{res.destroy()}catch{}}).pipe(res);
}

function sendJson(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});res.end(body);}
function contentType(file){const ext=path.extname(file).toLowerCase();return({'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json; charset=utf-8'})[ext]||'application/octet-stream';}
function serveStatic(req,res){const pathname=decodeURIComponent(new URL(req.url,`http://${req.headers.host}`).pathname);const rel=pathname==='/'?'index.html':pathname.replace(/^\/+/, '');const file=path.normalize(path.join(PUBLIC,rel));if(!file.startsWith(PUBLIC)){res.writeHead(403);res.end('Forbidden');return;}fs.readFile(file,(err,buf)=>{if(err){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});res.end('404');return;}res.writeHead(200,{'Content-Type':contentType(file),'Cache-Control':file.endsWith('index.html')?'no-cache':'public, max-age=300','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin'});res.end(buf);});}

const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,`http://${req.headers.host}`);
  if(u.pathname==='/api/health') return sendJson(res,200,{ok:true,source:'reddit-rss',redgifs:'direct-api-through-local-range-proxy',mediaProxy:true,needsCredentials:false});
  if(u.pathname==='/api/media'){
    const url=u.searchParams.get('url')||'';
    try{return await proxyMedia(req,res,url);}catch(e){return sendJson(res,502,{error:'No se pudo reproducir el archivo por el proxy',detail:String(e.message||e)});}
  }
  if(u.pathname==='/api/redgifs'){
    const id=String(u.searchParams.get('id')||'').toLowerCase(); if(!/^[a-z0-9_-]{3,100}$/.test(id)) return sendJson(res,400,{error:'ID de Redgifs no válido'});
    try{
      const data=await fetchRedgifs(id);
      const wrap=x=>x?`/api/media?url=${encodeURIComponent(x)}`:'';
      return sendJson(res,200,{...data,urls:{hd:wrap(data.urls.hd),sd:wrap(data.urls.sd),gif:wrap(data.urls.gif)},directUrls:data.urls});
    }catch(e){const deleted=!!e.deleted||e.status===404||e.status===410;return sendJson(res,deleted?404:502,{error:deleted?'Redgifs eliminado o no disponible':'No se pudo resolver Redgifs',deleted,detail:String(e.message||e)});}
  }
  if(u.pathname==='/api/batch'){
    const raw=String(u.searchParams.get('subreddits')||'');
    const subreddits=[...new Set(raw.split(/[,+\s]+/).map(x=>safeSubreddit(x)).filter(Boolean))];
    const sort=['hot','new','top'].includes(u.searchParams.get('sort'))?u.searchParams.get('sort'):'new';
    const t=['hour','day','week','month','year','all'].includes(u.searchParams.get('t'))?u.searchParams.get('t'):'all';
    const limit=u.searchParams.get('limit')||100;
    const scanPages=u.searchParams.get('scanPages')||4;
    const targetMedia=u.searchParams.get('targetMedia')||35;
    let state={};
    try{state=JSON.parse(u.searchParams.get('state')||'{}')||{};}catch{state={};}
    if(!subreddits.length) return sendJson(res,400,{error:'Subreddits no válidos'});
    try{return sendJson(res,200,await fetchRedditBatchRss(subreddits,sort,t,state,limit,scanPages,targetMedia));}
    catch(e){return sendJson(res,502,{error:'No se pudieron cargar los subreddits.',detail:String(e.message||e)});}
  }
  if(u.pathname==='/api/multi'){
    const raw=String(u.searchParams.get('subreddits')||'');
    const subreddits=[...new Set(raw.split(/[,+\s]+/).map(x=>safeSubreddit(x)).filter(Boolean))];
    const sort=['hot','new','top'].includes(u.searchParams.get('sort'))?u.searchParams.get('sort'):'new';
    const t=['hour','day','week','month','year','all'].includes(u.searchParams.get('t'))?u.searchParams.get('t'):'all';
    const after=u.searchParams.get('after')||'';
    const limit=u.searchParams.get('limit')||100;
    if(!subreddits.length) return sendJson(res,400,{error:'Subreddits no válidos'});
    try{return sendJson(res,200,await fetchRedditMultiRss(subreddits,sort,t,after,limit));}
    catch(e){return sendJson(res,502,{error:'No se pudo cargar el RSS combinado de Reddit.',detail:String(e.message||e)});}
  }
  if(u.pathname==='/api/subreddit'){
    const subreddit=safeSubreddit(u.searchParams.get('subreddit')); const sort=['hot','new','top'].includes(u.searchParams.get('sort'))?u.searchParams.get('sort'):'new'; const t=['hour','day','week','month','year','all'].includes(u.searchParams.get('t'))?u.searchParams.get('t'):'all'; const after=u.searchParams.get('after')||''; const limit=u.searchParams.get('limit')||100; const count=u.searchParams.get('count')||0;
    if(!subreddit) return sendJson(res,400,{error:'Subreddit no válido'}); try{return sendJson(res,200,await fetchRedditRss(subreddit,sort,t,after,limit,count));}catch(e){return sendJson(res,502,{error:'No se pudo cargar el RSS público de Reddit.',detail:String(e.message||e)});}
  }
  serveStatic(req,res);
}catch(e){sendJson(res,500,{error:String(e.message||e)});}});
server.listen(PORT,'0.0.0.0',()=>{console.log('\n===================================================');console.log(' ReddFlow · TikTok feed v16 · manual en medios rotos + vistos');console.log(` http://localhost:${PORT}`);console.log('===================================================\n');});
