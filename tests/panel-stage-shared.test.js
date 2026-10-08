'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBackend}=require('./fixtures/banco-simulado'),demo=require('./fixtures/caso-demonstracao');
const {loadSearchStageIndex}=require('../panel-search-stage');
test('andamento compartilhado preserva resultado, isola mapas e distingue escopos',async()=>{
  const backend=await createBackend({seed:demo.seed,nativeJsonRows:true}),original=global.fetch;
  global.fetch=(url,options)=>backend.fetch(url,options);
  const context={environment:'preview',config:{url:'http://banco-simulado.local',secretKey:'test'}};
  try{
    const control=await loadSearchStageIndex(context);
    const shared={...context,readCache:new Map()},start=backend.calls.length;
    const [a,b]=await Promise.all([loadSearchStageIndex(shared),loadSearchStageIndex({...shared})]);
    assert.deepEqual(a,control);assert.deepEqual(b,control);
    const calls=backend.calls.length-start;
    assert.ok(calls>0);
    a.get(demo.IDS.JOURNEY).searchKey='apenas na cópia';a.delete(demo.IDS.TWIN_A);
    assert.deepEqual(await loadSearchStageIndex(shared),control);
    assert.equal(backend.calls.length-start,calls);
    assert.deepEqual(b,control);
    for(const journeyIds of [[demo.IDS.JOURNEY],[demo.IDS.TWIN_A],[]]){
      const old=await loadSearchStageIndex(context,{journeyIds});
      const current=await loadSearchStageIndex(shared,{journeyIds});
      assert.deepEqual(current,old);
      assert.equal(current.size,journeyIds.length);
    }
    assert.equal(backend.refused.length,0);
  }finally{global.fetch=original;await backend.db.close();}
});
