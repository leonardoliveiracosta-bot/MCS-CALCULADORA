begin;
do $$
declare c uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); m uuid:=gen_random_uuid();
  first_reading uuid; second_reading uuid; confirmed_item uuid; result jsonb; allowed jsonb;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Cliente IA','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at)
    values(ch,'preview','WHATSAPP',c,'test-ai-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at)
    values(m,'preview',ch,'WHATSAPP','CUSTOMER','Pago à vista','pago à vista',now(),'ai-'||m,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
    values('preview',m,j,'TEST',now());

  result:=public.panel_ai_replace_reading('preview',j,ch,'{"want":"Audi","money":"À vista","missing":"Prazo"}',jsonb_build_array(
    jsonb_build_object('fingerprint',repeat('a',64),'evidence','Pago à vista','manualReview',false,'item',jsonb_build_object('type','payment','value','cash','evidence','Pago à vista')),
    jsonb_build_object('fingerprint',repeat('b',64),'evidence','Pago à vista','manualReview',true,'item',jsonb_build_object('type','checklist','point',3,'value','OK','evidence','Pago à vista'))
  ),1,m,now(),null);
  first_reading:=(result->>'readingId')::uuid;
  select id into confirmed_item from public.conversation_ai_items where reading_id=first_reading and item_fingerprint=repeat('a',64);
  update public.conversation_ai_items set status='CONFIRMED',decided_at=now() where id=confirmed_item;

  result:=public.panel_ai_replace_reading('preview',j,ch,'{"want":"Audi Q7","money":"À vista","missing":"Prazo"}',jsonb_build_array(
    jsonb_build_object('fingerprint',repeat('a',64),'evidence','Pago à vista','manualReview',false,'item',jsonb_build_object('type','payment','value','cash','evidence','Pago à vista')),
    jsonb_build_object('fingerprint',repeat('c',64),'evidence','Pago à vista','manualReview',false,'item',jsonb_build_object('type','deadline','value','30d','evidence','Pago à vista'))
  ),1,m,now(),null);
  second_reading:=(result->>'readingId')::uuid;
  if (select count(*) from public.conversation_ai_readings where environment='preview' and journey_id=j and status='ACTIVE')<>1 then raise exception 'AI_ACTIVE_READING_COUNT'; end if;
  if (select count(*) from public.conversation_ai_items where reading_id=second_reading and status='PENDING')<>1 then raise exception 'AI_REPLACEMENT_PENDING_COUNT'; end if;
  if (select status from public.conversation_ai_items where id=confirmed_item)<>'CONFIRMED' then raise exception 'AI_CONFIRMED_CHANGED'; end if;
  if exists(select 1 from public.conversation_ai_items where reading_id=second_reading and item_fingerprint=repeat('a',64)) then raise exception 'AI_CONFIRMED_RETURNED'; end if;
  if not exists(select 1 from public.conversation_ai_items where reading_id=first_reading and item_fingerprint=repeat('b',64) and status='SUPERSEDED') then raise exception 'AI_PENDING_NOT_SUPERSEDED'; end if;

  begin
    perform public.panel_ai_confirm_items('preview',null,j,second_reading,array[(select id from public.conversation_ai_items where reading_id=second_reading)],gen_random_uuid(),'{}');
    raise exception 'AI_REF_SHOULD_BE_REQUIRED';
  exception when others then
    if sqlerrm not like '%AI_REF_REQUIRED%' then raise; end if;
  end;

  delete from public.conversation_ai_daily_usage where environment='preview';
  insert into public.conversation_ai_daily_usage values('preview',((now() at time zone 'America/New_York')::date)-1,100,now());
  allowed:=public.panel_ai_reserve_call('preview');
  if not (allowed->>'allowed')::boolean or (allowed->>'count')::integer<>1 then raise exception 'AI_DAY_DID_NOT_RESET'; end if;
  update public.conversation_ai_daily_usage set call_count=99 where environment='preview' and day_et=(now() at time zone 'America/New_York')::date;
  allowed:=public.panel_ai_reserve_call('preview');
  if not (allowed->>'allowed')::boolean or (allowed->>'count')::integer<>100 then raise exception 'AI_LIMIT_100_FAILED'; end if;
  allowed:=public.panel_ai_reserve_call('preview');
  if (allowed->>'allowed')::boolean then raise exception 'AI_LIMIT_EXCEEDED'; end if;
  raise notice 'OK: leituras da IA, confirmação sem Ref e limite diário';
end $$;
rollback;
