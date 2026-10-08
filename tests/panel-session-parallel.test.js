'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../painel/painel.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
function setup(){
 const session=deferred(),boot=deferred(),calls=[],shown=[],store={parts:{},items:{}};
 const options={sort:'ready',page:{limit:30,ref:'all'},includeCounters:false};
 const ctx={initialBoot:null,accessToken:'fake',sessionScope:'',cacheEpoch:0,bootStore:null,bootStoreLoading:null,attendSnapshotTried:false,SESSION_TIMEOUT_MS:12000,
 location:{origin:'https://painel.test',hash:'',pathname:'/painel/',search:''},history:{state:true},Date,Object,Array,Set,Math,JSON,console:{log(){},error(){}},
 $:()=>({value:'ready'}),attendPageOptions:()=>options.page,sessionRetry(){},show:value=>shown.push(value),error(){},
 request:(url)=>{calls.push(url);return url==='/api/panel/session'?session.promise:boot.promise},
 invalidatePanelLists(){ctx.cacheEpoch++;ctx.initialBoot=null},clearSession(){ctx.accessToken=null;ctx.initialBoot=null},
 bootState:async()=>store,saveBootState(){},routeFromHash:async()=>{},refreshCounters:async()=>({}),loadAutomaticMessages:async()=>{},loadCaptureWarning:async()=>{},startSafeRefresh(){},bootWarning(){}};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('  async function bootLoadNow('),source.indexOf('  function primeBoot(')),ctx);
 ctx.switchPanel=()=>ctx.bootLoadNow('main',options);
 vm.runInContext(source.slice(source.indexOf('  async function routeSession()'),source.indexOf('  function bootWarning()')),ctx);
 return{ctx,session,boot,calls,shown,store,options};
}
const answer={parts:{today:{ok:true,hash:'same',body:{items:[{id:'case',group:'grupo',count:7}]}}}};
test('a abertura começa junto da sessão, mas só entrega a mesma fila depois da autorização',async()=>{
 const t=setup(),run=t.ctx.routeSession();
 assert.deepEqual(t.calls,['/api/panel/boot','/api/panel/session']);assert.deepEqual(t.shown,[]);
 t.boot.resolve(answer);await new Promise(setImmediate);assert.deepEqual(t.shown,[]);assert.equal(t.ctx.initialBoot,null);
 t.session.resolve({environment:'production',email:'ficticio@test',mustChangePassword:false});await run;
 assert.deepEqual(t.shown,['app-view']);assert.equal(t.calls.filter(url=>url==='/api/panel/boot').length,1);
 assert.deepEqual(t.store.parts.today.body,answer.parts.today.body);
});
test('troca obrigatória de senha e acesso negado nunca liberam a fila antecipada',async()=>{
 for(const denied of [false,true]){
  const t=setup(),run=t.ctx.routeSession();t.boot.resolve(answer);
  if(denied)t.session.reject(Object.assign(new Error('denied'),{code:'PANEL_ACCESS_DENIED'}));
  else t.session.resolve({environment:'production',email:'ficticio@test',mustChangePassword:true});
  await run;assert.deepEqual(t.shown,[denied?'login-view':'password-view']);assert.equal(t.ctx.initialBoot,null);assert.deepEqual(t.store.parts,{});
 }
});
test('resposta antecipada falha isoladamente; a abertura autenticada mantém a leitura normal',async()=>{
 const t=setup(),run=t.ctx.routeSession();t.boot.reject(new Error('failed'));await new Promise(setImmediate);
 t.ctx.request=url=>{t.calls.push(url);return Promise.resolve(answer)};
 t.session.resolve({environment:'production',email:'ficticio@test',mustChangePassword:false});await run;
 assert.deepEqual(t.shown,['app-view']);assert.equal(t.calls.filter(url=>url==='/api/panel/boot').length,2);
 assert.deepEqual(t.store.parts.today.body,answer.parts.today.body);
});
test('token, invalidação ou filtros diferentes não reutilizam uma resposta antecipada',async()=>{
 for(const change of ['token','epoch','filters']){
  const t=setup();t.ctx.sessionScope='pessoa';
  t.ctx.initialBoot={token:'fake',epoch:0,signature:JSON.stringify(t.options),promise:Promise.resolve({answer,ms:1})};
  if(change==='token')t.ctx.accessToken='outro';else if(change==='epoch')t.ctx.cacheEpoch++;else t.ctx.initialBoot.signature='outros filtros';
  t.boot.resolve(answer);await t.ctx.bootLoadNow('main',t.options);
  assert.deepEqual(t.calls,['/api/panel/boot']);assert.equal(t.ctx.initialBoot,null);
 }
});
