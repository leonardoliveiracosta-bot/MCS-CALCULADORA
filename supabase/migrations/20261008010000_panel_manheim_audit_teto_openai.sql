-- Teto único da OpenAI (US$ 50 por ambiente, somando PESQUISAS, testes de modelo, triagem da
-- ENTRADA, conferência Manheim e leitura do CSV Manheim) e conferência Manheim sem o limite de
-- US$ 2 por importação.
--
--  * openai_budget_holds: toda chamada paga reserva antes o custo máximo possível (entrada limitada
--    pelos bytes enviados, saída por max_completion_tokens). ABERTA conta pelo valor reservado; PAGA
--    (respondida, custo ainda não gravado na tabela da função) conta pelo custo real; REGISTRADA (o
--    custo já está na tabela da função) e LIBERADA (a OpenAI recusou, nada cobrado) não contam.
--    Tempo esgotado ou falha de rede: PAGA pelo valor reservado (pode ter sido cobrado).
--  * panel_openai_spent_usd: gasto já gravado nas tabelas das funções (as mesmas fontes de
--    panel-openai-budget.js).
--  * panel_openai_budget_hold: sob uma trava do ambiente, só reserva se gasto gravado + reservas que
--    contam + esta reserva couber em US$ 50. Chamadas concorrentes de qualquer função passam uma a
--    uma por essa trava.
--  * panel_openai_budget_settle: ABERTA -> PAGA ou LIBERADA; PAGA -> REGISTRADA. Nunca volta.
--  * panel_manheim_audit_budget_hold: só o limite do lote (US$ 50, sem least(..., 2)); o teto
--    global fica com a reserva de cada chamada.
--  * panel_manheim_batch_demand_options: opções do lote ativo só das pessoas pedidas, num único
--    valor jsonb (o PostgREST corta resultados em linhas a 1000; a conferência lia só as 6 primeiras
--    de 349 demandas).
--  * ai_task_claims aceita PESQUISAS: uma conversa é lida uma vez mesmo com cron e botão juntos.
--  * Lotes não autorizados com limite abaixo de US$ 50 passam a US$ 50 (um lote que só esperava
--    autorização por causa do limite antigo volta a ABERTO). Nada é apagado: gasto, estimativa,
--    reservas e conferências ficam como estão, e a troca fica registrada no audit_log.

alter table public.manheim_audit_runs alter column limit_usd set default 50;

-- PESQUISAS also reserves each conversation before paying (cron and button at the same time read it
-- once).
alter table public.ai_task_claims drop constraint if exists ai_task_claims_task_kind_check;
alter table public.ai_task_claims add constraint ai_task_claims_task_kind_check
  check (task_kind in ('ENTRADA_TRIAGE', 'MANHEIM_MATCH_AUDIT', 'PESQUISAS'));

