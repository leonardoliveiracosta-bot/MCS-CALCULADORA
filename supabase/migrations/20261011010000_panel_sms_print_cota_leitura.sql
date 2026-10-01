-- Leitura de print de SMS com cota diária própria.
-- Antes, o print disputava as 100 chamadas diárias de public.panel_ai_reserve_call com a rotina automática que lê
-- conversas (ai-cron, a cada 10 min). A rotina esgotava a cota todo dia e todo print enviado depois falhava com
-- AI_DAILY_LIMIT. A rotina e a cota dela não mudam: o print passa a contar só aqui.
create table if not exists public.sms_print_ai_daily_usage (
  environment public.panel_environment not null,
  day_et date not null,
  call_count integer not null default 0 check (call_count between 0 and 300),
  updated_at timestamptz not null default now(),
  primary key(environment,day_et)
);
alter table public.sms_print_ai_daily_usage enable row level security;
alter table public.sms_print_ai_daily_usage force row level security;
revoke all on public.sms_print_ai_daily_usage from public,anon,authenticated;
grant select,insert,update,delete on public.sms_print_ai_daily_usage to service_role;

create or replace function public.panel_sms_print_reserve_read(p_environment public.panel_environment)
returns jsonb language plpgsql security definer set search_path=public as $$
declare usage_day date := (clock_timestamp() at time zone 'America/New_York')::date; current_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('sms-print-ai:'||p_environment::text||':'||usage_day::text));
  insert into public.sms_print_ai_daily_usage(environment,day_et,call_count,updated_at)
    values(p_environment,usage_day,0,clock_timestamp()) on conflict do nothing;
  select u.call_count into current_count from public.sms_print_ai_daily_usage u
    where u.environment=p_environment and u.day_et=usage_day for update;
  if current_count >= 300 then return jsonb_build_object('allowed',false,'count',current_count,'day',usage_day); end if;
  update public.sms_print_ai_daily_usage u set call_count=u.call_count+1,updated_at=clock_timestamp()
    where u.environment=p_environment and u.day_et=usage_day returning u.call_count into current_count;
  return jsonb_build_object('allowed',true,'count',current_count,'day',usage_day);
end $$;
revoke all on function public.panel_sms_print_reserve_read(public.panel_environment) from public,anon,authenticated;
grant execute on function public.panel_sms_print_reserve_read(public.panel_environment) to service_role;
