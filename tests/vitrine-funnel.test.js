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

function seedDb(){
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