create table if not exists public.openai_budget_holds (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  feature text not null check (feature in ('PESQUISAS', 'MODELO_TESTE', 'ENTRADA', 'MANHEIM_AUDIT', 'MANHEIM_CSV')),
  subject text not null check (char_length(subject) between 1 and 200),
  model text check (model is null or char_length(model) <= 60),
  amount_usd numeric(12, 6) not null check (amount_usd > 0),
  actual_usd numeric(12, 6) check (actual_usd is null or actual_usd >= 0),
  status text not null default 'ABERTA' check (status in ('ABERTA', 'PAGA', 'REGISTRADA', 'LIBERADA')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  recorded_at timestamptz,
  check ((status = 'ABERTA') = (actual_usd is null))
);
create index if not exists openai_budget_holds_counting
  on public.openai_budget_holds (environment) where status in ('ABERTA', 'PAGA');
alter table public.openai_budget_holds enable row level security;
alter table public.openai_budget_holds force row level security;
revoke all on table public.openai_budget_holds from public, anon, authenticated;
grant select on table public.openai_budget_holds to service_role;
create or replace function public.panel_openai_spent_usd(p_environment public.panel_environment)
returns numeric language sql stable security definer set search_path = public as $$
  select round((
      coalesce((select sum(cost_usd) from public.vehicle_request_runs
                 where environment = p_environment and provider = 'OPENAI'), 0)
    + coalesce((select sum(cost_usd) from public.vehicle_request_batches
                 where environment = p_environment and provider = 'OPENAI' and conversations = 0), 0)
    + coalesce((select sum(cost_usd) from public.conversation_triage where environment = p_environment), 0)
    + coalesce((select sum(cost_usd) from public.manheim_match_audits where environment = p_environment), 0)
    + coalesce((select sum((after_json->>'costUsd')::numeric) from public.audit_log
                 where environment = p_environment and entity_type = 'manheim_openai'
                   and jsonb_typeof(after_json->'costUsd') = 'number'), 0)
  )::numeric, 6)
$$;
revoke all on function public.panel_openai_spent_usd(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_openai_spent_usd(public.panel_environment) to service_role;

create or replace function public.panel_openai_budget_state(p_environment public.panel_environment)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('limit', 50, 'spent', x.spent, 'held', x.held, 'projected', x.spent + x.held,
                            'remaining', greatest(50 - x.spent - x.held, 0))
    from (select public.panel_openai_spent_usd(p_environment) spent,
                 coalesce((select sum(case when status = 'ABERTA' then amount_usd else actual_usd end)
                             from public.openai_budget_holds
                            where environment = p_environment and status in ('ABERTA', 'PAGA')), 0) held) x
$$;
revoke all on function public.panel_openai_budget_state(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_openai_budget_state(public.panel_environment) to service_role;

create or replace function public.panel_openai_budget_hold(
  p_environment public.panel_environment,
  p_feature text,
  p_subject text,
  p_model text,
  p_amount numeric
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_limit constant numeric := 50;
  v_state jsonb;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'OPENAI_HOLD_AMOUNT_INVALID'; end if;
  -- Every OpenAI call of the environment, of any feature, passes here one at a time.
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':openai-budget', 0));
  v_state := public.panel_openai_budget_state(p_environment);
  if (v_state->>'projected')::numeric + p_amount > c_limit then
    return jsonb_build_object('held', false, 'reason', 'OPENAI_LIMIT', 'limit', c_limit,
      'projected', (v_state->>'projected')::numeric, 'remaining', (v_state->>'remaining')::numeric);
  end if;
  insert into public.openai_budget_holds (environment, feature, subject, model, amount_usd)
  values (p_environment, p_feature, left(coalesce(nullif(p_subject, ''), '-'), 200), left(p_model, 60), p_amount)
  returning id into v_id;
  return jsonb_build_object('held', true, 'id', v_id, 'limit', c_limit,
    'projected', (v_state->>'projected')::numeric + p_amount,
    'remaining', c_limit - (v_state->>'projected')::numeric - p_amount);
end $$;
revoke all on function public.panel_openai_budget_hold(public.panel_environment, text, text, text, numeric) from public, anon, authenticated;
grant execute on function public.panel_openai_budget_hold(public.panel_environment, text, text, text, numeric) to service_role;

create or replace function public.panel_openai_budget_settle(
  p_environment public.panel_environment,
  p_id uuid,
  p_status text,
  p_actual numeric default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if p_status = 'PAGA' then
    if p_actual is null or p_actual < 0 then raise exception 'OPENAI_SETTLE_INVALID'; end if;
    update public.openai_budget_holds set status = 'PAGA', actual_usd = round(p_actual, 6), paid_at = now()
     where id = p_id and environment = p_environment and status = 'ABERTA';
  elsif p_status = 'LIBERADA' then
    update public.openai_budget_holds set status = 'LIBERADA', actual_usd = 0, paid_at = now()
     where id = p_id and environment = p_environment and status = 'ABERTA';
  elsif p_status = 'REGISTRADA' then
    update public.openai_budget_holds set status = 'REGISTRADA', recorded_at = now()
     where id = p_id and environment = p_environment and status = 'PAGA';
  else
    raise exception 'OPENAI_SETTLE_INVALID';
  end if;
  get diagnostics v_count = row_count;
  return jsonb_build_object('settled', v_count = 1);
end $$;
revoke all on function public.panel_openai_budget_settle(public.panel_environment, uuid, text, numeric) from public, anon, authenticated;
grant execute on function public.panel_openai_budget_settle(public.panel_environment, uuid, text, numeric) to service_role;

-- Batch limit only (US$ 50, never above; p_base_limit can only lower it, an old authorization
-- never does). The OpenAI ceiling is held per call in panel_openai_budget_hold.
create or replace function public.panel_manheim_audit_budget_hold(
  p_environment public.panel_environment,
  p_upload_id uuid,
  p_demand_key text,
  p_amount numeric,
  p_base_limit numeric default 50
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c_openai_limit constant numeric := 50;
  v_run public.manheim_audit_runs%rowtype;
  v_limit numeric;
  v_spent numeric;
  v_held numeric;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'AUDIT_HOLD_AMOUNT_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':audit-budget:' || p_upload_id::text, 0));
  select * into v_run from public.manheim_audit_runs where environment = p_environment and upload_id = p_upload_id for update;
  if not found then
    insert into public.manheim_audit_runs (environment, upload_id, status, estimate_usd, limit_usd, spent_usd)
    values (p_environment, p_upload_id, 'ABERTO', 0, c_openai_limit, 0) returning * into v_run;
  end if;
  v_limit := least(greatest(case when v_run.status = 'AUTORIZADO' then v_run.limit_usd else 0 end,
                            least(coalesce(p_base_limit, c_openai_limit), c_openai_limit)), c_openai_limit);
  select coalesce(sum(cost_usd), 0) into v_spent from public.manheim_match_audits where environment = p_environment and upload_id = p_upload_id;
  select coalesce(sum(amount_usd), 0) into v_held from public.manheim_audit_budget_holds
    where environment = p_environment and upload_id = p_upload_id and status = 'ABERTA' and expires_at > now();
  if v_spent + v_held + p_amount > v_limit then
    -- The shown estimate stays the one computed by the caller (never the safety hold).
    update public.manheim_audit_runs set status = 'AGUARDANDO_AUTORIZACAO', authorized_by = null, authorized_at = null, updated_at = now() where id = v_run.id;
    return jsonb_build_object('held', false, 'reason', 'LOT_LIMIT', 'remaining', greatest(v_limit - v_spent - v_held, 0), 'limit', v_limit);
  end if;
  insert into public.manheim_audit_budget_holds (environment, upload_id, demand_key, amount_usd, expires_at)
  values (p_environment, p_upload_id, p_demand_key, p_amount, now() + interval '10 minutes') returning id into v_id;
  return jsonb_build_object('held', true, 'id', v_id, 'limit', v_limit, 'remaining', v_limit - v_spent - v_held - p_amount);
end $$;

revoke all on function public.panel_manheim_audit_budget_hold(public.panel_environment, uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.panel_manheim_audit_budget_hold(public.panel_environment, uuid, text, numeric, numeric) to service_role;

-- The options of the active batch for some people only (the demands with cars selected for the
-- customer), in the order of panel_manheim_batch_top_options, as one jsonb value: never cut at the
-- PostgREST row limit.
create or replace function public.panel_manheim_batch_demand_options(
  p_environment public.panel_environment,
  p_upload_id uuid,
  p_journey_ids uuid[],
  p_refs text[],
  p_per_demand integer
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x.m) order by x.key, x.position), '[]'::jsonb)
    from (
      select m, coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as key,
             row_number() over (partition by coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, ''))
                                order by coalesce(m.sort_rank::integer, case m.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end), coalesce(m.sort_miles, case when m.vehicle_json #>> '{parsed,miles}' ~ '^[0-9]{1,9}$' then (m.vehicle_json #>> '{parsed,miles}')::integer else 2147483647 end), m.id) as position
        from public.manheim_matches m
       where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
         and (m.journey_id = any(coalesce(p_journey_ids, '{}'::uuid[])) or trim(m.calc_ref::text) = any(coalesce(p_refs, '{}'::text[])))
         and coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
    ) x
   where x.position <= least(greatest(coalesce(p_per_demand, 10), 1), 2000);
$$;
revoke all on function public.panel_manheim_batch_demand_options(public.panel_environment, uuid, uuid[], text[], integer) from public, anon, authenticated;
grant execute on function public.panel_manheim_batch_demand_options(public.panel_environment, uuid, uuid[], text[], integer) to service_role;

-- Existing batches: the limit shown and used becomes US$ 50. Only limit_usd changes; the old value
-- stays in the audit_log.
with changed as (
  select id, environment, limit_usd, status from public.manheim_audit_runs
   where status <> 'AUTORIZADO' and limit_usd < 50
   for update
), updated as (
  -- A batch waiting for authorization only because of the old limit goes back to ABERTO.
  update public.manheim_audit_runs r set limit_usd = 50,
         status = case when r.status = 'AGUARDANDO_AUTORIZACAO' then 'ABERTO' else r.status end, updated_at = now()
    from changed c where r.id = c.id
  returning r.id, r.status
)
insert into public.audit_log (environment, actor_user_id, entity_type, entity_id, action, before_json, after_json)
select c.environment, null, 'manheim_audit_run', c.id, 'OPENAI_LIMIT_SYNC',
       jsonb_build_object('limit_usd', c.limit_usd, 'status', c.status), jsonb_build_object('limit_usd', 50, 'status', u.status)
  from changed c join updated u on u.id = c.id;
