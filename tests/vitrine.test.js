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
