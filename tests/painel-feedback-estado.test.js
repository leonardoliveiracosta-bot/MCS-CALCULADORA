'use strict';

// Regression cases from the functional audit. Executes the actual UI functions with a small
// DOM and controlled server replies; no production, customer messaging or browser is used.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const panel=fs.readFileSync(path.join(__dirname,'../painel/painel.js'),'utf8');
const assistant=fs.readFileSync(path.join(__dirname,'../painel/assistente.js'),'utf8');
const action=fs.readFileSync(path.join(__dirname,'../painel/action.js'),'utf8');
function part(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,'source function boundaries');return source.slice(a,b);}
class Node {
  constructor(tag='div',cls='',text=''){this.tagName=tag.toUpperCase();this.className=cls;this.textContent=String(text);this.children=[];this.dataset={};this.attributes={};this.listeners={};this.checked=false;this.disabled=false;this.isConnected=true;this.parentNode=null;
    this.classList={contains:c=>this.className.split(/\s+/).includes(c),toggle:(c,on)=>{const classes=new Set(this.className.split(/\s+/).filter(Boolean));if(on??!classes.has(c))classes.add(c);else classes.delete(c);this.className=[...classes].join(' ');},add:(c)=>this.classList.toggle(c,true),remove:(c)=>this.classList.toggle(c,false)};}
  append(...values){for(const x of values){if(x&&typeof x==='object')x.parentNode=this;this.children.push(x);}}
  replaceChildren(...values){this.children.forEach(x=>{if(x&&typeof x==='object')x.isConnected=false;});this.children=[];this.append(...values);}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.isConnected=false;}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  async click(){for(const fn of this.listeners.click||[])await fn({preventDefault(){},stopPropagation(){}});}
  async change(){for(const fn of this.listeners.change||[])await fn({});}
  querySelectorAll(selector){const found=[];const classes=[...selector.matchAll(/\.([\w-]+)/g)].map(x=>x[1]);const key=/data-action-key="([^"]+)"/.exec(selector)?.[1];const walk=n=>{n.children.forEach(x=>{if(x&&typeof x==='object'){if(classes.every(c=>x.classList.contains(c))&&(!key||x.dataset.actionKey===key)&&(!selector.includes(':checked')||x.checked))found.push(x);walk(x);}});};walk(this);return found;}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(){return this.parentNode;}
}
const el=(...xs)=>new Node(...xs);
const tree=n=>[n.textContent,...n.children.map(x=>x&&typeof x==='object'?tree(x):String(x))].join(' ');
const allButtons=n=>{const out=[];const walk=x=>{if(x.tagName==='BUTTON')out.push(x);x.children.filter(y=>y&&typeof y==='object').forEach(walk);};walk(n);return out;};
const findButton=(n,label)=>allButtons(n).find(x=>x.textContent===label);
const settle=async()=>{await new Promise(setImmediate);await new Promise(setImmediate);};
function queueUpdate(){
  const {action}=actions(),root=el();let fail=false,refreshFail=false,writes=0,reads=0,opened=0,release;
  const ctx={Set,Promise,String,MCSAction:action,element:el,viewRequestVersion:1,currentView:'searches',manheimData:{},WINDOW_LABELS:{NONE:'Sem prazo'},rowSummary:()=>'',demandSummary:()=>'',openOptionsClient:()=>opened++,openQueueDetail:()=>opened++,
    request:async()=>{writes++;if(release)await new Promise(r=>release=r);if(fail)throw Error('503');return {ok:true};},loadCurrent:async()=>{reads++;if(refreshFail)throw Error('503');}};
  vm.createContext(ctx);vm.runInContext(part(panel,'  function renderQueueRow(root, row) {','  // ===== ENVIAR OPÇÕES'),ctx);
  ctx.renderQueueRow(root,{person:{journeyId:'test'},demands:[{key:'test'}],states:[{kind:'pending',demand:{key:'test',mode:'VALOR'}}]});
  const line=root.children[0],button=findButton(root,'Atualizar');
  return {ctx,root,line,button,fail:v=>fail=v,refreshFail:v=>refreshFail=v,writes:()=>writes,reads:()=>reads,opened:()=>opened,hold:()=>release=true,release:()=>{release();release=null;}};
}
test('queue comparison gives progress, rejects duplicate clicks, then reports success without an extra step',async()=>{
  const a=queueUpdate();a.hold();const pending=a.button.click();assert.equal(a.button.disabled,true);assert.equal(a.button.textContent,'Comparando…');await a.button.click();assert.equal(a.writes(),1);a.release();await pending;await settle();
  assert.equal(a.button.disabled,false);assert.equal(a.button.textContent,'Comparado');assert.match(tree(a.root),/Pedido comparado/);assert.equal(a.reads(),1);assert.equal(a.ctx.manheimData,null);assert.equal(a.opened(),0);
});
test('queue comparison failure stays visible and the same button retries successfully',async()=>{
  const a=queueUpdate();a.fail(true);await a.button.click();assert.equal(a.button.disabled,false);assert.equal(a.button.textContent,'Atualizar');assert.match(tree(a.root),/Não consegui comparar este pedido/);assert.equal(a.reads(),0);
  a.fail(false);await a.button.click();await settle();assert.equal(a.writes(),2);assert.equal(a.reads(),1);assert.doesNotMatch(tree(a.root),/Não consegui comparar/);
});
test('queue refresh failure retries only the read; leaving the view does not refresh another page',async()=>{
  const a=queueUpdate();a.refreshFail(true);await a.button.click();await settle();assert.match(tree(a.root),/Não consegui atualizar a lista/);a.refreshFail(false);await findButton(a.root,'Atualizar lista').click();assert.equal(a.writes(),1);assert.equal(a.reads(),2);
  const b=queueUpdate();b.hold();const pending=b.button.click();b.ctx.currentView='v1';b.ctx.viewRequestVersion++;b.release();await pending;await settle();assert.equal(b.reads(),0);
});
test('queue row keyboard opens only the row, without stealing Enter or Space from its buttons',()=>{
  const a=queueUpdate(),handler=a.line.listeners.keydown[0];let prevented=0;
  handler({target:a.button,key:'Enter',preventDefault:()=>prevented++});handler({target:a.button,key:' ',preventDefault:()=>prevented++});assert.equal(a.opened(),0);assert.equal(prevented,0);
  handler({target:a.line,key:'Enter',preventDefault:()=>prevented++});assert.equal(a.opened(),1);assert.equal(prevented,1);
});
function actions(body=el('body')){const ctx={window:{},document:{body,createElement:el},Promise,setTimeout:()=>0,clearTimeout(){}};vm.createContext(ctx);vm.runInContext(action,ctx);return {body,action:ctx.window.MCSAction};}
function requests(response){const logs=[];const ctx={AbortController,Date,Number,String,Error,Object,Array,Promise,Set,Map,setTimeout:()=>0,clearTimeout(){},window:{MCSAssistantLog:{request:x=>logs.push(x)}},DEFAULT_TIMEOUT_MS:1000,accessToken:null,refreshToken:null,fetch:async()=>response,CRITERIA_WRITES:/actions/,scheduleOptionsSync(){}};vm.createContext(ctx);vm.runInContext(part(panel,'  const request = async (path, options = {}) => {','  const CRITERIA_WRITES =')+'\nthis.request=request;',ctx);return {ctx,logs};}

