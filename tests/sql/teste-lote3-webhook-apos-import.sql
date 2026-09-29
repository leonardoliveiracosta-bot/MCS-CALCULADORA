-- A16: a mensagem do webhook que chega depois de importar o export do WhatsApp não duplica.
begin;
do $$
declare
  raw_one uuid:=gen_random_uuid();
  v_contact uuid:=gen_random_uuid();
  v_journey uuid:=gen_random_uuid();
  v_chat uuid:=gen_random_uuid();
  v_message uuid:=gen_random_uuid();
  phone text:='+1305'||lpad((floor(random()*9000000)+1000000)::int::text,7,'0');
  stamp timestamptz:=date_trunc('minute',now()-interval '2 hours');
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json)
    values(raw_one,'preview','lote3-import-'||raw_one,'messages','{}');
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at)
    values(v_contact,'preview','Cliente Import','WHATSAPP_DIRECT',now(),now());
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
    values('preview',v_contact,phone,phone,true,true,now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(v_journey,'preview',v_contact,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at)
    values(v_chat,'preview','WHATSAPP',v_contact,'lote3-'||v_chat,'RESOLVED',now(),now());
  -- como o painel grava o export: source_kind IMPORT e corpo só aparado, com maiúsculas
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
    values(v_message,'preview',v_chat,'WHATSAPP','CUSTOMER','Quero  uma X5','Quero  uma X5',stamp,'sig-lote3-'||v_message,1,'IMPORT',now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
    values('preview',v_message,v_journey,'IMPORT',now());

  perform public.panel_whatsapp_apply_message('preview',raw_one,jsonb_build_object(
    'phone',phone,'name','Cliente Import','messageId','wamid.lote3.'||raw_one,
    'body','quero uma x5','direction','CUSTOMER','timestamp',extract(epoch from stamp+interval '41 seconds')::text));
  if (select count(*) from public.messages m join public.message_journeys l on l.message_id=m.id where l.journey_id=v_journey)<>1 then
    raise exception 'FALHA: a mensagem do webhook duplicou a mensagem importada';
  end if;
end $$;
rollback;
