const $=s=>document.querySelector(s);
const PALETTE=['#ff6a1a','#4cc9f0','#7dce4a','#f7d154','#c792ea','#ff5d8f','#2dd4bf','#60a5fa','#fb923c','#f472b6','#a3e635','#e879f9'];
const STORE='nest-presets-v1';
const S={parts:[],groups:{},res:null,tab:null,file:'peças',uid:0,sets:[],forbid:[],presetId:null,activePreset:null,snap:null,pdf:null,sheetMemory:{}};

/* ---------- geometria ---------- */
const area=p=>{let a=0;for(let i=0,n=p.length;i<n;i++){const q=p[(i+1)%n];a+=p[i][0]*q[1]-q[0]*p[i][1]}return a/2};
const bbox=rs=>{let x0=1e18,y0=1e18,x1=-1e18,y1=-1e18;for(const r of rs)for(const[x,y]of r){if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y}return{x0,y0,x1,y1,w:x1-x0,h:y1-y0}};
function pip(pt,poly){let c=false;const[x,y]=pt;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>y)!=(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])c=!c}return c}
/* SPLINE do DXF (NURBS): avalia pelos pontos de controle (de Boor); sem eles, liga os pontos de ajuste. */
function splinePts(e){const p=+((e.find(x=>x[0]===71)||[0,3])[1]),K=[],C=[],W=[],F=[];let c1=null,f1=null;
  for(const[c,v]of e){if(c===40)K.push(+v);else if(c===41)W.push(+v);else if(c===10){c1=[+v,0];C.push(c1)}else if(c===20&&c1)c1[1]=+v;else if(c===11){f1=[+v,0];F.push(f1)}else if(c===21&&f1)f1[1]=+v}
  if(!(p>=1&&C.length>p&&K.length===C.length+p+1))return F;
  const w=W.length===C.length?W:C.map(()=>1),a=K[p],b=K[C.length],N=Math.max(64,C.length*16),out=[];
  for(let s=0;s<=N;s++){const u=Math.min(b-1e-12*Math.max(1,Math.abs(b)),a+(b-a)*s/N);let k=p;while(k<C.length-1&&u>=K[k+1])k++;
    const d=[];for(let j=0;j<=p;j++){const q=C[k-p+j],ww=w[k-p+j];d.push([q[0]*ww,q[1]*ww,ww])}
    for(let r=1;r<=p;r++)for(let j=p;j>=r;j--){const i=k-p+j,den=K[i+p-r+1]-K[i],al=den?(u-K[i])/den:0;d[j]=d[j].map((x,m)=>(1-al)*d[j-1][m]+al*x)}
    out.push([d[p][0]/d[p][2],d[p][1]/d[p][2]])}
  return out}
function ellipsePts(g){const cx=g(10),cy=g(20),mx=g(11),my=g(21),ra=g(40,1);let t0=g(41,0),t1=g(42,Math.PI*2);if(t1<=t0)t1+=Math.PI*2;
  const n=Math.max(24,Math.ceil((t1-t0)/(Math.PI*2)*96)),out=[];
  for(let k=0;k<=n;k++){const t=t0+(t1-t0)*k/n,c=Math.cos(t),s=Math.sin(t);out.push([cx+c*mx-s*ra*my,cy+c*my+s*ra*mx])}
  return out}
function arcPts(cx,cy,r,a0,a1,ccw=true){let d=a1-a0;if(ccw){while(d<=0)d+=360}else{while(d>=0)d-=360}
  const n=Math.max(4,Math.ceil(Math.abs(d)/(r>200?2:5)));const o=[];for(let i=0;i<=n;i++){const a=(a0+d*i/n)*Math.PI/180;o.push([cx+r*Math.cos(a),cy+r*Math.sin(a)])}return o}
function bulgePts(a,b,bu){const dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy);if(!d||!bu)return[a,b];
  const th=4*Math.atan(bu),r=d/2/Math.sin(th/2),mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2,h=r*Math.cos(th/2),cx=mx-dy/d*h,cy=my+dx/d*h;
  const a0=Math.atan2(a[1]-cy,a[0]-cx),n=Math.max(2,Math.ceil(Math.abs(th)/0.1)),o=[];for(let i=0;i<=n;i++){const t=a0+th*i/n;o.push([cx+Math.abs(r)*Math.cos(t),cy+Math.abs(r)*Math.sin(t)])}return o}

/* ---------- leitura ---------- */
function parseDXF(txt,unitSel){
  const L=txt.split(/\r?\n/),G=[];for(let i=0;i+1<L.length;i+=2)G.push([+L[i],L[i+1].trim()]);
  let scale=1,u=null;for(let i=0;i<G.length;i++)if(G[i][1]==='$INSUNITS'){u=+G[i+1][1];break}
  const UN={1:25.4,2:304.8,4:1,5:10,6:1000,3:1609344},unitKnown=unitSel!=='auto'||!!UN[u];scale=unitSel!=='auto'?+unitSel:(UN[u]||1);
  let i=G.findIndex((g,k)=>g[0]===2&&g[1]==='ENTITIES');if(i<0)i=0;
  const segs=[],closed=[],lay={},geo={};let skipped=0;
  while(i<G.length){
    if(G[i][0]!==0){i++;continue}
    const t=G[i][1];if(t==='ENDSEC'||t==='EOF')break;let j=i+1;const e=[];while(j<G.length&&G[j][0]!==0)e.push(G[j++]);i=j;
    const g=(c,d=0)=>{const f=e.find(x=>x[0]===c);return f?+f[1]:d},lay_=(e.find(x=>x[0]===8)||[0,'0'])[1];
    const sg=(a,b)=>{const q=[a,b];q.lay=lay_;segs.push(q)},add=(pts)=>{lay[lay_]=(lay[lay_]||0)+1;for(let k=0;k<pts.length-1;k++)sg(pts[k],pts[k+1])};
    if(t==='LINE'){lay[lay_]=(lay[lay_]||0)+1;sg([g(10),g(20)],[g(11),g(21)])}
    else if(t==='ARC'){add(arcPts(g(10),g(20),g(40),g(50),g(51)))}
    else if(t==='CIRCLE'){const p=arcPts(g(10),g(20),g(40),0,360);p.pop();p.lay=lay_;lay[lay_]=(lay[lay_]||0)+1;closed.push(p)}
    else if(t==='LWPOLYLINE'){const v=[];let cur=null;for(const[c,val]of e){if(c===10){cur={p:[+val,0],b:0};v.push(cur)}else if(c===20&&cur)cur.p[1]=+val;else if(c===42&&cur)cur.b=+val}
      const cl=(g(70)&1)===1,pts=[];const n=v.length;for(let k=0;k<(cl?n:n-1);k++){const s=bulgePts(v[k].p,v[(k+1)%n].p,v[k].b);pts.push(...(k?s.slice(1):s))}
      if(!cl&&!pts.length)continue;lay[lay_]=(lay[lay_]||0)+1;if(cl){pts.pop();pts.lay=lay_;closed.push(pts)}else for(let k=0;k<pts.length-1;k++)sg(pts[k],pts[k+1])}
    else if(t==='SPLINE'||t==='ELLIPSE'){const pts=t==='SPLINE'?splinePts(e):ellipsePts(g);
      if(pts.length<2){geo[t]=(geo[t]||0)+1;continue}lay[lay_]=(lay[lay_]||0)+1;
      const end=pts[pts.length-1],cl=(t==='SPLINE'&&(g(70)&1)===1)||Math.hypot(pts[0][0]-end[0],pts[0][1]-end[1])<1e-6;
      if(cl){if(Math.hypot(pts[0][0]-end[0],pts[0][1]-end[1])<1e-6)pts.pop();pts.lay=lay_;closed.push(pts)}else for(let k=0;k<pts.length-1;k++)sg(pts[k],pts[k+1])}
    else if(['INSERT','POLYLINE'].includes(t))geo[t]=(geo[t]||0)+1;
    else if(['TEXT','MTEXT','DIMENSION','HATCH','POINT'].includes(t))skipped++;
  }
  const sc=r=>Object.assign(r.map(p=>[p[0]*scale,p[1]*scale]),{lay:r.lay});
  return{segs:segs.map(sc),closed:closed.map(sc),skipped,geo,scale,lay,unitKnown}}
function parseSVG(txt){const d=new DOMParser().parseFromString(txt,'image/svg+xml'),closed=[];
  d.querySelectorAll('path,polygon,polyline,rect,circle').forEach(el=>{const sv=document.createElementNS('http://www.w3.org/2000/svg','svg');sv.style.cssText='position:absolute;visibility:hidden';document.body.appendChild(sv);
    let p=el.cloneNode();sv.appendChild(p);if(!p.getTotalLength){sv.remove();return}
    try{const subs=(el.getAttribute('d')||'').split(/(?=[Mm])/).filter(s=>s.trim());(subs.length?subs:[null]).forEach(s=>{if(s){p.setAttribute('d',s)}const n=p.getTotalLength(),k=Math.max(24,Math.min(600,n/1.5|0)),r=[];for(let i=0;i<k;i++){const q=p.getPointAtLength(n*i/k);r.push([q.x,-q.y])}if(r.length>2)closed.push(r)})}catch(e){}sv.remove()});
  return{segs:[],closed,skipped:0,scale:1,lay:{}}}
function chain(segs,tol){
  const K=p=>Math.round(p[0]/tol)+','+Math.round(p[1]/tol),M=new Map();
  const ad=(k,i)=>{(M.get(k)||M.set(k,[]).get(k)).push(i)};
  segs.forEach((s,i)=>{ad(K(s[0]),i);ad(K(s[1]),i)});
  const used=new Uint8Array(segs.length),loops=[];let open=0;
  for(let i=0;i<segs.length;i++){if(used[i])continue;used[i]=1;const pts=[segs[i][0],segs[i][1]];pts.lay=segs[i].lay;const k0=K(pts[0]);let end=pts[1],ok=false;
    for(;;){const ke=K(end);if(ke===k0&&pts.length>2){ok=true;break}
      const c=(M.get(ke)||[]).find(x=>!used[x]);if(c===undefined)break;used[c]=1;const s=segs[c];end=K(s[0])===ke?s[1]:s[0];pts.push(end)}
    if(ok){pts.pop();loops.push(pts)}else open++}
  return{loops,open}}
/* Camadas do CAD no padrão Aspire/Alphacam: REBAIXO_5 (ou POCKET_5) = rebaixo de 5 mm; FURO_10 = furo cego de 10 mm. */
const PK_LAYER=/^(REBAIXO|POCKET|FURO)[_\- ]?(\d+(?:[.,]\d+)?)/i;
function makeParts(rings,name){
  const pk=[];
  rings=rings.filter(r=>{const m=PK_LAYER.exec(r.lay||'');if(m&&r.length>2){pk.push({r,d:+m[2].replace(',','.'),k:/^furo/i.test(m[1])?'furo':'rebaixo'});return false}return true});
  rings=rings.filter(r=>r.length>2&&Math.abs(area(r))>1e-3).sort((a,b)=>Math.abs(area(b))-Math.abs(area(a)));
  const depth=rings.map((r,i)=>{const pt=[(r[0][0]+r[1][0])/2,(r[0][1]+r[1][1])/2];let d=0;for(let j=0;j<i;j++)if(pip(pt,rings[j]))d++;return d});
  const out=[];
  rings.forEach((r,i)=>{if(depth[i]%2===0)out.push({rings:[r],o:i});else{let best=-1;for(let j=i-1;j>=0;j--)if(depth[j]===depth[i]-1&&pip([(r[0][0]+r[1][0])/2,(r[0][1]+r[1][1])/2],rings[j])){best=j;break}
    const p=out.find(x=>x.o===best);if(p)p.rings.push(r)}});
  return out.map(p=>{const b=bbox([p.rings[0]]),mv=r=>r.map(q=>[q[0]-b.x0,q[1]-b.y0]),rs=p.rings.map(mv);
    const mine=pk.filter(x=>!x.used&&pip(x.r[0],p.rings[0])&&!p.rings.slice(1).some(h=>pip(x.r[0],h)));mine.forEach(x=>{x.used=1});
    const A=Math.abs(area(rs[0]))-rs.slice(1).reduce((s,r)=>s+Math.abs(area(r)),0);
    return{rings:rs,w:b.w,h:b.h,A,holes:rs.length-1,...(mine.length?{pk:mine.map(x=>({r:mv(x.r),d:x.d,k:x.k}))}:{})}})}
function addParts(list,mat,th,merge,x={}){
  for(const p of list){const sig=[Math.round(p.A/4),Math.round(Math.max(p.w,p.h)),Math.round(Math.min(p.w,p.h)),p.holes].join('|');
    const ex=merge&&S.parts.find(q=>q.sig===sig&&q.mat===mat&&q.th===th&&q.fileId===x.fileId);if(ex){ex.qty++;continue}
    const nth=S.parts.filter(q=>q.fileId===x.fileId).length+1;
    S.parts.push({...p,id:++S.uid,sig,qty:1,on:true,mirror:false,rot:'auto',mat,th,name:(x.stem||'Peça')+' '+nth,groupId:x.groupId||'',color:'',pick:false,fileId:x.fileId||'',thSrc:x.thSrc||'',matSrc:x.matSrc||'',projectId:S.projectId||''})}}

