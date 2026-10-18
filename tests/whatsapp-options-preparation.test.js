'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {BASE,createBackend}=require('./fixtures/banco-simulado');
const {rpc}=require('../panel-server');
const {latestActiveUpload}=require('../panel-manheim-state');
const {linkFor}=require('../panel-option-links');
const {prepareOptions}=require('../whatsapp-options-prepare');
const {maybeAutoOptions,processOptionsTimer,explanation,details}=require('../whatsapp-auto-options');
const ctx={environment:'preview',config:{url:BASE,secretKey:'simulada'}};
let backend,ids,sends=[],queue=[];
const upload='3a700000-0000-4000-8000-000000000001',actor='3a700000-0000-4000-8000-000000000002';
const phone='+13055559761';
const body='My Car Scout · FIND · Vehicle search request\nYear range: 2018-2023\nRef: F8X29';
const deps={call:rpc,latestActiveUpload,linkFor,prepareOptions,
  queueTimer:async(...args)=>queue.push(args),
  sendMessage:async(target,text)=>{sends.push({target,text});return 'wamid.prepare.out.'+sends.length;},recordSent:async()=>{}};
test.before(async()=>{
  process.env.AUTO_REPLY_ENABLED='true';delete process.env.VERCEL_ENV;
  backend=await createBackend();global.fetch=backend.fetch;
  const raw=(await backend.db.query("insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status) values('preview','options-preparation','messages','{}','DONE') returning id")).rows[0].id;
  const applied=await rpc(ctx,'panel_whatsapp_apply_message',{p_environment:'preview',p_raw:raw,p_item:{messageId:'wamid.prepare.in',phone,direction:'CUSTOMER',body,timestamp:String(Math.floor(Date.now()/1000)),refs:['F8X29'],source_kind:'WHATSAPP_WEBHOOK'}});
  ids={...applied,raw};
  await backend.db.query("insert into public.calc_runs(dados,is_test,idioma) values($1,false,'en')",[JSON.stringify({ref:'F8X29',sid:'prepare-find-unit',canal:'whatsapp',logical_mode:'CARRO',evento:'busca',marca:'Tesla',modelo:'Model 3',ano_de:2018,ano_ate:2023,milhas_de:20000,milhas_ate:80000})]);
  await backend.db.query("insert into public.whatsapp_auto_replies(environment,contact_id,inbound_wa_message_id,status,sent_at,sent_wa_message_id) values('preview',$1,'wamid.prepare.in','SENT',now(),'wamid.prepare.welcome')",[ids.contactId]);
  await backend.db.query("insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values($1,'preview','3a700000-0000-4000-8000-000000000003','options@example.test','admin',true,false)",[actor]);
  await backend.db.query("insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by,activated_at) values($1,'preview',1,5,$2,now())",[upload,actor]);
  const car={year:2021,make:'Tesla',model:'Model 3',trim:'Long Range',miles:40000,mmrCents:1800000,lane:'1',run:'1',conditionGrade:'4.7',cleanTitle:true,odometerOk:true,startsAt:new Date(Date.now()+86400000).toISOString()};
  for(const [fingerprint,extra] of [['vin:EXACT',{}],['vin:NEAR',{year:2017}],['vin:WRONG',{year:2010}],['vin:BADTITLE',{cleanTitle:false,titleStatus:'Salvage'}],['vin:NO-MMR',{mmrCents:null}]]){
    const v={...car,...extra};await backend.db.query("insert into public.manheim_vehicles(environment,upload_id,row_fingerprint,vehicle_json,make_key,mmr_cents) values('preview',$1,$2,$3,'tesla',$4)",[upload,fingerprint,JSON.stringify(v),v.mmrCents]);
  }
});
test.after(async()=>{await backend?.db.close();});
test('new Ref schedules before any match and builds exact/near options with real DB without opening panel or AI',async()=>{
  assert.equal((await backend.db.query('select count(*)::int n from public.manheim_matches')).rows[0].n,0);
  const scheduled=await maybeAutoOptions(ctx,ids.raw,{messageId:'wamid.prepare.in',phone,body,direction:'CUSTOMER',eventField:'messages',source_kind:'WHATSAPP_WEBHOOK'},ids,{greeting:{sent:true,messageId:'wamid.prepare.welcome'}},deps);
  assert.equal(scheduled.scheduled,true);ids.job=scheduled.jobId;
  assert.equal(sends.length,0);assert.equal(queue.length,1);
  await assert.rejects(processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'LINK'},deps),/TIMER_NOT_DUE/);
  await backend.db.query("update public.whatsapp_auto_options set link_due_at=clock_timestamp()-interval '1 second' where id=$1",[ids.job]);
  const outcome=await processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'LINK'},deps);
  assert.equal(outcome.sent,true,JSON.stringify(outcome));
  assert.equal(sends.length,1);assert.match(sends[0].text,/^Preview the vehicles available to you at dealer-only auctions:\nhttps:\/\/www.mycarscout.net\/o\//);assert.equal(sends[0].target.phone,phone);
  const matches=(await backend.db.query('select row_fingerprint,vehicle_json from public.manheim_matches order by row_fingerprint')).rows;
  assert.deepEqual(matches.map(m=>m.row_fingerprint),['vin:EXACT','vin:NEAR']);assert.equal(matches[1].vehicle_json.parsed.matchNear,true);
  assert.equal(backend.refused.length,0);assert.equal(backend.calls.filter(c=>/\/api\/panel\//.test(c.url||'')).length,0);
  await assert.rejects(processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'EXPLANATION'},deps),/TIMER_NOT_DUE/);
  await backend.db.query("update public.whatsapp_auto_options set explanation_due_at=clock_timestamp()-interval '1 second' where id=$1",[ids.job]);
  assert.equal((await processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'EXPLANATION'},deps)).sent,true);
  assert.equal(sends[1].text,explanation('en'));
  assert.equal((await backend.db.query('select stage from public.whatsapp_auto_options where id=$1',[ids.job])).rows[0].stage,'EXPLANATION_SENT');
  // The third message waits 25 s after the explanation, then goes once.
  await assert.rejects(processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'DETAILS'},deps),/TIMER_NOT_DUE/);
  const due=(await backend.db.query('select extract(epoch from details_due_at-explanation_sent_at)::int s from public.whatsapp_auto_options where id=$1',[ids.job])).rows[0].s;
  assert.equal(due,25);
  await backend.db.query("update public.whatsapp_auto_options set details_due_at=clock_timestamp()-interval '1 second' where id=$1",[ids.job]);
  assert.equal((await processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'DETAILS'},deps)).sent,true);
  assert.equal(sends[2].text,details('en'));assert.equal(sends.length,3);
  const job=(await backend.db.query('select stage,link_wamid,explanation_wamid,details_wamid from public.whatsapp_auto_options where id=$1',[ids.job])).rows[0];
  assert.deepEqual(job,{stage:'COMPLETE',link_wamid:'wamid.prepare.out.1',explanation_wamid:'wamid.prepare.out.2',details_wamid:'wamid.prepare.out.3'});
  // A repeated timer never sends again.
  assert.equal((await processOptionsTimer(ctx,{environment:'preview',jobId:ids.job,step:'DETAILS'},deps)).sent,false);assert.equal(sends.length,3);
});
test('the third message echoed by WhatsApp is marked automatic, like the other two',async()=>{
  const chat=(await backend.db.query("select ch.id from public.chats ch where ch.contact_id=$1",[ids.contactId])).rows[0].id;
  const inserted=(await backend.db.query("insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('preview',$1,'WHATSAPP','MCS',$2,'x',now(),'WA:wamid.prepare.out.3',1,'WHATSAPP_WEBHOOK',now()) returning is_automatic",[chat,details('en')])).rows[0];
  assert.equal(inserted.is_automatic,true);
});
test('a second calculator request of the same ficha with another Ref does not get the same link again',async()=>{
  const ref='F8Z49',again='My Car Scout · FIND · Vehicle search request\nYear range: 2018-2023\nRef: '+ref;
  const applied=await rpc(ctx,'panel_whatsapp_apply_message',{p_environment:'preview',p_raw:ids.raw,p_item:{messageId:'wamid.prepare.again',phone,direction:'CUSTOMER',body:again,timestamp:String(Math.floor(Date.now()/1000)),refs:[ref],source_kind:'WHATSAPP_WEBHOOK'}});
  assert.equal(applied.journeyId,ids.journeyId,'same ficha');
  await backend.db.query("insert into public.calc_runs(dados,is_test,idioma) values($1,false,'en')",[JSON.stringify({ref,sid:'prepare-find-again',canal:'whatsapp',logical_mode:'CARRO',evento:'busca',marca:'Tesla',modelo:'Model 3',ano_de:2018,ano_ate:2023})]);
  const before=sends.length;
  const outcome=await maybeAutoOptions(ctx,ids.raw,{messageId:'wamid.prepare.again',phone,body:again,direction:'CUSTOMER',eventField:'messages',source_kind:'WHATSAPP_WEBHOOK'},applied,{greeting:{sent:false,reason:'RECENT_MESSAGE'}},deps);
  assert.equal(outcome.reason,'ALREADY_SENT_TO_REQUEST',JSON.stringify(outcome));
  assert.equal(sends.length,before);
});
test('private additions cannot mutate an existing match or human price and cannot add after completion',async()=>{
  const match=(await backend.db.query("select * from public.manheim_matches where row_fingerprint='vin:EXACT'")).rows[0];
  const key=match.demand_key;
  await backend.db.query("insert into public.manheim_option_selections(environment,match_id,upload_id,demand_key,status,manual,offer_group,mmr_cents,default_pct,final_cents) values('preview',$1,$2,$3,'AVAILABLE',true,'LANE',1800000,15,1700000)",[match.id,upload,key]);
  const before=JSON.stringify((await backend.db.query('select to_jsonb(m) m from public.manheim_matches m order by id')).rows);
  await backend.db.query("update public.whatsapp_auto_options set stage='CLAIMED',link_due_at=clock_timestamp()-interval '1 second' where id=$1",[ids.job]);
  assert.equal((await prepareOptions(ctx,ids.job,key)).added,0);
  assert.equal(JSON.stringify((await backend.db.query('select to_jsonb(m) m from public.manheim_matches m order by id')).rows),before);
  assert.equal((await backend.db.query('select final_cents from public.manheim_option_selections where match_id=$1',[match.id])).rows[0].final_cents,1700000);
  await backend.db.query("update public.whatsapp_auto_options set stage='COMPLETE' where id=$1",[ids.job]);
  assert.equal((await prepareOptions(ctx,ids.job,key)).reason,'STATE_CONFLICT');
  assert.equal((await backend.db.query("select has_function_privilege('anon','public.panel_whatsapp_auto_options_add_matches(public.panel_environment,uuid,uuid,jsonb)','EXECUTE') allowed")).rows[0].allowed,false);
});
test('VALOR prepares its own request using the same budget matcher and never borrows CARRO matches',async()=>{
  const otherPhone='+13055559762',ref='F8Y39';
  const otherBody='My Car Scout · Calculate My Cost\nMaximum bid: $19,000\nRef: '+ref;
  const applied=await rpc(ctx,'panel_whatsapp_apply_message',{p_environment:'preview',p_raw:ids.raw,p_item:{messageId:'wamid.prepare.value',phone:otherPhone,direction:'CUSTOMER',body:otherBody,timestamp:String(Math.floor(Date.now()/1000)),refs:[ref],source_kind:'WHATSAPP_WEBHOOK'}});
  await backend.db.query("insert into public.calc_runs(dados,is_test,idioma,lance) values($1,false,'en',19000)",[JSON.stringify({ref,sid:'prepare-value-unit',canal:'whatsapp',logical_mode:'VALOR',evento:'whatsapp',marca:'Tesla',modelo:'Model 3',lance:19000})]);
  await backend.db.query("insert into public.whatsapp_auto_replies(environment,contact_id,inbound_wa_message_id,status,sent_at,sent_wa_message_id) values('preview',$1,'wamid.prepare.value','SENT',now(),'wamid.prepare.value.welcome')",[applied.contactId]);
  const before=JSON.stringify((await backend.db.query("select to_jsonb(m) m from public.manheim_matches m where logical_mode='CARRO' order by id")).rows);
  const outcome=await maybeAutoOptions(ctx,ids.raw,{messageId:'wamid.prepare.value',phone:otherPhone,body:otherBody,direction:'CUSTOMER',eventField:'messages',source_kind:'WHATSAPP_WEBHOOK'},applied,{greeting:{sent:true,messageId:'wamid.prepare.value.welcome'}},deps);
  assert.equal(outcome.scheduled,true,JSON.stringify(outcome));
  await backend.db.query("update public.whatsapp_auto_options set link_due_at=clock_timestamp()-interval '1 second' where id=$1",[outcome.jobId]);
  const sent=await processOptionsTimer(ctx,{environment:'preview',jobId:outcome.jobId,step:'LINK'},deps);
  assert.equal(sent.sent,true,JSON.stringify(sent));
  const matches=(await backend.db.query('select * from public.manheim_matches where journey_id=$1',[applied.journeyId])).rows;
  assert.ok(matches.length>0);assert.ok(matches.every(m=>m.logical_mode==='VALOR'&&!m.vehicle_json.parsed.matchNear&&m.mmr_cents<=1900000));
  assert.equal(JSON.stringify((await backend.db.query("select to_jsonb(m) m from public.manheim_matches m where logical_mode='CARRO' order by id")).rows),before);
  assert.equal(backend.refused.length,0);
});
