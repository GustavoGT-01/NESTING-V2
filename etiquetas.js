/* Módulo de etiquetas com QR code (em desenvolvimento: fica fora do instalador e oculto na tela;
   o servidor só o ativa com NEST_ETIQUETAS=1). Usa as funções globais do app.js. */
/* ---------- etiquetas com QR (uma por peça encaixada, na ordem de corte) ---------- */
const MM=72/25.4;
function labelItems(){const q=sheetSeq(),pl=plans().find(p=>p.id===(curProj()||{}).plan),out=[];
  const keys=Object.keys(S.res||{});
  const L=[];keys.forEach(k=>S.res[k].sheets.forEach((sh,i)=>L.push({k,i,nn:q.get(k+'|'+i),sh})));L.sort((a,b)=>String(a.nn).localeCompare(String(b.nn)));
  for(const{k,nn,sh}of L){const placed=[...sh.placed].sort((a,b)=>a.x-b.x||a.y-b.y);
    placed.forEach((p,j)=>{const{prod,piece}=prodPiece(p.it);
      out.push({plan:planLabel(),client:pl&&pl.client||'',op:pl&&pl.op||'',nn,key:k,prod,piece,w:p.it.w,h:p.it.h,idx:j+1,of:placed.length,color:partColor(p.it)})})}
  return out}
function labelsPdf(fmt){const items=labelItems();if(!items.length)throw Error('Encaixe antes de gerar as etiquetas.');
  const t=fmt==='t100',W=t?100*MM:70*MM,H=t?50*MM:37*MM,cols=t?1:3,rows=t?1:8,page=t?[W,H]:[595,842],ox=t?0:(595-cols*W)/2,oy=t?0:(842-rows*H)/2,pages=[];
  const k=H/(37*MM);   // fonte cresce com a etiqueta
  items.forEach((it,n)=>{const slot=n%(cols*rows);if(!slot)pages.push('');const c=slot%cols,r=Math.floor(slot/cols),x0=ox+c*W,y0=page[1]-oy-(r+1)*H,pad=5*k;
    let o='0.85 0.85 0.85 RG 0.3 w '+x0.toFixed(2)+' '+y0.toFixed(2)+' '+W.toFixed(2)+' '+H.toFixed(2)+' re S\n';
    const txt=[it.plan,it.nn,it.prod,it.piece,Math.round(it.w)+'x'+Math.round(it.h),it.idx+'/'+it.of].join('|');
    const M=qrMatrix(txt),qs=H-2*pad,m=qs/(M.length+2);o+='0 0 0 rg\n';
    M.forEach((row,y)=>row.forEach((d,x)=>{if(d)o+=(x0+pad+(x+1)*m).toFixed(2)+' '+(y0+pad+qs-(y+2)*m).toFixed(2)+' '+m.toFixed(3)+' '+m.toFixed(3)+' re\n'}));o+='f\n';
    const tx=x0+pad+qs+4*k,tw=W-(tx-x0)-pad,rgb=hexRgb(it.color);
    o+=rgb.map(v=>v.toFixed(3)).join(' ')+' rg '+tx.toFixed(2)+' '+(y0+H-pad-6*k).toFixed(2)+' '+(5*k).toFixed(2)+' '+(5*k).toFixed(2)+' re f\n0.08 0.08 0.08 rg\n';
    const line=(y,s,size,f,dx=0)=>{o+=T(tx+dx,y0+H-pad-y*k,clipText(s,(tw-dx)*(f==='F2'?0.86:0.95),size*k),size*k,f)};
    line(6,it.prod||it.piece,8.5,'F2',7*k);line(17,it.prod?it.piece:'',8,'F1');line(28,'Chapa '+it.nn+' · '+it.key,7,'F1');
    line(38,Math.round(it.w)+' × '+Math.round(it.h)+' mm · peça '+it.idx+'/'+it.of,7,'F1');
    line(48,it.plan,6.5,'F2');const tail=[it.op&&'OP '+it.op,it.client].filter(Boolean).join(' · ');if(tail)line(57,tail,6.5,'F1');
    pages[pages.length-1]+=o});
  return{bytes:buildPdf(pages,[],page.map(v=>+v.toFixed(2))),n:items.length}}
