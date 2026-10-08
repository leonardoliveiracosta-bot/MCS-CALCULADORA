'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'test',SUPABASE_SECRET_KEY:'test',ENTRADA_OPENAI_ENABLED:'0',MANHEIM_OPENAI_ENABLED:'0',MANHEIM_MATCH_AUDIT_ENABLED:'0'});
const {createBackend}=require('./fixtures/banco-simulado'),demo=require('./fixtures/caso-demonstracao');
const original=fs.readFileSync(path.join(__dirname,'fixtures/original-panel_manheim_grouped_light.sql'),'utf8');
const id=n=>'7a100000-0000-4000-8000-'+String(n).padStart(12,'0'),upload=id(1),second=id(2),dk='journey:'+demo.IDS.JOURNEY+':CARRO';
const activation="create or replace function public.panel_manheim_grouped_light(p_environment public.panel_environment,p_upload_id uuid) returns table(upload_id uuid,demand_key text,dk text,car_key text,id uuid,logical_mode text,journey_id uuid,calc_ref text,match_kind text,criteria_hash text,presented boolean,mmr_cents integer,wish_index smallint,offer_group text,selected_id uuid) language sql stable security invoker set search_path='' set work_mem='32MB' as $$select * from panel_internal.manheim_grouped_prepared(p_environment,p_upload_id)$$;";
const variants=[
 {vin:'same',lane:'A',run:'1',startsAt:'2999-01-01T12:00:00Z'},
 {vin:' SAME ',buyNowPrice:'24000',endsAt:'2999-01-01T14:00:00Z'},
 {vin:'same',lane:'B',run:'2',endsAt:'2001-01-01T00:00:00Z'},
 {vin:'same',lane:'C',run:'3',startsAt:'2999-01-01',endsAt:''},
 {vin:'date',lane:'A',run:'1',saleDate:'2999-01-01'},
 {vin:'invalid',lane:'A',run:'1',startsAt:'invalid',endsAt:'not a date'},
 {vin:'relative',lane:'A',run:'1',startsAt:'tomorrow',endsAt:'tomorrow'},
 {vin:'today',lane:'A',run:'1',startsAt:'today'}, {vin:'now',endsAt:'now'},
 {vin:'offset',lane:'A',run:'1',startsAt:'2999-01-01T12:00:00-04:00'},
 {vin:'nooffset',lane:'A',run:'1',startsAt:'2999-01-01T12:00:00'},
 {vin:'badcalendar',lane:'A',run:'1',startsAt:'2999-02-30T12:00:00Z'},
 {vin:'locale',lane:'A',run:'1',startsAt:'12/01/2999'},
 {vin:'blank',lane:'',run:'',buyNowPrice:'$24,000'},
 {vin:'zero',mmrCents:0},{vin:'negative',mmrCents:-1},{vin:'fallback',mmrCents:'800000'},
 {vin:'invalidMMR',mmrCents:'N/A'},{vin:'missing'},{vin:''},
 {vin:'whitespace',endsAt:' 2999-01-01T00:00:00Z '},
 {vin:'DST',lane:'A',run:'1',startsAt:'2999-03-10T01:59:59-05:00'},
 {vin:'EMPTYKEY',blankKey:true},{vin:'EMPTYKEY',blankKey:true,buyNowPrice:'20000'},
 {vin:'EMPTYKEY',buyNowPrice:'30000'}
];
let backend,db;
const rows=(sql,args=[])=>db.query(sql,args).then(r=>r.rows);
async function parity(label){
 const a=await rows('select * from public.panel_manheim_grouped_light($1,$2) order by id',['preview',upload]);
 const b=await rows('select * from panel_internal.manheim_grouped_prepared($1,$2) order by id',['preview',upload]);
 assert.deepEqual(b,a,label);
 const oldScore=await rows("select * from public.panel_manheim_score_mmr('preview',now()-interval '60 days') order by person");
 const candidateScore=await rows("select * from panel_internal.manheim_score_mmr_candidates('preview',now()-interval '60 days') order by person");
 assert.deepEqual(candidateScore,oldScore,'same score: '+label);
}
async function insertMatch(n,parsed){
 await db.query("insert into public.manheim_matches(id,environment,upload_id,journey_id,logical_mode,demand_key,match_kind,row_fingerprint,mmr_cents,wish_index,criteria_hash,vehicle_json) values($1,'preview',$2,$3,'CARRO',$4,'BATE',$5,$6,0,$7,$8)",
 [id(100+n),upload,demo.IDS.JOURNEY,parsed.blankKey?'':n%3===0?null:dk,'row-'+n,n>=14&&n<=18?null:800000,'hash-'+n%3,JSON.stringify({parsed:{year:2020,make:'Toyota',model:'Corolla',...parsed}})]);
}
test.before(async()=>{
 backend=await createBackend({seed:demo.seed});db=backend.db;await db.exec("begin;set time zone 'UTC'");await db.exec(original);
 await db.query("insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by,activated_at) values($1,'preview',1,$2,$3,now()),($4,'preview',1,1,$3,now())",[upload,variants.length,demo.IDS.ACTOR,second]);
 for(let n=0;n<variants.length;n++)await insertMatch(n,variants[n]);
});
test.after(async()=>{if(db){await db.exec('rollback');await db.close();}});
test('preparo reproduz todos os campos em sete fusos, datas inválidas e relativas, MMR e VIN duplicado',async()=>{
 for(const zone of ['UTC','America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','Pacific/Honolulu']){
  await db.query("select set_config('TimeZone',$1,false)",[zone]);await parity(zone);
 }
 await db.exec("set time zone 'UTC'");
 assert.equal((await rows('select count(*) n from panel_internal.manheim_prepared_inputs'))[0].n,variants.length);
});
test('seleção e apresentação continuam vivas',async()=>{
 const before=await rows("select to_jsonb(q)-'source_version' r from panel_internal.manheim_prepared_inputs q order by match_id");
 await db.query("insert into public.manheim_option_selections(environment,match_id,upload_id,demand_key,status,offer_group,mmr_cents,default_pct,final_cents) values('preview',$1,$2,$3,'SELECTED','LANE',800000,10,880000)",[id(102),upload,dk]);
 await db.query("insert into public.units(id,environment,journey_id,vehicle_text,status,details_json,created_at,presented_at) values($1,'preview',$2,'Teste fictício','PRESENTED','{}',now(),now())",[id(50),demo.IDS.JOURNEY]);
 await db.query('update public.manheim_matches set presented_unit_id=$1 where id=$2',[id(50),id(102)]);
 await parity('seleção em membro expirado e apresentação em duplicata');
 assert.deepEqual(await rows("select to_jsonb(q)-'source_version' r from panel_internal.manheim_prepared_inputs q order by match_id"),before);
 const group=(await rows('select * from panel_internal.manheim_grouped_prepared($1,$2) where car_key=$3',['preview',upload,'SAME']))[0];
 assert.ok(group.presented);assert.equal(group.selected_id,id(102));
 await db.query("update public.manheim_option_selections set status='EXCLUDED' where match_id=$1",[id(102)]);await parity('desseleção');
});
test('alterar origem, mover entre lotes, desfazer e restaurar atualiza na mesma transação',async()=>{
 await db.query("update public.manheim_matches set vehicle_json=jsonb_set(vehicle_json,'{parsed,endsAt}',$1::jsonb),mmr_cents=0 where id=$2",[JSON.stringify('2000-01-01T00:00:00Z'),id(100)]);await parity('data e MMR');
 await db.query('update public.manheim_matches set upload_id=$1 where id=$2',[second,id(104)]);await parity('outro lote');
 await db.query('update public.manheim_matches set upload_id=$1,undone_at=now() where id=$2',[upload,id(104)]);await parity('desfazer');
 assert.equal((await rows('select count(*) n from panel_internal.manheim_prepared_inputs where match_id=$1',[id(104)]))[0].n,0);
 await db.query('update public.manheim_matches set undone_at=null where id=$1',[id(104)]);await parity('restaurar');
 await db.query("update public.manheim_matches set vehicle_json=jsonb_set(vehicle_json,'{parsed,vin}',$1::jsonb),demand_key=null where id=$2",[JSON.stringify('CHANGED'),id(110)]);await parity('VIN e chave');
});
test('staging, ativação, alteração, troca e remoção do complemento preservam a resposta',async()=>{
 for(const n of [10,11])await db.query("insert into public.manheim_complement_runs(id,environment,upload_id,created_by,client_key,manifest_hash) values($1,'preview',$2,$3,$4,'hash')",[id(n),upload,demo.IDS.ACTOR,String(n)]);
 const before=await rows('select * from panel_internal.manheim_prepared_inputs order by match_id');
 await db.query('insert into public.manheim_complement_items(run_id,row_fingerprint,sale) values($1,$2,$3)',[id(10),'row-5',JSON.stringify({lane:'A',run:'12',startsAt:'2999-01-01T12:00:00Z'})]);
 assert.deepEqual(await rows('select * from panel_internal.manheim_prepared_inputs order by match_id'),before);
 await db.query("insert into public.manheim_sale_current(environment,upload_id,run_id) values('preview',$1,$2)",[upload,id(10)]);await parity('ativar');
 await db.query('update public.manheim_complement_items set sale=$1 where run_id=$2',[JSON.stringify({lane:'A',run:'12',endsAt:'2001-01-01T00:00:00Z'}),id(10)]);await parity('atualizar');
 await db.query('insert into public.manheim_complement_items(run_id,row_fingerprint,sale) values($1,$2,$3)',[id(11),'row-5',JSON.stringify({lane:'B',run:'9',endsAt:'2999-01-01T12:00:00Z'})]);
 await db.query('update public.manheim_sale_current set run_id=$1 where upload_id=$2',[id(11),upload]);await parity('trocar');
 await db.query('delete from public.manheim_complement_items where run_id=$1',[id(11)]);await parity('remover item');
 await db.query('delete from public.manheim_sale_current where upload_id=$1',[upload]);await parity('remover complemento');
});
test('preparo ausente tem fallback; falha ou rollback mantém origem e preparo juntos',async()=>{
 await db.query('delete from panel_internal.manheim_prepared_inputs where match_id=$1',[id(105)]);await parity('sem preparo');
 await db.query('select panel_internal.manheim_refresh($1)',[[id(105)]]);
 await db.query("update panel_internal.manheim_prepared_inputs set source_version='stale',priority=2,valid_mmr=false where match_id=$1",[id(105)]);await parity('versão de origem concorrente');
 await db.query('select panel_internal.manheim_refresh($1)',[[id(105)]]);
 await db.query("update panel_internal.manheim_prepared_inputs set sale_version='stale',priority=2,valid_mmr=false where match_id=$1",[id(105)]);await parity('versão de venda concorrente');
 await db.query('select panel_internal.manheim_refresh($1)',[[id(105)]]);
 const before=await rows('select * from panel_internal.manheim_prepared_inputs order by match_id');
 await db.exec('savepoint atomic_test');await db.query('update public.manheim_matches set mmr_cents=1234567 where id=$1',[id(105)]);await parity('dentro da transação');
 await db.exec('rollback to atomic_test');assert.deepEqual(await rows('select * from panel_internal.manheim_prepared_inputs order by match_id'),before);
 await db.exec("alter table panel_internal.manheim_prepared_inputs add constraint reject_test check(match_id<>'"+id(999)+"')");
 await db.exec('savepoint rejected_insert');await assert.rejects(insertMatch(899,{vin:'REJECTED'}));await db.exec('rollback to rejected_insert');
 assert.equal((await rows('select count(*) n from public.manheim_matches where id=$1',[id(999)]))[0].n,0);
 await db.exec('alter table panel_internal.manheim_prepared_inputs drop constraint reject_test');
});
test('resumos, seleção, carros e nota são idênticos antes e depois, sem alterar fontes',async()=>{
 async function response(){
  const out={};
  for(const fn of ['panel_manheim_batch_summary_v2','panel_manheim_offer_summary','panel_manheim_batch_overview','panel_manheim_score_mmr']){
   const args=fn.endsWith('score_mmr')?"'preview',now()-interval '60 days'":"'preview','"+upload+"'";
   const r=await rows('select * from public.'+fn+'('+args+')');out[fn]=r.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
   if(fn.endsWith('overview'))for(const part of ['summary','offer','cars'])for(const row of r)row[fn][part].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  out.cars=await rows('select * from public.panel_manheim_batch_cars($1,$2) order by upload_id',['preview',[upload,second]]);return out;
 }
 const source=await rows('select * from public.manheim_matches order by id'),selections=await rows('select * from public.manheim_option_selections order by id');
 const a=await response();await db.exec(activation);const b=await response();await db.exec(original);const again=await response();
 assert.deepEqual(again,a,'controle A/A');assert.deepEqual(b,a,'mesmos campos, arrays e contagens');
 assert.deepEqual(await rows('select * from public.manheim_matches order by id'),source);
 assert.deepEqual(await rows('select * from public.manheim_option_selections order by id'),selections);
});
test('anon e authenticated não têm acesso aos dados nem às funções de preparo',async()=>{
 for(const role of ['anon','authenticated']){
  const [access]=await rows("select has_schema_privilege($1,'panel_internal','USAGE') schema,has_table_privilege($1,'panel_internal.manheim_prepared_inputs','SELECT') table_access,has_function_privilege($1,'panel_internal.manheim_refresh(uuid[],panel_environment,uuid)','EXECUTE') refresh",[role]);
  assert.deepEqual(access,{schema:false,table_access:false,refresh:false});
 }
 assert.equal((await rows("select relrowsecurity from pg_class where oid='panel_internal.manheim_prepared_inputs'::regclass"))[0].relrowsecurity,true);
});


test('fila inteira e contadores A/B/A preservam SMS sem data, mensagem nova e pedidos incompletos',async()=>{
 const originalFetch=global.fetch,RealDate=Date;global.fetch=(url,options)=>backend.fetch(url,options);
 const fixed=RealDate.parse('2026-10-08T12:00:00Z');
 global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed]))}static now(){return fixed}};
 try{
  for(let n=0;n<7;n++){
   await db.query("insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,original_datetime_text,signature_base,occurrence_index,source_kind,created_at) values($1,'preview',$2,'SMS','CUSTOMER','Print fictício sem data','print',null,true,'data original desconhecida',$3,1,'SMS_PRINT','2026-10-08T11:00:00Z')",[id(500+n),demo.IDS.CHAT,'prep-unknown-'+n]);
   await db.query("insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'IMPORT',now())",[id(500+n),demo.IDS.JOURNEY]);
  }
  await db.query("insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values($1,'preview',$2,'WHATSAPP','CUSTOMER','Mensagem nova fictícia','nova','2026-10-08T11:30:00Z','prep-new',1,'IMPORT','2026-10-08T11:30:00Z')",[id(510),demo.IDS.CHAT]);
  await db.query("insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'IMPORT',now())",[id(510),demo.IDS.JOURNEY]);
  async function response(){
   const out=[];
   for(const body of [{part:'main',sort:'ready',page:{limit:10000},includeCounters:true},{part:'main',sort:'recent',page:{limit:30,ref:'without'},includeCounters:true},{part:'main',sort:'ready',page:{limit:10000,stat:'late24'}},{part:'counters',summary:true}]){
    const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this},json(value){this.payload=value;return value},end(){}};
    await require('../api/panel/boot')({method:'POST',url:'/api/panel/boot',headers:{authorization:'Bearer token-simulado'},body},res);
    assert.equal(res.statusCode,200);out.push(res.payload);
   }
   return out;
  }
  await db.exec(original);const a=await response();await db.exec(activation);const b=await response();await db.exec(original);const again=await response();
  assert.deepEqual(again,a,'controle A/A');assert.deepEqual(b,a,'mesmas filas, grupos, ordem, textos e contagens');assert.equal(backend.refused.length,0);
 }finally{global.fetch=originalFetch;global.Date=RealDate;await db.exec(original);}
});

test('preparo em bloco coincide campo a campo com a extração unitária',async()=>{
 const result=await rows("select count(*) n,count(*) filter(where q is distinct from panel_internal.manheim_prepare(m,si.sale,m.xmin::text,c.run_id,si.xmin::text)) differences from public.manheim_matches m join panel_internal.manheim_prepared_inputs q on q.match_id=m.id left join public.manheim_sale_current c on c.environment=m.environment and c.upload_id=m.upload_id left join public.manheim_complement_items si on si.run_id=c.run_id and si.row_fingerprint=m.row_fingerprint where m.undone_at is null");
 assert.equal(result[0].differences,0);assert.ok(result[0].n>20);
});
