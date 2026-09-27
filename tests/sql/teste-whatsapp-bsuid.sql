-- Regressões para contatos WhatsApp identificados somente por BSUID.
begin;
do $$
declare
  raw_one uuid:=gen_random_uuid();
  raw_two uuid:=gen_random_uuid();
  raw_merge uuid:=gen_random_uuid();
  raw_invalid uuid:=gen_random_uuid();
  old_contact uuid;
  old_journey uuid;
  target_contact uuid:=gen_random_uuid();
  target_journey uuid:=gen_random_uuid();
  first_message uuid;
  phone text:='+1305'||lpad((floor(random()*9000000)+1000000)::int::text,7,'0');
  v_bsuid text:='US.'||replace(gen_random_uuid()::text,'-','');
  stamp timestamptz:=now()-interval '1 day';
  before_count bigint;
  after_count bigint;
begin
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json)
    values
      (raw_one,'preview','bsuid-one-'||raw_one,'history','{}'),
      (raw_two,'preview','bsuid-two-'||raw_two,'history','{}'),
      (raw_merge,'preview','bsuid-merge-'||raw_merge,'messages','{}'),
      (raw_invalid,'preview','bsuid-invalid-'||raw_invalid,'messages','{}');

  perform public.panel_whatsapp_apply_message('preview',raw_one,jsonb_build_object(
    'userId',v_bsuid,'username','sem.numero','messageId','wamid.bsuid.1.'||raw_one,
    'body','primeira mensagem','direction','CUSTOMER','timestamp',extract(epoch from stamp)::text,
    'source_kind','WHATSAPP_HISTORY'));
  select contact_id into old_contact from public.whatsapp_user_ids where environment='preview' and whatsapp_user_ids.bsuid=v_bsuid;
  select id into old_journey from public.journeys where environment='preview' and contact_id=old_contact order by created_at limit 1;
  select message_id into first_message from public.whatsapp_message_ids where environment='preview' and wa_message_id='wamid.bsuid.1.'||raw_one;
  if old_contact is null or old_journey is null or first_message is null then raise exception 'FALHA: BSUID sem telefone não criou contato, jornada e mensagem'; end if;
  if exists(select 1 from public.contact_phones where environment='preview' and contact_id=old_contact) then raise exception 'FALHA: BSUID sem telefone criou contact_phone'; end if;
  if not exists(select 1 from public.chats where environment='preview' and contact_id=old_contact and canonical_key='wa-user:'||v_bsuid) then raise exception 'FALHA: chat wa-user não foi criado'; end if;

  perform public.panel_whatsapp_apply_message('preview',raw_two,jsonb_build_object(
    'userId',v_bsuid,'username','sem.numero','messageId','wamid.bsuid.2.'||raw_two,
    'body','segunda mensagem','direction','CUSTOMER','timestamp',extract(epoch from stamp+interval '1 minute')::text,
    'source_kind','WHATSAPP_HISTORY'));
  if (select count(distinct contact_id) from public.whatsapp_user_ids where environment='preview' and whatsapp_user_ids.bsuid=v_bsuid)<>1 then raise exception 'FALHA: segunda mensagem mudou o contato do BSUID'; end if;
  if (select count(*) from public.messages where environment='preview' and signature_base in ('WA:wamid.bsuid.1.'||raw_one,'WA:wamid.bsuid.2.'||raw_two))<>2 then raise exception 'FALHA: segunda mensagem do BSUID não foi preservada'; end if;

  insert into public.contacts(id,environment,display_name,source,created_at,updated_at)
    values(target_contact,'preview','Contato com telefone','WHATSAPP_DIRECT',now(),now());
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
    values('preview',target_contact,phone,phone,true,true,now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(target_journey,'preview',target_contact,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());

  perform public.panel_whatsapp_apply_message('preview',raw_merge,jsonb_build_object(
    'phone',phone,'userId',v_bsuid,'username','sem.numero','messageId','wamid.bsuid.merge.'||raw_merge,
    'body','agora com telefone','direction','CUSTOMER','timestamp',extract(epoch from stamp+interval '2 minutes')::text));
  if (select contact_id from public.whatsapp_user_ids where environment='preview' and whatsapp_user_ids.bsuid=v_bsuid)<>target_contact then raise exception 'FALHA: BSUID não foi reapontado para o contato do telefone'; end if;
  if (select is_lead from public.contacts where id=old_contact) is distinct from false then raise exception 'FALHA: contato antigo não foi ocultado'; end if;
  if exists(select 1 from public.chats where environment='preview' and contact_id=old_contact) then raise exception 'FALHA: chat permaneceu no contato antigo'; end if;
  if not exists(select 1 from public.message_journeys where environment='preview' and message_id=first_message and journey_id=target_journey) then raise exception 'FALHA: mensagem antiga não foi preservada na jornada principal'; end if;
  if (select count(*) from public.contacts where id in (old_contact,target_contact) and is_lead is distinct from false)<>1 then raise exception 'FALHA: junção deixou mais de um contato visível'; end if;

  begin
    perform public.panel_whatsapp_apply_message('preview',raw_invalid,jsonb_build_object(
      'messageId','wamid.invalid.'||raw_invalid,'body','sem identificador','direction','CUSTOMER','timestamp',extract(epoch from stamp)::text));
    raise exception 'FALHA: mensagem sem telefone e sem BSUID foi aceita';
  exception when others then
    if sqlerrm not like '%MESSAGE_INVALID%' then raise; end if;
  end;

  select count(*) into before_count from public.messages where environment='preview';
  perform public.panel_whatsapp_apply_message('preview',raw_merge,jsonb_build_object(
    'phone',phone,'userId',v_bsuid,'username','sem.numero','messageId','wamid.bsuid.merge.'||raw_merge,
    'body','agora com telefone','direction','CUSTOMER','timestamp',extract(epoch from stamp+interval '2 minutes')::text));
  select count(*) into after_count from public.messages where environment='preview';
  if after_count<>before_count then raise exception 'FALHA: mesmo wamid duplicou mensagem após junção'; end if;

  raise notice 'OK: BSUID sem telefone e junção automática';
end $$;
rollback;
