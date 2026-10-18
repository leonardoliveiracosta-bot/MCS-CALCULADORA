'use strict';
// Importação do Manheim: até 100 arquivos .csv por envio e até 100 no lote ativo (era 50).
// Maior lote real até 18/10: 48 arquivos e 70.309 carros. O limite de 250.000 carros não muda.
const test=require('node:test'),assert=require('node:assert/strict');
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'test',SUPABASE_SECRET_KEY:'test'});
const fs=require('node:fs'),path=require('node:path');
const {createBackend}=require('./fixtures/banco-simulado'),batch=require('../panel-manheim-batch');
const {rpc}=require('../panel-server');
const {startInput}=require('../api/panel/manheim-batch');
const id=n=>`12340000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const ctx={environment:'preview',panel:{id:id(1)},config:{url:'http://banco-simulado.local',secretKey:'test'}};
const seed=`insert into panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`;
let backend;
test.before(async()=>{backend=await createBackend({seed});global.fetch=backend.fetch;require('../panel-manheim-state').resetUndoSupport();});
test.after(async()=>{if(backend)await backend.db.close();});

const lot=(count,prefix)=>{
  const blocks=Array.from({length:count},(_,i)=>[batch.sanitizeVehicle({fingerprint:`vin:${prefix}${i}`,vehicle:{vin:`${prefix}${i}`,year:2020,make:'Toyota',model:'Camry',miles:50000,mmrCents:1600000,lane:'',run:'',buyNowPrice:'18000',conditionGrade:'3'}})]);
  const files=blocks.map((entries,i)=>({name:`${prefix}-${i}.csv`,size:100,rowCount:1,vehicleCount:1,chunkCount:1,chunks:[{count:1,hash:batch.contentHash(entries)}]}));
  return {blocks,files};
};
async function send({blocks,files},key,append=null){
  const start=await rpc(ctx,'panel_manheim_batch_start',{p_environment:'preview',p_actor_id:id(1),p_client_key:key,p_vehicle_count:files.length,p_headers:[],p_header_map:{},p_files:files,p_manifest_hash:batch.contentHash(files),p_targets:[],p_targets_hash:batch.targetsHash([])});
  if(append)await rpc(ctx,'panel_manheim_batch_append_mark',{p_environment:'preview',p_actor_id:id(1),p_upload_id:start.uploadId,p_target_id:append});
  for(let i=0;i<files.length;i++)await rpc(ctx,'panel_manheim_batch_chunk',{p_environment:'preview',p_actor_id:id(1),p_upload_id:start.uploadId,p_file_index:i,p_chunk_index:0,p_chunk_hash:files[i].chunks[0].hash,p_received_count:1,p_vehicles:blocks[i],p_matches:[]});
  return rpc(ctx,append?'panel_manheim_batch_append_finalize':'panel_manheim_batch_finalize',{p_environment:'preview',p_actor_id:id(1),p_upload_id:start.uploadId});
}

test('100 arquivos num envio: o servidor aceita, o banco grava e ativa; 101 continua recusado',async()=>{
  const hundred=lot(100,'A');
  const body=(files)=>({files,vehicleCount:files.length,clientKey:'b'.repeat(32),manifestHash:batch.contentHash(files),headers:[['VIN','Year','Make','Model']],headerMap:{}});
  assert.ok(startInput(body(hundred.files)),'o servidor aceita 100 arquivos');
  assert.equal(startInput(body(lot(101,'X').files)),null,'101 arquivos continua fora');
  const done=await send(hundred,'a'.repeat(32));
  assert.equal((await backend.db.query(`select source_file_count n from manheim_uploads where id='${done.uploadId}'`)).rows[0].n,100);
  assert.equal((await backend.db.query('select public.panel_manheim_manifest_valid($1::jsonb,101) ok',[JSON.stringify(lot(101,'Y').files)])).rows[0].ok,false);
});

test('acrescentar ao lote ativo até somar 100 arquivos; passar de 100 é recusado e o lote não muda',async()=>{
  const active=(await backend.db.query("select id,source_file_count n from manheim_uploads where activated_at is not null and undone_at is null order by activated_at desc limit 1")).rows[0];
  assert.equal(active.n,100);
  // Um lote ativo novo com 60 arquivos recebe mais 40 (total 100).
  const sixty=await send(lot(60,'B'),'c'.repeat(32));
  const added=await send(lot(40,'C'),'d'.repeat(32),sixty.uploadId);
  assert.equal(added.fileCount,100);
  await assert.rejects(()=>send(lot(1,'D'),'e'.repeat(32),sixty.uploadId),(error)=>error.code==='MANHEIM_BATCH_LIMIT');
  assert.equal((await backend.db.query(`select source_file_count n from manheim_uploads where id='${sixty.uploadId}'`)).rows[0].n,100,'o lote ativo continua com 100');
});

test('o painel aceita até 100 arquivos e diz isso na ajuda',()=>{
  const panel=fs.readFileSync(path.join(__dirname,'../painel/painel.js'),'utf8');
  assert.match(panel,/const MANHEIM_MAX_FILES = 100;/);
  assert.match(fs.readFileSync(path.join(__dirname,'../painel/index.html'),'utf8'),/Aceita arquivos \.csv do Manheim, até 100 por vez e 25 MB cada/);
});
