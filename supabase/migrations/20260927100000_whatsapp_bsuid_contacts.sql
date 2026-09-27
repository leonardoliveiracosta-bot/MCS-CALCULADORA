create table if not exists public.whatsapp_user_ids (
  environment public.panel_environment not null,
  bsuid text not null,
  contact_id uuid not null references public.contacts(id),
  username text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (environment, bsuid),
  constraint whatsapp_user_ids_bsuid_check check (bsuid ~ '^[A-Z]{2}\.[A-Za-z0-9]{1,128}$')
);
create index if not exists whatsapp_user_ids_contact_idx
  on public.whatsapp_user_ids(environment, contact_id);
alter table public.whatsapp_user_ids enable row level security;
alter table public.whatsapp_user_ids force row level security;
revoke all on public.whatsapp_user_ids from public, anon, authenticated;
grant all on public.whatsapp_user_ids to service_role;

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
     and ((wid is not null and m.source_kind='WHATSAPP_ZIP')
       or (wid is null and m.source_kind in ('WHATSAPP_ZIP',source_key)))
     and m.direction=dir and m.body_normalized=norm and date_trunc('minute',m.occurred_at_utc)=date_trunc('minute',stamp)
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
 if dir='MCS' then update public.journeys j set stage=case when j.stage='NOVO' then 'RESPONDIDO' else j.stage end,
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
