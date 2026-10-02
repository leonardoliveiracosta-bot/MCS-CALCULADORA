-- IA (OpenAI e Claude) pelo saldo pré-pago de cada provedor, sem tetos internos.
--
-- Antes: US$ 50 somando tudo da OpenAI, limite por lote na conferência Manheim (com "aguardando
-- autorização"), US$ 20 + "Liberar mais US$ 10" na leitura geral (Claude) e cotas diárias de
-- chamadas (Claude 1000/2000 por dia, print de SMS 2000 por dia).
-- Agora: nenhum desses tetos. Cada provedor tem o saldo pré-pago informado no painel (o mesmo
-- que aparece no console do provedor; nenhum dos dois expõe o saldo por API). Toda chamada paga
-- reserva o pior caso antes de sair e só sai se couber no que resta desse saldo; o aviso aparece
-- quando restam 20% ou menos. Quando o provedor responde "sem saldo", aquele provedor para até um
-- novo saldo ser informado. Sem saldo informado, o limite é o próprio pré-pago do provedor.
-- Continua igual: a reserva por chamada (uma por vez, sob trava), a liquidação pelo custo real e
-- as travas contra leitura repetida (ai_task_claims, progresso da leitura geral, cache).
-- Aditiva: duas tabelas novas, funções novas e funções existentes redefinidas. Nenhum dado apagado.

create table if not exists public.ai_provider_balances (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  provider text not null check (provider in ('OPENAI', 'ANTHROPIC')),
  balance_usd numeric(12, 2) not null check (balance_usd >= 0),
  set_at timestamptz not null default now(),
  set_by uuid references public.panel_users(id)
);
create index if not exists ai_provider_balances_latest on public.ai_provider_balances (environment, provider, set_at desc);
alter table public.ai_provider_balances enable row level security;
alter table public.ai_provider_balances force row level security;
revoke all on table public.ai_provider_balances from public, anon, authenticated;
grant select, insert on table public.ai_provider_balances to service_role;

-- "Sem saldo" dito pelo próprio provedor (vale até o próximo saldo informado).
create table if not exists public.ai_provider_exhausted (
  environment public.panel_environment not null,
  provider text not null check (provider in ('OPENAI', 'ANTHROPIC')),
  exhausted_at timestamptz not null default now(),
  reason text,
  primary key (environment, provider)
);
alter table public.ai_provider_exhausted enable row level security;
alter table public.ai_provider_exhausted force row level security;
revoke all on table public.ai_provider_exhausted from public, anon, authenticated;
grant select, insert, update on table public.ai_provider_exhausted to service_role;

-- Reservas do Claude, iguais às da OpenAI (ABERTA -> PAGA ou LIBERADA; PAGA -> REGISTRADA).
create table if not exists public.anthropic_budget_holds (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  feature text not null check (char_length(feature) between 1 and 40),
  subject text not null check (char_length(subject) between 1 and 200),
  model text check (model is null or char_length(model) <= 80),
  amount_usd numeric(12, 6) not null check (amount_usd > 0),
  actual_usd numeric(12, 6) check (actual_usd is null or actual_usd >= 0),
  status text not null default 'ABERTA' check (status in ('ABERTA', 'PAGA', 'REGISTRADA', 'LIBERADA')),
  created_at timestamptz not null default clock_timestamp(),
  paid_at timestamptz,
  recorded_at timestamptz,
  check ((status = 'ABERTA') = (actual_usd is null))
);
create index if not exists anthropic_budget_holds_env_created on public.anthropic_budget_holds (environment, created_at);
alter table public.anthropic_budget_holds enable row level security;
alter table public.anthropic_budget_holds force row level security;
revoke all on table public.anthropic_budget_holds from public, anon, authenticated;
grant select on table public.anthropic_budget_holds to service_role;
create index if not exists openai_budget_holds_env_created on public.openai_budget_holds (environment, created_at);
-- The real moment of the reservation ("spent since the balance was informed" compares with it).
alter table public.openai_budget_holds alter column created_at set default clock_timestamp();

-- Gasto de um provedor desde um momento: reservas abertas pelo pior caso, pagas pelo custo real.
create or replace function public.panel_ai_spent_since(p_environment public.panel_environment, p_provider text, p_since timestamptz)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(case p_provider
    when 'OPENAI' then (select sum(case when status = 'ABERTA' then amount_usd else actual_usd end) from public.openai_budget_holds
                         where environment = p_environment and status <> 'LIBERADA' and created_at >= coalesce(p_since, '-infinity'::timestamptz))
    when 'ANTHROPIC' then (select sum(case when status = 'ABERTA' then amount_usd else actual_usd end) from public.anthropic_budget_holds
                         where environment = p_environment and status <> 'LIBERADA' and created_at >= coalesce(p_since, '-infinity'::timestamptz))
  end, 0)::numeric, 6)
