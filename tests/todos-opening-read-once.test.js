'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../painel/painel.js'),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function queue(){
  const calls=[],context={sessionScope:'account-a',cacheEpoch:1,bootLoadNow:(part,extra)=>{const gate=deferred();calls.push({part,extra,...gate});return gate.promise;}};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('  const bootQueue ='),source.indexOf('  async function bootLoadNow(')),context);
  return {calls,context,load:context.bootLoad};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('TODOS: dois pedidos iguais em andamento dividem a leitura; uma nova abertura relê',async()=>{
  const q=queue(),options={sort:'ready',page:{limit:30},includeCounters:false};
  const first=q.load('main',options),second=q.load('main',{...options,page:{limit:30}});
  assert.equal(first,second);await tick();assert.equal(q.calls.length,1);
  q.calls[0].resolve({today:{items:['same']}});assert.equal(await first,await second);
  const next=q.load('main',options);await tick();assert.equal(q.calls.length,2);
  q.calls[1].resolve({today:{items:['fresh']}});assert.deepEqual(await next,{today:{items:['fresh']}});
});
test('filtro diferente e alteração de dados nunca usam a leitura anterior; respostas seguem na ordem',async()=>{
  const q=queue(),first=q.load('main',{sort:'ready'}),filtered=q.load('main',{sort:'recent'});
  await tick();assert.equal(q.calls.length,1);
  q.context.cacheEpoch++;const afterAction=q.load('main',{sort:'ready'});
  assert.notEqual(afterAction,first);q.calls[0].resolve({id:1});await first;await tick();
  assert.equal(q.calls.length,2);assert.equal(q.calls[1].extra.sort,'recent');
  q.calls[1].resolve({id:2});await filtered;await tick();assert.equal(q.calls.length,3);
  q.calls[2].resolve({id:3});assert.deepEqual(await afterAction,{id:3});
});
test('falha libera a leitura, não deixa TODOS preso na mesma promessa rejeitada',async()=>{
  const q=queue(),first=q.load('main',{}),again=q.load('main',{});
  const rejected=assert.rejects(first,/offline/);await tick();q.calls[0].reject(new Error('offline'));await rejected;
  assert.equal(first,again);const retry=q.load('main',{});await tick();assert.equal(q.calls.length,2);
  q.calls[1].resolve({ok:true});assert.deepEqual(await retry,{ok:true});
});
test('preparação da abertura deixa o desenho para applyAttend; demais fluxos mantêm o desenho',async()=>{
  let drawings=0,imports=0;
  const select={value:'keep',replaceChildren(){},options:[]};
  const ctx={queueSeq:0,currentView:'today',attendData:{},$:()=>select,Option:function(){},option(){},refreshSmsJourneys(){},renderQueue(){drawings++;},renderImportsReview(){imports++;}};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('  async function loadQueue('),source.indexOf('\n  }',source.indexOf('  async function loadQueue('))+4),ctx);
  const body={contacts:[],chats:[],reviews:[]};
  assert.equal(await ctx.loadQueue(false,body,{deferRender:true}),body);assert.equal(drawings,0);assert.equal(imports,0);assert.equal(ctx.attendData.entry,body);
  await ctx.loadQueue(false,body);assert.equal(drawings,1);
  ctx.currentView='imports';await ctx.loadQueue(false,body);assert.equal(imports,1);
});
