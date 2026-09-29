'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const manheim=require('../painel/manheim');const {captureVitrineInterest}=require('../vitrine-webhook');const {removePushMessage}=require('../whatsapp-receiver');const {deposit,expiresAt,extractCode,locationState,publicResponse,publicVehicle,randomCode,randomToken}=require('../vitrine-domain');
const root=path.join(__dirname,'..');const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');
test('real Manheim timestamps, Simulcast preference, units and state are normalized',()=>{
 const csv='Inventory,Vin,Year,Make,Model,Odometer Value,Pickup Location,Starts At,Ends At,Condition Report Grade,Buy Now Price\nTimed Sale,1A,2020,Honda,Civic,20,FL - Miami,2026-09-29T14:00:00Z,2026-09-30T14:00:00Z,0.0,9000\nSimulcast,1A,2020,Honda,Civic,20,FL - Miami,2026-09-29T13:30:00Z,2026-09-29T14:00:00Z,0.0,';
 const parsed=manheim.parseCsv(csv),rows=manheim.chooseAuctionRows(manheim.normalizeRows(parsed,manheim.mapHeaders(parsed.headers)));
 assert.equal(rows.length,1);assert.equal(rows[0].startsAt,'2026-09-29T13:30:00Z');assert.equal(rows[0].conditionGrade,'0.0');assert.equal(rows[0].miles,20);assert.equal(locationState(rows[0].location),'Florida');assert.equal(rows[0].hasBuyNow,true);
});
test('short code has no ambiguous characters and can be read from WhatsApp',()=>{const code=randomCode();assert.match(code,/^MCS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);assert.equal(extractCode('Hey MCS-7K2Q please'),'MCS-7K2Q');assert.equal(extractCode('nothing here'),null);});
test('token is a 43-character base64url value',()=>assert.match(randomToken(),/^[A-Za-z0-9_-]{43}$/));
test('deposit follows the calculator limit rule',()=>{assert.equal(deposit(500000),500);assert.equal(deposit(1200000),1200);});
test('vitrine expires 48 hours after its latest auction, not after creation',()=>{const auction='2026-10-03T12:00:00.000Z';assert.equal(expiresAt([{vehicle:{endsAt:auction}}],Date.parse('2026-09-28T12:00:00.000Z')),'2026-10-05T12:00:00.000Z');});
test('public response is an allowlist, rounds MMR, and never leaks exact auction data',()=>{const vehicle={year:2020,make:'Honda',model:'Civic',vin:'SECRET',seller:'seller',location:'FL - Miami',mmrCents:1000000,conditionGrade:'4.2',startsAt:'2026-09-29T13:30:00Z',cleanTitle:true,odometerOk:true};const output=publicResponse({token:'x'.repeat(32),version:'V1',reference_code:'AB234',customer_name:'Ana',expires_at:'2099-01-01T00:00:00Z'},[{short_code:'MCS-7K2Q',vehicle_snapshot:vehicle,photo_paths:[]}]);const serialized=JSON.stringify(output);for(const forbidden of ['SECRET','seller','conditionGrade','vin','Buy Now','lane','comment','mmrCents'])assert.doesNotMatch(serialized,new RegExp(forbidden,'i'));assert.equal(output.cars[0].vehicle.state,'Florida');assert.equal(output.cars[0].averageAuctionValue,10000);});
test('public route, noindex rewrite, webhook isolation and auto-reply block are present',()=>{assert.match(read('vercel.json'),/"source": "\/v\/:token/);assert.match(read('v/index.html'),/noindex,nofollow/);assert.match(read('whatsapp-receiver.js'),/captureVitrineInterest/);assert.match(read('whatsapp-auto-reply.js'),/VITRINE_INTEREST/);assert.match(read('panel-push.js'),/sendVitrinePush/);});
test('customer copy has no em dash or final periods in required lines',()=>{const source=read('v/vitrine.js');for(const text of ['A reference, not a fixed price','The final price is set on auction day','Tap the car you like and send the message','Our team replies with photos and full details','This auction has ended','Ask us about similar cars'])assert.match(source,new RegExp(text));assert.doesNotMatch(source,/A reference, not a fixed price\.|This auction has ended\./);});
const uuid={car:'11111111-1111-4111-8111-111111111111',vitrine:'22222222-2222-4222-8222-222222222222',owner:'33333333-3333-4333-8333-333333333333',sender:'44444444-4444-4444-8444-444444444444',message:'55555555-5555-4555-8555-555555555555',journey:'66666666-6666-4666-8666-666666666666'};
function webhookServices({tap=false,owner=uuid.owner}={}){
  const calls=[];
  const car={id:uuid.car,vitrine_id:uuid.vitrine,short_code:'MCS-7K2Q',vehicle_snapshot:{year:2020,make:'Honda',model:'Civic'},customer_limit_cents:1200000};
  const vitrine={id:uuid.vitrine,contact_id:owner,journey_id:uuid.journey,reference_code:'3CG5P',version:'V1',expires_at:'2099-01-01T00:00:00.000Z'};
  const rows=async(_ctx,table,params)=>{
    if(table==='vitrine_cars')return params.short_code||params.id?[car]:[];
    if(table==='vitrines')return params.contact_id?(tap?[{id:uuid.vitrine,contact_id:owner}]:[]):[vitrine];
    if(table==='vitrine_events')return tap?[{vitrine_car_id:uuid.car}]:[];
    if(table==='contacts')return[{display_name:'Carlos'}];
    return[];
  };
  return {calls,services:{rows,insert:async(_ctx,table,payload)=>{calls.push({table,payload});return[];},sendVitrinePush:async(_ctx,payload)=>calls.push({table:'push',payload})}};
}
test('captureVitrineInterest handles a WhatsApp code and marks a referred sender',async()=>{const mocked=webhookServices({owner:uuid.owner});const output=await captureVitrineInterest({environment:'production'},{direction:'CUSTOMER',body:'I want MCS-7K2Q',phone:'13055550123'},{messageId:uuid.message,contactId:uuid.sender,journeyId:uuid.journey},mocked.services);assert.deepEqual(output,{handled:true,kind:'VIEW',referred:true});assert.equal(mocked.calls.find((call)=>call.table==='vitrine_requests').payload.referred,true);});
test('captureVitrineInterest uses a tap from the last 15 minutes when no code exists',async()=>{const mocked=webhookServices({tap:true,owner:uuid.sender});const output=await captureVitrineInterest({environment:'production'},{direction:'CUSTOMER',body:'yes'},{messageId:uuid.message,contactId:uuid.sender},mocked.services);assert.equal(output.handled,true);});
test('captureVitrineInterest ignores a message without code or recent tap',async()=>{const mocked=webhookServices();const output=await captureVitrineInterest({environment:'production'},{direction:'CUSTOMER',body:'yes'},{messageId:uuid.message,contactId:uuid.sender},mocked.services);assert.deepEqual(output,{handled:false});});
test('special Vitrine handling removes the ordinary push candidate',()=>{const messages=[{messageId:uuid.message},{messageId:uuid.car}];assert.equal(removePushMessage(messages,uuid.message),true);assert.deepEqual(messages,[{messageId:uuid.car}]);});

/* ===== Fase B (V2) ===== */
const {createV2,limitCents}=require('../api/panel/vitrines');
const {savePhoto,imageType,MAX_BYTES}=require('../api/panel/vitrine-photos');
const v2ids={v1:'77777777-7777-4777-8777-777777777777',car:'88888888-8888-4888-8888-888888888888',request:'99999999-9999-4999-8999-999999999999',journey:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',contact:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',match:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'};
function memoryDb({treated=null,carMissing=false}={}){
  const db={
    vitrines:[{id:v2ids.v1,environment:'production',token:'T'.repeat(43),version:'V1',journey_id:v2ids.journey,contact_id:v2ids.contact,reference_code:'3CG5P',customer_name:'Carlos',expires_at:'2099-01-01T00:00:00.000Z'}],
    vitrine_cars:carMissing?[]:[{id:v2ids.car,environment:'production',vitrine_id:v2ids.v1,source_match_id:v2ids.match,short_code:'MCS-7K2Q',vehicle_snapshot:{year:2021,make:'BMW',model:'X3',vin:'SECRETVIN',mmrCents:2580000,startsAt:'2099-01-01T12:00:00Z'},customer_limit_cents:1790000,note_text:null,photo_paths:[]}],
    vitrine_requests:[{id:v2ids.request,environment:'production',vitrine_id:v2ids.v1,vitrine_car_id:v2ids.car,treated_at:treated}],
    journeys:[{id:v2ids.journey,environment:'production',budget_cents:1800000}]
  };
  let seq=0;
  const match=(row,params)=>Object.entries(params).every(([key,value])=>['select','limit','order','offset'].includes(key)||String(row[key])===String(value).replace(/^eq\./,''));
  const services={
    rows:async(_ctx,table,params)=>(db[table]||[]).filter((row)=>match(row,params)).map((row)=>JSON.parse(JSON.stringify(row))),
    insert:async(_ctx,table,payload)=>{const row={id:'dddddddd-dddd-4ddd-8ddd-'+String(++seq).padStart(12,'0'),...payload};(db[table]=db[table]||[]).push(row);return [row];}
  };
  return {db,services};
}
const panelCtx={environment:'production',panel:{id:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'}};
test('V2 is a new vitrine: the origin V1 keeps its token, version and cars untouched',async()=>{
  const {db,services}=memoryDb();const before=JSON.stringify({v:db.vitrines[0],c:db.vitrine_cars[0]});
  const out=await createV2(panelCtx,{requestId:v2ids.request,noteText:'Clean car'},services);
  assert.equal(JSON.stringify({v:db.vitrines[0],c:db.vitrine_cars[0]}),before);
  const v2=db.vitrines.find((row)=>row.id===out.vitrineId),car=db.vitrine_cars.find((row)=>row.id===out.carId);
  assert.equal(v2.version,'V2');assert.equal(v2.parent_vitrine_id,v2ids.v1);assert.notEqual(v2.token,db.vitrines[0].token);assert.match(v2.token,/^[A-Za-z0-9_-]{43}$/);
  assert.equal(out.link,'/v/'+v2.token);assert.equal(v2.journey_id,v2ids.journey);assert.equal(v2.customer_name,'Carlos');
  assert.notEqual(car.short_code,'MCS-7K2Q');assert.match(car.short_code,/^MCS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
  assert.equal(car.source_match_id,v2ids.match);assert.deepEqual(car.vehicle_snapshot,db.vitrine_cars[0].vehicle_snapshot);assert.deepEqual(car.photo_paths,[]);
  assert.equal(car.customer_limit_cents,1800000,'defaults to journeys.budget_cents');assert.equal(car.note_text,'Clean car');
  assert.equal(db.vitrine_cars.filter((row)=>row.vitrine_id===out.vitrineId).length,1,'only the car the client asked for');
});
test('V2 limit: explicit value wins, blank hides the block',()=>{assert.equal(limitCents({customerLimitCents:2000000},{budget_cents:1800000}),2000000);assert.equal(limitCents({customerLimitCents:null},{budget_cents:1800000}),null);assert.equal(limitCents({},{budget_cents:1800000}),1800000);});
test('V2 creation rejects a treated request and a missing car',async()=>{
  assert.deepEqual(await createV2(panelCtx,{requestId:v2ids.request},memoryDb({treated:'2026-09-28T00:00:00Z'}).services),{error:'VITRINE_REQUEST_TREATED'});
  assert.deepEqual(await createV2(panelCtx,{requestId:v2ids.request},memoryDb({carMissing:true}).services),{error:'VITRINE_CAR_MISSING'});
});
const jpeg=(size=64)=>{const buffer=Buffer.alloc(size);buffer[0]=0xff;buffer[1]=0xd8;buffer[2]=0xff;return buffer;};
function photoServices(paths=[]){const uploads=[],patches=[];return {uploads,patches,services:{rows:async(_ctx,_table,params)=>params.id==='eq.'+v2ids.car&&params.vitrine_id==='eq.'+v2ids.v1?[{id:v2ids.car,vitrine_id:v2ids.v1,photo_paths:paths}]:[],upload:async(_ctx,path,buffer,type)=>uploads.push({path,type,size:buffer.length}),patchRows:async(_ctx,_table,_filters,payload)=>patches.push(payload)}};}
test('photo endpoint rejects non-image and oversized files, and checks the car belongs to the vitrine',async()=>{
  const mocked=photoServices();
  assert.equal((await savePhoto(panelCtx,{vitrineId:v2ids.v1,carId:v2ids.car,buffer:Buffer.from('%PDF-1.7 not an image at all')},mocked.services)).status,415);
  assert.equal((await savePhoto(panelCtx,{vitrineId:v2ids.v1,carId:v2ids.car,buffer:jpeg(MAX_BYTES+1)},mocked.services)).status,413);
  assert.equal((await savePhoto(panelCtx,{vitrineId:v2ids.v1,carId:v2ids.journey,buffer:jpeg()},mocked.services)).status,404);
  assert.equal(mocked.uploads.length,0);
  assert.equal(imageType(jpeg()),'image/jpeg');assert.equal(imageType(Buffer.from('GIF89a-not-allowed')),null);
});
test('photo endpoint stores vitrine-photos/<vitrine_id>/<uuid>.jpg and keeps order (first = cover)',async()=>{
  const mocked=photoServices(['cover.jpg']);const out=await savePhoto(panelCtx,{vitrineId:v2ids.v1,carId:v2ids.car,buffer:jpeg()},mocked.services);
  assert.equal(out.status,201);assert.match(out.path,new RegExp('^'+v2ids.v1+'/[0-9a-f-]{36}\\.jpg$'));assert.deepEqual(mocked.patches[0].photo_paths,['cover.jpg',out.path]);
  assert.equal((await savePhoto(panelCtx,{vitrineId:v2ids.v1,carId:v2ids.car,buffer:jpeg()},photoServices(Array(12).fill('x.jpg')).services)).status,409);
});
test('public V2 response keeps the allowlist (no VIN, no mmrCents) and shows limit and note',()=>{
  const output=publicResponse({token:'y'.repeat(43),version:'V2',reference_code:'3CG5P',customer_name:'Carlos',expires_at:'2099-01-01T00:00:00Z'},[{short_code:'MCS-9ABC',vehicle_snapshot:{year:2021,make:'BMW',model:'X3',vin:'SECRETVIN',mmrCents:2580000,startsAt:'2099-01-01T12:00:00Z'},customer_limit_cents:1800000,note_text:'Clean car',photo_paths:['a.jpg']}],[['https://signed/a']]);
  const serialized=JSON.stringify(output);for(const forbidden of ['SECRETVIN','vin','mmrCents','photo_paths'])assert.doesNotMatch(serialized,new RegExp(forbidden,'i'));
  assert.equal(output.version,'V2');assert.equal(output.cars[0].customerLimitCents,1800000);assert.equal(output.cars[0].note,'Clean car');assert.deepEqual(output.cars[0].photos,['https://signed/a']);
});
test('HOJE card deposit line: deposit() over the car limit',()=>{
  assert.equal(deposit(1800000),1800);assert.equal(deposit(400000),500);assert.equal(deposit(500000),500);assert.equal(deposit(500100),500);
  assert.match(read('api/panel/vitrine-requests.js'),/depositUsd:request\.referred\?null:limit\?deposit\(limit\):null/);
  assert.match(read('api/panel/vitrine-requests.js'),/vitrineId:request\.vitrine_id,vitrineCarId:request\.vitrine_car_id/);
  assert.match(read('painel/painel.js'),/Próximo passo: pedir o depósito · US\$ /);
});
test('V2 page keeps the approved spec and customer copy has no em dash or trailing period',()=>{
  const page=read('v/vitrine.js');
  for(const text of ["here's the car you asked to see",'I want to bid','Opens WhatsApp with a ready message to our team','Hey, I want to bid on the','Your limit','You set the limit, we do the bidding','Your limit is the most we\'ll bid, not what you pay','If we win it for less, you pay based on the winning bid','Clean title','Odometer OK','Mileage','Location','Exterior','Interior','Drivetrain','Transmission','Engine','Auction day','Average auction value'])assert.ok(page.includes(text),text);
  for(const banned of ['Carfax','Buy Now','Not for me','—'])assert.ok(!page.includes(banned),banned);
  const builder=read('painel/painel.js');assert.match(builder,/\$\{request\.name\}, here's the car you asked to see\\n\$\{link\}`/);assert.doesNotMatch(builder,/here's the car you asked to see\.`/);
});
test('migration for V2 is additive and newer than the V1 migration',()=>{
  const files=fs.readdirSync(path.join(root,'supabase','migrations')).filter((name)=>name.endsWith('.sql')).sort();
  const v2=files.find((name)=>/vitrine_v2_parent/.test(name));assert.ok(v2);assert.ok(v2.split('_')[0]>'20260928030000');
  const sql=read('supabase/migrations/'+v2);assert.match(sql,/add column if not exists parent_vitrine_id uuid/);assert.doesNotMatch(sql,/drop |truncate |delete from/i);
});
