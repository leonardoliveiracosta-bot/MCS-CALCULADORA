'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../panel-history-batch');
const {createBackend}=require('./fixtures/banco-simulado'),demo=require('./fixtures/caso-demonstracao');
test('função SQL conserva cada fonte, escopo, ordem e erro sem ampliar permissões',async()=>{
  const backend=await createBackend({seed:demo.seed});
  try{
    const requests=[{table:'messages',columns:['id','created_at']},{table:'calc_runs',columns:['id','dados']},{table:'panel_users',columns:['id']},{table:'messages',columns:['id']}];
    const result=(await backend.db.query('select public.panel_boot_history_batch($1,$2) result',['preview',JSON.stringify(requests)])).rows[0].result;
    for(const n of [0,1,3]){
      const control=(await backend.db.query('select public.panel_boot_table_rows($1,$2,$3) result',['preview',requests[n].table,requests[n].columns])).rows[0].result;
      assert.deepEqual(result[n].data,control);
    }
    assert.deepEqual(result[2],{error:'P0001',status:400});
    const scoped=(await backend.db.query('select public.panel_boot_history_batch($1,$2) result',['production',JSON.stringify([requests[0]])])).rows[0].result;
    assert.deepEqual(scoped,[{data:[]}]);
    const privileges=(await backend.db.query("select p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p where p.oid='public.panel_boot_history_batch(public.panel_environment,jsonb)'::regprocedure")).rows;
    assert.deepEqual(privileges,[{prosecdef:false,anon:false,authenticated:false,service:true}]);
    await assert.rejects(backend.db.query('select public.panel_boot_history_batch($1,$2)',['preview',JSON.stringify(Array(17).fill(requests[0]))]),/INVALID_HISTORY_BATCH/);
    const malformed=(await backend.db.query('select public.panel_boot_history_batch($1,$2) result',['preview',JSON.stringify([{table:'messages',columns:['id); drop table messages;--']},requests[0]])])).rows[0].result;
    assert.equal(malformed[0].status,400);assert.deepEqual(malformed[1],result[0]);
  }finally{await backend.db.close();}
});
test('transporte agrupa chamadas, preserva posições e limita cada lote a 16',async()=>{
  const calls=[],batch=create(async requests=>{calls.push(requests);return requests.map(request=>({data:[request]}));});
  const requests=Array.from({length:35},(_,n)=>({table:'messages',columns:['id','c'+n]}));
  const result=await Promise.all(requests.map(request=>batch.load(request.table,request.columns)));
  assert.deepEqual(calls.map(x=>x.length),[16,16,3]);
  assert.deepEqual(result,requests.map(x=>[x]));
});
test('falha de uma fonte não contamina as demais; próxima rodada continua',async()=>{
  let calls=0;
  const batch=create(async()=>{calls++;return calls===1?[{data:[{id:1}]},{error:'P0001',status:400}]:[{data:[]}];});
  const result=await Promise.allSettled([batch.load('messages',['id']),batch.load('calc_runs',['missing'])]);
  assert.deepEqual(result[0].value,[{id:1}]);assert.equal(result[1].reason.status,400);
  assert.deepEqual(await batch.load('messages',['id']),[]);
});
test('RPC ausente usa transporte anterior por fonte e conserva falhas isoladas',async()=>{
  const calls=[],batch=create(async()=>{throw Object.assign(new Error('absent'),{status:404});},async(table,columns)=>{
    calls.push({table,columns});if(table==='bad')throw Object.assign(new Error('failed'),{status:503});return [{table}];
  });
  const result=await Promise.allSettled([batch.load('messages',['id']),batch.load('bad',['id'])]);
  assert.deepEqual(result[0].value,[{table:'messages'}]);assert.equal(result[1].reason.status,503);assert.equal(calls.length,2);
});
test('erro de rede e resposta incompleta falham sem entregar história parcial',async()=>{
  for(const call of [async()=>{throw Object.assign(new Error('network'),{status:503});},async()=>[]]){
    const result=await Promise.allSettled([create(call).load('messages',['id'])]);
    assert.equal(result[0].status,'rejected');
  }
});
