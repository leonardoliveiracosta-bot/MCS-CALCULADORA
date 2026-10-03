create table public.sms_device_tokens (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  device_name text not null check (char_length(device_name) between 1 and 120),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (revoked_at is null or revoked_at >= created_at)
);

create unique index sms_device_tokens_environment_token_hash_key
  on public.sms_device_tokens(environment, token_hash);

alter table public.sms_device_tokens enable row level security;
alter table public.sms_device_tokens force row level security;
revoke all on public.sms_device_tokens from public, anon, authenticated;
grant all on public.sms_device_tokens to service_role;

create or replace function public.panel_sms_device_token_generate(
  p_environment public.panel_environment,
  p_token_hash text,
  p_device_name text
)
returns table(id uuid, device_name text, created_at timestamptz, revoked_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_token_hash !~ '^[0-9a-f]{64}$'
    or char_length(trim(coalesce(p_device_name, ''))) not between 1 and 120 then
    raise exception 'SMS_DEVICE_TOKEN_INVALID';
  end if;

  update public.sms_device_tokens token
     set revoked_at = clock_timestamp()
   where token.environment = p_environment
     and token.revoked_at is null;

  return query
  insert into public.sms_device_tokens(environment, token_hash, device_name)
  values (p_environment, p_token_hash, trim(p_device_name))
  returning sms_device_tokens.id, sms_device_tokens.device_name,
            sms_device_tokens.created_at, sms_device_tokens.revoked_at;
end;
$$;

revoke all on function public.panel_sms_device_token_generate(public.panel_environment, text, text)
  from public, anon, authenticated;
grant execute on function public.panel_sms_device_token_generate(public.panel_environment, text, text)
  to service_role;
