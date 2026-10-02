-- OpenAI: o crédito pré-pago de US$ 50 (já pago) é o único teto, contando tudo o que já foi gasto
-- desde o começo (o mesmo gasto de sempre: tabelas de cada função + reservas que ainda contam).
-- Aviso quando o gasto chega a US$ 40 (80%). Nenhum limite por função, lote ou tarefa: todas usam
-- o mesmo crédito até acabar. Se o dono carregar mais crédito, informa o novo total carregado.
-- Claude continua igual (saldo informado, sem teto interno).
-- Aditiva: muda a precisão do saldo informado e redefine panel_ai_balance_state.

alter table public.ai_provider_balances alter column balance_usd type numeric(12, 6);

create or replace function public.panel_ai_set_balance(p_environment public.panel_environment, p_provider text, p_balance numeric, p_actor uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if p_provider not in ('OPENAI', 'ANTHROPIC') then raise exception 'AI_PROVIDER_INVALID'; end if;
  if p_balance is null or p_balance < 0 or p_balance > 100000 then raise exception 'AI_BALANCE_INVALID'; end if;
  insert into public.ai_provider_balances (environment, provider, balance_usd, set_at, set_by) values (p_environment, p_provider, round(p_balance, 6), clock_timestamp(), p_actor);
  return public.panel_ai_balance_state(p_environment, p_provider);
end $$;

create or replace function public.panel_ai_balance_state(p_environment public.panel_environment, p_provider text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  c_openai_prepaid constant numeric := 50;
  v_balance public.ai_provider_balances%rowtype;
  v_out public.ai_provider_exhausted%rowtype;
  v_total numeric;
  v_spent numeric;
  v_remaining numeric;
  v_exhausted boolean;
begin
  if p_provider not in ('OPENAI', 'ANTHROPIC') then raise exception 'AI_PROVIDER_INVALID'; end if;
  select * into v_balance from public.ai_provider_balances where environment = p_environment and provider = p_provider order by set_at desc limit 1;
  select * into v_out from public.ai_provider_exhausted where environment = p_environment and provider = p_provider;
  v_exhausted := v_out.exhausted_at is not null and (v_balance.set_at is null or v_out.exhausted_at > v_balance.set_at);
  if p_provider = 'OPENAI' then
    -- Total prepaid credit (US$ 50 unless the owner informed a new total) against everything spent.
    v_total := coalesce(v_balance.balance_usd, c_openai_prepaid);
    v_spent := round(public.panel_openai_spent_usd(p_environment)
      + coalesce((select sum(case when status = 'ABERTA' then amount_usd else actual_usd end) from public.openai_budget_holds
                   where environment = p_environment and status in ('ABERTA', 'PAGA')), 0), 6);
    v_remaining := greatest(v_total - v_spent, 0);
    return jsonb_build_object('provider', p_provider, 'balance', v_total, 'setAt', v_balance.set_at, 'spent', v_spent,
      'remaining', round(v_remaining, 6), 'warn', v_exhausted or v_spent >= v_total * 0.8, 'warnAt', round(v_total * 0.8, 2),
      'exhausted', v_exhausted or v_remaining <= 0, 'exhaustedAt', v_out.exhausted_at, 'informed', true, 'sinceStart', true);
  end if;
  if v_balance.id is null then
    v_spent := public.panel_ai_spent_since(p_environment, p_provider, now() - interval '30 days');
    return jsonb_build_object('provider', p_provider, 'balance', null, 'setAt', null, 'spent', v_spent, 'remaining', null,
      'warn', v_exhausted, 'exhausted', v_exhausted, 'exhaustedAt', v_out.exhausted_at, 'informed', false);
  end if;
  v_spent := public.panel_ai_spent_since(p_environment, p_provider, v_balance.set_at);
  v_remaining := greatest(v_balance.balance_usd - v_spent, 0);
  return jsonb_build_object('provider', p_provider, 'balance', v_balance.balance_usd, 'setAt', v_balance.set_at, 'spent', v_spent,
    'remaining', round(v_remaining, 6), 'warn', v_exhausted or v_remaining <= v_balance.balance_usd * 0.2, 'warnAt', round(v_balance.balance_usd * 0.8, 2),
    'exhausted', v_exhausted or v_remaining <= 0, 'exhaustedAt', v_out.exhausted_at, 'informed', true);
end $$;
