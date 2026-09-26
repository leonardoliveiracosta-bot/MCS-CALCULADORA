create or replace function public.panel_confirm_lead_note(
 p_environment public.panel_environment, p_actor uuid, p_ref text, p_journey uuid,
 p_body text, p_items jsonb, p_key uuid, p_initial jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.journeys%rowtype; n public.lead_notes%rowtype; c uuid; x jsonb; typ text; v jsonb;
  at_time timestamptz := clock_timestamp(); due_time timestamptz; event_type text; result_text text;
  prior jsonb; interaction_id uuid; patch_stage public.panel_journey_stage;
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
     if v#>>'{}' not in ('now','30d','3m','none') then raise exception 'DEADLINE_INVALID'; end if;
     update public.journeys set customer_deadline_text=v#>>'{}',updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='wishlist' then
     if jsonb_typeof(x->'finalWishes') <> 'array' then raise exception 'WISHLIST_INVALID'; end if;
     update public.journeys set criteria_json=coalesce(criteria_json,'{}'::jsonb)||jsonb_build_object('wishlists',x->'finalWishes','wishlistOverride',true),updated_at=at_time,updated_by=p_actor where id=j.id;
   elsif typ='phone' then
     if length(coalesce(v->>'number','')) < 7 then raise exception 'PHONE_INVALID'; end if;
     insert into public.contact_phones(environment,contact_id,phone_raw,phone_owner,is_current,is_primary,created_at,created_by)
       values(p_environment,j.contact_id,v->>'number',nullif(v->>'owner',''),true,true,at_time,p_actor);
     update public.contact_phones set is_primary=(phone_raw=v->>'number' and retired_at is null)
       where environment=p_environment and contact_id=j.contact_id;
     insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
       values(p_environment,p_ref,j.id,'EXTRA_PHONE',jsonb_build_object('owner',v->>'owner','number',v->>'number'),at_time,p_actor);
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
revoke all on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) to service_role;


