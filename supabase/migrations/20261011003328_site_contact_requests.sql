-- Independent, one-time requests from the public site. No customer, chat,
-- journey, calculator event or qualification is created by this feature.
create table public.site_contact_requests (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  request_key uuid not null,
  name text not null check (char_length(name) between 2 and 80),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  channel text not null check (channel in ('SMS','WHATSAPP','CALL')),
  language text not null check (language in ('en','pt','es')),
  source text not null check (source in ('footer','contact-menu')),
  consent_version text not null default 'one-time-car-search-v1',
  consent_at timestamptz not null default now(),
  ip_hash text not null check (ip_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'OPEN' check (status in ('OPEN','CONTACTED','ARCHIVED')),
  created_at timestamptz not null default now(),
  handled_at timestamptz,
  handled_by uuid references public.panel_users(id),
  unique(environment,request_key)
);
alter table public.site_contact_requests enable row level security;
revoke all on public.site_contact_requests from public,anon,authenticated;
grant select,insert,update on public.site_contact_requests to service_role;
create index site_contact_requests_queue on public.site_contact_requests(environment,status,created_at desc,id desc);
create index site_contact_requests_phone_rate on public.site_contact_requests(environment,phone_e164,created_at desc);
create index site_contact_requests_ip_rate on public.site_contact_requests(environment,ip_hash,created_at desc);
create index site_contact_requests_handled on public.site_contact_requests(environment,handled_at desc,id desc) where status <> 'OPEN';

create function public.site_contact_request_create(
 p_environment public.panel_environment,p_request_key uuid,p_name text,p_phone text,
 p_channel text,p_language text,p_source text,p_ip_hash text
) returns void language plpgsql security invoker set search_path='' as $$
declare existing public.site_contact_requests;
begin
 if p_environment is null or p_request_key is null or p_name is null or char_length(btrim(p_name)) not between 2 and 80
 or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
 or p_channel is null or p_channel not in ('SMS','WHATSAPP','CALL')
 or p_language is null or p_language not in ('en','pt','es')
 or p_source is null or p_source not in ('footer','contact-menu')
 or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$' then raise exception 'CONTACT_INVALID'; end if;
 -- Locks make repeat submissions and rate checks atomic across server instances.
 perform pg_advisory_xact_lock(hashtextextended('site-request:'||p_environment||':'||p_request_key,0));
 perform pg_advisory_xact_lock(hashtextextended('site-phone:'||p_environment||':'||p_phone,0));
 perform pg_advisory_xact_lock(hashtextextended('site-ip:'||p_environment||':'||p_ip_hash,0));
 select * into existing from public.site_contact_requests where environment=p_environment and request_key=p_request_key;
 if found then
  if existing.name<>p_name or existing.phone_e164<>p_phone or existing.channel<>p_channel or existing.language<>p_language or existing.source<>p_source then raise exception 'CONTACT_KEY_CONFLICT'; end if;
  return;
 end if;
 -- Reopening the form with exactly the same request does not duplicate the queue.
 if exists(select 1 from public.site_contact_requests where environment=p_environment and name=p_name and phone_e164=p_phone and channel=p_channel and language=p_language and source=p_source and created_at>now()-interval '10 minutes') then return; end if;
 if (select count(*) from public.site_contact_requests where environment=p_environment and phone_e164=p_phone and created_at>now()-interval '1 hour')>=3
 or (select count(*) from public.site_contact_requests where environment=p_environment and ip_hash=p_ip_hash and created_at>now()-interval '10 minutes')>=8 then raise exception 'CONTACT_RATE_LIMIT'; end if;
 insert into public.site_contact_requests(environment,request_key,name,phone_e164,channel,language,source,ip_hash)
 values(p_environment,p_request_key,btrim(p_name),p_phone,p_channel,p_language,p_source,p_ip_hash);
end;$$;
revoke all on function public.site_contact_request_create(public.panel_environment,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.site_contact_request_create(public.panel_environment,uuid,text,text,text,text,text,text) to service_role;

create function public.site_contact_request_status(
 p_environment public.panel_environment,p_id uuid,p_status text,p_expected_status text,p_actor uuid
) returns void language plpgsql security invoker set search_path='' as $$
declare current_status text;
begin
 if p_status is null or p_status not in ('OPEN','CONTACTED','ARCHIVED') or p_expected_status is null or p_expected_status not in ('OPEN','CONTACTED','ARCHIVED')
 or not exists(select 1 from public.panel_users where id=p_actor and environment=p_environment and active) then raise exception 'CONTACT_INVALID'; end if;
 select status into current_status from public.site_contact_requests where id=p_id and environment=p_environment for update;
 if not found then raise exception 'CONTACT_NOT_FOUND'; end if;
 if current_status=p_status then return; end if;
 if current_status<>p_expected_status then raise exception 'CONTACT_STATUS_CHANGED'; end if;
 update public.site_contact_requests set status=p_status,
 handled_at=case when p_status='OPEN' then null else now() end,
 handled_by=case when p_status='OPEN' then null else p_actor end
 where id=p_id and environment=p_environment;
end;$$;
revoke all on function public.site_contact_request_status(public.panel_environment,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.site_contact_request_status(public.panel_environment,uuid,text,text,uuid) to service_role;