/* ---------- importação ---------- */
/* ---------- persistência no servidor (data/*.json) ---------- */
S.store={rev:0,projects:[],models:[],presets:[],settings:{naming:'{projeto}_{material}_{espessura}MM_{seq}'}};S.projectId=null;S.files=[];S.seq={};S.setQty={};S.savedNest=null;S.links=[];S.ready=false;
const sent={meta:'',models:'',proj:''};let saveT=null;
function setSaved(t,k){const el=$('#saved');el.textContent=t;el.className='saved '+(k||'')}
/* Rede caída vira mensagem clara em vez de "Failed to fetch". */
const OFF='O servidor local está desligado. Abra o iniciar.bat (ou rode python server.py) e tente de novo.';
async function sfetch(url,opt){try{return await fetch(url,opt)}catch(e){setSaved('servidor desligado','bad');throw Error(OFF)}}
async function api(path,body){const r=await sfetch(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});if(!r.ok){const e=Error(await r.text());e.status=r.status;throw e}return r.json()}
function hist(kind,detail){api('/api/history',{kind,detail,project:S.projectId||''}).catch(()=>{})}
const metaPatch=()=>({projects:S.store.projects,products:S.store.products||[],plans:S.store.plans||[],models:S.sets,presets:S.store.presets,settings:{...S.store.settings,forbid:S.forbid,mix:$('#mix').checked}});
const projPayload=()=>({uid:S.uid,seq:S.seq,files:S.files,groups:S.groups,setQty:S.setQty,nest:S.savedNest,...(S.links.length?{links:S.links}:{}),parts:S.parts.filter(p=>!p.guest).map(({pick,guest,...p})=>p)});
function autosave(){if(!S.ready)return;clearTimeout(saveT);saveT=setTimeout(()=>flush(),700);setSaved('gravando…')}
/* Uma gravação por vez: quem chega durante uma espera por ela e grava de novo se ainda houver diferença (senão o rev do servidor dá 409). */
let flushP=null;
function flush(){if(flushP)return flushP.then(flush);flushP=flush0().finally(()=>{flushP=null});return flushP}
/* rev vai só no corpo enviado; sent.proj fica sem ele, senão cada gravação geraria outra. */
const projBody=(p,rev)=>JSON.stringify({...JSON.parse(p),rev:rev||0});
async function flush0(){
  if(!S.ready)return;clearTimeout(saveT);saveT=null;
  const m=JSON.stringify(metaPatch()),pid=S.projectId,p=pid?JSON.stringify(projPayload()):'',prev=S.projRev;
  try{
    if(m!==sent.meta){const r=await api('/api/store',{rev:S.store.rev,patch:JSON.parse(m)});S.store.rev=r.rev;sent.meta=m;
      const mm=JSON.stringify(S.sets);if(mm!==sent.models){if(sent.models)hist('models.update',{models:S.sets.map(s=>({id:s.id,name:s.name,color:s.color}))});sent.models=mm}}
    if(pid&&p!==sent.proj){const r=await api('/api/project/'+pid,JSON.parse(projBody(p,prev)));if(S.projectId===pid){sent.proj=p;if(r&&Number.isInteger(r.rev))S.projRev=r.rev}}
    setSaved('salvo '+new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'}),'ok');
  }catch(e){if(e.status===409){S.ready=false;setSaved('dados alterados em outra janela: recarregue','bad');toast(e.message,'bad')}else setSaved('falha ao gravar','bad')}}
/* Fechar com algo por gravar: dispara a gravação (keepalive sobrevive ao fechamento) e pede confirmação. */
/* Saída da página: o aviso só adianta a gravação; o envio de última hora fica para o pagehide, quando a página sai de fato
   (gravar no aviso e o usuário ficar deixava rev e sent desatualizados: 409 falso na edição seguinte). */
const pending=()=>{if(!S.ready)return null;const m=JSON.stringify(metaPatch()),p=S.projectId?JSON.stringify(projPayload()):sent.proj;return flushP||m!==sent.meta||p!==sent.proj?{m,p}:null};
window.addEventListener('beforeunload',e=>{if(!pending())return;flush();e.preventDefault();e.returnValue=''});
window.addEventListener('pagehide',()=>{const d=pending();if(!d)return;
  if(d.m!==sent.meta)fetch('/api/store',{method:'POST',keepalive:true,body:JSON.stringify({rev:S.store.rev,patch:JSON.parse(d.m)})}).catch(()=>{});
  if(d.p!==sent.proj)fetch('/api/project/'+S.projectId,{method:'POST',keepalive:true,body:projBody(d.p,S.projRev)}).catch(()=>{})});

/* ---------- projetos ---------- */
const curProj=()=>S.store.projects.find(p=>p.id===S.projectId)||null;
const fileName=id=>{const f=S.files.find(x=>x.id===id);return f?f.name:''};
function renderProj(){const p=curProj();$('#projInfo').textContent='';$('#drop').classList.toggle('off',!p);
  const n=S.links.length;$('#linkTag').hidden=!n;$('#linkTag').textContent=n?'+ '+S.links.map(l=>projCode(l.id)).join(' + '):''}
/* O arquivo do projeto é dado externo: números das peças viram números de verdade antes de chegar ao HTML. */
const num=(v,d)=>{const n=typeof v==='number'||typeof v==='string'&&v.trim()?+v:NaN;return Number.isFinite(n)?n:d};
const normPart=p=>({...p,id:num(p.id,0),qty:Math.max(1,Math.round(num(p.qty,1))),th:num(p.th,0)>0?num(p.th,1):1,w:Math.max(0,num(p.w,0)),h:Math.max(0,num(p.h,0)),A:num(p.A,0),holes:Math.max(0,Math.round(num(p.holes,0))),mat:String(p.mat??''),name:String(p.name??''),pick:false});
async function openProject(id){
  cancelNest();await flush();
  const d=id?await api('/api/project/'+id):{};
  /* troca tudo de uma vez, sem await no meio: um autosave aqui não pode mandar dados velhos para o id novo */
  clearTimeout(saveT);saveT=null;S.projectId=id||null;S.projRev=Number.isInteger(d.rev)?d.rev:0;
  S.uid=Math.max(0,num(d.uid,0));S.parts=(d.parts||[]).map(normPart);for(const p of S.parts)if(!p.id)p.id=++S.uid;
  S.files=d.files||[];S.seq=d.seq||{};S.setQty=d.setQty||{};S.savedNest=d.nest||null;
  S.groups={};for(const k in d.groups||{}){const g=d.groups[k]||{};S.groups[k]={w:num(g.w,3000),h:num(g.h,1250)}}
  S.links=(d.links||[]).filter(l=>l&&l.id!==id&&S.store.projects.some(p=>p.id===l.id));sent.proj=JSON.stringify(projPayload());await loadGuests();
  S.res=null;S.snap=null;S.pdf=null;S.tab=null;
  if(S.store.settings.last!==id){S.store.settings.last=id;autosave()}
  renderProj();render();if(S.savedNest&&openSavedNest(true))render()}
/* ---------- encaixe conjunto: peças de outros projetos entram só para o cálculo ---------- */
/* As peças de um projeto juntado continuam gravadas no projeto de origem. Aqui são cópias só de leitura,
   com o id deslocado (base × 1e6) para não colidir com as do projeto aberto; o projeto aberto guarda apenas a lista `links`. */
const GUEST=1e6;
const projCode=id=>{const p=S.store.projects.find(x=>x.id===id);return p?p.code:''};
async function loadGuests(){
  S.parts=S.parts.filter(p=>!p.guest);
  for(const l of S.links){
    try{const d=await api('/api/project/'+l.id);for(const p of d.parts||[]){const q=normPart(p);S.parts.push({...q,id:num(l.base,0)*GUEST+q.id,guest:l.id})}}
    catch(e){toast('Não foi possível ler o projeto '+projCode(l.id)+': '+e.message,'bad')}}}
async function linkProject(id,on){
  if(!S.projectId||id===S.projectId)return;
  cancelNest();
  if(on){if(!S.links.some(l=>l.id===id)){let b=1;while(S.links.some(l=>l.base===b))b++;S.links.push({id,base:b})}}
  else S.links=S.links.filter(l=>l.id!==id);
  await loadGuests();S.res=null;S.snap=null;S.pdf=null;renderProj();render();
  status(on?'Peças de '+projCode(id)+' juntadas ao encaixe. Encaixe de novo.':'Peças de '+projCode(id)+' retiradas do encaixe.',false)}
/* ---------- importação em lote com revisão ---------- */
const sha256=async buf=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',buf))].map(b=>b.toString(16).padStart(2,'0')).join('');
const thFromName=n=>{const m=n.match(/(\d+(?:[.,]\d+)?)\s*mm/i);return m?+m[1].replace(',','.'):null};
async function analyze(f){
  const ext=f.name.split('.').pop().toLowerCase(),row={f,name:f.name,ext,size:f.size,include:true,warn:[],parts:[],err:'',model:'',dup:'',contours:0,unitKnown:true};
  try{
    const buf=await f.arrayBuffer();row.hash=await sha256(buf);let r;
    if(ext==='svg')r=parseSVG(new TextDecoder().decode(buf));
    else if(ext==='dxf'||ext==='dwg'){let txt;
      if(ext==='dwg'){const res=await sfetch('/api/dwg',{method:'POST',headers:{'X-Filename':encodeURIComponent(f.name)},body:buf});if(!res.ok)throw Error(await res.text());txt=await res.text()}else txt=new TextDecoder().decode(buf);
      r=parseDXF(txt,$('#unit').value)}
    else throw Error('formato não suportado');
    const c=chain(r.segs,+$('#tol').value||.05);
    row.parts=makeParts([...r.closed,...c.loops],f.name);row.contours=r.closed.length+c.loops.length;row.unitKnown=r.unitKnown!==false;
    if(c.open)row.warn.push(c.open+' cadeia(s) aberta(s) ignorada(s)');
    row.geo=Object.entries(r.geo||{}).map(([t,n])=>n+' '+t).join(', ');
    if(r.skipped)row.warn.push(r.skipped+' texto(s)/cota(s) ignorado(s)');
    if(!row.unitKnown)row.warn.push('unidade ausente no arquivo: assumido mm');
    if(!row.parts.length)row.err='nenhuma peça fechada encontrada';
  }catch(e){row.err=e.message||String(e)}
  const th=thFromName(f.name);
  row.mat=$('#defMat').value||'Material';row.matSrc='padrão';
  row.th=th||+$('#defTh').value||1;row.thSrc=th?'inferida do nome':'padrão';
  const known=IMP_TARGET==='product'&&PR.doc?PR.doc.files:S.files,same=known.find(x=>x.hash===row.hash);
  if(same&&row.hash){row.dup=same.name;row.include=false}
  else if(known.some(x=>x.name===f.name))row.warn.push('mesmo nome de um arquivo já importado, conteúdo diferente');
  if(row.err)row.include=false;
  return row}
let IMP=null;
function impRender(){
  IMP.rows.forEach(fitTh);
  const mods=S.sets.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  const src=(t)=>t?`<span class="tag ${t==='manual'?'':'inf'}">${esc(t)}</span>`:'';
  const B=IMP.bulk,nOn=IMP.rows.filter(r=>r.include&&!r.err).length;
  const bulk=IMP.rows.length<2?'':`<div class="imp imp-bulk"><div class="imp-hd"><div class="imp-name"><b>Mesma configuração para todos</b><span class="imp-meta">Aplica nos arquivos marcados (${nOn}).</span></div>
      <button type="button" class="pri" data-bulk-apply ${nOn?'':'disabled'}>Aplicar aos marcados</button></div>
    <div class="imp-fields">
      <label class="f">Material<select data-b="mat">${matOptions(B.mat)}</select></label>
      <label class="f">Espessura${thField(B.mat,B.th,'data-b="th"')}</label>
      <label class="f">Modelo<select data-b="model"><option value="__keep">Manter o de cada arquivo</option><option value="" ${B.model===''?'selected':''}>Sem modelo</option>${S.sets.map(s=>`<option value="${esc(s.id)}" ${B.model===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label>
    </div></div>`;
  $('#impBody').innerHTML=bulk+IMP.rows.map((r,i)=>{
    const st=r.err?`<span class="tag pend">erro: ${esc(r.err)}</span>`:r.dup?`<span class="tag pend">idêntico a ${esc(r.dup)}</span>`:'';
    const w=(r.geo?`<span class="tag pend">desenho não lido: ${esc(r.geo)}. A peça pode estar incompleta</span>`:'')+r.warn.map(x=>`<span class="tag inf">${esc(x)}</span>`).join('');
    return `<div class="imp" data-i="${i}"${r.include?'':' data-off'}>
      <div class="imp-hd"><input type="checkbox" data-k="include" ${r.include?'checked':''} ${r.err?'disabled':''} aria-label="Importar ${esc(r.name)}">
        <div class="imp-name"><b title="SHA-256 ${esc(r.hash||'')}">${esc(r.name)}</b><span class="imp-meta">${esc(r.ext)} · ${Math.max(1,Math.round(r.size/1024))} KB · ${r.contours} contorno(s) → ${r.parts.length} peça(s)</span></div>
        <div class="imp-st">${st}${w}${!st&&!w?'<span class="tag ok">pronto</span>':''}</div></div>
      <div class="imp-fields">
        <label class="f"><span class="imp-lb">Material ${src(r.matSrc)}</span><select data-k="mat">${matOptions(r.mat)}</select></label>
        <label class="f"><span class="imp-lb">Espessura ${src(r.thSrc)}</span>${thField(r.mat,r.th,'data-k="th"')}</label>
        <label class="f"><span class="imp-lb">Modelo${r.model?'':' <span class="tag pend">pendente</span>'}</span><select data-k="model"><option value="">Sem modelo</option>${mods.replace(`value="${esc(r.model)}"`,`value="${esc(r.model)}" selected`)}</select></label>
      </div></div>`}).join('');
  const n=IMP.rows.filter(r=>r.include).length,p=curProj(),dest=IMP_TARGET==='product'&&PR.doc?'produto '+PR.doc.name:'área de encaixe';
  $('#impModal').classList.toggle('prod',IMP_TARGET==='product');
  $('#impHead').textContent=`Destino: ${dest}. ${n} de ${IMP.rows.length} arquivo(s) serão importados.`;$('#impOk').disabled=!n}
/* Espessura da barra em lote: dentro das do material escolhido. */
function fitBulk(){const B=IMP.bulk,ts=presetThicknesses(B.mat);if(ts.length&&!ts.includes(+B.th))B.th=ts[0]}
$('#impBody').addEventListener('click',e=>{if(!IMP||!e.target.closest('[data-bulk-apply]'))return;
  const B=IMP.bulk,use=IMP.rows.filter(r=>r.include&&!r.err);
  for(const r of use){r.mat=B.mat;r.matSrc='em lote';if(+B.th>0){r.th=+B.th;r.thSrc='em lote'}if(B.model!=='__keep')r.model=B.model}
  impRender();toast('Configuração aplicada a '+use.length+' arquivo(s).','ok')});
function reviewImport(rows){IMP={rows,bulk:{mat:(rows[0]&&rows[0].mat)||$('#defMat').value,th:(rows[0]&&rows[0].th)||+$('#defTh').value||1,model:'__keep'}};fitBulk();impRender();showModal('impModal','#impOk')}
$('#impBody').addEventListener('input',e=>{const b=e.target.dataset.b;
  if(b&&IMP){IMP.bulk[b]=b==='th'?+e.target.value:e.target.value;if(b==='mat'){fitBulk();impRender()}return}
  const tr=e.target.closest('[data-i]');if(!tr||!IMP)return;const r=IMP.rows[+tr.dataset.i],k=e.target.dataset.k;
  if(k==='include'){r.include=e.target.checked;impRender();return}
  if(k==='mat'){r.mat=e.target.value;r.matSrc='manual'}if(k==='th'){r.th=+e.target.value;r.thSrc='manual'}if(k==='model')r.model=e.target.value});
$('#impBody').addEventListener('change',e=>{if(IMP&&['mat','th','model'].includes(e.target.dataset.k))impRender()});
$('#impNo').onclick=()=>{hideModal('impModal');IMP=null};
$('#impOk').onclick=async()=>{
  const use=IMP.rows.filter(r=>r.include&&!r.err);
  const bad=use.find(r=>!(r.th>0)||!r.mat.trim());if(bad){toast('Informe material e espessura válidos em '+bad.name+'.','bad');return}
  const part=use.filter(r=>r.geo);
  if(part.length&&!await ask('Parte do desenho não foi lida e as peças podem sair incompletas (sem um furo ou um contorno):\n'+part.map(r=>'• '+r.name+': '+r.geo).join('\n')+'\n\nNo CAD, exploda os blocos (INSERT) e converta POLYLINE 3D em polilinhas antes de exportar o DXF. Importar mesmo assim?','Importar mesmo assim',true))return;
  if(!IMP)return;
  if(IMP_TARGET==='product'){prodCommit(use,part);return}
  const done=[];
  for(const r of use){const id=nid('f'),before=S.parts.length;
    addParts(r.parts,r.mat.trim(),r.th,true,{fileId:id,groupId:r.model,thSrc:r.thSrc,matSrc:r.matSrc,stem:r.name.replace(/\.\w+$/,'')});
    if(r.model)for(const q of S.parts.slice(before))q.qty*=setN(r.model);
    S.files.push({id,name:r.name,format:r.ext,size:r.size,hash:r.hash,importedAt:new Date().toISOString(),status:'importado',parts:S.parts.length-before,unitKnown:r.unitKnown,mat:r.mat.trim(),th:r.th,thSrc:r.thSrc,matSrc:r.matSrc});
    done.push({name:r.name,hash:r.hash,parts:S.parts.length-before,mat:r.mat.trim(),th:r.th,thSrc:r.thSrc})}
  hideModal('impModal');IMP=null;
  if(!done.length){toast('Nada importado.','bad');return}
  const pend=S.parts.filter(p=>!p.groupId).length;
  $('#imsg').className='msg'+(pend?' w':' ok');$('#imsg').textContent=`${done.length} arquivo(s) importado(s).`+(pend?` ${pend} peça(s) sem modelo, pendentes de classificação.`:'');
  hist('import',{files:done,unread:part.map(r=>({name:r.name,entities:r.geo}))});S.res=null;S.snap=null;S.pdf=null;render();flush()};
async function startImport(files){files=[...files];if(!files.length)return;
  if(!S.ready){toast('Servidor indisponível: não é possível gravar a importação.','bad');return}
  if(!S.projectId){toast('Área de encaixe indisponível.','bad');return}
  IMP_TARGET='project';
  $('#imsg').className='msg';$('#imsg').textContent='Lendo '+files.length+' arquivo(s)…';
  const rows=[];for(const f of files)rows.push(await analyze(f));
  const seen=new Map();rows.forEach(r=>{if(r.hash&&seen.has(r.hash)&&!r.dup){r.dup=seen.get(r.hash)+' (neste lote)';r.include=false}else if(r.hash)seen.set(r.hash,r.name)});
  $('#imsg').textContent='';reviewImport(rows)}
const drop=$('#drop');
['dragover','dragenter'].forEach(e=>drop.addEventListener(e,ev=>{ev.preventDefault();drop.classList.add('on')}));
['dragleave','drop'].forEach(e=>drop.addEventListener(e,()=>drop.classList.remove('on')));
drop.addEventListener('drop',ev=>{ev.preventDefault();startImport(ev.dataTransfer.files)});
$('#file').onchange=e=>{const fl=[...e.target.files];e.target.value='';startImport(fl)};

$('#job').addEventListener('input',()=>{$('#job').dataset.touched='1'});

/* ---------- encaixe ---------- */
function tf(rings,ang,mir){const a=ang*Math.PI/180,c=Math.cos(a),s=Math.sin(a);
  let r=rings.map(q=>q.map(([x,y])=>{if(mir)x=-x;return[x*c-y*s,x*s+y*c]}));const b=bbox(r);return{rings:r.map(q=>q.map(([x,y])=>[x-b.x0,y-b.y0])),w:b.w,h:b.h}}
function mask(rings,w,h,cs,r){
  const W=Math.ceil(w/cs)+1+2*r,H=Math.ceil(h/cs)+1+2*r,m=new Uint8Array(W*H);
  for(let y=0;y<H;y++){const yy=(y-r+.5)*cs,xs=[];
    for(const q of rings)for(let i=0,n=q.length;i<n;i++){const a=q[i],b=q[(i+1)%n];if((a[1]>yy)!==(b[1]>yy))xs.push(a[0]+(yy-a[1])/(b[1]-a[1])*(b[0]-a[0]))}
    xs.sort((a,b)=>a-b);for(let k=0;k+1<xs.length;k+=2){const x0=Math.max(0,Math.round(xs[k]/cs-.5)+r),x1=Math.min(W-1,Math.round(xs[k+1]/cs-.5)+r);for(let x=x0;x<=x1;x++)m[y*W+x]=1}}
  /* Além do miolo, marca toda célula que o contorno toca: pontas agudas entre duas faixas não escapam e o espaço pedido vira um mínimo. */
  for(const q of rings)for(let i=0,n=q.length;i<n;i++){const a=q[i],b=q[(i+1)%n],lo=Math.min(a[1],b[1]),hi=Math.max(a[1],b[1]);
    for(let y=Math.max(0,Math.floor(lo/cs)+r),y1=Math.min(H-1,Math.floor(hi/cs)+r);y<=y1;y++){let xa=a[0],xb=b[0];
      if(lo!==hi){const b0=(y-r)*cs,ya=Math.max(lo,b0),yb=Math.min(hi,b0+cs);xa=a[0]+(ya-a[1])/(b[1]-a[1])*(b[0]-a[0]);xb=a[0]+(yb-a[1])/(b[1]-a[1])*(b[0]-a[0])}
      for(let x=Math.max(0,Math.floor(Math.min(xa,xb)/cs)+r),x1=Math.min(W-1,Math.floor(Math.max(xa,xb)/cs)+r);x<=x1;x++)m[y*W+x]=1}}
  if(r>0){const t=new Uint8Array(W*H);for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(m[y*W+x])for(let k=Math.max(0,x-r);k<=Math.min(W-1,x+r);k++)t[y*W+k]=1;
    m.fill(0);for(let y=0;y<H;y++)if(t.subarray(y*W,y*W+W).some(v=>v))for(let x=0;x<W;x++)if(t[y*W+x])for(let k=Math.max(0,y-r);k<=Math.min(H-1,y+r);k++)m[k*W+x]=1}
  const runs=[];for(let y=0;y<H;y++){let x=0;while(x<W){if(m[y*W+x]){let s=x;while(x<W&&m[y*W+x])x++;runs.push([y,s,x])}else x++}}
  return{W,H,runs}}
const fits=(sh,m,gx,gy)=>{const{W,occ}=sh;for(const[y,a,b]of m.runs){const o=(gy+y)*W+gx;for(let x=a;x<b;x++)if(occ[o+x])return false}return true};
function findSpot(sh,m,cap,e=0){
  for(let gx=e;gx<=Math.min(sh.W-m.W-e,cap);gx+=1)for(let gy=e;gy<=sh.H-m.H-e;gy+=1)if(fits(sh,m,gx,gy))return[gx,gy];return null}
function currentRules(){
  return {
    mix:$('#mix').checked,
    isolate:S.sets.filter(s=>s.isolate).map(s=>s.id),
    together:S.sets.filter(s=>s.together).map(s=>s.id),
    forbid:S.forbid.map(p=>[p[0],p[1]])
  };
}
function rulesActive(){const r=currentRules();return !r.mix||r.isolate.length>0||r.together.length>0||r.forbid.length>0}
/* Igual a nest.py _allows: a cor só separa chapa quando a regra pede. */
function sheetAllows(have,gid,rules){
  const isolate=new Set(rules.isolate||[]), together=new Set(rules.together||[]), forbid=rules.forbid||[];
  if(together.has(gid)) return !have.size || (have.size===1 && have.has(gid));
  for(const g of have) if(together.has(g)) return false;
  if(isolate.has(gid) || [...have].some(g=>isolate.has(g))) return !have.size || (have.size===1 && have.has(gid));
  if(!rules.mix) return !have.size || (have.size===1 && have.has(gid));
  for(const pair of forbid){const a=pair[0],b=pair[1];if((gid===a&&have.has(b))||(gid===b&&have.has(a)))return false}
  return true;
}
/* Espaço e margem por peça (vazio = do encaixe). A grade usa os menores; a peça com espaço maior ganha
   folga própria (r_a + r_b >= o maior dos dois) e a margem própria vira recuo e da borda, como nos motores do servidor. */
const ownMm=(v,d)=>v==null||v===''||!Number.isFinite(+v)||+v<0?d:+v;
function nestGroup(g,items,o,order){
  const gmin=Math.min(o.gap,...items.map(i=>ownMm(i.gap,o.gap))),mmin=Math.min(o.mar,...items.map(i=>ownMm(i.mar,o.mar)));
  const cs=o.cs,r=Math.ceil(gmin/2/cs),W=Math.floor((g.w-2*mmin)/cs),H=Math.floor((g.h-2*mmin)/cs),sheets=[],fail=[],failWhy=[];
  const rOf=it=>Math.max(r,Math.ceil(ownMm(it.gap,o.gap)/cs-1e-9)-r),eOf=it=>Math.max(0,Math.ceil((ownMm(it.mar,o.mar)-mmin)/cs-1e-9));
  if(W<1||H<1) return {sheets,fail:order.slice(),failWhy:order.map(()=>'tamanho')};
  const rules=o.rules||{mix:true,isolate:[],together:[],forbid:[]};
  const together=new Set(rules.together||[]), opened=new Map();
  const cache=new Map(),mk=(it,a,mi)=>{const k=it.id+'|'+a+'|'+mi;if(!cache.has(k)){const t=tf(it.rings,a,mi);cache.set(k,{...t,m:mask(o.fill===false?[t.rings[0]]:t.rings,t.w,t.h,cs,rOf(it))})}return cache.get(k)};
  /* Igual a nest.py angle_set: o giro da peça manda; 'auto' usa o global. shortcut: 'free' sem os ângulos do casco, só passo de 15°. */
  const angsOf=it=>{const md=it.rot;if(md==='0')return[0];if(md==='180')return[0,180];if(md==='90')return[0,90,180,270];
    const free=md==='free'||o.rot===-1,st=free?15:o.rot,a=[];if(st>0)for(let x=0;x<360;x+=st)a.push(x);else a.push(0);return a};
  // planejamento: produtos na ordem da lista (seq) e cada produto na mesma chapa ou nas vizinhas (near)
  if(o.seq)order=[...order].sort((a,b)=>(a.rank||0)-(b.rank||0));
  const span=new Map();
  for(const it of order){
    const gid=it.groupId||'';
    let put=false;const n0=sheets.length,sp0=o.near&&it.product?span.get(it.product):null;
    let tries=[...Array(n0+1).keys()];
    if(sp0){const pref=[];for(let k=sp0[0];k<=sp0[1]+1;k++)pref.push(k);if(sp0[0]>0)pref.push(sp0[0]-1);tries=[...pref.filter(k=>k<=n0),...tries.filter(k=>!pref.includes(k))]}
    for(const si of tries){if(put)break;
      if(si===sheets.length){
        if(together.has(gid)&&opened.has(gid)){fail.push(it);failWhy.push('junto');put=true;break}
        sheets.push({W,H,occ:new Uint8Array(W*H),placed:[],gids:new Set()});
      }
      const sh=sheets[si];
      if(together.has(gid)&&opened.has(gid)&&si!==opened.get(gid)) continue;
      if(!sheetAllows(sh.gids,gid,rules)){
        if(si===sheets.length-1&&sh.placed.length===0){sheets.pop();fail.push(it);failWhy.push('tamanho');put=true}
        continue;
      }
      let best=null;const ri=rOf(it),e=eOf(it);
      for(const a of angsOf(it))for(const mi of it.mirror?[0,1]:[0]){const c=mk(it,a,mi);if(c.m.W+2*e>W||c.m.H+2*e>H)continue;const sp=findSpot(sh,c.m,best?Math.ceil(best.sc/1e5)-c.m.W:1e9,e);if(!sp)continue;
        const sc=(sp[0]+c.m.W)*1e5+sp[1];if(!best||sc<best.sc)best={sc,a,mi,c,sp}}
      if(best){const{c,sp}=best;for(const[y,x0,x1]of c.m.runs)sh.occ.fill(1,(sp[1]+y)*W+sp[0]+x0,(sp[1]+y)*W+sp[0]+x1);
        sh.placed.push({it,rings:c.rings,x:mmin+(sp[0]+ri)*cs,y:mmin+(sp[1]+ri)*cs,w:c.w,h:c.h,a:best.a,mi:best.mi});
        sh.gids.add(gid);if(together.has(gid)&&!opened.has(gid))opened.set(gid,si);put=true;
        if(it.product){const q=span.get(it.product)||[si,si];span.set(it.product,[Math.min(q[0],si),Math.max(q[1],si)])}}
      else if(si===sheets.length-1&&sh.placed.length===0){sheets.pop();fail.push(it);failWhy.push('tamanho');put=true}
    }
    if(!put){fail.push(it);failWhy.push('tamanho')}
  }
  return{sheets,fail,failWhy}}
const used=g=>g.sheets.reduce((s,sh)=>s+sh.placed.reduce((q,p)=>q+p.it.A,0),0);
/* ---------- tempo de otimização ---------- */
const fmtSecs=v=>v<90?Math.round(v)+' s':(Math.round(v/6)/10).toLocaleString('pt-BR')+' min';
function setSecs(v,quiet){
  v=Math.max(5,Math.min(7200,Math.round(+v)||30));
  const pick=$('#secsPick'),known=[...pick.options].some(o=>o.value===String(v));
  pick.value=known?String(v):'';$('#secsBox').hidden=known;if(!known)$('#secsMin').value=Math.round(v/6)/10;
  if($('#secs').value!==String(v)){$('#secs').value=String(v);if(!quiet)$('#secs').dispatchEvent(new Event('change'))}
}
$('#secsPick').onchange=e=>{if(e.target.value)setSecs(e.target.value);else{$('#secsBox').hidden=false;setSecs((+$('#secsMin').value||45)*60);$('#secsBox').hidden=false;$('#secsPick').value='';$('#secsMin').focus()}};
$('#secsMin').addEventListener('change',e=>{const v=Math.max(5,Math.min(7200,Math.round((+e.target.value||1)*60)));$('#secs').value=String(v);$('#secs').dispatchEvent(new Event('change'))});

/* ---------- encaixe no servidor: tarefa com prévia, barra de progresso e parada ---------- */
let JOB=null;
function decodeNest(R,byId){const out={};
  for(const k in R){
    const why=Array.isArray(R[k].fail_why)&&R[k].fail_why.length===R[k].fail.length?R[k].fail_why:R[k].fail.map(()=>'tamanho');
    out[k]={fail:R[k].fail.map(i=>byId[i]),failWhy:why,sheets:R[k].sheets.map(sh=>({placed:sh.map(p=>{const it=byId[p.id],t=tf(it.rings,p.a,p.mi);return{it,rings:t.rings,w:t.w,h:t.h,x:p.x,y:p.y,a:p.a,mi:p.mi}})})),ext:R[k].extent,workers:R[k].workers,iters:R[k].iters,engine:R[k].engine,stopped:!!R[k].stopped};
  }
  return out}
function progShow(elapsed,total,text){$('#prog').hidden=false;$('#progBar').style.width=Math.max(0,Math.min(100,total?elapsed/total*100:0))+'%';$('#progTxt').textContent=text}
function progHide(){$('#prog').hidden=true;$('#progBar').style.width='0';$('#stopNest').disabled=false;$('#stopNest').textContent='Parar e ficar com o melhor até agora'}
$('#stopNest').onclick=async()=>{if(!JOB||JOB.stopping)return;JOB.stopping=true;$('#stopNest').disabled=true;$('#stopNest').textContent='Parando…';
  try{await sfetch('/api/nest/stop/'+JOB.id,{method:'POST',body:'{}'})}catch(e){toast(e.message,'bad')}};
/* NEST.run conta execuções: resultado ou prévia de uma execução antiga (projeto trocado no meio) é descartado. */
const NEST={run:0,busy:false};
function cancelNest(){if(!NEST.busy)return;NEST.run++;NEST.busy=false;
  if(JOB&&!JOB.stopping){JOB.stopping=true;sfetch('/api/nest/stop/'+JOB.id,{method:'POST',body:'{}'}).catch(()=>{})}
  JOB=null;progHide();$('#go').disabled=false;$('#nmsg').className='msg w';$('#nmsg').textContent='Encaixe interrompido: o projeto mudou.'}
async function serverNest(o,run){
  const G=groupsOf(),groups={},byId={},secs=+$('#secs').value,nGroups=Object.keys(G).length;
  for(const k in G){const items=[];G[k].forEach(p=>{byId[p.id]=p;for(let i=0;i<p.qty;i++)items.push({id:p.id,rings:o.fill===false?[p.rings[0]]:p.rings,area:p.A,mirror:p.mirror,rot:p.rot,gid:p.groupId||'',...(p.gap!=null?{gap:p.gap}:{}),...(p.mar!=null?{mar:p.mar}:{}),...(p.product?{prod:p.product,rank:p.rank||0}:{})})});groups[k]={w:S.groups[k].w,h:S.groups[k].h,items}}
  const r=await sfetch('/api/nest/start',{method:'POST',body:JSON.stringify({...o,seconds:secs,groups})});
  if(!r.ok)throw Error(await r.text());
  const id=(await r.json()).id;
  if(run!==NEST.run){sfetch('/api/nest/stop/'+id,{method:'POST',body:'{}'}).catch(()=>{});return null}
  const job={id,stopping:false};JOB=job;let rev=-1,seen=0,note='';
  progShow(0,secs,'Começando…');
  try{for(;;){
    await new Promise(z=>setTimeout(z,500));if(run!==NEST.run)return null;
    const q=await sfetch('/api/nest/poll/'+id+'?rev='+rev);if(!q.ok)throw Error(await q.text());
    const st=await q.json();if(run!==NEST.run)return null;
    if(st.error)throw Error(st.error);
    if(st.result)return decodeNest(st.result,byId);
    if(st.best&&st.rev!==rev){rev=st.rev;const pv=decodeNest(st.best,byId),keys=Object.keys(pv);
      if(keys.length){const cur=keys[keys.length-1];if(keys.length!==seen||!pv[S.tab]){seen=keys.length;S.tab=cur}
        S.res=pv;S.snap=null;renderCore();
        const ns=keys.reduce((a,k)=>a+pv[k].sheets.length,0),last=(pv[cur].ext||[]).slice(-1)[0];
        note=' · '+(nGroups>1?'grupo '+keys.length+' de '+nGroups+' · ':'')+ns+' chapa'+(ns===1?'':'s')+(last?', '+last+' mm na última':'')}}
    progShow(st.elapsed,st.seconds,fmtSecs(st.elapsed)+' de '+fmtSecs(st.seconds)+note+(st.engine==='rust'?'':' · sem prévia (motor Python)'));
  }}finally{if(JOB===job){JOB=null;progHide()}}
}
function takeSnap(o,engine){
  const vals=S.res?Object.values(S.res):[];
  S.snap={
    opt:{gap:o.gap,mar:o.mar,rot:o.rot,cs:o.cs,secs:+$('#secs').value,fill:o.fill!==false,seq:!!o.seq,near:!!o.near,srv:$('#srv').checked},
    askedCs:+$('#res').value,
    rotLabel:$('#rot').selectedOptions[0]?$('#rot').selectedOptions[0].textContent:'',
    rules:currentRules(),
    sets:S.sets.map(s=>({...s})),
    groups:JSON.parse(JSON.stringify(S.groups)),
    preset:S.activePreset?{id:S.activePreset.id,name:S.activePreset.name}:null,
    engine,
    workers:engine==='servidor'?Math.max(1,...vals.map(v=>v.workers||1)):null,
    iters:vals.reduce((s,v)=>s+(v.iters||0),0)
  };
}
/* ---------- encaixe salvo no projeto ---------- */
/* Só posições são gravadas (peça, x, y, ângulo, espelho); o contorno é refeito a partir da peça ao abrir. */
const nestSig=()=>{const G=groupsOf();return JSON.stringify([S.parts.filter(p=>p.on).map(p=>[p.id,p.qty,p.mat,p.th,p.mirror,p.rot,p.sig]),Object.keys(G).sort().map(k=>[k,(S.groups[k]||{}).w,(S.groups[k]||{}).h])])};
function packNest(){const o={};for(const k in S.res){const g=S.res[k];o[k]={sheets:g.sheets.map(sh=>sh.placed.map(q=>({id:q.it.id,x:q.x,y:q.y,a:q.a,mi:q.mi?1:0}))),fail:(g.fail||[]).map(p=>p.id),failWhy:g.failWhy||[],ext:g.ext||null,workers:g.workers||null,iters:g.iters||0}}return o}
function unpackNest(R){const byId=new Map(S.parts.map(p=>[p.id,p])),need=id=>{const it=byId.get(id);if(!it)throw Error('peça ausente');return it},o={};
  for(const k in R){const g=R[k];o[k]={sheets:g.sheets.map(sh=>({placed:sh.map(q=>{const it=need(q.id),t=tf(it.rings,q.a,q.mi);return{it,rings:t.rings,w:t.w,h:t.h,x:q.x,y:q.y,a:q.a,mi:q.mi}})})),fail:g.fail.map(need),failWhy:g.failWhy||[],ext:g.ext||undefined,workers:g.workers||undefined,iters:g.iters||0}}
  return o}
/* Definição de encaixe guardada com o encaixe salvo: volta para os campos de Encaixar ao abrir. */
function applySnap(sn){if(!sn||!sn.opt)return;const o=sn.opt;
  presetParams({rot:o.rot,res:sn.askedCs||o.cs,secs:o.secs,gap:o.gap,mar:o.mar,fill:o.fill});
  if(sn.rules)$('#mix').checked=sn.rules.mix!==false;if(o.srv!=null)$('#srv').checked=!!o.srv;
  const m=curProj();if(m&&o.seq!=null){m.seq=!!o.seq;m.near=!!o.near}
  for(const k in sn.groups||{}){const g=sn.groups[k];if(g&&+g.w>0&&+g.h>0){S.groups[k]={w:+g.w,h:+g.h};S.sheetMemory&&(S.sheetMemory[k]={w:+g.w,h:+g.h})}}}
function snapText(sn){if(!sn||!sn.opt)return'';const o=sn.opt,t=v=>v>=60?(v/60)+' min':v+' s';
  return['Espaço '+o.gap+' mm','margem '+o.mar+' mm',sn.rotLabel||('giro '+o.rot),'resolução '+(sn.askedCs||o.cs)+' mm','tempo '+t(o.secs),o.fill===false?'sem encaixe nos furos':'encaixe nos furos',
    o.seq?'ordem da lista':'',o.near?'produtos juntos':'',...Object.entries(sn.groups||{}).map(([k,g])=>k+' '+g.w+'×'+g.h)].filter(Boolean).join(' · ')}
const savedNestStale=()=>!!S.savedNest&&S.savedNest.sig!==nestSig();
function openSavedNest(quiet){
  const n=S.savedNest;if(!n)return false;
  if(savedNestStale()){if(!quiet)status('As peças ou as chapas mudaram depois que este encaixe foi salvo. Encaixe de novo e salve.',true);return false}
  try{S.res=unpackNest(n.res)}catch(e){S.res=null;if(!quiet)status('Não foi possível abrir o encaixe salvo.',true);return false}
  S.snap=JSON.parse(JSON.stringify(n.snap));S.tab=S.res[n.tab]?n.tab:Object.keys(S.res)[0];S.pdf=null;applySnap(S.snap);
  $('#nmsg').className='msg ok';$('#nmsg').textContent='Encaixe salvo em '+whenLabel(n.savedAt)+' aberto.';
  return true}
$('#nestOpen').onclick=()=>{if(openSavedNest(false)){render();showResult()}};
$('#nestSave').onclick=async()=>{
  if(!S.res||!S.snap){status('Encaixe antes de salvar.',true);return}
  if(!S.projectId){status('Selecione um projeto.',true);return}
  {const pl=plans().find(p=>p.id===(curProj()||{}).plan),at=pl?pl.nestAt:S.savedNest&&S.savedNest.savedAt;
   if(at&&!await ask((pl?'O planejamento '+pl.name:'A área de encaixe')+' já tem um encaixe salvo em '+whenLabel(at)+'. Substituir por este?','Substituir',false))return}
  const sheets=Object.values(S.res).reduce((a,g)=>a+g.sheets.length,0);
  S.savedNest={savedAt:new Date().toISOString(),sig:nestSig(),tab:S.tab,sheets,snap:JSON.parse(JSON.stringify(S.snap)),res:packNest()};
  const pl=plans().find(p=>p.id===(curProj()||{}).plan);
  if(pl){try{await api('/api/plan/'+pl.id,{parts:S.parts.filter(p=>!p.guest).map(({pick,guest,...p})=>p),groups:S.groups,seq:S.seq,uid:S.uid,nest:S.savedNest})}
    catch(e){status('Não foi possível gravar no planejamento: '+e.message,true);return}
    pl.nestAt=S.savedNest.savedAt;pl.nestSheets=sheets;pl.nestDef=snapText(S.snap)}
  hist('nest.save',{sheets,groups:Object.keys(S.res),plan:pl?pl.id:''});render();await flush();status(pl?'Encaixe salvo no planejamento '+pl.name+'.':'Encaixe salvo na área de encaixe.',false)};
async function runNest(){
  const run=++NEST.run;NEST.busy=true;$('#go').disabled=true;
  try{await nestRun(run)}finally{if(run===NEST.run){NEST.busy=false;$('#go').disabled=!S.parts.some(p=>p.on)}}}
async function nestRun(run){
  const o={gap:Math.max(0,+$('#gap').value||0),mar:Math.max(0,+$('#mar').value||0),rot:+$('#rot').value,cs:Math.max(0.5,+$('#res').value||2),fill:$('#fill').checked,rules:currentRules(),seq:!!(curProj()||{}).seq,near:!!(curProj()||{}).near};
  const G0=groupsOf();
  for(const k of Object.keys(G0)){const g=S.groups[k];if(!(g&&g.w>2*o.mar+1&&g.h>2*o.mar+1)){status('A chapa de '+k+' precisa ser maior que as margens.',true);return}}
  S.res=null;S.snap=null;S.pdf=null;
  if($('#srv').checked){
    try{$('#nmsg').className='msg';$('#nmsg').textContent='Otimizando no servidor ('+fmtSecs(+$('#secs').value)+')…';await new Promise(r=>setTimeout(r,30));
      const R=await serverNest(o,run);if(run!==NEST.run||!R)return;S.res=R;S.tab=Object.keys(S.res)[0];takeSnap(o,'servidor');
      $('#nmsg').className='msg ok';{const v=Object.values(S.res),n=v.reduce((a,x)=>a+(x.iters||0),0);const rust=v[0].engine==='rust',tail=', '+(v[0].workers||1)+' núcleo(s), '+n.toLocaleString('pt-BR')+' tentativa(s).';
        if(!rust)$('#nmsg').className='msg w';
        $('#nmsg').textContent=rust?(v.some(x=>x.stopped)?'Parado antes do prazo, com o melhor até ali · motor Rust':'Pronto · motor Rust')+tail:'Pronto, mas sem o motor Rust: o servidor não achou o executável e usou o Python, bem mais lento'+tail+' Compile com "cargo build --release" na pasta motor.'}
      toast('Encaixe pronto.','ok');render();return}
    catch(e){if(run!==NEST.run)return;
      /* só cai para o navegador com o servidor desligado; erro do servidor (400, 429, falha no job) é mostrado e para */
      if(e.message!==OFF){status(e.message||'Falha no encaixe do servidor.',true);return}
      $('#nmsg').className='msg w';$('#nmsg').textContent='Servidor indisponível ('+e.message+'); usando o motor do navegador…';await new Promise(r=>setTimeout(r,800))}}
  const asked=o.cs;o.cs=Math.max(o.cs,3);const out={};const keys=Object.keys(groupsOf());let k=0;
  for(const key of keys){const g=S.groups[key],items=[];groupsOf()[key].forEach(p=>{for(let i=0;i<p.qty;i++)items.push(p)});
    $('#nmsg').textContent=`Encaixando ${key} (${++k}/${keys.length})…`;await new Promise(r=>setTimeout(r,20));if(run!==NEST.run)return;
    const orders=[(a,b)=>b.A-a.A,(a,b)=>Math.max(b.w,b.h)-Math.max(a.w,a.h),(a,b)=>b.w*b.h-a.w*a.h];let best=null;
    for(const f of orders){const res=nestGroup(g,items,o,[...items].sort(f));
      const sc=res.fail.length*1e9+res.sheets.length*1e6-(res.sheets.length?used(res)/res.sheets.length/(g.w*g.h)*1e5:0);
      if(!best||sc<best.sc)best={sc,res};await new Promise(r=>setTimeout(r,0));if(run!==NEST.run)return}
    out[key]=best.res}
  S.res=out;takeSnap(o,'navegador');if(asked<3)S.snap.askedCs=asked;
  $('#nmsg').className='msg ok';$('#nmsg').textContent='Pronto.';toast('Encaixe pronto.','ok');S.tab=Object.keys(S.res)[0];render()}
const showResult=()=>{if(matchMedia('(max-width:1100px)').matches)$('.mid').scrollIntoView({behavior:'smooth',block:'start'})};
$('#go').onclick=()=>runNest().then(()=>{if(S.res)showResult()});
['gap','mar','rot','res','secs','fill'].forEach(id=>$('#'+id).addEventListener('change',()=>{if(S.res){S.res=null;S.snap=null;S.pdf=null;$('#nmsg').className='msg w';$('#nmsg').textContent='Parâmetro alterado. Encaixe de novo.';render()}}));

/* ---------- cores e presets ---------- */
function hexColor(v,fb){return /^#[0-9a-fA-F]{6}$/.test(v||'')?v:fb}
function partColor(p){if(p.groupId){const s=S.sets.find(x=>x.id===p.groupId);if(s)return s.color}return hexColor(p.color,'#8b93a1')}
function nid(prefix){return prefix+Date.now().toString(36)+Math.random().toString(36).slice(2,7)}
function loadPresets(){return (S.store.presets||[]).filter(p=>p&&typeof p.name==='string'&&p.id)}
function savePresets(list){if(!S.ready)return false;S.store.presets=list;hist('presets.update',{names:list.map(p=>p.name)});render();return true}
function presetMsg(text,bad){const el=$('#pmsg');el.className='msg'+(bad?' w':' ok');el.textContent=text;toast(text,bad?'bad':'ok')}
function status(text,bad){const el=$('#nmsg');el.className='msg'+(bad?' w':' ok');el.textContent=text;toast(text,bad?'bad':'ok')}
/* Ao fechar, o foco volta para quem abriu o modal (teclado e leitor de tela não se perdem). */
function showModal(id,f){const m=$('#'+id);if(m.hidden)m._ret=document.activeElement;m.hidden=false;if(f)$(f).focus()}
function hideModal(id){const m=$('#'+id);if(m.hidden)return;m.hidden=true;const r=m._ret;m._ret=null;if(r&&r.isConnected&&r.focus)r.focus()}
let toastT=0,asking=false;
function toast(text,kind,undo){const el=$('#toast');if(!text){el.hidden=true;return}el.textContent=text;
  if(undo){const b=document.createElement('button');b.type='button';b.textContent='Desfazer';b.style.marginLeft='10px';b.onclick=()=>{el.hidden=true;undo()};el.appendChild(b)}
  el.className='toast '+(kind||'');el.hidden=false;el.style.animation='none';void el.offsetWidth;el.style.animation='';
  clearTimeout(toastT);toastT=setTimeout(()=>{el.hidden=true},undo?10000:3600)}
function ask(text,yesLabel,danger){
  if(asking) return Promise.resolve(false);
  asking=true;
  return new Promise(resolve=>{
    $('#askText').textContent=text;
    $('#askYes').textContent=yesLabel||'Continuar';
    $('#askYes').className=danger?'danger':'pri';
    showModal('ask','#askNo');
    const done=v=>{asking=false;hideModal('ask');$('#askYes').onclick=null;$('#askNo').onclick=null;resolve(v)};
    $('#askYes').onclick=()=>done(true);
    $('#askNo').onclick=()=>done(false);
  });
}
/* Preset = encaixe de um material e espessura: a chapa e os parâmetros de Encaixar. Modelos e cores ficam de fora. */
function capturePreset(name,id){
  return {id:id||nid('p'),name,savedAt:new Date().toISOString(),
    mat:$('#presetMat').value.trim(),th:+$('#presetTh').value,w:+$('#presetW').value,h:+$('#presetH').value,
    gap:+$('#gap').value,mar:+$('#mar').value,rot:$('#rot').value,res:$('#res').value,secs:$('#secs').value,fill:$('#fill').checked};
}
function presetFieldsBad(){
  if(!$('#presetMat').value.trim())return 'Informe o material do preset.';
  for(const[id,what]of[['presetTh','a espessura'],['presetW','o comprimento da chapa'],['presetH','a largura da chapa']])if(!(+$('#'+id).value>0))return 'Informe '+what+' (maior que zero).';
  return ''}
const presetKey=p=>p.mat+' · '+(+p.th)+' mm';
const presetLine=p=>(p.mat?presetKey(p)+' · chapa '+(+p.w)+'×'+(+p.h)+' mm · espaço '+(+p.gap)+' · margem '+(+p.mar)+' · ':'')+whenLabel(p.savedAt);
function fillPresetFields(p){$('#presetName').value=p.name;$('#presetMat').value=p.mat||'';$('#presetTh').value=p.th||'';$('#presetW').value=p.w||'';$('#presetH').value=p.h||''}
/* Campos vazios começam com a chapa da aba aberta, para salvar o que está na tela. */
/* Acesso pela rede: só o computador principal vê o PIN (o servidor recusa /api/rede vindo de fora). */
function renderNet(n){
  $('#net').hidden=false;$('#netOn').checked=n.on;$('#netPin').disabled=!n.on;
  $('#netInfo').innerHTML=n.on?(n.active?`<span>PIN</span><b>${esc(n.pin)}</b><span>Nos outros aparelhos, abra no navegador:</span>${(n.urls||[]).map(u=>`<code>${esc(u)}</code>`).join('')||'<span>Nenhum endereço de rede encontrado neste computador.</span>'}`:'<span>Feche e abra o programa para ligar o acesso.</span>'):'';
  $('#netMsg').textContent=!n.on&&n.active?'Feche e abra o programa para desligar o acesso.':''}
async function loadNet(){try{const n=await api('/api/rede');S.net=n;renderNet(n)}catch(e){$('#net').hidden=true}}
$('#netOn').onchange=async e=>{try{const n=await api('/api/rede',{on:e.target.checked});S.net={...S.net,...n};renderNet(S.net)}catch(x){toast(x.message,'bad');loadNet()}};
$('#netPin').onclick=async()=>{if(!await ask('Gerar um PIN novo? Os aparelhos que já entraram vão precisar do PIN novo.','Gerar PIN'))return;try{const n=await api('/api/rede',{newpin:true});S.net={...S.net,...n};renderNet(S.net)}catch(x){toast(x.message,'bad')}};
function prefillPreset(){
  if(['presetMat','presetTh','presetW','presetH'].some(id=>$('#'+id).value))return;
  const k=S.tab&&S.groups[S.tab]?S.tab:Object.keys(S.groups)[0];if(!k)return;
  const[mat,th]=k.split(' · '),g=S.groups[k];
  $('#presetMat').value=mat;$('#presetTh').value=parseFloat(th)||'';$('#presetW').value=g.w;$('#presetH').value=g.h}
function setSel(id,v){const el=$('#'+id);if([...el.options].some(o=>o.value===String(v)))el.value=String(v)}
function selectedPreset(){return loadPresets().find(p=>p.id===S.presetId)||null}
/* Materiais da importação: os dos presets de encaixe; sem preset com material, a lista padrão do app. */
function presetMaterials(){
  const m=[...new Set(loadPresets().map(p=>String(p.mat||'').trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'pt-BR'));
  return m.length?m:[...$('#mats').options].map(o=>o.value)}
const matOptions=cur=>presetMaterials().map(m=>`<option value="${esc(m)}" ${m===cur?'selected':''}>${esc(m)}</option>`).join('');
function renderMaterials(){
  const el=$('#defMat'),cur=el.value,list=presetMaterials();
  el.innerHTML=matOptions(list.includes(cur)?cur:list[0]);
  const fromPresets=loadPresets().some(p=>String(p.mat||'').trim());
  renderDefTh();
  $('#defMatHint').textContent=fromPresets?'Os materiais vêm dos presets de encaixe. Para incluir outro, salve um preset com ele.':'Nenhum preset com material: usando a lista padrão. Salve presets de encaixe para escolher seus materiais aqui.'}
/* Espessuras: as dos presets do material escolhido. Material sem preset continua com campo livre. */
function presetThicknesses(mat){const m=String(mat||'').trim().toLowerCase();
  return [...new Set(loadPresets().filter(p=>String(p.mat||'').trim().toLowerCase()===m&&+p.th>0).map(p=>+p.th))].sort((a,b)=>a-b)}
function thField(mat,cur,attr){const ts=presetThicknesses(mat);
  return ts.length?`<select ${attr}>${ts.map(t=>`<option value="${t}" ${t===+cur?'selected':''}>${t} mm</option>`).join('')}</select>`:`<input ${attr} type="number" step=".1" min=".1" value="${esc(cur)}">`}
function renderDefTh(){const mat=$('#defMat').value,cur=+$('#defTh').value,ts=presetThicknesses(mat);
  $('#defThBox').innerHTML=thField(mat,ts.length&&!ts.includes(cur)?ts[0]:(cur||3),'id="defTh"')}
/* Na revisão, espessura fora dos presets do material vira a primeira do preset, com aviso quando o nome do arquivo dizia outra. */
function fitTh(r){const ts=presetThicknesses(r.mat);if(!ts.length||ts.includes(+r.th))return;
  const was=r.thSrc==='inferida do nome'?r.th:0;r.th=ts[0];r.thSrc=was?'preset (o nome dizia '+was+' mm)':'preset'}
$('#defMat').addEventListener('change',renderDefTh);
function renderPresets(){
  renderMaterials();
  const list=loadPresets();
  $('#presetList').innerHTML=list.map(p=>`<button type="button" class="preset-item ${p.id===S.presetId?'on':''}" data-pid="${esc(p.id)}"><b>${esc(p.name)}</b><span>${esc(presetLine(p))}</span></button>`).join('')||'<div class="msg">Nenhum preset salvo.</div>';
  const on=!!selectedPreset();
  ['presetApply','presetUpdate','presetDup','presetDel'].forEach(id=>$('#'+id).disabled=!on);
}
function presetParams(preset){
  setSel('rot',preset.rot);setSel('res',preset.res);setSecs(preset.secs,true);
  if(Number.isFinite(+preset.gap)) $('#gap').value=+preset.gap;
  if(Number.isFinite(+preset.mar)) $('#mar').value=+preset.mar;
  /* o motor do servidor (Rust) é sempre a primeira opção: preset não o desliga */$('#fill').checked=preset.fill!==false}
function applyPreset(preset){
  presetParams(preset);
  // presets antigos guardavam várias chapas por chave; os novos, a do seu material e espessura
  const sheets={...(preset.sheets||{})};
  if(preset.mat&&+preset.th>0&&+preset.w>0&&+preset.h>0) sheets[presetKey(preset)]={w:+preset.w,h:+preset.h};
  let matched=0;
  for(const[k,g]of Object.entries(sheets)){if(!(g&&+g.w>0&&+g.h>0))continue;
    for(const key of [k,...Object.keys(S.groups).filter(x=>x!==k&&x.toLowerCase()===k.toLowerCase())]){S.sheetMemory[key]={w:+g.w,h:+g.h};if(S.groups[key]){S.groups[key]={w:+g.w,h:+g.h};matched++}}}
  S.activePreset={id:preset.id,name:preset.name};
  S.presetId=preset.id;
  S.res=null;S.snap=null;S.pdf=null;
  render();renderPresets();
  let msg='Preset aplicado.';
  if(matched) msg+=' Chapa de '+matched+' material(is) atualizada.';
  else if(Object.keys(sheets).length) msg+=' A chapa entra quando o material '+(preset.mat?presetKey(preset):'correspondente')+' aparecer no projeto.';
  presetMsg(msg,false);
}
$('#presetList').onclick=e=>{const b=e.target.closest('[data-pid]');if(!b)return;S.presetId=b.dataset.pid;const p=selectedPreset();if(p)fillPresetFields(p);$('#pmsg').textContent='Selecionado: '+p.name+'. Aplicar carrega estas configurações.';$('#pmsg').className='msg';renderPresets()};
$('#presetName').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#presetSave').click()}});
$('#presetSave').onclick=async()=>{
  const name=$('#presetName').value.trim();
  if(!name){presetMsg('Dê um nome ao preset.',true);return}
  const bad=presetFieldsBad();if(bad){presetMsg(bad,true);return}
  const list=loadPresets();
  const hit=list.find(p=>p.name.toLowerCase()===name.toLowerCase());
  if(hit && !await ask('Já existe um preset com o nome "'+name+'". Substituir as configurações salvas?','Substituir',true)) return;
  const item=capturePreset(name,hit&&hit.id);
  const next=hit?list.map(p=>p.id===hit.id?item:p):list.concat(item);
  if(!savePresets(next)){presetMsg('Não foi possível gravar o preset neste navegador.',true);return}
  S.presetId=item.id;S.activePreset={id:item.id,name:item.name};
  if(S.snap&&S.res)S.snap.preset={id:item.id,name:item.name};
  renderPresets();presetMsg('Preset "'+name+'" salvo.',false);
};
$('#presetApply').onclick=async()=>{
  const p=selectedPreset();if(!p){presetMsg('Selecione um preset.',true);return}
  if(!await ask('Aplicar o preset "'+p.name+'" troca '+(p.mat?'a chapa de '+presetKey(p)+' e ':'')+'os parâmetros de Encaixar (espaço, margem, rotação, tempo). Modelos, cores e peças não mudam. Continuar?','Aplicar',false)) return;
  applyPreset(p);
};
$('#presetUpdate').onclick=async()=>{
  const p=selectedPreset();if(!p){presetMsg('Selecione um preset para atualizar.',true);return}
  const name=$('#presetName').value.trim()||p.name;
  const bad=presetFieldsBad();if(bad){presetMsg(bad,true);return}
  if(!await ask('Substituir o preset "'+p.name+'" pelas configurações atuais?','Substituir',true)) return;
  const list=loadPresets();
  const clash=list.find(x=>x.id!==p.id&&x.name.toLowerCase()===name.toLowerCase());
  if(clash){presetMsg('Já existe outro preset com esse nome.',true);return}
  const item=capturePreset(name,p.id);
  if(!savePresets(list.map(x=>x.id===p.id?item:x))){presetMsg('Não foi possível gravar o preset neste navegador.',true);return}
  S.activePreset={id:item.id,name:item.name};
  if(S.snap&&S.res)S.snap.preset={id:item.id,name:item.name};
  renderPresets();presetMsg('Preset "'+name+'" atualizado.',false);
};
$('#presetDup').onclick=()=>{
  const p=selectedPreset();if(!p){presetMsg('Selecione um preset para duplicar.',true);return}
  const list=loadPresets();
  let name=p.name+' cópia',n=2;
  while(list.some(x=>x.name.toLowerCase()===name.toLowerCase())) name=p.name+' cópia '+n++;
  const item={...JSON.parse(JSON.stringify(p)),id:nid('p'),name,savedAt:new Date().toISOString()};
  if(!savePresets(list.concat(item))){presetMsg('Não foi possível gravar o preset neste navegador.',true);return}
  S.presetId=item.id;$('#presetName').value=item.name;renderPresets();presetMsg('Preset duplicado como "'+name+'".',false);
};
$('#presetDel').onclick=async()=>{
  const p=selectedPreset();if(!p){presetMsg('Selecione um preset para excluir.',true);return}
  if(!await ask('Excluir o preset "'+p.name+'"? Essa ação não pode ser desfeita.','Excluir',true)) return;
  if(!savePresets(loadPresets().filter(x=>x.id!==p.id))){presetMsg('Não foi possível gravar a exclusão neste navegador.',true);return}
  if(S.activePreset&&S.activePreset.id===p.id)S.activePreset=null;
  S.presetId=null;renderPresets();presetMsg('Preset excluído.',false);
};
/* Cor de modelo: automática e única. Primeiro a paleta; depois tons gerados, o mais longe possível dos já usados. */
const hsl2hex=(h,sa,l)=>{sa/=100;l/=100;const f=n=>{const k=(n+h/30)%12,a=sa*Math.min(l,1-l);return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))).toString(16).padStart(2,'0')};return '#'+f(0)+f(8)+f(4)};
const rgbOf=h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16));
const colorGap=(a,b)=>{const x=rgbOf(a),y=rgbOf(b);return Math.hypot(x[0]-y[0],x[1]-y[1],x[2]-y[2])};
function nextColor(skip){
  const used=S.sets.filter(x=>x!==skip).map(x=>String(x.color).toLowerCase());
  const free=PALETTE.find(c=>!used.includes(c));if(free)return free;
  for(let min=70;min>=0;min-=10)for(let k=0;k<360;k++){const c=hsl2hex(k*137.508%360,[70,55,85][k%3],[60,45,72][(k/3|0)%3]);if(!used.includes(c)&&used.every(u=>colorGap(u,c)>min))return c}
  for(;;){const c='#'+Math.floor(Math.random()*0x1000000).toString(16).padStart(6,'0');if(!used.includes(c))return c}
}
function uniqueColors(){const seen=new Set();let n=0;for(const x of S.sets){if(seen.has(String(x.color).toLowerCase())){x.color=nextColor(x);n++}seen.add(String(x.color).toLowerCase())}return n}
function picked(){return S.parts.filter(p=>p.pick&&!p.guest)}
/* Quantidade de modelos (por projeto): a quantidade de cada peça do modelo é a de um modelo × este número. */
const setN=id=>Math.max(1,Math.round(+S.setQty[id])||1);
function moveToSet(p,gid){gid=gid||'';if(p.groupId===gid)return;const a=p.groupId?setN(p.groupId):1,b=gid?setN(gid):1;p.qty=Math.max(1,Math.round(p.qty/a*b));p.groupId=gid}
function setCount(id,v){
  const s=S.sets.find(x=>x.id===id);if(!s)return;
  const n=setN(id),m=Math.max(1,Math.round(+v)||1);if(m===n){render();return}
  const parts=S.parts.filter(p=>p.groupId===id&&!p.guest),odd=parts.filter(p=>p.qty%n).length;
  for(const p of parts)p.qty=Math.max(1,Math.round(p.qty/n*m));
  if(m>1)S.setQty[id]=m;else delete S.setQty[id];
  S.res=null;S.snap=null;S.pdf=null;render();
  toast(odd?odd+' peça(s) não tinham quantidade múltipla de '+n+': valor arredondado, confira.':m+' × '+s.name+': quantidades das peças atualizadas.',odd?'bad':'ok');
}
/* Filtro da lista de peças: só a vista, não muda dados. */
const PV={q:'',f:'',open:new Set(),mopen:new Set()};
const partVisible=p=>(!PV.f||(PV.f==='__pend'?!p.groupId:p.groupId===PV.f))&&(!PV.q||String(p.name).toLowerCase().includes(PV.q));
$('#partSearch').addEventListener('input',e=>{PV.q=e.target.value.trim().toLowerCase();renderCore()});
$('#partFilter').addEventListener('change',e=>{PV.f=e.target.value;renderCore()});
function updateColorButtons(){const n=picked().length;$('#applyColor').disabled=!n;$('#clearGroup').disabled=!n;$('#delPicked').disabled=!n;$('#delPicked').textContent=n?'Excluir ('+n+')':'Excluir';
  $('#actbar').classList.toggle('on',!!n);$('#selInfo').textContent=n+' marcada(s)'}
/* Quadro: clicar no desenho marca; − e + mudam a quantidade; o que está aberto em "Mais opções" sobrevive ao redesenho. */
$('#parts').addEventListener('click',e=>{
  const st=e.target.closest('[data-step]');
  if(st){const q=st.closest('.part').querySelector('[data-f=qty]');q.value=Math.max(1,(+q.value||1)+(+st.dataset.step));q.dispatchEvent(new Event('input',{bubbles:true}));q.dispatchEvent(new Event('change',{bubbles:true}));return}
  if(e.target.closest('[data-go-import]')){showView('import');return}
  const art=e.target.closest('.tile-art');
  if(art&&!e.target.closest('.tile-check')){const cb=art.querySelector('[data-f=pick]');if(cb.disabled)return;cb.checked=!cb.checked;cb.dispatchEvent(new Event('input',{bubbles:true}))}});
$('#parts').addEventListener('toggle',e=>{const d=e.target;if(!d.matches||!d.matches('.tile-more'))return;d.open?PV.open.add(d.dataset.more):PV.open.delete(d.dataset.more)},true);
$('#legend').addEventListener('click',e=>{
  const m=e.target.closest('[data-mf]');if(m){PV.f=m.dataset.mf;renderCore();return}
  const ed=e.target.closest('[data-medit]');if(ed){const id=ed.dataset.medit;PV.mopen.has(id)?PV.mopen.delete(id):PV.mopen.add(id);renderLegend()}});
$('#applyColor').onclick=async()=>{
  const parts=picked();if(!parts.length){toast('Marque ao menos uma peça.','bad');return}
  // destino escolhido na barra; sem escolha, vale o nome digitado em "Novo modelo" (cria se não existir)
  const name=$('#setName').value.trim();let st=S.sets.find(x=>x.id===$('#pickTarget').value);
  if(!st&&!name){toast('Escolha o modelo em "Mover para…".','bad');$('#pickTarget').focus();return}
  st=st||S.sets.find(x=>x.name.toLowerCase()===name.toLowerCase());
  if(!st){st={id:nid('c'),name,color:nextColor(),isolate:false,together:false};S.sets.push(st)}
  for(const p of parts)moveToSet(p,st.id);toast('Peças no modelo '+st.name+'.','ok');
  if(rulesActive()){S.res=null;S.snap=null;S.pdf=null}
  render();
};
$('#newSet').onclick=()=>{
  const name=$('#setName').value.trim();
  if(!name){toast('Dê um nome ao modelo.','bad');$('#setName').focus();return}
  if(S.sets.some(x=>x.name.toLowerCase()===name.toLowerCase())){toast('Já existe um modelo com esse nome.','bad');return}
  S.sets.push({id:nid('c'),name,color:nextColor(),isolate:false,together:false});
  $('#setName').value='';render();toast('Modelo '+name+' criado.','ok');
};
$('#setName').addEventListener('keydown',e=>{if(e.key==='Enter'&&!picked().length){e.preventDefault();$('#newSet').click()}});
$('#clearGroup').onclick=()=>{
  const parts=picked();if(!parts.length){toast('Marque ao menos uma peça.','bad');return}
  for(const p of parts){if(p.groupId){const s=S.sets.find(x=>x.id===p.groupId);if(s&&!p.color)p.color=s.color;moveToSet(p,'')}}
  if(rulesActive()){S.res=null;S.snap=null;S.pdf=null}
  render();toast('Peças fora do conjunto.','ok');
};
$('#pickAll').onclick=()=>{S.parts.forEach(p=>{if(!p.guest&&partVisible(p))p.pick=true});render()};
$('#pickNone').onclick=()=>{S.parts.forEach(p=>{p.pick=false});render()};
$('#mix').addEventListener('change',()=>{S.res=null;S.snap=null;S.pdf=null;render();status($('#mix').checked?'Cores diferentes podem compartilhar a chapa. Encaixe de novo.':'Cada conjunto vai para chapas separadas. Encaixe de novo.',false)});
/* Exclui peças do projeto aberto; arquivo de origem que ficar sem peça sai junto, para poder ser reimportado. */
async function removeParts(list,what){
  list=list.filter(p=>!p.guest);if(!list.length)return false;
  const un=list.reduce((a,p)=>a+p.qty,0);
  if(!await ask('Excluir '+what+' deste projeto ('+list.length+' peça(s), '+un+' un)? Essa ação não pode ser desfeita.','Excluir',true))return false;
  const ids=new Set(list.map(p=>p.id)),at=S.parts.map((p,i)=>ids.has(p.id)?[i,p]:null).filter(Boolean),pid=S.projectId;
  S.parts=S.parts.filter(p=>!ids.has(p.id));
  const gone=S.files.filter(f=>!S.parts.some(p=>p.fileId===f.id));
  S.files=S.files.filter(f=>!gone.includes(f));
  hist('parts.delete',{parts:list.map(p=>p.name),files:gone.map(f=>f.name)});
  S.res=null;S.snap=null;S.pdf=null;render();
  toast(list.length+' peça(s) excluída(s).','ok',()=>{
    if(S.projectId!==pid){toast('O projeto mudou: não dá mais para desfazer.','bad');return}
    for(const[i,p]of at){p.pick=false;S.parts.splice(Math.min(i,S.parts.length),0,p)}
    S.files.push(...gone);hist('parts.restore',{parts:list.map(p=>p.name)});
    S.res=null;S.snap=null;S.pdf=null;render();toast('Peças restauradas.','ok')});
  return true;
}
$('#delPicked').onclick=()=>removeParts(picked(),'as peças marcadas');
$('#parts').addEventListener('click',e=>{const b=e.target.closest('[data-del-part]');if(!b)return;const p=S.parts[+b.closest('.part').dataset.i];if(p)removeParts([p],'"'+p.name+'"')});
$('#legend').onclick=async e=>{
  const dp=e.target.closest('[data-del-set-parts]');
  if(dp){const s=S.sets.find(x=>x.id===dp.dataset.delSetParts);if(s)removeParts(S.parts.filter(p=>p.groupId===s.id),'todas as peças do modelo "'+s.name+'"');return}
  const btn=e.target.closest('[data-del-set]');if(!btn)return;
  const s=S.sets.find(x=>x.id===btn.dataset.delSet);if(!s)return;
  if(!await ask('Excluir o modelo "'+s.name+'"? Ele some de todos os projetos. As peças permanecem, sem modelo.','Excluir',true))return;
  const at=S.sets.indexOf(s),pairs=S.forbid.filter(p=>p[0]===s.id||p[1]===s.id),n=S.setQty[s.id],pid=S.projectId,was=[];
  S.sets=S.sets.filter(x=>x.id!==s.id);
  S.forbid=S.forbid.filter(p=>p[0]!==s.id&&p[1]!==s.id);delete S.setQty[s.id];
  for(const p of S.parts) if(p.groupId===s.id){was.push([p,p.color]);if(!p.color)p.color=s.color;p.groupId=''}
  S.res=null;S.snap=null;S.pdf=null;
  render();toast('Modelo excluído.','ok',()=>{
    if(S.sets.some(x=>x.id===s.id))return;
    S.sets.splice(Math.min(at,S.sets.length),0,s);S.forbid.push(...pairs);
    if(S.projectId===pid){if(n)S.setQty[s.id]=n;for(const[p,c]of was)if(S.parts.includes(p)){p.groupId=s.id;p.color=c}}
    S.res=null;S.snap=null;S.pdf=null;render();toast('Modelo restaurado.','ok')});
};
$('#forbidAdd').onclick=()=>{
  const a=$('#fa').value,b=$('#fb').value;
  if(!a||!b){toast('Crie ao menos dois conjuntos.','bad');return}
  if(a===b){toast('Escolha dois conjuntos diferentes.','bad');return}
  if(S.forbid.some(p=>(p[0]===a&&p[1]===b)||(p[0]===b&&p[1]===a))){toast('Esse par já está impedido.','bad');return}
  S.forbid.push([a,b]);S.res=null;S.snap=null;S.pdf=null;render();status('Estes conjuntos não entram na mesma chapa. Encaixe de novo.',false);
};
$('#forbids').onclick=e=>{
  const btn=e.target.closest('[data-unforbid]');if(!btn)return;
  const i=+btn.dataset.unforbid;S.forbid.splice(i,1);S.res=null;S.snap=null;S.pdf=null;render();status('Mistura liberada para esse par. Encaixe de novo.',false);
};

/* ---------- interface ---------- */
const gk=p=>p.mat+' · '+p.th+' mm';
/* Opções de "Chapa padrão": os presets salvos (os deste material e espessura primeiro) e as medidas comuns. */
function sheetOptions(k,g){
  const lk=k.toLowerCase(),mine=p=>p.mat&&presetKey(p).toLowerCase()===lk;
  const ps=loadPresets().filter(p=>+p.w>0&&+p.h>0).sort((a,b)=>mine(b)-mine(a));
  const hit=ps.find(p=>mine(p)&&+p.w===g.w&&+p.h===g.h);
  const sizes=[[2750,1840],[2750,1850],[2440,1220],[3000,1250],[3000,1500]];
  return '<option value="">Personalizada</option>'+
    (ps.length?'<optgroup label="Presets">'+ps.map(p=>`<option value="p:${esc(p.id)}" ${p===hit?'selected':''}>${esc(p.name)} · ${esc(+p.w)}×${esc(+p.h)} mm</option>`).join('')+'</optgroup>':'')+
    '<optgroup label="Medidas comuns">'+sizes.map(([w,hh])=>`<option value="${w}x${hh}" ${!hit&&g.w===w&&g.h===hh?'selected':''}>${w}×${hh} mm</option>`).join('')+'</optgroup>'}
function groupsOf(){const o={};S.parts.filter(p=>p.on).forEach(p=>(o[gk(p)]||(o[gk(p)]=[])).push(p));return o}
const path=rs=>rs.map(r=>'M'+r.map(p=>p[0].toFixed(1)+' '+(-p[1]).toFixed(1)).join('L')+'Z').join('');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function whenLabel(v){const d=new Date(v);return Number.isNaN(d.getTime())?'':d.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})}
function setNameOf(id){const s=S.sets.find(x=>x.id===id);return s?s.name:'Sem modelo'}
function ruleHintText(){
  const r=currentRules();
  if(r.mix&&!r.isolate.length&&!r.together.length&&!r.forbid.length) return 'A cor identifica o conjunto. O encaixe continua misturando as peças na mesma chapa.';
  const bits=[];
  bits.push(r.mix?'Cores diferentes ainda podem dividir a chapa, salvo a regra abaixo.':'Cada conjunto fica em chapas separadas. Peças sem conjunto formam o grupo delas.');
  if(r.isolate.length) bits.push('Conjunto exclusivo não mistura com outro.');
  if(r.together.length) bits.push('Conjunto marcado para ficar junto usa uma chapa só.');
  if(r.forbid.length) bits.push('Há pares que não podem se misturar.');
  return bits.join(' ');
}
function renderLegend(){
  const n=f=>S.parts.filter(p=>f==='__pend'?!p.groupId:p.groupId===f).length;
  const row=(f,dot,name,num,extra='')=>`<button type="button" class="mrow${PV.f===f?' on':''}" data-mf="${esc(f)}"${extra}>${dot}<span class="mname">${esc(name)}</span><span class="mnum">${esc(num)}</span></button>`;
  $('#legend').innerHTML=row('','<span class="mdot all"></span>','Todas as peças',S.parts.length)+row('__pend','<span class="mdot pend"></span>','Sem modelo',n('__pend'))+
    S.sets.map(s=>{const parts=S.parts.filter(p=>p.groupId===s.id),q=parts.reduce((a,p)=>a+(p.on?p.qty:0),0),open=PV.mopen.has(s.id);
      return `<div class="mitem${PV.f===s.id?' on':''}"><div class="mhead">${row(s.id,`<span class="mdot" style="background:${esc(s.color)}"></span>`,s.name,parts.length)}
        <button type="button" class="icon medit" data-medit="${esc(s.id)}" aria-expanded="${open}" aria-label="Editar modelo ${esc(s.name)}" title="Editar modelo"><svg class="ic" aria-hidden="true"><use href="#i-edit"/></svg></button></div>
        ${open?`<div class="mbody setcard"><div class="top"><input type="color" value="${esc(s.color)}" data-set="${esc(s.id)}" data-set-f="color" aria-label="Cor de ${esc(s.name)}"><input type="text" value="${esc(s.name)}" data-set="${esc(s.id)}" data-set-f="name" aria-label="Nome do modelo" maxlength="60"></div>
          <div class="setstats"><span><b>${esc(q)}</b> un no encaixe</span><label class="setn">× <input type="number" min="1" step="1" value="${esc(setN(s.id))}" data-set="${esc(s.id)}" data-set-f="count" aria-label="Quantidade de modelos ${esc(s.name)}"> modelo(s)</label></div>
          <div class="flags"><label><input type="checkbox" data-set="${esc(s.id)}" data-set-f="isolate" ${s.isolate?'checked':''}> Chapas só deste modelo</label><label><input type="checkbox" data-set="${esc(s.id)}" data-set-f="together" ${s.together?'checked':''}> Tudo na mesma chapa</label></div>
          <div class="btns"><button type="button" data-del-set-parts="${esc(s.id)}" ${parts.length?'':'disabled'}>Excluir peças</button><button type="button" class="danger" data-del-set="${esc(s.id)}" aria-label="Excluir modelo ${esc(s.name)}">Excluir modelo</button></div></div>`:''}</div>`}).join('')+
    (S.sets.length?'':'<div class="msg">Nenhum modelo ainda. Digite um nome acima e clique em Criar.</div>');
  // listas que dependem dos modelos: filtro do quadro e destino da barra de ações
  const mopts=S.sets.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#partFilter').innerHTML='<option value="">Todas as peças</option><option value="__pend">Sem modelo</option>'+mopts;$('#partFilter').value=S.sets.some(s=>s.id===PV.f)||PV.f==='__pend'?PV.f:(PV.f='');
  const tg=$('#pickTarget').value;$('#pickTarget').innerHTML='<option value="">Mover para…</option>'+mopts;$('#pickTarget').value=S.sets.some(s=>s.id===tg)?tg:'';
  const opts=S.sets.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  $('#fa').innerHTML=opts;$('#fb').innerHTML=opts;$('#forbidAdd').disabled=S.sets.length<2;
  $('#forbids').innerHTML=S.forbid.map((p,i)=>{const A=S.sets.find(s=>s.id===p[0]),B=S.sets.find(s=>s.id===p[1]);if(!A||!B)return '';return `<div class="pair"><span><i class="sw" style="background:${esc(A.color)}"></i>${esc(A.name)} × <i class="sw" style="background:${esc(B.color)}"></i>${esc(B.name)}</span><button type="button" data-unforbid="${i}">Tirar</button></div>`}).join('');
  $('#ruleHint').textContent=ruleHintText();
}
function legendBar(){
  const bits=S.sets.map(s=>{const q=S.parts.filter(p=>p.on&&p.groupId===s.id).reduce((a,p)=>a+p.qty,0);if(!q)return '';return `<span class="lg"><i class="sw" style="background:${esc(s.color)}"></i>${esc(s.name)}<b>${esc(q)}</b></span>`}).filter(Boolean);
  const loose=S.parts.filter(p=>p.on&&!p.groupId).reduce((a,p)=>a+p.qty,0);
  if(loose) bits.push(`<span class="lg"><i class="sw" style="background:#8b93a1"></i>Sem conjunto<b>${esc(loose)}</b></span>`);
  return bits.length?`<div class="legend-bar">${bits.join('')}</div>`:'';
}
function render(){renderCore();autosave()}
function renderCore(){
  $('#go').disabled=NEST.busy||!S.parts.some(p=>p.on);
  /* a lista é refeita por innerHTML: guarda o campo com foco e a rolagem para devolver depois */
  const fa=document.activeElement,fp=fa&&fa.closest&&fa.closest('#parts .part'),fk=fp&&fa.dataset.f?[fp.dataset.i,fa.dataset.f]:null,pst=$('#panel').scrollTop,mst=$('.mid').scrollTop;
  $('#pcount').textContent=S.parts.length?`${S.parts.reduce((s,p)=>s+(p.on?p.qty:0),0)} un · ${S.parts.length} únicas`:'';
  let shown=0;const ROT=[['auto','Giro padrão'],['free','Giro livre 360°'],['90','Giro 90°'],['180','Giro 180° (veio)'],['0','Fixo (veio)']];
  $('#parts').innerHTML=S.parts.map((p,i)=>{if(!partVisible(p))return '';shown++;const col=partColor(p),ro=p.guest?' disabled':'',open=PV.open.has(String(p.id));
   const tags=(p.groupId?'':'<span class="tag pend">sem modelo</span>')+(p.guest?'<span class="tag inf" title="Peça de outro projeto, juntada só para o encaixe">'+esc(projCode(p.guest))+'</span>':'')+(p.thSrc&&p.thSrc!=='manual'?'<span class="tag inf" title="Espessura não lida do arquivo">esp. '+esc(p.thSrc)+'</span>':'');
   return `<article class="part tile${p.on?'':' off'}${p.pick?' pick':''}${p.groupId?'':' pend'}${p.guest?' guest':''}" data-i="${i}" style="--c:${col};--i:${shown}">
   <div class="tile-art" title="Clique para marcar"><svg viewBox="-2 ${esc(-p.h-2)} ${esc(p.w+4)} ${esc(p.h+4)}" aria-hidden="true"><path d="${path(p.rings)}" fill="${col}" fill-opacity=".9" fill-rule="evenodd"/></svg>
    <label class="tile-check"><input type="checkbox" data-f="pick" ${p.pick?'checked':''}${ro} aria-label="Marcar ${esc(p.name)}"></label>${p.on?'':'<span class="tile-flag">fora do encaixe</span>'}</div>
   <div class="tile-body">
    <div class="tile-name" title="${esc(p.name)}">${esc(p.name)}</div>
    <div class="tile-meta" title="${esc(fileName(p.fileId))}">${esc(p.w.toFixed(0))}×${esc(p.h.toFixed(0))} mm${p.holes?` · ${esc(p.holes)} furo${p.holes>1?'s':''}`:''} · ${esc(p.mat)} ${esc(p.th)} mm</div>
    ${tags?`<div class="tile-tags">${tags}</div>`:''}
    <div class="tile-ctl"><select class="tile-model" data-f="groupId"${ro} aria-label="Modelo de ${esc(p.name)}"><option value="">Sem modelo</option>${S.sets.map(s=>`<option value="${esc(s.id)}" ${p.groupId===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select>
     <div class="stepper"><button type="button" data-step="-1"${ro} aria-label="Diminuir quantidade de ${esc(p.name)}">−</button><input type="number" min="1" value="${esc(p.qty)}" data-f="qty"${ro} aria-label="Quantidade de ${esc(p.name)}"><button type="button" data-step="1"${ro} aria-label="Aumentar quantidade de ${esc(p.name)}">+</button></div></div>
    <details class="tile-more" data-more="${esc(p.id)}"${open?' open':''}><summary>Mais opções</summary><div class="tile-more-in">
     <div class="tile-grid"><label class="f">Material<input value="${esc(p.mat)}" data-f="mat"${ro} list="mats" aria-label="Material de ${esc(p.name)}"></label><label class="f">Esp. (mm)<input type="number" step=".1" value="${esc(p.th)}" data-f="th"${ro} aria-label="Espessura de ${esc(p.name)}"></label></div>
     <div class="tile-opts"><label><input type="checkbox" data-f="on" ${p.on?'checked':''}${ro}> No encaixe</label><select data-f="rot"${ro} aria-label="Giro de ${esc(p.name)}">${ROT.map(([v,t])=>`<option value="${v}" ${p.rot===v?'selected':''}>${t}</option>`).join('')}</select><label><input type="checkbox" data-f="mirror" ${p.mirror?'checked':''}${ro}> Espelhar</label></div>
     <button type="button" class="tile-del" data-del-part${ro}><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>Excluir peça</button></div></details>
   </div></article>`}).join('')||`<div class="board-empty">${S.parts.length?'Nenhuma peça com esse filtro.':'<b>Nenhuma peça neste projeto.</b>Importe arquivos DXF, DWG ou SVG para começar.<button type="button" class="pri" data-go-import>Importar arquivos</button>'}</div>`;
  const fl=PV.f==='__pend'?'Sem modelo':(S.sets.find(s=>s.id===PV.f)||{}).name;
  $('#pvInfo').textContent=S.parts.length&&(PV.q||PV.f)?'Mostrando '+shown+' de '+S.parts.length+' peças'+(fl?' · '+fl:'')+(PV.q?' · busca "'+PV.q+'"':''):'';
  if(fk){const el=$(`#parts .part[data-i="${fk[0]}"] [data-f="${fk[1]}"]`);if(el&&!el.disabled)el.focus({preventScroll:true})}$('#panel').scrollTop=pst;$('.mid').scrollTop=mst;
  const G=groupsOf();
  Object.keys(G).forEach(k=>{if(!S.groups[k]){const mem=S.sheetMemory&&S.sheetMemory[k];if(mem&&+mem.w>0&&+mem.h>0)S.groups[k]={w:+mem.w,h:+mem.h};else{const t=+k.split('· ')[1].replace(' mm','');const mdf=/mdf|mdp|compens/i.test(k);S.groups[k]=mdf?{w:2750,h:1840}:{w:3000,h:t>=6?1500:1250}}}});
  $('#groups').innerHTML=Object.keys(G).map(k=>{const g=S.groups[k],q=G[k].reduce((s,p)=>s+p.qty,0),a=G[k].reduce((s,p)=>s+p.A*p.qty,0)/1e6;
   return`<div class="grp" data-k="${esc(k)}"><div class="t">${esc(k)} <span>${q} un · ${a.toFixed(2)} m²</span></div><label class="f">Chapa padrão<select data-preset>${sheetOptions(k,g)}</select></label><div class="row3"><label class="f">Comprimento<input type="number" data-g="w" value="${esc(g.w)}" aria-label="Comprimento da chapa ${esc(k)}"></label><label class="f">Largura<input type="number" data-g="h" value="${esc(g.h)}" aria-label="Largura da chapa ${esc(k)}"></label></div></div>`}).join('')||'<div class="msg">Sem grupos ainda.</div>';
  renderLegend();updateColorButtons();
  const R=S.res,tabs=R?Object.keys(R):[];if(R&&!R[S.tab])S.tab=tabs[0];
  $('#tabs').innerHTML=tabs.map(k=>`<button type="button" class="tab ${k===S.tab?'on':''}" data-t="${esc(k)}">${esc(k)}</button>`).join('');
  const ready=!!(R&&S.snap);$('#xLock').hidden=ready;patPreview();
  ['pdfPrev','pdfGo'].forEach(id=>{const el=$('#'+id);if(el)el.disabled=!ready});document.querySelectorAll('[data-x]').forEach(b=>{b.disabled=!ready});
  $('#pdfDl').disabled=!S.pdf;$('#modalDl').disabled=!S.pdf;
  const sv=S.savedNest,old=savedNestStale();$('#nestSave').disabled=!ready;$('#nestOpen').disabled=!sv||old;
  $('#nestInfo').className='msg'+(old?' w':'');$('#nestInfo').textContent=sv?'Encaixe salvo em '+whenLabel(sv.savedAt)+' · '+sv.sheets+' chapa(s).'+(old?' As peças ou chapas mudaram desde então: ele não pode mais ser aberto.':''):'Nenhum encaixe salvo neste projeto.';
  if(!R){$('#kpi').textContent=S.parts.length?'pronto para encaixar':'sem peças';const stage=$('#stage');stage.classList.remove('sheets-in');stage.dataset.sheetSig='';stage.dataset.sheetDone='';if(!S.parts.length)stage.innerHTML='<div class="empty"><b>Importe um arquivo para começar.</b>Cada contorno fechado vira uma peça; furos internos são reconhecidos.</div>';else stage.innerHTML='<div class="empty"><b>Peças prontas para encaixar.</b>Ajuste material, espessura e quantidade e clique em Encaixar.</div>';return}
  const gr=R[S.tab],g=S.groups[S.tab];let tot=0,ar=0,ns=0;Object.keys(R).forEach(k=>{ns+=R[k].sheets.length;const gg=S.groups[k];ar+=R[k].sheets.length*gg.w*gg.h;tot+=used(R[k])});
  $('#kpi').innerHTML=ns?`<b>${ns}</b> chapa${ns>1?'s':''} · aproveitamento <b>${(tot/ar*100).toFixed(1)}%</b>`:`<b>0</b> chapas · nada encaixado`;
  const nJunto=(gr.failWhy||[]).filter(w=>w==='junto').length,nSize=(gr.fail||[]).length-nJunto;
  let warn='';
  if(nSize) warn+=`${nSize} peça(s) não cabem na chapa de ${g.w}×${g.h} mm.`;
  if(nJunto) warn+=(warn?' ':'')+`${nJunto} peça(s) não couberam na mesma chapa do conjunto.`;
  const stage=$('#stage'),sig=(S.tab||'')+':'+gr.sheets.map(sh=>sh.placed.length).join(','),done=S.snap?'1':'';
  const play=stage.dataset.sheetSig!==sig||(done==='1'&&stage.dataset.sheetDone!=='1');
  stage.dataset.sheetSig=sig;stage.dataset.sheetDone=done;stage.classList.remove('sheets-in');
  stage.innerHTML=(warn?`<div class="msg w" style="margin-bottom:8px">${esc(warn)}</div>`:'')+legendBar()+gr.sheets.map((sh,si)=>{
    const u=sh.placed.reduce((s,p)=>s+p.it.A,0)/(g.w*g.h)*100;
    return`<div class="sheetbox" style="--i:${Math.min(si,8)}"><div class="hd"><b>Chapa ${si+1}</b><span>${esc(g.w)}×${esc(g.h)} mm</span><span>${sh.placed.length} ${sh.placed.length===1?'peça':'peças'}</span>${gr.ext&&gr.ext[si]!=null?`<span>usado ${esc(gr.ext[si])} mm</span>`:''}<span class="bar"><i style="width:${Math.max(0,Math.min(100,u))}%"></i></span><b>${u.toFixed(1)}%</b></div><div class="cv">${sheetSVG(sh,g)}</div></div>`}).join('');
  if(play){void stage.offsetWidth;stage.classList.add('sheets-in')}}
function sheetSVG(sh,g,plain){
  const body=sh.placed.map(p=>{
    const col=partColor(p.it);
    return `<path transform="translate(${p.x.toFixed(1)} ${(-p.y).toFixed(1)})" d="${path(p.rings)}" fill="${plain?'none':col}" fill-opacity=".82" fill-rule="evenodd" stroke="${plain?'#000':'#1a1c20cc'}" stroke-width="${plain?.5:1.2}" vector-effect="non-scaling-stroke"><title>${esc(p.it.name)}</title></path>`;
  }).join('');
  return `<svg viewBox="-20 ${esc(-g.h-20)} ${esc(g.w+40)} ${esc(g.h+40)}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="${esc(-g.h)}" width="${esc(g.w)}" height="${esc(g.h)}" fill="${plain?'#fff':'none'}" stroke="${plain?'#000':'currentColor'}" stroke-opacity=".5" stroke-width="2"/>${body}</svg>`;
}
document.addEventListener('input',e=>{const t=e.target,pe=t.closest('.part'),ge=t.closest('.grp');
  if(t.dataset.setF==='name'){const s=S.sets.find(x=>x.id===t.dataset.set);if(s)s.name=t.value;return}
  if(pe&&t.dataset.f){const p=S.parts[+pe.dataset.i],f=t.dataset.f;if(p.guest)return;
    if(f==='pick'){p.pick=t.checked;pe.classList.toggle('pick',p.pick);updateColorButtons();return}
    if(f==='groupId') return;
    p[f]=t.tagName==='SELECT'?t.value:t.type==='checkbox'?t.checked:t.type==='number'?(+t.value||(f==='th'?1:1)):t.value;if(f==='th')p.thSrc='manual';if(f==='mat')p.matSrc='manual';S.res=null;S.snap=null;S.pdf=null}
  if(ge&&t.dataset.g){const g=S.groups[ge.dataset.k];g[t.dataset.g]=+t.value||1;S.sheetMemory[ge.dataset.k]={w:g.w,h:g.h};S.res=null;S.snap=null;S.pdf=null}});
document.addEventListener('change',e=>{
  const t=e.target;
  if(t.dataset.set){const s=S.sets.find(x=>x.id===t.dataset.set);if(!s)return;const f=t.dataset.setF;
    if(f==='name'){s.name=t.value;render();return}
    if(f==='count'){setCount(s.id,t.value);return}
    if(f==='color'){const c=hexColor(t.value,s.color).toLowerCase();if(S.sets.some(x=>x!==s&&String(x.color).toLowerCase()===c)){toast('Essa cor já é de outro modelo. Cada modelo tem a sua.','bad');render();return}s.color=c}
    if(f==='isolate') s.isolate=t.checked;
    if(f==='together') s.together=t.checked;
    if(f==='isolate'||f==='together'){S.res=null;S.snap=null;S.pdf=null;$('#nmsg').className='msg w';$('#nmsg').textContent='Regra alterada. Encaixe de novo para valer no cálculo.'}
    render();return}
  const pe=t.closest('.part');
  if(pe&&t.dataset.f==='groupId'){const p=S.parts[+pe.dataset.i];if(p.guest)return;moveToSet(p,t.value);if(rulesActive()){S.res=null;S.snap=null;S.pdf=null;$('#nmsg').className='msg w';$('#nmsg').textContent='Conjunto alterado. Encaixe de novo para a regra valer.'}render();return}
  const pr=t.closest('.grp');
  if(pr&&t.dataset.g){render();return}
  if(pr&&t.hasAttribute('data-preset')&&t.value.startsWith('p:')){const p=loadPresets().find(x=>x.id===t.value.slice(2));if(!p)return render();
    const k=pr.dataset.k;S.groups[k]={w:+p.w,h:+p.h};S.sheetMemory[k]={w:+p.w,h:+p.h};presetParams(p);
    S.activePreset={id:p.id,name:p.name};S.presetId=p.id;S.res=null;S.snap=null;S.pdf=null;render();renderPresets();
    toast('Preset "'+p.name+'" aplicado: chapa '+(+p.w)+'×'+(+p.h)+' mm, espaço '+(+p.gap)+', margem '+(+p.mar)+'.','ok');return}
  if(pr&&t.hasAttribute('data-preset')&&t.value){const[w,hh]=t.value.split('x').map(Number);Object.assign(S.groups[pr.dataset.k],{w,h:hh});S.sheetMemory[pr.dataset.k]={w,h:hh};S.res=null;S.snap=null;S.pdf=null;render();return}
  /* depois do Tab: o foco já está no próximo campo e renderCore o devolve no campo recriado */
  if(pe&&['mat','th','on','qty'].includes(t.dataset.f))setTimeout(render)});
$('#tabs').onclick=e=>{const k=e.target.dataset.t;if(k){S.tab=k;render()}};

/* ---------- relatório ---------- */
function nfmt(n,d){return Number(n).toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d})}
function m2txt(mm2){return nfmt(mm2/1e6,3)+' m²'}
function pctxt(v){return v==null?'não calculado':nfmt(v,1)+'%'}
function mmxt(n){if(!Number.isFinite(n))return '—';const r=Math.round(n);return Math.abs(n-r)<0.05?r.toLocaleString('pt-BR'):nfmt(n,1)}
function nearly(a,b){return Math.abs(a-b)<=Math.max(0.05,Math.abs(b)*1e-6)}
function jobName(){return ($('#job').value||S.file||'encaixe').trim()||'encaixe'}
function audit(){
  const issues=[],R=S.res,snap=S.snap;
  if(!R||!snap) return ['Não há encaixe calculado.'];
  for(const k of Object.keys(R)){
    const g=snap.groups[k],live=S.groups[k],gr=R[k];
    if(!g||!(g.w>0)||!(g.h>0)){issues.push('Chapa sem medida válida em '+k+'.');continue}
    if(!live||live.w!==g.w||live.h!==g.h) issues.push('A medida da chapa mudou depois do encaixe ('+k+').');
    const placed={},failed={};
    let occ=0,pcs=0;
    for(const sh of gr.sheets){
      let shOcc=0;
      for(const p of sh.placed){
        if(!p.it||!Number.isFinite(p.it.A)||p.it.A<0){issues.push('Área de peça inválida.');continue}
        if(gk(p.it)!==k) issues.push(p.it.name+' foi parar em chapa de outro material.');
        shOcc+=p.it.A;placed[p.it.id]=(placed[p.it.id]||0)+1;pcs++;
      }
      occ+=shOcc;
      if(shOcc-g.w*g.h>0.05) issues.push('Área ocupada maior que a chapa em '+k+'.');
    }
    (gr.fail||[]).forEach(p=>{if(!p){issues.push('Falha de encaixe sem peça.');return}failed[p.id]=(failed[p.id]||0)+1});
    let req=0;
    for(const p of (groupsOf()[k]||[])){
      req+=p.qty;
      const got=(placed[p.id]||0)+(failed[p.id]||0);
      if(got!==p.qty) issues.push(p.name+': '+got+' peça(s) no resultado, quantidade pedida '+p.qty+'.');
    }
    if(pcs+(gr.fail||[]).length!==req) issues.push('A soma de peças encaixadas e de fora não fecha em '+k+'.');
    if(!nearly(used(gr),occ)) issues.push('Área ocupada divergente em '+k+'.');
    if((gr.failWhy||[]).length && gr.failWhy.length!==(gr.fail||[]).length) issues.push('Motivo da falha incompleto em '+k+'.');
  }
  return issues;
}
function reportModel(){
  const issues=audit();
  if(issues.length) throw Error('Relatório bloqueado. '+issues.slice(0,3).join(' '));
  const snap=S.snap,when=new Date();
  const groups=[];
  let sheetN=0,sheetA=0,occA=0,reqN=0,placeN=0,failN=0;
  for(const k of Object.keys(S.res)){
    const gr=S.res[k],g=snap.groups[k],sheetArea=g.w*g.h;
    const sheets=gr.sheets.map((sh,i)=>{
      const occ=sh.placed.reduce((s,p)=>s+p.it.A,0);
      const by={};
      for(const p of sh.placed){const id=p.it.id;if(!by[id])by[id]={id,name:p.it.name,n:0,color:partColor(p.it)};by[id].n++}
      return {n:i+1,w:g.w,h:g.h,pcs:sh.placed.length,occ,area:sheetArea,waste:sheetArea-occ,util:sheetArea?occ/sheetArea*100:null,extent:gr.ext&&gr.ext[i]!=null?gr.ext[i]:null,counts:Object.values(by),raw:sh};
    });
    const occ=sheets.reduce((s,sh)=>s+sh.occ,0);
    const parts=(groupsOf()[k]||[]).map(p=>{
      const placed=sheets.reduce((s,sh)=>s+sh.counts.filter(c=>c.id===p.id).reduce((a,c)=>a+c.n,0),0);
      return {name:p.name,qty:p.qty,placed,w:p.w,h:p.h,area:p.A,holes:p.holes||0,group:p.groupId?setNameOf(p.groupId):'Sem conjunto',color:partColor(p)};
    });
    const placedSum=parts.reduce((s,p)=>s+p.placed,0);
    const gArea=sheets.length*sheetArea;
    groups.push({key:k,w:g.w,h:g.h,sheets,parts,occ,sheetArea:gArea,waste:gArea-occ,util:gArea?occ/gArea*100:null,fail:failRows(gr),rawG:g});
    sheetN+=sheets.length;sheetA+=gArea;occA+=occ;reqN+=parts.reduce((s,p)=>s+p.qty,0);placeN+=placedSum;failN+=(gr.fail||[]).length;
    if(!nearly(placedSum,sheets.reduce((s,sh)=>s+sh.pcs,0))) throw Error('Relatório bloqueado. Contagem por chapa não fecha em '+k+'.');
  }
  if(!nearly(occA,groups.reduce((s,g)=>s+g.occ,0))) throw Error('Relatório bloqueado. A área ocupada não fecha.');
  const rules=snap.rules||{mix:true,isolate:[],together:[],forbid:[]};
  const legend=[];
  for(const s of S.sets){
    const parts=S.parts.filter(p=>p.on&&p.groupId===s.id);
    if(!parts.length) continue;
    legend.push({name:s.name,color:s.color,qty:parts.reduce((a,p)=>a+p.qty,0),names:parts.map(p=>p.name),rule:ruleOf(s.id,rules)});
  }
  const loose=S.parts.filter(p=>p.on&&!p.groupId);
  if(loose.length) legend.push({name:'Sem conjunto',color:'#8b93a1',qty:loose.reduce((a,p)=>a+p.qty,0),names:loose.map(p=>p.name),rule:rules.mix?'Pode compartilhar a chapa':'Chapas separadas dos conjuntos nomeados'});
  return {
    job:jobName(),when,whenLabel:when.toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'medium'}),
    preset:snap.preset&&snap.preset.name?snap.preset.name:'',
    engine:snap.engine,workers:snap.workers,iters:snap.iters||0,opt:snap.opt,askedCs:snap.askedCs,rotLabel:snap.rotLabel||'',
    rules,rulesText:rulesParagraph(rules),legend,groups,
    totals:{sheets:sheetN,sheetArea:sheetA,occ:occA,waste:sheetA-occA,util:sheetA?occA/sheetA*100:null,requested:reqN,placed:placeN,failed:failN}
  };
}
function failRows(gr){
  const rows=[];
  (gr.fail||[]).forEach((p,i)=>{
    const why=(gr.failWhy||[])[i]||'tamanho';
    const hit=rows.find(r=>r.name===p.name&&r.why===why);
    if(hit) hit.n++; else rows.push({name:p.name,why,n:1,color:partColor(p)});
  });
  return rows;
}
function ruleOf(id,rules){
  if((rules.together||[]).includes(id)) return 'Mesma chapa, sem misturar';
  if((rules.isolate||[]).includes(id)) return 'Chapas exclusivas';
  if(!rules.mix) return 'Chapas separadas dos outros conjuntos';
  const ban=(rules.forbid||[]).filter(p=>p[0]===id||p[1]===id);
  if(ban.length){const names=ban.map(p=>setNameOf(p[0]===id?p[1]:p[0]));return 'Não mistura com '+names.join(', ')}
  return 'Pode compartilhar a chapa';
}
function rulesParagraph(rules){
  const bits=[];
  bits.push(rules.mix?'Peças de cores diferentes puderam ocupar a mesma chapa.':'Conjuntos diferentes foram para chapas diferentes.');
  const nome=id=>setNameOf(id);
  if((rules.isolate||[]).length) bits.push('Chapas exclusivas: '+(rules.isolate.map(nome).join(', '))+'.');
  if((rules.together||[]).length) bits.push('Manter na mesma chapa: '+(rules.together.map(nome).join(', '))+'.');
  if((rules.forbid||[]).length) bits.push('Sem misturar: '+rules.forbid.map(p=>nome(p[0])+' × '+nome(p[1])).join('; ')+'.');
  if(rules.mix&&!(rules.isolate||[]).length&&!(rules.together||[]).length&&!(rules.forbid||[]).length) return 'Nenhuma regra de separação. A cor só identifica o conjunto.';
  return bits.join(' ');
}
function fingerprint(m){
  return JSON.stringify({job:m.job,preset:m.preset,opt:m.opt,rules:m.rulesText,totals:m.totals,legend:m.legend,groups:m.groups.map(g=>({key:g.key,w:g.w,h:g.h,occ:g.occ,waste:g.waste,util:g.util,parts:g.parts,fail:g.fail,sheets:g.sheets.map(s=>({n:s.n,pcs:s.pcs,occ:s.occ,waste:s.waste,util:s.util,extent:s.extent,counts:s.counts}))}))});
}
function modelHtml(m){
  const t=m.totals;
  const meta=[
    ['Trabalho',m.job],['Gerado em',m.whenLabel],
    m.preset?['Preset',m.preset]:null,
    ['Motor',m.engine==='servidor'?'Servidor'+(m.workers?' · '+m.workers+' núcleo(s)':'')+(m.iters?' · '+m.iters+' iterações da busca':''):'Navegador'],
    ['Materiais',m.groups.map(g=>g.key).join(' · ')||'—'],
    ['Chapas',String(t.sheets)],
    ['Peças pedidas / encaixadas / de fora',t.requested+' / '+t.placed+' / '+t.failed],
    ['Área das chapas',m2txt(t.sheetArea)],
    ['Área líquida das peças',m2txt(t.occ)],
    ['Sobra',m2txt(t.waste)],
    ['Aproveitamento',pctxt(t.util)],
    ['Espaço entre peças',mmxt(m.opt.gap)+' mm'],
    ['Margem da chapa',mmxt(m.opt.mar)+' mm'],
    ['Rotação',m.rotLabel],
    ['Resolução usada',mmxt(m.opt.cs)+' mm'+(m.engine==='navegador'&&m.askedCs<3?' (pedido '+mmxt(m.askedCs)+' mm; o motor do navegador usa no mínimo 3 mm)':'')],
    ['Limite de otimização',m.opt.secs+' s']
  ].filter(Boolean);
  let h=`<div class="paper"><h2>Relatório de encaixe</h2><table><tbody>`;
  for(const [a,b] of meta) h+=`<tr><th>${esc(a)}</th><td>${esc(b)}</td></tr>`;
  h+=`</tbody></table><p>${esc(m.rulesText)}</p><p class="note">Área líquida é a área já calculada da peça, com furos descontados. A sobra é área da chapa menos essa área e inclui margem, espaçamento, furos e região vazia.</p>`;
  if(m.legend.length){h+=`<h2>Conjuntos</h2><table><thead><tr><th>Conjunto</th><th>Qtd</th><th>Peças</th><th>Regra no encaixe</th></tr></thead><tbody>`;
    for(const e of m.legend) h+=`<tr><td><i class="sw" style="background:${esc(e.color)}"></i>${esc(e.name)}</td><td>${esc(e.qty)}</td><td>${esc(e.names.join(', '))}</td><td>${esc(e.rule)}</td></tr>`;
    h+=`</tbody></table>`}
  for(const g of m.groups){
    h+=`<h2>${esc(g.key)}</h2><p>Comprimento ${mmxt(g.w)} mm · largura ${mmxt(g.h)} mm · ${g.sheets.length} chapa(s) · área ${m2txt(g.sheetArea)} · ocupada ${m2txt(g.occ)} · sobra ${m2txt(g.waste)} · aproveitamento ${pctxt(g.util)}</p>`;
    h+=`<table><thead><tr><th>Chapa</th><th>Comp.</th><th>Larg.</th><th>Peças</th><th>m² chapa</th><th>m² peças</th><th>Sobra</th><th>%</th><th>Usado</th></tr></thead><tbody>`;
    for(const s of g.sheets) h+=`<tr><td>${s.n}</td><td>${mmxt(s.w)}</td><td>${mmxt(s.h)}</td><td>${esc(s.pcs)}</td><td>${m2txt(s.area)}</td><td>${m2txt(s.occ)}</td><td>${m2txt(s.waste)}</td><td>${pctxt(s.util)}</td><td>${s.extent==null?'—':esc(mmxt(s.extent))+' mm'}</td></tr>`;
    h+=`<tr><th>Total</th><td></td><td></td><th>${g.sheets.reduce((a,s)=>a+s.pcs,0)}</th><th>${m2txt(g.sheetArea)}</th><th>${m2txt(g.occ)}</th><th>${m2txt(g.waste)}</th><th>${pctxt(g.util)}</th><td></td></tr></tbody></table>`;
    h+=`<table><thead><tr><th>Peça</th><th>Qtd</th><th>Encaix.</th><th>Medida</th><th>m² un.</th><th>Conjunto</th></tr></thead><tbody>`;
    for(const p of g.parts) h+=`<tr><td><i class="sw" style="background:${esc(p.color)}"></i>${esc(p.name)}</td><td>${esc(p.qty)}</td><td>${esc(p.placed)}</td><td>${mmxt(p.w)}×${mmxt(p.h)} mm${p.holes?' · '+esc(p.holes)+' furo'+(p.holes>1?'s':''):''}</td><td>${m2txt(p.area)}</td><td>${esc(p.group)}</td></tr>`;
    h+=`</tbody></table>`;
    if(g.fail.length){h+=`<p>Fora do encaixe: ${g.fail.map(f=>esc(f.name)+' × '+f.n+' ('+(f.why==='junto'?'não coube na mesma chapa do conjunto':'não cabe na chapa')+')').join('; ')}.</p>`}
    for(const s of g.sheets){
      h+=`<h2>Chapa ${s.n} · ${esc(g.key)}</h2><p>${s.pcs} ${s.pcs===1?'peça':'peças'}: ${esc(s.counts.map(c=>c.name+' × '+c.n).join(', ')||'—')}</p><div data-fig="${esc(g.key)}:${s.n}"></div>`;
    }
  }
  h+=`<p class="note">No PDF este conteúdo vai para folhas A4, com cabeçalho, rodapé e número de página. A coluna Usado só aparece com número quando o motor do servidor devolve o comprimento usado.</p></div>`;
  return h;
}
function mountCanvases(m){
  for(const g of m.groups) for(const s of g.sheets){
    const host=document.querySelector('[data-fig="'+CSS.escape(g.key+':'+s.n)+'"]');
    if(!host) continue;
    const c=drawSheet(s.raw,{w:s.w,h:s.h},m.opt.mar);
    c.className='sheetcanvas';
    host.appendChild(c);
  }
}
function drawSheet(sh,g,mar){
  const maxW=1200,pad=36,sc=(maxW-pad*2)/g.w,H=Math.round(g.h*sc+pad*2);
  const c=document.createElement('canvas');c.width=maxW;c.height=Math.max(180,H);
  const ctx=c.getContext('2d');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,c.width,c.height);
  const X=x=>pad+x*sc,Y=y=>pad+(g.h-y)*sc;
  ctx.strokeStyle='#222';ctx.lineWidth=2;ctx.strokeRect(X(0),Y(g.h),g.w*sc,g.h*sc);
  if(mar>0&&g.w>2*mar&&g.h>2*mar){ctx.save();ctx.strokeStyle='#b7b1a6';ctx.setLineDash([5,4]);ctx.lineWidth=1;ctx.strokeRect(X(mar),Y(g.h-mar),(g.w-2*mar)*sc,(g.h-2*mar)*sc);ctx.restore()}
  for(const p of sh.placed){
    ctx.beginPath();
    p.rings.forEach(r=>{r.forEach((pt,i)=>{const x=X(p.x+pt[0]),y=Y(p.y+pt[1]);if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)});ctx.closePath()});
    const col=partColor(p.it);ctx.fillStyle=col;ctx.fill('evenodd');ctx.strokeStyle='#1a1c20';ctx.lineWidth=1;ctx.stroke();
  }
  return c;
}
function openPreview(){
  try{const m=reportModel();$('#modalBody').innerHTML=modelHtml(m);mountCanvases(m);showModal('modal','#modalX')}
  catch(e){status(e.message,true)}
}
function generatePdf(){
  try{
    const m=reportModel();
    const bytes=modelPdf(m);
    S.pdf={bytes,name:safeName(m.job)+'_relatorio.pdf',fingerprint:fingerprint(m)};
    $('#pdfDl').disabled=false;$('#modalDl').disabled=false;
    if(!$('#modal').hidden){$('#modalBody').innerHTML=modelHtml(m);mountCanvases(m)}
    status('PDF gerado. Já pode baixar.',false);
  }catch(e){status(e.message,true)}
}
function downloadReady(){
  if(!S.pdf){status('Gere o PDF antes de baixar.',true);return}
  let now;
  try{now=fingerprint(reportModel())}catch(e){status(e.message,true);return}
  if(now!==S.pdf.fingerprint){status('Os dados mudaram depois da geração. Gere o PDF de novo.',true);S.pdf=null;$('#pdfDl').disabled=true;$('#modalDl').disabled=true;return}
  dl(S.pdf.name,S.pdf.bytes,'application/pdf');
}
$('#pdfPrev').onclick=openPreview;
$('#pdfGo').onclick=generatePdf;
$('#pdfDl').onclick=downloadReady;
$('#modalPdf').onclick=generatePdf;
$('#modalDl').onclick=downloadReady;
$('#modalX').onclick=()=>hideModal('modal');
$('#modal').onclick=e=>{if(e.target.id==='modal')hideModal('modal')};
$('#ask').onclick=e=>{if(e.target.id==='ask'&&$('#askNo').onclick)$('#askNo').click()};
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(!$('#ask').hidden&&$('#askNo').onclick){$('#askNo').click();return}
  if(!$('#impModal').hidden){$('#impNo').click();return}if(!$('#projModal').hidden){hideModal('projModal');return}hideModal('modal')});

