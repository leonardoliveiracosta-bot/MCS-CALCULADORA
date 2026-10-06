'use strict';
// COMANDO 1: the V1/V2 funnel API, the tap-to-request bridge and the V2 AI draft.
// No network, no database: every dependency is mocked.
process.env.VERCEL_ENV='preview';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');

function loadWith(relative,mocks){
  const file=path.join(root,relative);const mod={exports:{}};
  const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);
  return mod.exports;
}
const UUID='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const isUuid=(value)=>new RegExp(UUID,'i').test(String(value||''));
const safeText=(value,max)=>{const text=String(value==null?'':value).trim();return text?text.slice(0,max):'';};

/* ---------- tiny in-memory PostgREST ---------- */
function applyParams(list,params={}){
  let out=list.filter((row)=>{for(const [key,value] of Object.entries(params)){
    if(key==='select'||key==='order'||key==='limit'||value===undefined)continue;
    const actual=row[key];
    if(value==='is.null'){if(actual!==null&&actual!==undefined)return false;continue;}
    if(value==='not.is.null'){if(actual===null||actual===undefined)return false;continue;}
    if(value.startsWith('eq.')){if(String(actual)!==value.slice(3))return false;continue;}
    if(value.startsWith('in.(')){if(!value.slice(4,-1).split(',').includes(String(actual)))return false;continue;}
    if(value.startsWith('gte.')){if(Date.parse(actual)<Date.parse(value.slice(4)))return false;continue;}
    if(value.startsWith('gt.')){if(Date.parse(actual)<=Date.parse(value.slice(3)))return false;continue;}
    if(value.startsWith('lte.')){if(Date.parse(actual)>Date.parse(value.slice(4)))return false;continue;}
  }return true;});
  if(params.order){const [field,dir]=String(params.order).split('.');out=[...out].sort((a,b)=>{const delta=Date.parse(a[field]||0)-Date.parse(b[field]||0);return dir==='desc'?-delta:delta;});}
  if(params.limit)out=out.slice(0,Number(params.limit));
  return out;
}
function makeDb(tables){
  const store={};Object.entries(tables).forEach(([name,list])=>{store[name]=list.map((row)=>({...row}));});
  let seq=1;
  const allRows=async(ctx,table,params)=>applyParams(store[table]||[],params);
  const rows=async(ctx,table,params)=>applyParams(store[table]||[],params);
  const insert=async(ctx,table,body)=>{const row={id:'10000000-0000-4000-8000-'+String(seq++).padStart(12,'0'),created_at:new Date().toISOString(),...body};(store[table]=store[table]||[]).push(row);return [row];};
  return {store,allRows,rows,insert};
}
const panelServer=(db)=>({allRows:db.allRows,rows:db.rows,insert:db.insert,isUuid,safeText,
  jsonBody:async()=>({}),requirePanel:async()=>null,send:(res,code,payload)=>{res.code=code;res.payload=payload;}});

const ENV='test';
const ids={v1:'11111111-1111-4111-8111-111111111111',v1b:'22222222-2222-4222-8222-222222222222',v1c:'33333333-3333-4333-8333-333333333333',v1d:'44444444-4444-4444-8444-444444444444',v2:'55555555-5555-4555-8555-555555555555',v2b:'66666666-6666-4666-8666-666666666666',car1:'a1111111-1111-4111-8111-111111111111',car2:'a2222222-2222-4222-8222-222222222222',car3:'a3333333-3333-4333-8333-333333333333',contact:'c1111111-1111-4111-8111-111111111111',journey:'d1111111-1111-4111-8111-111111111111',req1:'e1111111-1111-4111-8111-111111111111'};
const agoMin=(min)=>new Date(Date.now()-min*60000).toISOString();
const future=()=>new Date(Date.now()+7*86400000).toISOString();
const past=()=>new Date(Date.now()-86400000).toISOString();

