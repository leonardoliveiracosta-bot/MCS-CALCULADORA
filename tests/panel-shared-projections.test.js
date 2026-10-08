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
    const afterShared=backend.calls.length;
    const later=await allRows(shared,'messages',{select:'chat_id,id',environment:'eq.preview',order:'id.desc'},2);
    assert.deepEqual(later,control[1]);assert.equal(backend.calls.length,afterShared,'later projection reuses the same complete source');
    assert.ok(actual[0].some(row=>row.date_unknown===true&&row.created_at===null));
    assert.ok(actual[1].every(row=>!('date_unknown' in row)));
    assert.ok(actual[2].some(row=>row.date_unknown===true&&!('created_at' in row)));
    actual[0][0].id='isolated';assert.notEqual(actual[1][0].id,'isolated');
    assert.deepEqual(Object.keys(actual[1][0]),['chat_id','id']);
    const ids=control[0].map(row=>row.id);
    const scopedParams={select:'id,created_at',environment:'eq.preview',id:'in.('+ids.map(id=>'"'+id+'"').join(',')+')',order:'created_at.desc'};
    const scopedControl=await allRows(base,'messages',scopedParams,2);
    const beforeScoped=backend.calls.length;
    const scoped=await allRows(shared,'messages',scopedParams,2);
    assert.deepEqual(scoped,scopedControl,'UUID matching, order, fields and unknown SMS date match PostgreSQL');
    assert.equal(backend.calls.length,beforeScoped,'known scoped projection adds no source read');
    // The REST fixture compares UUIDs as text. Verify PostgreSQL's typed UUID
    // semantics directly for uppercase literals, then compare the reused rows.
    const upperIds=ids.map(id=>id.toUpperCase());
    const typedIds=(await backend.db.query('select id from public.messages where id=any($1::uuid[]) order by id',[upperIds])).rows.map(row=>row.id);
    assert.deepEqual(typedIds,ids.slice().sort());
    assert.deepEqual(await allRows(shared,'messages',{...scopedParams,id:'in.('+upperIds.map(id=>'"'+id+'"').join(',')+')'},2),scopedControl);
    scoped[0].created_at='isolated';
    assert.deepEqual(await allRows(shared,'messages',scopedParams,2),scopedControl,'each caller has isolated rows');
    const dateParams={...scopedParams,created_at:'gte.2026-10-08T00:00:00Z'};
    const dateControl=await allRows(base,'messages',dateParams,2);
    const beforeDate=backend.calls.length;
    assert.deepEqual(await allRows(shared,'messages',dateParams,2),dateControl,'date filters remain in PostgreSQL before masking SMS');
    assert.ok(backend.calls.length>beforeDate,'different source filters cannot reuse the unfiltered source');
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
test('identidade leve reaproveitada é idêntica à leitura própria, incluindo prova e propriedade de Ref',async()=>{
  const backend=await createBackend({seed:demo.seed,maxRows:1000,nativeJsonRows:true}),originalFetch=global.fetch,RealDate=Date;
  const fixed=RealDate.now();
  global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed]))}static now(){return fixed}};
  global.fetch=(url,options)=>backend.fetch(url,options);
  const base={environment:'preview',config:{url:'http://banco-simulado.local',secretKey:'test'}};
  const {buildContexts,prepareListContexts}=require('../panel-client-context');
  try{
    const input={journeyIds:[demo.IDS.JOURNEY]},services={listOnly:true};
    const control=await buildContexts(base,input,services);
    const shared={...base,sharedProjections:create((table,params,size)=>allRows(base,table,params,size),orderComparator)};
    await prepareListContexts(shared);
    const result=await buildContexts(shared,input,services);
    assert.deepEqual(result,control,'same complete identity output');
    assert.ok(shared.sharedProjections.stats.scopedReuses>0,'identity uses complete opening sources');
    assert.equal(backend.refused.length,0);
  }finally{global.fetch=originalFetch;global.Date=RealDate;await backend.db.close();}
});
