create or replace function public.panel_contact_phone_normalize()
returns trigger language plpgsql set search_path=public as $$
declare normalized text;
begin
  normalized=coalesce(public.panel_normalize_phone(new.phone_e164),public.panel_normalize_phone(new.phone_raw));
  if normalized is null then raise exception 'PHONE_INVALID'; end if;
  new.phone_e164=normalized;
  return new;
end $$;

-- Repair the current primary flags deterministically before enforcing uniqueness.
with ranked as (
  select cp.id,
    row_number() over (
      partition by cp.environment,cp.contact_id
      order by
        exists(
          select 1 from public.chats c
          where c.environment=cp.environment and c.contact_id=cp.contact_id
            and c.channel='WHATSAPP' and c.canonical_key='wa:'||cp.phone_e164
        ) desc,
        cp.is_primary desc,
        cp.created_at asc,
        cp.id asc
    ) as position
  from public.contact_phones cp
  where cp.retired_at is null and cp.is_current
)
update public.contact_phones cp
set is_primary=(ranked.position=1)
from ranked
where cp.id=ranked.id;

update public.contact_phones cp
set is_primary=false
where cp.retired_at is not null or not cp.is_current;

create unique index if not exists contact_phones_one_active_primary_idx
  on public.contact_phones(environment,contact_id)
  where is_primary and retired_at is null and is_current;

create unique index if not exists contact_phones_one_active_number_idx
  on public.contact_phones(environment,contact_id,phone_e164)
  where retired_at is null and is_current;

create or replace function public.panel_whatsapp_apply_message(p_environment public.panel_environment,p_raw uuid,p_item jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
#variable_conflict use_variable
declare phone text := p_item->>'phone'; wid text := p_item->>'messageId'; nm text := left(coalesce(nullif(trim(p_item->>'name'),''),phone),160);
  body text := left(coalesce(p_item->>'body',''),25000); dir public.panel_message_direction;
  stamp timestamptz; contact_id uuid; journey_id uuid; chat_id uuid; message_id uuid; ref text;
  new_contact boolean := false; norm text; other_count integer; forced_contact uuid := nullif(p_item->>'forceContactId','')::uuid; chosen_ref text;
begin
 if not exists(select 1 from public.whatsapp_raw_events raw where raw.id=p_raw and raw.environment=p_environment) then raise exception 'RAW_EVENT_MISSING'; end if;
 if phone !~ '^\+[1-9][0-9]{6,14}$' or length(wid) not between 2 and 256 or length(body)=0 or
    p_item->>'direction' not in ('CUSTOMER','MCS') then raise exception 'MESSAGE_INVALID'; end if;
 dir=(p_item->>'direction')::public.panel_message_direction;
 stamp=to_timestamp(nullif(p_item->>'timestamp','')::double precision);
 if stamp is null or stamp > now()+interval '1 day' or stamp < '2009-01-01'::timestamptz then raise exception 'TIMESTAMP_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||phone));
 select w.message_id into message_id from public.whatsapp_message_ids w where w.environment=p_environment and w.wa_message_id=wid;
 if found then return jsonb_build_object('messageId',message_id,'duplicate',true); end if;
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
 if nm=phone then
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
 if not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=contact_id and cp.phone_e164=phone and cp.retired_at is null and cp.is_current) then
   insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
     values(p_environment,contact_id,phone,phone,true,false,now());
 end if;
 -- A WhatsApp number is authoritative for this contact only.
 update public.contact_phones cp set is_primary=(cp.phone_e164=phone and cp.retired_at is null and cp.is_current)
   where cp.environment=p_environment and cp.contact_id=contact_id;
 update public.contacts c set display_name=nm,updated_at=now()
   where c.id=contact_id and c.environment=p_environment and (c.display_name is null or c.display_name='' or c.display_name=phone or c.display_name like 'Contato WhatsApp%');
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
 select c.id into chat_id from public.chats c where c.environment=p_environment and c.channel='WHATSAPP' and c.canonical_key='wa:'||phone limit 1;
 if chat_id is null then
   insert into public.chats(environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at)
     values(p_environment,'WHATSAPP',contact_id,'wa:'||phone,'RESOLVED',false,stamp,stamp,now(),now()) returning id into chat_id;
 end if;
 norm=lower(trim(regexp_replace(body,'\s+',' ','g')));
 select m.id into message_id from public.messages m join public.message_journeys l on l.message_id=m.id
   where l.environment=p_environment and l.journey_id=journey_id and m.environment=p_environment
     and m.source_kind='WHATSAPP_ZIP'
     and m.direction=dir and m.body_normalized=norm and date_trunc('minute',m.occurred_at_utc)=date_trunc('minute',stamp)
   order by m.created_at limit 1;
 if message_id is null then
   insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at)
     values(p_environment,chat_id,'WHATSAPP',dir,body,norm,stamp,false,'WA:'||wid,1,'WHATSAPP_WEBHOOK',now()) returning id into message_id;
   insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
     values(p_environment,message_id,journey_id,'WHATSAPP_WEBHOOK',now());
   insert into public.interactions(environment,journey_id,message_id,type,occurred_at,created_at)
     values(p_environment,journey_id,message_id,case when dir='MCS' then 'OUTBOUND_MESSAGE' else 'INBOUND_MESSAGE' end::public.panel_interaction_type,stamp,now());
 end if;
 insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id) values(p_environment,wid,message_id,p_raw);
 update public.chats c set last_seen_at=greatest(coalesce(c.last_seen_at,stamp),stamp),updated_at=now() where c.id=chat_id and c.environment=p_environment;
 if dir='MCS' then update public.journeys j set stage=case when j.stage='NOVO' then 'RESPONDIDO' else j.stage end,
    last_effective_contact_at=greatest(coalesce(j.last_effective_contact_at,stamp),stamp),updated_at=now() where j.id=journey_id and j.environment=p_environment and j.status<>'ENCERRADO'; end if;
 if new_contact then
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

revoke all on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_confirm_lead_note(public.panel_environment,uuid,text,uuid,text,jsonb,uuid,jsonb) to service_role;
