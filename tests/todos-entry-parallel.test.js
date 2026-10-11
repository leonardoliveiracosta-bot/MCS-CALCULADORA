'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../api/panel/entry.js'),'utf8');
function fixture(failed=false){
  let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
  const ctx={allRows:()=>gate,supabase:()=>gate,smsPrintReviews:()=>[],smsPrintFailures:()=>[],smsPrintResolved:()=>[],activeTriage:async()=>[],chatGroupIndex:async()=>new Map(),loadSearchStageIndex:async()=>new Map(),toggleEnabled:()=>true,lastRealMessageAt:()=>null,
    calcRoute:{loadQueue:async()=>{started++;if(failed)throw new Error('unavailable');return [{messageId:'review-1',reason:'REF'}];}},nameLink:{loadReviews:async()=>[{key:'name-1'}]},send:(_res,_status,body)=>body,MESSAGE_SELECT:'id',RESOLVED_WINDOW_MS:1000};
  vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function queue('),source.indexOf('\nasync function resolveChat(')),ctx);
  return {ctx,release,started:()=>started};
}
test('TODOS: revisão começa enquanto a base ainda está carregando; resposta mantém a revisão',async()=>{
  const f=fixture(),result=f.ctx.queue({environment:'production',config:{url:'test',secretKey:'test'}},{});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.started(),1,'review read must not wait for chats, grouping or stage');
  f.release([]);const body=await result;
  assert.deepEqual(JSON.parse(JSON.stringify(body.calcQueue)),[{messageId:'review-1',reason:'REF'}]);
  assert.deepEqual(JSON.parse(JSON.stringify(body.nameLinks)),[{key:'name-1'}]);assert.equal(body.chats.length,0);
});
test('falha da revisão continua indisponível, nunca vira revisão vazia confirmada',async()=>{
  const f=fixture(true),result=f.ctx.queue({environment:'production',config:{url:'test',secretKey:'test'}},{});
  f.release([]);const body=await result;assert.equal(body.calcQueue,null);assert.equal(body.chats.length,0);
});
