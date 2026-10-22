'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {migratedDatabase}=require('./sql/run');
let db;
const contact='5c220000-0000-4000-8000-000000000001',journey='5c220000-0000-4000-8000-000000000002';
test.before(async()=>{({db}=await migratedDatabase());await db.exec(`
 insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Example','WHATSAPP_DIRECT',now(),now());
 insert into public.journeys(id,environment,contact_id,source,reference_code,stage,status,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','6CFB3','NOVO','ATIVO',now(),now());
`);});
test.after(async()=>{await db?.close();});
test('Florida 09:00–18:00 boundaries follow daylight-saving time and every day',async()=>{
 const cases=[
 ['2026-07-02T12:59:59Z','2026-07-02T13:00:00Z'],['2026-07-02T13:00:00Z','2026-07-02T13:00:00Z'],
 ['2026-07-02T21:59:59Z','2026-07-02T21:59:59Z'],['2026-07-02T22:00:00Z','2026-07-03T13:00:00Z'],
 ['2026-12-02T13:59:59Z','2026-12-02T14:00:00Z'],['2026-12-02T23:00:00Z','2026-12-03T14:00:00Z'],
 ['2026-10-31T22:00:00Z','2026-11-01T14:00:00Z'],['2026-03-07T23:00:00Z','2026-03-08T13:00:00Z']];
 for(const [input,expected]of cases){const {rows}=await db.query('select public.panel_whatsapp_next_send_at($1) at',[input]);assert.equal(new Date(rows[0].at).toISOString(),new Date(expected).toISOString());}
});
test('a bare internal Ref is not a calculator request; a linked real run is, without borrowing another contact',async()=>{
 const known=async(env='preview',who=contact)=>(await db.query('select public.panel_whatsapp_has_calculator_request($1,$2) known',[env,who])).rows[0].known;
 assert.equal(await known(),false);
 await db.query("insert into public.calc_runs(dados,is_test) values($1,true)",[JSON.stringify({ref:'6CFB3',evento:'busca'})]);assert.equal(await known(),false);
 await db.query('update public.calc_runs set is_test=false');assert.equal(await known(),true);
 assert.equal(await known('production'),false);assert.equal(await known('preview','5c220000-0000-4000-8000-000000000099'),false);
 await db.exec("delete from public.calc_runs; update public.journeys set reference_code='6CFB4';");
 await db.query("insert into public.journey_refs(environment,journey_id,ref_code,created_at) values('preview',$1,'6CFB3',now())",[journey]);
 await db.query('insert into public.calc_runs(dados,is_test) values($1,false)',[JSON.stringify({ref:'6CFB3',evento:'busca'})]);assert.equal(await known(),true);
});
test('new private functions cannot be called by a browser or unauthenticated visitor',async()=>{
 for(const role of ['anon','authenticated']){
  const {rows}=await db.query("select has_function_privilege($1,'public.panel_whatsapp_has_calculator_request(public.panel_environment,uuid)','execute') known,has_function_privilege($1,'public.panel_whatsapp_options_business_due(public.panel_environment,uuid,text,timestamptz)','execute') timer",[role]);
  assert.equal(rows[0].known,false);assert.equal(rows[0].timer,false);
 }
});


test('pending LINK, EXPLANATION and DETAILS keep their stage and move from 18:00 to the next 09:00',async()=>{
 const raw=(await db.query("insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status) values('preview','business-hours-unit','messages','{}','DONE') returning id")).rows[0].id;
 const applied=(await db.query("select public.panel_whatsapp_apply_message('preview',$1,$2) result",[raw,JSON.stringify({messageId:'wamid.hours.in',phone:'+13055559883',direction:'CUSTOMER',body:'Hello',timestamp:String(Math.floor(Date.now()/1000)),refs:[],source_kind:'WHATSAPP_WEBHOOK'})])).rows[0].result;
 const claimed=(await db.query("select public.panel_whatsapp_claim_auto_reply('preview',$1,$2,'wamid.hours.in',false) result",[applied.contactId,applied.messageId])).rows[0].result;
 assert.equal(claimed.claimed,true);
 await db.query("select public.panel_whatsapp_finish_auto_reply('preview','wamid.hours.in','SENT','wamid.hours.invite',null)");
 const invitation=(await db.query("select public.panel_whatsapp_apply_message('preview',$1,$2) result",[raw,JSON.stringify({messageId:'wamid.hours.invite',phone:'+13055559883',direction:'MCS',body:require('../whatsapp-auto-reply').AUTO_REPLY_TEXT,timestamp:String(Math.floor(Date.now()/1000)),refs:[],source_kind:'WHATSAPP_WEBHOOK'})])).rows[0].result;
 assert.equal((await db.query('select is_automatic from public.messages where id=$1',[invitation.messageId])).rows[0].is_automatic,true);
 const job=(await db.query("insert into public.whatsapp_auto_options(environment,contact_id,journey_id,ref_code,logical_mode,inbound_message_id,inbound_wamid,link_body,explanation_body,details_body,scheduled_at,link_due_at) values('preview',$1,$2,'6CFB5','CARRO',$3,'wamid.hours.in','link','explanation','details',now(),'2026-10-27T22:01:00Z') returning id",[applied.contactId,applied.journeyId,applied.messageId])).rows[0].id;
 for(const [step,stage,column]of [['LINK','CLAIMED','link_due_at'],['EXPLANATION','LINK_SENT','explanation_due_at'],['DETAILS','EXPLANATION_SENT','details_due_at']]){
  await db.query(`update public.whatsapp_auto_options set stage=$1,${column}='2026-10-27T22:01:00Z' where id=$2`,[stage,job]);
  const answer=(await db.query("select public.panel_whatsapp_options_business_due('preview',$1,$2,'2026-10-27T21:59:00Z') result",[job,step])).rows[0].result;
  assert.equal(answer.deferred,true);assert.equal(new Date(answer.dueAt).toISOString(),'2026-10-28T13:00:00.000Z');
  const saved=(await db.query(`select stage,${column} due,case when $2='LINK' then link_queued_at when $2='EXPLANATION' then explanation_queued_at else details_queued_at end queued from public.whatsapp_auto_options where id=$1`,[job,step])).rows[0];assert.equal(saved.stage,stage);assert.equal(saved.queued,null);
  assert.equal(new Date(saved.due).toISOString(),'2026-10-28T13:00:00.000Z');
 }
 await db.query("update public.whatsapp_auto_options set stage='CLAIMED',link_due_at='2026-10-27T21:59:50Z' where id=$1",[job]);
 const crossed=(await db.query("select public.panel_whatsapp_options_business_due('preview',$1,'LINK','2026-10-27T22:00:01Z') result",[job])).rows[0].result;
 assert.equal(new Date(crossed.dueAt).toISOString(),'2026-10-28T13:00:00.000Z');
 // An in-hours timer stays exactly as it was; a failed/completed job is never revived.
 await db.query("update public.whatsapp_auto_options set stage='CLAIMED',link_due_at='2026-10-27T17:30:00Z' where id=$1",[job]);
 assert.equal((await db.query("select public.panel_whatsapp_options_business_due('preview',$1,'LINK','2026-10-27T17:29:00Z') result",[job])).rows[0].result.deferred,false);
 await db.query("update public.whatsapp_auto_options set stage='COMPLETE' where id=$1",[job]);
 assert.deepEqual((await db.query("select public.panel_whatsapp_options_business_due('preview',$1,'LINK','2026-10-27T23:00:00Z') result",[job])).rows[0].result,{deferred:false});
});
