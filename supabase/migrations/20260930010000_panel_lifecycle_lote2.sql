-- Lote 2 (audit: lead lifecycle). Same signatures, bodies replaced; old panel code keeps working.
--  * panel_set_journey_enabled: switching a closed journey on reopens it (A7). Before, a journey
--    closed by "Cliente deu OK", close or SMS print undo raised JOURNEY_RESUME_STATE_MISSING, and one
--    with the switch already on answered changed=false and stayed closed. A journey merged into
--    another (WHATSAPP_LINKED) is refused with JOURNEY_MERGED. Stage and qualified_at are kept.
--  * panel_quick_result and panel_confirm_lead_note refuse to change a closed journey (M6); a note
--    on a closed journey can still add a phone or a suggestion. The note accepts deadline "3mo" (M1).
--    Answered / no answer / in person keep a manual return that is still in the future (B6).
--  * panel_refresh_effective_mcs never moves the stage back (RESPONDIDO -> NOVO) and counts answered
--    calls as effective contact (M6).
--  * panel_customer_unit_response: "I want this car" moves the stage forward to DECIDINDO (A10).
--  * panel_mark_message_fact_v2: every kind refuses a closed journey, not only the ceiling (M6).
--  * panel_mark_message_fact (V1) loses EXECUTE for service_role: the published panel only calls the
--    V2, and the V1 still writes the ceiling into budget_cents (maximum bid).

