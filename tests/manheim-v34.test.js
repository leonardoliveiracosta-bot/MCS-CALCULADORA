'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const offer=require('../manheim-offer'),audit=require('../panel-manheim-audit'),batch=require('../panel-manheim-batch');
const id=n=>`34340000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=id(1),journey=id(2),contact=id(3),upload=id(4),key=`journey:${journey}:CARRO`;
const future=new Date(Date.now()+7*86400000).toISOString(),past=new Date(Date.now()-86400000).toISOString();
const p={vin:'4T1BF1FK5EU310551',year:2020,make:'Toyota',model:'Camry',miles:50000,mmrCents:1500000,conditionGrade:'3',cleanTitle:true,odometerOk:true,endsAt:future};
const row=(n,sale)=>({id:id(n),journey_id:journey,upload_id:upload,demand_key:key,demandKey:key,logical_mode:'CARRO',match_kind:'BATE',mmr_cents:p.mmrCents,row_fingerprint:'entry:'+n,vehicle_json:{parsed:{...p,...sale}}});
const buy=row(10,{lane:'',run:'',buyNowPrice:'11700',saleType:'OVE'}),lane=row(11,{lane:'7',run:'103',startsAt:future,saleType:'Simulcast'});
const target={key,journeyId:journey,mode:'CARRO',targetType:'JOURNEY',active:true,activeWishes:[{make:'Toyota',model:'Camry',yearMin:2019}],wishes:[{make:'Toyota',model:'Camry',yearMin:2019}],issues:[]};
const input=matches=>({upload:{id:upload},demands:[target],matches,base:{calcRuns:[],journeyById:new Map([[journey,{id:journey,status:'ATIVO',contact:{is_lead:true}}]])}});
test('v3.4 shared grouping: one VIN, primary Lane, both sales, expiration and distinct VINs',()=>{
 const [g]=offer.groupVehicles([buy,lane]);assert.equal(g.id,lane.id);assert.equal(g.vehicle_json.parsed.purchaseOptions.length,2);assert.equal(offer.classify(g.vehicle_json.parsed,p.mmrCents).group,'LANE');
 assert.equal(audit.buildGroups(input([buy,lane]))[0].options.length,1);assert.deepEqual(audit.buildGroups(input([buy,lane]))[0].divergences,[]);
 const ended={...buy,vehicle_json:{parsed:{...buy.vehicle_json.parsed,endsAt:past}}};
 assert.equal(offer.groupVehicles([ended,lane])[0].vehicle_json.parsed.purchaseOptions.length,1);
 assert.deepEqual(offer.groupVehicles([{...ended,vehicle_json:{parsed:{...p,endsAt:past}}}]),[]);
 assert.equal(offer.groupVehicles([buy,lane,row(12,{vin:'OTHER'})]).length,2);
 assert.deepEqual(offer.groupVehicles(offer.groupVehicles([buy,lane])),offer.groupVehicles([buy,lane]));
});
test('v3.4 duplicate-only reviews release with audit trail, other reasons stay blocked',async()=>{
 const records=[{id:id(20),demand_key:key,status:'REVISAR',content_hash:'old',divergences:[{code:'VIN_DUPLICATE'}]},{id:id(21),demand_key:'other',status:'REVISAR',content_hash:'other',divergences:[{code:'YEAR_OUT_OF_RANGE'}]}];const writes=[],patches=[];
 const out=await audit.releaseVinReviews({environment:'preview',panel:{id:actor}},input([buy,lane]),{auditRows:async()=>records,insert:async(_,table,body)=>writes.push({table,body}),patchRows:async(_,table,filter,body)=>patches.push({table,filter,body})});
 assert.equal(out.released,1);assert.equal(patches[0].filter.id,'eq.'+id(20));assert.ok(writes.some(w=>w.table==='audit_log'&&w.body.action==='VIN_GROUP_V34_RELEASE'));assert.ok(writes.some(w=>w.table==='manheim_match_audits'&&w.body.status==='CONFERIDO'));
});
test('v3.4 database pagination, counts, legacy selection, duplicate send and V1 to V2',async()=>{
 Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'test',SUPABASE_SECRET_KEY:'test'});
 const backend=await require('./fixtures/banco-simulado').createBackend();global.fetch=backend.fetch;
 const server=require('../panel-server'),ctx={environment:'preview',panel:{id:actor},config:{url:'http://banco-simulado.local',secretKey:'test'}};
 const db=backend.db,q=async(s,a=[])=>(await db.query(s,a)).rows;
 try{
  await db.exec(`insert into panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${actor}','preview','${actor}','v34@test.test','admin',true,false);insert into contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Teste','WHATSAPP_DIRECT',now(),now());insert into journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());insert into manheim_uploads(id,environment,created_by,source_file_count,vehicle_count,matched_vehicle_count,lead_count,headers_json,header_map,activated_at) values('${upload}','preview','${actor}',2,3,3,1,'[]','{}',now());`);
  for(const r of [buy,lane,row(12,{vin:'OTHER',lane:'2',run:'1'})])await q('insert into manheim_matches(id,environment,upload_id,journey_id,logical_mode,demand_key,match_kind,row_fingerprint,vehicle_json,mmr_cents,vin) values($1,\'preview\',$2,$3,\'CARRO\',$4,\'BATE\',$5,$6,$7,$8)',[r.id,upload,journey,key,r.row_fingerprint,JSON.stringify(r.vehicle_json),p.mmrCents,offer.vinOf(r)]);
  // Existing selection belongs to the OVE entry; grouping must not rewrite it.
  await q("insert into manheim_option_selections(environment,match_id,upload_id,demand_key,status,offer_group,mmr_cents,default_pct,final_cents,updated_by,manual,manual_reason) values('preview',$1,$2,$3,'SELECTED','OFFLANE',1500000,8,1620000,$4,true,'Escolha anterior OVE')",[buy.id,upload,key,actor]);
  const call=(fn,args)=>server.rpc(ctx,fn,{p_environment:'preview',p_upload_id:upload,...args});
  let summary=await call('panel_manheim_offer_summary',{});assert.deepEqual([summary[0].lane_count,summary[0].offlane_count,summary[0].selected_count],[2,0,1]);
  assert.deepEqual(summary[0].selected_ids,[buy.id]);
  const page=await call('panel_manheim_offer_page',{p_demand_key:key,p_group:'LANE',p_offset:0,p_limit:10});assert.equal(page.length,2);assert.equal(page.find(r=>r.id===lane.id).selection_status,'SELECTED');assert.equal(page.find(r=>r.id===lane.id).vehicle_json.parsed.purchaseOptions.length,2);
  const sorted=await call('panel_manheim_offer_page_sorted',{p_demand_key:key,p_group:'LANE',p_sort:'year_desc',p_offset:0,p_limit:1});assert.equal(sorted[0].total_in_group,2);
  assert.equal((await call('panel_manheim_batch_summary',{}))[0].match_count,2);
  const sel=await server.rpc(ctx,'panel_manheim_offer_select_v2',{p_environment:'preview',p_actor_id:actor,p_match_id:lane.id,p_action:'SELECT',p_manual_pct:null,p_reason:null,p_note:null,p_final_cents:null});assert.equal(sel.selectedCount,1);assert.equal(sel.matchId,buy.id);
  const services={rows:server.rows,insert:server.insert,patchRows:server.patchRows,auditGate:async()=>null,stampGate:async()=>null,activeFilter:async()=>({})};
  const vit=require('../api/panel/vitrines');
  assert.equal((await vit.create(ctx,{journeyId:journey,matchIds:[buy.id,lane.id]},services)).error,'VITRINE_VIN_DUPLICATE');
  const v1=await vit.create(ctx,{journeyId:journey,matchIds:[buy.id]},services);assert.ok(v1.token,JSON.stringify(v1));
  const [vitrine]=await q('select id from vitrines where token=$1',[v1.token]);const [car]=await q('select * from vitrine_cars where vitrine_id=$1',[vitrine.id]);assert.equal(car.vehicle_snapshot.purchaseOptions.length,2);
  await q("insert into vitrine_requests(id,environment,vitrine_id,vitrine_car_id,request_kind) values($1,'preview',$2,$3,'VIEW')",[id(50),vitrine.id,car.id]);
  const v2=await vit.createV2(ctx,{requestId:id(50)},services);assert.ok(v2.token,JSON.stringify(v2));assert.equal((await q('select vehicle_snapshot from vitrine_cars where vitrine_id=$1',[v2.vitrineId]))[0].vehicle_snapshot.purchaseOptions.length,2);
  await q("update manheim_matches set vehicle_json=jsonb_set(vehicle_json,'{parsed,endsAt}',to_jsonb($1::text)) where id=$2",[past,buy.id]);
  const [g]=await call('panel_manheim_grouped_options',{p_demand_key:key});assert.ok(g);assert.equal((await server.rpc(ctx,'panel_manheim_grouped_matches',{p_environment:'preview',p_match_ids:[buy.id]})).length,1);
  await q("update manheim_matches set vehicle_json=jsonb_set(vehicle_json,'{parsed,endsAt}',to_jsonb($1::text)) where id=$2",[past,lane.id]);
  // Leilão passado (20261027010000): o carro selecionado (entrada OVE) continua, o resto sai.
  assert.deepEqual([(await call('panel_manheim_offer_summary',{}))[0].lane_count,(await call('panel_manheim_offer_summary',{}))[0].offlane_count],[1,1]);
  assert.equal((await q('select count(*) n from manheim_matches'))[0].n,3);assert.equal((await q('select count(*) n from vitrines'))[0].n,2);assert.deepEqual(backend.refused,[]);
  await q("insert into manheim_matches(environment,upload_id,journey_id,logical_mode,demand_key,match_kind,row_fingerprint,vehicle_json,mmr_cents) select environment,upload_id,journey_id,logical_mode,demand_key,match_kind,'perf:'||n,jsonb_set(vehicle_json,'{parsed,vin}',to_jsonb('PERF'||n)),mmr_cents from manheim_matches cross join generate_series(1,2000) n where id=$1",[id(12)]);
  const started=Date.now();assert.equal((await call('panel_manheim_batch_summary',{}))[0].match_count,2002);assert.ok(Date.now()-started<5000,'agrupamento de 2 mil opções deve continuar rápido');
 }finally{await db.close();}
});