/* ---------- PDF ---------- */
const PW=595,PH=842,ML=40,MT=74,MB=44,CW=PW-80;
function pdfStr(s){
  let o='(';
  for(const ch of String(s)){
    let c=ch.codePointAt(0);
    if(c>255){const map={'€':0x80,'–':0x96,'—':0x97,'‘':0x91,'’':0x92,'“':0x93,'”':0x94,'…':0x85,'•':0x95};c=map[ch]||63}
    if(c===40||c===41||c===92) o+='\\'+String.fromCharCode(c);
    else if(c<32||c>126) o+='\\'+c.toString(8).padStart(3,'0');
    else o+=String.fromCharCode(c);
  }
  return o+')';
}
function latin1(s){const u=new Uint8Array(s.length);for(let i=0;i<s.length;i++)u[i]=s.charCodeAt(i)&255;return u}
function T(x,y,text,size,font){return `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfStr(text)} Tj ET\n`}
function clipText(text,width,size){const max=Math.max(1,Math.floor((width-4)/(size*0.5)));text=String(text);return text.length>max?text.slice(0,max-3)+'...':text}
function wrapText(text,size,maxW){const max=Math.max(8,Math.floor(maxW/(size*0.5)));const words=String(text).split(/\s+/),lines=[];let cur='';for(const w of words){const t=cur?cur+' '+w:w;if(t.length>max&&cur){lines.push(cur);cur=w}else cur=t}if(cur)lines.push(cur);return lines.length?lines:['']}
function hexRgb(hex){const n=parseInt(String(hex).slice(1),16)||0;return[(n>>16)/255,((n>>8)&255)/255,(n&255)/255]}
function buildPdf(pageContents,images){
  const nImg=images.length,nPages=pageContents.length,firstImg=5,firstPage=5+nImg,pageNums=[];
  for(let i=0;i<nPages;i++) pageNums.push(firstPage+i*2);
  const chunks=[];let off=0;const offsets=[0];
  function add(data){const b=typeof data==='string'?latin1(data):data;chunks.push(b);off+=b.length}
  function addObj(n,parts){offsets[n]=off;add(n+' 0 obj\n');for(const p of parts)add(p);add('\nendobj\n')}
  add('%PDF-1.4\n');
  addObj(1,['<< /Type /Catalog /Pages 2 0 R >>']);
  addObj(2,['<< /Type /Pages /Count '+nPages+' /Kids ['+pageNums.map(n=>n+' 0 R').join(' ')+'] >>']);
  addObj(3,['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>']);
  addObj(4,['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>']);
  images.forEach((im,i)=>{const header=`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.data.length} >>\nstream\n`;addObj(firstImg+i,[header,im.data,'\nendstream'])});
  pageContents.forEach((content,i)=>{
    const pn=pageNums[i],cn=pn+1,cb=latin1(content);
    const xobj=images.map((im,k)=>'/Im'+k+' '+(firstImg+k)+' 0 R').join(' ');
    addObj(pn,['<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << '+xobj+' >> >> /Contents '+cn+' 0 R >>']);
    addObj(cn,['<< /Length '+cb.length+' >>\nstream\n',cb,'\nendstream']);
  });
  const start=off,count=firstPage+nPages*2;
  let xref='xref\n0 '+count+'\n0000000000 65535 f \n';
  for(let i=1;i<count;i++){if(offsets[i]==null)throw Error('PDF incompleto');xref+=String(offsets[i]).padStart(10,'0')+' 00000 n \n'}
  xref+='trailer\n<< /Size '+count+' /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF';
  add(xref);
  const out=new Uint8Array(off);let p=0;for(const c of chunks){out.set(c,p);p+=c.length}
  return out;
}
function paintPages(blocks,images,whenLabel){
  const pages=[];let cur=[],y=PH-MT;
  function flush(){if(cur.length)pages.push(cur);cur=[];y=PH-MT}
  for(const b of blocks){if(y-b.h<MB)flush();cur.push(b.draw(y));y-=b.h}
  flush();
  if(!pages.length)pages.push(['']);
  const streams=pages.map((chunks,i)=>{
    const head='0.886 0.416 0.102 RG 1.3 w 40 814 m 555 814 l S\n0.886 0.416 0.102 rg\n'+T(40,822,'ENCAIXE / CHAPA',8,'F2')+'0.25 0.23 0.2 rg\n'+T(330,822,'Relatório de encaixe',8,'F1');
    const foot='0.75 0.72 0.66 RG 0.4 w 40 32 m 555 32 l S\n0.35 0.33 0.3 rg\n'+T(40,18,whenLabel,8,'F1')+T(430,18,'Página '+(i+1)+' de '+pages.length,8,'F1');
    return head+chunks.join('')+foot;
  });
  return buildPdf(streams,images);
}
function paraBlock(text,size,font){const lines=wrapText(text,size,CW),h=lines.length*(size+3)+2;return {h,draw(top){let s='0.12 0.11 0.1 rg\n';lines.forEach((ln,i)=>{s+=T(ML,top-size-i*(size+3),ln,size,font)});return s}}}
function headBlock(text){return {h:20,draw(top){return '0.1 0.09 0.08 rg\n'+T(ML,top-13,text,11,'F2')}}}
function gapBlock(h){return {h,draw(){return ''}}}
function tableBlocks(headers,rows,colW){
  const headH=16,rowH=14,maxH=PH-MT-MB-8,chunk=Math.max(1,Math.floor((maxH-headH)/rowH));
  const out=[];
  const src=rows.length?rows:[['—']];
  for(let i=0;i<src.length;i+=chunk){
    const slice=src.slice(i,i+chunk),h=headH+slice.length*rowH+6;
    out.push({h,draw(top){return drawTable(top,headers,slice,colW,headH,rowH)}});
  }
  return out;
}
function drawTable(top,headers,rows,colW,headH,rowH){
  const tableH=headH+rows.length*rowH,y0=top-tableH;let s='0.91 0.89 0.84 rg\n';
  s+=ML+' '+(top-headH).toFixed(2)+' '+CW+' '+headH+' re f\n';
  s+='0.72 0.69 0.62 RG 0.4 w\n'+ML+' '+y0.toFixed(2)+' '+CW+' '+tableH.toFixed(2)+' re S\n';
  let x=ML;for(let i=0;i<colW.length-1;i++){x+=colW[i];s+=x.toFixed(2)+' '+y0.toFixed(2)+' m '+x.toFixed(2)+' '+top.toFixed(2)+' l S\n'}
  for(let r=0;r<=rows.length;r++){const yy=top-headH-r*rowH;s+=ML+' '+yy.toFixed(2)+' m '+(ML+CW)+' '+yy.toFixed(2)+' l S\n'}
  s+='0.2 0.18 0.16 rg\n';x=ML;
  headers.forEach((h,i)=>{s+=T(x+2,top-headH+4,clipText(h,colW[i],7.5),7.5,'F2');x+=colW[i]});
  rows.forEach((row,ri)=>{let xx=ML;row.forEach((cell,i)=>{s+=T(xx+2,top-headH-ri*rowH-rowH+4,clipText(cell,colW[i]||40,8),8,'F1');xx+=colW[i]||0});});
  return s;
}
function canvasJpeg(canvas){
  const url=canvas.toDataURL('image/jpeg',0.84),bin=atob(url.split(',')[1]),data=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++)data[i]=bin.charCodeAt(i);
  if(data[0]!==0xFF||data[1]!==0xD8) throw Error('Falha ao desenhar a chapa para o PDF.');
  return {w:canvas.width,h:canvas.height,data};
}
function imageBlock(im,caption){
  const maxH=PH-MT-MB-30;let dw=CW,dh=im.h*(CW/im.w);if(dh>maxH){dh=maxH;dw=im.w*(dh/im.h)}
  const h=16+dh+8;
  return {h,draw(top){const y=top-16-dh,x=ML+(CW-dw)/2;return '0.1 0.1 0.1 rg\n'+T(ML,top-11,caption,9,'F2')+`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im${im.idx} Do Q\n`}};
}
function legendBlock(entries){
  const rowH=13,h=entries.length*rowH+4;
  return {h,draw(top){let s='';entries.forEach((e,i)=>{const y=top-10-i*rowH,rgb=hexRgb(e.color);s+=rgb.map(v=>v.toFixed(3)).join(' ')+' rg\n'+ML+' '+(y-1).toFixed(2)+' 8 8 re f\n0.12 0.11 0.1 rg\n'+T(ML+14,y,clipText(e.name+' · '+e.qty+' un · '+e.names.join(', ')+' · '+e.rule,CW-14,8),8,'F1')});return s}};
}
function modelPdf(m){
  const images=[],blocks=[];
  const push=b=>{if(Array.isArray(b))blocks.push(...b);else blocks.push(b)};
  const t=m.totals;
  push(paraBlock(m.job,14,'F2'));
  push(paraBlock('Gerado em '+m.whenLabel+(m.preset?' · Preset '+m.preset:''),9,'F1'));
  push(gapBlock(4));
  push(headBlock('Resumo'));
  const meta=[
    ['Trabalho',m.job],['Motor',m.engine==='servidor'?'Servidor':'Navegador'],
    ['Núcleos',m.workers?String(m.workers):'—'],['Iterações',m.iters?String(m.iters):'—'],
    ['Chapas',String(t.sheets)],['Pedidas',String(t.requested)],['Encaixadas',String(t.placed)],['De fora',String(t.failed)],
    ['Área chapas',m2txt(t.sheetArea)],['Área peças',m2txt(t.occ)],['Sobra',m2txt(t.waste)],['Aproveitamento',pctxt(t.util)],
    ['Espaço',mmxt(m.opt.gap)+' mm'],['Margem',mmxt(m.opt.mar)+' mm'],['Resolução',mmxt(m.opt.cs)+' mm'],['Limite',m.opt.secs+' s']
  ];
  push(tableBlocks(['Item','Valor'],meta,[180,335]));
  push(paraBlock('Rotação: '+m.rotLabel,9,'F1'));
  push(paraBlock(m.rulesText,9,'F1'));
  push(paraBlock('Área líquida é a área já calculada da peça, com furos descontados. A sobra é chapa menos essa área: margem, espaçamento, furos e vazio.',8,'F1'));
  if(m.legend.length){push(headBlock('Conjuntos'));push(legendBlock(m.legend))}
  const colS=[28,58,58,42,70,68,62,46,83];
  const colP=[130,40,52,100,60,133];
  for(const g of m.groups){
    push(headBlock(g.key));
    push(paraBlock('Comprimento '+mmxt(g.w)+' mm · largura '+mmxt(g.h)+' mm · '+g.sheets.length+' chapa(s).',9,'F1'));
    push(tableBlocks(['Chapa','Comp.','Larg.','Peças','m² chapa','m² peças','Sobra','%','Usado'],g.sheets.map(s=>[String(s.n),mmxt(s.w),mmxt(s.h),String(s.pcs),m2txt(s.area),m2txt(s.occ),m2txt(s.waste),pctxt(s.util),s.extent==null?'—':mmxt(s.extent)+' mm']),colS));
    push(tableBlocks(['Peça','Qtd','Encaix.','Medida','m² un.','Conjunto'],g.parts.map(p=>[p.name,String(p.qty),String(p.placed),mmxt(p.w)+' × '+mmxt(p.h)+(p.holes?' · '+p.holes+' furo'+(p.holes>1?'s':''):''),m2txt(p.area),p.group]),colP));
    if(g.fail.length) push(paraBlock('Fora do encaixe: '+g.fail.map(f=>f.name+' × '+f.n+' ('+(f.why==='junto'?'não coube na mesma chapa do conjunto':'não cabe na chapa')+')').join('; ')+'.',9,'F1'));
    for(const s of g.sheets){
      const canvas=drawSheet(s.raw,{w:s.w,h:s.h},m.opt.mar);
      const im=canvasJpeg(canvas);im.idx=images.length;images.push(im);
      push(imageBlock(im,'Chapa '+s.n+' · '+g.key+' · '+s.counts.map(c=>c.name+' × '+c.n).join(', ')));
    }
  }
  push(gapBlock(8));
  push(paraBlock('Resultado: '+t.placed+' de '+t.requested+' peças em '+t.sheets+' chapa(s). Aproveitamento '+pctxt(t.util)+'. Sobra '+m2txt(t.waste)+'.',10,'F2'));
  return paintPages(blocks,images,m.whenLabel);
}