create or replace function public.panel_set_journey_enabled(
  p_environment public.panel_environment,
  p_journey_id uuid,
  p_enabled boolean,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_journey public.journeys%rowtype;
  v_state public.journey_toggle_states%rowtype;
  v_snapshot jsonb;
  v_now timestamptz := now();
  v_closed_reason text;
  v_reopened boolean := false;
begin
  if p_enabled is null then raise exception 'JOURNEY_SWITCH_INVALID'; end if;
  if p_reason is not null and p_reason not in ('MCS_PURCHASE','OTHER_PURCHASE','GAVE_UP','NO_RESPONSE') then
    raise exception 'JOURNEY_SWITCH_REASON_INVALID';
  end if;
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_journey
  from public.journeys
  where id = p_journey_id and environment = p_environment
  for update;
  if not found then raise exception 'JOURNEY_NOT_FOUND'; end if;

  select * into v_state
  from public.journey_toggle_states
  where journey_id = p_journey_id and environment = p_environment
  for update;

  if not p_enabled then
    v_closed_reason := case p_reason
      when 'MCS_PURCHASE' then 'DESLIGADO_COMPROU_MCS'
      when 'OTHER_PURCHASE' then 'DESLIGADO_COMPROU_OUTRO'
      when 'GAVE_UP' then 'DESLIGADO_DESISTIU'
      when 'NO_RESPONSE' then 'DESLIGADO_SEM_RESPOSTA'
      else 'DESLIGADO_SEM_MOTIVO'
    end;

    if found and not v_state.enabled then
      update public.journey_toggle_states
         set off_reason = p_reason, switched_at = v_now, switched_by = p_actor_id
       where id = v_state.id;
      update public.journeys
         set closed_reason = v_closed_reason, updated_at = v_now, updated_by = p_actor_id
       where id = p_journey_id and environment = p_environment;
    else
      v_snapshot := jsonb_build_object(
        'stage', v_journey.stage,
        'status', v_journey.status,
        'stage_frozen', v_journey.stage_frozen,
        'qualified_at', v_journey.qualified_at,
        'closed_at', v_journey.closed_at,
        'closed_reason', v_journey.closed_reason,
        'next_action_at', v_journey.next_action_at,
        'next_action_text', v_journey.next_action_text,
        'next_action_missing_since', v_journey.next_action_missing_since
      );

      update public.journeys
         set status = 'ENCERRADO', stage_frozen = true, closed_at = v_now,
             closed_reason = v_closed_reason, next_action_at = null,
             next_action_text = null, next_action_missing_since = null,
             updated_at = v_now, updated_by = p_actor_id
       where id = p_journey_id and environment = p_environment;

      insert into public.journey_toggle_states(
        environment, journey_id, enabled, off_reason, resume_snapshot, switched_at, switched_by
      ) values (
        p_environment, p_journey_id, false, p_reason, v_snapshot, v_now, p_actor_id
      ) on conflict (environment, journey_id) do update
        set enabled = false, off_reason = excluded.off_reason,
            resume_snapshot = excluded.resume_snapshot,
            switched_at = excluded.switched_at, switched_by = excluded.switched_by;

      insert into public.interactions(environment, journey_id, type, occurred_at, created_at, created_by)
      values (p_environment, p_journey_id, 'JOURNEY_CLOSED', v_now, v_now, p_actor_id);
    end if;
  else
    if v_journey.status = 'ENCERRADO' and v_journey.closed_reason = 'WHATSAPP_LINKED' then
      -- A journey merged into another one must stay closed; reopening would duplicate the person.
      raise exception 'JOURNEY_MERGED';
    end if;
    if found and not v_state.enabled and jsonb_typeof(v_state.resume_snapshot) = 'object' and v_state.resume_snapshot ? 'status' then
      update public.journeys
         set stage = (v_state.resume_snapshot ->> 'stage')::public.panel_journey_stage,
             status = (v_state.resume_snapshot ->> 'status')::public.panel_journey_status,
             stage_frozen = coalesce((v_state.resume_snapshot ->> 'stage_frozen')::boolean, false),
             qualified_at = (v_state.resume_snapshot ->> 'qualified_at')::timestamptz,
             closed_at = (v_state.resume_snapshot ->> 'closed_at')::timestamptz,
             closed_reason = v_state.resume_snapshot ->> 'closed_reason',
             next_action_at = (v_state.resume_snapshot ->> 'next_action_at')::timestamptz,
             next_action_text = v_state.resume_snapshot ->> 'next_action_text',
             next_action_missing_since = (v_state.resume_snapshot ->> 'next_action_missing_since')::timestamptz,
             updated_at = v_now, updated_by = p_actor_id
       where id = p_journey_id and environment = p_environment;
    elsif v_journey.status <> 'ENCERRADO' and (not found or v_state.enabled) then
      return jsonb_build_object('enabled', true, 'reason', null, 'changed', false);
    end if;

    -- A7: explicit reopen. A journey closed without a usable snapshot ("Cliente deu OK" before
    -- it stopped closing, close, SMS print undo) or restored to a closed state reopens as ATIVO.
    -- The stage and qualified_at are kept, so QUALIFICADO <=> qualified_at still holds.
    if (select j.status from public.journeys j where j.id = p_journey_id and j.environment = p_environment) = 'ENCERRADO' then
      update public.journeys
         set status = 'ATIVO', stage_frozen = false, closed_at = null, closed_reason = null,
             updated_at = v_now, updated_by = p_actor_id
       where id = p_journey_id and environment = p_environment;
      v_reopened := true;
    end if;

    insert into public.journey_toggle_states(
      environment, journey_id, enabled, off_reason, resume_snapshot, switched_at, switched_by
    ) values (
      p_environment, p_journey_id, true, null, '{}'::jsonb, v_now, p_actor_id
    ) on conflict (environment, journey_id) do update
      set enabled = true, off_reason = null, switched_at = excluded.switched_at, switched_by = excluded.switched_by;
  end if;

  insert into public.activity_log(
    environment, journey_id, contact_id, activity_type, summary, metadata, occurred_at, actor_user_id
  ) values (
    p_environment, p_journey_id, v_journey.contact_id,
    case when v_reopened then 'JOURNEY_REOPENED' when p_enabled then 'JOURNEY_ENABLED' else 'JOURNEY_DISABLED' end,
    case when v_reopened then 'Ficha reaberta' when p_enabled then 'Busca ligada' else 'Busca desligada' end,
    jsonb_build_object('enabled', p_enabled, 'reason', p_reason, 'reopened', v_reopened), v_now, p_actor_id
  );

  insert into public.audit_log(
    environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at
  ) values (
    p_environment, p_actor_id, 'journey', p_journey_id,
    case when v_reopened then 'REOPEN' when p_enabled then 'ENABLE' else 'DISABLE' end,
    jsonb_build_object('stage', v_journey.stage, 'status', v_journey.status),
    jsonb_build_object('enabled', p_enabled, 'reason', p_reason), v_now
  );

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'journey', p_journey_id, v_now);

  return jsonb_build_object('enabled', p_enabled, 'reason', p_reason, 'changed', true, 'reopened', v_reopened);
