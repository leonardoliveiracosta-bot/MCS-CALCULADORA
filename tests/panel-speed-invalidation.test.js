'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../painel/painel.js'),'utf8');
const pool=require('../painel/refresh-coordinator');
test('gravação invalida o boot anterior: resposta atrasada não volta para os caches de listas e contadores',async()=>{
 let resolve;const primed=[];
 const ctx={cacheEpoch:0,mainBootRunning:null,requestPool:{prime:(...args)=>primed.push(args)},primeBoot:value=>primed.push(value),primeCounterParts:value=>primed.push(value),bootLoad:()=>new Promise(r=>resolve=r)};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('  function loadMainBoot(options)'),source.indexOf('  function readTodayCounter()')),ctx);
 const pending=ctx.loadMainBoot({});ctx.cacheEpoch++;
 resolve({today:{page:{counts:{todos:1}}},entry:{},triage:{},whatsapp:{}});
 await pending;assert.deepEqual(primed,[]);assert.equal(ctx.mainBootRunning,null);
});
test('resposta em andamento antes de invalidar não sobrescreve a resposta nova nem é reutilizada',async()=>{
 const requests=pool.createRequestPool();let oldResolve;
 const old=requests.get('lista',()=>new Promise(r=>oldResolve=r));await Promise.resolve();
 requests.invalidate();
 assert.equal(await requests.get('lista',()=>Promise.resolve('nova')),'nova');
 oldResolve('antiga');await old;
 assert.equal(await requests.get('lista',()=>Promise.reject(Error('não deve buscar')),{ttlMs:60000}),'nova');
});

test('boot iniciado antes de uma gravação não altera nem salva a cópia persistente',async()=>{
 let reply;let saves=0;const store={parts:{},items:{}};
 const ctx={sessionScope:'pessoa',cacheEpoch:0,accessToken:'fake',bootState:async()=>store,request:()=>new Promise(resolve=>reply=resolve),saveBootState:()=>saves++,console:{log(){}},Date,Object,Array,Set,Math};
 vm.createContext(ctx);
 vm.runInContext(source.slice(source.indexOf('  async function bootLoadNow('),source.indexOf('  function primeBoot(')),ctx);
 const pending=ctx.bootLoadNow('main',{});await new Promise(setImmediate);
 ctx.cacheEpoch++;
 reply({parts:{today:{ok:true,hash:'old',body:{items:[]}}}});
 await assert.rejects(pending,error=>error.code==='REQUEST_ABORTED');
 assert.equal(saves,0);assert.deepEqual(store.parts,{});
});
