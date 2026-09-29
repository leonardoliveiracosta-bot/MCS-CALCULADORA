-- Lote 3 (audit: imports, files, Manheim/BUSCAS). Same signatures, bodies replaced; compatible
-- with the published panel.
--  * panel_mark_message_fact_v2: marking "Carro ou faixa" on a customer message also updates the
--    ficha's confirmed wishes (criteria_json.wishlists + wishlistOverride) when the panel sends
--    value_json.confirmedWishlists (A:P17). Without that key (older panel) nothing changes.
--  * panel_whatsapp_apply_message: a webhook message already imported from a WhatsApp export
--    (source_kind IMPORT, body only trimmed) is recognized and not duplicated (A16). Only the
--    duplicate check changes.

create or replace function public.panel_mark_message_fact_v2(
  p_environment public.panel_environment,
  p_journey_id uuid,
  p_message_id uuid,
  p_kind text,
  p_actor_id uuid,
  p_value text default null,
  p_value_json jsonb default '{}'::jsonb,
  p_deadline_at timestamptz default null,
  p_simulate_failure boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_point smallint;
  v_field public.panel_declaration_field;
  v_mark_id uuid;
  v_checklist_id uuid;
  v_declaration_id uuid;
  v_contact_id uuid;
  v_chat_id uuid;
  v_message_text text;
  v_message_at timestamptz;
  v_result jsonb;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then
    raise exception 'PANEL_ACTOR_NOT_AUTHORIZED';
  end if;

  case p_kind
    when 'VEHICLE' then v_point := 1; v_field := 'VEICULO';
    when 'BUDGET' then v_point := 2; v_field := 'TETO';
    when 'PAYMENT' then v_point := 3; v_field := 'PAGAMENTO';
    when 'DEADLINE' then v_point := 4; v_field := 'PRAZO';
    when 'OUTSIDE_FLORIDA' then v_point := 5; v_field := null;
    when 'NO_TEST_DRIVE' then v_point := 6; v_field := null;
    else raise exception 'MESSAGE_MARK_KIND_INVALID';
  end case;

  if p_value is not null and (length(btrim(p_value)) = 0 or length(p_value) > 500) then
    raise exception 'MESSAGE_MARK_VALUE_INVALID';
  end if;

  select j.contact_id into v_contact_id
  from public.journeys j
  where j.id = p_journey_id and j.environment = p_environment
  for update;
  if not found then raise exception 'JOURNEY_NOT_FOUND'; end if;
  -- M6: nothing marked on a message changes a closed journey (vehicle, ceiling, payment, deadline, checklist).
  if exists (
    select 1 from public.journeys j where j.id = p_journey_id and j.environment = p_environment and (j.status = 'ENCERRADO' or j.stage_frozen)
  ) then raise exception 'JOURNEY_CLOSED'; end if;

  select m.chat_id, left(m.body_text, 1000), coalesce(m.occurred_at_utc, m.created_at)
    into v_chat_id, v_message_text, v_message_at
  from public.messages m
  join public.message_journeys mj
    on mj.message_id = m.id
   and mj.journey_id = p_journey_id
   and mj.environment = p_environment
  where m.id = p_message_id
    and m.environment = p_environment
    and m.direction = 'CUSTOMER';
  if not found then raise exception 'MESSAGE_MARK_INVALID'; end if;

  select jc.id into v_checklist_id
  from public.journey_checklist jc
  where jc.environment = p_environment
    and jc.journey_id = p_journey_id
    and jc.point_number = v_point
  for update;
  if not found then raise exception 'CHECKLIST_POINT_NOT_FOUND'; end if;

  begin
    insert into public.message_fact_marks(
      environment, journey_id, message_id, kind, created_at, created_by
    ) values (
      p_environment, p_journey_id, p_message_id, p_kind, v_now, p_actor_id
    )
    on conflict (environment, journey_id, message_id, kind) do nothing
    returning id into v_mark_id;

    if v_mark_id is null then
      select mfm.result_json into v_result
      from public.message_fact_marks mfm
      where mfm.environment = p_environment
        and mfm.journey_id = p_journey_id
        and mfm.message_id = p_message_id
        and mfm.kind = p_kind;
      if v_result is null then raise exception 'MESSAGE_MARK_RESULT_MISSING'; end if;
      return v_result;
    end if;

    insert into public.checklist_evidence(
      environment, checklist_id, message_id, excerpt_text, created_at, created_by
    ) values (
      p_environment, v_checklist_id, p_message_id, v_message_text, v_now, p_actor_id
    )
    on conflict (environment, checklist_id, message_id) do nothing;

    update public.journey_checklist
      set status = 'COMPLETE', completed_at = coalesce(completed_at, v_now), updated_at = v_now
    where id = v_checklist_id and environment = p_environment;

    if p_simulate_failure then
      raise exception 'PANEL_SIMULATED_MESSAGE_MARK_FAILURE';
    end if;

    if v_field is not null then
      if p_value is null then raise exception 'MESSAGE_MARK_VALUE_REQUIRED'; end if;
      insert into public.journey_declarations(
        environment, journey_id, field, source, value_text, value_json,
        message_id, declared_at, created_at, created_by
      ) values (
        p_environment, p_journey_id, v_field, 'CONVERSATION', p_value,
        coalesce(p_value_json, '{}'::jsonb), p_message_id, v_message_at, v_now, p_actor_id
      ) returning id into v_declaration_id;

      update public.journeys
      set vehicle_text = case when v_field = 'VEICULO' then p_value else vehicle_text end,
          -- A:P17: "Carro ou faixa" confirmed on a message becomes the ficha's confirmed wishes (the
          -- panel sends the merged list: marked cars first, the other cars of the ficha kept).
          criteria_json = case
            when v_field = 'VEICULO' and jsonb_typeof(p_value_json -> 'confirmedWishlists') = 'array'
                 and jsonb_array_length(p_value_json -> 'confirmedWishlists') between 1 and 5
              then coalesce(criteria_json, '{}'::jsonb) || jsonb_build_object('wishlists', p_value_json -> 'confirmedWishlists', 'wishlistOverride', true)
            else criteria_json
          end,
          payment_text = case when v_field = 'PAGAMENTO' then p_value else payment_text end,
          -- R2: TETO is the customer's total ceiling. It never changes budget_cents (maximum bid).
          confirmed_total_ceiling_cents = case
            when v_field = 'TETO' and jsonb_typeof(p_value_json -> 'ceilingCents') = 'number'
                 and (p_value_json ->> 'ceilingCents')::numeric between 100000 and 10000000000
              then (p_value_json ->> 'ceilingCents')::bigint
            else confirmed_total_ceiling_cents
          end,
          customer_deadline_text = case when v_field = 'PRAZO' then p_value else customer_deadline_text end,
          customer_deadline_at = case when v_field = 'PRAZO' and p_deadline_at is not null then p_deadline_at else customer_deadline_at end,
          updated_at = v_now,
          updated_by = p_actor_id
      where id = p_journey_id and environment = p_environment;
    end if;

    insert into public.activity_log(
      environment, journey_id, contact_id, chat_id, activity_type,
      summary, metadata, occurred_at, actor_user_id
    ) values (
      p_environment, p_journey_id, v_contact_id, v_chat_id, 'MESSAGE_FACT_MARKED',
      'Mensagem marcada na ficha e no checklist',
      jsonb_build_object('point_number', v_point, 'field', v_field, 'message_id', p_message_id),
      v_now, p_actor_id
    );

    insert into public.audit_log(
      environment, actor_user_id, entity_type, entity_id, action, after_json, created_at
    ) values (
      p_environment, p_actor_id, 'message_fact_mark', v_mark_id, 'MESSAGE_FACT_MARK',
      jsonb_build_object('point_number', v_point, 'field', v_field, 'message_id', p_message_id, 'declaration_id', v_declaration_id),
      v_now
    );

    insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
    values (p_environment, 'panel.updated', 'journey', p_journey_id, v_now);

    v_result := jsonb_build_object(
      'pointNumber', v_point,
      'field', v_field,
      'status', 'COMPLETE',
      'declarationId', v_declaration_id
    );
    update public.message_fact_marks
      set result_json = v_result
      where id = v_mark_id and environment = p_environment;
    return v_result;
  exception
    when others then
      if p_simulate_failure and sqlerrm = 'PANEL_SIMULATED_MESSAGE_MARK_FAILURE' then
        return jsonb_build_object('simulatedFailure', true, 'rolledBack', true);
      end if;
      raise;
  end;
