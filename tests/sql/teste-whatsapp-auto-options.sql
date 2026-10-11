begin;
do $$
declare
  raw_id uuid:=gen_random_uuid(); c uuid; j uuid; m uuid; job uuid; other uuid:=gen_random_uuid(); other_j uuid:=gen_random_uuid();
  result jsonb; body text:='My Car Scout · FIND · Vehicle search request Year range: 2019-2021 Ref: Q7X29';
  link text:=E'Current options:\nhttps://www.mycarscout.net/o/'||repeat('a',43); explanation text:='Our market reference can include adjustments. Our goal is to buy below it.';
  out_id uuid;
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status,received_at)
    values(raw_id,'preview','auto-options-sql','messages','{}','DONE',now());
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.in','phone','+13055559981','direction','CUSTOMER','body',body,
    'timestamp',extract(epoch from now())::bigint::text,'refs',jsonb_build_array('Q7X29'),'source_kind','WHATSAPP_WEBHOOK'));
  c:=(result->>'contactId')::uuid;j:=(result->>'journeyId')::uuid;m:=(result->>'messageId')::uuid;
  if c is null or j is null or m is null then raise exception 'fixture not resolved'; end if;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'NO_CALCULATOR_RECORD' then raise exception 'Ref without calculator record eligible: %',result; end if;
  insert into public.calc_runs(dados,is_test,idioma,whatsapp) values('{
    "ref":"Q7X29","logical_mode":"CARRO","evento":"busca"}',true,'en','+13055559981');
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'NO_CALCULATOR_RECORD' then raise exception 'test calculator record eligible'; end if;
  update public.calc_runs set is_test=false where dados->>'ref'='Q7X29';
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if not (result->>'eligible')::boolean or result->>'key'<>'journey:'||j::text||':CARRO' then raise exception 'real calculator request not eligible: %',result; end if;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','VALOR','+13055559981',null);
  if result->>'reason'<>'MODE_CONFLICT' then raise exception 'calculator mode mixed'; end if;
  result:=public.panel_whatsapp_auto_options_context('production',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'cross environment allowed'; end if;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559982',null);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'wrong recipient allowed'; end if;
  update public.calc_runs set whatsapp='+13055559982' where dados->>'ref'='Q7X29';
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'CALCULATOR_PHONE_CONFLICT' then raise exception 'calculator phone conflict allowed'; end if;
  update public.calc_runs set whatsapp='+13055559981' where dados->>'ref'='Q7X29';
  update public.messages set occurred_at_utc=now()-interval '11 minutes' where id=m;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'old inbound allowed'; end if;
  update public.messages set occurred_at_utc=now(),source_kind='WHATSAPP_HISTORY' where id=m;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'history allowed'; end if;
  update public.messages set source_kind='WHATSAPP_WEBHOOK' where id=m;
  update public.contacts set is_lead=false where id=c;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'nonlead allowed'; end if;
  update public.contacts set is_lead=true where id=c;
  update public.journeys set status='ENCERRADO',closed_at=now(),closed_reason='Test' where id=j;
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'REQUEST_NOT_ACTIVE' then raise exception 'closed request allowed'; end if;
  update public.journeys set status='ATIVO',closed_at=null,closed_reason=null where id=j;
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at)
    values(other,'preview','Other','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,created_at,updated_at)
    values(other_j,'preview',other,'WHATSAPP_DIRECT',now(),now());
  insert into public.journey_refs(environment,journey_id,ref_code,created_at) values('preview',other_j,'Q7X29',now());
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null);
  if result->>'reason'<>'REF_OWNERSHIP_CONFLICT' then raise exception 'forwarded/conflicting Ref allowed'; end if;
  delete from public.journey_refs where journey_id=other_j;
  insert into public.panel_option_links(environment,demand_key,public_code) values('preview','journey:'||j::text||':CARRO',repeat('a',43));
  insert into public.whatsapp_auto_replies(environment,contact_id,inbound_wa_message_id,status)
    values('preview',c,'auto.options.in','FAILED');
  result:=public.panel_whatsapp_auto_options_claim('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null,link,explanation);
  if result->>'reason'<>'GREETING_NOT_READY' then raise exception 'failed greeting allowed'; end if;
  update public.whatsapp_auto_replies set status='SENT' where inbound_wa_message_id='auto.options.in';
  result:=public.panel_whatsapp_auto_options_claim('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null,link,explanation);
  if not (result->>'claimed')::boolean then raise exception 'claim rejected: %',result; end if;
  job:=(result->>'id')::uuid;
  result:=public.panel_whatsapp_auto_options_claim('preview',c,j,m,'auto.options.in','Q7X29','CARRO','+13055559981',null,link,explanation);
  if result->>'reason'<>'ALREADY_CLAIMED' then raise exception 'duplicate allowed'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'EXPLANATION_SENDING');
  if (result->>'updated')::boolean then raise exception 'explanation allowed before link'; end if;
  perform public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  perform public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENT','auto.options.link');
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.link','phone','+13055559981','direction','MCS','body',link,
    'timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  out_id:=(result->>'messageId')::uuid;
  if not exists(select 1 from public.messages where id=out_id and is_automatic) then raise exception 'link not automatic'; end if;
  if exists(select 1 from public.journeys where id=j and (stage<>'NOVO' or last_effective_contact_at is not null)) then raise exception 'link marked human contact'; end if;
  perform public.panel_whatsapp_auto_options_advance('preview',job,'EXPLANATION_SENDING');
  -- Echo before acknowledgement: must be repaired by the advance function.
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.explanation','phone','+13055559981','direction','MCS','body',explanation,
    'timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  out_id:=(result->>'messageId')::uuid;
  perform public.panel_whatsapp_auto_options_advance('preview',job,'COMPLETE','auto.options.explanation');
  if not exists(select 1 from public.messages where id=out_id and is_automatic) then raise exception 'early echo not repaired'; end if;
  if exists(select 1 from public.journeys where id=j and (stage<>'NOVO' or last_effective_contact_at is not null)) then raise exception 'explanation marked human contact'; end if;
  result:=public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  if (result->>'updated')::boolean then raise exception 'completed sequence restarted'; end if;
  if has_table_privilege('anon','public.whatsapp_auto_options','SELECT') or has_table_privilege('authenticated','public.whatsapp_auto_options','INSERT') then raise exception 'private table exposed'; end if;
  if has_function_privilege('anon','public.panel_whatsapp_auto_options_claim(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,text,text)','EXECUTE') then raise exception 'public claim exposed'; end if;
end $$;
do $$
declare raw_id uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); result jsonb; c uuid; j uuid; m uuid; job uuid;
  body text:='My Car Scout · Calculate My Cost Maximum bid: $10,000 Ref: T8X29';
  link text:=E'Opciones actuales:\nhttps://www.mycarscout.net/o/'||repeat('b',43);
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status,received_at)
    values(raw_id,'preview','auto-options-valor-bsuid','messages','{}','DONE',now());
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.valor','userId','US.AutoOptionsTest','direction','CUSTOMER','body',body,
    'timestamp',extract(epoch from now())::bigint::text,'refs',jsonb_build_array('T8X29'),'source_kind','WHATSAPP_WEBHOOK'));
  c:=(result->>'contactId')::uuid;j:=(result->>'journeyId')::uuid;m:=(result->>'messageId')::uuid;
  insert into public.calc_runs(dados,is_test,idioma) values('{"ref":"T8X29","evento":"simulacao"}',false,'es');
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.valor','T8X29','VALOR',null,'US.AutoOptionsTest');
  if not (result->>'eligible')::boolean or result->>'key'<>'journey:'||j::text||':VALOR' or result->>'language'<>'es' then raise exception 'VALOR/BSUID/language failed: %',result; end if;
  insert into public.panel_users(id,environment,auth_user_id,email) values(actor,'preview',gen_random_uuid(),'auto-options-sql@example.test');
  insert into public.journey_toggle_states(environment,journey_id,enabled,switched_at,switched_by) values('preview',j,false,now(),actor);
  result:=public.panel_whatsapp_auto_options_context('preview',c,j,m,'auto.options.valor','T8X29','VALOR',null,'US.AutoOptionsTest');
  if result->>'reason'<>'REQUEST_NOT_ACTIVE' then raise exception 'disabled request allowed'; end if;
  update public.journey_toggle_states set enabled=true where journey_id=j;
  insert into public.panel_option_links(environment,demand_key,public_code) values('preview','journey:'||j::text||':VALOR',repeat('b',43));
  result:=public.panel_whatsapp_auto_options_claim('preview',c,j,m,'auto.options.valor','T8X29','VALOR',null,'US.AutoOptionsTest',link,'Nuestra referencia de mercado. El objetivo es comprar por debajo.');
  if not (result->>'claimed')::boolean then raise exception 'VALOR claim failed: %',result; end if;
  job:=(result->>'id')::uuid;
  perform public.panel_whatsapp_auto_options_advance('preview',job,'LINK_SENDING');
  -- A human using the unchanged manual button sends the raw URL, not the labelled automation body.
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.options.manual','userId','US.AutoOptionsTest','direction','MCS','body',split_part(link,E'\n',2),
    'timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  if not exists(select 1 from public.messages where id=(result->>'messageId')::uuid and not is_automatic) then raise exception 'manual link incorrectly marked automatic'; end if;
  if not exists(select 1 from public.journeys where id=j and stage='RESPONDIDO' and last_effective_contact_at is not null) then raise exception 'manual contact changed'; end if;
  perform public.panel_whatsapp_auto_options_advance('preview',job,'FAILED',null,'D360_NETWORK_ERROR');
  result:=public.panel_whatsapp_auto_options_claim('preview',c,j,m,'auto.options.valor','T8X29','VALOR',null,'US.AutoOptionsTest',link,'Nuestra referencia de mercado. El objetivo es comprar por debajo.');
  if result->>'reason'<>'ALREADY_CLAIMED' then raise exception 'uncertain send retried'; end if;
end $$;
rollback;