$('#lblGo').onclick=()=>{try{const fmt=$('#lblFmt').value,{bytes,n}=labelsPdf(fmt);dl(safeName('ETIQUETAS-'+planLabel())+'.pdf',bytes,'application/pdf');hist('export',{format:'etiquetas',fmt,labels:n});status(n+' etiqueta(s) geradas.',false)}catch(e){status(e.message,true)}};

/* QR Code (ISO 18004) para as etiquetas: modo byte (UTF-8), correção M, versões 1 a 10 (até 213 bytes).
   Sem bibliotecas: o app roda offline e o CSP só aceita scripts do próprio servidor. Devolve matriz [y][x] (true = escuro). */
function qrMatrix(text,forceMask){
  const data=[...new TextEncoder().encode(String(text))];
  const ECC=[0,10,16,26,18,24,16,18,22,22,26],BLK=[0,1,1,1,2,2,4,4,4,5,5];
  const raw=v=>{let r=(16*v+128)*v+64;if(v>=2){const n=Math.floor(v/7)+2;r-=(25*n-10)*n-55;if(v>=7)r-=36}return r};
  let ver=1;for(;ver<=10;ver++){const cap=Math.floor(raw(ver)/8)-ECC[ver]*BLK[ver];if(4+(ver<10?8:16)+data.length*8<=cap*8)break}
  if(ver>10)throw Error('Texto longo demais para o QR da etiqueta.');
  const size=ver*4+17,total=Math.floor(raw(ver)/8),eccLen=ECC[ver],nb=BLK[ver],dataCap=total-eccLen*nb;
  // bits: modo byte, quantidade, dados, terminador, enchimento
  const bits=[];const put=(v,n)=>{for(let i=n-1;i>=0;i--)bits.push((v>>>i)&1)};
  put(4,4);put(data.length,ver<10?8:16);data.forEach(b=>put(b,8));
  put(0,Math.min(4,dataCap*8-bits.length));while(bits.length%8)bits.push(0);
  const cw=[];for(let i=0;i<bits.length;i+=8)cw.push(bits.slice(i,i+8).reduce((a,b)=>a<<1|b,0));
  for(let p=0xEC;cw.length<dataCap;p^=0xEC^0x11)cw.push(p);
  // Reed-Solomon em GF(256), polinômio 0x11D
  const mul=(x,y)=>{let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11D);z^=((y>>>i)&1)*x}return z&255};
  const div=[];for(let i=0;i<eccLen-1;i++)div.push(0);div.push(1);
  let root=1;for(let i=0;i<eccLen;i++){for(let j=0;j<div.length;j++){div[j]=mul(div[j],root);if(j+1<div.length)div[j]^=div[j+1]}root=mul(root,2)}
  const rs=d=>{const r=div.map(()=>0);for(const b of d){const f=b^r.shift();r.push(0);div.forEach((c,i)=>{r[i]^=mul(c,f)})}return r};
  const nShort=nb-total%nb,shortLen=Math.floor(total/nb),blocks=[];
  for(let i=0,k=0;i<nb;i++){const dl=shortLen-eccLen+(i<nShort?0:1),d=cw.slice(k,k+dl);k+=dl;const e=rs(d);if(i<nShort)d.push(0);blocks.push(d.concat(e))}
  const all=[];for(let i=0;i<blocks[0].length;i++)blocks.forEach((b,j)=>{if(i!==shortLen-eccLen||j>=nShort)all.push(b[i])});
  // padrões fixos
  const M=[...Array(size)].map(()=>Array(size).fill(false)),F=[...Array(size)].map(()=>Array(size).fill(false));
  const set=(x,y,d)=>{M[y][x]=d;F[y][x]=true};
  for(let i=0;i<size;i++){set(6,i,i%2===0);set(i,6,i%2===0)}
  const finder=(x,y)=>{for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++){const d=Math.max(Math.abs(dx),Math.abs(dy)),xx=x+dx,yy=y+dy;if(xx>=0&&xx<size&&yy>=0&&yy<size)set(xx,yy,d!==2&&d!==4)}};
  finder(3,3);finder(size-4,3);finder(3,size-4);
  if(ver>1){const n=Math.floor(ver/7)+2,step=Math.ceil((ver*4+4)/(n*2-2))*2,pos=[6];for(let p=size-7;pos.length<n;p-=step)pos.splice(1,0,p);
    for(let i=0;i<n;i++)for(let j=0;j<n;j++)if(!((i===0&&j===0)||(i===0&&j===n-1)||(i===n-1&&j===0)))
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)set(pos[i]+dx,pos[j]+dy,Math.max(Math.abs(dx),Math.abs(dy))!==1)}
  const format=mask=>{const d=(0<<3)|mask;let r=d;for(let i=0;i<10;i++)r=(r<<1)^((r>>>9)*0x537);const b=((d<<10)|r)^0x5412,g=i=>((b>>>i)&1)===1;
    for(let i=0;i<=5;i++)set(8,i,g(i));set(8,7,g(6));set(8,8,g(7));set(7,8,g(8));for(let i=9;i<15;i++)set(14-i,8,g(i));
    for(let i=0;i<8;i++)set(size-1-i,8,g(i));for(let i=8;i<15;i++)set(8,size-15+i,g(i));set(8,size-8,true)};
  format(0);
  if(ver>=7){let r=ver;for(let i=0;i<12;i++)r=(r<<1)^((r>>>11)*0x1F25);const b=(ver<<12)|r;
    for(let i=0;i<18;i++){const d=((b>>>i)&1)===1,a=size-11+i%3,c=Math.floor(i/3);set(a,c,d);set(c,a,d)}}
  // dados em zigue-zague
  let k=0;for(let right=size-1;right>=1;right-=2){if(right===6)right=5;
    for(let v=0;v<size;v++)for(let j=0;j<2;j++){const x=right-j,up=((right+1)&2)===0,y=up?size-1-v:v;
      if(!F[y][x]&&k<all.length*8){M[y][x]=((all[k>>>3]>>>(7-(k&7)))&1)===1;k++}}}
  // máscara: a de menor penalidade (regras 1 a 4 da norma)
  const MASK=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,
    (x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
  const apply=m=>{for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(!F[y][x]&&MASK[m](x,y))M[y][x]=!M[y][x]};
  const penalty=()=>{let p=0;const line=get=>{for(let a=0;a<size;a++){let run=1;for(let b=1;b<=size;b++){if(b<size&&get(a,b)===get(a,b-1))run++;else{if(run>=5)p+=run-2;run=1}}
      for(let b=0;b+10<size+1;b++){const s=[...Array(11)].map((_,i)=>b+i<size&&get(a,b+i)?1:0).join('');if(b+11<=size&&(s==='10111010000'||s==='00001011101'))p+=40}}};
    line((a,b)=>M[a][b]);line((a,b)=>M[b][a]);
    for(let y=0;y<size-1;y++)for(let x=0;x<size-1;x++){const c=M[y][x];if(c===M[y][x+1]&&c===M[y+1][x]&&c===M[y+1][x+1])p+=3}
    let dark=0;M.forEach(r=>r.forEach(c=>{if(c)dark++}));p+=Math.floor(Math.abs(dark*20-size*size*10)/(size*size))*10;return p};
  let best=forceMask;
  if(best==null){let bp=Infinity;for(let m=0;m<8;m++){apply(m);format(m);const pn=penalty();if(pn<bp){bp=pn;best=m}apply(m)}}
  apply(best);format(best);
  return M}
