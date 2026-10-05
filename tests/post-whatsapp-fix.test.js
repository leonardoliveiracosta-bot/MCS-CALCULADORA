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
  // orderCard saiu em 7c9c86f: o trecho de HOJE/ATENDIMENTO vai até a função seguinte.
  const todayStart=panel.indexOf('function renderToday'),todayEnd=panel.indexOf('function demandSummary');
  assert.ok(todayStart>0&&todayEnd>todayStart,'renderToday delimitado');
  const today=panel.slice(todayStart,todayEnd);
  const face=panel.slice(panel.indexOf('function caseFace'),panel.indexOf('function',panel.indexOf('function caseFace')+10));
  assert.equal((identity.match(/contactMeta\(item[,)]/g)||[]).length,1);
  // ATENDIMENTO cards are lean (3102cd2: one face for every card): phone once, Ref, the request and which
  // calculator. 3a0886c ("⋯ Mais só com a decisão") removed the badges, so no channel badge at all.
  assert.match(face,/const face = element\('div', 'case-face case-identity'\)/);
  assert.match(face,/if \(phone\) face\.append\(element\('p', 'case-face-phone case-phone', phone\)\)/);
  assert.match(today,/rows\.push\(\['Calculadora', calculatorLabel\(item\), 'case-calculator'\]\)/);
  assert.match(today,/card\.append\(caseFace\(\{ title, ref: ref \|\| \(refStateOf\(item\) === 'A_RECUPERAR' \? 'a recuperar' : 'sem Ref'\), phone: title === phoneText \? '' : phoneText, rows, requests: entry\.requests \}\)\)/);
  assert.equal((today.match(/contactMeta\(/g)||[]).length,0);
  assert.doesNotMatch(panel,/\$\{item\.contactChannel\} CLICADO/);
});

test('options queue cards show one compact identity block and never expand inline',()=>{
  const panel=read('painel/painel.js');
  const start=panel.indexOf('function renderQueueCard'),end=panel.indexOf('function v1ErrorText');
  assert.ok(start>0&&end>start,'renderQueueCard delimitado');
  const queue=panel.slice(start,end);
  assert.match(queue,/identity-name/);
  assert.match(queue,/phone-link/);
  assert.match(queue,/'Ref ' \+ person\.ref/);
  assert.doesNotMatch(queue,/contactMeta\(/);
  assert.doesNotMatch(queue,/<details/);
  // The old inline cards are gone: the selection lives in the ficha.
  assert.doesNotMatch(panel,/function renderManheimGroup/);
  assert.doesNotMatch(panel,/function renderManheimOrderGroup/);
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
