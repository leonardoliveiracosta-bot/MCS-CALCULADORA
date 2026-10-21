alter table public.panel_users add column username text;
alter table public.panel_users add column sessions_valid_after timestamptz;
alter table public.panel_users add constraint panel_users_username_format check (username is null or username ~ '^[a-z][a-z0-9_]{2,31}$');
create unique index panel_users_username_idx on public.panel_users(environment,username) where username is not null;
alter table public.panel_lead_accesses add column login_username text;

create table private.panel_login_attempts (
  environment public.panel_environment not null,
  key_hash text not null,
  started_at timestamptz not null default now(),
  attempts integer not null default 1,
  primary key(environment,key_hash)
);
alter table private.panel_login_attempts enable row level security;
revoke all on private.panel_login_attempts from public,anon,authenticated;
grant usage on schema private to service_role;
grant select,insert,update,delete on private.panel_login_attempts to service_role;
create policy panel_login_attempts_server_only on private.panel_login_attempts to service_role using(true) with check(true);
create function public.panel_login_allow(p_environment public.panel_environment,p_key text) returns boolean
language plpgsql security invoker set search_path='' as $$
declare n integer;
begin
  delete from private.panel_login_attempts where started_at < now()-interval '1 day';
  insert into private.panel_login_attempts as a(environment,key_hash) values(p_environment,p_key)
  on conflict(environment,key_hash) do update set
    attempts=case when a.started_at < now()-interval '5 minutes' then 1 else a.attempts+1 end,
    started_at=case when a.started_at < now()-interval '5 minutes' then now() else a.started_at end
  returning attempts into n;
  return n<=30;
end;
$$;
revoke all on function public.panel_login_allow(public.panel_environment,text) from public,anon,authenticated;
grant execute on function public.panel_login_allow(public.panel_environment,text) to service_role;
