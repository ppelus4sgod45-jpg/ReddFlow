(()=>{'use strict';
const $=id=>document.getElementById(id),feed=$('feed');
const KEYS={settings:'reddflow.settings.v5',seen:'reddflow.seen.v1',seenMedia:'reddflow.seenMedia.v1',history:'reddflow.history.v1',subs:'reddflow.subs.v3',presets:'reddflow.presets.v1',broken:'reddflow.broken.v1',brokenMedia:'reddflow.brokenMedia.v1'};
const defaults={hideSeen:true,autoSeen:true,autoplay:true,showNsfw:true,preloadThreshold:25,filterVideo:true,filterGif:true,filterImage:true,volume:80,muted:false};
let settings={...defaults,...read(KEYS.settings,{})};
// Migración V9: mantener 25 elementos por delante sin perder volumen/filtros/otros ajustes guardados.
if(localStorage.getItem('reddflow.buffer25.v1')!=='1'){settings.preloadThreshold=25;save(KEYS.settings,settings);localStorage.setItem('reddflow.buffer25.v1','1')}
let seen=new Set(read(KEYS.seen,[])),seenMedia=new Set(read(KEYS.seenMedia,[])),history=read(KEYS.history,[]),presets=read(KEYS.presets,[]),broken=new Set(read(KEYS.broken,[])),brokenMedia=new Set(read(KEYS.brokenMedia,[]));
// V16: lo que versiones anteriores marcaron como roto pasa a considerarse visto.
for(const id of broken)seen.add(id);for(const key of brokenMedia)seenMedia.add(key);if(broken.size||brokenMedia.size){save(KEYS.seen,[...seen]);save(KEYS.seenMedia,[...seenMedia]);broken.clear();brokenMedia.clear();save(KEYS.broken,[]);save(KEYS.brokenMedia,[]);}
let items=[],subs=[],feedState={},current=-1,observer=null;
let freshGeneration=0,freshController=null,morePromise=null,bufferTimer=null,initialRetryTimer=null,bufferBackoff=900,bufferWorking=false;
const INITIAL_PER_SUB_TARGET=3, INITIAL_MAX_ROUNDS=24, BUFFER_MAX_ROUNDS=24, INITIAL_RETRY_PER_SUB=6;

function read(k,d){try{return JSON.parse(localStorage.getItem(k))??d}catch{return d}}
function save(k,v){localStorage.setItem(k,JSON.stringify(v))}
function status(t,ms=2600){$('status').textContent=t;$('status').style.opacity='1';clearTimeout(status.t);status.t=setTimeout(()=>$('status').style.opacity='.22',ms)}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function parseSubs(){return [...new Set($('subs').value.split(/[,+\s]+/).map(s=>s.replace(/^r\//i,'').trim()).filter(s=>/^[A-Za-z0-9_]{2,30}$/.test(s)))]}
function category(it){return it?.media?.category||(it?.media?.type==='gif'?'gif':it?.media?.type==='image'?'image':'video')}
function labelCategory(it){const c=category(it);return c==='video'?'Vídeo':c==='gif'?'GIF':'Imagen'}
function proxyUrl(url){return `/api/media?url=${encodeURIComponent(url)}`}
function normalizedUrl(raw){try{const u=new URL(String(raw||''),location.origin);u.hash='';for(const k of [...u.searchParams.keys()])if(/^(utm_|ref|source|width|format|auto|quality)/i.test(k))u.searchParams.delete(k);u.hostname=u.hostname.toLowerCase();return u.href}catch{return String(raw||'')}}
function unwrapMediaUrl(raw){try{const u=new URL(String(raw||''),location.origin);if(u.pathname==='/api/media'&&u.searchParams.get('url'))return u.searchParams.get('url');return String(raw||'')}catch{return String(raw||'')}}
function redgifsIdFromUrl(raw){const value=unwrapMediaUrl(raw);if(!value)return '';const w=value.match(/(?:https?:\/\/)?(?:www\.)?redgifs\.com\/(?:watch|ifr)\/([A-Za-z0-9_-]+)/i);if(w)return w[1].toLowerCase();try{const u=new URL(value,location.origin),h=u.hostname.toLowerCase();if(h==='redgifs.com'||h.endsWith('.redgifs.com')){const f=decodeURIComponent(u.pathname.split('/').filter(Boolean).pop()||'');const m=f.match(/^([A-Za-z0-9_-]+?)(?:-(?:mobile|silent))?\.(?:mp4|webm|m4v|gif)$/i);if(m)return m[1].toLowerCase()}}catch{}return ''}
function mediaKey(it){if(!it?.media)return `post:${it?.id||''}`;const candidates=[it.media.id?`https://www.redgifs.com/watch/${it.media.id}`:'',it.media.canonicalUrl,it.sourceUrl,it.media.src];for(const src of candidates){const rg=redgifsIdFromUrl(src);if(rg)return `redgifs:${rg}`}const src=it.media.canonicalUrl||it.sourceUrl||it.media.src||'';return src?`${category(it)}:${normalizedUrl(unwrapMediaUrl(src)).toLowerCase()}`:`post:${it.id}`}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

$('subs').value=localStorage.getItem(KEYS.subs)||'';
$('sort').value=localStorage.getItem('reddflow.sort')||'new';
$('period').value=localStorage.getItem('reddflow.period')||'all';

function syncSettings(){
  for(const k of ['hideSeen','autoSeen','autoplay','showNsfw']) $(k).checked=!!settings[k];
  $('preloadThreshold').value=settings.preloadThreshold;
  $('filterVideo').checked=!!settings.filterVideo;$('filterGif').checked=!!settings.filterGif;$('filterImage').checked=!!settings.filterImage;
  $('volume').value=Math.round(Number(settings.volume)||0);$('volumeValue').textContent=`${$('volume').value}%`;
  updateMuteButton();$('seenCount').textContent=seenMedia.size||seen.size;
}
function updateMuteButton(){$('muteBtn').textContent=settings.muted||settings.volume<=0?'🔇':settings.volume<45?'🔉':'🔊';$('muteBtn').title=settings.muted?'Activar sonido':'Silenciar'}
function applyVolume(v){if(!v)return;v.volume=Math.max(0,Math.min(1,(Number(settings.volume)||0)/100));v.muted=!!settings.muted||settings.volume<=0}
function applyVolumeToAll(){document.querySelectorAll('video').forEach(applyVolume);updateMuteButton()}
function syncPlayButtons(){document.querySelectorAll('.slide').forEach(slide=>{const b=slide.querySelector('.play-toggle'),v=slide.querySelector('video');if(!b)return;if(!v){b.disabled=true;b.textContent='⏸';b.title='Pausa disponible solo en vídeos';return}b.disabled=false;const playing=!v.paused&&!v.ended;b.textContent=playing?'⏸':'▶';b.title=playing?'Pausar':'Reproducir'})}
async function toggleCurrentVideo(slide){const v=slide?.querySelector('video');if(!v){status('Este elemento no es un vídeo');return}if(v.paused||v.ended){applyVolume(v);try{await v.play()}catch{status('El navegador bloqueó la reproducción')} }else v.pause();syncPlayButtons()}
async function toggleFeedFullscreen(){try{if(document.fullscreenElement){await document.exitFullscreen()}else if(feed.requestFullscreen){await feed.requestFullscreen()}else{status('Tu navegador no permite pantalla completa aquí')}}catch{status('No se pudo abrir pantalla completa')}}
function syncFullscreenButtons(){const on=!!document.fullscreenElement;$('fullscreenBtn').textContent=on?'⛶':'⛶';$('fullscreenBtn').title=on?'Salir de pantalla completa':'Pantalla completa del feed';document.querySelectorAll('.fullscreen-toggle').forEach(b=>{b.textContent=on?'⤢':'⛶';b.title=on?'Salir de pantalla completa':'Pantalla completa'})}
syncSettings();

async function apiFetchBatch(state={},signal){
  const q=new URLSearchParams({subreddits:subs.join('+'),sort:$('sort').value,t:$('period').value,limit:'100',state:JSON.stringify(state||{})});
  const r=await fetch('/api/batch?'+q,{signal});
  const d=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(d.detail||d.error||'Error cargando subreddits');
  return d;
}
function filterAllows(it){const c=category(it);return c==='video'?settings.filterVideo:c==='gif'?settings.filterGif:settings.filterImage}
function eligible(it){if(!it?.media||!filterAllows(it)||broken.has(it.id)||brokenMedia.has(mediaKey(it)))return false;if(!settings.showNsfw&&it.over18)return false;if(settings.hideSeen&&(seen.has(it.id)||seenMedia.has(mediaKey(it))))return false;const key=mediaKey(it);return !items.some(x=>x.id===it.id||mediaKey(x)===key)}
function randomizedFairOrder(list){
  // Mezcla aleatoria con equilibrio suave: no fuerza cuotas fijas por subreddit,
  // pero penaliza rachas largas y favorece comunidades que han aparecido menos.
  const groups=new Map();
  for(const it of list){const k=String(it.subreddit||'').toLowerCase();if(!groups.has(k))groups.set(k,[]);groups.get(k).push(it)}
  for(const arr of groups.values()){
    arr.sort((a,b)=>(b.createdUtc||0)-(a.createdUtc||0));
    // Pequeño barajado dentro de ventanas para que no quede todo cronológico.
    for(let i=0;i<arr.length;i+=6){const w=arr.slice(i,i+6);for(let j=w.length-1;j>0;j--){const k=Math.floor(Math.random()*(j+1));[w[j],w[k]]=[w[k],w[j]]}arr.splice(i,w.length,...w)}
  }
  const used=new Map(),out=[];let last='',streak=0;
  while(groups.size){
    const choices=[];
    for(const [sub,arr] of groups){if(!arr.length){groups.delete(sub);continue}const u=used.get(sub)||0;let weight=(0.65+Math.random()*1.35)/(1+u*0.22);if(sub===last)weight/=Math.pow(2.4,streak);choices.push([sub,weight])}
    if(!choices.length)break;
    const total=choices.reduce((a,x)=>a+x[1],0);let r=Math.random()*total,chosen=choices[choices.length-1][0];
    for(const [sub,w] of choices){r-=w;if(r<=0){chosen=sub;break}}
    const arr=groups.get(chosen);out.push(arr.shift());used.set(chosen,(used.get(chosen)||0)+1);
    if(chosen===last)streak++;else{last=chosen;streak=1}
    if(!arr.length)groups.delete(chosen);
  }
  return out;
}
function aheadCounts(){
  const m=Object.fromEntries(subs.map(s=>[s.toLowerCase(),0]));
  for(const it of items.slice(Math.max(0,current+1))){const k=String(it.subreddit||'').toLowerCase();if(k in m)m[k]++}
  return m;
}
function activeBufferSubs(){
  return subs.filter(sub=>{
    const st=feedState[sub]||{};
    return !st.exhausted && (Number(st.mediaTotal)||0)>0;
  });
}
function bufferIsHealthy(){
  const ahead=Math.max(0,items.length-current-1);
  if(ahead<settings.preloadThreshold)return false;
  const active=activeBufferSubs();
  if(active.length<=1)return true;
  const counts=aheadCounts();
  // No cuotas 5+5: basta con que cada fuente activa siga representada en la ventana futura.
  // El orden/cantidad exacta sigue siendo aleatorio.
  return active.every(sub=>(counts[sub.toLowerCase()]||0)>0);
}
function markSeen(it){if(!it)return;const key=mediaKey(it);seen.add(it.id);seenMedia.add(key);history=history.filter(h=>h.id!==it.id&&h.mediaKey!==key);history.unshift({id:it.id,mediaKey:key,title:it.title,subreddit:it.subreddit,permalink:it.permalink,when:Date.now()});history=history.slice(0,5000);save(KEYS.seen,[...seen]);save(KEYS.seenMedia,[...seenMedia]);save(KEYS.history,history);$('seenCount').textContent=seenMedia.size||seen.size}
function markBroken(it){if(!it)return;broken.add(it.id);brokenMedia.add(mediaKey(it));if(broken.size>3000)broken=new Set([...broken].slice(-2500));if(brokenMedia.size>3000)brokenMedia=new Set([...brokenMedia].slice(-2500));save(KEYS.broken,[...broken]);save(KEYS.brokenMedia,[...brokenMedia])}

function makeSkeleton(text='Cargando vídeo…'){const sk=document.createElement('div');sk.className='media-skeleton';sk.innerHTML=`<div><div class="spinner"></div><div class="small" style="margin-top:10px">${esc(text)}</div></div>`;return sk}
function pauseAllExcept(idx){document.querySelectorAll('.slide').forEach(s=>{const v=s.querySelector('video');if(v&&Number(s.dataset.index)!==idx){v.pause();v.muted=true}});syncPlayButtons()}
function mediaErrorUI(wrap,it,msg){wrap.querySelector('.media-skeleton')?.remove();if(wrap.querySelector('.media-error'))return;const box=document.createElement('div');box.className='media-error';box.innerHTML=`<b>No se pudo reproducir</b><span>${esc(msg||'El archivo ya no está disponible.')}</span>`;const open=document.createElement('button');open.className='ghost';open.textContent='Abrir origen';open.onclick=()=>window.open(it.sourceUrl||it.permalink,'_blank','noopener');box.append(open);wrap.append(box)}

function reindexSlides(){document.querySelectorAll('.slide').forEach((s,i)=>{s.dataset.index=i;const m=s.querySelector('.meta');if(m&&items[i])m.textContent=`u/${items[i].author||'[deleted]'} · ${i+1}/${items.length} · ${labelCategory(items[i])}`})}
function showBrokenWithoutSkipping(it,wrap,msg){
  // V16: nunca desplazamos ni eliminamos la tarjeta automáticamente.
  // Al entrar en ella, activate() la marca como vista si autoSeen está activado.
  mediaErrorUI(wrap,it,msg||'El vídeo no está disponible. Baja manualmente cuando quieras.');
}

function buildVideo(src,it,wrap,{proxied=false,redgifs=false,fallbackSrc='',fallbackSources=[]}={}){
  const sk=makeSkeleton(redgifs?'Cargando Redgifs con audio…':'Cargando vídeo…');wrap.append(sk);
  const v=document.createElement('video');v.loop=true;v.playsInline=true;v.preload='auto';v.controls=false;v.disablePictureInPicture=false;v.setAttribute('playsinline','');v.setAttribute('webkit-playsinline','');
  let attempt=0,settled=false,stallTimer=null;const sources=[];
  const add=s=>{if(s&&!sources.includes(s))sources.push(s)};
  if(proxied){add(src);add(fallbackSrc);for(const x of fallbackSources)add(x)}else{add(proxyUrl(src));add(src);add(fallbackSrc);for(const x of fallbackSources)add(x)}
  const clearStall=()=>{if(stallTimer){clearTimeout(stallTimer);stallTimer=null}};
  function loadAttempt(reason=''){
    clearStall();settled=false;clearTimeout(v._loadTimer);
    if(attempt>=sources.length){showBrokenWithoutSkipping(it,wrap,reason||'El vídeo falló en todas sus fuentes. Baja manualmente para continuar.');return}
    const next=sources[attempt++];
    try{v.pause()}catch{}
    v.removeAttribute('src');v.load();v.src=next;v.load();
    v._loadTimer=setTimeout(()=>{if(!settled)loadAttempt('El vídeo tardó demasiado en responder.')},9000);
  }
  const ready=()=>{settled=true;clearTimeout(v._loadTimer);clearStall();sk.remove();v.classList.add('ready');applyVolume(v);if(Number(v.closest('.slide')?.dataset.index)===current&&settings.autoplay)v.play().catch(()=>{});syncPlayButtons()};
  const armStall=()=>{
    if(Number(v.closest('.slide')?.dataset.index)!==current||v.paused)return;
    clearStall();stallTimer=setTimeout(()=>{
      if(Number(v.closest('.slide')?.dataset.index)===current&&!v.paused&&v.readyState<3)loadAttempt('El vídeo se quedó bloqueado cargando.')
    },10000);
  };
  v.addEventListener('loadedmetadata',()=>{if(v.videoWidth>0&&v.videoHeight>0)ready()});
  v.addEventListener('canplay',ready);v.addEventListener('playing',()=>{ready();clearStall()});
  v.addEventListener('waiting',armStall);v.addEventListener('stalled',armStall);
  v.addEventListener('error',()=>loadAttempt('Error de reproducción.'));
  v.addEventListener('play',syncPlayButtons);v.addEventListener('pause',()=>{clearStall();syncPlayButtons()});v.addEventListener('ended',syncPlayButtons);
  v.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();toggleCurrentVideo(v.closest('.slide'))});
  wrap.append(v);loadAttempt();
  return v;
}
async function resolveRedgifs(it,wrap){
  const sk=makeSkeleton('Comprobando Redgifs…');wrap.append(sk);
  try{
    const r=await fetch(it.media.src),d=await r.json().catch(()=>({}));sk.remove();
    if(!r.ok){if(d.deleted||r.status===404||r.status===410){showBrokenWithoutSkipping(it,wrap,'Redgifs eliminado o no disponible. Baja manualmente para continuar.');return null}throw new Error(d.detail||d.error||`HTTP ${r.status}`)}
    const src=d.urls?.hd||d.urls?.sd;if(!src){showBrokenWithoutSkipping(it,wrap,'Redgifs sin archivo de vídeo. Baja manualmente para continuar.');return null}
    const direct=[]; if(d.directUrls?.hd)direct.push(d.directUrls.hd);if(d.directUrls?.sd)direct.push(d.directUrls.sd);
    const v=buildVideo(src,it,wrap,{proxied:true,redgifs:true,fallbackSrc:d.urls?.sd&&d.urls.sd!==src?d.urls.sd:'',fallbackSources:direct});
    const note=document.createElement('div');note.className='audio-note';note.textContent=d.hasAudio===false?'Redgifs · sin pista de audio':'Redgifs · audio disponible';wrap.append(note);setTimeout(()=>note.remove(),1800);return v;
  }catch(e){sk.remove();showBrokenWithoutSkipping(it,wrap,'Redgifs: '+String(e.message||e)+' · Baja manualmente para continuar.');return null}
}

function createSlide(it,index){
  const s=document.createElement('section');s.className='slide';s.dataset.index=index;s.dataset.id=it.id;
  const wrap=document.createElement('div');wrap.className='media-wrap';
  if(it.media.type==='video')buildVideo(it.media.src,it,wrap);
  else if(it.media.type==='gif'||it.media.type==='image'){
    const sk=makeSkeleton(it.media.type==='gif'?'Cargando GIF…':'Cargando imagen…');wrap.append(sk);const img=document.createElement('img');img.alt='';img.loading='eager';let retried=false;
    img.onload=()=>{sk.remove();img.classList.add('ready')};img.onerror=()=>{if(!retried){retried=true;img.src=it.media.src;return}sk.remove();showBrokenWithoutSkipping(it,wrap,'La imagen ya no está disponible. Baja manualmente para continuar.');};img.src=proxyUrl(it.media.src);wrap.append(img);
  } else resolveRedgifs(it,wrap);
  const overlay=document.createElement('div');overlay.className='overlay';overlay.innerHTML=`<a class="sub" href="https://www.reddit.com/r/${encodeURIComponent(it.subreddit)}/" target="_blank" rel="noopener">r/${esc(it.subreddit)}</a><div class="title">${esc(it.title)}</div><div class="meta">u/${esc(it.author||'[deleted]')} · ${index+1}/${items.length} · ${labelCategory(it)}</div>`;
  const side=document.createElement('div');side.className='side-actions';
  const fs=document.createElement('button');fs.className='circle fullscreen-toggle';fs.title='Pantalla completa';fs.textContent='⛶';fs.onclick=e=>{e.stopPropagation();toggleFeedFullscreen()};
  const un=document.createElement('button');un.className='circle';un.title='Marcar no visto';un.textContent='↩';un.onclick=()=>{const key=mediaKey(it);seen.delete(it.id);seenMedia.delete(key);history=history.filter(h=>h.id!==it.id&&h.mediaKey!==key);save(KEYS.seen,[...seen]);save(KEYS.seenMedia,[...seenMedia]);save(KEYS.history,history);$('seenCount').textContent=seenMedia.size||seen.size;status('Marcado como no visto')};
  const rd=document.createElement('button');rd.className='circle';rd.title='Abrir Reddit';rd.textContent='↗';rd.onclick=()=>window.open(it.permalink,'_blank','noopener');side.append(fs,un,rd);s.append(wrap,overlay,side);return s;
}

function appendItems(newItems){const added=randomizedFairOrder(newItems.filter(eligible));if(!added.length)return 0;const start=items.length;items.push(...added);$('empty')?.remove();added.forEach((it,j)=>feed.append(createSlide(it,start+j)));reindexSlides();setupObserver();return added.length}
function setupObserver(){observer?.disconnect();observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting&&e.intersectionRatio>=.66)activate(Number(e.target.dataset.index))},{root:feed,threshold:[.66]});document.querySelectorAll('.slide').forEach(s=>observer.observe(s))}
async function activate(idx,force=false){if((idx===current&&!force)||!items[idx])return;current=idx;pauseAllExcept(idx);const s=document.querySelector(`.slide[data-index="${idx}"]`),v=s?.querySelector('video');if(v){applyVolume(v);if(v.readyState===0&&v.src)v.load();if(settings.autoplay){try{await v.play()}catch{applyVolume(v);try{await v.play()}catch{}}}}syncPlayButtons();const it=items[idx];if(settings.autoSeen)markSeen(it);scheduleBuffer(0)}
function mergeFeedState(next){
  if(!next||typeof next!=='object')return;
  for(const sub of subs){
    const n=next[sub];
    if(!n)continue;
    const prev=feedState[sub]||{};
    // No retroceder un cursor válido si justo esa petición falló.
    feedState[sub]={
      after:n.after||prev.after||'',
      count:Math.max(Number(prev.count)||0,Number(n.count)||0),
      pages:Math.max(Number(prev.pages)||0,Number(n.pages)||0),
      scannedEntries:Math.max(Number(prev.scannedEntries)||0,Number(n.scannedEntries)||0),
      exhausted:!!n.exhausted,
      advanced:!!n.advanced,
      stalled:!!n.stalled,
      stallCount:Number(n.stallCount)||0,
      emptyCount:Number(n.emptyCount)||0,
      signature:n.signature||prev.signature||'',
      ok:n.ok!==false,
      error:n.error||'',
      mediaTotal:Math.max(Number(prev.mediaTotal)||0,Number(n.mediaTotal)||0),
      lastSuccessAt:Number(n.lastSuccessAt)||Number(prev.lastSuccessAt)||0
    };
  }
}
function scheduleBuffer(delay=0){
  clearTimeout(bufferTimer);
  bufferTimer=setTimeout(()=>ensureForwardBuffer(current),Math.max(0,delay));
}
async function ensureForwardBuffer(idx=current){
  if(bufferWorking||!subs.length||idx<0)return;
  const ahead=items.length-idx-1;
  if(bufferIsHealthy()){bufferBackoff=900;return;}
  bufferWorking=true;
  try{
    let rounds=0,addedTotal=0;
    while(!bufferIsHealthy()&&rounds<BUFFER_MAX_ROUNDS){
      const n=await loadMore(true);
      rounds++;
      addedTotal+=n;
      const allExhausted=subs.length>0&&subs.every(sub=>feedState[sub]?.exhausted);
      if(allExhausted)break;
      // Una página sin vídeos que pasen los filtros NO es el final del subreddit.
      // Seguimos avanzando cursores para buscar más atrás.
      if(n===0)await sleep(500);
    }
    if(!bufferIsHealthy()){
      // Si Reddit está lento/limitando, no obliga al usuario a pulsar: vuelve a intentarlo solo.
      scheduleBuffer(bufferBackoff);
      bufferBackoff=Math.min(8000,Math.round(bufferBackoff*1.55));
    }else{
      bufferBackoff=900;
    }
  }finally{bufferWorking=false;}
}

async function loadFresh(){
  subs=parseSubs();
  if(!subs.length){status('Escribe al menos un subreddit');return;}
  if(!settings.filterVideo&&!settings.filterGif&&!settings.filterImage){status('Activa al menos un tipo');return;}

  // Cada carga nueva invalida/cancela cualquier carga anterior para que nunca se pisen resultados.
  const gen=++freshGeneration;
  freshController?.abort();
  freshController=new AbortController();
  clearTimeout(bufferTimer);clearTimeout(initialRetryTimer);
  morePromise=null;bufferWorking=false;bufferBackoff=900;
  items=[];feedState={};current=-1;
  feed.innerHTML='<section id="empty" class="empty"><div class="spinner"></div><p>Cargando todos los subreddits…</p></section>';
  localStorage.setItem(KEYS.subs,subs.join(', '));localStorage.setItem('reddflow.sort',$('sort').value);localStorage.setItem('reddflow.period',$('period').value);
  const btn=$('loadBtn');btn.disabled=true;btn.textContent='Cargando…';
  try{
    let totalAdded=0,failures=[],rounds=0;
    const initialAttempts=Object.fromEntries(subs.map(s=>[s,0]));
    // Antes de mostrar el feed esperamos a que TODAS las comunidades hayan tenido
    // una oportunidad real de cargar. No exigimos cuotas rígidas de vídeos.
    while(gen===freshGeneration&&rounds<INITIAL_MAX_ROUNDS){
      const d=await apiFetchBatch(feedState,freshController.signal);
      if(gen!==freshGeneration)return;
      mergeFeedState(d.state);
      failures=d.failures||[];
      for(const sub of subs) initialAttempts[sub]++;
      const n=appendItems(d.items||[]);totalAdded+=n;rounds++;
      const counts=Object.fromEntries(subs.map(sub=>[sub,items.filter(x=>String(x.subreddit).toLowerCase()===sub.toLowerCase()).length]));
      const settled=subs.filter(sub=>{
        const st=feedState[sub]||{};
        return !!st.lastSuccessAt || !!st.exhausted || initialAttempts[sub]>=INITIAL_RETRY_PER_SUB;
      });
      const enoughTotal=items.length>=Math.max(45,settings.preloadThreshold+18);
      const everySubSettled=settled.length===subs.length;
      if(everySubSettled&&enoughTotal)break;
      if(everySubSettled&&rounds>=INITIAL_RETRY_PER_SUB)break;
      if(n===0)await sleep(550); else await sleep(120);
    }
    if(gen!==freshGeneration)return;
    if(!items.length){
      feed.innerHTML='<section id="empty" class="empty"><div class="empty-logo">R</div><h1>Sin resultados</h1><p>No encontré contenido con estos filtros. Reintentaré automáticamente si Reddit está limitando la carga.</p></section>';
      status(failures.length?`${failures.length}/${subs.length} subreddits pendientes · reintentando solo…`:'Sin contenido del tipo seleccionado');
      if(failures.length){initialRetryTimer=setTimeout(()=>{if(gen===freshGeneration)loadFresh()},3500);}
      return;
    }
    const present=[...new Set(items.map(x=>x.subreddit).filter(Boolean))];
    const scanned=Object.values(feedState).reduce((a,x)=>a+(Number(x.scannedEntries)||0),0);
    const stalled=subs.filter(sub=>feedState[sub]?.stalled).length;
    const perSub=subs.map(sub=>`${sub}:${items.filter(x=>String(x.subreddit).toLowerCase()===sub.toLowerCase()).length}`).join(' · ');
    status(`${items.length} únicos · ${present.length}/${subs.length} subreddits · ${scanned} posts escaneados · ${perSub}${stalled?` · ${stalled} cursor(es) reintentando`:''}${failures.length?` · ${failures.length} pendiente(s) de reintento`:''}`,7000);
    requestAnimationFrame(()=>{feed.scrollTo({top:0,behavior:'instant'});activate(0,true);scheduleBuffer(150)});
  }catch(e){
    if(e?.name==='AbortError')return;
    console.error(e);
    status(`Carga temporalmente fallida · reintentando automáticamente`,4200);
    initialRetryTimer=setTimeout(()=>{if(gen===freshGeneration)loadFresh()},3500);
  }finally{
    if(gen===freshGeneration){btn.disabled=false;btn.textContent='Cargar';}
  }
}

async function loadMore(auto=false){
  if(!subs.length)return 0;
  // Todos los disparadores (scroll, buffer, botón) comparten la MISMA promesa: nunca se pisan.
  if(morePromise)return morePromise;
  const gen=freshGeneration;
  morePromise=(async()=>{
    try{
      const d=await apiFetchBatch(feedState);
      if(gen!==freshGeneration)return 0;
      mergeFeedState(d.state);
      const n=appendItems(d.items||[]);
      const failed=(d.failures||[]).length;
      if(!auto){
        if(n)status(`+${n} elementos únicos${failed?` · ${failed} subreddit(s) reintentándose`:''}`);
        else status('Sin nuevos todavía · seguiré reintentando automáticamente');
      }
      return n;
    }catch(e){
      if(!auto)status('Reddit no respondió · reintentando automáticamente');
      return 0;
    }finally{morePromise=null;}
  })();
  const n=await morePromise;
  if(auto&&!bufferIsHealthy())scheduleBuffer(n?250:bufferBackoff);
  return n;
}

function commitFilters(changed){
  const v=$('filterVideo').checked,g=$('filterGif').checked,i=$('filterImage').checked;if(!v&&!g&&!i){changed.checked=true;status('Tiene que quedar al menos un filtro activo');return}
  settings={...settings,filterVideo:v,filterGif:g,filterImage:i};save(KEYS.settings,settings);if(parseSubs().length)loadFresh();
}
['filterVideo','filterGif','filterImage'].forEach(id=>$(id).addEventListener('change',()=>commitFilters($(id))));
$('volume').addEventListener('input',()=>{settings.volume=Number($('volume').value);if(settings.volume>0)settings.muted=false;$('volumeValue').textContent=`${settings.volume}%`;save(KEYS.settings,settings);applyVolumeToAll()});
$('muteBtn').onclick=()=>{settings.muted=!settings.muted;save(KEYS.settings,settings);applyVolumeToAll();const v=document.querySelector(`.slide[data-index="${current}"] video`);if(v&&!settings.muted)v.play().catch(()=>{});status(settings.muted?'Silencio':'Sonido activado')};
$('loadBtn').onclick=loadFresh;$('sort').onchange=()=>{$('period').classList.toggle('hidden',$('sort').value!=='top')};$('period').onchange=()=>{if(parseSubs().length)loadFresh()};$('subs').addEventListener('keydown',e=>{if(e.key==='Enter')loadFresh()});

$('presetsBtn').onclick=()=>{renderPresets();$('presetsDialog').showModal()};$('settingsBtn').onclick=()=>{syncSettings();$('settingsDialog').showModal()};$('historyBtn').onclick=()=>{renderHistory();$('historyDialog').showModal()};$('fullscreenBtn').onclick=toggleFeedFullscreen;document.addEventListener('fullscreenchange',()=>{syncFullscreenButtons();syncPlayButtons()});document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>$(b.dataset.close).close());
$('saveSettings').onclick=()=>{settings={...settings,hideSeen:$('hideSeen').checked,autoSeen:$('autoSeen').checked,autoplay:$('autoplay').checked,showNsfw:$('showNsfw').checked,preloadThreshold:Math.max(3,Math.min(30,Number($('preloadThreshold').value)||25))};save(KEYS.settings,settings);$('settingsDialog').close();status('Ajustes guardados');if(parseSubs().length)loadFresh()};
$('savePreset').onclick=()=>{const name=$('presetName').value.trim(),list=parseSubs();if(!name||!list.length){status('Pon nombre y subreddits');return}presets=presets.filter(p=>p.name.toLowerCase()!==name.toLowerCase());presets.unshift({name,subs:list});save(KEYS.presets,presets);$('presetName').value='';renderPresets()};
function renderPresets(){$('presetList').innerHTML='';if(!presets.length){$('presetList').innerHTML='<p class="small">Aún no hay Multis guardados.</p>';return}for(const p of presets){const r=document.createElement('div');r.className='list-row';r.innerHTML=`<b>${esc(p.name)}</b><span class="small">${esc(p.subs.join(', '))}</span>`;const a=document.createElement('div');a.className='list-actions';const use=document.createElement('button');use.className='primary';use.textContent='Usar';use.onclick=()=>{$('subs').value=p.subs.join(', ');$('presetsDialog').close();loadFresh()};const del=document.createElement('button');del.className='ghost';del.textContent='Eliminar';del.onclick=()=>{presets=presets.filter(x=>x!==p);save(KEYS.presets,presets);renderPresets()};a.append(use,del);r.append(a);$('presetList').append(r)}}
function renderHistory(){$('historyList').innerHTML='';if(!history.length){$('historyList').innerHTML='<p class="small">Sin historial.</p>';return}history.slice(0,300).forEach(h=>{const r=document.createElement('div');r.className='list-row';r.innerHTML=`<b>${esc(h.title||h.id)}</b><span class="small">r/${esc(h.subreddit)} · ${new Date(h.when).toLocaleString('es-ES')}</span>`;$('historyList').append(r)})}
$('clearHistory').onclick=()=>{seen.clear();seenMedia.clear();history=[];save(KEYS.seen,[]);save(KEYS.seenMedia,[]);save(KEYS.history,[]);$('seenCount').textContent='0';renderHistory();status('Historial borrado')};

document.addEventListener('keydown',e=>{if(document.querySelector('dialog[open]'))return;if(e.key==='ArrowDown'||e.key==='PageDown'){e.preventDefault();go(current+1)}if(e.key==='ArrowUp'||e.key==='PageUp'){e.preventDefault();go(current-1)}if(e.key===' '){e.preventDefault();toggleCurrentVideo(document.querySelector(`.slide[data-index="${current}"]`))}if(e.key.toLowerCase()==='f'){e.preventDefault();toggleFeedFullscreen()}});
function go(i){if(!items.length)return;i=Math.max(0,Math.min(items.length-1,i));document.querySelector(`.slide[data-index="${i}"]`)?.scrollIntoView({behavior:'smooth',block:'start'})}
$('period').classList.toggle('hidden',$('sort').value!=='top');
fetch('/api/health').then(r=>r.json()).then(()=>status('Listo')).catch(()=>status('No puedo conectar con el servidor'));
})();
