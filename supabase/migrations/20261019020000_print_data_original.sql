-- Print de SMS: a mensagem leva o momento real em que o cliente mandou o SMS, nunca a hora da confirmação.
-- Regra (uma só, para o print novo e para a correção dos antigos: panel_sms_print_fix_date):
--  1. Com Ref: o último clique no botão de SMS da calculadora dessa Ref (evento 'sms', ou 'busca' com canal 'sms') antes da
--     confirmação; sem clique, o último registro dessa Ref antes da confirmação. Ref comparada sem maiúsculas e sem espaços;
--     calc_runs de teste não contam.
--  2. Sem Ref, ou Ref sem registro: occurred_at_utc vazio, time_uncertain e 'data original desconhecida'. Essa mensagem
--     nunca é recente: não é a última mensagem do lead, não move "visto por último", não entra no HOJE nem no topo.
-- A hora da confirmação é messages.created_at (gravada no clique), nunca usada como data da mensagem de um print.

create index if not exists calc_runs_ref_norm_idx on public.calc_runs ((upper(regexp_replace(coalesce(dados->>'ref', ''), '\s', '', 'g'))), created_at desc);

-- The moment a message happened, for every reader: a print without its original date has none (never its creation time).
create or replace function public.panel_message_at(p_utc timestamptz, p_local timestamp, p_created timestamptz, p_source text)
-- No search_path here on purpose: a plain immutable SQL function is inlined, so the per-message call costs nothing.
returns timestamptz language sql immutable as $$
  select coalesce(p_utc, p_local at time zone 'UTC', case when p_source = 'SMS_PRINT' then null else p_created end)
$$;
grant execute on function public.panel_message_at(timestamptz, timestamp, timestamptz, text) to service_role;

create or replace function public.panel_sms_print_moment(p_ref text, p_before timestamptz)
returns table(at timestamptz, source text) language sql stable security definer set search_path = public as $$
  select c.created_at,
    case when lower(coalesce(c.dados->>'evento', '')) = 'sms' or (lower(coalesce(c.dados->>'evento', '')) = 'busca' and lower(coalesce(c.dados->>'canal', '')) = 'sms') then 'CLIQUE_SMS' else 'CALCULADORA' end
  from public.calc_runs c
  where coalesce(p_ref, '') <> '' and not c.is_test and c.created_at <= p_before
    and upper(regexp_replace(coalesce(c.dados->>'ref', ''), '\s', '', 'g')) = upper(regexp_replace(p_ref, '\s', '', 'g'))
  order by (lower(coalesce(c.dados->>'evento', '')) = 'sms' or (lower(coalesce(c.dados->>'evento', '')) = 'busca' and lower(coalesce(c.dados->>'canal', '')) = 'sms')) desc, c.created_at desc
  limit 1
$$;
revoke all on function public.panel_sms_print_moment(text, timestamptz) from public, anon, authenticated;
grant execute on function public.panel_sms_print_moment(text, timestamptz) to service_role;

-- "Visto por último" (and first) of a chat: its real messages only; a print without date never moves it.
create or replace function public.panel_refresh_chat_seen(p_environment public.panel_environment, p_chat uuid)
returns void language sql security definer set search_path = public as $$
  update public.chats ch set
    first_seen_at = s.first_at, last_seen_at = s.last_at
  from (select min(public.panel_message_at(m.occurred_at_utc, m.occurred_at_local, m.created_at, m.source_kind)) first_at,
               max(public.panel_message_at(m.occurred_at_utc, m.occurred_at_local, m.created_at, m.source_kind)) last_at
          from public.messages m where m.environment = p_environment and m.chat_id = p_chat and m.undone_at is null) s
  where ch.environment = p_environment and ch.id = p_chat
    and (ch.first_seen_at is distinct from s.first_at or ch.last_seen_at is distinct from s.last_at)
