alter table public.whatsapp_link_suggestions
  alter column target_contact_id drop not null,
  alter column target_journey_id drop not null,
  add column if not exists source_chat_id uuid references public.chats(id),
  add column if not exists target_ref char(5),
  add column if not exists motives text,
  add column if not exists suggestion_kind text not null default 'NAME_MATCH',
  add column if not exists candidate_latest_at timestamptz;

alter table public.whatsapp_link_suggestions
  drop constraint if exists whatsapp_link_suggestions_target_check;
alter table public.whatsapp_link_suggestions
  add constraint whatsapp_link_suggestions_target_check check (
    (target_journey_id is not null and target_contact_id is not null) or target_ref is not null
  );
create unique index if not exists whatsapp_link_suggestions_ai_ref_unique
  on public.whatsapp_link_suggestions(environment,source_journey_id,target_ref)
  where target_ref is not null;

create table if not exists public.conversation_ai_readings (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  summary_json jsonb not null default '{}'::jsonb,
  message_count integer not null check (message_count >= 0),
  last_customer_message_id uuid not null references public.messages(id),
  last_customer_at timestamptz not null,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','SUPERSEDED')),
  created_at timestamptz not null default now(),
  created_by uuid references public.panel_users(id)
);
create unique index if not exists conversation_ai_readings_one_active
  on public.conversation_ai_readings(environment,journey_id,chat_id) where status='ACTIVE';
create index if not exists conversation_ai_readings_last_customer_idx
  on public.conversation_ai_readings(environment,last_customer_at desc);

create table if not exists public.conversation_ai_items (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  reading_id uuid not null references public.conversation_ai_readings(id) on delete cascade,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  item_fingerprint text not null check (item_fingerprint ~ '^[0-9a-f]{64}$'),
  item_json jsonb not null,
  evidence_text text not null,
  manual_review boolean not null default false,
  status text not null default 'PENDING' check (status in ('PENDING','CONFIRMED','DISCARDED','SUPERSEDED')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.panel_users(id)
);
create index if not exists conversation_ai_items_pending_idx
  on public.conversation_ai_items(environment,journey_id,status,created_at desc);
create index if not exists conversation_ai_items_fingerprint_idx
  on public.conversation_ai_items(environment,journey_id,chat_id,item_fingerprint,status);

create table if not exists public.conversation_ai_daily_usage (
  environment public.panel_environment not null,
  day_et date not null,
  call_count integer not null default 0 check (call_count between 0 and 100),
  updated_at timestamptz not null default now(),
  primary key(environment,day_et)
);

create table if not exists public.conversation_ai_link_state (
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  first_customer_at timestamptz not null,
  last_run_at timestamptz,
  last_order_seen_at timestamptz,
  retry_requested boolean not null default false,
  primary key(environment,journey_id,chat_id)
);

do $$ declare table_name text; begin
  foreach table_name in array array['conversation_ai_readings','conversation_ai_items','conversation_ai_daily_usage','conversation_ai_link_state'] loop
    execute format('alter table public.%I enable row level security',table_name);
    execute format('alter table public.%I force row level security',table_name);
    execute format('revoke all on public.%I from public,anon,authenticated',table_name);
    execute format('grant select,insert,update,delete on public.%I to service_role',table_name);
  end loop;
end $$;

create or replace function public.panel_ai_reserve_call(p_environment public.panel_environment)
returns jsonb language plpgsql security definer set search_path=public as $$
declare usage_day date := (clock_timestamp() at time zone 'America/New_York')::date; current_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('conversation-ai:'||p_environment::text||':'||usage_day::text));
  insert into public.conversation_ai_daily_usage(environment,day_et,call_count,updated_at)
    values(p_environment,usage_day,0,clock_timestamp()) on conflict do nothing;
  select u.call_count into current_count from public.conversation_ai_daily_usage u
    where u.environment=p_environment and u.day_et=usage_day for update;
  if current_count >= 100 then return jsonb_build_object('allowed',false,'count',current_count,'day',usage_day); end if;
  update public.conversation_ai_daily_usage u set call_count=u.call_count+1,updated_at=clock_timestamp()
    where u.environment=p_environment and u.day_et=usage_day returning u.call_count into current_count;
  return jsonb_build_object('allowed',true,'count',current_count,'day',usage_day);
end $$;
revoke all on function public.panel_ai_reserve_call(public.panel_environment) from public,anon,authenticated;
grant execute on function public.panel_ai_reserve_call(public.panel_environment) to service_role;

