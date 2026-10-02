-- Claude: os US$ 50 depositados são o crédito pré-pago, separado da OpenAI. O gasto conta desde o
-- começo das reservas (anthropic_budget_holds) e o saldo nunca recomeça em US$ 50. O uso anterior
-- às reservas não tem custo registrado: ele aparece como desconhecido (número de chamadas e
-- período), nunca como zero, e o saldo mostrado passa a ser "no máximo". Quando o dono informa o
-- saldo do console, esse valor passa a valer a partir de então (como antes).
-- Aviso quando o gasto registrado chega a 80% do pré-pago. Nenhum limite por função; sem recarga.
-- Aditiva: só redefine panel_ai_balance_state (a OpenAI continua igual à 20261014050000).

create or replace function public.panel_ai_balance_state(p_environment public.panel_environment, p_provider text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c_openai_prepaid constant numeric := 50;
  c_claude_prepaid constant numeric := 50;
  v_balance public.ai_provider_balances%rowtype;
  v_out public.ai_provider_exhausted%rowtype;
  v_total numeric;
  v_spent numeric;
  v_remaining numeric;
  v_exhausted boolean;
  v_tracked_since timestamptz;
  v_tracked_day date;
  v_prior_calls bigint;
  v_prior_from date;
  v_prior_to date;
begin
  if p_provider not in ('OPENAI', 'ANTHROPIC') then raise exception 'AI_PROVIDER_INVALID'; end if;
  select * into v_balance from public.ai_provider_balances where environment = p_environment and provider = p_provider order by set_at desc limit 1;
  select * into v_out from public.ai_provider_exhausted where environment = p_environment and provider = p_provider;
  v_exhausted := v_out.exhausted_at is not null and (v_balance.set_at is null or v_out.exhausted_at > v_balance.set_at);
  if p_provider = 'OPENAI' then
    v_total := coalesce(v_balance.balance_usd, c_openai_prepaid);
    v_spent := round(public.panel_openai_spent_usd(p_environment)
      + coalesce((select sum(case when status = 'ABERTA' then amount_usd else actual_usd end) from public.openai_budget_holds
                   where environment = p_environment and status in ('ABERTA', 'PAGA')), 0), 6);
    v_remaining := greatest(v_total - v_spent, 0);
    return jsonb_build_object('provider', p_provider, 'balance', v_total, 'setAt', v_balance.set_at, 'spent', v_spent,
      'remaining', round(v_remaining, 6), 'warn', v_exhausted or v_spent >= v_total * 0.8, 'warnAt', round(v_total * 0.8, 2),
      'exhausted', v_exhausted or v_remaining <= 0, 'exhaustedAt', v_out.exhausted_at, 'informed', true, 'sinceStart', true);
  end if;
  if v_balance.id is not null then
    -- Saldo do console informado pelo dono: vale a partir de então (já desconta o uso anterior).
    v_spent := public.panel_ai_spent_since(p_environment, p_provider, v_balance.set_at);
    v_remaining := greatest(v_balance.balance_usd - v_spent, 0);
    return jsonb_build_object('provider', p_provider, 'balance', v_balance.balance_usd, 'setAt', v_balance.set_at, 'spent', v_spent,
      'remaining', round(v_remaining, 6), 'warn', v_exhausted or v_remaining <= v_balance.balance_usd * 0.2, 'warnAt', round(v_balance.balance_usd * 0.8, 2),
      'exhausted', v_exhausted or v_remaining <= 0, 'exhaustedAt', v_out.exhausted_at, 'informed', true, 'sinceStart', false, 'priorUnknown', false);
  end if;
  -- Pré-pago de US$ 50 desde o começo: todo gasto registrado (reservas) é descontado.
  v_spent := public.panel_ai_spent_since(p_environment, p_provider, null);
  v_remaining := greatest(c_claude_prepaid - v_spent, 0);
  select min(created_at) into v_tracked_since from public.anthropic_budget_holds where environment = p_environment;
  v_tracked_since := coalesce(v_tracked_since, now());
  v_tracked_day := (v_tracked_since at time zone 'America/New_York')::date;
  -- Chamadas do Claude contadas por dia antes das reservas: custo nunca registrado.
  select coalesce(sum(n), 0), min(d), max(d) into v_prior_calls, v_prior_from, v_prior_to from (
    select call_count::bigint n, day_et d from public.conversation_ai_daily_usage where environment = p_environment and day_et <= v_tracked_day
    union all select call_count::bigint, day_et from public.sms_print_ai_daily_usage where environment = p_environment and day_et <= v_tracked_day
    union all select call_count::bigint, day_et from public.panel_ai_daily_usage_kind where environment = p_environment and day_et <= v_tracked_day
  ) prior where n > 0;
  return jsonb_build_object('provider', p_provider, 'balance', c_claude_prepaid, 'setAt', null, 'spent', v_spent,
    'remaining', round(v_remaining, 6), 'warn', v_exhausted or v_spent >= c_claude_prepaid * 0.8, 'warnAt', round(c_claude_prepaid * 0.8, 2),
    'exhausted', v_exhausted or v_remaining <= 0, 'exhaustedAt', v_out.exhausted_at, 'informed', true, 'sinceStart', true,
    'trackedSince', v_tracked_since, 'priorUnknown', v_prior_calls > 0, 'priorCalls', v_prior_calls, 'priorFrom', v_prior_from, 'priorTo', v_prior_to);
end $$;
