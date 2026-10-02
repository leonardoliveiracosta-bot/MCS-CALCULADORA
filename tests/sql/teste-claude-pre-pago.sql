-- Claude: US$ 50 pré-pagos, separados da OpenAI. Gasto registrado desde o começo; uso anterior às
-- reservas sem custo registrado aparece como desconhecido (nunca zero); aviso em US$ 40; trava no
-- pré-pago; saldo do console informado passa a valer a partir de então.
do $$ declare r jsonb; s jsonb; first_id uuid; prior bigint;
begin
  s := public.panel_ai_balance_state('production', 'ANTHROPIC');
  if (s->>'balance')::numeric <> 50 or (s->>'spent')::numeric <> 0 or not (s->>'sinceStart')::boolean or (s->>'priorUnknown')::boolean then raise exception 'CLAUDE_DEFAULT_50:%', s; end if;
  -- Uso anterior às reservas: chamadas contadas por dia, sem custo (os cenários anteriores podem
  -- já ter contado chamadas: o teste soma 45 ao que já existia).
  select coalesce(sum(call_count), 0) into prior from (select call_count from public.conversation_ai_daily_usage where environment = 'production'
    union all select call_count from public.sms_print_ai_daily_usage where environment = 'production'
    union all select call_count from public.panel_ai_daily_usage_kind where environment = 'production') u;
  insert into public.conversation_ai_daily_usage(environment, day_et, call_count) values ('production', date '2020-01-01', 40);
  insert into public.sms_print_ai_daily_usage(environment, day_et, call_count) values ('production', date '2020-01-02', 5);
  r := public.panel_anthropic_budget_hold('production', 'LEITURA', 'conversa-1', 'claude-x', 1);
  if not (r->>'held')::boolean then raise exception 'CLAUDE_HOLD:%', r; end if;
  first_id := (r->>'id')::uuid;
  perform public.panel_anthropic_budget_settle('production', first_id, 'PAGA', 0.25);
  s := public.panel_ai_balance_state('production', 'ANTHROPIC');
  if not (s->>'priorUnknown')::boolean or (s->>'priorCalls')::int <> prior + 45 then raise exception 'PRIOR_UNKNOWN:%', s; end if;
  if (s->>'spent')::numeric <> 0.25 or (s->>'remaining')::numeric <> 49.75 then raise exception 'CLAUDE_SPENT:%', s; end if;
  -- OpenAI continua separada.
  if (public.panel_ai_balance_state('production', 'OPENAI')->>'spent')::numeric <> 0 then raise exception 'OPENAI_MIXED'; end if;
  -- Aviso a partir de US$ 40 de gasto registrado.
  r := public.panel_anthropic_budget_hold('production', 'PRINT_SMS', 'print-1', 'claude-x', 39.75);
  perform public.panel_anthropic_budget_settle('production', (r->>'id')::uuid, 'PAGA', 39.75);
  s := public.panel_ai_balance_state('production', 'ANTHROPIC');
  if not (s->>'warn')::boolean or (s->>'warnAt')::numeric <> 40 then raise exception 'CLAUDE_WARN_40:%', s; end if;
  -- Nunca passa do pré-pago: restam US$ 10.
  if (public.panel_anthropic_budget_hold('production', 'NOTA', 'nota-1', 'claude-x', 10.01)->>'held')::boolean then raise exception 'CLAUDE_OVER_PREPAID'; end if;
  -- Saldo do console informado: desconta o uso anterior a partir de então.
  perform pg_sleep(0.01);
  perform public.panel_ai_set_balance('production', 'ANTHROPIC', 8.5, null);
  s := public.panel_ai_balance_state('production', 'ANTHROPIC');
  if (s->>'remaining')::numeric <> 8.5 or (s->>'priorUnknown')::boolean or (s->>'sinceStart')::boolean then raise exception 'CONSOLE_BALANCE:%', s; end if;
  raise notice 'OK: Claude pelo crédito pré-pago de US$ 50, uso anterior desconhecido nunca zero';
end $$;
