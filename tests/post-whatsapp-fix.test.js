'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const uuid='2d0c1218-4d44-4c57-9b1e-3bbfc66d7f17';
const candidate='c3f9a8a9-4f4d-4f17-8b55-81ca9dd3fd7a';

function loadWith(relative,mocks){
  const file=path.join(root,relative),mod={exports:{}};
  const localRequire=(name)=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);
  return mod.exports;
}
function output(){return {code:0,payload:null,status(code){this.code=code;return this;},json(payload){this.payload=payload;return payload;}};}

test('GET WhatsApp ignores null suggestion contacts and remains available',async()=>{
  let contactsFilter='';
  const server={
    requirePanel:async()=>({environment:'production',panel:{id:uuid},config:{}}),
    allRows:async(_ctx,table)=>table==='whatsapp_link_suggestions'?[{id:uuid,source_contact_id:uuid,target_contact_id:null,target_ref:'RX43A'}]:table==='whatsapp_phone_reviews'?[{id:candidate,candidate_contact_ids:[null,candidate]}]:[],
    rows:async(_ctx,table,filters)=>{if(table==='contacts'){contactsFilter=filters.id;return[{id:uuid,display_name:'Origem',is_lead:true},{id:candidate,display_name:'Candidato',is_lead:true}];}return[];},
    send:(res,code,payload)=>res.status(code).json(payload),jsonBody:async()=>({}),patchRows:async()=>[],supabase:async()=>{},isUuid:()=>true
  };
  const handler=loadWith('api/panel/whatsapp.js',{'../../panel-server':server,'../../whatsapp-receiver':{}});
  const res=output();await handler({method:'GET'},res);
  assert.equal(res.code,200);
  assert.match(contactsFilter,/^in\.\(/);
  assert.doesNotMatch(contactsFilter,/(?:^|,)null(?:,|\))/);
});

test('HOJE keeps contact metadata once for journeys and once for calculator orders, without technical click badges',()=>{
  const panel=read('painel/painel.js');
  const identity=panel.slice(panel.indexOf('function identityHeader'),panel.indexOf('function smsPrintMissing'));
  const today=panel.slice(panel.indexOf('function renderToday'),panel.indexOf('function orderCard'));
  assert.equal((identity.match(/contactMeta\(item[,)]/g)||[]).length,1);
  // ATENDIMENTO cards show origin and channel once (the origin chip): the compact identity skips the channel badge.
  assert.match(today,/head\.append\(identityHeader\(item, \{ compact: true \}\)\)/);
  assert.match(today,/if\(item\.kind==='CALCULATOR_ORDER'\)\{const contact=contactMeta\(item\);if\(contact\)badges\.append\(contact\);\}/);
  assert.equal((today.match(/contactMeta\(item\)/g)||[]).length,1);
  assert.doesNotMatch(panel,/\$\{item\.contactChannel\} CLICADO/);
});

test('Manheim journey cards rely on identityHeader for one contact metadata block',()=>{
  const panel=read('painel/painel.js');
  const group=panel.slice(panel.indexOf('function renderManheimGroup'),panel.indexOf('function renderManheimOrderGroup'));
  assert.match(group,/identityHeader\(journey\)/);
  assert.doesNotMatch(group,/contactMeta\(journey\)/);
});

test('direct-origin status is based on calculator refs shared by journey and journey_refs',()=>{
  const {calculatorRefs,hasCalculatorOrder,directLeadSource}=require('../panel-search-stage');
  const journey={id:'journey-1',reference_code:'A9V63',source:'WHATSAPP_DIRECT'};
  const calculator=calculatorRefs([{dados:{ref:'PKZAG'}}]);
  assert.equal(hasCalculatorOrder(journey,[],calculator),false);
  assert.equal(directLeadSource(journey,false),'WHATSAPP_DIRECT');
  assert.equal(hasCalculatorOrder(journey,[{journey_id:'journey-1',ref_code:'PKZAG'}],calculator),true);
  assert.equal(directLeadSource(journey,true),null);
  assert.equal(directLeadSource({...journey,source:'SMS_DIRECT'},false),'SMS_DIRECT');
  assert.match(read('api/panel/searches.js'),/hasCalculatorOrder: stage\.hasCalculatorOrder, directLeadSource: stage\.directLeadSource/);
  assert.match(read('painel/painel.js'),/Veio por mensagem · Via WhatsApp \(sem calculadora\)/);
  assert.match(read('painel/lead.js'),/Veio por mensagem · Via SMS \(sem calculadora\)/);
});
