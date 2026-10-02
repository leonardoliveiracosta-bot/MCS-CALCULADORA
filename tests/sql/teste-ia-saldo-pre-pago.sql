-- IA pelo crédito pré-pago: OpenAI com teto único de US$ 50 (todo o gasto desde o começo, aviso em
-- US$ 40, nenhum limite por função); Claude pelo saldo informado; "sem saldo" do provedor para até
-- um novo saldo ser informado. Nada passa por teto de US$ 50 ou US$ 20.
do $$ declare r jsonb; s jsonb; hold_id uuid;
begin
  -- OpenAI: o crédito pré-pago de US$ 50 é o teto único, contando todo o gasto desde o começo.
  s := public.panel_ai_balance_state('preview', 'OPENAI');
  if (s->>'balance')::numeric <> 50 or (s->>'spent')::numeric <> 0 or (s->>'warn')::boolean then raise exception 'OPENAI_DEFAULT_50:%', s; end if;
  -- Uma função sozinha pode usar quase tudo (nenhum limite por função): US$ 39,99 cabe.
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-1', 'gpt-6-luna', 39.99);
  if not (r->>'held')::boolean then raise exception 'ONE_FEATURE_CAN_USE_ALL:%', r; end if;
  hold_id := (r->>'id')::uuid;
  if (public.panel_ai_balance_state('preview', 'OPENAI')->>'warn')::boolean then raise exception 'WARNED_BEFORE_40'; end if;
  -- Gasto já gravado por outra função conta no mesmo teto: chegou a US$ 40 = aviso.
  insert into public.audit_log(environment, entity_type, action, after_json) values ('preview', 'manheim_openai', 'TESTE', '{"costUsd":0.01}');
  s := public.panel_ai_balance_state('preview', 'OPENAI');
  if (s->>'spent')::numeric <> 40 or not (s->>'warn')::boolean or (s->>'warnAt')::numeric <> 40 then raise exception 'WARN_AT_40:%', s; end if;
  -- Restam US$ 10: 10 cabe, 10,000001 não.
  r := public.panel_openai_budget_hold('preview', 'PESQUISAS', 'teste-2', 'gpt-6-luna', 10.000001);
  if (r->>'held')::boolean or r->>'reason' <> 'SALDO_INSUFICIENTE' then raise exception 'OVER_50_SHOULD_REFUSE:%', r; end if;
  r := public.panel_openai_budget_hold('preview', 'PESQUISAS', 'teste-3', 'gpt-6-luna', 10);
  if not (r->>'held')::boolean then raise exception 'EXACT_50_SHOULD_HOLD:%', r; end if;
  if not (public.panel_ai_balance_state('preview', 'OPENAI')->>'exhausted')::boolean then raise exception 'AT_50_EXHAUSTED'; end if;
  perform public.panel_openai_budget_settle('preview', (r->>'id')::uuid, 'LIBERADA', 0);
  -- Paga pelo custo real (US$ 1): a reserva libera o resto do pior caso.
  perform public.panel_openai_budget_settle('preview', hold_id, 'PAGA', 1);
  if (public.panel_ai_balance_state('preview', 'OPENAI')->>'spent')::numeric <> 1.01 then raise exception 'SETTLE_REAL_COST'; end if;
  -- O provedor disse "sem saldo": para até informar um novo total carregado.
  perform public.panel_ai_mark_exhausted('preview', 'OPENAI', 'insufficient_quota');
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-4', 'gpt-6-luna', 0.01);
  if (r->>'held')::boolean or r->>'reason' <> 'SALDO_ESGOTADO' then raise exception 'EXHAUSTED_SHOULD_STOP:%', r; end if;
  perform pg_sleep(0.01);
  perform public.panel_ai_set_balance('preview', 'OPENAI', 70, null);
  s := public.panel_ai_balance_state('preview', 'OPENAI');
  if (s->>'balance')::numeric <> 70 or (s->>'remaining')::numeric <> 68.99 then raise exception 'NEW_TOTAL:%', s; end if;
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-5', 'gpt-6-luna', 0.01);
  if not (r->>'held')::boolean then raise exception 'NEW_BALANCE_SHOULD_RESUME:%', r; end if;
  perform public.panel_openai_budget_settle('preview', (r->>'id')::uuid, 'LIBERADA', 0);
  s := public.panel_openai_budget_state('preview');
  if s->>'limit' is null or s->>'projected' is null or s->>'remaining' is null then raise exception 'STATE_CONTRACT:%', s; end if;

  -- Claude: mesma regra, reservas próprias.
  perform public.panel_ai_set_balance('preview', 'ANTHROPIC', 0.5, null);
  r := public.panel_anthropic_budget_hold('preview', 'LEITURA', 'conversa-1', 'claude-x', 0.4);
  if not (r->>'held')::boolean then raise exception 'CLAUDE_FITS:%', r; end if;
  if (public.panel_anthropic_budget_hold('preview', 'LEITURA', 'conversa-2', 'claude-x', 0.2)->>'held')::boolean then raise exception 'CLAUDE_OVER_BALANCE'; end if;
  perform public.panel_anthropic_budget_settle('preview', (r->>'id')::uuid, 'PAGA', 0.05);
  if (public.panel_ai_balance_state('preview', 'ANTHROPIC')->>'remaining')::numeric <> 0.45 then raise exception 'CLAUDE_SETTLE_WRONG'; end if;

  raise notice 'OK: IA pelo saldo pré-pago, sem tetos internos';
end $$;
