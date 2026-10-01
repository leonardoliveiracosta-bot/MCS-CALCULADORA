-- Confirmar itens da leitura da IA e anotações ("Distribuir o que conversei") numa ficha SEM Ref
-- da calculadora (clientes que chegaram direto por WhatsApp/SMS). A ficha passa a ser identificada
-- pela própria jornada: as anotações, eventos e promessas gravam journey_id e ficam sem ref_code.
-- O caminho com Ref continua igual. Migração aditiva: nada é apagado.

-- 1) ref_code passa a ser opcional quando a linha tem a jornada (nunca os dois vazios).
alter table public.lead_notes alter column ref_code drop not null;
alter table public.lead_events alter column ref_code drop not null;
alter table public.lead_promises alter column ref_code drop not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='lead_notes_ref_or_journey') then
    alter table public.lead_notes add constraint lead_notes_ref_or_journey check (ref_code is not null or journey_id is not null);
  end if;
  if not exists(select 1 from pg_constraint where conname='lead_events_ref_or_journey') then
    alter table public.lead_events add constraint lead_events_ref_or_journey check (ref_code is not null or journey_id is not null);
  end if;
  if not exists(select 1 from pg_constraint where conname='lead_promises_ref_or_journey') then
    alter table public.lead_promises add constraint lead_promises_ref_or_journey check (ref_code is not null or journey_id is not null);
  end if;
end $$;
-- A ficha sem Ref lê suas anotações, eventos e promessas pela jornada.
create index if not exists lead_notes_journey_created_idx on public.lead_notes(environment, journey_id, created_at desc);
create index if not exists lead_events_journey_occurred_idx on public.lead_events(environment, journey_id, occurred_at desc);
create index if not exists lead_promises_journey_due_idx on public.lead_promises(environment, journey_id, due_at);

-- 2) Anotação confirmada: com Ref (igual a antes) ou, sem Ref, pela jornada informada.
create or replace function public.panel_confirm_lead_note(
 p_environment public.panel_environment, p_actor uuid, p_ref text, p_journey uuid,
 p_body text, p_items jsonb, p_key uuid, p_initial jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.journeys%rowtype; n public.lead_notes%rowtype; c uuid; x jsonb; typ text; v jsonb;
  at_time timestamptz := clock_timestamp(); due_time timestamptz; event_type text; result_text text;
  prior jsonb; interaction_id uuid; patch_stage public.panel_journey_stage;
  normalized_phone text; existing_phone_id uuid; preferred_phone_id uuid; has_active_phone boolean;
  -- Sem Ref (nula ou vazia) a ficha é a jornada informada; com Ref, o formato continua obrigatório.
  ref_value text := case when p_ref is null or trim(p_ref)='' then null else p_ref end;
begin
 if (ref_value is null and p_journey is null) or (ref_value is not null and ref_value !~ '^[A-HJ-NP-Z2-9]{5}$')
    or p_key is null or length(trim(p_body)) not between 1 and 12000
    or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 30 then raise exception 'NOTE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||coalesce(ref_value,'journey:'||p_journey::text)));
 select * into n from public.lead_notes where environment=p_environment and confirmation_key=p_key;
 if found then
   if n.ref_code::text is distinct from ref_value or n.body_text <> p_body or n.created_by <> p_actor
      or (ref_value is null and n.journey_id is distinct from p_journey) then raise exception 'CONFIRMATION_KEY_REUSED'; end if;
   return jsonb_build_object('noteId',n.id,'journeyId',n.journey_id,'duplicate',true);
 end if;
 if ref_value is null then
   -- Ficha sem Ref: nunca cria contato nem jornada; a jornada precisa existir.
   select * into j from public.journeys where environment=p_environment and id=p_journey for update;
   if not found then raise exception 'JOURNEY_NOT_FOUND'; end if;
 elsif p_journey is not null then
   select * into j from public.journeys where environment=p_environment and id=p_journey for update;
   -- A ficha sem reference_code também precisa ter a Ref ligada (antes o null deixava passar).
   if not found or (j.reference_code::text is distinct from ref_value and not exists (select 1 from public.journey_refs where environment=p_environment and journey_id=j.id and ref_code=ref_value)) then
     raise exception 'JOURNEY_REF_MISMATCH'; end if;
 else
   select * into j from public.journeys where environment=p_environment and reference_code=ref_value order by created_at limit 1 for update;
   if not found then
     select q.* into j from public.journey_refs r join public.journeys q on q.id=r.journey_id and q.environment=r.environment
       where r.environment=p_environment and r.ref_code=ref_value order by q.created_at limit 1 for update of q;
   end if;
 end if;
 if j.id is null then
   insert into public.contacts(environment,display_name,source,created_at,updated_at,created_by,updated_by)
   values(p_environment,coalesce(nullif(p_initial->>'name',''),'Contato da Ref '||ref_value),'CALCULATOR',at_time,at_time,p_actor,p_actor) returning id into c;
   insert into public.journeys(environment,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_text,created_at,updated_at,created_by,updated_by)
   values(p_environment,c,ref_value,'CALCULATOR','NOVO','ATIVO',p_initial->>'vehicle',jsonb_build_object('wishlists',coalesce(p_initial->'wishes','[]'::jsonb)),
     nullif(p_initial->>'maxBidCents','')::bigint,p_initial->>'payment',p_initial->>'deadline',at_time,at_time,p_actor,p_actor) returning * into j;
   insert into public.journey_refs(environment,journey_id,ref_code,created_at,created_by) values(p_environment,j.id,ref_value,at_time,p_actor);
   insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at)
     select p_environment,j.id,k, (array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[k], 'OPEN'::public.panel_checklist_status,at_time,at_time from generate_series(1,6) k;
 end if;
 -- M6: a closed journey only takes a note that adds a phone or a suggestion; anything that would
 -- change its state is refused (JOURNEY_FROZEN) and nothing is saved.
 if (j.status='ENCERRADO' or j.stage_frozen) and exists(select 1 from jsonb_array_elements(p_items) e where e.value->>'type' not in ('phone','disable')) then
   raise exception 'JOURNEY_FROZEN';
 end if;
 if ref_value is not null then
   update public.lead_tracking set journey_id=j.id,updated_at=at_time where environment=p_environment and ref_code=ref_value and journey_id is null;
 end if;
 insert into public.lead_notes(environment,ref_code,journey_id,body_text,distributed_json,confirmation_key,created_at,created_by)
 values(p_environment,ref_value,j.id,p_body,p_items,p_key,at_time,p_actor) returning * into n;
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
       values(p_environment,ref_value,j.id,'EXTRA_PHONE',jsonb_build_object('owner',v->>'owner','number',normalized_phone),at_time,p_actor);
   elsif typ='promise' then
     due_time=nullif(x->>'dueUtc','')::timestamptz;
     if due_time is null then raise exception 'DUE_DATE_REQUIRED'; end if;
     insert into public.lead_promises(environment,ref_code,journey_id,promise_text,due_at,created_at,created_by)
       values(p_environment,ref_value,j.id,coalesce(v->>'text','Promessa'),due_time,at_time,p_actor);
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
       values(p_environment,ref_value,j.id,'DISABLE_SUGGESTED',jsonb_build_object('reason',v->>'reason'),at_time,p_actor);
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
       -- B6: an automatic follow-up never replaces a manual return still in the future.
       next_action_at=case when result_text in ('ANSWERED','NO_ANSWER','IN_PERSON') and next_action_at>at_time then next_action_at else coalesce(due_time,next_action_at) end,
       next_action_text=case when result_text in ('ANSWERED','NO_ANSWER','IN_PERSON') and next_action_at>at_time then next_action_text when due_time is null then next_action_text else result_text end,
       next_action_missing_since=case when due_time is null and not coalesce(next_action_at>at_time,false) then next_action_missing_since else null end,updated_at=at_time,updated_by=p_actor where id=j.id;
     insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
       values(p_environment,ref_value,j.id,'QUICK_'||result_text,jsonb_build_object('label',result_text,'interactionId',interaction_id,'snapshot',prior,'dueAt',due_time,'source','annotation','confirmationKey',p_key),at_time,p_actor);
   else raise exception 'ITEM_TYPE_INVALID: %',typ;
   end if;
 end loop;
 insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
   values(p_environment,ref_value,j.id,'NOTE_CONFIRMED',jsonb_build_object('noteId',n.id,'confirmationKey',p_key),clock_timestamp(),p_actor);
 return jsonb_build_object('noteId',n.id,'journeyId',j.id,'distributed',jsonb_array_length(p_items),'duplicate',false);
end $$;

revoke all on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) to service_role;

