begin;
do $$
declare raw uuid:=gen_random_uuid(); data jsonb; c uuid; j uuid; m uuid; job uuid; url text; text_body text;
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status)
    values(raw,'preview','options-recovery-sql','messages','{}','DONE');
  data:=public.panel_whatsapp_apply_message('preview',raw,jsonb_build_object('messageId','recovery.in',
    'phone','+13055559791','direction','CUSTOMER','body','My Car Scout · FIND · Year range: 2018-2023 Ref: H8X29',
    'timestamp',extract(epoch from now())::bigint::text,'refs',jsonb_build_array('H8X29'),'source_kind','WHATSAPP_WEBHOOK'));
  c:=(data->>'contactId')::uuid;j:=(data->>'journeyId')::uuid;m:=(data->>'messageId')::uuid;
  insert into public.calc_runs(dados,is_test,idioma,whatsapp) values('{"ref":"H8X29","sid":"sql-find","logical_mode":"CARRO"}',false,'en','+13055559791');
  insert into public.panel_option_links(environment,demand_key,public_code) values('preview','journey:'||j::text||':CARRO',repeat('h',43));
  url:=E'Current options:\nhttps://www.mycarscout.net/o/'||repeat('h',43);
  text_body:='Market reference. Which option would you like our team to check first?';
  insert into public.whatsapp_auto_replies(environment,contact_id,inbound_wa_message_id,status,sent_at,sent_wa_message_id)
    values('preview',c,'recovery.in','SENT',now()-interval '40 minutes','recovery.welcome');
  update public.messages set occurred_at_utc=now()-interval '40 minutes' where id=m;
  data:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'recovery.in','H8X29','CARRO','+13055559791',null);
  if data->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'normal live age guard changed'; end if;
  -- Wrong recipient / later opt-out must roll back the attempted private recovery reservation.
  update public.calc_runs set whatsapp='+13055559792' where dados->>'ref'='H8X29';
  begin
    perform public.panel_whatsapp_auto_options_recover('preview',m,url,text_body,'User approved missed delivery recovery');
    raise exception 'TEST_UNSAFE_RECOVERY';
  exception when others then if sqlerrm<>'RECOVERY_NOT_ELIGIBLE' then raise; end if; end;
  if exists(select 1 from public.whatsapp_auto_options where ref_code='H8X29') then raise exception 'invalid recovery left a job'; end if;
  update public.calc_runs set whatsapp='+13055559791' where dados->>'ref'='H8X29';
  data:=public.panel_whatsapp_apply_message('preview',raw,jsonb_build_object('messageId','recovery.stop',
    'phone','+13055559791','direction','CUSTOMER','body','STOP','timestamp',extract(epoch from now())::bigint::text,
    'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  begin
    perform public.panel_whatsapp_auto_options_recover('preview',m,url,text_body,'User approved missed delivery recovery');
    raise exception 'TEST_UNSAFE_OPT_OUT';
  exception when others then if sqlerrm<>'RECOVERY_NOT_ELIGIBLE' then raise; end if; end;
  update public.messages set body_text='YES' where signature_base='WA:recovery.stop';
  data:=public.panel_whatsapp_auto_options_recover('preview',m,url,text_body,'User approved missed delivery recovery');
  if not (data->>'recovered')::boolean then raise exception 'approved recovery rejected: %',data; end if;
  job:=(data->>'jobId')::uuid;
  data:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if not (data->>'ready')::boolean or data->'recipient'->>'phone'<>'+13055559791' then raise exception 'recovery wrong recipient'; end if;
  data:=public.panel_whatsapp_auto_options_recover('preview',m,url,text_body,'User approved missed delivery recovery');
  if data->>'reason'<>'ALREADY_CLAIMED' then raise exception 'recovery duplicate allowed'; end if;
  update public.whatsapp_auto_options set recovery_authorized_at=now()-interval '11 minutes' where id=job;
  data:=public.panel_whatsapp_auto_options_step_context('preview',job,'LINK');
  if data->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'recovery age exception did not expire'; end if;
  if has_function_privilege('anon','public.panel_whatsapp_auto_options_recover(public.panel_environment,uuid,text,text,text)','EXECUTE')
    or has_function_privilege('authenticated','public.panel_whatsapp_auto_options_recover(public.panel_environment,uuid,text,text,text)','EXECUTE') then
    raise exception 'recovery exposed to browsers'; end if;
end $$;
rollback;
