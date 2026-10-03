'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {clickChannel,contactIndex,decorateContact,heatFor}=require('../panel-contact');
const {auditCapture}=require('../panel-capture');
const {sortItems}=require('../panel-sort');

const run=(ref,event,when)=>({id:ref+event+when,created_at:new Date(when).toISOString(),dados:{ref,evento:event,quando:new Date(when).toISOString()}});
const message=(id,source,when='2026-09-26T01:00:00Z')=>({id,direction:'CUSTOMER',source_kind:source,occurred_at_utc:when});

test('only a message that really arrived is contact: simulations and calculator clicks stay hidden',()=>{
  const index=contactIndex({calcRuns:[run('AAAAA','simulacao',1),run('BBBBB','sms',2),run('CCCCC','whatsapp',3)],messages:[message('m','WHATSAPP_WEBHOOK')],messageLinks:[{journey_id:'j',message_id:'m'}]});
  assert.equal(index.facts({ref:'AAAAA'}).entered,false);
  assert.equal(index.facts({ref:'BBBBB'}).entered,false,'clicou em SMS e não mandou: não aparece');
  assert.equal(index.facts({ref:'CCCCC'}).entered,false,'clicou em WhatsApp e não mandou: não aparece');
  assert.equal(index.facts({journeyId:'j'}).entered,true);
  assert.equal(index.facts({journeyId:'j',ref:'BBBBB'}).channel,'WHATSAPP','a ficha com mensagem entra pelo canal da mensagem');
});
test('a WhatsApp click never counts, before or after the first webhook inbound',()=>{
  const index=contactIndex({calcRuns:[run('EARLY','whatsapp',100),run('LATE1','whatsapp',300)],messages:[message('in','WHATSAPP_WEBHOOK',new Date(200).toISOString())],messageLinks:[{journey_id:'j',message_id:'in'}]});
  assert.equal(index.facts({ref:'EARLY'}).entered,false);
  assert.equal(index.facts({ref:'LATE1'}).entered,false);
  assert.equal(index.facts({journeyId:'j'}).entered,true);
});
test('Find contact clicks keep their stored channel for reading, but never count as contact',()=>{
  const find=(ref,canal,when)=>({id:ref+String(canal),created_at:new Date(when).toISOString(),dados:{ref,evento:'busca',canal,quando:new Date(when).toISOString()}});
  assert.equal(clickChannel(find('FNDW1','whatsapp',100)),'WHATSAPP_CLICK');
  assert.equal(clickChannel(find('FNDS1','sms',101)),'SMS_CLICK');
  assert.equal(clickChannel(find('FNDL1','',102)),'CONTACT_CLICK_UNKNOWN');
  const index=contactIndex({calcRuns:[find('FNDW1','whatsapp',100),find('FNDS1','sms',101),find('FNDL1','',102)]});
  for(const ref of ['FNDW1','FNDS1','FNDL1','SIMUL'])assert.equal(index.facts({ref}).entered,false,ref);
});
test('capture audit: a click without a message is not an alert; a ficha with a message missing from the list is',()=>{
  const run=(ref)=>({id:ref,created_at:new Date(1).toISOString(),dados:{sid:'find-'+ref,ref,evento:'busca',canal:'whatsapp',quando:new Date(1).toISOString()}});
  const result=auditCapture({calcRuns:[run('ABCD2'),run('DROP2'),run('NLED2')],journeys:[{id:'j1',contact_id:'c1',reference_code:'ABCD2'},{id:'j2',contact_id:'c2',reference_code:'DROP2'},{id:'j3',contact_id:'c3',reference_code:'NLED2'}],contacts:[{id:'c1',is_lead:true},{id:'c2',is_lead:true},{id:'c3',is_lead:false}]});
  assert.deepEqual(result.missingRefs,[]);
  const bad={id:'bad',created_at:new Date(300).toISOString(),dados:{ref:'HDE22',evento:'busca',canal:'whatsapp',quando:new Date(300).toISOString()}};
  assert.deepEqual(auditCapture({calcRuns:[bad]}).missingRefs,[],'só clicou: não é alerta');
  const hidden=auditCapture({calcRuns:[bad],journeys:[{id:'jh',contact_id:'ch',reference_code:'HDE22'}],contacts:[{id:'ch',is_lead:true}],messages:[message('mh','WHATSAPP_WEBHOOK')],messageLinks:[{journey_id:'jh',message_id:'mh'}]});
  assert.deepEqual(hidden.missingRefs,['HDE22']);
  const legacy=auditCapture({calcRuns:[{id:'legacy',created_at:new Date(300).toISOString(),dados:{sid:'legacy',ref:'-----',evento:'busca',canal:'whatsapp',quando:new Date(300).toISOString()}}]});
  assert.deepEqual(legacy.missingRefs,[]);
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
  const ordered=sortItems([{id:'later',score:99,heat:'HOT',purchaseWindow:'3M'},{id:'now',score:1,heat:'COLD',purchaseWindow:'NOW'}],'ready','ready');assert.equal(ordered[0].id,'now');
});
