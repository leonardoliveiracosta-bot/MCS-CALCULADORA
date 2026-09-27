-- Regressions for WhatsApp dedupe-by-wamid and the one-off history repair.
-- Everything runs in a transaction and is rolled back.

begin;
do $$
declare
  c uuid := gen_random_uuid();
  j uuid := gen_random_uuid();
  r_history uuid := gen_random_uuid();
  r_webhook uuid := gen_random_uuid();
  phone text := '+1305' || lpad((floor(random()*9000000)+1000000)::int::text,7,'0');
  stamp timestamptz := date_trunc('minute', now() - interval '1 day') + interval '10 seconds';
  first_id uuid;
  second_id uuid;
  zip_id uuid;
  repaired_id uuid;
  before_count bigint;
  after_count bigint;
  repair_item jsonb;
begin
  insert into public.contacts(id,environment,display_name,created_at,updated_at)
    values(c,'preview','Teste dedupe WhatsApp',now(),now());
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
    values('preview',c,phone,phone,true,true,now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',stamp,now());
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json)
    values
      (r_history,'preview','teste-history-'||r_history,'history','{}'),
      (r_webhook,'preview','teste-webhook-'||r_webhook,'messages','{}');

  perform public.panel_whatsapp_apply_message('preview',r_history,
    jsonb_build_object('phone',phone,'messageId','wamid.history.1.'||r_history,
      'body','📷 foto (arquivo não veio no histórico)','direction','CUSTOMER',
      'timestamp',extract(epoch from stamp)::text,'forceContactId',c,
      'source_kind','WHATSAPP_HISTORY'));
  perform public.panel_whatsapp_apply_message('preview',r_history,
    jsonb_build_object('phone',phone,'messageId','wamid.history.2.'||r_history,
      'body','📷 foto (arquivo não veio no histórico)','direction','CUSTOMER',
      'timestamp',extract(epoch from stamp + interval '5 seconds')::text,'forceContactId',c,
      'source_kind','WHATSAPP_HISTORY'));

  select message_id into first_id from public.whatsapp_message_ids
    where environment='preview' and wa_message_id='wamid.history.1.'||r_history;
  select message_id into second_id from public.whatsapp_message_ids
    where environment='preview' and wa_message_id='wamid.history.2.'||r_history;
  if first_id=second_id then
    raise exception 'FALHA: duas mídias de histórico com wamids diferentes foram fundidas';
  end if;
  if (select count(*) from public.messages where id in (first_id,second_id))<>2 then
    raise exception 'FALHA: duas mídias de histórico não criaram duas mensagens';
  end if;

  select count(*) into before_count from public.messages where environment='preview';
  perform public.panel_whatsapp_apply_message('preview',r_history,
    jsonb_build_object('phone',phone,'messageId','wamid.history.1.'||r_history,
      'body','📷 foto (arquivo não veio no histórico)','direction','CUSTOMER',
      'timestamp',extract(epoch from stamp)::text,'forceContactId',c,
      'source_kind','WHATSAPP_HISTORY'));
  select count(*) into after_count from public.messages where environment='preview';
  if after_count<>before_count then
    raise exception 'FALHA: o mesmo wamid criou uma segunda mensagem';
  end if;

  select chat_id into zip_id from public.messages where id=first_id;
  insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,
      occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
    select 'preview',m.chat_id,'WHATSAPP','CUSTOMER','texto conciliado com ZIP',
      'texto conciliado com zip',stamp,false,'ZIP:'||r_webhook,1,'WHATSAPP_ZIP',now()
    from public.messages m where m.id=first_id
    returning id into zip_id;
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
    values('preview',zip_id,j,'WHATSAPP_ZIP',now());
  perform public.panel_whatsapp_apply_message('preview',r_webhook,
    jsonb_build_object('phone',phone,'messageId','wamid.webhook.zip.'||r_webhook,
      'body','texto conciliado com ZIP','direction','CUSTOMER',
      'timestamp',extract(epoch from stamp)::text,'forceContactId',c));
  if (select message_id from public.whatsapp_message_ids
       where environment='preview' and wa_message_id='wamid.webhook.zip.'||r_webhook)<>zip_id then
    raise exception 'FALHA: webhook não conciliou com a mensagem WHATSAPP_ZIP';
  end if;

  insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id)
    values('preview','wamid.history.extra.'||r_history,first_id,r_history);
  repair_item := jsonb_build_object(
    'body','📷 foto (arquivo não veio no histórico)',
    'direction','CUSTOMER',
    'timestamp',extract(epoch from stamp + interval '7 seconds')::text);

  insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,
      occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
    select m.environment,m.chat_id,'WHATSAPP',(repair_item->>'direction')::public.panel_message_direction,
      repair_item->>'body',lower(trim(regexp_replace(repair_item->>'body','\s+',' ','g'))),
      to_timestamp((repair_item->>'timestamp')::double precision),false,
      'WA:wamid.history.extra.'||r_history,1,m.source_kind,now()
    from public.whatsapp_message_ids w
    join public.messages m on m.id=w.message_id and m.environment=w.environment
    where w.environment='preview' and w.wa_message_id='wamid.history.extra.'||r_history
      and m.signature_base like 'WA:%'
      and m.signature_base<>'WA:'||w.wa_message_id
      and not exists (
        select 1 from public.whatsapp_dedupe_repair_log l
        where l.environment=w.environment and l.wa_message_id=w.wa_message_id)
    returning id into repaired_id;
  if repaired_id is null then raise exception 'FALHA: dry-run reparável não foi encontrado'; end if;

  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
    select environment,repaired_id,journey_id,'DEDUPE_REPAIR',now()
    from public.message_journeys where environment='preview' and message_id=first_id;
  insert into public.interactions(environment,journey_id,message_id,type,occurred_at,created_at)
    select environment,journey_id,repaired_id,'INBOUND_MESSAGE',
      to_timestamp((repair_item->>'timestamp')::double precision),now()
    from public.message_journeys where environment='preview' and message_id=repaired_id;
  update public.whatsapp_message_ids set message_id=repaired_id
    where environment='preview' and wa_message_id='wamid.history.extra.'||r_history
      and message_id=first_id;
  insert into public.whatsapp_dedupe_repair_log(environment,wa_message_id,old_message_id,new_message_id,raw_event_id)
    values('preview','wamid.history.extra.'||r_history,first_id,repaired_id,r_history);

  if (select message_id from public.whatsapp_message_ids
       where environment='preview' and wa_message_id='wamid.history.extra.'||r_history)<>repaired_id then
    raise exception 'FALHA: reparo não moveu o wamid para a mensagem própria';
  end if;
  if (select association_source from public.message_journeys
       where environment='preview' and message_id=repaired_id limit 1)<>'DEDUPE_REPAIR' then
    raise exception 'FALHA: reparo não copiou a journey';
  end if;

  select count(*) into before_count from public.messages where environment='preview';
  -- Segunda execução: o filtro idempotente não encontra o wamid já registrado.
  insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,
      occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
    select m.environment,m.chat_id,'WHATSAPP',(repair_item->>'direction')::public.panel_message_direction,
      repair_item->>'body',lower(trim(regexp_replace(repair_item->>'body','\s+',' ','g'))),
      to_timestamp((repair_item->>'timestamp')::double precision),false,
      'WA:wamid.history.extra.'||r_history,1,m.source_kind,now()
    from public.whatsapp_message_ids w
    join public.messages m on m.id=w.message_id and m.environment=w.environment
    where w.environment='preview' and w.wa_message_id='wamid.history.extra.'||r_history
      and m.signature_base like 'WA:%'
      and m.signature_base<>'WA:'||w.wa_message_id
      and not exists (
        select 1 from public.whatsapp_dedupe_repair_log l
        where l.environment=w.environment and l.wa_message_id=w.wa_message_id);
  get diagnostics after_count = row_count;
  if after_count<>0 or (select count(*) from public.messages where environment='preview')<>before_count then
    raise exception 'FALHA: segunda execução do reparo alterou dados';
  end if;

  -- Um wamid de webhook pode apontar legitimamente para ZIP e não é reparável.
  insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id)
    values('preview','wamid.zip.legit.'||r_webhook,zip_id,r_webhook);
  if exists (
    select 1 from public.whatsapp_message_ids w
    join public.messages m on m.id=w.message_id and m.environment=w.environment
    where w.environment='preview' and w.wa_message_id='wamid.zip.legit.'||r_webhook
      and m.signature_base like 'WA:%'
      and m.signature_base<>'WA:'||w.wa_message_id) then
    raise exception 'FALHA: mensagem ZIP entrou no conjunto reparável';
  end if;
  if exists (select 1 from public.whatsapp_dedupe_repair_log
      where environment='preview' and wa_message_id='wamid.zip.legit.'||r_webhook) then
    raise exception 'FALHA: mensagem ZIP foi registrada como reparada';
  end if;

  raise notice 'OK: dedupe por wamid e reparo idempotente';
end $$;
rollback;