$$;
revoke all on function public.panel_refresh_chat_seen(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_refresh_chat_seen(public.panel_environment, uuid) to service_role;

create or replace function public.panel_sms_print_fix_date(p_environment public.panel_environment, p_message uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare v_msg public.messages%rowtype; v_ref text; v_at timestamptz; v_source text;
begin
  select * into v_msg from public.messages m where m.environment = p_environment and m.id = p_message and m.source_kind = 'SMS_PRINT' for update;
  if not found then return null; end if;
  select nullif(upper(regexp_replace(coalesce(r.extracted_json->>'ref', ''), '\s', '', 'g')), '') into v_ref
    from public.sms_print_reads r where r.environment = p_environment and r.message_id = p_message order by (r.status = 'CONFIRMED') desc, r.updated_at desc limit 1;
  if v_ref is null then v_ref := upper(substring(coalesce(v_msg.body_text, '') from '(?in)^\s*ref:[ \t]*([A-Za-z0-9]{5})\M')); end if;
  if v_ref is not null then select x.at, x.source into v_at, v_source from public.panel_sms_print_moment(v_ref, v_msg.created_at) x; end if;
  if v_at is not null then
    update public.messages m set occurred_at_utc = v_at, occurred_at_local = null, timezone_assumed = null, time_uncertain = false,
      original_datetime_text = case when v_source = 'CLIQUE_SMS' then 'clique no SMS da calculadora · Ref ' else 'registro da calculadora · Ref ' end || v_ref
      where m.id = p_message;
    update public.interactions i set occurred_at = v_at where i.environment = p_environment and i.message_id = p_message and i.type = 'INBOUND_MESSAGE';
  else
    update public.messages m set occurred_at_utc = null, occurred_at_local = null, timezone_assumed = null, time_uncertain = true,
      original_datetime_text = 'data original desconhecida' where m.id = p_message;
  end if;
  perform public.panel_refresh_chat_seen(p_environment, v_msg.chat_id);
  return jsonb_build_object('messageId', p_message, 'ref', v_ref, 'at', v_at, 'source', coalesce(v_source, 'DESCONHECIDA'));
end $$;
revoke all on function public.panel_sms_print_fix_date(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_sms_print_fix_date(public.panel_environment, uuid) to service_role;

-- The summary of a lead's messages (CLIENTES, HOJE): a print without date counts as a message but is never the first, last or latest.
create or replace function public.panel_journey_message_facts(p_environment public.panel_environment, p_limit integer default 500, p_offset integer default 0)
returns table(journey_id uuid, message_count integer, customer_count integer, first_customer_at timestamptz, first_customer_channel text, first_customer_source text, first_customer_text text, last_customer_id uuid, last_customer_at timestamptz, last_customer_text text, last_customer_channel text, last_customer_source text, last_mcs_id uuid, last_mcs_at timestamptz, last_mcs_delivered_at timestamptz, last_mcs_read_at timestamptz, last_mcs_automatic boolean, latest_id uuid, latest_direction text, latest_at timestamptz, latest_text text, latest_automatic boolean, latest_source text, latest_real_at timestamptz, latest_real_mcs_at timestamptz)
language sql stable security definer set search_path = public as $$
  with m as (
    select mj.journey_id, msg.id, msg.direction::text as direction, msg.body_text, coalesce(msg.is_automatic, false) as automatic,
      msg.channel::text as channel, msg.source_kind, msg.whatsapp_delivered_at, msg.whatsapp_read_at,
      public.panel_message_at(msg.occurred_at_utc, msg.occurred_at_local, msg.created_at, msg.source_kind) as at,
      coalesce(msg.occurred_at_utc, msg.occurred_at_local at time zone 'UTC') as real_at
    from public.message_journeys mj
    join public.messages msg on msg.id = mj.message_id and msg.environment = p_environment and msg.undone_at is null
    where mj.environment = p_environment and mj.undone_at is null
  ),
  first_customer as (
    select distinct on (journey_id) journey_id, at, channel, source_kind, left(body_text, 300) as body
    from m where direction = 'CUSTOMER' and at is not null order by journey_id, at asc, id asc
  ),
  last_customer as (
    select distinct on (journey_id) journey_id, id, at, channel, source_kind, left(body_text, 600) as body
    from m where direction = 'CUSTOMER' and at is not null order by journey_id, at desc, id desc
  ),
  last_mcs as (
    select distinct on (journey_id) journey_id, id, at, whatsapp_delivered_at, whatsapp_read_at, automatic
    from m where direction = 'MCS' and at is not null order by journey_id, at desc, id desc
  ),
  latest as (
    select distinct on (journey_id) journey_id, id, direction, at, left(body_text, 600) as body, automatic, source_kind
    from m where at is not null order by journey_id, automatic asc, at desc, id desc
  ),
  counts as (
    select journey_id, count(*)::integer as total, count(*) filter (where direction = 'CUSTOMER')::integer as customers,
      max(real_at) filter (where not automatic) as latest_real_at,
      max(real_at) filter (where not automatic and direction = 'MCS') as latest_real_mcs_at
    from m group by journey_id
  )
  select c.journey_id, c.total, c.customers,
    fc.at, fc.channel, fc.source_kind, fc.body,
    lc.id, lc.at, lc.body, lc.channel, lc.source_kind,
    lm.id, lm.at, lm.whatsapp_delivered_at, lm.whatsapp_read_at, lm.automatic,
    l.id, l.direction, l.at, l.body, l.automatic, l.source_kind,
    c.latest_real_at, c.latest_real_mcs_at
  from counts c
  left join first_customer fc on fc.journey_id = c.journey_id
  left join last_customer lc on lc.journey_id = c.journey_id
  left join last_mcs lm on lm.journey_id = c.journey_id
  left join latest l on l.journey_id = c.journey_id
  order by c.journey_id
  limit greatest(1, least(coalesce(p_limit, 500), 1000)) offset greatest(0, coalesce(p_offset, 0));
$$;

-- Confirmation of a print: unchanged except the date rule at the end.
create or replace function public.panel_sms_print_confirm(p_environment public.panel_environment,p_actor uuid,p_read uuid,p_target_journey uuid,p_keep_source boolean,p_phone text,p_name text,p_ref text,p_message text,p_translation text,p_attachment uuid,p_bucket text,p_storage_path text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_print_reads%rowtype; j public.journeys%rowtype; source_j public.journeys%rowtype; ref_j public.journeys%rowtype; c public.contacts%rowtype; chat_id uuid; msg_id uuid; attached_id uuid; chosen_ref text:=nullif(upper(trim(p_ref)), ''); phone text; at_time timestamptz:=clock_timestamp(); norm text;
begin
 if p_actor is null or p_read is null or p_attachment is null or p_bucket<>'mcs-panel-attachments' or p_storage_path not like 'panel/'||p_environment::text||'/%' or length(trim(coalesce(p_message,''))) not between 1 and 25000 then raise exception 'SMS_PRINT_INVALID'; end if;
 select * into r from public.sms_print_reads where id=p_read and environment=p_environment for update;
 if not found then raise exception 'SMS_PRINT_NOT_FOUND'; end if;
 if r.status='CONFIRMED' then return jsonb_build_object('journeyId',r.confirmed_journey_id,'contactId',r.confirmed_contact_id,'messageId',r.message_id,'attachmentId',r.attachment_id,'duplicate',true); end if;
 if r.status<>'READY' then raise exception 'SMS_PRINT_NOT_READY'; end if;
 phone:=public.panel_normalize_phone(p_phone); if phone is null then raise exception 'SMS_PRINT_PHONE_INVALID'; end if;
 if chosen_ref is not null and chosen_ref !~ '^[A-HJ-NP-Z2-9]{5}$' then raise exception 'SMS_PRINT_REF_INVALID'; end if;
 if r.source_journey_id is not null then select * into source_j from public.journeys where id=r.source_journey_id and environment=p_environment; end if;
 if chosen_ref is not null then
   select * into ref_j from public.journeys where environment=p_environment and reference_code=chosen_ref limit 1;
   if ref_j.id is null then
     select journey_row.* into ref_j from public.journey_refs ref_link join public.journeys journey_row on journey_row.id=ref_link.journey_id and journey_row.environment=ref_link.environment where ref_link.environment=p_environment and ref_link.ref_code=chosen_ref limit 1;
   end if;
 end if;
 if p_target_journey is not null then select * into j from public.journeys where id=p_target_journey and environment=p_environment for update; if j.id is null then raise exception 'SMS_PRINT_TARGET_INVALID'; end if;
 elsif source_j.id is not null and ref_j.id is not null and source_j.id<>ref_j.id and not p_keep_source then raise exception 'SMS_PRINT_REF_DECISION_REQUIRED';
 elsif source_j.id is not null then j:=source_j;
 elsif ref_j.id is not null then j:=ref_j;
 else
   insert into public.contacts(environment,display_name,source,created_at,updated_at,created_by,updated_by) values(p_environment,coalesce(nullif(trim(p_name),''),phone),'SMS_DIRECT',at_time,at_time,p_actor,p_actor) returning * into c;
   insert into public.journeys(environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at,created_by,updated_by) values(p_environment,c.id,chosen_ref,'SMS_DIRECT','NOVO','ATIVO','{}'::jsonb,at_time,at_time,p_actor,p_actor) returning * into j;
   insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) select p_environment,j.id,n,(array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[n],'OPEN'::public.panel_checklist_status,at_time,at_time from generate_series(1,6) n;
 end if;
 select * into c from public.contacts where id=j.contact_id and environment=p_environment for update;
 if exists(select 1 from public.contact_phones phone_row where phone_row.environment=p_environment and phone_row.phone_e164=phone and phone_row.contact_id<>c.id and phone_row.is_current and phone_row.retired_at is null) then raise exception 'SMS_PRINT_PHONE_CONFLICT'; end if;
 if not exists(select 1 from public.contact_phones phone_row where phone_row.environment=p_environment and phone_row.contact_id=c.id and phone_row.phone_e164=phone and phone_row.is_current and phone_row.retired_at is null) then insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,confirmed_at,created_at,created_by) values(p_environment,c.id,phone,phone,true,not exists(select 1 from public.contact_phones phone_row where phone_row.environment=p_environment and phone_row.contact_id=c.id and phone_row.is_current and phone_row.retired_at is null),at_time,at_time,p_actor); end if;
 if coalesce(trim(c.display_name),'')='' then update public.contacts set display_name=coalesce(nullif(trim(p_name),''),phone),updated_at=at_time,updated_by=p_actor where id=c.id; end if;
 if chosen_ref is not null and (j.reference_code is null or j.reference_code=chosen_ref) and not exists(select 1 from public.journey_refs ref_link where ref_link.environment=p_environment and ref_link.journey_id=j.id and ref_link.ref_code=chosen_ref) then update public.journeys set reference_code=coalesce(reference_code,chosen_ref),updated_at=at_time,updated_by=p_actor where id=j.id; insert into public.journey_refs(environment,journey_id,ref_code,created_at,created_by) values(p_environment,j.id,chosen_ref,at_time,p_actor) on conflict do nothing; end if;
 select id into chat_id from public.chats where environment=p_environment and channel='SMS' and canonical_key='sms:'||phone limit 1;
 if chat_id is not null and exists(select 1 from public.chats chat_row where chat_row.id=chat_id and chat_row.contact_id<>c.id) then raise exception 'SMS_PRINT_PHONE_CONFLICT'; end if;
 if chat_id is null then insert into public.chats(environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values(p_environment,'SMS',c.id,'sms:'||phone,'RESOLVED',false,at_time,at_time,at_time,at_time) returning id into chat_id; else update public.chats set contact_id=c.id,resolution_status='RESOLVED',last_seen_at=at_time,updated_at=at_time where id=chat_id; end if;
 norm:=lower(trim(regexp_replace(p_message,'\s+',' ','g')));
 insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at) values(p_environment,chat_id,'SMS','CUSTOMER',trim(p_message),norm,at_time,true,'SMS_PRINT:'||p_read::text,1,'SMS_PRINT',at_time) returning id into msg_id;
 insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at,associated_by) values(p_environment,msg_id,j.id,'SMS_PRINT',at_time,p_actor);
 insert into public.interactions(environment,journey_id,message_id,type,occurred_at,created_at,created_by) values(p_environment,j.id,msg_id,'INBOUND_MESSAGE',at_time,at_time,p_actor);
 insert into public.attachments(id,environment,contact_id,chat_id,journey_id,message_id,kind,bucket_name,storage_path,original_filename,mime_type,byte_size,sha256,verified_at,created_at,created_by) values(p_attachment,p_environment,c.id,chat_id,j.id,msg_id,'IMAGE',p_bucket,p_storage_path,r.original_filename,r.mime_type,r.byte_size,r.sha256,at_time,at_time,p_actor) returning id into attached_id;
 update public.sms_print_reads set status='CONFIRMED',storage_path=p_storage_path,confirmed_journey_id=j.id,confirmed_contact_id=c.id,message_id=msg_id,attachment_id=attached_id,updated_at=at_time,updated_by=p_actor where id=r.id;
 -- The message takes the real moment the client sent it (never the time of this click): the same rule as the backfill (after
 -- the read points to the message, so the Ref of the print is found).
 perform public.panel_sms_print_fix_date(p_environment,msg_id);
 insert into public.activity_log(environment,journey_id,contact_id,chat_id,activity_type,summary,metadata,occurred_at,actor_user_id) values(p_environment,j.id,c.id,chat_id,'SMS_PRINT_CONFIRMED','Print de SMS confirmado',jsonb_build_object('readId',r.id,'attachmentId',attached_id,'translation',coalesce(p_translation,'')),at_time,p_actor);
 return jsonb_build_object('journeyId',j.id,'contactId',c.id,'messageId',msg_id,'attachmentId',attached_id,'duplicate',false);
end $$;
revoke all on function public.panel_sms_print_confirm(public.panel_environment,uuid,uuid,uuid,boolean,text,text,text,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.panel_sms_print_confirm(public.panel_environment,uuid,uuid,uuid,boolean,text,text,text,text,text,uuid,text,text) to service_role;

create or replace function public.panel_journey_names(p_environment public.panel_environment, p_journey_ids uuid[])
returns table(journey_id uuid, contact_name text, calc_names text[], chat_ids uuid[], last_channel text, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  select j.id, c.display_name,
    coalesce((select array_agg(distinct public.panel_calc_name(m.body_text)) filter (where public.panel_calc_name(m.body_text) is not null)
      from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null and m.direction = 'CUSTOMER'
      where mj.environment = p_environment and mj.journey_id = j.id and mj.undone_at is null), '{}'),
    coalesce((select array_agg(distinct m.chat_id) filter (where m.chat_id is not null)
      from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null
      where mj.environment = p_environment and mj.journey_id = j.id and mj.undone_at is null), '{}'),
    last.channel, last.at
  from public.journeys j
  left join public.contacts c on c.id = j.contact_id
  left join lateral (
    select m.channel::text channel, public.panel_message_at(m.occurred_at_utc, m.occurred_at_local, m.created_at, m.source_kind) at
      from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null and not coalesce(m.is_automatic, false)
     where mj.environment = p_environment and mj.journey_id = j.id and mj.undone_at is null and public.panel_message_at(m.occurred_at_utc, m.occurred_at_local, m.created_at, m.source_kind) is not null
     order by 2 desc limit 1) last on true
  where j.environment = p_environment and j.id = any(coalesce(p_journey_ids, '{}'))
$$;
revoke all on function public.panel_journey_names(public.panel_environment, uuid[]) from public, anon, authenticated;
grant execute on function public.panel_journey_names(public.panel_environment, uuid[]) to service_role;

create or replace function public.panel_name_link_candidates(p_environment public.panel_environment)
returns table(message_id uuid, journey_id uuid, reference_code text, contact_name text, phone text, message_name text, message_channel text, message_at timestamptz,
  other_names text[], other_channel text, other_last_at timestamptz)
language sql stable security definer set search_path = public as $$
  with calc as (
    select m.id, m.chat_id, m.channel::text channel, public.panel_message_at(m.occurred_at_utc, m.occurred_at_local, m.created_at, m.source_kind) at, mj.journey_id, public.panel_calc_name(m.body_text) nm
      from public.messages m
      join public.message_journeys mj on mj.environment = p_environment and mj.message_id = m.id and mj.undone_at is null
     where m.environment = p_environment and m.undone_at is null and m.direction = 'CUSTOMER'
       and public.panel_calc_template_text(m.body_text) and public.panel_calc_name(m.body_text) is not null
       and not exists (select 1 from public.panel_name_link_decisions d where d.environment = p_environment and d.message_id = m.id and d.journey_id = mj.journey_id)
  )
  select calc.id, calc.journey_id, j.reference_code, c.display_name,
    (select p.phone_e164 from public.contact_phones p where p.environment = p_environment and p.contact_id = j.contact_id and p.is_current and p.retired_at is null order by p.is_primary desc limit 1),
    calc.nm, calc.channel, calc.at,
    coalesce((select array_agg(distinct public.panel_calc_name(m2.body_text)) filter (where public.panel_calc_name(m2.body_text) is not null)
      from public.message_journeys mj2 join public.messages m2 on m2.id = mj2.message_id and m2.undone_at is null and m2.direction = 'CUSTOMER' and m2.chat_id is distinct from calc.chat_id
      where mj2.environment = p_environment and mj2.journey_id = calc.journey_id and mj2.undone_at is null), '{}'),
    other.channel, other.at
  from calc
  join public.journeys j on j.id = calc.journey_id
  left join public.contacts c on c.id = j.contact_id
  join lateral (
    select m2.channel::text channel, public.panel_message_at(m2.occurred_at_utc, m2.occurred_at_local, m2.created_at, m2.source_kind) at
      from public.message_journeys mj2 join public.messages m2 on m2.id = mj2.message_id and m2.undone_at is null and not coalesce(m2.is_automatic, false)
     where mj2.environment = p_environment and mj2.journey_id = calc.journey_id and mj2.undone_at is null and m2.chat_id is distinct from calc.chat_id
       and public.panel_message_at(m2.occurred_at_utc, m2.occurred_at_local, m2.created_at, m2.source_kind) is not null
     order by 2 desc limit 1) other on true
$$;
revoke all on function public.panel_name_link_candidates(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_name_link_candidates(public.panel_environment) to service_role;

-- Correction of every print already saved (same function as a new print), then each lead's "último contato da MCS"
-- recomputed from its real messages (a print is the client's message, so it never moved it; only fixed where it differs).
do $$
declare v_row record;
begin
  for v_row in select m.environment, m.id from public.messages m where m.source_kind = 'SMS_PRINT' order by m.created_at loop
    perform public.panel_sms_print_fix_date(v_row.environment, v_row.id);
  end loop;
  update public.journeys x set last_effective_contact_at = s.value
  from (
    select j.id, nullif(greatest(
      coalesce((select max(m.occurred_at_utc) from public.messages m join public.message_journeys mj on mj.message_id = m.id
        where mj.environment = j.environment and mj.journey_id = j.id and mj.undone_at is null and m.environment = j.environment
          and m.direction = 'MCS' and not m.is_automatic and m.undone_at is null), '-infinity'::timestamptz),
      coalesce((select max(i.occurred_at) from public.interactions i where i.environment = j.environment and i.journey_id = j.id and i.undone_at is null
        and coalesce(i.detail_text, '') <> 'Desfeito' and i.type in ('CALL_ANSWERED', 'IN_PERSON')), '-infinity'::timestamptz)), '-infinity'::timestamptz) value
    from public.journeys j
    where j.status <> 'ENCERRADO' and exists (select 1 from public.message_journeys mj join public.messages m on m.id = mj.message_id
      where mj.journey_id = j.id and mj.undone_at is null and m.source_kind = 'SMS_PRINT')
  ) s
  where x.id = s.id and x.last_effective_contact_at is distinct from s.value;
end $$;