/* ---------- exportação ---------- */
function dl(name,data,type){const blob=data instanceof Blob?data:new Blob([data],{type});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000)}
function dxfSheets(list){let o='0\nSECTION\n2\nENTITIES\n';
  const pl=(pts,layer)=>{o+=`0\nPOLYLINE\n8\n${layer}\n66\n1\n70\n1\n`;pts.forEach(([x,y])=>o+=`0\nVERTEX\n8\n${layer}\n10\n${x.toFixed(4)}\n20\n${y.toFixed(4)}\n`);o+='0\nSEQEND\n8\n'+layer+'\n'};
  let oy=0;for(const{sh,g}of list){pl([[0,oy],[g.w,oy],[g.w,oy+g.h],[0,oy+g.h]],'CHAPA');
    for(const p of sh.placed)for(const r of p.rings)pl(r.map(([x,y])=>[x+p.x,y+p.y+oy]),'CORTE');oy+=g.h+200}
  return o+'0\nENDSEC\n0\nEOF\n'}
const cur=()=>{const gr=S.res[S.tab],g=S.groups[S.tab];return gr.sheets.map(sh=>({sh,g}))};
/* Nome padrão de exportação: NN-<espessura>MM-<planejamento>. NN é a ordem de corte entre todas as chapas
   do encaixe: primeiro as chapas com o produto que vem antes no planejamento (menor posição na lista). */
