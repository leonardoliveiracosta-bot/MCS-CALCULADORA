-- Cotas diárias altas para a IA do painel (Claude), separando o que é manual do que é rotina.
-- Antes: 100 chamadas/dia compartilhadas entre a rotina automática (ai-cron) e os cliques do operador
-- ("Ler conversa agora", "Opinião da IA", distribuir nota). A rotina esgotava a cota e travava os cliques.
-- Agora: ROTINA 1000/dia e MANUAL 2000/dia, contadas em separado (dia de Nova York), e o print de SMS 2000/dia.
-- A função antiga panel_ai_reserve_call(p_environment) fica como está; o código passa a usar a versão com p_kind.
create table if not exists public.panel_ai_daily_usage_kind (
  environment public.panel_environment not null,
  day_et date not null,
  kind text not null check (kind in ('ROTINA','MANUAL')),
  call_count integer not null default 0 check (call_count >= 0),
  updated_at timestamptz not null default now(),
  primary key(environment,day_et,kind)
);
alter table public.panel_ai_daily_usage_kind enable row level security;
alter table public.panel_ai_daily_usage_kind force row level security;
revoke all on public.panel_ai_daily_usage_kind from public,anon,authenticated;
grant select,insert,update,delete on public.panel_ai_daily_usage_kind to service_role;

create or replace function public.panel_ai_reserve_call(p_environment public.panel_environment,p_kind text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare usage_day date := (clock_timestamp() at time zone 'America/New_York')::date; current_count integer;
  kind_limit integer := case p_kind when 'ROTINA' then 1000 when 'MANUAL' then 2000 end;
begin
  if kind_limit is null then raise exception 'AI_KIND_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('panel-ai:'||p_environment::text||':'||p_kind||':'||usage_day::text));
  insert into public.panel_ai_daily_usage_kind(environment,day_et,kind,call_count,updated_at)
    values(p_environment,usage_day,p_kind,0,clock_timestamp()) on conflict do nothing;
  select u.call_count into current_count from public.panel_ai_daily_usage_kind u
    where u.environment=p_environment and u.day_et=usage_day and u.kind=p_kind for update;
  if current_count >= kind_limit then return jsonb_build_object('allowed',false,'count',current_count,'limit',kind_limit,'kind',p_kind,'day',usage_day); end if;
  update public.panel_ai_daily_usage_kind u set call_count=u.call_count+1,updated_at=clock_timestamp()
    where u.environment=p_environment and u.day_et=usage_day and u.kind=p_kind returning u.call_count into current_count;
  return jsonb_build_object('allowed',true,'count',current_count,'limit',kind_limit,'kind',p_kind,'day',usage_day);
end $$;
revoke all on function public.panel_ai_reserve_call(public.panel_environment,text) from public,anon,authenticated;
grant execute on function public.panel_ai_reserve_call(public.panel_environment,text) to service_role;

-- Print de SMS: de 300 para 2000 por dia.
alter table public.sms_print_ai_daily_usage drop constraint if exists sms_print_ai_daily_usage_call_count_check;
alter table public.sms_print_ai_daily_usage add constraint sms_print_ai_daily_usage_call_count_check check (call_count >= 0);
create or replace function public.panel_sms_print_reserve_read(p_environment public.panel_environment)
returns jsonb language plpgsql security definer set search_path=public as $$
declare usage_day date := (clock_timestamp() at time zone 'America/New_York')::date; current_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('sms-print-ai:'||p_environment::text||':'||usage_day::text));
  insert into public.sms_print_ai_daily_usage(environment,day_et,call_count,updated_at)
    values(p_environment,usage_day,0,clock_timestamp()) on conflict do nothing;
  select u.call_count into current_count from public.sms_print_ai_daily_usage u
    where u.environment=p_environment and u.day_et=usage_day for update;
  if current_count >= 2000 then return jsonb_build_object('allowed',false,'count',current_count,'day',usage_day); end if;
  update public.sms_print_ai_daily_usage u set call_count=u.call_count+1,updated_at=clock_timestamp()
    where u.environment=p_environment and u.day_et=usage_day returning u.call_count into current_count;
  return jsonb_build_object('allowed',true,'count',current_count,'day',usage_day);
end $$;
revoke all on function public.panel_sms_print_reserve_read(public.panel_environment) from public,anon,authenticated;
grant execute on function public.panel_sms_print_reserve_read(public.panel_environment) to service_role;
