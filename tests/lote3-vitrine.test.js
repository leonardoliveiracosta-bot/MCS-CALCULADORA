'use strict';
// Lote 3: vitrine publica (/v), API publica, /t e API do painel. Sem rede: fetch e banco sao simulados.
process.env.VERCEL_ENV='preview';
process.env.SUPABASE_URL='https://proj.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY='publishable';
process.env.SUPABASE_SECRET_KEY='secret';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
const {expiresAt,isExpired,publicFirstName,publicResponse}=require('../vitrine-domain');
const vitrineHandler=require('../api/vitrine');
const {create,createV2,update,parseLimit,limitCents}=require('../api/panel/vitrines');

function loadWith(relative,mocks){
  const file=path.join(root,relative);const mod={exports:{}};
  const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);
  return mod.exports;
}
function output(){return {code:0,payload:null,headers:{},setHeader(key,value){this.headers[key]=value;},status(code){this.code=code;return this;},json(payload){this.payload=payload;return payload;}};}
const reply=(status,body)=>({ok:status>=200&&status<300,status,text:async()=>body===undefined?'':JSON.stringify(body)});

const ids={vitrine:'11111111-1111-4111-8111-111111111111',journey:'22222222-2222-4222-8222-222222222222',car:'33333333-3333-4333-8333-333333333333',car2:'44444444-4444-4444-8444-444444444444'};
const TOKEN='T'.repeat(43);