create or replace function public.panel_ai_replace_reading(
  p_environment public.panel_environment,p_journey uuid,p_chat uuid,p_summary jsonb,p_items jsonb,
  p_message_count integer,p_last_customer uuid,p_last_customer_at timestamptz,p_actor uuid default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare reading_id uuid; entry jsonb; inserted_count integer:=0;
begin
  if jsonb_typeof(p_summary)<>'object' or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>30
    or p_message_count<1 or p_last_customer_at is null then raise exception 'AI_READING_INVALID'; end if;
  if not exists(select 1 from public.message_journeys mj join public.messages m on m.id=mj.message_id
    where mj.environment=p_environment and mj.journey_id=p_journey and m.environment=p_environment
      and m.id=p_last_customer and m.chat_id=p_chat and m.direction='CUSTOMER') then raise exception 'AI_MESSAGE_MISMATCH'; end if;
  perform pg_advisory_xact_lock(hashtext(p_environment::text||':'||p_journey::text||':'||p_chat::text));
  update public.conversation_ai_readings r set status='SUPERSEDED'
    where r.environment=p_environment and r.journey_id=p_journey and r.chat_id=p_chat and r.status='ACTIVE';
  update public.conversation_ai_items i set status='SUPERSEDED'
    where i.environment=p_environment and i.journey_id=p_journey and i.chat_id=p_chat and i.status='PENDING';
  insert into public.conversation_ai_readings(environment,journey_id,chat_id,summary_json,message_count,last_customer_message_id,last_customer_at,created_by)
    values(p_environment,p_journey,p_chat,p_summary,p_message_count,p_last_customer,p_last_customer_at,p_actor) returning id into reading_id;
  for entry in select value from jsonb_array_elements(p_items) loop
    if entry->>'fingerprint' !~ '^[0-9a-f]{64}$' or jsonb_typeof(entry->'item')<>'object'
      or length(trim(coalesce(entry->>'evidence',''))) < 2 then raise exception 'AI_ITEM_INVALID'; end if;
    if not exists(select 1 from public.conversation_ai_items old
      where old.environment=p_environment and old.journey_id=p_journey and old.chat_id=p_chat
        and old.item_fingerprint=entry->>'fingerprint' and old.status in ('CONFIRMED','DISCARDED')) then
      insert into public.conversation_ai_items(environment,reading_id,journey_id,chat_id,item_fingerprint,item_json,evidence_text,manual_review)
        values(p_environment,reading_id,p_journey,p_chat,entry->>'fingerprint',entry->'item',entry->>'evidence',coalesce((entry->>'manualReview')::boolean,false));
      inserted_count:=inserted_count+1;
    end if;
  end loop;
  return jsonb_build_object('readingId',reading_id,'pending',inserted_count);
end $$;
revoke all on function public.panel_ai_replace_reading(public.panel_environment,uuid,uuid,jsonb,jsonb,integer,uuid,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.panel_ai_replace_reading(public.panel_environment,uuid,uuid,jsonb,jsonb,integer,uuid,timestamptz,uuid) to service_role;

create or replace function public.panel_ai_confirm_items(
  p_environment public.panel_environment,p_actor uuid,p_journey uuid,p_reading uuid,p_item_ids uuid[],p_key uuid,p_initial jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare ref text; selected jsonb; result jsonb; selected_count integer;
begin
  if p_key is null or coalesce(array_length(p_item_ids,1),0)=0 then raise exception 'AI_SELECTION_REQUIRED'; end if;
  perform j.id from public.journeys j where j.environment=p_environment and j.id=p_journey for update;
  select candidate.ref into ref from (
    select trim(j.reference_code) ref,0 priority from public.journeys j where j.environment=p_environment and j.id=p_journey
    union all
    select trim(r.ref_code),1 from public.journey_refs r where r.environment=p_environment and r.journey_id=p_journey
  ) candidate where candidate.ref ~ '^[A-HJ-NP-Z2-9]{5}$' and exists(
    select 1 from public.calc_runs cr where not cr.is_test and upper(trim(cr.dados->>'ref'))=candidate.ref
  ) order by candidate.priority limit 1;
  if ref is null then raise exception 'AI_REF_REQUIRED'; end if;
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

create or replace function public.panel_ai_discard_reading(p_environment public.panel_environment,p_actor uuid,p_journey uuid,p_reading uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare changed integer;
begin
  update public.conversation_ai_items i set status='DISCARDED',decided_at=clock_timestamp(),decided_by=p_actor
    where i.environment=p_environment and i.journey_id=p_journey and i.reading_id=p_reading and i.status='PENDING';
  get diagnostics changed=row_count;
  return jsonb_build_object('discarded',changed);
end $$;
revoke all on function public.panel_ai_discard_reading(public.panel_environment,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.panel_ai_discard_reading(public.panel_environment,uuid,uuid,uuid) to service_role;

create or replace function public.panel_whatsapp_resolve_suggestion(p_environment public.panel_environment,p_id uuid,p_actor uuid,p_link boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.whatsapp_link_suggestions%rowtype; m record; existing_id uuid; linked_count integer:=0; skipped_count integer:=0; owner uuid;
begin
  select * into s from public.whatsapp_link_suggestions where id=p_id and environment=p_environment for update;
  if not found or s.status<>'PENDING' then raise exception 'SUGGESTION_UNAVAILABLE'; end if;
  if p_link and s.target_ref is not null then
    select j.id into owner from public.journeys j where j.environment=p_environment and j.id<>s.source_journey_id and trim(j.reference_code)=trim(s.target_ref) limit 1;
    if owner is null then select j.id into owner from public.journey_refs r join public.journeys j on j.id=r.journey_id and j.environment=r.environment
      where r.environment=p_environment and j.id<>s.source_journey_id and trim(r.ref_code)=trim(s.target_ref) limit 1; end if;
    if owner is not null then raise exception 'REF_ALREADY_LINKED'; end if;
    update public.journeys j set reference_code=coalesce(j.reference_code,s.target_ref),updated_at=clock_timestamp(),updated_by=p_actor
      where j.environment=p_environment and j.id=s.source_journey_id;
    insert into public.journey_refs(environment,journey_id,ref_code,created_at,created_by)
      values(p_environment,s.source_journey_id,s.target_ref,clock_timestamp(),p_actor) on conflict do nothing;
    update public.calculator_request_links l set contact_id=s.source_contact_id,journey_id=s.source_journey_id,linked_at=clock_timestamp(),linked_by=p_actor
      where l.environment=p_environment and trim(l.calc_ref)=trim(s.target_ref);
    linked_count:=1;
  elsif p_link then
    insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,confirmed_at,created_at,created_by)
      select p_environment,s.target_contact_id,s.phone_e164,s.phone_e164,true,now(),now(),p_actor
      where not exists(select 1 from public.contact_phones cp where cp.environment=p_environment and cp.contact_id=s.target_contact_id and cp.phone_e164=s.phone_e164 and cp.retired_at is null);
    update public.chats set contact_id=s.target_contact_id,updated_at=now() where environment=p_environment and contact_id=s.source_contact_id and canonical_key='wa:'||s.phone_e164;
    for m in select q.message_id,x.body_normalized,x.direction,x.occurred_at_utc from public.message_journeys q
      join public.messages x on x.id=q.message_id where q.environment=p_environment and q.journey_id=s.source_journey_id loop
      select x.id into existing_id from public.message_journeys q join public.messages x on x.id=q.message_id
        where q.environment=p_environment and q.journey_id=s.target_journey_id and x.id<>m.message_id
          and x.direction=m.direction and x.body_normalized=m.body_normalized
          and date_trunc('minute',x.occurred_at_utc)=date_trunc('minute',m.occurred_at_utc) limit 1;
      if existing_id is null then
        insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at,associated_by)
          values(p_environment,m.message_id,s.target_journey_id,'WHATSAPP_REVIEW',now(),p_actor) on conflict do nothing;
        linked_count:=linked_count+1;
      else skipped_count:=skipped_count+1; end if;
    end loop;
    delete from public.message_journeys where environment=p_environment and journey_id=s.source_journey_id;
    update public.journeys set status='ENCERRADO',closed_at=now(),closed_reason='WHATSAPP_LINKED',updated_at=now(),updated_by=p_actor
      where id=s.source_journey_id and environment=p_environment;
  end if;
  update public.whatsapp_link_suggestions set status=case when p_link then 'LINKED' else 'REJECTED' end,
    resolved_at=now(),resolved_by=p_actor where id=p_id;
  update public.conversation_ai_link_state st set retry_requested=not p_link
    where st.environment=p_environment and st.journey_id=s.source_journey_id and st.chat_id=coalesce(s.source_chat_id,st.chat_id);
  return jsonb_build_object('linked',linked_count,'duplicates',skipped_count,'status',case when p_link then 'LINKED' else 'REJECTED' end);
end $$;
revoke all on function public.panel_whatsapp_resolve_suggestion(public.panel_environment,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_resolve_suggestion(public.panel_environment,uuid,uuid,boolean) to service_role;