end;
$$;

revoke all on function public.panel_mark_message_fact_v2(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.panel_mark_message_fact_v2(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) to service_role;

create or replace function public.panel_whatsapp_apply_message(p_environment public.panel_environment,p_raw uuid,p_item jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
#variable_conflict use_variable
declare phone text := p_item->>'phone'; wid text := p_item->>'messageId'; nm text := left(coalesce(nullif(trim(p_item->>'name'),''),phone),160);
  body text := left(coalesce(p_item->>'body',''),25000); dir public.panel_message_direction;
  stamp timestamptz; contact_id uuid; journey_id uuid; chat_id uuid; message_id uuid; ref text;
  new_contact boolean := false; norm text; other_count integer; forced_contact uuid := nullif(p_item->>'forceContactId','')::uuid; chosen_ref text;
  source_key text := coalesce(nullif(p_item->>'source_kind',''),'WHATSAPP_WEBHOOK');
  user_id text := nullif(trim(p_item->>'userId'),''); username text := left(nullif(trim(p_item->>'username'),''),160);
  bsuid_contact_id uuid; merge_contact_id uuid;
begin
 if not exists(select 1 from public.whatsapp_raw_events raw where raw.id=p_raw and raw.environment=p_environment) then raise exception 'RAW_EVENT_MISSING'; end if;
 if not coalesce(phone ~ '^\+[1-9][0-9]{6,14}$',false) then phone=null; end if;
 if not coalesce(user_id ~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$',false) then user_id=null; end if;
 if (phone is null and user_id is null) or length(wid) not between 2 and 256 or length(body)=0 or
    p_item->>'direction' not in ('CUSTOMER','MCS') then raise exception 'MESSAGE_INVALID'; end if;
 if phone is null then nm=left(coalesce(case when username is not null then '@'||username end,nullif(trim(p_item->>'name'),''),'WhatsApp sem número'),160); end if;
 dir=(p_item->>'direction')::public.panel_message_direction;
 stamp=to_timestamp(nullif(p_item->>'timestamp','')::double precision);
 if stamp is null or stamp > now()+interval '1 day' or stamp < '2009-01-01'::timestamptz then raise exception 'TIMESTAMP_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||coalesce(phone,user_id)));
 if phone is not null and user_id is not null then perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||user_id)); end if;
 select w.message_id into message_id from public.whatsapp_message_ids w where w.environment=p_environment and w.wa_message_id=wid;
 if found then return jsonb_build_object('messageId',message_id,'duplicate',true); end if;
 if user_id is not null then
   select u.contact_id into bsuid_contact_id from public.whatsapp_user_ids u
     where u.environment=p_environment and u.bsuid=user_id for update;
 end if;
 if phone is not null then
   select count(distinct cp.contact_id) into other_count from public.contact_phones cp
    where cp.environment=p_environment and cp.phone_e164=phone and cp.retired_at is null and cp.is_current;
   if forced_contact is not null then
     if not exists(select 1 from public.contacts c where c.id=forced_contact and c.environment=p_environment) then raise exception 'FORCED_CONTACT_INVALID'; end if;
     if other_count>0 and not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=forced_contact and cp.phone_e164=phone and cp.retired_at is null and cp.is_current) then raise exception 'FORCED_CONTACT_NOT_CANDIDATE'; end if;
     contact_id=forced_contact;
   elsif other_count>1 then raise exception 'PHONE_AMBIGUOUS';
   else
     select cp.contact_id into contact_id from public.contact_phones cp where cp.environment=p_environment and cp.phone_e164=phone and cp.retired_at is null and cp.is_current limit 1;
   end if;
   if contact_id is null then contact_id=bsuid_contact_id; end if;
   if bsuid_contact_id is not null and contact_id is not null and bsuid_contact_id<>contact_id then merge_contact_id=bsuid_contact_id; end if;
 else
   contact_id=bsuid_contact_id;
 end if;
 if phone is not null and nm=phone then
   select left(coalesce(nullif(book.full_name,''),nullif(book.first_name,''),phone),160) into nm
   from public.whatsapp_address_book book where book.environment=p_environment and book.phone_e164=phone;
   nm=coalesce(nm,phone);
 end if;
 if contact_id is null then
   for ref in select distinct upper(value) from jsonb_array_elements_text(coalesce(p_item->'refs','[]'::jsonb)) value
     where upper(value) ~ '^[A-HJ-NP-Z2-9]{5}$' loop
     select j.contact_id,j.id into contact_id,journey_id from public.journeys j
       where j.environment=p_environment and j.reference_code=ref limit 1;
     if contact_id is null then
       select j.contact_id,j.id into contact_id,journey_id from public.journey_refs r join public.journeys j on j.id=r.journey_id
         where r.environment=p_environment and j.environment=p_environment and r.ref_code=ref limit 1;
     end if;
     if contact_id is not null then exit; end if;
   end loop;
 end if;
 if contact_id is null then
   insert into public.contacts(environment,display_name,source,created_at,updated_at)
     values(p_environment,nm,'WHATSAPP_DIRECT',now(),now()) returning id into contact_id;
   new_contact=true;
 end if;
 if phone is not null then
   if not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=contact_id and cp.phone_e164=phone and cp.retired_at is null and cp.is_current) then
     insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
       values(p_environment,contact_id,phone,phone,true,false,now());
   end if;
   -- A WhatsApp number is authoritative for this contact only.
   -- Two statements on purpose: flipping is_primary in a single UPDATE can
   -- transiently violate contact_phones_one_active_primary_idx, because unique
   -- constraints are checked per row. If the active number's row is stored
   -- before the current primary's row, the single-statement flip raises
   -- unique_violation and the whole message ingestion fails. Clearing first
   -- can never violate the index.
   update public.contact_phones cp set is_primary=false where cp.environment=p_environment and cp.contact_id=contact_id and cp.is_primary;
   update public.contact_phones cp set is_primary=true where cp.environment=p_environment and cp.contact_id=contact_id and cp.phone_e164=phone and cp.retired_at is null and cp.is_current;
   update public.contacts c set display_name=nm,updated_at=now()
     where c.id=contact_id and c.environment=p_environment and (c.display_name is null or c.display_name='' or c.display_name=phone or c.display_name like 'Contato WhatsApp%');
 end if;
 if journey_id is null and contact_id is not null then
   for ref in select distinct upper(value) from jsonb_array_elements_text(coalesce(p_item->'refs','[]'::jsonb)) value
     where upper(value) ~ '^[A-HJ-NP-Z2-9]{5}$' loop
     select j.id into journey_id from public.journeys j where j.environment=p_environment and j.contact_id=contact_id and j.reference_code=ref limit 1;
     if journey_id is null then
       select j.id into journey_id from public.journey_refs r join public.journeys j on j.id=r.journey_id
         where r.environment=p_environment and j.environment=p_environment and j.contact_id=contact_id and r.ref_code=ref limit 1;
     end if;
     if journey_id is not null then exit; end if;
   end loop;
 end if;
 if journey_id is null then
   select j.id into journey_id from public.journeys j where j.environment=p_environment and j.contact_id=contact_id
     order by (j.status='ENCERRADO'),j.created_at desc limit 1;
 end if;
 if journey_id is null then
   select upper(value) into chosen_ref from jsonb_array_elements_text(coalesce(p_item->'refs','[]'::jsonb)) value
    where upper(value) ~ '^[A-HJ-NP-Z2-9]{5}$'
      and not exists(select 1 from public.journeys j where j.environment=p_environment and j.reference_code=upper(value))
      and not exists(select 1 from public.journey_refs r where r.environment=p_environment and r.ref_code=upper(value))
    limit 1;
   insert into public.journeys(environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at)
     values(p_environment,contact_id,chosen_ref,'WHATSAPP_DIRECT','NOVO','ATIVO','{}'::jsonb,stamp,now()) returning id into journey_id;
   insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at)
     select p_environment,journey_id,n,(array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[n],
       'OPEN'::public.panel_checklist_status,now(),now() from generate_series(1,6) n;
 end if;
 for ref in select distinct upper(value) from jsonb_array_elements_text(coalesce(p_item->'refs','[]'::jsonb)) value
   where upper(value) ~ '^[A-HJ-NP-Z2-9]{5}$' loop
   if not exists(select 1 from public.journeys j where j.environment=p_environment and j.reference_code=ref and j.contact_id<>contact_id)
     and not exists(select 1 from public.journey_refs r join public.journeys j on j.id=r.journey_id
       where r.environment=p_environment and j.environment=p_environment and r.ref_code=ref and j.contact_id<>contact_id) then
     insert into public.journey_refs(environment,journey_id,ref_code,created_at)
       select p_environment,journey_id,ref,now() where not exists(select 1 from public.journey_refs r where r.environment=p_environment and r.journey_id=journey_id and r.ref_code=ref);
   end if;
 end loop;
 if merge_contact_id is not null then
   update public.chats c set contact_id=contact_id,updated_at=now()
     where c.environment=p_environment and c.contact_id=merge_contact_id;
   update public.message_journeys link set journey_id=journey_id,association_source='WHATSAPP_BSUID_MERGE',associated_at=now()
     where link.environment=p_environment
       and link.journey_id in (select old.id from public.journeys old where old.environment=p_environment and old.contact_id=merge_contact_id)
       and not exists(select 1 from public.message_journeys target where target.environment=p_environment and target.message_id=link.message_id and target.journey_id=journey_id);
   update public.journeys old set status='ENCERRADO',closed_at=coalesce(old.closed_at,now()),closed_reason=coalesce(old.closed_reason,'WHATSAPP_LINKED'),updated_at=now()
     where old.environment=p_environment and old.contact_id=merge_contact_id and old.status<>'ENCERRADO';
   update public.contacts old set is_lead=false,lead_excluded_at=coalesce(old.lead_excluded_at,now()),updated_at=now()
     where old.environment=p_environment and old.id=merge_contact_id;
 end if;
 if user_id is not null then
   insert into public.whatsapp_user_ids(environment,bsuid,contact_id,username,first_seen_at,last_seen_at)
     values(p_environment,user_id,contact_id,username,now(),now())
     on conflict (environment,bsuid) do update set contact_id=excluded.contact_id,
       username=coalesce(excluded.username,public.whatsapp_user_ids.username),last_seen_at=excluded.last_seen_at;
 end if;
 select c.id into chat_id from public.chats c where c.environment=p_environment and c.channel='WHATSAPP'
   and c.canonical_key=case when phone is not null then 'wa:'||phone else 'wa-user:'||user_id end limit 1;
 if chat_id is null then
   insert into public.chats(environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at)
     values(p_environment,'WHATSAPP',contact_id,case when phone is not null then 'wa:'||phone else 'wa-user:'||user_id end,'RESOLVED',false,stamp,stamp,now(),now()) returning id into chat_id;
 end if;
 norm=lower(trim(regexp_replace(body,'\s+',' ','g')));
 select m.id into message_id from public.messages m join public.message_journeys l on l.message_id=m.id
   where l.environment=p_environment and l.journey_id=journey_id and m.environment=p_environment
     -- A16: a message imported from a WhatsApp export is stored with source_kind 'IMPORT' and a
     -- body that is only trimmed; compare it the same way the webhook normalizes its own body.
     and ((wid is not null and m.source_kind in ('WHATSAPP_ZIP','WHATSAPP_TXT','IMPORT'))
       or (wid is null and m.source_kind in ('WHATSAPP_ZIP','WHATSAPP_TXT','IMPORT',source_key)))
     and m.direction=dir and lower(trim(regexp_replace(m.body_normalized,'\s+',' ','g')))=norm and date_trunc('minute',m.occurred_at_utc)=date_trunc('minute',stamp)
     -- one imported message stands for one webhook message: a second "ok" in the same minute is kept
     and not exists(select 1 from public.whatsapp_message_ids w where w.environment=p_environment and w.message_id=m.id)
   order by m.created_at limit 1;
 if message_id is null then
   insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
     values(p_environment,chat_id,'WHATSAPP',dir,body,norm,stamp,false,'WA:'||wid,1,source_key,now()) returning id into message_id;
   insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
     values(p_environment,message_id,journey_id,source_key,now());
   insert into public.interactions(environment,journey_id,message_id,type,occurred_at,created_at)
     values(p_environment,journey_id,message_id,case when dir='MCS' then 'OUTBOUND_MESSAGE' else 'INBOUND_MESSAGE' end::public.panel_interaction_type,stamp,now());
 end if;
 insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id) values(p_environment,wid,message_id,p_raw);
 update public.chats c set last_seen_at=greatest(coalesce(c.last_seen_at,stamp),stamp),updated_at=now() where c.id=chat_id and c.environment=p_environment;
 if dir='MCS' and not exists(select 1 from public.messages automatic_message where automatic_message.id=message_id and automatic_message.environment=p_environment and automatic_message.is_automatic) then update public.journeys j set stage=case when j.stage='NOVO' then 'RESPONDIDO' else j.stage end,
    last_effective_contact_at=greatest(coalesce(j.last_effective_contact_at,stamp),stamp),updated_at=now() where j.id=journey_id and j.environment=p_environment and j.status<>'ENCERRADO'; end if;
 if new_contact and phone is not null then
   insert into public.whatsapp_link_suggestions(environment,source_contact_id,source_journey_id,target_contact_id,target_journey_id,phone_e164)
     select p_environment,contact_id,journey_id,c.id,j.id,phone from public.contacts c
       join public.journeys j on j.environment=p_environment and j.contact_id=c.id
       where c.environment=p_environment and c.id<>contact_id
         and not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=c.id and cp.phone_e164 is not null)
         and exists(select 1 from public.chats z join public.import_jobs i on i.chat_id=z.id and i.environment=p_environment
           where z.environment=p_environment and z.contact_id=c.id and i.source_kind='WHATSAPP_ZIP')
         and length(split_part(nm,' ',1))>=3 and
           translate(lower(split_part(c.display_name,' ',1)),'áàâãéêíóôõúüç','aaaaeeiooouuc')=
           translate(lower(split_part(nm,' ',1)),'áàâãéêíóôõúüç','aaaaeeiooouuc')
       on conflict do nothing;
 end if;
 return jsonb_build_object('messageId',message_id,'duplicate',false,'contactId',contact_id,'journeyId',journey_id);
end $$;
revoke all on function public.panel_whatsapp_apply_message(public.panel_environment,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_apply_message(public.panel_environment,uuid,jsonb) to service_role;
