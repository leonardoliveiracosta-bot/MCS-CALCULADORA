begin;
do $$
declare
  raw_id uuid:=gen_random_uuid(); result jsonb; c uuid; j uuid; m uuid; job uuid; due timestamptz; first_due timestamptz;
  body text:='My Car Scout · FIND · Vehicle search request Year range: 2019-2021 Ref: D8X29';
  link text:=E'Current options:\nhttps://www.mycarscout.net/o/'||repeat('d',43);
  explanation text:='Our market reference can include adjustments. Which option would you like our team to check first?';
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status,received_at)
    values(raw_id,'preview','auto-options-delay-sql','messages','{}','DONE',now());
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.delay.in','phone','+13055559891','direction','CUSTOMER','body',body,
    'timestamp',extract(epoch from now())::bigint::text,'refs',jsonb_build_array('D8X29'),'source_kind','WHATSAPP_WEBHOOK'));
  c:=(result->>'contactId')::uuid;j:=(result->>'journeyId')::uuid;m:=(result->>'messageId')::uuid;
  insert into public.calc_runs(dados,is_test,idioma,whatsapp) values('{"ref":"D8X29","logical_mode":"CARRO","evento":"busca"}',false,'en','+13055559891');
  insert into public.panel_option_links(environment,demand_key,public_code) values('preview','journey:'||j::text||':CARRO',repeat('d',43));
  insert into public.whatsapp_auto_replies(environment,contact_id,inbound_wa_message_id,status,sent_at,sent_wa_message_id)
    values('preview',c,'auto.options.delay.in','SENT',now(),'auto.options.delay.welcome');
  result:=public.panel_whatsapp_auto_options_claim('preview',c,j,m,'auto.options.delay.in','D8X29','CARRO','+13055559891',null,link,explanation);
  if not (result->>'claimed')::boolean then raise exception 'delay fixture claim failed: %',result; end if;
  job:=(result->>'id')::uuid;
  result:=public.panel_whatsapp_auto_options_schedule('preview',job,raw_id,'+13055559892',null,'auto.options.delay.welcome');
  if (result->>'scheduled')::boolean then raise exception 'wrong stored timer recipient allowed'; end if;
  result:=public.panel_whatsapp_auto_options_schedule('preview',job,gen_random_uuid(),'+13055559891',null,'auto.options.delay.welcome');
  if result->>'reason'<>'RAW_EVENT_CONFLICT' then raise exception 'wrong raw event allowed'; end if;
  result:=public.panel_whatsapp_auto_options_schedule('preview',job,raw_id,'+13055559891',null,'wrong.welcome');
  if result->>'reason'<>'GREETING_NOT_READY' then raise exception 'unconfirmed welcome allowed'; end if;
  result:=public.panel_whatsapp_auto_options_schedule('preview',job,raw_id,'+13055559891',null,'auto.options.delay.welcome');
  if not (result->>'scheduled')::boolean then raise exception 'scheduling failed: %',result; end if;
  due:=(result->>'dueAt')::timestamptz;
  if due<>now()+interval '90 seconds' then raise exception 'link not exactly 90s after welcome'; end if;
  result:=public.panel_whatsapp_auto_options_schedule('preview',job,raw_id,'+13055559891',null,'auto.options.delay.welcome');
  if (result->>'dueAt')::timestamptz<>due then raise exception 'duplicate schedule moved timer'; end if;
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if result->>'reason'<>'NOT_DUE' then raise exception 'link ready before timer'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  if (result->>'updated')::boolean then raise exception 'link send claim before 90s'; end if;
  result:=public.panel_whatsapp_auto_options_pending_timers('preview');
  if jsonb_array_length(result)<>1 or result->0->>'step'<>'LINK' then raise exception 'pending timer not recoverable: %',result; end if;
  perform public.panel_whatsapp_auto_options_timer_queued('preview',job,'LINK');
  result:=public.panel_whatsapp_auto_options_pending_timers('preview');
  if jsonb_array_length(result)<>0 then raise exception 'published timer requeued'; end if;
  update public.whatsapp_auto_options set link_due_at=clock_timestamp()-interval '1 second',claimed_at=now()-interval '3 minutes' where id=job;
  update public.journeys set status='ENCERRADO',closed_at=now(),closed_reason='Test' where id=j;
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if result->>'reason'<>'REQUEST_NOT_ACTIVE' then raise exception 'closed request after timer accepted'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  if (result->>'updated')::boolean then raise exception 'closed request send claim'; end if;
  update public.journeys set status='ATIVO',closed_at=null,closed_reason=null where id=j;
  update public.calc_runs set whatsapp='+13055559892' where dados->>'ref'='D8X29';
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if result->>'reason'<>'CALCULATOR_PHONE_CONFLICT' then raise exception 'timer ignored changed identity'; end if;
  update public.calc_runs set whatsapp='+13055559891' where dados->>'ref'='D8X29';
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if not (result->>'ready')::boolean or result->'recipient'->>'phone'<>'+13055559891' then raise exception 'due timer unavailable: %',result; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  if not (result->>'updated')::boolean then raise exception 'due link claim failed'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  if (result->>'updated')::boolean then raise exception 'concurrent duplicate claim accepted'; end if;
  -- Delayed echo arrives >2 minutes after original reservation, before provider acknowledgement.
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.delay.link','phone','+13055559891','direction','MCS','body',link,
    'timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  if not exists(select 1 from public.messages where id=(result->>'messageId')::uuid and is_automatic) then raise exception 'delayed pre-ack link marked human'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENT','auto.options.delay.link');
  first_due:=(result->>'explanationDueAt')::timestamptz;
  if not exists(select 1 from public.whatsapp_auto_options where id=job and explanation_due_at=link_sent_at+interval '35 seconds') then raise exception 'explanation not anchored to link acknowledgement'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENT','auto.options.delay.link','PANEL_RECORD_FAILED');
  if (result->>'explanationDueAt')::timestamptz<>first_due then raise exception 'record retry shifted explanation timer'; end if;
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if not (result->>'resumeExplanation')::boolean then raise exception 'link retry cannot resume pending explanation'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'EXPLANATION_SENDING');
  if (result->>'updated')::boolean then raise exception 'explanation claim before 35s'; end if;
  update public.whatsapp_auto_options set explanation_due_at=clock_timestamp()-interval '1 second' where id=job;
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.delay.stop','phone','+13055559891','direction','CUSTOMER','body','STOP',
    'timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'EXPLANATION');
  if result->>'reason'<>'OPT_OUT' then raise exception 'opt-out after link ignored'; end if;
  update public.messages set body_text='YES' where signature_base='WA:auto.options.delay.stop';
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'EXPLANATION_SENDING');
  if not (result->>'updated')::boolean then raise exception 'due explanation claim failed: %',result; end if;
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.delay.explanation','phone','+13055559891','direction','MCS','body',explanation,
    'timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  if not exists(select 1 from public.messages where id=(result->>'messageId')::uuid and is_automatic) then raise exception 'delayed pre-ack explanation marked human'; end if;
  if exists(select 1 from public.journeys where id=j and (stage<>'NOVO' or last_effective_contact_at is not null)) then raise exception 'delayed automation counted as human'; end if;
  perform public.panel_whatsapp_auto_options_advance('preview',job,'COMPLETE','auto.options.delay.explanation');
  result:=public.panel_whatsapp_auto_options_step_context('preview',job,'EXPLANATION');
  if result->>'reason'<>'STATE_CONFLICT' then raise exception 'complete timer replayed'; end if;
  if has_function_privilege('anon','public.panel_whatsapp_auto_options_schedule(public.panel_environment,uuid,uuid,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.panel_whatsapp_auto_options_step_context(public.panel_environment,uuid,text)','EXECUTE') then raise exception 'timers exposed publicly'; end if;
  -- No abandoned pending timer is delivered hours later.
  update public.whatsapp_auto_options set stage='CLAIMED',link_due_at=now()-interval '6 minutes',link_queued_at=null where id=job;
  result:=public.panel_whatsapp_auto_options_pending_timers('preview');
  if not exists(select 1 from public.whatsapp_auto_options where id=job and stage='FAILED' and error_code='TIMER_EXPIRED') then raise exception 'expired timer survived'; end if;
  insert into public.whatsapp_options_timer_checks(environment,delay_seconds) values('preview',35) returning id into job;
  result:=public.panel_whatsapp_auto_options_pending_timers('preview');
  if jsonb_array_length(result)<>1 or result->0->>'step'<>'PROBE' then raise exception 'one-time infrastructure check missing: %',result; end if;
  if (result->0->>'id')::uuid<>job or result->0->>'seconds'<>'35' then raise exception 'infrastructure check identity mismatch'; end if;
  perform public.panel_whatsapp_auto_options_timer_queued('preview',job,'PROBE');
  result:=public.panel_whatsapp_auto_options_pending_timers('preview');
  if jsonb_array_length(result)<>0 then raise exception 'one-time check republished'; end if;
  perform public.panel_whatsapp_options_probe_received('preview',job,35);
  select received_at into first_due from public.whatsapp_options_timer_checks where id=job;
  perform public.panel_whatsapp_options_probe_received('preview',job,35);
  if first_due is null or not exists(select 1 from public.whatsapp_options_timer_checks where id=job and received_at=first_due) then raise exception 'probe confirmation missing or replay changed first receipt'; end if;
  if has_table_privilege('anon','public.whatsapp_options_timer_checks','SELECT')
    or has_function_privilege('authenticated','public.panel_whatsapp_options_probe_received(public.panel_environment,uuid,integer)','EXECUTE') then raise exception 'infrastructure checks exposed publicly'; end if;
end $$;
rollback;