$$;

create or replace function public.panel_ai_balance_state(p_environment public.panel_environment, p_provider text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_balance public.ai_provider_balances%rowtype;
  v_out public.ai_provider_exhausted%rowtype;
  v_spent numeric;
  v_remaining numeric;
  v_exhausted boolean;
begin
  if p_provider not in ('OPENAI', 'ANTHROPIC') then raise exception 'AI_PROVIDER_INVALID'; end if;
  select * into v_balance from public.ai_provider_balances where environment = p_environment and provider = p_provider order by set_at desc limit 1;
  select * into v_out from public.ai_provider_exhausted where environment = p_environment and provider = p_provider;
  v_exhausted := v_out.exhausted_at is not null and (v_balance.set_at is null or v_out.exhausted_at > v_balance.set_at);
  if v_balance.id is null then
    -- Sem saldo informado: mostra o gasto dos últimos 30 dias; o limite é o pré-pago do provedor.
    v_spent := public.panel_ai_spent_since(p_environment, p_provider, now() - interval '30 days');
    return jsonb_build_object('provider', p_provider, 'balance', null, 'setAt', null, 'spent', v_spent, 'remaining', null,
      'warn', v_exhausted, 'exhausted', v_exhausted, 'exhaustedAt', v_out.exhausted_at, 'informed', false);
  end if;
  v_spent := public.panel_ai_spent_since(p_environment, p_provider, v_balance.set_at);
  v_remaining := greatest(v_balance.balance_usd - v_spent, 0);
  return jsonb_build_object('provider', p_provider, 'balance', v_balance.balance_usd, 'setAt', v_balance.set_at, 'spent', v_spent,
    'remaining', round(v_remaining, 6), 'warn', v_exhausted or v_remaining <= v_balance.balance_usd * 0.2,
    'exhausted', v_exhausted or v_remaining <= 0, 'exhaustedAt', v_out.exhausted_at, 'informed', true);
end $$;

create or replace function public.panel_ai_set_balance(p_environment public.panel_environment, p_provider text, p_balance numeric, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_provider not in ('OPENAI', 'ANTHROPIC') then raise exception 'AI_PROVIDER_INVALID'; end if;
  if p_balance is null or p_balance < 0 or p_balance > 100000 then raise exception 'AI_BALANCE_INVALID'; end if;
  insert into public.ai_provider_balances (environment, provider, balance_usd, set_at, set_by) values (p_environment, p_provider, round(p_balance, 2), clock_timestamp(), p_actor);
  return public.panel_ai_balance_state(p_environment, p_provider);
end $$;

create or replace function public.panel_ai_mark_exhausted(p_environment public.panel_environment, p_provider text, p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_provider not in ('OPENAI', 'ANTHROPIC') then raise exception 'AI_PROVIDER_INVALID'; end if;
  insert into public.ai_provider_exhausted (environment, provider, exhausted_at, reason) values (p_environment, p_provider, clock_timestamp(), left(p_reason, 200))
    on conflict (environment, provider) do update set exhausted_at = excluded.exhausted_at, reason = excluded.reason;
  return public.panel_ai_balance_state(p_environment, p_provider);
end $$;

-- Reserva genérica sob a trava do provedor: só reserva se couber no saldo que resta.
create or replace function public.panel_ai_provider_hold_allowed(p_environment public.panel_environment, p_provider text, p_amount numeric)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_state jsonb;
begin
  v_state := public.panel_ai_balance_state(p_environment, p_provider);
  if coalesce((v_state->>'exhausted')::boolean, false) then
    return jsonb_build_object('held', false, 'reason', 'SALDO_ESGOTADO', 'state', v_state);
  end if;
  if (v_state->>'remaining') is not null and p_amount > (v_state->>'remaining')::numeric then
    return jsonb_build_object('held', false, 'reason', 'SALDO_INSUFICIENTE', 'state', v_state);
  end if;
  return jsonb_build_object('held', true, 'state', v_state);
end $$;

-- OpenAI: mesmo contrato de antes (limit, spent, held, projected, remaining), agora pelo saldo.
create or replace function public.panel_openai_budget_state(p_environment public.panel_environment)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_state jsonb := public.panel_ai_balance_state(p_environment, 'OPENAI');
begin
  return v_state || jsonb_build_object('limit', v_state->'balance', 'held', 0, 'projected', v_state->'spent');
end $$;

create or replace function public.panel_openai_budget_hold(
  p_environment public.panel_environment,
  p_feature text,
  p_subject text,
  p_model text,
  p_amount numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_check jsonb;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'OPENAI_HOLD_AMOUNT_INVALID'; end if;
  -- Every OpenAI call of the environment, of any feature, passes here one at a time.
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':openai-budget', 0));
  v_check := public.panel_ai_provider_hold_allowed(p_environment, 'OPENAI', p_amount);
  if not (v_check->>'held')::boolean then
    return jsonb_build_object('held', false, 'reason', v_check->>'reason', 'remaining', v_check#>'{state,remaining}', 'limit', v_check#>'{state,balance}');
  end if;
  insert into public.openai_budget_holds (environment, feature, subject, model, amount_usd)
  values (p_environment, p_feature, left(coalesce(nullif(p_subject, ''), '-'), 200), left(p_model, 60), p_amount)
  returning id into v_id;
  return jsonb_build_object('held', true, 'id', v_id, 'limit', v_check#>'{state,balance}', 'remaining', v_check#>'{state,remaining}');
end $$;

create or replace function public.panel_anthropic_budget_hold(
  p_environment public.panel_environment,
  p_feature text,
  p_subject text,
  p_model text,
  p_amount numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_check jsonb;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'ANTHROPIC_HOLD_AMOUNT_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':anthropic-budget', 0));
  v_check := public.panel_ai_provider_hold_allowed(p_environment, 'ANTHROPIC', p_amount);
  if not (v_check->>'held')::boolean then
    return jsonb_build_object('held', false, 'reason', v_check->>'reason', 'remaining', v_check#>'{state,remaining}', 'limit', v_check#>'{state,balance}');
  end if;
  insert into public.anthropic_budget_holds (environment, feature, subject, model, amount_usd)
  values (p_environment, left(coalesce(nullif(p_feature, ''), 'CLAUDE'), 40), left(coalesce(nullif(p_subject, ''), '-'), 200), left(p_model, 80), p_amount)
  returning id into v_id;
  return jsonb_build_object('held', true, 'id', v_id, 'limit', v_check#>'{state,balance}', 'remaining', v_check#>'{state,remaining}');
end $$;

create or replace function public.panel_anthropic_budget_settle(
  p_environment public.panel_environment,
  p_id uuid,
  p_status text,
  p_actual numeric default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  if p_status = 'PAGA' then
    if p_actual is null or p_actual < 0 then raise exception 'ANTHROPIC_SETTLE_INVALID'; end if;
    update public.anthropic_budget_holds set status = 'PAGA', actual_usd = round(p_actual, 6), paid_at = now()
     where id = p_id and environment = p_environment and status = 'ABERTA';
  elsif p_status = 'LIBERADA' then
    update public.anthropic_budget_holds set status = 'LIBERADA', actual_usd = 0, paid_at = now()
     where id = p_id and environment = p_environment and status = 'ABERTA';
  else
    raise exception 'ANTHROPIC_SETTLE_INVALID';
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('settled', v_count = 1);
end $$;

-- Conferência Manheim: sem limite por lote e sem "aguardando autorização". A reserva do lote
-- continua (10 minutos) para chamadas concorrentes do mesmo lote; o saldo é conferido por chamada.
create or replace function public.panel_manheim_audit_budget_hold(
  p_environment public.panel_environment,
  p_upload_id uuid,
  p_demand_key text,
  p_amount numeric,
  p_base_limit numeric default 50
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_run public.manheim_audit_runs%rowtype;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'AUDIT_HOLD_AMOUNT_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':audit-budget:' || p_upload_id::text, 0));
  select * into v_run from public.manheim_audit_runs where environment = p_environment and upload_id = p_upload_id for update;
  if not found then
    insert into public.manheim_audit_runs (environment, upload_id, status, estimate_usd, spent_usd)
    values (p_environment, p_upload_id, 'ABERTO', 0, 0) returning * into v_run;
  elsif v_run.status = 'AGUARDANDO_AUTORIZACAO' then
    update public.manheim_audit_runs set status = 'ABERTO', updated_at = now() where id = v_run.id;
  end if;
  insert into public.manheim_audit_budget_holds (environment, upload_id, demand_key, amount_usd, expires_at)
  values (p_environment, p_upload_id, p_demand_key, p_amount, now() + interval '10 minutes') returning id into v_id;
  return jsonb_build_object('held', true, 'id', v_id, 'limit', null, 'remaining', null);
end $$;

-- Cotas diárias de chamadas do Claude: continuam contando (histórico), nunca recusam.
create or replace function public.panel_ai_reserve_call(p_environment public.panel_environment, p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare usage_day date := (clock_timestamp() at time zone 'America/New_York')::date; current_count integer;
begin
  if p_kind not in ('ROTINA', 'MANUAL') then raise exception 'AI_KIND_INVALID'; end if;
  insert into public.panel_ai_daily_usage_kind (environment, day_et, kind, call_count, updated_at)
    values (p_environment, usage_day, p_kind, 1, clock_timestamp())
    on conflict (environment, day_et, kind) do update set call_count = public.panel_ai_daily_usage_kind.call_count + 1, updated_at = clock_timestamp()
    returning call_count into current_count;
  return jsonb_build_object('allowed', true, 'count', current_count, 'limit', null, 'kind', p_kind, 'day', usage_day);
end $$;

create or replace function public.panel_sms_print_reserve_read(p_environment public.panel_environment)
returns jsonb language plpgsql security definer set search_path = public as $$
declare usage_day date := (clock_timestamp() at time zone 'America/New_York')::date; current_count integer;
begin
  insert into public.sms_print_ai_daily_usage (environment, day_et, call_count, updated_at)
    values (p_environment, usage_day, 1, clock_timestamp())
    on conflict (environment, day_et) do update set call_count = public.sms_print_ai_daily_usage.call_count + 1, updated_at = clock_timestamp()
    returning call_count into current_count;
  return jsonb_build_object('allowed', true, 'count', current_count, 'day', usage_day);
end $$;

-- Leitura geral (Claude): sem orçamento próprio por rodada. Cada conversa ainda reserva o pior
-- caso (o saldo do provedor é conferido por chamada, no painel); a rodada não para por US$ 20.
create or replace function public.panel_pending_claim_general_read(p_environment public.panel_environment, p_reserve_usd numeric)
returns table(journey_id uuid, chat_id uuid, message_count integer, snapshot_last_message_id uuid, next_message_index integer, accumulated_summary text, reserved_usd numeric)
language plpgsql security definer set search_path = public as $$
declare run public.conversation_general_read_runs%rowtype; progress public.conversation_general_read_progress%rowtype;
begin
  if p_reserve_usd <= 0 or p_reserve_usd > 2 then raise exception 'PENDING_RESERVE_INVALID'; end if;
  select * into run from public.conversation_general_read_runs where environment = p_environment for update;
  if not found or run.status not in ('ACTIVE', 'LIMIT') then return; end if;
  if run.status = 'LIMIT' then
    update public.conversation_general_read_runs set status = 'ACTIVE', updated_at = clock_timestamp() where environment = p_environment;
  end if;
  select * into progress from public.conversation_general_read_progress p
    where p.environment = p_environment and (p.status = 'PENDING' or (p.status = 'PROCESSING' and p.processing_started_at < clock_timestamp() - interval '2 minutes'))
    order by p.updated_at, p.journey_id, p.chat_id for update skip locked limit 1;
  if not found then
    if exists (select 1 from public.conversation_general_read_progress p where p.environment = p_environment and p.status = 'PROCESSING') then
      return;
    end if;
    update public.conversation_general_read_runs set status = 'COMPLETED', completed_conversations = (select count(*) from public.conversation_general_read_progress where environment = p_environment and status = 'COMPLETED'), updated_at = clock_timestamp() where environment = p_environment;
    return;
  end if;
  update public.conversation_general_read_progress p set status = 'PROCESSING', processing_started_at = clock_timestamp(), attempts = p.attempts + 1, updated_at = clock_timestamp()
    where p.environment = p_environment and p.journey_id = progress.journey_id and p.chat_id = progress.chat_id;
  update public.conversation_general_read_runs r set reserved_usd = r.reserved_usd + p_reserve_usd, updated_at = clock_timestamp() where r.environment = p_environment;
  return query select progress.journey_id, progress.chat_id, progress.message_count, progress.snapshot_last_message_id, progress.next_message_index, progress.accumulated_summary, p_reserve_usd;
end $$;

create or replace function public.panel_pending_finish_general_read(
  p_environment public.panel_environment, p_journey uuid, p_chat uuid, p_next integer, p_summary text, p_completed boolean,
  p_situation text default null, p_heat text default null, p_final_summary text default null, p_next_step text default null, p_translation text default null,
  p_last_message uuid default null, p_actual_usd numeric default 0, p_reserved_usd numeric default 0, p_error text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare completed integer;
begin
  perform pg_advisory_xact_lock(hashtext('pending-general:' || p_environment::text));
  if p_actual_usd < 0 or p_reserved_usd < 0 or p_actual_usd > p_reserved_usd then raise exception 'PENDING_COST_INVALID'; end if;
  update public.conversation_general_read_progress p set
    next_message_index = greatest(p.next_message_index, p_next), accumulated_summary = left(coalesce(p_summary, ''), 12000),
    status = case when p_error is not null then 'PENDING' when p_completed then 'COMPLETED' else 'PENDING' end,
    processing_started_at = null, last_error = case when p_error is null then null else left(p_error, 180) end, updated_at = clock_timestamp()
    where p.environment = p_environment and p.journey_id = p_journey and p.chat_id = p_chat and p.status = 'PROCESSING';
  if not found then raise exception 'PENDING_CLAIM_LOST'; end if;
  update public.conversation_general_read_runs r set reserved_usd = greatest(0, r.reserved_usd - p_reserved_usd), spent_usd = r.spent_usd + p_actual_usd, updated_at = clock_timestamp()
    where r.environment = p_environment;
  if p_completed and p_error is null then
    if p_situation not in ('MCS_PENDING', 'CUSTOMER_PENDING', 'IN_PROGRESS', 'CLOSED', 'UNKNOWN') or p_heat not in ('HOT', 'WARM', 'COLD') then raise exception 'PENDING_INSIGHT_INVALID'; end if;
    insert into public.conversation_pending_insights (environment, journey_id, chat_id, situation, heat, summary_text, next_step_text, translation_text, last_ai_message_id, updated_at)
      values (p_environment, p_journey, p_chat, p_situation, p_heat, left(coalesce(p_final_summary, ''), 2000), left(coalesce(p_next_step, ''), 1000), nullif(left(coalesce(p_translation, ''), 2000), ''), p_last_message, clock_timestamp())
      on conflict (environment, journey_id, chat_id) do update set situation = excluded.situation, heat = excluded.heat, summary_text = excluded.summary_text, next_step_text = excluded.next_step_text, translation_text = excluded.translation_text, last_ai_message_id = excluded.last_ai_message_id, updated_at = excluded.updated_at;
  end if;
  select count(*) into completed from public.conversation_general_read_progress where environment = p_environment and status = 'COMPLETED';
  update public.conversation_general_read_runs r set completed_conversations = completed,
    status = case when p_error is not null then 'PAUSED' when completed >= r.total_conversations then 'COMPLETED' else r.status end,
    last_error = case when p_error is null then null else left(p_error, 180) end,
    updated_at = clock_timestamp() where r.environment = p_environment;
  return jsonb_build_object('completed', completed);
end $$;

-- A leitura geral parada pelo antigo teto de US$ 20 fica pausada (o botão Continuar volta a ler).
update public.conversation_general_read_runs set status = 'PAUSED', updated_at = now() where status = 'LIMIT';

revoke all on function public.panel_ai_spent_since(public.panel_environment, text, timestamptz) from public, anon, authenticated;
revoke all on function public.panel_ai_balance_state(public.panel_environment, text) from public, anon, authenticated;
revoke all on function public.panel_ai_set_balance(public.panel_environment, text, numeric, uuid) from public, anon, authenticated;
revoke all on function public.panel_ai_mark_exhausted(public.panel_environment, text, text) from public, anon, authenticated;
revoke all on function public.panel_ai_provider_hold_allowed(public.panel_environment, text, numeric) from public, anon, authenticated;
revoke all on function public.panel_anthropic_budget_hold(public.panel_environment, text, text, text, numeric) from public, anon, authenticated;
revoke all on function public.panel_anthropic_budget_settle(public.panel_environment, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.panel_ai_spent_since(public.panel_environment, text, timestamptz) to service_role;
grant execute on function public.panel_ai_balance_state(public.panel_environment, text) to service_role;
grant execute on function public.panel_ai_set_balance(public.panel_environment, text, numeric, uuid) to service_role;
grant execute on function public.panel_ai_mark_exhausted(public.panel_environment, text, text) to service_role;
grant execute on function public.panel_ai_provider_hold_allowed(public.panel_environment, text, numeric) to service_role;
grant execute on function public.panel_anthropic_budget_hold(public.panel_environment, text, text, text, numeric) to service_role;
grant execute on function public.panel_anthropic_budget_settle(public.panel_environment, uuid, text, numeric) to service_role;