function sheetSeq(){const L=[],keys=Object.keys(S.res||{});
  keys.forEach((k,gi)=>S.res[k].sheets.forEach((sh,i)=>L.push({k,i,gi,r:Math.min(1e9,...sh.placed.map(q=>Number.isFinite(q.it.rank)?q.it.rank:1e9))})));
  L.sort((a,b)=>a.r-b.r||a.gi-b.gi||a.i-b.i);
  const w=Math.max(2,String(L.length).length);return new Map(L.map((x,n)=>[x.k+'|'+x.i,String(n+1).padStart(w,'0')]))}
const planLabel=()=>{const m=curProj()||{};return plain(String(m.plan&&m.product||'ENCAIXE').trim()||'ENCAIXE')};   // sem planejamento enviado: ENCAIXE
function sheetFile(k,i,seq){const th=String(k.split(' · ')[1]||'').replace(/\s*mm$/,'').replace(',','.');
  return safeName((seq||sheetSeq()).get(k+'|'+i)+'-'+th+'MM-'+planLabel())}
const safeName=s=>String(s||'encaixe').normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^\w.-]+/g,'_').replace(/^_+|_+$/g,'')||'encaixe';
const nm=()=>safeName((($('#job').value||S.file)||'pecas')+'_'+S.tab);
/* Exportação igual em todos os formatos: chapa por chapa ou todas em um arquivo (chapas empilhadas, 200 mm entre elas),
   na aba aberta ou em todas as espessuras. */
