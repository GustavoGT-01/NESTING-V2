const {JSDOM}=require('jsdom'),{spawn,spawnSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
// rodar: NODE_PATH=<pasta com jsdom>/node_modules node tests/e2e_jsdom.js   (PYTHON=... troca o interpretador)
const REPO=path.resolve(__dirname,'..');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'nest-e2e-'));
const PY=process.env.PYTHON||(process.platform==='win32'?'py':'python3');
let PORT=0;
// porta livre escolhida pelo próprio servidor (porta 0); ele imprime a porta na 1a linha
function startServer(){return new Promise((res,rej)=>{
  const code=`import sys;sys.path.insert(0,${JSON.stringify(REPO)});import server;from http.server import ThreadingHTTPServer;s=ThreadingHTTPServer(('127.0.0.1',0),server.Handler);print(s.server_address[1],flush=True);s.serve_forever()`;
  const p=spawn(PY,[...(PY==='py'?['-3']:[]),'-c',code],{env:{...process.env,NEST_DATA:data}});
  let out='';p.stderr.on('data',d=>{if(process.env.E2E_VERBOSE)process.stderr.write(d)});
  p.stdout.on('data',d=>{out+=d;const m=/^(\d+)\s/.exec(out);if(m&&!PORT){PORT=+m[1];res(p)}});
  p.on('exit',c=>rej(new Error('servidor saiu com código '+c)));
  setTimeout(()=>rej(new Error('servidor não subiu em 15 s')),15000).unref();
})}
function killTree(p){if(!p||p.exitCode!==null)return;if(process.platform==='win32')spawnSync('taskkill',['/T','/F','/PID',String(p.pid)]);else p.kill('SIGKILL')}
const dxf=(items)=>{let o='0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n';for(const it of items)o+=it;return o+'0\nENDSEC\n0\nEOF\n'};
const rect=(x,y,w,h)=>`0\nLWPOLYLINE\n8\n0\n90\n4\n70\n1\n10\n${x}\n20\n${y}\n10\n${x+w}\n20\n${y}\n10\n${x+w}\n20\n${y+h}\n10\n${x}\n20\n${y+h}\n`;
const circ=(x,y,r)=>`0\nCIRCLE\n8\n0\n10\n${x}\n20\n${y}\n40\n${r}\n`;
async function boot(){
  const dom=await JSDOM.fromURL('http://127.0.0.1:'+PORT+'/',{runScripts:'dangerously',resources:'usable',pretendToBeVisual:true,beforeParse(w){
    w.fetch=(u,o)=>fetch(new URL(u,'http://127.0.0.1:'+PORT).href,o);
    w.matchMedia=w.matchMedia||(q=>({matches:false,media:q,onchange:null,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){},dispatchEvent(){return false}}));
    w.Element.prototype.scrollIntoView=w.Element.prototype.scrollIntoView||function(){};
    Object.defineProperty(w,'crypto',{value:require('crypto').webcrypto});
    w.File.prototype.arrayBuffer=function(){return new Promise(r=>{const fr=new w.FileReader();fr.onload=()=>r(fr.result);fr.readAsArrayBuffer(this)})};
    w.TextDecoder=TextDecoder;w.URL.createObjectURL=b=>{w.__blobs=(w.__blobs||[]);w.__blobs.push(b);return 'blob:x'};w.URL.revokeObjectURL=()=>{};
    w.HTMLAnchorElement.prototype.click=function(){w.__dl=(w.__dl||[]);w.__dl.push(this.download)};
    w.addEventListener('error',e=>console.log('PAGE ERROR',e.message));
  }});
  await new Promise(r=>setTimeout(r,1200));return dom.window}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)process.exitCode=1};