/* ---------- API publica /api/vitrine com fetch simulado ---------- */
function publicFetch({vitrine={},journey={status:'ATIVO'},toggle={enabled:true},recentEvent=false,signFails=[]}={}){
  const calls=[];
  const row={id:ids.vitrine,environment:'preview',token:TOKEN,version:'V2',journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Carlos Souza',expires_at:'2099-01-01T00:00:00.000Z',...vitrine};
  const cars=[{id:ids.car,short_code:'MCS-7K2Q',vehicle_snapshot:{year:2021,make:'BMW',model:'X3',mmrCents:2580000,startsAt:'2099-01-01T12:00:00Z'},customer_limit_cents:1800000,note_text:'Clean car',photo_paths:[ids.vitrine+'/a b.jpg',ids.vitrine+'/c.jpg']}];
  const fetch=async(url,options={})=>{
    const target=new URL(url);calls.push({url:String(url),path:target.pathname,params:target.searchParams,method:options.method||'GET',body:options.body});
    if(target.pathname==='/rest/v1/vitrines')return reply(200,[row]);
    if(target.pathname==='/rest/v1/journeys')return reply(200,journey?[{id:ids.journey,...journey}]:[]);
    if(target.pathname==='/rest/v1/journey_toggle_states')return reply(200,toggle?[toggle]:[]);
    if(target.pathname==='/rest/v1/vitrine_cars')return reply(200,cars);
    if(target.pathname==='/rest/v1/vitrine_events'&&(options.method||'GET')==='GET')return reply(200,recentEvent?[{id:'e1'}]:[]);
    if(target.pathname==='/rest/v1/vitrine_events')return reply(201);
    if(target.pathname.startsWith('/storage/v1/object/sign/vitrine-photos/')){
      const objectPath=target.pathname.slice('/storage/v1/object/sign/vitrine-photos/'.length);
      if(signFails.some((item)=>objectPath.endsWith(item)))return reply(400,{message:'Object not found'});
      return reply(200,{signedURL:'/object/sign/vitrine-photos/'+objectPath+'?token=signed'});
    }
    throw new Error('unexpected '+url);
  };
  return {calls,fetch};
}
async function callVitrine(mock,req){
  const previous=global.fetch;global.fetch=mock.fetch;
  try{const res=output();await vitrineHandler({query:{token:TOKEN},method:'GET',...req},res);return res;}finally{global.fetch=previous;}
}

test('A27: photos are absolute signed URLs, the path keeps its slash, a failed photo is dropped',async()=>{
  const mock=publicFetch({signFails:['c.jpg']});
  const res=await callVitrine(mock,{});
  assert.equal(res.code,200);
  const photos=res.payload.cars[0].photos;
  assert.deepEqual(photos,['https://proj.supabase.co/storage/v1/object/sign/vitrine-photos/'+ids.vitrine+'/a%20b.jpg?token=signed']);
  assert.ok(photos.every((url)=>typeof url==='string'),'flat list of strings, never nested arrays');
  const signCalls=mock.calls.filter((call)=>call.path.startsWith('/storage/v1/object/sign/'));
  assert.equal(signCalls.length,2);
  for(const call of signCalls){assert.doesNotMatch(call.url,/%2F/i);assert.equal(call.method,'POST');}
});

test('M5: an expired vitrine returns only expired and the Ref, and signs no photo',async()=>{
  const mock=publicFetch({vitrine:{expires_at:'2020-01-01T00:00:00.000Z'}});
  const res=await callVitrine(mock,{});
  assert.equal(res.code,200);
  assert.deepEqual(res.payload,{expired:true,referenceCode:'3CG5P',whatsAppNumber:vitrineHandler.WHATSAPP_NUMBER});
  assert.equal(mock.calls.filter((call)=>call.path.startsWith('/storage/')).length,0);
  assert.equal(mock.calls.filter((call)=>call.path==='/rest/v1/vitrine_cars').length,0);
});

test('M5: a closed journey (ENCERRADO or switched off) closes the vitrine like /t',async()=>{
  const ended=await callVitrine(publicFetch({journey:{status:'ENCERRADO'}}),{});
  assert.equal(ended.payload.expired,true);assert.equal(ended.payload.cars,undefined);
  const off=await callVitrine(publicFetch({toggle:{enabled:false}}),{});
  assert.equal(off.payload.expired,true);assert.equal(off.payload.cars,undefined);
  const open=await callVitrine(publicFetch(),{});
  assert.equal(open.payload.expired,false);assert.equal(open.payload.cars.length,1);
});

test('M5: V1 hides limit and note; the public name is a first name, never a phone or placeholder',async()=>{
  const v1=await callVitrine(publicFetch({vitrine:{version:'V1',customer_name:'+13055551234'}}),{});
  assert.equal(v1.payload.version,'V1');
  assert.equal(Object.hasOwn(v1.payload.cars[0],'customerLimitCents'),false);
  assert.equal(Object.hasOwn(v1.payload.cars[0],'note'),false);
  assert.doesNotMatch(JSON.stringify(v1.payload),/1800000|Clean car|3055551234/);
  assert.equal(v1.payload.customerName,null);
  const v2=await callVitrine(publicFetch(),{});
  assert.equal(v2.payload.customerName,'Carlos');assert.equal(v2.payload.cars[0].customerLimitCents,1800000);assert.equal(v2.payload.cars[0].note,'Clean car');
  assert.equal(publicFirstName('Contato da Ref 3CG5P'),null);
  assert.equal(publicFirstName('Ana 2'),null);
  assert.equal(publicFirstName('  maria   josé '),'maria');
  assert.equal(publicFirstName(''),null);
});

test('B3: events are refused on an expired vitrine and deduplicated within 10 minutes',async()=>{
  const expired=publicFetch({vitrine:{expires_at:'2020-01-01T00:00:00.000Z'}});
  const refused=await callVitrine(expired,{method:'POST',body:{event:'OPEN'}});
  assert.equal(refused.code,410);assert.equal(expired.calls.filter((call)=>call.path==='/rest/v1/vitrine_events').length,0);

  const fresh=publicFetch();
  const first=await callVitrine(fresh,{method:'POST',body:{event:'TAP',code:'MCS-7K2Q'}});
  assert.equal(first.code,201);
  const lookup=fresh.calls.find((call)=>call.path==='/rest/v1/vitrine_events'&&call.method==='GET');
  assert.equal(lookup.params.get('vitrine_id'),'eq.'+ids.vitrine);assert.equal(lookup.params.get('vitrine_car_id'),'eq.'+ids.car);assert.equal(lookup.params.get('event_type'),'eq.TAP');
  const since=Date.parse(lookup.params.get('created_at').replace(/^gte\./,''));
  assert.ok(Math.abs(Date.now()-10*60*1000-since)<5000,'window of 10 minutes');
  const inserted=fresh.calls.find((call)=>call.path==='/rest/v1/vitrine_events'&&call.method==='POST');
  assert.deepEqual(JSON.parse(inserted.body),{environment:'preview',vitrine_id:ids.vitrine,vitrine_car_id:ids.car,event_type:'TAP'});

  const repeated=publicFetch({recentEvent:true});
  const second=await callVitrine(repeated,{method:'POST',body:{event:'OPEN'}});
  assert.equal(second.code,200);assert.equal(second.payload.duplicate,true);
  assert.equal(repeated.calls.find((call)=>call.path==='/rest/v1/vitrine_events'&&call.method==='GET').params.get('vitrine_car_id'),'is.null');
  assert.equal(repeated.calls.filter((call)=>call.path==='/rest/v1/vitrine_events'&&call.method==='POST').length,0);

  const closed=publicFetch({journey:{status:'ENCERRADO'}});
  assert.equal((await callVitrine(closed,{method:'POST',body:{event:'OPEN'}})).code,410);
});

/* ---------- dominio ---------- */
test('A28: a car without auction date never makes the vitrine expired (no "year 2000")',()=>{
  const now=Date.parse('2026-09-28T12:00:00.000Z');
  assert.equal(expiresAt([{vehicle:{}}],now),'2026-09-30T12:00:00.000Z');
  assert.equal(expiresAt([{vehicle_snapshot:{startsAt:''}}],now),'2026-09-30T12:00:00.000Z');
  assert.equal(expiresAt([{vehicle:{}},{vehicle:{endsAt:'2026-10-03T12:00:00.000Z'}}],now),'2026-10-05T12:00:00.000Z');
  assert.equal(isExpired({expires_at:expiresAt([{year:2020,make:'Honda'}])}),false);
});

test('M5: publicResponse for an expired vitrine carries no cars, limit, note or photos',()=>{
  const out=publicResponse({token:TOKEN,version:'V2',reference_code:'AB234',customer_name:'Ana',expires_at:'2020-01-01T00:00:00Z'},[{short_code:'MCS-7K2Q',vehicle_snapshot:{},customer_limit_cents:2500000,note_text:'x'}],[['https://a']]);
  assert.deepEqual(out,{expired:true,referenceCode:'AB234'});
});

/* ---------- pagina /v (v/vitrine.js) num DOM simulado ---------- */
async function renderPage(data){
  const app={innerHTML:'',textContent:'',querySelectorAll:()=>[],querySelector:()=>({})};
  const context={document:{querySelector:()=>app},location:{pathname:'/v/'+TOKEN,href:''},
    fetch:async(_url,options)=>options&&options.method==='POST'?{ok:true}:{ok:true,json:async()=>data},console};
  vm.runInNewContext(read('v/vitrine.js'),context);
  for(let i=0;i<5;i++)await new Promise((resolve)=>setImmediate(resolve));
  return app.innerHTML||app.textContent;
}
const pageData=(vehicle,extra={})=>({token:TOKEN,version:'V1',referenceCode:'AB234',customerName:'Ana',expired:false,whatsAppNumber:'1',cars:[{code:'MCS-7K2Q',vehicle:{year:2020,make:'Honda',model:'Civic',...vehicle},averageAuctionValue:null,photos:[],...extra}]});

test('M6: a date-only auction shows that day, with no hour and no countdown',async()=>{
  const html=await renderPage(pageData({startsAt:'2026-10-01'}));
  assert.match(html,/Thu, Oct 1/);
  assert.doesNotMatch(html,/Sep 30|PM|AM|h left|Auction time has passed/);
  const us=await renderPage(pageData({startsAt:'10/01/2026'}));
  assert.match(us,/Thu, Oct 1/);assert.doesNotMatch(us,/Sep 30|h left/);
  const withTime=await renderPage(pageData({startsAt:'2099-10-01T14:00:00Z'}));
  assert.match(withTime,/Oct 1, 10:00 AM/);assert.match(withTime,/left/);
  const none=await renderPage(pageData({startsAt:null}));
  assert.doesNotMatch(none,/Auction day|Auction time has passed/);
});

test('B1: without MMR the average auction value block is left out (never "~ $0")',async()=>{
  const html=await renderPage(pageData({startsAt:'2026-10-01'}));
  assert.doesNotMatch(html,/Average auction value|\$0/);
  const withValue=await renderPage(pageData({startsAt:'2026-10-01'},{averageAuctionValue:25800}));
  assert.match(withValue,/Average auction value/);assert.match(withValue,/\$25,800/);
});

/* ---------- /t: codigos do RPC ---------- */
test('B2: RPC business errors on POST /t become clear 409/400 answers, not 500',async()=>{
  const server=require('../panel-server');
  const handler=loadWith('api/tracking.js',{'../panel-server':{...server,SERVER_ENVIRONMENT:'preview'},'../panel-lead':{orders:async()=>[]}});
  const run=async(raised)=>{
    const previous=global.fetch;
    global.fetch=async(url)=>{
      const target=new URL(url);
      if(target.pathname==='/rest/v1/lead_tracking')return reply(200,[{id:ids.car,ref_code:'ABC23',journey_id:ids.journey,step:1}]);
      if(target.pathname==='/rest/v1/journeys')return reply(200,[{id:ids.journey,contact_id:ids.car2,status:'ATIVO'}]);
      if(target.pathname==='/rest/v1/journey_toggle_states')return reply(200,[{enabled:true}]);
      if(target.pathname==='/rest/v1/rpc/panel_customer_unit_response')return reply(400,{code:'P0001',message:raised,details:null,hint:null});
      throw new Error('unexpected '+url);
    };
    try{const res=output();await handler({method:'POST',query:{code:'abcdefghijklmnopqrstuvwxyz'},body:{unitId:ids.car,response:'WANT'}},res);return res;}finally{global.fetch=previous;}
  };
  const closed=await run('SEARCH_CLOSED');assert.equal(closed.code,409);assert.equal(closed.payload.message,'This search is closed');
  const unavailable=await run('UNIT_UNAVAILABLE');assert.equal(unavailable.code,409);assert.equal(unavailable.payload.message,'This car is no longer available');
  const invalid=await run('RESPONSE_INVALID');assert.equal(invalid.code,400);assert.ok(invalid.payload.message);
  const answered=await run('RESPONSE_ALREADY_SET');assert.equal(answered.code,409);assert.equal(answered.payload.message,'You already answered this car');
  const other=await run('SOMETHING_ELSE');assert.equal(other.code,500);
  for(const res of [closed,unavailable,invalid,answered])assert.doesNotMatch(res.payload.message,/—|\.$/);
});

/* ---------- API do painel: limite, A26 e idempotencia ---------- */
test('B4: the V2 limit must be between US$ 1.000 and US$ 10.000.000',()=>{
  assert.equal(parseLimit(100000),100000);assert.equal(parseLimit(1000000000),1000000000);
  assert.equal(parseLimit(99999),false);assert.equal(parseLimit(1000000001),false);assert.equal(parseLimit(0),false);assert.equal(parseLimit(-5),false);
  assert.equal(parseLimit('20,000'),2000000);assert.equal(parseLimit('20k'),2000000);assert.equal(parseLimit('US$ 20.000'),2000000);
  assert.equal(parseLimit('abc'),false);assert.equal(parseLimit('20'),false);assert.equal(parseLimit({}),false);
  assert.equal(parseLimit(null),null);assert.equal(parseLimit(''),null);
  assert.equal(limitCents({customerLimitCents:5},{budget_cents:1800000}),false);
  assert.equal(limitCents({},{budget_cents:99}),null,'an absurd budget is not used as default');
});

const panelCtx={environment:'production',panel:{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}};
const v2ids={v1:'77777777-7777-4777-8777-777777777777',car:'88888888-8888-4888-8888-888888888888',request:'99999999-9999-4999-8999-999999999999',journey:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',contact:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',match:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',match2:'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'};
function memoryDb(){
  const clock={now:Date.parse('2026-09-28T12:00:00.000Z')};
  const db={
    vitrines:[{id:v2ids.v1,environment:'production',token:'V'.repeat(43),version:'V1',journey_id:v2ids.journey,contact_id:v2ids.contact,reference_code:'3CG5P',customer_name:'Carlos',expires_at:'2099-01-01T00:00:00.000Z',created_at:'2026-09-20T00:00:00.000Z'}],
    vitrine_cars:[{id:v2ids.car,environment:'production',vitrine_id:v2ids.v1,source_match_id:v2ids.match,short_code:'MCS-7K2Q',vehicle_snapshot:{year:2021,make:'BMW',model:'X3',startsAt:'2099-01-01T12:00:00Z'},customer_limit_cents:1790000,note_text:null,photo_paths:[]}],
    vitrine_requests:[{id:v2ids.request,environment:'production',vitrine_id:v2ids.v1,vitrine_car_id:v2ids.car,treated_at:null}],
    journeys:[{id:v2ids.journey,environment:'production',contact_id:v2ids.contact,reference_code:'3CG5P',budget_cents:1800000,confirmed_total_ceiling_cents:2500000}],
    contacts:[{id:v2ids.contact,environment:'production',display_name:'Carlos'}],
    manheim_matches:[{id:v2ids.match,environment:'production',journey_id:v2ids.journey,vehicle_json:{parsed:{year:2021,make:'BMW',model:'X3',mmrCents:3000000,startsAt:'2099-01-01T12:00:00Z'}}},{id:v2ids.match2,environment:'production',journey_id:v2ids.journey,vehicle_json:{parsed:{year:2020,make:'Audi',model:'Q5',mmrCents:2800000}}}]
  };
  let seq=0;const selects=[];const patches=[];
  const matches=(row,params)=>Object.entries(params).every(([key,raw])=>{
    if(['select','limit','order','offset'].includes(key))return true;
    const value=String(raw);
    if(value==='is.null')return row[key]==null;
    if(value.startsWith('gte.'))return Date.parse(row[key])>=Date.parse(value.slice(4));
    return String(row[key])===value.replace(/^eq\./,'');
  });
  const services={
    rows:async(_ctx,table,params)=>{selects.push({table,select:params.select});return (db[table]||[]).filter((row)=>matches(row,params)).map((row)=>JSON.parse(JSON.stringify(row)));},
    insert:async(_ctx,table,payload)=>{const row={id:'dddddddd-dddd-4ddd-8ddd-'+String(++seq).padStart(12,'0'),created_at:new Date(clock.now).toISOString(),...payload};(db[table]=db[table]||[]).push(row);return [row];},
    patchRows:async(_ctx,table,filters,payload)=>{patches.push({table,filters,payload});for(const row of (db[table]||[]).filter((item)=>matches(item,filters)))Object.assign(row,payload);return null;},
    // Both cars were selected for the customer (only selected cars make a V1).
    selectionRows:async()=>[v2ids.match,v2ids.match2].map((matchId)=>({match_id:matchId,status:'SELECTED',final_cents:3090000,manual:false}))
  };
  return {db,services,clock,selects,patches};
}

test('A26: V1 and V2 public limit is the maximum bid (budget_cents), never the confirmed total ceiling',async()=>{
  const mem=memoryDb();
  await create(panelCtx,{journeyId:v2ids.journey,matchIds:[v2ids.match]},mem.services,mem.clock.now);
  const v1Car=mem.db.vitrine_cars.at(-1);assert.equal(v1Car.customer_limit_cents,1800000);
  const out=await createV2(panelCtx,{requestId:v2ids.request},mem.services,mem.clock.now);
  assert.equal(mem.db.vitrine_cars.find((row)=>row.id===out.carId).customer_limit_cents,1800000);
  const journeySelects=mem.selects.filter((call)=>call.table==='journeys').map((call)=>call.select);
  // The contact guard (panel-opt-out.js journeyBlock) also reads the ficha, without any amount.
  const moneySelects=journeySelects.filter((select)=>/cents/.test(select));
  assert.ok(moneySelects.length>=2);
  for(const select of moneySelects)assert.match(select,/budget_cents/);
  for(const select of journeySelects)assert.doesNotMatch(select,/confirmed_total_ceiling_cents/);
  assert.doesNotMatch(read('api/panel/vitrines.js').replace(/\/\/.*$/gm,'').replace(/\/\*[\s\S]*?\*\//g,''),/confirmed_total_ceiling_cents/);
});

test('A22: a V2 retry within 10 minutes reuses the same V2 instead of duplicating it',async()=>{
  const mem=memoryDb();
  const first=await createV2(panelCtx,{requestId:v2ids.request,customerLimitCents:2000000,noteText:'Clean car'},mem.services,mem.clock.now);
  mem.clock.now+=3*60*1000;
  const retry=await createV2(panelCtx,{requestId:v2ids.request,customerLimitCents:2100000,noteText:'Clean car, one owner'},mem.services,mem.clock.now);
  assert.equal(retry.reused,true);assert.equal(retry.token,first.token);assert.equal(retry.vitrineId,first.vitrineId);assert.equal(retry.carId,first.carId);
  assert.equal(mem.db.vitrines.filter((row)=>row.version==='V2').length,1);
  const car=mem.db.vitrine_cars.find((row)=>row.id===first.carId);assert.equal(car.customer_limit_cents,2100000);assert.equal(car.note_text,'Clean car, one owner');
  mem.clock.now+=11*60*1000;
  const later=await createV2(panelCtx,{requestId:v2ids.request},mem.services,mem.clock.now);
  assert.notEqual(later.token,first.token);assert.equal(mem.db.vitrines.filter((row)=>row.version==='V2').length,2);
});

test('A22: an invalid V2 limit is rejected before anything is created',async()=>{
  const mem=memoryDb();
  assert.deepEqual(await createV2(panelCtx,{requestId:v2ids.request,customerLimitCents:5000},mem.services),{error:'VITRINE_LIMIT_INVALID'});
  assert.deepEqual(await createV2(panelCtx,{requestId:v2ids.request,customerLimitCents:'20'},mem.services),{error:'VITRINE_LIMIT_INVALID'});
  assert.equal(mem.db.vitrines.length,1);assert.equal(mem.db.vitrine_cars.length,1);
});

test('A22: a V1 retry for the same journey and cars returns the vitrine already created',async()=>{
  const mem=memoryDb();
  const first=await create(panelCtx,{journeyId:v2ids.journey,matchIds:[v2ids.match,v2ids.match2],requestId:'12345678-1234-4234-8234-123456789012'},mem.services,mem.clock.now);
  mem.clock.now+=2*60*1000;
  const retry=await create(panelCtx,{journeyId:v2ids.journey,matchIds:[v2ids.match2,v2ids.match],requestId:'12345678-1234-4234-8234-123456789012'},mem.services,mem.clock.now);
  assert.equal(retry.reused,true);assert.equal(retry.token,first.token);assert.equal(retry.link,'/v/'+first.token);
  assert.equal(mem.db.vitrines.filter((row)=>row.version==='V1').length,2,'the seeded V1 plus one new');
  const other=await create(panelCtx,{journeyId:v2ids.journey,matchIds:[v2ids.match]},mem.services,mem.clock.now);
  assert.notEqual(other.token,first.token);
  assert.equal(await create(panelCtx,{journeyId:v2ids.journey,matchIds:[v2ids.match],requestId:'not-a-uuid'},mem.services),null);
});

test('B4: PATCH rejects an absurd limit without writing anything',async()=>{
  const mem=memoryDb();
  const token=mem.db.vitrines[0].token;
  assert.deepEqual(await update(panelCtx,{token,version:'V1',cars:[{id:v2ids.car,customerLimitCents:3000000000}]},mem.services),{error:'VITRINE_LIMIT_INVALID'});
  assert.equal(mem.patches.length,0);
  const ok=await update(panelCtx,{token,version:'V1',cars:[{id:v2ids.car,customerLimitCents:'25k'}]},mem.services);
  assert.equal(ok.version,'V1');assert.equal(mem.db.vitrine_cars[0].customer_limit_cents,2500000);
});

/* ---------- fila de interesses ---------- */
test('B6: a referred request has no deposit ("a definir"), an owner request keeps it',async()=>{
  const now=new Date().toISOString();
  const data={
    vitrine_requests:[{id:'r1',vitrine_id:ids.vitrine,vitrine_car_id:ids.car,contact_id:'c2',journey_id:null,request_kind:'BID',referred:true,created_at:now},{id:'r2',vitrine_id:ids.vitrine,vitrine_car_id:ids.car,contact_id:'c1',journey_id:null,request_kind:'BID',referred:false,created_at:now}],
    vitrines:[{id:ids.vitrine,contact_id:'c1',journey_id:ids.journey,reference_code:'3CG5P',customer_name:'Carlos',version:'V2',created_at:now}],
    vitrine_cars:[{id:ids.car,vitrine_id:ids.vitrine,vehicle_snapshot:{year:2021,make:'BMW',model:'X3'},customer_limit_cents:1800000}],
    contacts:[{id:'c1',display_name:'Carlos'},{id:'c2',display_name:'Bia'}],contact_phones:[],vitrine_events:[],journeys:[{id:ids.journey,budget_cents:1800000}]
  };
  const {payload}=loadWith('api/panel/vitrine-requests.js',{'../../panel-server':{allRows:async(_ctx,table)=>data[table]||[],isUuid:()=>true,jsonBody:async()=>({}),patchRows:async()=>null,requirePanel:async()=>null,send:()=>null}});
  const out=await payload({environment:'production'});
  assert.equal(out.requests.find((item)=>item.id==='r1').depositUsd,null);
  assert.equal(out.requests.find((item)=>item.id==='r2').depositUsd,1800);
});

/* ---------- headers de seguranca ---------- */
test('B7: /t and /v send anti-framing, referrer and nosniff headers and keep noindex/no-store',()=>{
  const config=JSON.parse(read('vercel.json'));
  for(const source of ['/t/(.*)','/v/(.*)']){
    const entry=config.headers.find((item)=>item.source===source);assert.ok(entry,source);
    const headers=Object.fromEntries(entry.headers.map((item)=>[item.key,item.value]));
    assert.equal(headers['X-Frame-Options'],'DENY');
    assert.equal(headers['Content-Security-Policy'],"frame-ancestors 'none'");
    assert.equal(headers['Referrer-Policy'],'no-referrer');
    assert.equal(headers['X-Content-Type-Options'],'nosniff');
    assert.equal(headers['X-Robots-Tag'],'noindex, nofollow');
    assert.equal(headers['Cache-Control'],'no-store, max-age=0');
  }
});
