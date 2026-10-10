'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const id=n=>`6a310000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=id(1),journey=id(2),contact=id(3),upload=id(4),key=`journey:${journey}:CARRO`;
function migrationSQL(){const dir=path.join(__dirname,'../supabase/migrations'),name=fs.readdirSync(dir).find(x=>x.endsWith('_manheim_page_and_trims_once.sql'));return fs.readFileSync(name?path.join(dir,name):path.join(__dirname,'../supabase/sql/manheim_page_and_trims_once.sql'),'utf8');}
test('one grouping supplies exactly the former page and trims in every sort, filter and group; alias selection stays intact',async()=>{
 const {db}=await require('./sql/run').migratedDatabase();
 try{
  await db.exec(migrationSQL());
  await db.exec(`insert into panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${actor}','preview','${actor}','bundle@example.test','admin',true,false);
   insert into contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Synthetic','WHATSAPP_DIRECT',now(),now());
   insert into journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
   insert into manheim_uploads(id,environment,created_by,source_file_count,vehicle_count,matched_vehicle_count,lead_count,headers_json,header_map,activated_at) values('${upload}','preview','${actor}',1,42,42,1,'[]','{}',now());`);
  const future=new Date(Date.now()+7*86400000).toISOString();
  for(let n=10;n<52;n++){
   const p={vin:n===50||n===51?'ALIASVIN':'VIN'+n,year:n%9===0?'unknown':2020+n%4,make:'Honda',model:'CR-V',trim:n%5===0?'':n%2?'EX':'LX',miles:n%11===0?'unknown':20000+n*97,mmrCents:1500000+n*1000,conditionGrade:n%7===0?null:String(2+n%6/2),cleanTitle:true,odometerOk:true,endsAt:future};
   if(n%3===0||n===51)Object.assign(p,{lane:'7',run:String(n),startsAt:future});else if(n%3===1||n===50)Object.assign(p,{lane:'',run:'',buyNowPrice:'27000'});
   if(n===49)p.endsAt=new Date(Date.now()-86400000).toISOString();
   await db.query("insert into manheim_matches(id,environment,upload_id,journey_id,logical_mode,demand_key,match_kind,row_fingerprint,vehicle_json,mmr_cents,vin) values($1,'preview',$2,$3,'CARRO',$4,'BATE',$5,$6,$7,$8)",[id(n),upload,journey,key,'entry:'+n,JSON.stringify({parsed:p}),p.mmrCents,p.vin]);
  }
  await db.query("insert into manheim_option_selections(environment,match_id,upload_id,demand_key,status,offer_group,mmr_cents,default_pct,final_cents,updated_by,manual,manual_reason) values('preview',$1,$2,$3,'SELECTED','OFFLANE',1550000,8,1674000,$4,true,'Prior selection')",[id(50),upload,key,actor]);
  await db.exec('begin');
  const value=async(sql,args)=>(await db.query(sql,args)).rows[0].value;
  let comparisons=0;
  for(const group of ['LANE','OFFLANE','INCOMPLETE'])for(const sort of ['cr','year_desc','year_asc','miles_desc','miles_asc','mmr_desc','mmr_asc'])for(const trims of [[],['ex'],['']])for(const offset of [0,3,50]){
   const old=trims.length?await value("select coalesce(jsonb_agg(to_jsonb(p)),'[]') value from public.panel_manheim_offer_page_trim($1,$2,$3,$4,$5,$6,$7,$8) p",['preview',upload,key,group,sort,trims,offset,5]):sort==='cr'?await value("select coalesce(jsonb_agg(to_jsonb(p)),'[]') value from public.panel_manheim_offer_page($1,$2,$3,$4,$5,$6) p",['preview',upload,key,group,offset,5]):await value("select coalesce(jsonb_agg(to_jsonb(p)),'[]') value from public.panel_manheim_offer_page_sorted($1,$2,$3,$4,$5,$6,$7) p",['preview',upload,key,group,sort,offset,5]);
   const facets=await value("select coalesce(jsonb_agg(to_jsonb(f)),'[]') value from public.panel_manheim_offer_trims($1,$2,$3,$4) f",['preview',upload,key,group]);
   const now=await value('select public.panel_manheim_offer_page_bundle($1,$2,$3,$4,$5,$6,$7,$8) value',['preview',upload,key,group,sort,trims,offset,5]);
   assert.deepEqual(now,{options:old,trims:facets},JSON.stringify({group,sort,trims,offset}));comparisons++;
  }
  assert.equal(comparisons,189);
  const direct=await db.query("select * from public.panel_manheim_offer_ids_v2('preview',$1,$2,$3)",[upload,key,[id(50)]]);assert.deepEqual(direct.rows,[{id:id(50)}]);
  const selection=(await db.query('select match_id,final_cents from manheim_option_selections')).rows;assert.deepEqual(selection,[{match_id:id(50),final_cents:1674000}]);
  const [acl]=(await db.query("select has_function_privilege('anon','public.panel_manheim_offer_page_bundle(public.panel_environment,uuid,text,text,text,text[],integer,integer)','EXECUTE') anon,has_function_privilege('authenticated','public.panel_manheim_offer_ids_v2(public.panel_environment,uuid,text,uuid[])','EXECUTE') authenticated,has_function_privilege('service_role','public.panel_manheim_offer_page_bundle(public.panel_environment,uuid,text,text,text,text[],integer,integer)','EXECUTE') service")).rows;assert.deepEqual(acl,{anon:false,authenticated:false,service:true});
  await db.exec('rollback');
  // Local-only instrumentation: replacing the call within the tested functions, not production code.
  const names=['panel_manheim_offer_page_bundle','panel_manheim_offer_page','panel_manheim_offer_trims'];
  const defs=(await db.query("select pg_get_functiondef(oid) definition from pg_proc where pronamespace='public'::regnamespace and proname=any($1)",[names])).rows;
  await db.exec("create table public.perf_page_group_calls(n integer);insert into public.perf_page_group_calls values(0);create function public.perf_page_grouped(e public.panel_environment,u uuid,k text) returns setof public.manheim_matches language plpgsql as $$begin update public.perf_page_group_calls set n=n+1;return query select * from public.panel_manheim_grouped_options(e,u,k);end$$;");
  for(const d of defs)await db.exec(d.definition.replaceAll('public.panel_manheim_grouped_options(','public.perf_page_grouped('));
  await db.query("select * from public.panel_manheim_offer_page('preview',$1,$2,'LANE',0,26)",[upload,key]);await db.query("select * from public.panel_manheim_offer_trims('preview',$1,$2,'LANE')",[upload,key]);assert.equal((await db.query('select n from perf_page_group_calls')).rows[0].n,2);
  await db.exec('update perf_page_group_calls set n=0');await db.query("select public.panel_manheim_offer_page_bundle('preview',$1,$2,'LANE','cr','{}',0,26)",[upload,key]);assert.equal((await db.query('select n from perf_page_group_calls')).rows[0].n,1);
 }finally{await db.close();}
});
