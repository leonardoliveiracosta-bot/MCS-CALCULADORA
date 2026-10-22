'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {PGlite}=require('@electric-sql/pglite');
const api=require('../api/panel/manual-vitrines');
const {publicResponse}=require('../vitrine-domain');
const {resetUndoSupport}=require('../panel-manheim-state');
const ACTOR='11111111-1111-4111-8111-111111111111',ID='22222222-2222-4222-8222-222222222222',UPLOAD='33333333-3333-4333-8333-333333333333';
const VIN='1C4RJKBG0P8004352',ctx={environment:'preview',panel:{id:ACTOR},config:{url:'manual-test'}};
let db,stock,services;
test.before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create type panel_environment as enum('preview','production');
 create table panel_users(id uuid primary key);insert into panel_users values('${ACTOR}');
 create table vitrines(id uuid primary key default gen_random_uuid(),environment panel_environment not null,token text not null,reference_code text not null,customer_name text,version text,expires_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),created_by uuid references panel_users,contact_id uuid,journey_id uuid,parent_vitrine_id uuid,unique(environment,token));
 create table vitrine_cars(id uuid primary key default gen_random_uuid(),environment panel_environment not null,vitrine_id uuid references vitrines on delete cascade,source_match_id uuid,short_code text not null,vehicle_snapshot jsonb not null,customer_limit_cents integer,note_text text,photo_paths jsonb default '[]',created_at timestamptz default now(),unique(environment,short_code));
 alter table vitrines enable row level security;alter table vitrine_cars enable row level security;revoke all on vitrines,vitrine_cars from public,anon,authenticated;grant all on vitrines,vitrine_cars to service_role;`);
 await db.exec(fs.readFileSync('supabase/migrations/20261022035311_manual_vitrines.sql','utf8'));
});
test.after(async()=>db.close());
function apply(rows,params){return rows.filter(row=>Object.entries(params).every(([key,value])=>{
 if(['select','order','limit'].includes(key))return true;let target=key==='vehicle_json->>vin'?row.vehicle_json.vin:row[key];
 if(value==='is.null')return target==null;if(value==='not.is.null')return target!=null;
 if(value.startsWith('eq.'))return String(target)===value.slice(3);
 if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(String(target));
 if(value.startsWith('ilike.*'))return String(target).endsWith(value.slice(7));
 throw Error('Unexpected filter '+key+':'+value);
})).slice(0,Number(params.limit)||1000);}
test.beforeEach(async()=>{
 await db.exec('truncate vitrines cascade');resetUndoSupport();
 stock=[{id:ID,upload_id:UPLOAD,environment:'preview',undone_at:null,vehicle_json:{year:2023,make:'Jeep',model:'Grand Cherokee L',vin:VIN,mmrCents:2500000,cleanTitle:true,odometerOk:true,startsAt:'2099-10-22T15:00:00Z',endsAt:'2099-10-22T18:00:00Z',engine:'6-cylinder',transmission:'Automatic',drivetrain:'AWD',interiorColor:'Black'}}];
 services={rows:async(_ctx,table,params)=>apply(table==='manheim_uploads'?[{id:UPLOAD,environment:'preview',undone_at:null,activated_at:'2026-10-01',uploaded_at:'2026-10-01'}]:table==='manheim_vehicles'?stock:(await db.query('select * from '+table)).rows,params),rpc:async(_ctx,name,args)=>(await db.query(`select ${name}($1,$2,$3,$4,$5,$6) as value`,[args.p_environment,args.p_actor,args.p_request,args.p_hash,args.p_vitrine,args.p_cars])).rows[0].value};
});
const body=(extra={})=>({version:'V1',requestKey:'44444444-4444-4444-8444-444444444444',name:'Alex',phone:'305 555 0100',cars:[{id:ID,pct:5}],...extra});
test('manual V1 needs no message, contact, journey or Ref; the transaction stores source-backed data and retry reuses the link',async()=>{
 const first=await api.create(ctx,body(),services),second=await api.create(ctx,body(),services);assert.equal(first.token,second.token);assert.equal(second.reused,true);assert.equal(first.phone,'+13055550100');
 const vitrine=(await db.query('select * from vitrines')).rows[0];assert.equal(vitrine.journey_id,null);assert.equal(vitrine.contact_id,null);assert.equal(vitrine.reference_code,'');assert.equal(vitrine.created_by,ACTOR);
 const cars=(await db.query('select * from vitrine_cars')).rows;assert.equal(cars.length,1);assert.equal(cars[0].vehicle_snapshot.estimatedMarketReference,26250);assert.equal(cars[0].vehicle_snapshot.engine,'6-cylinder');
 const publicData=publicResponse(vitrine,cars);const text=JSON.stringify(publicData);for(const privateData of ['3055550100','recipient_phone','manual_payload_hash','manualSourceIds',VIN])assert.ok(!text.includes(privateData));assert.equal(publicData.cars[0].vinLast6,'004352');
 await assert.rejects(()=>api.create(ctx,body({name:'Changed'}),services),{code:'MANUAL_DRAFT_CHANGED'});
});
test('manual V2 has no parent V1 or customer request, keeps its optional limit and note, and supports a share-only link',async()=>{
 const result=await api.create(ctx,body({version:'V2',phone:'',customerLimitCents:'30k',note:'Customer-facing note'}),services);
 const vitrine=(await db.query('select * from vitrines')).rows[0],cars=(await db.query('select * from vitrine_cars')).rows;
 assert.equal(result.phone,null);assert.equal(vitrine.parent_vitrine_id,null);assert.equal(vitrine.version,'V2');assert.equal(cars[0].customer_limit_cents,3000000);assert.equal(cars[0].note_text,'Customer-facing note');
 const output=publicResponse(vitrine,cars);assert.equal(output.independent,true);const context={window:{}};require('node:vm').runInNewContext(fs.readFileSync('v/vitrine-render.js','utf8'),context);const html=context.window.MCSVitrineRender.page(output,false);assert.ok(html.includes('here are the photos and details'));assert.ok(!html.includes('asked to see'));assert.equal(output.cars[0].customerLimitCents,3000000);assert.equal(output.cars[0].note,'Customer-facing note');
});
test('search accepts the last six VIN digits, groups sale options and excludes withdrawn, expired and ineligible cars',async()=>{
 assert.equal((await api.search(ctx,'004352',services)).cars[0].id,ID);
 stock[0].undone_at='2026-10-01';assert.equal((await api.search(ctx,VIN,services)).cars.length,0);stock[0].undone_at=null;
 for(const change of [{mmrCents:null},{cleanTitle:false},{odometerOk:false},{endsAt:'2020-01-01'}]){const old=stock[0].vehicle_json;stock[0].vehicle_json={...old,...change};assert.equal((await api.search(ctx,VIN,services)).cars.length,0);stock[0].vehicle_json=old;}
 await assert.rejects(()=>api.search(ctx,'123',services),{code:'MANUAL_VIN_INVALID'});
});
test('server rejects forged cars, invalid phone, price, duplicate selection and extra V2 cars before creating anything',async()=>{
 for(const [extra,code] of [[{phone:'abc'},'MANUAL_PHONE_INVALID'],[{cars:[{id:ID,pct:51}]},'MANUAL_PRICE_INVALID'],[{cars:[{id:ID},{id:ID}]},'MANUAL_CARS_INVALID'],[{version:'V2',cars:[{id:ID},{id:UPLOAD}]},'MANUAL_CARS_INVALID'],[{cars:[{id:UPLOAD}]},'MANUAL_CAR_UNAVAILABLE']])await assert.rejects(()=>api.create(ctx,body(extra),services),{code});
 assert.equal((await db.query('select count(*)::int as n from vitrines')).rows[0].n,0);
});
test('failed car insertion rolls back the whole presentation and the new RPC is unavailable to anon/authenticated',async()=>{
 const args={p_environment:'preview',p_actor:ACTOR,p_request:body().requestKey,p_hash:'a'.repeat(64),p_vitrine:{version:'V1',token:'test',expires_at:'2099-01-01'},p_cars:[{short_code:'MCS-7K2Q',vehicle_snapshot:{estimatedMarketReference:10000}},{short_code:'MCS-8K2Q'}]};
 await assert.rejects(()=>services.rpc(ctx,'panel_manual_vitrine_create',args));assert.equal((await db.query('select count(*)::int as n from vitrines')).rows[0].n,0);
 const permissions=(await db.query("select has_function_privilege('anon','panel_manual_vitrine_create(panel_environment,uuid,uuid,text,jsonb,jsonb)','execute') as anon,has_function_privilege('authenticated','panel_manual_vitrine_create(panel_environment,uuid,uuid,text,jsonb,jsonb)','execute') as authenticated")).rows[0];assert.deepEqual(permissions,{anon:false,authenticated:false});
});
test('concurrent retries create one presentation and later V2 creation rejects a withdrawn manual source',async()=>{
 const [one,two]=await Promise.all([api.create(ctx,body(),services),api.create(ctx,body(),services)]);assert.equal(one.token,two.token);assert.equal((await db.query('select count(*)::int as n from vitrines')).rows[0].n,1);
 const snapshot=(await db.query('select vehicle_snapshot from vitrine_cars')).rows[0].vehicle_snapshot;assert.ok(await api.refreshVehicle(ctx,snapshot,services));stock[0].undone_at='2026-10-01';assert.equal(await api.refreshVehicle(ctx,snapshot,services),null);
});
test('history returns manual links by version without creating messages or modifying legacy records',async()=>{
 await api.create(ctx,body(),services);await api.create(ctx,body({version:'V2',requestKey:'55555555-5555-4555-8555-555555555555'}),services);
 const v1=await api.history(ctx,'V1',services),v2=await api.history(ctx,'V2',services);assert.equal(v1.items.length,1);assert.equal(v2.items.length,1);assert.equal(v1.items[0].cars[0].vinLast6,'004352');assert.equal(v2.items[0].version,'V2');
});