end;
$$;

create or replace function public.panel_quick_result(p_environment public.panel_environment,p_actor uuid,p_ref text,p_journey uuid,p_type text,p_due timestamptz,p_operation uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.journeys%rowtype; prior jsonb; interaction_id uuid; event_id uuid; at_time timestamptz:=clock_timestamp();
  interaction_type public.panel_interaction_type; label_text text;
begin
 if p_operation is null or p_type not in ('ANSWERED','NO_ANSWER','LATER','IN_PERSON','DEPOSIT') then raise exception 'QUICK_RESULT_INVALID'; end if;
 select * into j from public.journeys where environment=p_environment and id=p_journey for update;
 if not found or (j.reference_code<>p_ref and not exists(select 1 from public.journey_refs where environment=p_environment and journey_id=j.id and ref_code=p_ref)) then raise exception 'JOURNEY_REF_MISMATCH'; end if;
 select id into event_id from public.lead_events where environment=p_environment and ref_code=p_ref and detail_json->>'operationId'=p_operation::text and event_type like 'QUICK_%' limit 1;
 if event_id is not null then return jsonb_build_object('eventId',event_id,'duplicate',true); end if;
 if j.status='ENCERRADO' or j.stage_frozen then raise exception 'JOURNEY_FROZEN'; end if;
 prior=jsonb_build_object('stage',j.stage,'status',j.status,'qualified_at',j.qualified_at,'next_action_at',j.next_action_at,'next_action_text',j.next_action_text,
   'next_action_missing_since',j.next_action_missing_since,'last_effective_contact_at',j.last_effective_contact_at);
 interaction_type=case when p_type in ('NO_ANSWER','LATER') then 'CALL_ATTEMPT'::public.panel_interaction_type
   when p_type='IN_PERSON' then 'IN_PERSON'::public.panel_interaction_type else 'CALL_ANSWERED'::public.panel_interaction_type end;
 label_text=case p_type when 'ANSWERED' then 'Atendeu' when 'NO_ANSWER' then 'Não atendeu' when 'LATER' then 'Pediu para ligar depois' when 'IN_PERSON' then 'Conversa presencial' else 'Vai pagar o depósito' end;
 insert into public.interactions(environment,journey_id,type,occurred_at,detail_text,next_action_at,created_at,created_by)
   values(p_environment,j.id,interaction_type,at_time,label_text,p_due,at_time,p_actor) returning id into interaction_id;
 update public.journeys set stage=case when p_type='DEPOSIT' then 'QUALIFICADO'::public.panel_journey_stage
     when p_type not in ('NO_ANSWER','LATER') and stage='NOVO' then 'RESPONDIDO'::public.panel_journey_stage else stage end,
   qualified_at=case when p_type='DEPOSIT' then coalesce(qualified_at,at_time) else qualified_at end,
   last_effective_contact_at=case when p_type in ('NO_ANSWER','LATER') then last_effective_contact_at else at_time end,
   -- B6: an automatic follow-up (answered / no answer) never replaces a manual return still in the future.
   next_action_at=case when p_type in ('ANSWERED','NO_ANSWER','IN_PERSON') and next_action_at>at_time then next_action_at else coalesce(p_due,next_action_at) end,
   next_action_text=case when p_type in ('ANSWERED','NO_ANSWER','IN_PERSON') and next_action_at>at_time then next_action_text when p_due is null then next_action_text else label_text end,
   next_action_missing_since=case when p_due is null and not (next_action_at>at_time) then next_action_missing_since else null end,
   updated_at=at_time,updated_by=p_actor where id=j.id;
 insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
   values(p_environment,p_ref,j.id,'QUICK_'||p_type,jsonb_build_object('label',label_text,'interactionId',interaction_id,'snapshot',prior,'dueAt',p_due,'source','button','operationId',p_operation),at_time,p_actor)
   returning id into event_id;
 return jsonb_build_object('eventId',event_id,'undoUntil',at_time+interval '10 seconds','journeyId',j.id,'duplicate',false);
end $$;

create or replace function public.panel_confirm_lead_note(
 p_environment public.panel_environment, p_actor uuid, p_ref text, p_journey uuid,
 p_body text, p_items jsonb, p_key uuid, p_initial jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.journeys%rowtype; n public.lead_notes%rowtype; c uuid; x jsonb; typ text; v jsonb;
  at_time timestamptz := clock_timestamp(); due_time timestamptz; event_type text; result_text text;
  prior jsonb; interaction_id uuid; patch_stage public.panel_journey_stage;
  normalized_phone text; existing_phone_id uuid; preferred_phone_id uuid; has_active_phone boolean;
begin
 if p_ref !~ '^[A-HJ-NP-Z2-9]{5}$' or p_key is null or length(trim(p_body)) not between 1 and 12000
    or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then raise exception 'NOTE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||p_ref));
 select * into n from public.lead_notes where environment=p_environment and confirmation_key=p_key;
 if found then
   if n.ref_code <> p_ref or n.body_text <> p_body or n.created_by <> p_actor then raise exception 'CONFIRMATION_KEY_REUSED'; end if;
   return jsonb_build_object('noteId',n.id,'journeyId',n.journey_id,'duplicate',true);
 end if;
 if p_journey is not null then
   select * into j from public.journeys where environment=p_environment and id=p_journey for update;
   if not found or (j.reference_code <> p_ref and not exists (select 1 from public.journey_refs where environment=p_environment and journey_id=j.id and ref_code=p_ref)) then
     raise exception 'JOURNEY_REF_MISMATCH'; end if;
 else
   select * into j from public.journeys where environment=p_environment and reference_code=p_ref order by created_at limit 1 for update;
   if not found then
     select q.* into j from public.journey_refs r join public.journeys q on q.id=r.journey_id and q.environment=r.environment
       where r.environment=p_environment and r.ref_code=p_ref order by q.created_at limit 1 for update of q;
   end if;
 end if;
 if j.id is null then
   insert into public.contacts(environment,display_name,source,created_at,updated_at,created_by,updated_by)
   values(p_environment,coalesce(nullif(p_initial->>'name',''),'Contato da Ref '||p_ref),'CALCULATOR',at_time,at_time,p_actor,p_actor) returning id into c;
   insert into public.journeys(environment,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_text,created_at,updated_at,created_by,updated_by)
   values(p_environment,c,p_ref,'CALCULATOR','NOVO','ATIVO',p_initial->>'vehicle',jsonb_build_object('wishlists',coalesce(p_initial->'wishes','[]'::jsonb)),
     nullif(p_initial->>'maxBidCents','')::bigint,p_initial->>'payment',p_initial->>'deadline',at_time,at_time,p_actor,p_actor) returning * into j;
   insert into public.journey_refs(environment,journey_id,ref_code,created_at,created_by) values(p_environment,j.id,p_ref,at_time,p_actor);
   insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at)
     select p_environment,j.id,k, (array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[k], 'OPEN'::public.panel_checklist_status,at_time,at_time from generate_series(1,6) k;
 end if;
 -- M6: a closed journey keeps the note, a phone or a suggestion, but its state does not change.
 if (j.status='ENCERRADO' or j.stage_frozen) and exists(select 1 from jsonb_array_elements(p_items) e where e.value->>'type' not in ('phone','disable')) then
   raise exception 'JOURNEY_FROZEN';
 end if;
 update public.lead_tracking set journey_id=j.id,updated_at=at_time where environment=p_environment and ref_code=p_ref and journey_id is null;
 insert into public.lead_notes(environment,ref_code,journey_id,body_text,distributed_json,confirmation_key,created_at,created_by)
 values(p_environment,p_ref,j.id,p_body,p_items,p_key,at_time,p_actor) returning * into n;
 for x in select value from jsonb_array_elements(p_items) loop
   typ=x->>'type';v=x->'value';
   if typ='checklist' then
     if (x->>'point')::integer not between 1 and 6 then raise exception 'CHECKLIST_INVALID'; end if;
     update public.journey_checklist set status='COMPLETE',completed_at=at_time,updated_at=at_time
       where environment=p_environment and journey_id=j.id and point_number=(x->>'point')::integer;
     if not found then raise exception 'CHECKLIST_MISSING'; end if;
   elsif typ='budget' then
     if (v#>>'{}')::numeric <= 0 then raise exception 'CEILING_INVALID'; end if;
     update public.journeys set confirmed_total_ceiling_cents=round((v#>>'{}')::numeric*100),updated_at=at_time,updated_by=p_actor where id=j.id;
     update public.journey_checklist set status='COMPLETE',completed_at=at_time,updated_at=at_time where environment=p_environment and journey_id=j.id and point_number=2;
   elsif typ='payment' then
     if v#>>'{}' not in ('cash','fin') then raise exception 'PAYMENT_INVALID'; end if;
     update public.journeys set payment_text=v#>>'{}',updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='deadline' then
     -- The calculator says "3mo" (Within 3 months); the panel stores "3m".
     if v#>>'{}' not in ('now','30d','3m','3mo','none') then raise exception 'DEADLINE_INVALID'; end if;
     update public.journeys set customer_deadline_text=case when v#>>'{}'='3mo' then '3m' else v#>>'{}' end,updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='wishlist' then
     if jsonb_typeof(x->'finalWishes') <> 'array' then raise exception 'WISHLIST_INVALID'; end if;
     update public.journeys set criteria_json=coalesce(criteria_json,'{}'::jsonb)||jsonb_build_object('wishlists',x->'finalWishes','wishlistOverride',true),updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='phone' then
     normalized_phone=public.panel_normalize_phone(v->>'number');
     if normalized_phone is null then raise exception 'PHONE_INVALID'; end if;
     perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||j.contact_id::text));
     select cp.id into existing_phone_id from public.contact_phones cp
       where cp.environment=p_environment and cp.contact_id=j.contact_id and cp.phone_e164=normalized_phone and cp.retired_at is null and cp.is_current limit 1;
     if existing_phone_id is null then
       select exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=j.contact_id and cp.retired_at is null and cp.is_current) into has_active_phone;
       if has_active_phone and not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=j.contact_id and cp.retired_at is null and cp.is_current and cp.is_primary) then
         select cp.id into preferred_phone_id from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=j.contact_id and cp.retired_at is null and cp.is_current order by cp.created_at,cp.id limit 1;
         update public.contact_phones cp set is_primary=(cp.id=preferred_phone_id) where cp.environment=p_environment and cp.contact_id=j.contact_id;
       end if;
       insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,phone_owner,is_current,is_primary,created_at,created_by)
         values(p_environment,j.contact_id,v->>'number',normalized_phone,nullif(v->>'owner',''),true,not has_active_phone,at_time,p_actor);
     else
       update public.contact_phones cp set phone_owner=coalesce(nullif(v->>'owner',''),cp.phone_owner),phone_raw=v->>'number'
         where cp.id=existing_phone_id and cp.environment=p_environment;
     end if;
     insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
       values(p_environment,p_ref,j.id,'EXTRA_PHONE',jsonb_build_object('owner',v->>'owner','number',normalized_phone),at_time,p_actor);
   elsif typ='promise' then
     due_time=nullif(x->>'dueUtc','')::timestamptz;
     if due_time is null then raise exception 'DUE_DATE_REQUIRED'; end if;
     insert into public.lead_promises(environment,ref_code,journey_id,promise_text,due_at,created_at,created_by)
       values(p_environment,p_ref,j.id,coalesce(v->>'text','Promessa'),due_time,at_time,p_actor);
   elsif typ='return' then
     due_time=nullif(x->>'dueUtc','')::timestamptz;
     if due_time is null then raise exception 'DUE_DATE_REQUIRED'; end if;
     update public.journeys set next_action_at=due_time,next_action_text=coalesce(v->>'text','Retorno'),next_action_missing_since=null,updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='stage' then
     patch_stage=(v#>>'{}')::public.panel_journey_stage;
     update public.journeys set stage=patch_stage,qualified_at=case when patch_stage='QUALIFICADO' then coalesce(qualified_at,at_time) else null end,
       updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='disable' then
     if length(coalesce(v->>'reason','')) < 2 then raise exception 'REASON_INVALID'; end if;
     insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
       values(p_environment,p_ref,j.id,'DISABLE_SUGGESTED',jsonb_build_object('reason',v->>'reason'),at_time,p_actor);
   elsif typ='call_result' then
     result_text=v#>>'{}';
     if result_text not in ('ANSWERED','NO_ANSWER','LATER','IN_PERSON','DEPOSIT') then raise exception 'CALL_RESULT_INVALID'; end if;
     due_time=nullif(x->>'dueUtc','')::timestamptz;
     if result_text='LATER' and due_time is null then raise exception 'DUE_DATE_REQUIRED'; end if;
     event_type=case when result_text in ('NO_ANSWER','LATER') then 'CALL_ATTEMPT' when result_text='IN_PERSON' then 'IN_PERSON' else 'CALL_ANSWERED' end;
     prior=(select to_jsonb(q) from (select stage,status,qualified_at,next_action_at,next_action_text,next_action_missing_since,last_effective_contact_at from public.journeys where id=j.id) q);
     insert into public.interactions(environment,journey_id,type,occurred_at,detail_text,next_action_at,created_at,created_by)
       values(p_environment,j.id,event_type::public.panel_interaction_type,at_time,result_text,due_time,at_time,p_actor) returning id into interaction_id;
     update public.journeys set stage=case when result_text='DEPOSIT' then 'QUALIFICADO'::public.panel_journey_stage when result_text in ('ANSWERED','IN_PERSON') and stage='NOVO' then 'RESPONDIDO'::public.panel_journey_stage else stage end,
       qualified_at=case when result_text='DEPOSIT' then coalesce(qualified_at,at_time) else qualified_at end,
       last_effective_contact_at=case when result_text in ('NO_ANSWER','LATER') then last_effective_contact_at else at_time end,
       next_action_at=coalesce(due_time,next_action_at),next_action_text=case when due_time is null then next_action_text else result_text end,
       next_action_missing_since=case when due_time is null then next_action_missing_since else null end,updated_at=at_time,updated_by=p_actor where id=j.id;
     insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
       values(p_environment,p_ref,j.id,'QUICK_'||result_text,jsonb_build_object('label',result_text,'interactionId',interaction_id,'snapshot',prior,'dueAt',due_time,'source','annotation','confirmationKey',p_key),at_time,p_actor);
   else raise exception 'ITEM_TYPE_INVALID: %',typ;
   end if;
 end loop;
 insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
   values(p_environment,p_ref,j.id,'NOTE_CONFIRMED',jsonb_build_object('noteId',n.id,'confirmationKey',p_key),clock_timestamp(),p_actor);
 return jsonb_build_object('noteId',n.id,'journeyId',j.id,'distributed',jsonb_array_length(p_items),'duplicate',false);
end $$;

create or replace function public.panel_refresh_effective_mcs(p_environment public.panel_environment,p_journey uuid)
returns void language plpgsql security definer set search_path=public as $$
declare latest_message timestamptz; latest_call timestamptz;
begin
 select max(m.occurred_at_utc) into latest_message from public.messages m join public.message_journeys j on j.message_id=m.id
 where j.environment=p_environment and j.journey_id=p_journey and j.undone_at is null and m.environment=p_environment
   and m.direction='MCS' and not m.is_automatic and m.undone_at is null;
 -- An answered call or an in-person talk is effective contact too (it is not a WhatsApp message).
 select max(i.occurred_at) into latest_call from public.interactions i
 where i.environment=p_environment and i.journey_id=p_journey and i.undone_at is null and i.type in ('CALL_ANSWERED','IN_PERSON');
 -- M6: marking a message as automatic updates the date but never moves the stage back.
 update public.journeys x set
   last_effective_contact_at=nullif(greatest(coalesce(latest_message,'-infinity'::timestamptz),coalesce(latest_call,'-infinity'::timestamptz)),'-infinity'::timestamptz),
   updated_at=now()
 where x.environment=p_environment and x.id=p_journey and x.status<>'ENCERRADO';
end $$;

create or replace function public.panel_customer_unit_response(p_environment public.panel_environment,p_code text,p_unit uuid,p_response text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare t public.lead_tracking%rowtype; u public.units%rowtype; kind text; at_time timestamptz:=clock_timestamp();
begin
 select * into t from public.lead_tracking where environment=p_environment and public_code=p_code for update;
 if not found or t.journey_id is null then raise exception 'TRACKING_NOT_FOUND'; end if;
 select * into u from public.units where id=p_unit and environment=p_environment and journey_id=t.journey_id for update;
 if not found or p_response not in ('WANT','DECLINE') then raise exception 'RESPONSE_INVALID'; end if;
 if exists (select 1 from public.journey_toggle_states where environment=p_environment and journey_id=t.journey_id and enabled=false) or
    exists (select 1 from public.journeys where id=t.journey_id and status='ENCERRADO') then raise exception 'SEARCH_CLOSED'; end if;
 if u.status not in ('PRESENTED','UNDER_REVIEW','ACCEPTED','DECLINED') then raise exception 'UNIT_UNAVAILABLE'; end if;
 if u.status in ('ACCEPTED','DECLINED') then
   if u.status='ACCEPTED' and not exists(select 1 from public.lead_events where environment=p_environment and unit_id=p_unit and event_type='WANT_CAR' and undone_at is null) then
     insert into public.lead_events(environment,ref_code,journey_id,unit_id,event_type,detail_json,occurred_at)
       values(p_environment,t.ref_code,t.journey_id,p_unit,'WANT_CAR',jsonb_build_object('vehicle',u.vehicle_text),at_time);
   end if;
   return jsonb_build_object('alreadyAnswered',true);
 end if;
 kind=case when p_response='WANT' then 'WANT_CAR' else 'NOT_FOR_ME' end;
 update public.units set status=case when p_response='WANT' then 'ACCEPTED'::public.panel_unit_status else 'DECLINED'::public.panel_unit_status end,
   decline_reason=case when p_response='DECLINE' then 'Not for me' else null end,last_customer_response_at=coalesce(last_customer_response_at,at_time),updated_at=at_time where id=u.id;
 -- A10: the customer wanting a car means deciding. Only forward (QUALIFICADO stays).
 if p_response='WANT' then
   update public.journeys set stage='DECIDINDO',search_started_at=coalesce(search_started_at,at_time),updated_at=at_time
    where id=t.journey_id and environment=p_environment and stage in ('NOVO','RESPONDIDO','EM_BUSCA');
 end if;
 if not exists(select 1 from public.lead_events where environment=p_environment and unit_id=p_unit and event_type=kind and undone_at is null) then
   insert into public.lead_events(environment,ref_code,journey_id,unit_id,event_type,detail_json,occurred_at)
   values(p_environment,t.ref_code,t.journey_id,p_unit,kind,jsonb_build_object('vehicle',u.vehicle_text),at_time);
 end if;
 return jsonb_build_object('accepted',true);
end $$;

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

revoke all on function public.panel_set_journey_enabled(public.panel_environment, uuid, boolean, text, uuid) from public, anon, authenticated;
grant execute on function public.panel_set_journey_enabled(public.panel_environment, uuid, boolean, text, uuid) to service_role;
revoke all on function public.panel_quick_result(public.panel_environment,uuid,text,uuid,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.panel_quick_result(public.panel_environment,uuid,text,uuid,text,timestamptz,uuid) to service_role;
revoke all on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) to service_role;
revoke execute on function public.panel_refresh_effective_mcs(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_refresh_effective_mcs(public.panel_environment, uuid) to service_role;
revoke all on function public.panel_customer_unit_response(public.panel_environment,text,uuid,text) from public,anon,authenticated;
grant execute on function public.panel_customer_unit_response(public.panel_environment,text,uuid,text) to service_role;
revoke all on function public.panel_mark_message_fact_v2(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.panel_mark_message_fact_v2(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) to service_role;
revoke execute on function public.panel_mark_message_fact(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) from service_role;