let seedDb=function(){
  return makeDb({
    vitrines:[
      {id:ids.v1,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V1',created_at:agoMin(120),expires_at:future(),parent_vitrine_id:null},
      {id:ids.v1b,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V1',created_at:agoMin(300),expires_at:future(),parent_vitrine_id:null},
      {id:ids.v1c,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V1',created_at:agoMin(60),expires_at:past(),parent_vitrine_id:null},
      {id:ids.v1d,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V1',created_at:agoMin(500),expires_at:future(),parent_vitrine_id:null},
      {id:ids.v2,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V2',created_at:agoMin(30),expires_at:future(),parent_vitrine_id:ids.v1d},
      {id:ids.v2b,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V2',created_at:agoMin(90),expires_at:future(),parent_vitrine_id:ids.v1b}
    ],
    vitrine_cars:[
      {id:ids.car1,vitrine_id:ids.v1,environment:ENV,vehicle_snapshot:{year:2021,make:'BMW',model:'X3',vin:'5uxtr9c51mlc00001'},customer_limit_cents:2000000},
      {id:ids.car2,vitrine_id:ids.v1b,environment:ENV,vehicle_snapshot:{year:2020,make:'Audi',model:'Q5'},customer_limit_cents:1800000},
      {id:ids.car3,vitrine_id:ids.v2,environment:ENV,vehicle_snapshot:{year:2021,make:'BMW',model:'X3'},customer_limit_cents:2000000}
    ],
    vitrine_events:[
      // a 2-minute-old tap: the funnel shows it at once (no 15-minute delay)
      {vitrine_id:ids.v1,vitrine_car_id:ids.car1,event_type:'TAP',created_at:agoMin(2),environment:ENV},
      {vitrine_id:ids.v1b,vitrine_car_id:ids.car2,event_type:'TAP',created_at:agoMin(200),environment:ENV},
      {vitrine_id:ids.v2,vitrine_car_id:ids.car3,event_type:'TAP',created_at:agoMin(10),environment:ENV}
    ],
    vitrine_requests:[
      // treated VIEW request after the tap on v1b: its tap stays out of the action zone
      {id:ids.req1,vitrine_id:ids.v1b,vitrine_car_id:ids.car2,request_kind:'VIEW',treated_at:agoMin(100),created_at:agoMin(210),environment:ENV}
    ],
    contacts:[{id:ids.contact,display_name:'Ana Souza',is_lead:true,environment:ENV}],
    contact_phones:[{contact_id:ids.contact,phone_e164:'+13055551234',phone_raw:'+13055551234',is_primary:true,is_current:true,retired_at:null,environment:ENV}],
    journeys:[{id:ids.journey,contact_id:ids.contact,reference_code:'3CG5P',status:'ATIVO',budget_cents:2000000,environment:ENV}],
    journey_toggle_states:[],panel_item_dispositions:[],journey_refs:[],
    message_journeys:[],messages:[]
  });
}
const seedDbRaw=seedDb;
seedDb=()=>sendAll(seedDbRaw());
// Every seeded vitrine was really sent: an MCS message with its /v/<token> link a minute after it was created.
function sendAll(db){
  db.store.messages=db.store.messages||[];
  db.store.vitrines.forEach((vitrine,index)=>{
    if(vitrine.token)return;
    vitrine.token='tok'+vitrine.id.slice(0,8)+index;
    db.store.messages.push({id:'m'+vitrine.id,environment:ENV,direction:'MCS',undone_at:null,body_text:'Your options: https://mycarscout.net/v/'+vitrine.token,occurred_at_utc:new Date(Date.parse(vitrine.created_at)+60000).toISOString(),created_at:vitrine.created_at});
  });
  return db;
}
const servicesFor=(db)=>({
  allRows:db.allRows,rows:db.rows,insert:db.insert,
  loadClassification:async()=>({identityOf:()=>({state:'OK',status:'REF_COMPROVADA'})})
});
const mocksFor=(db)=>({
  '../../panel-server':panelServer(db),
  '../../panel-classification':{loadClassification:async()=>({identityOf:()=>({state:'OK',status:'REF_COMPROVADA'})})},
  '../../panel-domain':{toggleEnabled:()=>true},
  '../../panel-groups':{refStateOf:()=>'OK'},
  '../../panel-disposition':{dispositionIndex:()=>()=>null}
});
const ctx={environment:ENV};

/* ---------- vitrine-funnel ---------- */
test('funnel: a fresh tap lands in "Tocou · falta a V2" with no 15-minute wait',async()=>{
  const db=seedDb();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  assert.equal(out.v1.tapped.length,1);
  assert.equal(out.v1.tapped[0].vitrineId,ids.v1);
  assert.equal(out.v1.tapped[0].vitrineCarId,ids.car1);
  assert.equal(out.v1.tapped[0].car,'2021 BMW X3');
  // The VIN tells apart two cars of the same year and model (upper case; null when the car has none).
  assert.equal(out.v1.tapped[0].vin,'5UXTR9C51MLC00001');
  assert.equal(out.v1.tapped[0].phone,'+13055551234');
  assert.equal(out.v1.tapped[0].budgetCents,2000000);
  assert.equal(out.counts.v1Action,1);
});
test('funnel: V1 gravada sem VIN no carro mostra o VIN do carro original do lote',async()=>{
  // V1s created before the snapshot kept the VIN: the car still points to its source match, which has it.
  const db=seedDb();
  const car=db.store.vitrine_cars.find((row)=>row.id===ids.car1);
  delete car.vehicle_snapshot.vin; car.source_match_id='77777777-7777-4777-8777-777777777777';
  db.store.manheim_matches=[{id:car.source_match_id,environment:ENV,vehicle_json:{parsed:{vin:'4t1bf1fk5eu000001'}}}];
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  assert.equal(out.v1.tapped[0].vin,'4T1BF1FK5EU000001');
});
test('funnel: V1 sem pedido gravado é ligada pelo cliente e Ref; sem pedido possível diz por quê',async()=>{
  const db=seedDb();
  db.store.vitrines.forEach((row)=>{if(row.id===ids.v1||row.id===ids.v1c)row.journey_id=null;});
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  let out=await funnel.payload(ctx,servicesFor(db));
  assert.equal(out.v1.tapped[0].journeyId,ids.journey,'ativa: ligada pelo cliente + Ref');
  assert.equal(out.v1.expired[0].journeyId,ids.journey,'expirada: ligada pelo cliente + Ref');
  // Ref de outro pedido do cliente: nenhum pedido para ligar, com o motivo.
  db.store.vitrines.forEach((row)=>{if(row.id===ids.v1c)row.reference_code='ZZZZZ';});
  out=await funnel.payload(ctx,servicesFor(db));
  assert.equal(out.v1.expired[0].journeyId,null);
  assert.equal(out.v1.expired[0].journeyMissing,'SEM_PEDIDO');
  // Dois pedidos do cliente com a mesma Ref: não escolhe sozinho.
  db.store.vitrines.forEach((row)=>{if(row.id===ids.v1c)row.reference_code='3CG5P';});
  db.store.journeys.push({id:'d2222222-2222-4222-8222-222222222222',contact_id:ids.contact,reference_code:'3cg5p',status:'ATIVO',environment:ENV});
  out=await funnel.payload(ctx,servicesFor(db));
  assert.equal(out.v1.expired[0].journeyId,null);
  assert.equal(out.v1.expired[0].journeyMissing,'VARIOS_PEDIDOS');
});
test('funnel: V1 without a tap waits, expired V1 goes to "Expiradas"',async()=>{
  const db=seedDb();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  // v1b has a tap but a V2 child (v2b) and a treated request: out of the action zone
  assert.ok(!out.v1.tapped.some((item)=>item.vitrineId===ids.v1b));
  assert.equal(out.v1.expired.length,1);
  assert.equal(out.v1.expired[0].vitrineId,ids.v1c);
});
test('funnel: V2 with a bid tap is flagged, the others wait',async()=>{
  const db=seedDb();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  assert.equal(out.v2.bid.length,1);
  assert.equal(out.v2.bid[0].vitrineId,ids.v2);
  assert.equal(out.v2.bid[0].car,'2021 BMW X3');
  assert.equal(out.v2.waiting.length,1);
  assert.equal(out.v2.waiting[0].vitrineId,ids.v2b);
  assert.equal(out.counts.v2Action,1);
});
test('funnel: a V2 child takes the V1 out of the action zone',async()=>{
  const db=seedDb();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  assert.ok(!out.v1.tapped.some((item)=>item.vitrineId===ids.v1d),'v1d has a V2 child');
});
test('ensure_request: reuses the open VIEW request, creates one when missing',async()=>{
  const db=seedDb();
  // an open VIEW request for v1/car1
  db.store.vitrine_requests.push({id:ids.req1,vitrine_id:ids.v1,vitrine_car_id:ids.car1,request_kind:'VIEW',treated_at:null,created_at:agoMin(1),environment:ENV});
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const reused=await funnel.ensureRequest(ctx,{vitrineId:ids.v1,vitrineCarId:ids.car1},{insert:db.insert,allRows:db.allRows});
  assert.equal(reused.requestId,ids.req1);assert.equal(reused.reused,true);
  db.store.vitrine_requests.pop();
  const created=await funnel.ensureRequest(ctx,{vitrineId:ids.v1,vitrineCarId:ids.car1},{insert:db.insert,allRows:db.allRows});
  assert.equal(created.created,true);assert.ok(isUuid(created.requestId));
  const row=db.store.vitrine_requests.find((item)=>item.id===created.requestId);
  assert.equal(row.request_kind,'VIEW');assert.equal(row.vitrine_id,ids.v1);assert.equal(row.vitrine_car_id,ids.car1);
});
test('ensure_request: refuses unknown, non-V1 and expired vitrines',async()=>{
  const db=seedDb();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const services={insert:db.insert,allRows:db.allRows};
  assert.equal((await funnel.ensureRequest(ctx,{vitrineId:'99999999-9999-4999-8999-999999999999',vitrineCarId:ids.car1},services)).error,'VITRINE_NOT_FOUND');
  assert.equal((await funnel.ensureRequest(ctx,{vitrineId:ids.v2,vitrineCarId:ids.car3},services)).error,'VITRINE_FUNNEL_INVALID');
  assert.equal((await funnel.ensureRequest(ctx,{vitrineId:ids.v1c,vitrineCarId:ids.car1},services)).error,'VITRINE_EXPIRED');
});

/* ---------- v2-draft ---------- */
const draftMocks=(db,budget)=>({
  '../../panel-server':panelServer(db),
  '../../panel-openai-budget':budget
});
function draftDb(){
  const db=seedDb();
  db.store.vitrine_requests.push({id:ids.req1,vitrine_id:ids.v1,vitrine_car_id:ids.car1,journey_id:ids.journey,request_kind:'VIEW',treated_at:null,created_at:agoMin(1),environment:ENV});
  db.store.message_journeys.push({message_id:'m1',journey_id:ids.journey,undone_at:null,environment:ENV});
  db.store.messages.push({id:'m1',direction:'CUSTOMER',body_text:'I need a BMW X3 under 60k miles',is_automatic:null,undone_at:null,created_at:agoMin(50),environment:ENV});
  return db;
}
const okBudget=()=>({guard:()=>({}),recorded:async()=>{},openAiFailure:async()=>Object.assign(new Error('OPENAI_FAILED'),{code:'OPENAI_FAILED'}),
  paidCall:async()=>{throw Object.assign(new Error('OPENAI_FAILED'),{code:'OPENAI_FAILED'});}});
test('v2-draft: returns the AI note and message',async()=>{
  const db=draftDb();
  const budget=okBudget();
  budget.paidCall=async()=>({payload:{choices:[{message:{content:JSON.stringify({note:'Clean title, one owner',message:"Ana, here's the car you asked to see. Clean title and low miles for the year."})}}]},costUsd:0.001});
  const mod=loadWith('api/panel/v2-draft.js',draftMocks(db,budget));
  const out=await mod.draft(ctx,{requestId:ids.req1},{rows:db.rows,allRows:db.allRows,budget});
  assert.equal(out.note,'Clean title, one owner');
  assert.ok(out.message.startsWith("Ana, here's the car you asked to see"));
});
test('v2-draft: any AI failure returns empty, the screen opens with defaults',async()=>{
  const db=draftDb();
  const budget=okBudget();
  budget.paidCall=async()=>{throw Object.assign(new Error('OPENAI_FAILED'),{code:'OPENAI_FAILED'});};
  const mod=loadWith('api/panel/v2-draft.js',draftMocks(db,budget));
  const out=await mod.draft(ctx,{requestId:ids.req1},{rows:db.rows,allRows:db.allRows,budget});
  assert.deepEqual({note:out.note,message:out.message},{note:null,message:null});
});
test('v2-draft: invalid or unknown requestId is rejected',async()=>{
  const db=draftDb();
  const mod=loadWith('api/panel/v2-draft.js',draftMocks(db,okBudget()));
  assert.equal((await mod.draft(ctx,{requestId:'nope'},{rows:db.rows,allRows:db.allRows,budget:okBudget()})).error,'V2_DRAFT_INVALID');
  assert.equal((await mod.draft(ctx,{requestId:'99999999-9999-4999-8999-999999999999'},{rows:db.rows,allRows:db.allRows,budget:okBudget()})).error,'V2_DRAFT_REQUEST_NOT_FOUND');
});
test('summary: real V1s from the vitrines table, with today in Florida time',async()=>{
  const db=seedDb();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.summary(ctx,{allRows:db.allRows});
  // distinct journey ids with a V1 (seed has 4 V1s on the same journey, one expired: still generated)
  assert.deepEqual(out.v1JourneyIds,[ids.journey]);
  // only the V1s created today (Florida time) count as today; expired ones still count as generated
  const today=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
  const key=(t)=>today.find((x)=>x.type===t).value;
  const todayKey=`${key('year')}-${key('month')}-${key('day')}`;
  const created=[120,300,60,500].map((min)=>{const d=new Date(Date.now()-min*60000);
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
    const g=(t)=>parts.find((x)=>x.type===t).value;return `${g('year')}-${g('month')}-${g('day')}`;});
  assert.equal(out.v1Today,created.filter((k)=>k===todayKey).length);
});

/* ---------- tirar da lista: todo cartão de V1 e V2, sem apagar nada, com Desfazer ---------- */
const extra={v1w:'77777777-7777-4777-8777-77777777aaaa',carW:'a4444444-4444-4444-8444-444444444444',v2w:'88888888-8888-4888-8888-88888888aaaa',carV2w:'a5555555-5555-4555-8555-555555555555'};
function seedWithWaiting(){
  const db=seedDb();
  db.store.vitrines.push({id:extra.v1w,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V1',created_at:agoMin(40),expires_at:future(),parent_vitrine_id:null},
    {id:extra.v2w,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Ana Souza',version:'V2',created_at:agoMin(50),expires_at:future(),parent_vitrine_id:null});
  sendAll(db);
  db.store.vitrine_cars.push({id:'a6666666-6666-4666-8666-666666666666',vitrine_id:ids.v1c,environment:ENV,vehicle_snapshot:{year:2018,make:'Kia',model:'Soul'}},{id:extra.carW,vitrine_id:extra.v1w,environment:ENV,vehicle_snapshot:{year:2019,make:'Honda',model:'CR-V'}},{id:extra.carV2w,vitrine_id:extra.v2w,environment:ENV,vehicle_snapshot:{year:2020,make:'Toyota',model:'RAV4'}});
  return db;
}
const listed=(out)=>({v1w:out.v1.waiting.map((i)=>i.vitrineId),v1e:out.v1.expired.map((i)=>i.vitrineId),v2w:out.v2.waiting.map((i)=>i.vitrineId),v2b:out.v2.bid.map((i)=>i.vitrineId)});

test('tirar da lista: V1 aguardando, V1 expirada, V2 aguardando e V2 com lance saem; Desfazer volta; nada é apagado',async()=>{
  const db=seedWithWaiting();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const requests=loadWith('api/panel/vitrine-requests.js',{...mocksFor(db),'../../panel-server':{...panelServer(db),patchRows:async(c,table,filter,patch)=>{db.store[table].filter((row)=>row.id===filter.id.slice(3)).forEach((row)=>Object.assign(row,patch));return [];}},'../../vitrine-domain':{deposit:()=>0,vehicleName:()=>''}});
  let out=await funnel.payload(ctx,servicesFor(db));
  assert.ok(listed(out).v1w.includes(extra.v1w));
  assert.ok(listed(out).v1e.includes(ids.v1c));
  assert.ok(listed(out).v2w.includes(extra.v2w));
  assert.ok(listed(out).v2b.includes(ids.v2));
  const done={};
  for(const vitrineId of [extra.v1w,ids.v1c,extra.v2w,ids.v2]) done[vitrineId]=await requests.dismiss(ctx,{vitrineId},servicesFor(db));
  out=await funnel.payload(ctx,servicesFor(db));
  const after=listed(out);
  for(const [list,vitrineId] of [['v1w',extra.v1w],['v1e',ids.v1c],['v2w',extra.v2w],['v2b',ids.v2]]) assert.ok(!after[list].includes(vitrineId),list);
  // Só sai o cartão dispensado: a outra V2 aguardando continua.
  assert.ok(after.v2w.includes(ids.v2b));
  // Nada apagado: as linhas continuam, só marcadas; o tipo próprio nunca vira pedido aberto.
  const rows=db.store.vitrine_requests.filter((row)=>row.request_kind==='DISMISS');
  assert.equal(rows.length,4);
  assert.ok(rows.every((row)=>row.treated_at));
  // Dispensar de novo reaproveita a mesma linha.
  assert.equal((await requests.dismiss(ctx,{vitrineId:extra.v1w},servicesFor(db))).requestId,done[extra.v1w].requestId);
  assert.equal(db.store.vitrine_requests.filter((row)=>row.request_kind==='DISMISS').length,4);
  // Desfazer: o cartão volta, a linha fica.
  db.store.vitrine_requests.find((row)=>row.id===done[extra.v1w].requestId).treated_at=null;
  out=await funnel.payload(ctx,servicesFor(db));
  assert.deepEqual(listed(out).v1w,[extra.v1w]);
  assert.equal(db.store.vitrine_requests.filter((row)=>row.request_kind==='DISMISS').length,4);
});

test('tirar da lista: lance novo depois de dispensar traz a V2 de volta; toque novo traz a V1',async()=>{
  const db=seedWithWaiting();
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const requests=loadWith('api/panel/vitrine-requests.js',{...mocksFor(db),'../../vitrine-domain':{deposit:()=>0,vehicleName:()=>''}});
  await requests.dismiss(ctx,{vitrineId:extra.v2w},servicesFor(db));
  await requests.dismiss(ctx,{vitrineId:extra.v1w},servicesFor(db));
  db.store.vitrine_events.push({vitrine_id:extra.v2w,vitrine_car_id:extra.carV2w,event_type:'TAP',created_at:new Date(Date.now()+1000).toISOString(),environment:ENV},
    {vitrine_id:extra.v1w,vitrine_car_id:extra.carW,event_type:'TAP',created_at:new Date(Date.now()+1000).toISOString(),environment:ENV});
  const out=await funnel.payload(ctx,servicesFor(db));
  assert.ok(out.v2.bid.some((item)=>item.vitrineId===extra.v2w));
  assert.ok(out.v1.tapped.some((item)=>item.vitrineId===extra.v1w));
});

/* ---------- "V1 enviada" só com prova de envio (o link numa mensagem da MCS) ---------- */
test('V1 só é "enviada" quando o link está numa mensagem da MCS; link só gerado vai para "envio não confirmado"',async()=>{
  const db=seedDb();
  const id='99999999-9999-4999-8999-999999999999',car='a9999999-9999-4999-8999-999999999999';
  db.store.vitrines.push({id,environment:ENV,contact_id:ids.contact,journey_id:ids.journey,reference_code:'QPVK3',customer_name:'Anderson',version:'V1',created_at:agoMin(3000),expires_at:future(),parent_vitrine_id:null,token:'nuncaenviado1'});
  db.store.vitrine_cars.push({id:car,vitrine_id:id,environment:ENV,vehicle_snapshot:{year:2020,make:'Ford',model:'Edge'}});
  // A pré-visualização logo depois de gerar o link: abre e toca, mas nenhuma mensagem levou o link.
  db.store.vitrine_events.push({vitrine_id:id,vitrine_car_id:car,event_type:'TAP',created_at:agoMin(2998),environment:ENV});
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  const all=[...out.v1.tapped,...out.v1.waiting,...out.v1.expired].map((item)=>item.vitrineId);
  assert.ok(!all.includes(id),'nunca aparece como V1 enviada nem como "tocou"');
  assert.deepEqual(out.v1.unsent.map((item)=>item.vitrineId),[id]);
  assert.equal(out.counts.v1Action,1,'o toque da pré-visualização não conta');
  // Depois que o link sai numa mensagem, vira V1 enviada; o tempo conta da mensagem, e o toque antigo (antes do envio) não vale.
  db.store.messages.push({id:'mx',environment:ENV,direction:'MCS',undone_at:null,body_text:'https://mycarscout.net/v/nuncaenviado1',occurred_at_utc:agoMin(60),created_at:agoMin(60)});
  const after=await funnel.payload(ctx,servicesFor(db));
  const waiting=after.v1.waiting.find((item)=>item.vitrineId===id);
  assert.ok(waiting,'agora é V1 enviada, aguardando o toque');
  assert.equal(waiting.ago,'há 1 h');
  assert.ok(!after.v1.unsent.some((item)=>item.vitrineId===id));
});
test('mensagem do cliente com o link não prova envio',async()=>{
  const db=seedDb();
  const v=db.store.vitrines.find((row)=>row.id===ids.v1);
  db.store.messages=db.store.messages.filter((m)=>!m.body_text.includes(v.token));
  db.store.messages.push({id:'mc',environment:ENV,direction:'CUSTOMER',undone_at:null,body_text:'https://mycarscout.net/v/'+v.token,occurred_at_utc:agoMin(5),created_at:agoMin(5)});
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.payload(ctx,servicesFor(db));
  assert.ok(out.v1.unsent.some((item)=>item.vitrineId===ids.v1));
  assert.ok(!out.v1.tapped.some((item)=>item.vitrineId===ids.v1));
});
test('summary: V1 só gerada (link nunca enviado) não conta como enviada',async()=>{
  const db=seedDb();
  const other='e2222222-2222-4222-8222-222222222222';
  db.store.vitrines.push({id:'99999999-9999-4999-8999-99999999aaaa',environment:ENV,contact_id:ids.contact,journey_id:other,reference_code:'QPVK3',version:'V1',created_at:agoMin(5),expires_at:future(),token:'sopreview1'});
  const funnel=loadWith('api/panel/vitrine-funnel.js',mocksFor(db));
  const out=await funnel.summary(ctx,{allRows:db.allRows});
  assert.ok(!out.v1JourneyIds.includes(other));
});