-- 3) Itens da leitura da IA: com Ref da calculadora usa a Ref (igual a antes); sem ela, confirma
-- pela jornada. Ficha encerrada continua recusada (JOURNEY_FROZEN dentro da anotação).
create or replace function public.panel_ai_confirm_items(
  p_environment public.panel_environment,p_actor uuid,p_journey uuid,p_reading uuid,p_item_ids uuid[],p_key uuid,p_initial jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare ref text; selected jsonb; result jsonb; selected_count integer;
begin
  if p_key is null or coalesce(array_length(p_item_ids,1),0)=0 then raise exception 'AI_SELECTION_REQUIRED'; end if;
  perform j.id from public.journeys j where j.environment=p_environment and j.id=p_journey for update;
  if not found then raise exception 'JOURNEY_NOT_FOUND'; end if;
  select candidate.ref into ref from (
    select trim(j.reference_code) ref,0 priority from public.journeys j where j.environment=p_environment and j.id=p_journey
    union all
    select trim(r.ref_code),1 from public.journey_refs r where r.environment=p_environment and r.journey_id=p_journey
  ) candidate where candidate.ref ~ '^[A-HJ-NP-Z2-9]{5}$' and exists(
    select 1 from public.calc_runs cr where not cr.is_test and upper(trim(cr.dados->>'ref'))=candidate.ref
  ) order by candidate.priority limit 1;
  -- ref nula: ficha sem Ref da calculadora, a anotação vai pela jornada (p_journey).
  perform i.id from public.conversation_ai_items i where i.environment=p_environment and i.journey_id=p_journey
      and i.reading_id=p_reading and i.id=any(p_item_ids) and i.status='PENDING' for update;
  select count(*),coalesce(jsonb_agg(i.item_json order by i.created_at,i.id),'[]'::jsonb) into selected_count,selected
    from public.conversation_ai_items i where i.environment=p_environment and i.journey_id=p_journey
      and i.reading_id=p_reading and i.id=any(p_item_ids) and i.status='PENDING';
  if selected_count<>coalesce(array_length(p_item_ids,1),0) then raise exception 'AI_ITEMS_UNAVAILABLE'; end if;
  result:=public.panel_confirm_lead_note(p_environment,p_actor,ref,p_journey,'Leitura da IA',selected,p_key,p_initial);
  update public.conversation_ai_items i set status='CONFIRMED',decided_at=clock_timestamp(),decided_by=p_actor
    where i.environment=p_environment and i.reading_id=p_reading and i.id=any(p_item_ids) and i.status='PENDING';
  return result||jsonb_build_object('confirmed',selected_count);
end $$;
revoke all on function public.panel_ai_confirm_items(public.panel_environment,uuid,uuid,uuid,uuid[],uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_ai_confirm_items(public.panel_environment,uuid,uuid,uuid,uuid[],uuid,jsonb) to service_role;
