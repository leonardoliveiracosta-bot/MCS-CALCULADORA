'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {contactIndex,decorateContact,heatFor}=require('../panel-contact');
const {auditCapture}=require('../panel-capture');
const {sortItems}=require('../panel-sort');

const run=(ref,event,when)=>({id:ref+event+when,created_at:new Date(when).toISOString(),dados:{ref,evento:event,quando:new Date(when).toISOString()}});
const message=(id,source,when='2026-09-26T01:00:00Z')=>({id,direction:'CUSTOMER',source_kind:source,occurred_at_utc:when});

test('only simulations stay hidden, SMS and a real customer message enter the panel',()=>{
  const index=contactIndex({calcRuns:[run('AAAAA','simulacao',1),run('BBBBB','sms',2)],messages:[message('m','WHATSAPP_WEBHOOK')],messageLinks:[{journey_id:'j',message_id:'m'}]});
  assert.equal(index.facts({ref:'AAAAA'}).entered,false);
  assert.equal(index.facts({ref:'BBBBB'}).entered,true);
  assert.equal(index.facts({journeyId:'j'}).entered,true);
});
test('WhatsApp clicks before the first webhook inbound count permanently; later clicks do not',()=>{
  const index=contactIndex({calcRuns:[run('EARLY','whatsapp',100),run('LATE1','whatsapp',300)],messages:[message('in','WHATSAPP_WEBHOOK',new Date(200).toISOString())],messageLinks:[{journey_id:'j',message_id:'in'}]});
  assert.equal(index.facts({ref:'EARLY'}).entered,true);
  assert.equal(index.facts({ref:'LATE1'}).entered,false);
  assert.equal(index.facts({journeyId:'j'}).entered,true);
});
test('Find contact clicks use their stored channel and older channelless clicks remain visible',()=>{
  const find=(ref,canal,when)=>({id:ref+String(canal),created_at:new Date(when).toISOString(),dados:{ref,evento:'busca',canal,quando:new Date(when).toISOString()}});
  const index=contactIndex({calcRuns:[find('FNDW1','whatsapp',100),find('FNDS1','sms',101),find('FNDL1','',102)]});
  assert.equal(index.facts({ref:'FNDW1'}).channel,'WHATSAPP_CLICK');
  assert.equal(index.facts({ref:'FNDS1'}).channel,'SMS_CLICK');
  assert.equal(index.facts({ref:'FNDL1'}).channel,'CONTACT_CLICK_UNKNOWN');
  assert.equal(index.facts({ref:'SIMUL'}).entered,false);
});
test('capture audit reports only an actually hidden click and ignores discarded and non-leads',()=>{
  const run=(ref)=>({id:ref,created_at:new Date(1).toISOString(),dados:{ref,evento:'busca',canal:'whatsapp',quando:new Date(1).toISOString()}});
  const result=auditCapture({calcRuns:[run('SHOW1'),run('DROP1'),run('NOLED')],journeys:[{id:'j1',contact_id:'c1',reference_code:'SHOW1'},{id:'j2',contact_id:'c2',reference_code:'DROP1'},{id:'j3',contact_id:'c3',reference_code:'NOLED'}],contacts:[{id:'c1',is_lead:true},{id:'c2',is_lead:true},{id:'c3',is_lead:false}],dispositions:[{item_kind:'REF',item_key:'DROP1',status:'DISCARDED'}]});
  assert.deepEqual(result.missingRefs,[]);
  const hidden=auditCapture({calcRuns:[{id:'bad',created_at:new Date(300).toISOString(),dados:{ref:'HIDE1',evento:'busca',canal:'whatsapp',quando:new Date(300).toISOString()}}],messages:[{id:'webhook',direction:'CUSTOMER',source_kind:'WHATSAPP_WEBHOOK',occurred_at_utc:new Date(100).toISOString()}]});
  assert.deepEqual(hidden.missingRefs,['HIDE1']);
});
test('contact index processes 20,000 linked messages in under one second',()=>{
  const messages=Array.from({length:20000},(_,index)=>message('bulk-'+index,'WHATSAPP_WEBHOOK',new Date(1000+index).toISOString()));
  const links=messages.map((item)=>({journey_id:'bulk-journey',message_id:item.id}));
  const started=performance.now();
  const index=contactIndex({messages,messageLinks:links});
  assert.equal(index.facts({journeyId:'bulk-journey'}).entered,true);
  assert.ok(performance.now()-started<1000);
});
test('latest contact chooses channel and Florida metadata uses the customer contact',()=>{
  const index=contactIndex({calcRuns:[run('ABCDE','sms',100)],messages:[message('m','WHATSAPP_WEBHOOK',new Date(200).toISOString())],messageLinks:[{journey_id:'j',message_id:'m'}]});
  const item=decorateContact({ref:'ABCDE'},index.facts({ref:'ABCDE',journeyId:'j'}));
  assert.equal(item.contactChannel,'WHATSAPP');assert.equal(item.contactAt,new Date(200).toISOString());
});
test('temperature thresholds and AI heat override the calculated score',()=>{
  assert.equal(heatFor({score:34}).key,'COLD');assert.equal(heatFor({score:35}).key,'WARM');assert.equal(heatFor({score:59}).key,'WARM');assert.equal(heatFor({score:60}).key,'HOT');
  assert.equal(heatFor({score:99,aiHeat:'WARM'}).key,'WARM');
  const ordered=sortItems([{id:'warm',score:99,heat:'WARM'},{id:'hot',score:1,heat:'HOT'}],'ready','ready');assert.equal(ordered[0].id,'hot');
});