test('valid response stays direct; malformed JSON, null and arrays never become empty success',async()=>{
  const valid={ok:true,status:200,json:async()=>({items:[],counts:{total:0}})};
  const {ctx}=requests(valid);assert.equal((await ctx.request('/api/panel/records')).counts.total,0);
  for(const reply of [async()=>{throw new SyntaxError('not JSON');},async()=>null,async()=>[],async()=>0]){
    const {ctx,logs}=requests({ok:true,status:200,json:reply});
    await assert.rejects(ctx.request('/api/panel/records'),e=>e.code==='RESPONSE_INVALID');assert.equal(logs.at(-1).code,'RESPONSE_INVALID');
  }
});
test('HTTP and network failures keep their error codes even with an unreadable error body',async()=>{
  const {ctx}=requests({ok:false,status:503,json:async()=>{throw Error('html');}});
  await assert.rejects(ctx.request('/api/panel/records'),e=>e.code==='SERVER_ERROR'&&e.status===503);
  ctx.fetch=async()=>{throw Error('offline');};await assert.rejects(ctx.request('/api/panel/records'),e=>e.code==='NETWORK_ERROR');
  ctx.fetch=async()=>({ok:false,status:503,json:async()=>null});await assert.rejects(ctx.request('/api/panel/records'),e=>e.code==='SERVER_ERROR');
  const controller=new AbortController();ctx.fetch=async()=>({ok:true,status:200,json:async()=>{controller.abort();throw Error('abort');}});
  await assert.rejects(ctx.request('/api/panel/records',{signal:controller.signal}),e=>e.code==='REQUEST_ABORTED');
});
test('funnel accepts confirmed zero but refuses an incomplete object before replacing the list',()=>{
  const roots={'v1-list':el(),'v2-list':el()},counts={};
  const ctx={Number,Date,Array,Error,Object,$:k=>roots[k],element:el,setCount:(k,v)=>counts[k]=v,v1FunnelData:null,v1ClientGroups:x=>x,expiredDetails:()=>null};
  vm.createContext(ctx);vm.runInContext(part(panel,'  function funnelZone(title,list,emptyText){','  // Without a linked request')+part(panel,'  function renderVitrineFunnel(data,view){','  function relativeAuction'),ctx);
  const zero={counts:{v1Action:0,v2Action:0},v1:{tapped:[]},v2:{bid:[],waiting:[],expired:[]}};
  ctx.renderVitrineFunnel(zero,'v1');ctx.renderVitrineFunnel(zero,'v2');assert.deepEqual(counts,{v1:0,v2:0});
  const old=tree(roots['v1-list']);assert.throws(()=>ctx.renderVitrineFunnel({},'v1'),e=>e.code==='RESPONSE_INVALID');assert.equal(tree(roots['v1-list']),old);
});

