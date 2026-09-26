alter table public.contacts add column if not exists is_lead boolean not null default true;
alter table public.contacts add column if not exists lead_excluded_at timestamptz;
alter table public.contacts add column if not exists lead_excluded_by uuid references public.panel_users(id);
alter table public.contact_phones add column if not exists phone_owner text;
alter table public.contact_phones add column if not exists is_primary boolean not null default false;

create or replace function public.panel_normalize_phone(p_value text)
returns text language sql immutable parallel safe as $$
  with d as (select regexp_replace(coalesce(p_value,''),'[^0-9]','','g') v)
  select case when length(v)=10 then '+1'||v when length(v)=11 and left(v,1)='1' then '+'||v
    when length(v) between 7 and 15 and left(trim(coalesce(p_value,'')),1)='+' then '+'||v else null end from d
$$;

create or replace function public.panel_contact_phone_normalize()
returns trigger language plpgsql set search_path=public as $$
begin
  new.phone_e164=coalesce(public.panel_normalize_phone(new.phone_e164),public.panel_normalize_phone(new.phone_raw));
  return new;
end $$;
drop trigger if exists contact_phone_normalize on public.contact_phones;
create trigger contact_phone_normalize before insert or update of phone_raw,phone_e164 on public.contact_phones
for each row execute function public.panel_contact_phone_normalize();

update public.contact_phones set phone_e164=public.panel_normalize_phone(coalesce(phone_e164,phone_raw))
where public.panel_normalize_phone(coalesce(phone_e164,phone_raw)) is distinct from phone_e164;
with ranked as (
 select id,row_number() over(partition by environment,contact_id order by (retired_at is null) desc,is_current desc,confirmed_at desc nulls last,created_at desc,id) n
 from public.contact_phones
) update public.contact_phones p set is_primary=(r.n=1) from ranked r where p.id=r.id;

alter type public.panel_attachment_kind add value if not exists 'PDF';

create table if not exists public.whatsapp_address_book (
 environment public.panel_environment not null,
 phone_e164 text not null,
 full_name text,
 first_name text,
 source_action text,
 source_timestamp text,
 updated_at timestamptz not null default now(),
 primary key(environment,phone_e164)
);
alter table public.whatsapp_address_book enable row level security;
alter table public.whatsapp_address_book force row level security;
revoke all on public.whatsapp_address_book from anon,authenticated;
grant select,insert,update on public.whatsapp_address_book to service_role;

create table if not exists public.whatsapp_item_errors (
 id uuid primary key default gen_random_uuid(),
 environment public.panel_environment not null,
 raw_event_id uuid not null references public.whatsapp_raw_events(id) on delete cascade,
 item_index integer not null,
 error_code text not null,
 item_json jsonb not null default '{}',
 created_at timestamptz not null default now(),
 unique(raw_event_id,item_index)
);
alter table public.whatsapp_item_errors enable row level security;
alter table public.whatsapp_item_errors force row level security;
revoke all on public.whatsapp_item_errors from anon,authenticated;
grant select,insert,update on public.whatsapp_item_errors to service_role;

create table if not exists public.whatsapp_phone_reviews (
 id uuid primary key default gen_random_uuid(),
 environment public.panel_environment not null,
 raw_event_id uuid not null references public.whatsapp_raw_events(id) on delete cascade,
 item_index integer not null,
 item_json jsonb not null,
 phone_e164 text not null,
 candidate_contact_ids uuid[] not null,
 status text not null default 'PENDING' check(status in ('PENDING','LINKED','REJECTED')),
 created_at timestamptz not null default now(),
 resolved_at timestamptz,
 resolved_by uuid references public.panel_users(id),
 unique(raw_event_id,item_index)
);
alter table public.whatsapp_phone_reviews enable row level security;
alter table public.whatsapp_phone_reviews force row level security;
revoke all on public.whatsapp_phone_reviews from anon,authenticated;
grant select,insert,update on public.whatsapp_phone_reviews to service_role;

create index if not exists contacts_lead_filter_idx on public.contacts(environment,is_lead);
create index if not exists contact_phones_lookup_idx on public.contact_phones(environment,phone_e164) where retired_at is null;

