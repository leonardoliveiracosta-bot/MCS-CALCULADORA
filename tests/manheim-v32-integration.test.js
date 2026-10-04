'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'test',SUPABASE_SECRET_KEY:'test'});
const {createBackend}=require('./fixtures/banco-simulado'),batch=require('../panel-manheim-batch');
const id=n=>`12340000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let backend;const ctx={environment:'preview',panel:{id:id(1)},config:{url:'http://banco-simulado.local',secretKey:'test'}};
const {rpc}=require('../panel-server');
const seed=`insert into panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);
insert into contacts(id,environment,display_name,source,created_at,updated_at) values('${id(2)}','preview','Teste v32','WHATSAPP_DIRECT',now(),now());
insert into journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(3)}','preview','${id(2)}','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
insert into chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(4)}','preview','WHATSAPP','${id(2)}','wa:+13055551111','RESOLVED',false,now(),now(),now(),now());
insert into messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(5)}','preview','${id(4)}','WHATSAPP','CUSTOMER','I want a Toyota Camry budget $9000','x',now(),'v32-message',1,'WHATSAPP_WEBHOOK',now());
insert into message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(5)}','${id(3)}','IMPORT',now());`;
test.before(async()=>{backend=await createBackend({seed});global.fetch=backend.fetch;require('../panel-manheim-state').resetUndoSupport();});
test.after(async()=>{if(backend)await backend.db.close();});
test('v3.2 30 complete files, versioned editing, manual attention and dynamic aliases',async()=>{
 const search=require('../panel-search-requests');const extracted=await search.extractChat(ctx,id(4));assert.ok(extracted.requests);
 const base=await require('../panel-buscas').loadBuscasBase(ctx),targets=batch.snapshotTargets(require('../panel-buscas-view').demandContext(base).targets);assert.equal(targets.length,1);assert.equal(targets[0].wishes[0].budgetUsd,9000);
 const blocks=Array.from({length:30},(_,i)=>[batch.sanitizeVehicle({fingerprint:'vin:V32'+i,vehicle:{vin:'V32'+i,year:2020,make:'Toyota',model:'Camry',miles:50000,mmrCents:i<15?800000:1600000,lane:'',run:'',buyNowPrice:'18000',conditionGrade:'3'}})]);
 const files=blocks.map((entries,i)=>({name:i+'.csv',size:100,rowCount:1,vehicleCount:1,chunkCount:1,chunks:[{count:1,hash:batch.contentHash(entries)}]}));
 const start=await rpc(ctx,'panel_manheim_batch_start',{p_environment:'preview',p_actor_id:id(1),p_client_key:'a'.repeat(32),p_vehicle_count:30,p_headers:[],p_header_map:{},p_files:files,p_manifest_hash:batch.contentHash(files),p_targets:targets,p_targets_hash:batch.targetsHash(targets)});
 const uploadId=start.uploadId;assert.ok(uploadId);
 for(let i=0;i<30;i++){
  if(i===29)await assert.rejects(()=>rpc(ctx,'panel_manheim_batch_finalize',{p_environment:'preview',p_actor_id:id(1),p_upload_id:uploadId}),e=>e.code==='MANHEIM_BATCH_INCOMPLETE');
  const entries=blocks[i];await rpc(ctx,'panel_manheim_batch_chunk',{p_environment:'preview',p_actor_id:id(1),p_upload_id:uploadId,p_file_index:i,p_chunk_index:0,p_chunk_hash:files[i].chunks[0].hash,p_received_count:1,p_vehicles:entries,p_matches:batch.matchChunk(entries,targets,undefined,{staging:true})});
 }
 await rpc(ctx,'panel_manheim_batch_finalize',{p_environment:'preview',p_actor_id:id(1),p_upload_id:uploadId});
 assert.equal((await backend.db.query('select count(*) n from manheim_matches where undone_at is null')).rows[0].n,15);
 const api=require('../api/panel/pesquisas');let list=await api.buildList(ctx);let item=list.items.find(x=>x.source==='CONVERSA');assert.ok(item);
 const changed=await api.editRequest(ctx,{key:item.key,criteriaHash:item.criteriaHash,wishIndex:0,patch:{budgetUsd:18000}});assert.equal(changed.status,200);assert.equal(changed.options[0].matches,15);
 let versions=(await backend.db.query('select criteria_json,edited_by from vehicle_request_versions order by created_at,id')).rows;assert.equal(versions.length,2);assert.equal(versions[0].criteria_json.budgetUsd,9000);assert.equal(versions[1].criteria_json.budgetUsd,18000);assert.equal(versions[1].edited_by,id(1));
 assert.equal((await backend.db.query("select count(*) n from audit_log where entity_type='vehicle_request' and action='EDIT'")).rows[0].n,1);
 assert.equal((await backend.db.query('select min(mmr_cents) n from manheim_matches where undone_at is null')).rows[0].n,1600000);
 list=await api.buildList(ctx);item=list.items.find(x=>x.source==='CONVERSA');
 assert.equal((await api.editRequest(ctx,{key:item.key,criteriaHash:'old',patch:{budgetUsd:1}})).status,409);
 const unknown=await api.editRequest(ctx,{key:item.key,criteriaHash:item.criteriaHash,patch:{model:'Xyz'}});assert.equal(unknown.status,200);
 list=await api.buildList(ctx);item=list.items.find(x=>x.source==='CONVERSA');assert.equal(item.state,'SEM_OPCAO');assert.equal(item.manualReason,'modelo não reconhecido');
 await backend.db.exec("insert into model_aliases(make,client_model,manheim_models,kind,target_make) values('Toyota','Xyz',array['Camry'],'EQUIVALENT','Toyota')");
 delete ctx.modelAliasesLoaded;list=await api.buildList(ctx);item=list.items.find(x=>x.source==='CONVERSA');assert.notEqual(item.manualReason,'modelo não reconhecido');
 const out=await search.compareItems(ctx,[item],{services:{upsertCheck:async()=>{}}});assert.equal(out.results[0].count,15);
 assert.deepEqual(backend.refused,[]);
});