const xKeys=()=>$('#xScope').checked?Object.keys(S.res||{}):[S.tab];
function allName(key,keys){const[mat,thTxt]=key.split(' · '),th=String(thTxt||'').replace(/\s*mm$/,''),dup=keys.filter(k=>String(k.split(' · ')[1])===String(thTxt)).length>1;
  return safeName('TODAS-'+th+'MM-'+planLabel()+(dup?'-'+plain(mat):''))}
function stacked(key){const g=S.groups[key],L=S.res[key].sheets;let oy=0;const placed=[];
  L.forEach((sh,i)=>{for(const q of sh.placed)placed.push({...q,y:q.y+oy});oy+=g.h+(i<L.length-1?200:0)});
  return{sh:{placed},g:{w:g.w,h:oy}}}
const svgOf=(sh,g)=>sheetSVG(sh,g,true).replace('<svg ',`<svg width="${g.w}mm" height="${g.h}mm" `);
async function exportAs(fmt,mode){if(!S.res||!S.tab){toast('Encaixe antes de exportar.','bad');return}
  const keys=xKeys(),q=sheetSeq();let n=0;
  if(fmt==='eps')return exportEps(keys,mode);
  status('Gerando '+fmt.toUpperCase()+'…',false);
  try{for(const key of keys){const g=S.groups[key],L=S.res[key].sheets.map(sh=>({sh,g}));
      const files=mode==='one'?[{name:allName(key,keys),list:L,one:stacked(key)}]:L.map((c,i)=>({name:sheetFile(key,i,q),list:[c],one:c}));
      for(const f of files){
        if(fmt==='dxf')dl(f.name+'.dxf',dxfSheets(f.list),'text/plain');
        else if(fmt==='svg')dl(f.name+'.svg',svgOf(f.one.sh,f.one.g),'image/svg+xml');
        else if(fmt==='dwg'){const r=await sfetch('/api/dxf-dwg',{method:'POST',body:dxfSheets(f.list)});if(!r.ok){status(await r.text(),true);return}dl(f.name+'.dwg',await r.blob(),'application/acad')}
        n++}}
    hist('export',{format:fmt,mode,keys,files:n});status(n+' arquivo(s) '+fmt.toUpperCase()+' gerado(s).',false)}
  catch(e){status(e.message,true)}}
document.addEventListener('click',e=>{const b=e.target.closest('[data-x]');if(b)exportAs(b.dataset.x,b.dataset.xm).catch(x=>status(x.message,true))});
renderPresets();render();
/* ---------- exportação EPS ---------- */
function plain(t){return String(t).normalize('NFD').replace(/[\u0300-\u036f]/g,'')}
function nameFrom(pat,ctx){return safeName(plain(pat.replace(/\{(\w+)\}/g,(_,k)=>ctx[k]==null?'':ctx[k])).replace(/\s+/g,'_').replace(/_{2,}/g,'_'))}
function epsPlan(keys,mode){
  const q=sheetSeq(),items=[],used={};
  for(const key of keys){const[mat,thTxt]=key.split(' · '),th=thTxt.replace(' mm',''),sk=[S.projectId,mat,th].join('|');
    if(mode==='one'){const{sh,g}=stacked(key);items.push({key,sk,n:0,name:allName(key,keys)+'.eps',mat,th,one:true,sheet:{w:g.w,h:g.h,parts:sh.placed.map(q=>({rings:q.rings.map(r=>r.map(([x,y])=>[x+q.x,y+q.y])),color:partColor(q.it)}))},parts:sh.placed.length,src:[...new Set(sh.placed.map(q=>fileName(q.it.fileId)).filter(Boolean))]});continue}
    for(const[i,sh]of S.res[key].sheets.entries()){const n=(used[sk]??(S.seq[sk]||0))+1;used[sk]=n;
      const name=sheetFile(key,i,q)+'.eps',g=S.groups[key];
      items.push({key,sk,n,name,mat,th,sheet:{w:g.w,h:g.h,parts:sh.placed.map(q=>({rings:q.rings.map(r=>r.map(([x,y])=>[x+q.x,y+q.y])),color:partColor(q.it)}))},parts:sh.placed.length,src:[...new Set(sh.placed.map(q=>fileName(q.it.fileId)).filter(Boolean))]})}}
  return items}
async function exportEps(keys,mode){
  const p=curProj();if(!p){toast('Selecione um projeto.','bad');return}
  if(!S.res||!S.snap){toast('Encaixe antes de exportar.','bad');return}
  const items=epsPlan(keys,mode),pend=S.parts.filter(q=>q.on&&!q.groupId).length,guess=S.parts.filter(q=>q.on&&q.thSrc&&q.thSrc!=='manual').length,fails=keys.reduce((a,k)=>a+(S.res[k].fail||[]).length,0);
  const warns=[];if(pend)warns.push(pend+' peça(s) sem modelo (pendentes de classificação)');if(guess)warns.push(guess+' peça(s) com espessura não lida do arquivo (inferida do nome ou padrão)');if(fails)warns.push(fails+' peça(s) não couberam e ficarão fora dos arquivos');
  const text=`Exportar ${items.length} arquivo(s) EPS de ${planLabel()}:\n`+items.map(i=>'• '+i.name+' ('+i.parts+(i.parts===1?' peça, ':' peças, ')+i.sheet.w+'×'+i.sheet.h+' mm)').join('\n')+(warns.length?'\n\nAvisos:\n'+warns.map(w=>'• '+w).join('\n'):'')+'\n\nOs arquivos só são baixados depois de conferidos com o desenho de origem.';
  if(!await ask(text,'Exportar',false))return;
  status('Gerando e conferindo EPS…',false);
  // num arquivo só, o contorno seria um retângulo em volta de todas as chapas: sai
  let R;try{R=await api('/api/eps',{opts:{colors:$('#epsColors').checked,frame:$('#epsFrame').checked&&mode!=='one'},sheets:items.map(i=>({name:i.name,title:planLabel()+' '+i.mat+' '+i.th+'mm',sheet:i.sheet}))})}
  catch(e){status(e.message,true);hist('export.error',{format:'eps',error:e.message});return}
  const log=[];let ok=0;
  R.files.forEach((f,i)=>{const it=items[i],good=f.check.ok;
    if(good){dl(f.name,f.eps,'application/postscript');if(!it.one)S.seq[it.sk]=Math.max(S.seq[it.sk]||0,it.n);ok++}
    log.push({name:f.name,ok:good,issues:f.check.issues,bbox_mm:f.check.bbox_mm,contours:f.check.rings,max_dev_mm:f.check.max_dev_mm,material:it.mat,thickness:it.th,parts:it.parts,sources:it.src})});
  hist('export',{format:'eps',project:{code:p.code,product:p.product,lot:p.lot,order:p.order},pattern:$('#namePat').value,opts:{colors:$('#epsColors').checked,frame:$('#epsFrame').checked},preset:S.activePreset?S.activePreset.name:null,files:log,warnings:warns});
  const bad=log.filter(x=>!x.ok);
  status(bad.length?`${ok} de ${log.length} EPS gerados. Falha em: ${bad.map(b=>b.name+' ('+b.issues.join('; ')+')').join(' | ')}`:`${ok} EPS gerado(s) e conferido(s): medidas e contornos iguais ao desenho.`,!!bad.length);
  flush()}
/* Prévia do nome com o projeto e a chapa da aba aberta (sequência ilustrativa 001). */
function patPreview(){const k=S.tab||Object.keys(S.groups)[0]||'Material · 15 mm',th=String(k.split(' · ')[1]||'').replace(/\s*mm$/,'');
  $('#patPrev').textContent=safeName('01-'+th+'MM-'+planLabel())+'.eps'}

/* ---------- início ---------- */
(async()=>{
  try{
    const d=await api('/api/store');S.store={...S.store,...d};
    S.sets=(d.models||[]).map((s,i)=>({id:String(s.id),name:String(s.name||'Modelo '+(i+1)),color:hexColor(s.color,PALETTE[i%PALETTE.length]),isolate:!!s.isolate,together:!!s.together}));
    const ids=new Set(S.sets.map(s=>s.id));S.forbid=(Array.isArray(d.settings&&d.settings.forbid)?d.settings.forbid:[]).filter(p=>Array.isArray(p)&&ids.has(p[0])&&ids.has(p[1])&&p[0]!==p[1]).map(p=>[p[0],p[1]]);$('#mix').checked=!(d.settings&&d.settings.mix===false);
    sent.meta=JSON.stringify(metaPatch());sent.models=JSON.stringify(S.sets);uniqueColors();
    let migrated=false;
    try{const old=JSON.parse(localStorage.getItem(STORE)||'{}').presets;if(Array.isArray(old)&&old.length&&!S.store.presets.length){S.store.presets=old;migrated=true}}catch(e){}
    S.ready=true;renderPresets();
    if(!Array.isArray(S.store.products))S.store.products=[];
    if(!S.store.projects.some(p=>p.id===MESA)){S.store.projects.push({id:MESA,code:'MESA',product:'Área de encaixe',order:'',lot:'',createdAt:new Date().toISOString(),status:'aberto',notes:''});await flush()}
    await openProject(MESA);renderProducts();
    if(migrated){hist('presets.migrate',{n:S.store.presets.length});autosave()}
    setSaved('dados no servidor','ok');
  }catch(e){setSaved('servidor indisponível: nada será gravado','bad');renderProj()}
})();