create or replace function public.panel_whatsapp_apply_message(p_environment public.panel_environment,p_raw uuid,p_item jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
#variable_conflict use_variable
declare phone text := p_item->>'phone'; wid text := p_item->>'messageId'; nm text := left(coalesce(nullif(trim(p_item->>'name'),''),phone),160);
  body text := left(coalesce(p_item->>'body',''),25000); dir public.panel_message_direction;
  stamp timestamptz; contact_id uuid; journey_id uuid; chat_id uuid; message_id uuid; ref text;
  candidate record; new_contact boolean := false; norm text; other_count integer; forced_contact uuid := nullif(p_item->>'forceContactId','')::uuid; chosen_ref text;
begin
 if not exists(select 1 from public.whatsapp_raw_events where id=p_raw and environment=p_environment) then raise exception 'RAW_EVENT_MISSING'; end if;
 if phone !~ '^\+[1-9][0-9]{6,14}$' or length(wid) not between 2 and 256 or length(body)=0 or
    p_item->>'direction' not in ('CUSTOMER','MCS') then raise exception 'MESSAGE_INVALID'; end if;
 dir=(p_item->>'direction')::public.panel_message_direction;
 stamp=to_timestamp(nullif(p_item->>'timestamp','')::double precision);
 if stamp is null or stamp > now()+interval '1 day' or stamp < '2009-01-01'::timestamptz then raise exception 'TIMESTAMP_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||phone));
 select w.message_id into message_id from public.whatsapp_message_ids w where w.environment=p_environment and w.wa_message_id=wid;
 if found then return jsonb_build_object('messageId',message_id,'duplicate',true); end if;
 select count(distinct contact_id) into other_count from public.contact_phones
  where environment=p_environment and phone_e164=phone and retired_at is null;
 if forced_contact is not null then
   if not exists(select 1 from public.contacts c where c.id=forced_contact and c.environment=p_environment) then raise exception 'FORCED_CONTACT_INVALID'; end if;
   if other_count>0 and not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=forced_contact and cp.phone_e164=phone and cp.retired_at is null) then raise exception 'FORCED_CONTACT_NOT_CANDIDATE'; end if;
   contact_id=forced_contact;
 elsif other_count>1 then raise exception 'PHONE_AMBIGUOUS';
 else
   select cp.contact_id into contact_id from public.contact_phones cp where cp.environment=p_environment and cp.phone_e164=phone and cp.retired_at is null limit 1;
 end if;
 if nm=phone then
   select left(coalesce(nullif(full_name,''),nullif(first_name,''),phone),160) into nm
   from public.whatsapp_address_book where environment=p_environment and phone_e164=phone;
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
 if not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=contact_id and cp.phone_e164=phone and cp.retired_at is null) then
   insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
     values(p_environment,contact_id,phone,phone,true,true,now());
 end if;
 update public.contact_phones set is_primary=(phone_e164=phone and retired_at is null)
   where environment=p_environment and contact_id=contact_id;
 update public.contacts set display_name=nm,updated_at=now()
   where id=contact_id and (display_name is null or display_name='' or display_name=phone or display_name like 'Contato WhatsApp%');
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
     order by (status='ENCERRADO'),created_at desc limit 1;
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
 -- A phone is authoritative. A conflicting Ref is never attached to another person's journey.
 for ref in select distinct upper(value) from jsonb_array_elements_text(coalesce(p_item->'refs','[]'::jsonb)) value
   where upper(value) ~ '^[A-HJ-NP-Z2-9]{5}$' loop
   if not exists(select 1 from public.journeys j where j.environment=p_environment and j.reference_code=ref and j.contact_id<>contact_id)
     and not exists(select 1 from public.journey_refs r join public.journeys j on j.id=r.journey_id
       where r.environment=p_environment and j.environment=p_environment and r.ref_code=ref and j.contact_id<>contact_id) then
     insert into public.journey_refs(environment,journey_id,ref_code,created_at)
       select p_environment,journey_id,ref,now() where not exists(select 1 from public.journey_refs r where r.environment=p_environment and r.journey_id=journey_id and r.ref_code=ref);
   end if;
 end loop;
 select id into chat_id from public.chats where environment=p_environment and channel='WHATSAPP' and canonical_key='wa:'||phone limit 1;
 if chat_id is null then
   insert into public.chats(environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at)
     values(p_environment,'WHATSAPP',contact_id,'wa:'||phone,'RESOLVED',false,stamp,stamp,now(),now()) returning id into chat_id;
 end if;
 norm=lower(trim(regexp_replace(body,'\s+',' ','g')));
 -- The minute/text rule only reconciles older ZIP imports. Distinct live IDs remain distinct calls.
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
 update public.chats set last_seen_at=greatest(coalesce(last_seen_at,stamp),stamp),updated_at=now() where id=chat_id;
 if dir='MCS' then update public.journeys set stage=case when stage='NOVO' then 'RESPONDIDO' else stage end,
    last_effective_contact_at=greatest(coalesce(last_effective_contact_at,stamp),stamp),updated_at=now() where id=journey_id and status<>'ENCERRADO'; end if;
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

