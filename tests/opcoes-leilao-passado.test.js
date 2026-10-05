'use strict';
// Carro com leilão passado sai sozinho: a regra em JS é a mesma da migração 20261027010000
// (tests/sql/teste-manheim-leilao-passado.sql), a V1 deixa de fora o expirado e avisa, e o
// "comparar de novo" não cria combinação para carro de leilão passado nem desfaz uma que já existe.
const test=require('node:test'),assert=require('node:assert/strict');
const offer=require('../manheim-offer');

const T=Date.parse('2026-10-05T15:00:00Z'); // 11h na Flórida
const lane={lane:'A',run:'12'};

test('regra: leilão de dia anterior na Flórida, endsAt passado, Buy Now só pelo endsAt',()=>{
  assert.equal(offer.offerExpired({...lane,startsAt:'2026-10-04T14:00:00Z',endsAt:'2026-10-09T00:00:00Z'},T),true);
  assert.equal(offer.offerExpired({...lane,startsAt:'2026-10-05T13:00:00Z'},T),false);
  assert.equal(offer.offerExpired({...lane,startsAt:'2026-10-06T13:00:00Z'},T),false);
  assert.equal(offer.offerExpired(lane,T),false);
  assert.equal(offer.offerExpired({},T),false);
  assert.equal(offer.offerExpired({...lane,startsAt:'2026-10-05T02:00:00Z'},T),true,'22h de ontem na Flórida');
  assert.equal(offer.offerExpired({...lane,saleDate:'2026-10-04'},T),true);
  assert.equal(offer.offerExpired({...lane,saleDate:'2026-10-05'},T),false);
  assert.equal(offer.offerExpired({...lane,startsAt:'amanhã cedo'},T),false);
  assert.equal(offer.offerExpired({...lane,endsAt:'2026-10-05T14:00:00Z'},T),true);
  assert.equal(offer.offerExpired({buyNowPrice:'25000',startsAt:'2026-09-20T10:00:00Z',endsAt:'2026-10-20T00:00:00Z'},T),false);
  assert.equal(offer.offerExpired({buyNowPrice:'25000'},T),false);
  assert.equal(offer.offerExpired({buyNowPrice:'25000',endsAt:'2026-10-05T10:00:00Z'},T),true);
  // carro agrupado: expirado só quando todas as vendas expiraram
  assert.equal(offer.carExpired({purchaseOptions:[{...lane,startsAt:'2026-10-04T14:00:00Z'},{buyNowPrice:'1',endsAt:'2026-10-20T00:00:00Z'}]},T),false);
  assert.equal(offer.carExpired({purchaseOptions:[{...lane,startsAt:'2026-10-04T14:00:00Z'}]},T),true);
  assert.equal(offer.carExpired({...lane,startsAt:'2026-10-04T14:00:00Z'},T),true);
});

const id=n=>`5e5e0000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const day=(offset)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10)+'T16:00:00Z';
const car=(n,sale)=>({id:id(n),upload_id:id(90),journey_id:id(1),vehicle_json:{parsed:{vin:'VINLEILAO'+n,year:2022,make:'Jeep',model:'Wrangler',trim:'Rubicon',miles:20000,mmrCents:3000000,lane:'B',run:String(n),...sale}}});
function services(cars){
  const inserted=[];
  const table={journeys:[{id:id(1),contact_id:id(2),reference_code:'ABCDE',budget_cents:4000000}],contacts:[{display_name:'Cliente'}],vitrines:[],vitrine_cars:[]};
  return {inserted,svc:{
    rows:async(_,name,filter)=>name==='manheim_matches'?cars.filter(c=>filter.id==='eq.'+c.id):name==='manheim_option_selections'?cars.map(c=>({match_id:c.id,status:'SELECTED',final_cents:3300000})):table[name]||[],
    insert:async(_,name,body)=>{inserted.push({name,body});return [{id:id(80+inserted.length),...body}];},
    groupedMatches:async(_,matches)=>cars.filter(c=>matches.some(m=>m.id===c.id)),
    auditGate:async()=>null,stampGate:async()=>null,activeFilter:async()=>({}),liveUploadFilter:async()=>({})
  }};
}

test('V1: carro de leilão passado não entra e a resposta diz quais saíram',async()=>{
  const vit=require('../api/panel/vitrines'),ctx={environment:'preview',panel:{id:id(3)}};
  const live=car(10,{startsAt:day(1)}),old=car(11,{startsAt:day(-1),trim:'Sahara'});
  const {inserted,svc}=services([live,old]);
  const out=await vit.create(ctx,{journeyId:id(1),matchIds:[live.id,old.id]},svc);
  assert.ok(out.token,JSON.stringify(out));
  assert.deepEqual(out.removed,['2022 Jeep Wrangler Sahara']);
  assert.deepEqual(inserted.filter(i=>i.name==='vitrine_cars').map(i=>i.body.source_match_id),[live.id]);
  const none=services([old]);
  assert.deepEqual(await vit.create(ctx,{journeyId:id(1),matchIds:[old.id]},none.svc),{error:'MANHEIM_SALE_ENDED',removed:['2022 Jeep Wrangler Sahara']});
  assert.equal(none.inserted.length,0,'nenhuma V1 vazia é criada');
});

test('comparar de novo: carro de leilão passado não vira combinação nova; a que já existe fica',()=>{
  const {comparableEntries}=require('../panel-rematch');
  const entries=[{fingerprint:'a',vehicle:{...lane,startsAt:day(1)}},{fingerprint:'b',vehicle:{...lane,startsAt:day(-1)}},{fingerprint:'c',vehicle:{...lane,startsAt:day(-1)}},{fingerprint:'d',vehicle:{buyNowPrice:'9000',startsAt:day(-9),endsAt:day(4)}}];
  assert.deepEqual(comparableEntries(entries,new Set(['c'])).map(e=>e.fingerprint),['a','c','d']);
});