(async()=>{
  const srv=await startServer();
  try{
    let w=await boot(),$=s=>w.document.querySelector(s);
    ok(!!$('#proj')&&/salvo|servidor/.test($('#saved').textContent),'página carrega e conecta ao servidor: '+$('#saved').textContent);
    // importar sem projeto -> bloqueia
    $('#file').dispatchEvent(Object.assign(new w.Event('change'),{}));
    // criar projeto
    $('#projNew').click();$('#pjCode').value='POLTRONA-A';$('#pjProd').value='Poltrona modelo A';$('#pjLot').value='L123';$('#pjOk').click();await sleep(600);
    ok($('#proj').options.length===1,'projeto criado');
    // importar 2 arquivos (15 mm e 18 mm do mesmo modelo) + duplicado
    const mk=(n,c)=>new w.File([c],n,{type:'text/plain'});
    const f15=mk('Bacio_15mm.dxf',dxf([rect(0,0,300,200),circ(150,100,30)])),f18=mk('Bacio_18mm.dxf',dxf([rect(0,0,300,200),circ(150,100,35)])),dup=mk('Copia.dxf',dxf([rect(0,0,300,200),circ(150,100,30)]));
    const lateral=mk('Lateral.dxf',dxf([rect(0,0,500,80)]));
    await w.startImport([f15,f18,dup,lateral]);await sleep(500);
    ok(!$('#impModal').hidden,'tela de revisão aberta');
    const rows=w.eval('IMP').rows;
    ok(rows[0].th===15&&rows[0].thSrc.includes('nome'),'espessura 15 inferida do nome e marcada como inferida');
    ok(rows[1].th===18,'espessura 18 inferida');
    ok(rows[2].dup&&!rows[2].include,'arquivo idêntico detectado por hash e desmarcado: '+rows[2].dup);
    ok(rows[3].thSrc==='padrão','lateral sem espessura = padrão (pendência)');
    // cria modelo e atribui
    $('#setName').value='Bacio de poltrona';
    w.eval('S').sets.push({id:'mbacio',name:'Bacio de poltrona',color:'#4cc9f0',isolate:false,together:false});
    rows[0].model='mbacio';rows[1].model='mbacio';w.impRender();
    $('#impOk').click();await sleep(300);
    ok(w.eval('S').parts.length===3,'3 peças importadas (duplicado ignorado): '+w.eval('S').parts.length);
    const b15=w.eval('S').parts.find(p=>p.th===15),b18=w.eval('S').parts.find(p=>p.th===18);
    ok(w.partColor(b15)===w.partColor(b18)&&w.partColor(b15)==='#4cc9f0','mesma cor do modelo em 15 mm e 18 mm');
    ok(w.eval('S').parts.find(p=>p.name.startsWith('Lateral')).groupId==='','lateral sem modelo = pendente');
    await w.flush();await sleep(300);
    // encaixar (motor do navegador)
    $('#srv').checked=false;$('#secs').value='10';$('#go').click();
    for(let i=0;i<120&&!/^Pronto/.test($('#nmsg').textContent);i++)await sleep(500);
    ok(!!w.eval('S').res,'encaixe concluído');
    // exportar EPS da aba atual
    const origAsk=w.ask;let askText='';w.ask=async t=>{askText=t;return true};
    console.log('DBG disabled',$('#xeps').disabled,'tab',w.eval('S').tab,'snap',!!w.eval('S').snap,'nmsg',$('#nmsg').textContent);
    $('#xeps').click();await sleep(1500);
    console.log('DBG toast',$('#toast').textContent);console.log(askText.split('\n').slice(0,6).join(' | '));
    ok((w.__dl||[]).some(n=>/POLTRONA-A_.*MM_001\.eps$/.test(n)),'EPS baixado com nome padronizado: '+JSON.stringify(w.__dl));
    const blob=w.__blobs[w.__blobs.length-1],blobText=await new Promise(r=>{const fr=new w.FileReader();fr.onload=()=>r(fr.result);fr.onerror=()=>r('');fr.readAsText(blob)});// o Blob do jsdom não tem .text()
    ok(/^%!PS-Adobe-3.0 EPSF-3.0/.test(blobText||''),'conteúdo EPS válido');
    ok(/pendentes de classificação/.test(askText),'aviso de peças sem modelo na revisão antes de exportar');
    $('#xeps').click();await sleep(1500);
    ok((w.__dl||[]).some(n=>/_002\.eps$/.test(n)),'segunda exportação não repete o nome (sequência 002)');
    await w.flush();await sleep(300);
    await w.flush?.();w.close();
    // reinício: nova página, mesmo servidor/dados
    w=await boot();$=s=>w.document.querySelector(s);
    ok(w.eval('S').projectId&&w.eval('S').parts.length===3,'após reabrir: projeto e 3 peças restaurados');
    ok(w.eval('S').sets.some(s=>s.id==='mbacio'&&s.color==='#4cc9f0'),'cor do modelo persistida após reiniciar');
    const st=JSON.parse(fs.readFileSync(path.join(data,'store.json'),'utf8'));
    ok(!st.history&&!st.exports,'store.json não carrega mais histórico nem exportações');
    const hist=fs.readFileSync(path.join(data,'history.jsonl'),'utf8').trim().split(/\n/).map(JSON.parse);
    const kinds=hist.map(h=>h.kind);
    ok(['project.create','import','export'].every(k=>kinds.includes(k)),'histórico: '+kinds.join(', '));
    const ex=fs.readFileSync(path.join(data,'exports.jsonl'),'utf8').trim().split(/\n/).map(JSON.parse)[0].detail;
    ok(ex.files[0].ok&&ex.files[0].sources.length>0&&ex.project.code==='POLTRONA-A','exportação registrada com origem, projeto e validação');
    // outro projeto fica separado
    $('#projNew').click();$('#pjCode').value='CADEIRA-B';$('#pjProd').value='Cadeira B';$('#pjOk').click();await sleep(800);
    ok(w.eval('S').parts.length===0&&w.eval('S').projectId!==st.projects[0].id,'novo projeto começa vazio (sem mistura)');
    await w.flush?.();w.close();
  }finally{killTree(srv)}
})().catch(e=>{console.log('FAIL erro: '+(e&&e.stack||e));process.exitCode=1});
