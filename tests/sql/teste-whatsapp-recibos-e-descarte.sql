do $$
declare
  raw_id uuid:=gen_random_uuid(); contact_id uuid:=gen_random_uuid(); chat_id uuid:=gen_random_uuid(); message_id uuid:=gen_random_uuid();
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status,received_at)
    values(raw_id,'preview','receipt-test','messages','{}','DONE',now());
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at)
    values(contact_id,'preview','Receipt','WHATSAPP_DIRECT',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at)
    values(chat_id,'preview','WHATSAPP',contact_id,'receipt:test','RESOLVED',false,now(),now(),now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
    values(message_id,'preview',chat_id,'WHATSAPP','MCS','Hello','hello',now()-interval '3 hours',false,'WA:receipt.test',1,'WHATSAPP_WEBHOOK',now()-interval '3 hours');
  insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id)
    values('preview','receipt.test',message_id,raw_id);
  perform public.panel_whatsapp_apply_status('preview',jsonb_build_object('id','receipt.test','status','read','timestamp',extract(epoch from now())::bigint::text));
  if not exists(select 1 from public.messages where id=message_id and whatsapp_read_at is not null and whatsapp_delivered_at is not null) then raise exception 'read receipt was not stored'; end if;
end $$;

do $$
begin
  if not exists(select 1 from information_schema.columns where table_schema='public' and table_name='panel_item_dispositions' and column_name='discard_reason') then raise exception 'discard_reason missing'; end if;
  begin
    insert into public.panel_item_dispositions(environment,item_kind,item_key,status,discard_reason,updated_by)
      values('preview','REF','ZXCV2','DISCARDED','INVALID','10000000-0000-4000-8000-000000000001');
    raise exception 'invalid discard reason accepted';
  exception when check_violation then null;
  end;
end $$;
