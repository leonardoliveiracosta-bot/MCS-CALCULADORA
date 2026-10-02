-- IA pelo saldo pré-pago de cada provedor: sem saldo informado não há teto interno; com saldo, a
-- reserva só sai se couber no que resta; aviso com 20% ou menos; "sem saldo" do provedor para até
-- um novo saldo ser informado. Nada passa por teto de US$ 50 ou US$ 20.
do $$ declare r jsonb; s jsonb; hold_id uuid;
begin
  -- Sem saldo informado: uma chamada grande passa (o limite é o pré-pago do próprio provedor).
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-sem-saldo', 'gpt-6-luna', 60);
  if not (r->>'held')::boolean then raise exception 'NO_BALANCE_SHOULD_NOT_CAP:%', r; end if;
  perform public.panel_openai_budget_settle('preview', (r->>'id')::uuid, 'LIBERADA', 0);

  -- Saldo informado de US$ 1: cabe 0,60; depois 0,50 não cabe.
  s := public.panel_ai_set_balance('preview', 'OPENAI', 1, null);
  if (s->>'remaining')::numeric <> 1 or (s->>'warn')::boolean then raise exception 'BALANCE_STATE_WRONG:%', s; end if;
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-1', 'gpt-6-luna', 0.6);
  if not (r->>'held')::boolean then raise exception 'FITS_SHOULD_HOLD:%', r; end if;
  hold_id := (r->>'id')::uuid;
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-2', 'gpt-6-luna', 0.5);
  if (r->>'held')::boolean or r->>'reason' <> 'SALDO_INSUFICIENTE' then raise exception 'OVER_BALANCE_SHOULD_REFUSE:%', r; end if;
  -- Paga pelo custo real (0,85): restam 0,15 = aviso (20% ou menos).
  perform public.panel_openai_budget_settle('preview', hold_id, 'PAGA', 0.85);
  s := public.panel_ai_balance_state('preview', 'OPENAI');
  if (s->>'remaining')::numeric <> 0.15 or not (s->>'warn')::boolean then raise exception 'WARN_AT_20_PERCENT:%', s; end if;
  -- Registrada pela função continua contando no gasto desde o saldo informado.
  perform public.panel_openai_budget_settle('preview', hold_id, 'REGISTRADA', null);
  if (public.panel_ai_balance_state('preview', 'OPENAI')->>'remaining')::numeric <> 0.15 then raise exception 'RECORDED_STOPPED_COUNTING'; end if;

  -- O provedor disse "sem saldo": para até informar um novo saldo.
  perform public.panel_ai_mark_exhausted('preview', 'OPENAI', 'insufficient_quota');
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-3', 'gpt-6-luna', 0.01);
  if (r->>'held')::boolean or r->>'reason' <> 'SALDO_ESGOTADO' then raise exception 'EXHAUSTED_SHOULD_STOP:%', r; end if;
  perform pg_sleep(0.01);
  perform public.panel_ai_set_balance('preview', 'OPENAI', 10, null);
  r := public.panel_openai_budget_hold('preview', 'ENTRADA', 'teste-4', 'gpt-6-luna', 0.01);
  if not (r->>'held')::boolean then raise exception 'NEW_BALANCE_SHOULD_RESUME:%', r; end if;
  perform public.panel_openai_budget_settle('preview', (r->>'id')::uuid, 'LIBERADA', 0);
  -- Contrato antigo de estado continua com as mesmas chaves.
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