/* ---------- interface: navegação, painel e zoom (só aparência; não toca em dados nem no encaixe) ---------- */
const mainEl=$('main'),appEl=$('#app');
function kickView(){mainEl.classList.remove('view-in');void mainEl.offsetWidth;mainEl.classList.add('view-in');clearTimeout(mainEl._vin);mainEl._vin=setTimeout(()=>mainEl.classList.remove('view-in'),280)}
function showView(v,toggle){
  const changed=mainEl.dataset.view!==v;
  const bd=v==='produtos'?$('#prodboard'):v==='pecas'?$('#board'):null;
  if(v==='produtos')renderProducts();
  if(v==='planejamento')renderPlan();
  if(bd&&changed){bd.classList.add('enter');clearTimeout(bd._t);bd._t=setTimeout(()=>bd.classList.remove('enter'),900)}
  if(v==='presets'){prefillPreset();loadNet()}
  if(v==='cnc')renderCnc();
  const same=mainEl.dataset.view===v&&!mainEl.classList.contains('nopanel');
  mainEl.dataset.view=v;mainEl.classList.toggle('nopanel',!!toggle&&same);
  const open=!mainEl.classList.contains('nopanel');
  document.querySelectorAll('.sec[data-view]').forEach(el=>{el.hidden=el.dataset.view!==v});
  document.querySelectorAll('.nav[data-view]').forEach(b=>{const on=open&&b.dataset.view===v;b.classList.toggle('on',on);if(on)b.setAttribute('aria-current','page');else b.removeAttribute('aria-current')});
  $('#panelToggle').setAttribute('aria-expanded',open);
  if(changed)kickView()}
kickView();
$('.rail').addEventListener('click',e=>{const b=e.target.closest('.nav[data-view]');if(b)showView(b.dataset.view,true)});
$('#go').addEventListener('click',()=>{if(['pecas','produtos','planejamento'].includes(mainEl.dataset.view))showView('encaixe')},true);
$('#panelToggle').onclick=()=>showView(mainEl.dataset.view,true);
$('#railToggle').onclick=()=>{const wide=$('.rail').offsetWidth>100;appEl.classList.toggle('rail-min',wide);appEl.classList.toggle('rail-max',!wide);
  $('#railToggle').querySelector('span').textContent=wide?'Expandir menu':'Recolher menu'};
const ZOOMS=[1,1.5,2,3,4,6];let zi=0;
function setZoom(i){zi=Math.max(0,Math.min(ZOOMS.length-1,i));const z=ZOOMS[zi],st=$('#stage');st.style.setProperty('--z',z);st.classList.toggle('zoomed',zi>0);
  $('#zVal').textContent=zi?Math.round(z*100)+'%':'Ajustado';$('#zOut').disabled=$('#zFit').disabled=!zi;$('#zIn').disabled=zi===ZOOMS.length-1}
$('#zIn').onclick=()=>setZoom(zi+1);$('#zOut').onclick=()=>setZoom(zi-1);$('#zFit').onclick=()=>setZoom(0);
setZoom(0);

/* ---------- Usinagem CNC (no estilo Aspire/Alphacam: ferramentas, estratégia e pós-processador) ---------- */
const CAM_POST={name:'NCStudio (mm)',ext:'nc',header:'G90 G17 G21 G40 G49 G80\nG0 Z{SAFEZ}',toolchange:'T{T} M06\nS{RPM} M03',spindle:'S{RPM} M03',footer:'G0 Z{SAFEZ}\nM05\nG0 X{HOMEX} Y{HOMEY}\nM30',comments:false};
const CAM_DEF={machine:{atc:false,zero:'topo',safe:15,over:0.2,rapid:12000,home_x:0,home_y:0},post:CAM_POST,
  tools:[{id:'t1',name:'Fresa reta 6 mm',kind:'fresa',dia:6,num:1,rpm:18000,feed:6000,plunge:1500,step:6,stepover:40,flutes:2},
         {id:'t2',name:'Broca 5 mm',kind:'broca',dia:5,num:2,rpm:12000,feed:2000,plunge:1200,step:20,stepover:40,flutes:2}],
  strategy:{profile_tool:'t1',pocket_tool:'t1',dir:'climb',ramp:40,small_first:true,drill:true,peck:0,tabs:true,tab_cm2:150,tab_count:2,tab_w:6,tab_h:2}};
const CNC={tool:null,group:'',sheet:0,res:null,t:null,run:0};
function camCfg(){const st=S.store.settings;if(!st.cam||typeof st.cam!=='object')st.cam=JSON.parse(JSON.stringify(CAM_DEF));const c=st.cam;
  for(const k of['machine','post','strategy'])c[k]={...CAM_DEF[k],...(c[k]||{})};if(!Array.isArray(c.tools))c.tools=JSON.parse(JSON.stringify(CAM_DEF.tools));return c}
const camGet=(o,path)=>path.split('.').reduce((a,k)=>a==null?a:a[k],o);
function camSet(o,path,v){const ks=path.split('.'),last=ks.pop();ks.reduce((a,k)=>a[k],o)[last]=v}
function camPayloadCfg(){const c=camCfg();return{...c,strategy:{...c.strategy,tab_area:(+c.strategy.tab_cm2||0)*100}}}
function renderCncPanel(){const c=camCfg();
  document.querySelectorAll('.c-tools').forEach(sel=>{sel.innerHTML=c.tools.map(t=>`<option value="${esc(t.id)}">T${esc(t.num)} · ${esc(t.name)}</option>`).join('')});
  document.querySelectorAll('[data-cm]').forEach(el=>{const v=camGet(c,el.dataset.cm);if(el.type==='checkbox')el.checked=!!v;else if(el.hasAttribute('data-bool'))el.value=v?'1':'0';else el.value=v??''});
  if(!c.tools.some(t=>t.id===CNC.tool))CNC.tool=c.tools[0]?.id||null;
  $('#cTools').innerHTML=c.tools.map(t=>`<button type="button" class="tool-item ${t.id===CNC.tool?'on':''}" data-tool="${esc(t.id)}"><b class="tn">T${esc(t.num)}</b><span><b>${esc(t.name)}</b><small>${t.kind==='broca'?'Broca':'Fresa'} Ø${esc(t.dia)} mm · ${esc(t.rpm)} RPM · ${esc(t.feed)} mm/min</small></span></button>`).join('')||'<div class="msg">Nenhuma ferramenta. Crie uma.</div>';
  const t=c.tools.find(x=>x.id===CNC.tool);$('#cToolEd').hidden=!t;$('#cToolDel').disabled=!t||c.tools.length<2;
  if(t){document.querySelectorAll('[data-ct]').forEach(el=>{el.value=t[el.dataset.ct]??''});
    const chip=t.feed/(t.rpm*(t.flutes||2));$('#cChip').textContent=`Carga por dente: ${chip.toFixed(3)} mm (avanço ÷ rotação ÷ cortes). Em MDF, fresas de 6 mm costumam trabalhar entre 0,10 e 0,25 mm.`}}
function camChanged(){autosave();clearTimeout(CNC.t);CNC.t=setTimeout(()=>{if(mainEl.dataset.view==='cnc')camCalc()},500)}
document.addEventListener('change',e=>{const el=e.target.closest('[data-cm]');if(!el)return;const c=camCfg();
  const v=el.type==='checkbox'?el.checked:el.hasAttribute('data-bool')?el.value==='1':el.type==='number'?(el.value===''?0:+el.value):el.value;camSet(c,el.dataset.cm,v);renderCncPanel();camChanged()});
document.addEventListener('change',e=>{const el=e.target.closest('[data-ct]');if(!el)return;const t=camCfg().tools.find(x=>x.id===CNC.tool);if(!t)return;
  t[el.dataset.ct]=el.type==='number'?(el.value===''?0:+el.value):el.value;renderCncPanel();camChanged()});
$('#cTools').addEventListener('click',e=>{const b=e.target.closest('[data-tool]');if(!b)return;CNC.tool=b.dataset.tool;renderCncPanel()});
$('#cToolNew').onclick=()=>{const c=camCfg(),id=nid('t'),num=Math.max(0,...c.tools.map(t=>+t.num||0))+1;c.tools.push({id,name:'Nova fresa',kind:'fresa',dia:6,num,rpm:18000,feed:5000,plunge:1500,step:6,stepover:40,flutes:2});CNC.tool=id;renderCncPanel();camChanged()};
$('#cToolDel').onclick=async()=>{const c=camCfg(),t=c.tools.find(x=>x.id===CNC.tool);if(!t||c.tools.length<2)return;
  if(!await ask('Excluir a ferramenta "'+t.name+'"?','Excluir',true))return;c.tools=c.tools.filter(x=>x!==t);
  for(const k of['profile_tool','pocket_tool'])if(c.strategy[k]===t.id)c.strategy[k]=c.tools[0].id;CNC.tool=c.tools[0].id;renderCncPanel();camChanged()};
$('#cPostReset').onclick=()=>{camCfg().post={...CAM_POST};renderCncPanel();camChanged()};
function camKeys(){return S.res?Object.keys(S.res).filter(k=>S.res[k].sheets.length):[]}
function camSheets(key,only){const g=S.groups[key],p=curProj(),[mat,thTxt]=key.split(' · '),th=parseFloat(thTxt),warns=[];
  const list=S.res[key].sheets.map((sh,i)=>({i,sh})).filter(x=>only==null||x.i===only);
  const q=sheetSeq(),sheets=list.map(({sh,i})=>({name:sheetFile(key,i,q),
    w:g.w,h:g.h,th,parts:sh.placed.map(q=>{const pk=q.it.pk||[];if(pk.length&&q.mi)warns.push(q.it.name+': peça espelhada com rebaixo, o rebaixo sai do outro lado da chapa.');
      const tp=pk.length?tf([q.it.rings[0],...pk.map(x=>x.r)],q.a,q.mi).rings.slice(1):[];
      return{rings:q.rings.map(r=>r.map(([x,y])=>[x+q.x,y+q.y])),pockets:pk.map((x,k)=>({r:tp[k].map(([u,v])=>[u+q.x,v+q.y]),d:x.d,k:x.k}))}})}));
  return{sheets,warns:[...new Set(warns)]}}
function renderCnc(){const keys=camKeys();renderCncPanel();
  if(!keys.includes(CNC.group))CNC.group=keys.includes(S.tab)?S.tab:keys[0]||'';
  $('#cGroup').innerHTML=keys.map(k=>`<option ${k===CNC.group?'selected':''}>${esc(k)}</option>`).join('');
  const n=CNC.group?S.res[CNC.group].sheets.length:0;if(CNC.sheet>=n)CNC.sheet=0;
  $('#cSheet').innerHTML=Array.from({length:n},(_,i)=>`<option value="${i}" ${i===CNC.sheet?'selected':''}>Chapa ${i+1} de ${n}</option>`).join('');
  $('#cCount').textContent=keys.length?keys.reduce((a,k)=>a+S.res[k].sheets.length,0)+' chapa(s)':'';
  [$('#cGroup'),$('#cSheet'),$('#cCalc'),$('#cGen'),$('#cSim')].forEach(el=>{el.disabled=!keys.length});
  if(!keys.length){$('#cPrev').innerHTML='<div class="board-empty"><b>Nada para usinar ainda.</b><span>Encaixe as peças primeiro; as chapas encaixadas aparecem aqui com os caminhos da fresa.</span><button type="button" class="pri" data-goto="encaixe">Ir para Encaixar</button></div>';
    $('#cStats').innerHTML='';$('#cWarn').innerHTML='';$('#cFiles').innerHTML='';$('#cMsg').textContent='';return}
  camCalc()}
async function camCalc(){if(!CNC.group||!S.res||!S.res[CNC.group])return;const run=++CNC.run,{sheets,warns}=camSheets(CNC.group,CNC.sheet);
  $('#cMsg').className='msg';$('#cMsg').textContent='Calculando caminhos…';
  let R;try{R=await api('/api/gcode',{cam:camPayloadCfg(),sheets})}catch(e){if(run!==CNC.run)return;$('#cMsg').className='msg w';$('#cMsg').textContent=e.message;$('#cPrev').innerHTML='';return}
  if(run!==CNC.run)return;const r=R.sheets[0];CNC.res=r;$('#cMsg').textContent='';
  $('#cPrev').innerHTML=camSvg(sheets[0],r.preview);
  const st=r.stats,min=st.minutes,tt=min>=60?Math.floor(min/60)+' h '+Math.round(min%60)+' min':Math.max(1,Math.round(min))+' min';
  $('#cStats').innerHTML=`<div><dt>Tempo estimado</dt><dd>${tt}</dd></div><div><dt>Corte</dt><dd>${st.cut_m.toLocaleString('pt-BR',{maximumFractionDigits:1})} m</dd></div><div><dt>Ferramentas</dt><dd>${st.tools.length}</dd></div><div><dt>Arquivos</dt><dd>${r.files.length}</dd></div>`;
  $('#cWarn').innerHTML=[...warns,...r.warnings].map(w=>`<span>${esc(w)}</span>`).join('');
  $('#cFiles').innerHTML=r.files.map(f=>`<span>${f.tool?esc(f.tool)+': ':''}<code>${esc(f.name)}</code></span>`).join('')}
function camSvg(sh,prev){const W=sh.w,H=sh.h,pad=Math.max(W,H)*0.02,sw=Math.max(W,H)/700;
  const col={externo:'var(--ac)',interno:'var(--alt)',rebaixo:'var(--ok)'};let o='';
  for(const p of sh.parts){for(const r of p.rings)o+=`<path d="M${r.map(q=>q[0].toFixed(1)+' '+q[1].toFixed(1)).join('L')}Z" fill="var(--sf3)" fill-opacity=".55" stroke="none"/>`;
    for(const k of p.pockets||[])o+=`<path d="M${k.r.map(q=>q[0].toFixed(1)+' '+q[1].toFixed(1)).join('L')}Z" fill="var(--ok)" fill-opacity=".12" stroke="none"/>`}
  for(const p of prev){if(p.op==='furo'){const[x,y]=p.pts[0];o+=`<circle cx="${x}" cy="${y}" r="${p.r}" fill="var(--warn)" fill-opacity=".35" stroke="var(--warn)" stroke-width="${sw}"/>`;continue}
    o+=`<path d="M${p.pts.map(q=>q[0]+' '+q[1]).join('L')}Z" fill="none" stroke="${col[p.op]}" stroke-width="${sw*1.4}" stroke-linejoin="round"/>`;
    for(const[a,b]of p.tabs||[]){const m=camAt(p.pts,(a+b)/2);if(m)o+=`<circle cx="${m[0]}" cy="${m[1]}" r="${sw*5}" fill="#f472b6"/>`}}
  return `<svg viewBox="${-pad} ${-pad} ${W+pad*2} ${H+pad*2}" role="img" aria-label="Caminhos da fresa na chapa"><g transform="translate(0 ${H}) scale(1 -1)"><rect x="0" y="0" width="${W}" height="${H}" fill="var(--sheet)" stroke="var(--ln2)" stroke-width="${sw}"/>${o}</g></svg>`}
function camAt(pts,s){let acc=0;for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length],L=Math.hypot(b[0]-a[0],b[1]-a[1]);if(acc+L>=s){const t=L?(s-acc)/L:0;return[a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]}acc+=L}return null}
$('#cGroup').onchange=e=>{CNC.group=e.target.value;CNC.sheet=0;renderCnc()};
$('#cSheet').onchange=e=>{CNC.sheet=+e.target.value;camCalc()};
$('#cCalc').onclick=()=>camCalc();
/* Simulação (sim.js): roda o G-code da chapa escolhida sobre o material, em 2D ou 3D */
const SIM_MAT=k=>/acr[ií]l/i.test(k)?'acr':/acm|alum/i.test(k)?'acm':/compens/i.test(k)?'comp':/preto/i.test(k)?'bpp':/\bbp\b|branco/i.test(k)?'bp':'mdf';
$('#cSim').onclick=async()=>{if(!CNC.res)await camCalc();const r=CNC.res;if(!r){toast('Calcule os caminhos antes de simular.','bad');return}
  const c=camCfg(),g=S.groups[CNC.group],th=parseFloat(CNC.group.split(' · ')[1]);
  c.sim=c.sim||{};const material=c.sim[CNC.group]||{mat:SIM_MAT(CNC.group)};
  try{window.CamSim.open({title:'Simulação · '+CNC.group+' · chapa '+(CNC.sheet+1),sheet:{w:g.w,h:g.h,th},files:r.files,tools:c.tools,zero:c.machine.zero,over:+c.machine.over||0,rapid:+c.machine.rapid||12000,material:{...material},
    onMaterial:m=>{camCfg().sim={...(camCfg().sim||{}),[CNC.group]:m};autosave()}})}
  catch(e){toast(e.message,'bad')}};
$('#cGen').onclick=async()=>{const p=curProj();if(!p){toast('Selecione um projeto.','bad');return}
  if(!S.res||!CNC.group){toast('Encaixe antes de gerar o G-code.','bad');return}
  const{sheets,warns}=camSheets(CNC.group),c=camCfg();
  if(!await ask(`Gerar G-code de ${sheets.length} chapa(s) de ${CNC.group} para ${c.post.name}?\n\nTroca de ferramenta: ${c.machine.atc?'automática (um arquivo por chapa)':'manual (um arquivo por ferramenta)'}.\nZero Z: ${c.machine.zero==='mesa'?'mesa':'topo da chapa'}. Origem no canto inferior esquerdo.`+(warns.length?'\n\nAvisos:\n'+warns.map(w=>'• '+w).join('\n'):'')+'\n\nConfira a simulação no controle da máquina antes de cortar.','Gerar',false))return;
  status('Gerando G-code…',false);
  let R;try{R=await api('/api/gcode',{cam:camPayloadCfg(),sheets})}catch(e){status(e.message,true);hist('export.error',{format:'gcode',error:e.message});return}
  let n=0;for(const s of R.sheets)for(const f of s.files){dl(safeName(f.name),f.gcode,'text/plain');n++}
  hist('export',{format:'gcode',post:c.post.name,group:CNC.group,files:R.sheets.flatMap(s=>s.files.map(f=>f.name)),minutes:R.sheets.reduce((a,s)=>a+s.stats.minutes,0)});
  status(n+' arquivo(s) de G-code gerado(s).',false);toast(n+' arquivo(s) de G-code baixado(s).','ok')};
$('#cPrev').addEventListener('click',e=>{const b=e.target.closest('[data-goto]');if(b)showView(b.dataset.goto)});

/* ---------- Produtos: base de produtos (catálogo) ----------
   Cada produto tem nome e as peças importadas (quantidade, giro, espelhamento, material e espessura),
   gravados em data/product_<id>.json. O índice (nome, contagens) vai no store.json. */
const MESA='mesa';   // área de encaixe interna, até a tela de pedido/OP existir
let IMP_TARGET='project';
const PR={id:null,doc:null,rev:0,sent:'',t:null,mat:''};
const PROD_ROT=[['auto','Giro padrão'],['free','Giro livre 360°'],['90','Giro 90°'],['180','Giro 180° (veio)'],['0','Fixo (veio)']];
const prodIdx=()=>S.store.products||(S.store.products=[]);
const matKey=p=>(String(p.mat||'').trim()||'Sem material')+' · '+p.th+' mm';
/* Cor fixa por material (pelo nome), só para identificar na tela. */
function matColor(p){const k=String(p.mat||'').trim().toLowerCase();let h=0;for(const ch of k)h=(h*31+ch.charCodeAt(0))>>>0;return PALETTE[h%PALETTE.length]}
const initials=t=>String(t||'?').trim().split(/[\s_-]+/).filter(Boolean).map(w=>w[0]).join('').slice(0,2).toUpperCase()||'?';
const prodPayload=()=>({name:PR.doc.name,uid:PR.doc.uid,files:PR.doc.files,parts:PR.doc.parts,createdAt:PR.doc.createdAt});
function prodSyncIdx(){const ix=prodIdx().find(x=>x.id===PR.id);if(!ix)return;const P=PR.doc.parts;
  Object.assign(ix,{name:PR.doc.name,parts:P.length,units:P.reduce((a,p)=>a+p.qty,0),updatedAt:new Date().toISOString()});autosave()}
async function prodSave(){if(!PR.id)return;const id=PR.id,body=JSON.stringify(prodPayload());if(body===PR.sent)return;
  const r=await api('/api/product/'+id,{...prodPayload(),rev:PR.rev});if(id!==PR.id)return;PR.rev=r.rev;PR.sent=body}
function prodChanged(){prodSyncIdx();clearTimeout(PR.t);setSaved('gravando…');PR.t=setTimeout(()=>prodSave().then(()=>setSaved('salvo','ok')).catch(e=>{setSaved('falha ao gravar','bad');toast(e.message,'bad')}),600)}
async function prodFlush(){clearTimeout(PR.t);if(PR.id)await prodSave()}
addEventListener('pagehide',()=>{if(!PR.id)return;const body=JSON.stringify(prodPayload());if(body!==PR.sent)fetch('/api/product/'+PR.id,{method:'POST',keepalive:true,body:JSON.stringify({...prodPayload(),rev:PR.rev})}).catch(()=>{})});
async function openProduct(id){await prodFlush();
  if(!id){PR.id=null;PR.doc=null;renderProducts();return}
  const d=await api('/api/product/'+id);
  PR.id=id;PR.mat='';PR.rev=Number.isInteger(d.rev)?d.rev:0;
  PR.doc={name:String(d.name||(prodIdx().find(x=>x.id===id)||{}).name||'Produto'),uid:Math.max(0,num(d.uid,0)),files:Array.isArray(d.files)?d.files:[],createdAt:d.createdAt||'',
    parts:(Array.isArray(d.parts)?d.parts:[]).map(p=>({...normPart(p),mirror:!!p.mirror,rot:PROD_ROT.some(r=>r[0]===p.rot)?p.rot:'auto',gap:p.gap==null?null:Math.max(0,num(p.gap,0)),mar:p.mar==null?null:Math.max(0,num(p.mar,0))}))};
  PR.sent=JSON.stringify(prodPayload());renderProducts()}
