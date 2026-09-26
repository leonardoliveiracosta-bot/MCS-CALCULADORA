'use strict';

process.env.VERCEL_ENV='preview';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

function loadWith(relative,mocks){
  const file=path.join(root,relative),mod={exports:{}};
  const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);
  return mod.exports;
}

function server(data,calls=[]){
  return {
    allRows:async(_ctx,table)=>data[table]||[],
    rows:async(_ctx,table)=>data[table]||[],
    insert:async()=>[],patchRows:async()=>[],
    supabase:async(_url,_key,endpoint,options)=>{calls.push({endpoint,options});return {started:true};}
  };
}
function group(latestDirection='CUSTOMER',extra={}){
  const now=new Date();const old=new Date(Date.now()-4*86400000).toISOString();
  return {journey:{id:'j',status:extra.closed?'ENCERRADO':'ATIVO',contact_id:'c'},chat:{id:'h'},contact:{is_lead:extra.isLead===undefined?true:extra.isLead},enabled:extra.enabled===undefined?true:extra.enabled,
    latest:{id:'last',direction:latestDirection,body_text:'Mensagem',occurred_at_utc:old},resolution:extra.resolution||null,insight:extra.insight||null};
}

test('customer last message is red even when the search is closed, and a resolved item returns on a new message',()=>{
  const pending=loadWith('panel-pendencias.js',{'./panel-server':server({})});
  assert.equal(pending.fixedSituation(group('CUSTOMER',{closed:true}),null),'NO_RESPONSE');
  assert.equal(pending.fixedSituation(group('MCS',{closed:true}),null),'CLOSED');
  assert.equal(pending.itemFromGroup(group('CUSTOMER',{resolution:{resolved_message_id:'older'}})).resolved,false);
  assert.equal(pending.itemFromGroup(group('CUSTOMER',{resolution:{resolved_message_id:'last'}})).resolved,true);
});

test('a 400-message conversation is segmented from beginning to end in three bounded parts',()=>{
  const pending=loadWith('panel-pendencias.js',{'./panel-server':server({})});
  const messages=Array.from({length:400},(_,index)=>({id:String(index),direction:index%2?'MCS':'CUSTOMER',body_text:'m'+index,occurred_at_utc:new Date(1700000000000+index*1000).toISOString()}));
  let index=0,parts=0;
  while(index<messages.length){const segment=pending.formatSegment(messages,index,'');assert.ok(segment.messages.length<=150);assert.ok(segment.user.length<=40000);assert.ok(segment.nextIndex>index);index=segment.nextIndex;parts++;}
  assert.equal(parts,3);assert.equal(index,400);
});

test('history received less than 30 minutes ago blocks the general reading before a run is created',async()=>{
  const now=new Date().toISOString(),calls=[];
  const data={
    journeys:[{id:'j',contact_id:'c',reference_code:null,status:'ATIVO'}],contacts:[{id:'c',display_name:'Cliente',is_lead:true}],contact_phones:[],
    chats:[{id:'h',contact_id:'c',channel:'WHATSAPP',is_group:false}],message_journeys:[{journey_id:'j',message_id:'m'}],
    messages:[{id:'m',chat_id:'h',direction:'CUSTOMER',body_text:'Oi',occurred_at_utc:now}],journey_refs:[],journey_toggle_states:[],conversation_pending_insights:[],conversation_pending_resolutions:[],conversation_general_read_runs:[],whatsapp_raw_events:[{received_at:now}]
  };
  const pending=loadWith('panel-pendencias.js',{'./panel-server':server(data,calls)});
  await assert.rejects(()=>pending.startGeneralRead({environment:'preview',config:{url:'x',secretKey:'y'}}),{message:'HISTORY_STILL_ARRIVING'});
  assert.equal(calls.length,0);
});

test('general-read pricing reserves the configured price and unknown models use the highest rate',()=>{
  const pending=loadWith('panel-pendencias.js',{'./panel-server':server({})});
  assert.deepEqual(pending.modelPrices('claude-sonnet-5'),{input:2,output:10});
  assert.deepEqual(pending.modelPrices('model-not-in-table'),{input:15,output:75});
  assert.ok(pending.maximumCostUsd('model-not-in-table')>pending.maximumCostUsd('claude-sonnet-5'));
  assert.equal(pending.usageCostUsd({input_tokens:1000000,output_tokens:1000000},'claude-sonnet-5'),12);
});

test('groups never enter the pending queue',async()=>{
  const data={journeys:[{id:'j',contact_id:'c',reference_code:null,status:'ATIVO'}],contacts:[{id:'c',display_name:'Grupo',is_lead:true}],contact_phones:[],chats:[{id:'g',contact_id:'c',channel:'WHATSAPP',is_group:true}],message_journeys:[{journey_id:'j',message_id:'m'}],messages:[{id:'m',chat_id:'g',direction:'CUSTOMER',body_text:'Oi',occurred_at_utc:new Date().toISOString()}],journey_refs:[],journey_toggle_states:[],conversation_pending_insights:[],conversation_pending_resolutions:[]};
  const pending=loadWith('panel-pendencias.js',{'./panel-server':server(data)});
  assert.deepEqual(await pending.conversationGroups({environment:'preview'}),[]);
});
