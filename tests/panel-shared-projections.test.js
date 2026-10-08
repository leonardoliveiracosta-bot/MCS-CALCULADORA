'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const create=require('../panel-shared-projections');
const {allRows,orderComparator}=require('../panel-server');
const {createBackend}=require('./fixtures/banco-simulado'),demo=require('./fixtures/caso-demonstracao');
test('projeções compartilham paginação sem mudar dados, ordem, campos ou máscara de SMS',async()=>{
  const backend=await createBackend({seed:demo.seed,maxRows:2,nativeJsonRows:true}),original=global.fetch;
  global.fetch=(url,options)=>backend.fetch(url,options);
  const base={environment:'preview',config:{url:'http://banco-simulado.local',secretKey:'test'}};
  try{
    await backend.db.exec(`insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,time_uncertain,original_datetime_text,signature_base,occurrence_index,source_kind,created_at)
      values('preview','${demo.IDS.CHAT}','SMS','CUSTOMER','Print fictício','print',true,'data original desconhecida','projection-unknown',1,'SMS_PRINT','2026-10-08T04:00:00Z');`);
    const requests=[
      ['messages',{select:'id,created_at',environment:'eq.preview',order:'created_at.desc'}],
      ['messages',{select:'chat_id,id',environment:'eq.preview',order:'id.desc'}],
      ['messages',{select:'body_text',environment:'eq.preview',order:'created_at.asc'}],
      ['messages',{select:'id,created_at',environment:'eq.production'}],
      ['contacts',{select:'id,display_name',environment:'eq.preview',order:'display_name.asc'}],
      ['contacts',{select:'display_name,id',environment:'eq.preview',order:'display_name.desc'}]
    ];
    const control=await Promise.all(requests.map(([table,params])=>allRows(base,table,params,2)));
    const before=backend.calls.length;
    const shared={...base,sharedProjections:create((table,params,size)=>allRows(base,table,params,size),orderComparator)};
    const actual=await Promise.all(requests.map(([table,params])=>allRows(shared,table,params,2)));
    assert.deepEqual(actual,control);
    assert.ok(backend.calls.length-before<before,'fewer complete source reads');
    assert.ok(actual[0].some(row=>row.date_unknown===true&&row.created_at===null));
    assert.ok(actual[1].every(row=>!('date_unknown' in row)));
    assert.ok(actual[2].some(row=>row.date_unknown===true&&!('created_at' in row)));
    actual[0][0].id='isolated';assert.notEqual(actual[1][0].id,'isolated');
    assert.deepEqual(Object.keys(actual[1][0]),['chat_id','id']);
    assert.equal(backend.refused.length,0);
  }finally{global.fetch=original;await backend.db.close();}
});
test('coluna indisponível falha somente para a projeção afetada',async()=>{
  const read=async(table,params)=>{if(params.select.includes('missing'))throw Object.assign(new Error('column'),{status:400});return [{id:1}];};
  const shared=create(read,orderComparator),metadata=fields=>({fields,keys:['id'],orderColumns:[]});
  const result=await Promise.allSettled([
    shared.load('contacts',{select:'id'},1000,metadata(['id'])),
    shared.load('contacts',{select:'missing'},1000,metadata(['missing']))
  ]);
  assert.deepEqual(result[0].value,[{id:1}]);assert.equal(result[1].reason.status,400);
});
test('relações, seleções especiais e filtros diferentes mantêm leituras separadas',async()=>{
  const calls=[],read=async(table,params)=>{calls.push({table,params});return [{id:1}];};
  const shared=create(read,orderComparator),metadata=fields=>({fields,keys:['id'],orderColumns:[]});
  await Promise.all([
    shared.load('contacts',{select:'*',environment:'eq.preview'},1000,metadata(['*'])),
    shared.load('contacts',{select:'id',environment:'eq.preview'},1000,metadata(['id'])),
    shared.load('contacts',{select:'id',environment:'eq.production'},1000,metadata(['id'])),
    shared.load('panel_users',{select:'id'},1000,metadata(['id']))
  ]);
  assert.equal(calls.length,4);
});
