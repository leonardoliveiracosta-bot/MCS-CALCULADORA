create table if not exists public.panel_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  panel_user_id uuid not null references public.panel_users(id),
  endpoint text not null check (length(endpoint) between 16 and 2048),
  p256dh text not null check (length(p256dh) between 16 and 512),
  auth text not null check (length(auth) between 8 and 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_status integer,
  failure_count integer not null default 0 check (failure_count >= 0),
  unique(environment, endpoint)
);

create index if not exists panel_push_subscriptions_user_idx
  on public.panel_push_subscriptions(environment, panel_user_id);

alter table public.panel_push_subscriptions enable row level security;
alter table public.panel_push_subscriptions force row level security;
revoke all on public.panel_push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.panel_push_subscriptions to service_role;

create table if not exists public.panel_push_contact_throttle (
  environment public.panel_environment not null,
  contact_id uuid not null references public.contacts(id),
  last_sent_at timestamptz not null default now(),
  last_message_id uuid references public.messages(id),
  primary key(environment, contact_id)
);

alter table public.panel_push_contact_throttle enable row level security;
alter table public.panel_push_contact_throttle force row level security;
revoke all on public.panel_push_contact_throttle from public, anon, authenticated;
grant select, insert, update on public.panel_push_contact_throttle to service_role;

create or replace function public.panel_claim_push_throttle(
  p_environment public.panel_environment,
  p_contact_id uuid,
  p_message_id uuid default null
)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare claimed boolean := false;
begin
  if not exists(select 1 from public.contacts where id=p_contact_id and environment=p_environment)
     or (p_message_id is not null and not exists(select 1 from public.messages where id=p_message_id and environment=p_environment)) then
    return false;
  end if;
  insert into public.panel_push_contact_throttle(environment,contact_id,last_sent_at,last_message_id)
    values(p_environment,p_contact_id,now(),p_message_id)
  on conflict(environment,contact_id) do update
    set last_sent_at=excluded.last_sent_at,last_message_id=excluded.last_message_id
    where public.panel_push_contact_throttle.last_sent_at <= excluded.last_sent_at - interval '5 minutes'
  returning true into claimed;
  return coalesce(claimed,false);
end $$;

revoke all on function public.panel_claim_push_throttle(public.panel_environment,uuid,uuid) from public, anon, authenticated;
grant execute on function public.panel_claim_push_throttle(public.panel_environment,uuid,uuid) to service_role;
