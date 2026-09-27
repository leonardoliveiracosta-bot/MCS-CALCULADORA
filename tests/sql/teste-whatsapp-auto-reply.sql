do $$
declare
  raw_id uuid:=gen_random_uuid();
  contact_new uuid:=gen_random_uuid(); chat_new uuid:=gen_random_uuid(); inbound_new uuid:=gen_random_uuid(); inbound_second uuid:=gen_random_uuid();
  contact_recent uuid:=gen_random_uuid(); chat_recent uuid:=gen_random_uuid(); recent_mcs uuid:=gen_random_uuid(); inbound_recent uuid:=gen_random_uuid();
  contact_old uuid:=gen_random_uuid(); chat_old uuid:=gen_random_uuid(); inbound_old uuid:=gen_random_uuid();
  contact_nonlead uuid:=gen_random_uuid(); chat_nonlead uuid:=gen_random_uuid(); inbound_nonlead uuid:=gen_random_uuid();
  contact_test uuid:=gen_random_uuid(); chat_test uuid:=gen_random_uuid(); inbound_test_one uuid:=gen_random_uuid(); inbound_test_two uuid:=gen_random_uuid();
  result jsonb;
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status,received_at)
    values(raw_id,'preview','auto-reply-claims','messages','{}','DONE',now());
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values
    (contact_new,'preview','New','WHATSAPP_DIRECT',now(),now()),
    (contact_recent,'preview','Recent','WHATSAPP_DIRECT',now(),now()),
    (contact_old,'preview','Old','WHATSAPP_DIRECT',now(),now()),
    (contact_nonlead,'preview','Nonlead','WHATSAPP_DIRECT',now(),now()),
    (contact_test,'preview','Test','WHATSAPP_DIRECT',now(),now());
  update public.contacts set is_lead=false where id=contact_nonlead;
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values
    (chat_new,'preview','WHATSAPP',contact_new,'auto:new','RESOLVED',false,now(),now(),now(),now()),
    (chat_recent,'preview','WHATSAPP',contact_recent,'auto:recent','RESOLVED',false,now(),now(),now(),now()),
    (chat_old,'preview','WHATSAPP',contact_old,'auto:old','RESOLVED',false,now(),now(),now(),now()),
    (chat_nonlead,'preview','WHATSAPP',contact_nonlead,'auto:nonlead','RESOLVED',false,now(),now(),now(),now()),
    (chat_test,'preview','WHATSAPP',contact_test,'auto:test','RESOLVED',false,now(),now(),now(),now());

  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at) values
    (inbound_new,'preview',chat_new,'WHATSAPP','CUSTOMER','Hi','hi',now(),false,'WA:auto.new',1,'WHATSAPP_WEBHOOK',now()),
    (recent_mcs,'preview',chat_recent,'WHATSAPP','MCS','Previous','previous',now()-interval '3 days',false,'WA:auto.previous',1,'WHATSAPP_WEBHOOK',now()-interval '3 days'),
    (inbound_recent,'preview',chat_recent,'WHATSAPP','CUSTOMER','Hi','hi',now(),false,'WA:auto.recent',1,'WHATSAPP_WEBHOOK',now()),
    (inbound_old,'preview',chat_old,'WHATSAPP','CUSTOMER','Hi','hi',now()-interval '11 minutes',false,'WA:auto.old',1,'WHATSAPP_WEBHOOK',now()-interval '11 minutes'),
    (inbound_nonlead,'preview',chat_nonlead,'WHATSAPP','CUSTOMER','Hi','hi',now(),false,'WA:auto.nonlead',1,'WHATSAPP_WEBHOOK',now()),
    (inbound_test_one,'preview',chat_test,'WHATSAPP','CUSTOMER','One','one',now(),false,'WA:auto.test.1',1,'WHATSAPP_WEBHOOK',now()),
    (inbound_test_two,'preview',chat_test,'WHATSAPP','CUSTOMER','Two','two',now()+interval '1 second',false,'WA:auto.test.2',1,'WHATSAPP_WEBHOOK',now()+interval '1 second');
  insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id) values
    ('preview','auto.new',inbound_new,raw_id),
    ('preview','auto.recent',inbound_recent,raw_id),
    ('preview','auto.old',inbound_old,raw_id),
    ('preview','auto.nonlead',inbound_nonlead,raw_id),
    ('preview','auto.test.1',inbound_test_one,raw_id),
    ('preview','auto.test.2',inbound_test_two,raw_id);

  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_new,inbound_new,'auto.new',false);
  if not (result->>'claimed')::boolean then raise exception 'new contact was not claimed'; end if;
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_new,inbound_new,'auto.new',false);
  if result->>'reason'<>'ALREADY_CLAIMED' then raise exception 'retry was not deduplicated'; end if;

  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
    values(inbound_second,'preview',chat_new,'WHATSAPP','CUSTOMER','Again','again',now()+interval '2 seconds',false,'WA:auto.second',1,'WHATSAPP_WEBHOOK',now()+interval '2 seconds');
  insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id)
    values('preview','auto.second',inbound_second,raw_id);
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_new,inbound_second,'auto.second',false);
  if result->>'reason'<>'RECENT_MESSAGE' then raise exception 'second message was not blocked'; end if;
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_recent,inbound_recent,'auto.recent',false);
  if result->>'reason'<>'RECENT_MESSAGE' then raise exception 'MCS message from 3 days ago did not block'; end if;
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_old,inbound_old,'auto.old',false);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'old inbound was eligible'; end if;
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_nonlead,inbound_nonlead,'auto.nonlead',false);
  if result->>'reason'<>'INBOUND_NOT_ELIGIBLE' then raise exception 'non-lead was eligible'; end if;
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_test,inbound_test_one,'auto.test.1',true);
  if not (result->>'claimed')::boolean then raise exception 'test number first claim failed'; end if;
  result:=public.panel_whatsapp_claim_auto_reply('preview',contact_test,inbound_test_two,'auto.test.2',true);
  if result->>'reason'<>'TEST_RATE_LIMIT' then raise exception 'test number rate limit failed'; end if;
end $$;

do $$
declare raw_id uuid:=gen_random_uuid(); result jsonb; journey_id uuid; outbound_id uuid;
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status,received_at)
    values(raw_id,'preview','auto-reply-rpc','messages','{}','DONE',now());
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.rpc.in','phone','+13055559990','name','Welcome Test','direction','CUSTOMER','body','Hello','timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  journey_id:=(result->>'journeyId')::uuid;
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object(
    'messageId','auto.rpc.out','phone','+13055559990','name','Welcome Test','direction','MCS','body','Hi, this is an automatic message from My Car Scout - test','timestamp',extract(epoch from now())::bigint::text,'refs','[]'::jsonb,'source_kind','WHATSAPP_WEBHOOK'));
  outbound_id:=(result->>'messageId')::uuid;
  if not exists(select 1 from public.messages where id=outbound_id and is_automatic) then raise exception 'outbound was not marked automatic'; end if;
  if exists(select 1 from public.journeys where id=journey_id and (stage<>'NOVO' or last_effective_contact_at is not null)) then raise exception 'automatic reply removed the lead from unanswered HOJE'; end if;
end $$;
