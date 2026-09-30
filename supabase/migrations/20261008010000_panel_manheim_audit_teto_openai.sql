-- Conferência Manheim: o teto é o compartilhado da OpenAI (US$ 50 somando todas as funções), não
-- mais US$ 2 por importação.
--
--  * panel_openai_spent_usd: gasto real da OpenAI no ambiente, somando as mesmas fontes de
--    panel-openai-budget.js (PESQUISAS e testes de modelo, triagem da ENTRADA, conferência Manheim
--    e leitura do CSV Manheim).
--  * panel_manheim_audit_budget_hold: sob uma trava do ambiente, só reserva se gasto real + reservas
--    abertas de todos os lotes + esta reserva couber em US$ 50. O limite do lote passa a ser o mesmo
--    US$ 50 (p_base_limit ainda só pode baixá-lo; uma autorização antiga nunca o reduz). Quando o que
--    falta é o teto da OpenAI, o lote não vai para "aguardando autorização": autorizar não cria saldo.
--  * Lotes não autorizados com limite abaixo de US$ 50 passam a US$ 50 (um lote que só esperava
--    autorização por causa do limite antigo volta a ABERTO). Nada é apagado: gasto,
--    estimativa, reservas e conferências ficam como estão, e a troca fica registrada no audit_log.
--
-- Conferências PENDENTE com 3 tentativas continuam sem nova tentativa automática
-- (MAX_ATTEMPTS em panel-manheim-audit.js); só o botão "Tentar de novo" as repete.

alter table public.manheim_audit_runs alter column limit_usd set default 50;

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
  v_openai_spent numeric;
  v_openai_held numeric;
  v_id uuid;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'AUDIT_HOLD_AMOUNT_INVALID'; end if;
  -- One lock per environment first (every batch shares the OpenAI ceiling), then the batch lock.
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':openai-budget', 0));
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':audit-budget:' || p_upload_id::text, 0));
  select * into v_run from public.manheim_audit_runs where environment = p_environment and upload_id = p_upload_id for update;
  if not found then
    insert into public.manheim_audit_runs (environment, upload_id, status, estimate_usd, limit_usd, spent_usd)
    values (p_environment, p_upload_id, 'ABERTO', 0, c_openai_limit, 0) returning * into v_run;
  end if;
  v_limit := least(greatest(case when v_run.status = 'AUTORIZADO' then v_run.limit_usd else 0 end,
                            least(coalesce(p_base_limit, c_openai_limit), c_openai_limit)), c_openai_limit);
  v_openai_spent := public.panel_openai_spent_usd(p_environment);
  select coalesce(sum(amount_usd), 0) into v_openai_held from public.manheim_audit_budget_holds
    where environment = p_environment and status = 'ABERTA' and expires_at > now();
  if v_openai_spent + v_openai_held + p_amount > c_openai_limit then
    return jsonb_build_object('held', false, 'reason', 'OPENAI_LIMIT', 'limit', c_openai_limit,
      'remaining', greatest(c_openai_limit - v_openai_spent - v_openai_held, 0));
  end if;
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
  return jsonb_build_object('held', true, 'id', v_id, 'limit', v_limit,
    'remaining', least(v_limit - v_spent - v_held, c_openai_limit - v_openai_spent - v_openai_held) - p_amount);
end $$;

revoke all on function public.panel_manheim_audit_budget_hold(public.panel_environment, uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.panel_manheim_audit_budget_hold(public.panel_environment, uuid, text, numeric, numeric) to service_role;

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