function renderProducts(){const home=!PR.id;$('#prodHome').hidden=!home;$('#prodDetail').hidden=home;
  const L=prodIdx(),dt=v=>{const d=new Date(v);return isNaN(d)?'':d.toLocaleDateString('pt-BR')};
  $('#prodCount').textContent=L.length?L.length+' no total':'';
  if(home){const q=($('#prodFilter').value||'').trim().toLowerCase(),ord=L.filter(p=>!q||String(p.name).toLowerCase().includes(q)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    $('#prodList').innerHTML=ord.map((p,k)=>`<article class="pcard" style="--i:${k}">
      <button type="button" class="pcard-open" data-prod="${esc(p.id)}" aria-label="Abrir produto ${esc(p.name)}"><span class="pcard-mark" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="pcard-txt"><b>${esc(p.name)}</b><span>${esc(p.parts||0)} peça(s) · ${esc(p.units||0)} unidade(s)</span></span></button>
      <div class="pcard-meta">${p.createdAt?`<span>Criado em ${esc(dt(p.createdAt))}</span>`:''}</div>
      <div class="pcard-foot"><span class="pcard-hint">Abrir →</span><button type="button" class="icon pcard-del" data-del-prod="${esc(p.id)}" aria-label="Excluir produto ${esc(p.name)}" title="Excluir produto"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button></div></article>`).join('')
      ||`<div class="board-empty">${L.length?'Nenhum produto com esse nome.':'<b>Nenhum produto ainda.</b>Crie o primeiro e importe as peças dele.<button type="button" class="pri" data-new-prod>Novo produto</button>'}</div>`;
    $('#prodSide').innerHTML=`<div class="msg">${L.length?'Abra um produto para ver e editar as peças.':'Crie um produto para começar a base.'}</div>`;return}
  renderProduct()}
function renderProduct(){const d=PR.doc,P=d.parts,un=P.reduce((a,p)=>a+p.qty,0);
  if(document.activeElement!==$('#prodName'))$('#prodName').value=d.name;
  $('#prodInfo').textContent=P.length+' peça(s) · '+un+' unidade(s)';
  // visualização por material: filtro no topo e um bloco por material · espessura (os dados não mudam)
  const groups=new Map();for(const p of P){const k=matKey(p);if(!groups.has(k))groups.set(k,[]);groups.get(k).push(p)}
  if(PR.mat&&!groups.has(PR.mat))PR.mat='';
  $('#prodMats').innerHTML=groups.size>1?`<button type="button" class="mat-chip" data-mat="" aria-pressed="${!PR.mat}">Todos <small>${esc(P.length)}</small></button>`+[...groups].map(([k,L])=>`<button type="button" class="mat-chip" data-mat="${esc(k)}" aria-pressed="${PR.mat===k}"><span class="mat-dot" style="--mc:${matColor(L[0])}"></span>${esc(k)} <small>${esc(L.length)}</small></button>`).join(''):'';
  const card=(p,k)=>`<article class="ppart" data-pp="${esc(p.id)}" style="--i:${k};--mc:${matColor(p)}">
      <div class="ppart-art"><svg viewBox="-2 ${esc(-p.h-2)} ${esc(p.w+4)} ${esc(p.h+4)}" aria-hidden="true"><path d="${path(p.rings)}" fill="${matColor(p)}" fill-opacity=".85" fill-rule="evenodd"/>${(p.pk||[]).map(k2=>`<path d="${path([k2.r])}" fill="var(--ok)" fill-opacity=".7"/>`).join('')}</svg></div>
      <input class="ppart-name" data-pf="name" value="${esc(p.name)}" maxlength="120" aria-label="Nome da peça">
      <span class="ppart-meta">${esc(Math.round(p.w))} × ${esc(Math.round(p.h))} mm · ${esc(p.mat)} ${esc(p.th)} mm${p.holes?' · '+esc(p.holes)+' furo(s)':''}${(p.pk||[]).length?' · '+esc(p.pk.length)+' rebaixo(s)':''}</span>
      <div class="ppart-ctl"><label class="f">Quantidade<input type="number" min="1" step="1" data-pf="qty" value="${esc(p.qty)}"></label>
        <label class="f">Giro<select data-pf="rot">${PROD_ROT.map(([v,t])=>`<option value="${v}" ${p.rot===v?'selected':''}>${t}</option>`).join('')}</select></label>
        <label class="f">Espaço entre peças (mm)<input type="number" min="0" step="0.5" data-pf="gap" value="${p.gap==null?'':esc(p.gap)}" placeholder="global" title="Espaço entre esta peça e as vizinhas. Vazio = o do encaixe."></label>
        <label class="f">Margem da chapa (mm)<input type="number" min="0" step="0.5" data-pf="mar" value="${p.mar==null?'':esc(p.mar)}" placeholder="global" title="Distância mínima desta peça até a borda da chapa. Vazio = a do encaixe."></label></div>
      <div class="ppart-foot"><label class="f chk" title="Permite que o encaixe use a peça espelhada"><input type="checkbox" data-pf="mirror" ${p.mirror?'checked':''}> Espelhar</label>
        <button type="button" class="icon pcard-del" data-pdel aria-label="Excluir peça ${esc(p.name)}" title="Excluir peça"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button></div></article>`;
  $('#prodParts').innerHTML=[...groups].filter(([k])=>!PR.mat||PR.mat===k).map(([k,L])=>`<section class="pgroup"><header class="pgroup-hd"><span class="mat-dot" style="--mc:${matColor(L[0])}"></span><b>${esc(k)}</b><span>${esc(L.length)} peça(s) · ${esc(L.reduce((a,p)=>a+p.qty,0))} unidade(s)</span></header><div class="ptiles">${L.map(card).join('')}</div></section>`).join('')
    ||'<div class="board-empty"><b>Produto sem peças.</b>Importe os desenhos (DXF, DWG ou SVG) das peças deste produto.<button type="button" class="pri" data-prod-import>Importar peças</button></div>';
  const mats=[...new Set(P.map(p=>p.mat+' · '+p.th+' mm'))];
  $('#prodSide').innerHTML=`<div class="psum"><div class="psum-hd"><span class="pcard-mark" aria-hidden="true">${esc(initials(d.name))}</span><div><b>${esc(d.name)}</b><span>${esc(d.files.length)} arquivo(s) importado(s)</span></div></div>
    <dl class="psum-dl"><div><dt>Peças</dt><dd>${esc(P.length)}</dd></div><div><dt>Unidades</dt><dd>${esc(un)}</dd></div></dl>
    ${mats.length?`<div class="psum-links"><b>Materiais</b>${mats.map(m=>`<span class="tag inf">${esc(m)}</span>`).join('')}</div>`:''}
    <button type="button" class="psum-del" data-del-prod="${esc(PR.id)}"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>Excluir produto</button></div>`}
function prodCommit(use,partial){const d=PR.doc,done=[];
  for(const r of use){const fid=nid('f'),stem=r.name.replace(/\.\w+$/,''),before=d.parts.length,mat=r.mat.trim(),th=r.th;
    for(const p of r.parts){const sig=[Math.round(p.A/4),Math.round(Math.max(p.w,p.h)),Math.round(Math.min(p.w,p.h)),p.holes].join('|');
      const ex=d.parts.find(q=>q.sig===sig&&q.fileId===fid&&q.mat===mat&&q.th===th);if(ex){ex.qty++;continue}
      d.parts.push({...p,id:++d.uid,sig,qty:1,mirror:false,rot:'auto',gap:null,mar:null,mat,th,name:stem+' '+(d.parts.length-before+1),fileId:fid})}
    d.files.push({id:fid,name:r.name,format:r.ext,size:r.size,hash:r.hash,importedAt:new Date().toISOString(),parts:d.parts.length-before,mat,th});
    done.push({name:r.name,parts:d.parts.length-before})}
  hideModal('impModal');IMP=null;IMP_TARGET='project';
  if(!done.length){toast('Nada importado.','bad');return}
  hist('product.import',{id:PR.id,name:d.name,files:done,unread:partial.map(r=>({name:r.name,entities:r.geo}))});
  renderProduct();prodChanged();toast(done.reduce((a,x)=>a+x.parts,0)+' peça(s) importada(s) para '+d.name+'.','ok')}
async function startProdImport(files){files=[...files];if(!files.length||!PR.id)return;
  IMP_TARGET='product';const rows=[];for(const f of files)rows.push(await analyze(f));
  const seen=new Map();rows.forEach(r=>{if(r.hash&&seen.has(r.hash)&&!r.dup){r.dup=seen.get(r.hash)+' (neste lote)';r.include=false}else if(r.hash)seen.set(r.hash,r.name)});
  reviewImport(rows)}
async function newProduct(){await prodFlush();
  let n=1,name='Novo produto';while(prodIdx().some(p=>p.name===name))name='Novo produto '+(++n);
  const id=nid('pr'),now=new Date().toISOString();
  try{await api('/api/product/'+id,{name,uid:0,files:[],parts:[],createdAt:now})}catch(e){toast(e.message,'bad');return}
  prodIdx().push({id,name,parts:0,units:0,createdAt:now});autosave();hist('product.create',{id,name});
  await openProduct(id);const el=$('#prodName');el.focus();el.select()}
async function deleteProduct(id){const p=prodIdx().find(x=>x.id===id);if(!p)return;
  if(!await ask('Excluir o produto "'+p.name+'" ('+(p.parts||0)+' peça(s))?\n\nEle sai da base. O arquivo fica guardado na pasta data/ marcado como excluído e pode ser recuperado depois.','Excluir produto',true))return;
  if(PR.id===id){clearTimeout(PR.t);PR.id=null;PR.doc=null}
  try{await api('/api/product/'+id+'/delete',{})}catch(e){toast(e.message,'bad');return}
  S.store.products=prodIdx().filter(x=>x.id!==id);autosave();hist('product.delete',{id,name:p.name});renderProducts();toast('Produto '+p.name+' excluído.','ok')}
$('#prodNew').onclick=()=>newProduct().catch(e=>toast(e.message,'bad'));
$('#prodFilter').addEventListener('input',renderProducts);
$('#prodBack').onclick=()=>openProduct(null).catch(e=>toast(e.message,'bad'));
$('#prodImport').onclick=()=>$('#prodFile').click();
$('#prodFile').onchange=e=>{const fl=[...e.target.files];e.target.value='';startProdImport(fl).catch(x=>toast(x.message,'bad'))};
$('#prodName').addEventListener('input',e=>{if(!PR.doc)return;PR.doc.name=e.target.value.slice(0,120);prodChanged();$('#prodSide b').textContent=PR.doc.name});
$('#prodName').addEventListener('change',e=>{if(PR.doc&&!PR.doc.name.trim()){PR.doc.name='Produto sem nome';e.target.value=PR.doc.name;prodChanged()}});
$('#prodboard').addEventListener('click',e=>{
  const o=e.target.closest('[data-prod]');if(o){openProduct(o.dataset.prod).catch(x=>toast(x.message,'bad'));return}
  if(e.target.closest('[data-new-prod]')){newProduct();return}
  if(e.target.closest('[data-prod-import]')){$('#prodFile').click();return}
  const mc=e.target.closest('[data-mat]');if(mc){PR.mat=mc.dataset.mat;renderProduct();return}
  const del=e.target.closest('[data-pdel]');if(del&&PR.doc){const id=+del.closest('[data-pp]').dataset.pp,p=PR.doc.parts.find(x=>x.id===id);if(!p)return;
    ask('Excluir a peça "'+p.name+'" deste produto?','Excluir',true).then(ok=>{if(!ok)return;PR.doc.parts=PR.doc.parts.filter(x=>x!==p);renderProduct();prodChanged()})}});
$('#prodParts').addEventListener('change',e=>{const el=e.target.closest('[data-pf]');if(!el||!PR.doc)return;const p=PR.doc.parts.find(x=>x.id===+el.closest('[data-pp]').dataset.pp);if(!p)return;
  const f=el.dataset.pf;if(f==='qty')p.qty=Math.max(1,Math.round(+el.value||1));else if(f==='mirror')p.mirror=el.checked;else if(f==='rot')p.rot=el.value;else if(f==='name')p.name=el.value.trim().slice(0,120)||p.name;
  else if(f==='gap'||f==='mar')p[f]=el.value.trim()===''?null:Math.max(0,Math.min(500,+el.value||0));   // vazio = valor global do encaixe
  renderProduct();prodChanged()});
document.addEventListener('click',e=>{const b=e.target.closest('[data-del-prod]');if(b)deleteProduct(b.dataset.delProd).catch(x=>toast(x.message,'bad'))});

/* ---------- Planejamento: banco de planejamentos (produtos × quantidade) ----------
   store.json "plans": [{id, name, createdAt, sentAt, items:[{id, qty}]}]. Enviar troca as peças da área de
   encaixe pelas dos produtos, cada peça com quantidade = quantidade da peça × unidades do produto. */
const PL={id:null};
const plans=()=>{const st=S.store;if(!Array.isArray(st.plans))st.plans=[];
  if(Array.isArray(st.settings.plan)){if(st.settings.plan.length)st.plans.push({id:nid('pl'),name:'Planejamento 1',createdAt:new Date().toISOString(),items:st.settings.plan});delete st.settings.plan;autosave()}   // plano único antigo
  return st.plans};
const curPlan=()=>plans().find(p=>p.id===PL.id)||null;
const planItems=pl=>{pl.items=(pl.items||[]).filter(r=>r&&prodIdx().some(p=>p.id===r.id));
  // cada produto tem uma cor que não se repete no mesmo planejamento (vira a cor das peças no encaixe)
  const used=new Set();for(const r of pl.items){const c=hexColor(r.color,'');if(!c||used.has(c.toLowerCase()))r.color=freeColor(used);else r.color=c;used.add(r.color.toLowerCase())}
  return pl.items};
function freeColor(used){const c=PALETTE.find(x=>!used.has(x.toLowerCase()));if(c)return c;
  for(let k=0;;k++){const h=(k*137.508)%360,v=hslHex(h,70,60);if(!used.has(v))return v}}
function hslHex(h,s,l){s/=100;l/=100;const f=n=>{const k=(n+h/30)%12,c=l-s*Math.min(l,1-l)*Math.max(-1,Math.min(k-3,9-k,1));return Math.round(c*255).toString(16).padStart(2,'0')};return '#'+f(0)+f(8)+f(4)}
const planUnits=pl=>planItems(pl).reduce((a,r)=>a+((prodIdx().find(x=>x.id===r.id)||{}).units||0)*r.qty,0);
function renderPlan(){const pl=curPlan();$('#planHome').hidden=!!pl;$('#planDetail').hidden=!pl;
  const dt=v=>{const d=new Date(v);return isNaN(d)?'':d.toLocaleDateString('pt-BR')};
  if(!pl){const L=plans(),q=($('#planSearch').value||'').trim().toLowerCase();
    $('#planCount').textContent=L.length?L.length+' no total':'';
    $('#planCards').innerHTML=L.filter(p=>!q||String(p.name).toLowerCase().includes(q)).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).map((p,k)=>`<article class="pcard" style="--i:${k}">
      <button type="button" class="pcard-open" data-plan="${esc(p.id)}" aria-label="Abrir planejamento ${esc(p.name)}"><span class="pcard-mark" aria-hidden="true">${esc(initials(p.name))}</span>
        <span class="pcard-txt"><b>${esc(p.name)}</b><span>${esc(planItems(p).length)} produto(s) · ${esc(planUnits(p))} peça(s)</span></span></button>
      <div class="pcard-meta">${p.createdAt?`<span>Criado em ${esc(dt(p.createdAt))}</span>`:''}${p.sentAt?`<span>Enviado ao encaixe em ${esc(dt(p.sentAt))}</span>`:''}</div>
      <div class="pcard-foot"><span class="pcard-hint">Abrir →</span><button type="button" class="icon pcard-del" data-del-plan="${esc(p.id)}" aria-label="Excluir planejamento ${esc(p.name)}" title="Excluir planejamento"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button></div></article>`).join('')
      ||`<div class="board-empty">${L.length?'Nenhum planejamento com esse nome.':'<b>Nenhum planejamento ainda.</b>Crie um e escolha os produtos e quantidades.<button type="button" class="pri" data-new-plan>Novo planejamento</button>'}</div>`;
    $('#planSide').innerHTML=`<div class="msg">${L.length?'Abra um planejamento para editar e enviar ao encaixe.':'Crie um planejamento para começar.'}</div>`;return}
  const L=planItems(pl),P=prodIdx(),q=($('#planFilter').value||'').trim().toLowerCase();
  if(document.activeElement!==$('#planName'))$('#planName').value=pl.name;
  $('#planCat').innerHTML=P.filter(p=>!q||String(p.name).toLowerCase().includes(q)).sort((a,b)=>String(a.name).localeCompare(String(b.name),'pt-BR')).map(p=>{const inPlan=L.some(r=>r.id===p.id);
    return `<div class="plan-item${inPlan?' in':''}"><span class="pcard-mark" aria-hidden="true">${esc(initials(p.name))}</span><span><b>${esc(p.name)}</b><small>${esc(p.parts||0)} peça(s) · ${esc(p.units||0)} unidade(s) por produto</small></span>
      <button type="button" data-plan-add="${esc(p.id)}" ${inPlan?'disabled':''}>${inPlan?'Adicionado':'Adicionar'}</button></div>`}).join('')
    ||`<div class="msg">${P.length?'Nenhum produto com esse nome.':'Nenhum produto na base. Crie em Produtos.'}</div>`;
  $('#planSeq').checked=pl.seq!==false;$('#planNear').checked=pl.near!==false;
  $('#planRows').innerHTML=L.map((r,k)=>{const p=P.find(x=>x.id===r.id);return `<div class="plan-item plan-row" data-plan-row="${esc(r.id)}"><span class="plan-ord"><button type="button" data-plan-mv="-1" ${k?'':'disabled'} aria-label="Subir ${esc(p.name)}">▲</button><b>${k+1}</b><button type="button" data-plan-mv="1" ${k<L.length-1?'':'disabled'} aria-label="Descer ${esc(p.name)}">▼</button></span><span class="pcard-mark" aria-hidden="true" style="background:${esc(r.color)};color:#04121c">${esc(initials(p.name))}</span>
      <span><b>${esc(p.name)}</b><small>${esc((p.units||0)*r.qty)} peça(s) no encaixe</small></span>
      <input type="color" value="${esc(r.color)}" data-plan-color aria-label="Cor de ${esc(p.name)}" title="Cor das peças deste produto no encaixe">
      <label class="f"><input type="number" min="1" step="1" value="${esc(r.qty)}" data-plan-qty aria-label="Quantidade de ${esc(p.name)}"></label>
      <button type="button" class="icon pcard-del" data-plan-del aria-label="Tirar ${esc(p.name)} do planejamento" title="Tirar do planejamento"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg></button></div>`}).join('')
    ||'<div class="board-empty"><b>Planejamento vazio.</b>Adicione produtos da lista ao lado.</div>';
  const units=planUnits(pl),prods=L.reduce((a,r)=>a+r.qty,0);
  $('#planInfo').textContent=L.length+' produto(s) · '+units+' peça(s)';
  [$('#planSend'),$('#planClear')].forEach(b=>{b.disabled=!L.length});
  $('#planSide').innerHTML=`<div class="psum"><div class="psum-hd"><span class="pcard-mark" aria-hidden="true">${esc(initials(pl.name))}</span><div><b>${esc(pl.name)}</b><span>${pl.sentAt?'Enviado ao encaixe em '+esc(dt(pl.sentAt)):'Ainda não enviado'}</span></div></div>
    <dl class="psum-dl"><div><dt>Produtos</dt><dd>${esc(L.length)}</dd></div><div><dt>Unidades de produto</dt><dd>${esc(prods)}</dd></div><div><dt>Peças no encaixe</dt><dd>${esc(units)}</dd></div></dl>
    ${pl.nestAt?`<div class="plan-saved"><b>Encaixe salvo</b><span>${esc(whenLabel(pl.nestAt))} · ${esc(pl.nestSheets||0)} chapa(s)</span>${pl.nestDef?`<small class="plan-def">${esc(pl.nestDef)}</small>`:''}<button type="button" data-plan-open>Abrir encaixe salvo</button></div>`:''}
    <button type="button" class="pri" data-plan-send ${L.length?'':'disabled'}>Enviar para o encaixe</button>
    <div class="msg">Enviar troca as peças da área de encaixe pelas deste planejamento. Depois, em Encaixar, confira chapa, espaço, margem, rotação e tempo.</div>
    <button type="button" class="psum-del" data-del-plan="${esc(pl.id)}"><svg class="ic" aria-hidden="true"><use href="#i-trash"/></svg>Excluir planejamento</button></div>`}
function planSave(){autosave();renderPlan()}
function newPlan(){let n=plans().length+1,name='PLANEJAMENTO-'+n;while(plans().some(p=>p.name===name))name='PLANEJAMENTO-'+(++n);
  const p={id:nid('pl'),name,createdAt:new Date().toISOString(),items:[]};plans().push(p);PL.id=p.id;hist('plan.create',{id:p.id,name});planSave();
  const el=$('#planName');el.focus();el.select()}
async function deletePlan(id){const p=plans().find(x=>x.id===id);if(!p)return;
  if(!await ask('Excluir o planejamento "'+p.name+'" ('+planItems(p).length+' produto(s))?\n\nOs produtos continuam na base; só o planejamento sai.','Excluir planejamento',true))return;
  S.store.plans=plans().filter(x=>x!==p);if(PL.id===id)PL.id=null;hist('plan.delete',{id,name:p.name});planSave();toast('Planejamento '+p.name+' excluído.','ok')}
$('#planNew').onclick=newPlan;
$('#planSearch').addEventListener('input',renderPlan);
$('#planFilter').addEventListener('input',renderPlan);
$('#planBack').onclick=()=>{PL.id=null;renderPlan()};
$('#planName').addEventListener('input',e=>{const pl=curPlan();if(!pl)return;pl.name=e.target.value.slice(0,120);autosave();const b=$('#planSide .psum-hd b');if(b)b.textContent=pl.name});
$('#planName').addEventListener('change',e=>{const pl=curPlan();if(pl&&!pl.name.trim()){pl.name='Planejamento sem nome';e.target.value=pl.name;planSave()}});
$('#planboard').addEventListener('click',e=>{
  const o=e.target.closest('[data-plan]');if(o){PL.id=o.dataset.plan;renderPlan();return}
  if(e.target.closest('[data-new-plan]')){newPlan();return}
  const pl=curPlan();if(!pl)return;
  const add=e.target.closest('[data-plan-add]');if(add){const it=planItems(pl);it.push({id:add.dataset.planAdd,qty:1,color:freeColor(new Set(it.map(r=>r.color.toLowerCase())))});planSave();return}
  const del=e.target.closest('[data-plan-del]');if(del){const id=del.closest('[data-plan-row]').dataset.planRow;pl.items=planItems(pl).filter(r=>r.id!==id);planSave();return}
  const mv=e.target.closest('[data-plan-mv]');if(mv){const it=planItems(pl),i=it.findIndex(r=>r.id===mv.closest('[data-plan-row]').dataset.planRow),j=i+(+mv.dataset.planMv);
    if(i>=0&&j>=0&&j<it.length){[it[i],it[j]]=[it[j],it[i]];planSave()}}});
function planOpt(k,v){const pl=curPlan();if(!pl)return;pl[k]=v;const mesa=curProj();if(mesa&&mesa.plan===pl.id)mesa[k]=v;planSave()}
$('#planSeq').onchange=e=>planOpt('seq',e.target.checked);
$('#planNear').onchange=e=>planOpt('near',e.target.checked);
$('#planRows').addEventListener('change',e=>{const pl=curPlan(),cl=e.target.closest('[data-plan-color]');if(cl&&pl){const r=planItems(pl).find(x=>x.id===cl.closest('[data-plan-row]').dataset.planRow);if(!r)return;
    const c=cl.value.toLowerCase(),dup=planItems(pl).find(x=>x!==r&&x.color.toLowerCase()===c);
    if(dup){toast('Esta cor já é de '+((prodIdx().find(p=>p.id===dup.id)||{}).name||'outro produto')+' neste planejamento. Escolha outra.','bad');cl.value=r.color;return}
    r.color=cl.value;planSave();return}
  const el=e.target.closest('[data-plan-qty]');if(!el||!pl)return;const r=planItems(pl).find(x=>x.id===el.closest('[data-plan-row]').dataset.planRow);if(!r)return;
  r.qty=Math.max(1,Math.min(100000,Math.round(+el.value||1)));planSave()});
$('#planClear').onclick=async()=>{const pl=curPlan();if(pl&&await ask('Tirar todos os produtos de "'+pl.name+'"?','Limpar',true)){pl.items=[];planSave()}};
async function sendPlan(){const pl=curPlan();if(!pl)return;const L=planItems(pl);if(!L.length)return;
  await prodFlush();
  const docs=[];for(const r of L){try{docs.push({r,d:await api('/api/product/'+r.id)})}catch(e){toast('Não foi possível ler o produto: '+e.message,'bad');return}}
  const n=docs.reduce((a,{r,d})=>a+(d.parts||[]).reduce((q,p)=>q+Math.max(1,Math.round(num(p.qty,1)))*r.qty,0),0),old=S.parts.filter(p=>!p.guest).length;
  if(!n){toast('Os produtos deste planejamento não têm peças.','bad');return}
  if(!await ask(`Enviar "${pl.name}" para o encaixe: ${n} peça(s) de ${L.length} produto(s)?`+(old?`\n\nAs ${old} peça(s) que estão hoje na área de encaixe saem e o encaixe calculado é descartado.`:''),'Enviar',!!old))return;
  cancelNest();
  const parts=[];let uid=0;
  for(const[rank,{r,d}]of docs.entries()){const pn=String(d.name||'Produto');
    for(const p0 of d.parts||[]){const p=normPart(p0);
      parts.push({...p,id:++uid,qty:p.qty*r.qty,on:true,mirror:!!p0.mirror,rot:PROD_ROT.some(x=>x[0]===p0.rot)?p0.rot:'auto',gap:p0.gap==null?null:Math.max(0,num(p0.gap,0)),mar:p0.mar==null?null:Math.max(0,num(p0.mar,0)),
        name:pn+' · '+p.name,groupId:'',color:r.color,pick:false,fileId:'',projectId:S.projectId,product:r.id,rank})}}
  S.parts=parts;S.uid=uid;S.files=[];S.links=[];S.res=null;S.snap=null;S.pdf=null;S.savedNest=null;
  pl.sentAt=new Date().toISOString();const mesa=curProj();if(mesa){mesa.product=pl.name;mesa.plan=pl.id;mesa.seq=pl.seq!==false;mesa.near=pl.near!==false}   // nome no relatório/exportação; Salvar encaixe grava neste planejamento
  hist('plan.send',{id:pl.id,name:pl.name,products:L.map(r=>({id:r.id,name:(prodIdx().find(p=>p.id===r.id)||{}).name,qty:r.qty})),parts:n});
  render();autosave();showView('encaixe');toast(n+' peça(s) de '+pl.name+' no encaixe. Confira a configuração e clique em Encaixar.','ok')}
$('#planSend').onclick=()=>sendPlan().catch(e=>toast(e.message,'bad'));
document.addEventListener('click',e=>{if(e.target.closest('[data-plan-open]'))openPlanNest().catch(x=>toast(x.message,'bad'));if(e.target.closest('[data-plan-send]'))sendPlan().catch(x=>toast(x.message,'bad'));const d=e.target.closest('[data-del-plan]');if(d)deletePlan(d.dataset.delPlan).catch(x=>toast(x.message,'bad'))});

/* Abre o encaixe salvo do planejamento: peças, chapas e posições voltam para a área de encaixe. */
async function openPlanNest(){const pl=curPlan();if(!pl||!pl.nestAt)return;
  const old=S.parts.filter(p=>!p.guest).length,same=(curProj()||{}).plan===pl.id;
  if(old&&!same&&!await ask('Abrir o encaixe salvo de "'+pl.name+'"? As '+old+' peça(s) da área de encaixe saem.','Abrir',true))return;
  let d;try{d=await api('/api/plan/'+pl.id)}catch(e){toast(e.message,'bad');return}
  if(!d.nest||!Array.isArray(d.parts)){toast('Este planejamento não tem encaixe salvo no servidor.','bad');return}
  cancelNest();
  S.parts=d.parts.map(p=>({...normPart(p),gap:p.gap==null?null:num(p.gap,0),mar:p.mar==null?null:num(p.mar,0),rank:num(p.rank,0)}));S.uid=Math.max(0,num(d.uid,0),...S.parts.map(p=>p.id));
  S.groups={};for(const k in d.groups||{}){const g=d.groups[k]||{};S.groups[k]={w:num(g.w,3000),h:num(g.h,1250)}}
  S.seq=d.seq||{};S.files=[];S.links=[];S.savedNest=d.nest;S.res=null;S.snap=null;S.pdf=null;
  const mesa=curProj();if(mesa){mesa.product=pl.name;mesa.plan=pl.id;mesa.seq=pl.seq!==false;mesa.near=pl.near!==false}
  if(!openSavedNest(false)){render();autosave();return}
  render();autosave();showView('encaixe');showResult();toast('Encaixe de '+pl.name+' aberto.','ok')}