function attend(){
  const nodes={'today-list':el(),'today-stats':el(),'today-sort':{value:'ready'}};
  const entries=Array.from({length:644},(_,i)=>({key:'case:'+i,item:null,bucket:'depende',decisions:[]}));let query='',badge='—';
  const ctx={Date,Set,Map,Math,String,Number,Promise,document:{querySelectorAll:()=>[],createElement:el},$:k=>nodes[k],element:el,
    stageDecisionRows(){},todayItems:[],attendData:{entry:{},triage:{},whatsapp:{},incompleteFailed:false},attendModel:()=>({cases:entries,counts:{todos:entries.length,fora:0}}),setCount:(_,n)=>badge=String(n),setCountUnknown:()=>badge='—',loadAttendIdentities(){},todayRefFilter:'all',todayStatFilter:null,attendBucket:'todos',caseFacts:()=>({known:true,refState:'COM_REF'}),MCSAttend:{countsOf:()=>({}),inBucket:()=>true},v1JourneySet:new Set(),v1TodayCount:0,attendQuery:()=>query,attendMatches:(e,q)=>e.key===q,syncAttendStamp(){},MCSCompleting:{insert:a=>a},attendIdentity:new Map(),attendPageKey:'',attendLimit:30,ATTEND_PAGE:30,hydrateContexts(){},MCSContactGroups:{hydrateTranslations:()=>Promise.resolve()},request(){},loadCurrent(){},viewRequestVersion:0};
  vm.createContext(ctx);vm.runInContext('const attendPicked=new Set();this.picked=attendPicked;'+part(panel,'  function bulkBar() {','  // One "⋯ Mais"')+part(panel,'  function renderToday(items, preserveAll=false) {','  // One demand = one person'),ctx);
  ctx.document.querySelector=s=>nodes['today-list'].querySelector(s);
  ctx.document.querySelectorAll=s=>s.startsWith('#today-list ')?nodes['today-list'].querySelectorAll(s.slice(12)):[];
  ctx.attendRow=e=>{const row=el('article','case-card');row.dataset.caseKey=e.key;row.append(ctx.pickBox(row));return row;};
  ctx.renderToday([]);
  const grid=()=>nodes['today-list'].querySelector('.attend-list');
  return {ctx,nodes,entries,grid,badge:()=>badge,query:q=>query=q,checkbox:()=>grid().children[0].querySelector('.case-pick-box')};
}
test('selection survives redraw and filters; clear selection and removed cases do not linger',async()=>{
  const a=attend();let box=a.checkbox();box.checked=true;await box.change();
  a.ctx.renderToday([],true);assert.equal(a.checkbox().checked,true);assert.equal(a.grid().children[0].classList.contains('case-picked'),true);
  a.query('case:643');a.ctx.renderToday([],true);assert.equal(a.grid().children.length,1);assert.equal(a.ctx.picked.size,1);
  await findButton(a.nodes['today-list'],'Limpar seleção').click();a.query('');a.ctx.renderToday([],true);assert.equal(a.checkbox().checked,false);
  box=a.checkbox();box.checked=true;await box.change();a.entries.shift();a.ctx.renderToday([],true);assert.equal(a.ctx.picked.size,0);assert.equal(a.checkbox().checked,false);
});
test('644 cases load incrementally and keep loaded quantity; current sources confirm the badge',async()=>{
  const a=attend();assert.equal(a.badge(),'644');assert.equal(a.grid().children.length,30);
  await a.nodes['today-list'].querySelector('.attend-more-button').click();assert.equal(a.grid().children.length,60);
  a.ctx.renderToday([],true);assert.equal(a.grid().children.length,60);
  for(let i=0;i<20;i++)await a.nodes['today-list'].querySelector('.attend-more-button').click();assert.equal(a.grid().children.length,644);
  a.ctx.attendData.triage=null;a.ctx.renderToday([],true);assert.equal(a.badge(),'—');
  a.ctx.attendData.triage={};a.ctx.attendData.incompleteFailed=true;a.ctx.renderToday([],true);assert.equal(a.badge(),'—');
});
test('an incomplete source cannot erase a selection until a complete refresh confirms removal',async()=>{
  const a=attend();const box=a.checkbox();box.checked=true;await box.change();a.ctx.attendData.triage=null;a.entries.shift();a.ctx.renderToday([],true);assert.equal(a.ctx.picked.size,1);
  a.ctx.attendData.triage={};a.ctx.renderToday([],true);assert.equal(a.ctx.picked.size,0);
});
test('automatic refresh restores scroll only if the operator stayed in the same view',async()=>{
  let release;const moves=[];const ctx={window:{scrollY:350,scrollTo:(x,y)=>moves.push([x,y])},currentView:'today',viewRequestVersion:1,loadCurrent:()=>new Promise(r=>release=r),requestAnimationFrame:f=>f()};
  vm.createContext(ctx);vm.runInContext(part(panel,'  async function refreshCurrentPreservingState() {','  function captureOrigin()'),ctx);
  let pending=ctx.refreshCurrentPreservingState();release();await pending;assert.deepEqual(moves,[[0,350]]);
  pending=ctx.refreshCurrentPreservingState();ctx.currentView='v1';ctx.viewRequestVersion++;release();await pending;assert.equal(moves.length,1);
  assert.match(panel,/run: async \(\) => \{ await refreshCurrentPreservingState\(\)/);
});
test('saved action warns about refresh failure, keeps undo and retries only the read',async()=>{
  const {body,action}=actions();let writes=0,reads=0,rollback=0,fail=true,undone=0;
  const out=await action.run({button:el('button'),scope:body,successText:'Salvo',commit:async()=>{writes++;return {saved:true};},rollback:()=>rollback++,refresh:async()=>{reads++;if(fail)throw Error('503');},undo:{commit:async()=>undone++}});
  await settle();assert.equal(out.ok,true);assert.equal(writes,1);assert.equal(rollback,0);assert.match(tree(body),/Salvo.*Não consegui atualizar/);
  assert.ok(findButton(body,'Desfazer'));fail=false;await findButton(body,'Atualizar lista').click();
  assert.equal(reads,2);assert.equal(writes,1);assert.doesNotMatch(tree(body),/Não consegui atualizar/);await findButton(body,'Desfazer').click();assert.equal(undone,1);
});
test('normal save and refresh do not add a warning or an extra step',async()=>{
  const {body,action}=actions();let reads=0;
  const result=await action.run({button:el('button'),scope:body,successText:'Salvo',commit:async()=>({}),refresh:async()=>reads++});await settle();
  assert.equal(result.ok,true);assert.equal(reads,1);assert.equal(tree(body).trim(),'Salvo');assert.equal(allButtons(body).length,0);
});

test('failed client page preserves existing rows, offers retry and clears the error after retry',async()=>{
  const {action}=actions(),root=el(),old=el('article','client-card','Cliente já carregado');old.dataset.journeyId='old';root.append(old);
  let fail=true,reads=0,disconnected=0;
  const ctx={Set,Map,String,Promise,element:el,MCSAction:action,$:()=>root,clientsVersion:1,clientsPagesLoaded:1,clientsRestoring:false,clientsOpen:()=>true,clientsQuery:()=>'/clients',clientsHiddenInTodos:0,clientsHiddenBy:new Map(),clientsObserver:{disconnect:()=>disconnected++},todosJourneyIds:()=>new Set(),refreshClientCounts(){},request:async()=>{reads++;if(fail)throw Error('503');return {items:[],total:644,page:2,pageSize:50,hasMore:false};}};
  vm.createContext(ctx);vm.runInContext(part(panel,'  function appendClients(root,data){','  function renderClients(data){')+part(panel,'  async function loadClientsPage(page){','  // Old conversations'),ctx);
  ctx.appendClients(root,{items:[],total:644,page:1,pageSize:50,hasMore:true});await findButton(root,'Mostrar mais (594 restantes)').click();await settle();
  assert.equal(old.isConnected,true);assert.match(tree(root),/Não consegui carregar mais clientes/);assert.ok(disconnected>0);fail=false;
  await findButton(root,'Tentar novamente').click();await settle();assert.equal(reads,2);assert.equal(old.isConnected,true);assert.doesNotMatch(tree(root),/Não consegui carregar mais clientes/);
});

function incidents(){
  const root=el(),{body,action}=actions();let fail=false;
  const rows=Array.from({length:121},(_,i)=>({id:String(i),status:i===120?'CORRIGIDO':'ABERTO',severity:'P1',count:1}));const writes=[];
  const ctx={document:{body,getElementById:()=>root},bridge:()=>({request:async()=>{if(fail)throw Error('offline');return {incidents:rows.map(x=>({...x}))};}}),api:async b=>{if(fail)throw Error('offline');writes.push(b);rows.find(x=>x.id===b.id).status=b.status;return {ok:true};},MCSAction:action,el,incidentLine:i=>i.id,fmtDate:()=>'',setTimeout:()=>0};
  vm.createContext(ctx);vm.runInContext(part(assistant,"  let incidentsFilter = 'open'",'  window.MCSAssistant ='),ctx);
  return {ctx,root,body,rows,writes,fail:x=>fail=x};
}
test('incidents show all pages, retain page length on refresh and keep closed items out of the open queue',async()=>{
  const a=incidents();await a.ctx.renderIncidents();assert.equal(a.root.querySelectorAll('.assistant-incident').length,50);
  await findButton(a.root,'Mostrar mais (70 restantes)').click();await settle();assert.equal(a.root.querySelectorAll('.assistant-incident').length,100);
  await a.ctx.renderIncidents();assert.equal(a.root.querySelectorAll('.assistant-incident').length,100);
  await findButton(a.root,'Mostrar mais (20 restantes)').click();await settle();assert.equal(a.root.querySelectorAll('.assistant-incident').length,120);
  await findButton(a.root,'Encerrados').click();await settle();assert.equal(a.root.querySelectorAll('.assistant-incident').length,1);assert.ok(findButton(a.root,'Reabrir'));
});
test('incident can be closed, undone and reopened; a failed write remains actionable',async()=>{
  const a=incidents();await a.ctx.renderIncidents();await findButton(a.root,'Marcar como corrigido').click();await settle();
  assert.equal(a.rows[0].status,'CORRIGIDO');assert.equal(a.writes[0].action,'incident_status');assert.match(tree(a.body),/Chamado encerrado/);
  await findButton(a.body,'Desfazer').click();await settle();assert.equal(a.rows[0].status,'ABERTO');
  await findButton(a.root,'Encerrar sem defeito').click();await settle();assert.equal(a.rows[0].status,'NAO_ERA_DEFEITO');
  await findButton(a.root,'Encerrados').click();await settle();await findButton(a.root,'Reabrir').click();await settle();assert.equal(a.rows[0].status,'ABERTO');
  await findButton(a.root,'Abertos').click();await settle();a.fail(true);const close=findButton(a.root,'Marcar como corrigido');await close.click();await settle();
  assert.equal(close.disabled,false);assert.match(tree(a.root),/Não consegui salvar/);assert.equal(a.rows[0].status,'ABERTO');
});
test('incident load failure offers retry rather than reporting no open cases',async()=>{
  const a=incidents();a.fail(true);await a.ctx.renderIncidents();assert.match(tree(a.root),/Não consegui carregar/);assert.doesNotMatch(tree(a.root),/Nenhum chamado aberto/);
  a.fail(false);await findButton(a.root,'Tentar novamente').click();assert.equal(a.root.querySelectorAll('.assistant-incident').length,50);
});
test('missing incident list is a retryable error, while a confirmed empty list remains empty',async()=>{
  const a=incidents();a.ctx.bridge=()=>({request:async()=>({})});await a.ctx.renderIncidents();assert.match(tree(a.root),/Resposta de chamados inválida/);assert.ok(findButton(a.root,'Tentar novamente'));assert.doesNotMatch(tree(a.root),/Nenhum chamado aberto/);
  a.ctx.bridge=()=>({request:async()=>({incidents:[]})});await findButton(a.root,'Tentar novamente').click();assert.match(tree(a.root),/Nenhum chamado aberto/);
});