test('v3.3 rematch adds cheaper FIND options without losing selections or sent snapshots',async()=>{
 const api=require('../api/panel/pesquisas'), rematch=require('../panel-rematch');
 let list=await api.buildList(ctx),item=list.items.find(x=>x.source==='CONVERSA');
 const edited=await api.editRequest(ctx,{key:item.key,criteriaHash:item.criteriaHash,patch:{model:'Camry',yearMin:2019,budgetUsd:18000}});
 assert.equal(edited.status,200);
 const key=`journey:${id(3)}:CARRO`;
 const query=async(sql,args=[])=>(await backend.db.query(sql,args)).rows;
 const [selected]=await query("select id,upload_id from manheim_matches where demand_key=$1 and mmr_cents=1600000 and undone_at is null order by id limit 1",[key]);
 assert.ok(selected);
 // Reproduce a v3.2 lot: the cheaper cars had been filtered by its lower budget bound.
 await backend.db.query("update manheim_matches set undone_at=now() where demand_key=$1 and mmr_cents=800000",[key]);
 await rpc(ctx,'panel_manheim_offer_select_v2',{p_environment:'preview',p_actor_id:id(1),p_match_id:selected.id,p_action:'SELECT',p_manual_pct:null,p_reason:'Cliente aceita Buy Now',p_note:'Preservar esta seleção',p_final_cents:null});
 const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this;},json(value){this.payload=value;return value;},end(){}};
 await require('../api/panel/vitrines')({method:'POST',url:'/api/panel/vitrines',headers:{authorization:'Bearer token-simulado'},body:{journeyId:id(3),matchIds:[selected.id],demandKey:key}},res);
 assert.equal(res.statusCode,201,JSON.stringify(res.payload));
 const snapshot=async()=>({
  selections:await query('select * from manheim_option_selections order by id'),
  vitrines:await query('select * from vitrines order by id'),
  cars:await query('select * from vitrine_cars order by id'),
  messages:await query('select * from messages order by id'),
  inventory:await query('select id,row_fingerprint,vehicle_json,undone_at from manheim_vehicles order by id')
 });
 const before=await snapshot();
 const [done]=await rematch.rematchDemands(ctx,[key]);
 assert.equal(done.status,'DONE');assert.equal(done.matches,30);
 assert.deepEqual(await snapshot(),before,'seleção, V1, mensagens e inventário permanecem intactos');
 const rows=await query('select id,vehicle_json from manheim_matches where demand_key=$1 and undone_at is null order by id',[key]);
 assert.ok(rows.some(row=>row.id===selected.id));
 assert.ok(rows.every(row=>!row.vehicle_json.parsed.budgetFallback&&!/acima do valor informado/.test(row.vehicle_json.parsed.matchNotice||'')));
 await rematch.rematchDemands(ctx,[key]);
 assert.deepEqual((await query('select id from manheim_matches where demand_key=$1 and undone_at is null order by id',[key])).map(row=>row.id),rows.map(row=>row.id),'recálculo repetido mantém as identidades');
 assert.deepEqual(await snapshot(),before);
 // No active batch means no writes and no resurrection of an undone import.
 await backend.db.query('update manheim_uploads set undone_at=now() where id=$1',[selected.upload_id]);
 const inactive=await snapshot();
 assert.deepEqual(await rematch.rematchDemands(ctx,[key]),[{key,status:'NO_BATCH'}]);
 assert.deepEqual(await snapshot(),inactive);
 assert.deepEqual(backend.refused,[]);
});
