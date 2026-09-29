-- Aditiva: nenhuma tabela existente é alterada.
-- Reserva atômica antes de qualquer chamada paga (tipo da tarefa + conversa ou demanda + hash do
-- conteúdo + versão da regra). Só quem obtém a reserva chama a OpenAI; outra execução ao mesmo
-- tempo (cron e botão) recebe "já em processamento" e não chama. Uma reserva abandonada (execução
-- que travou) pode ser retomada depois do prazo. CONCLUIDA nunca volta a ser reservada.
create table if not exists public.ai_task_claims (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  task_kind text not null check (task_kind in ('ENTRADA_TRIAGE', 'MANHEIM_MATCH_AUDIT')),
  subject_key text not null check (char_length(subject_key) between 1 and 200),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  rule_version text not null check (char_length(rule_version) between 1 and 40),
  status text not null check (status in ('RESERVADA', 'CONCLUIDA', 'LIBERADA')),
  claim_token uuid not null,
  attempts integer not null default 1 check (attempts >= 1),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  finished_at timestamptz,
  unique (environment, task_kind, subject_key, content_hash, rule_version)
);
alter table public.ai_task_claims enable row level security;
alter table public.ai_task_claims force row level security;
revoke all on table public.ai_task_claims from public, anon, authenticated;
grant select, insert, update on table public.ai_task_claims to service_role;

-- One statement: a new reservation, or taking over a released or expired one. Returns the token
-- only to the caller that won; everyone else gets claimed = false.
create or replace function public.panel_ai_task_claim(
  p_environment public.panel_environment,
  p_task_kind text,
  p_subject_key text,
  p_content_hash text,
  p_rule_version text,
  p_ttl_seconds integer default 300
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token uuid := gen_random_uuid();
  v_row public.ai_task_claims%rowtype;
begin
  if p_ttl_seconds is null or p_ttl_seconds < 30 or p_ttl_seconds > 3600 then raise exception 'AI_CLAIM_TTL_INVALID'; end if;
  insert into public.ai_task_claims as c (environment, task_kind, subject_key, content_hash, rule_version, status, claim_token, expires_at)
  values (p_environment, p_task_kind, p_subject_key, p_content_hash, p_rule_version, 'RESERVADA', v_token, now() + make_interval(secs => p_ttl_seconds))
  on conflict (environment, task_kind, subject_key, content_hash, rule_version) do update
    set status = 'RESERVADA', claim_token = v_token, attempts = c.attempts + 1, reserved_at = now(),
        expires_at = now() + make_interval(secs => p_ttl_seconds), finished_at = null
    where c.status = 'LIBERADA' or (c.status = 'RESERVADA' and c.expires_at < now())
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.ai_task_claims
      where environment = p_environment and task_kind = p_task_kind and subject_key = p_subject_key and content_hash = p_content_hash and rule_version = p_rule_version;
    return jsonb_build_object('claimed', false, 'status', v_row.status);
  end if;
  return jsonb_build_object('claimed', true, 'id', v_row.id, 'token', v_row.claim_token, 'attempts', v_row.attempts);
end $$;

-- Ends a reservation, only with its own token: CONCLUIDA (done) or LIBERADA (may be retried).
create or replace function public.panel_ai_task_finish(
  p_environment public.panel_environment,
  p_claim_id uuid,
  p_token uuid,
  p_status text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  if p_status not in ('CONCLUIDA', 'LIBERADA') then raise exception 'AI_CLAIM_STATUS_INVALID'; end if;
  update public.ai_task_claims set status = p_status, finished_at = now()
    where id = p_claim_id and environment = p_environment and claim_token = p_token and status = 'RESERVADA';
  get diagnostics v_count = row_count;
  return jsonb_build_object('finished', v_count = 1);
end $$;

revoke all on function public.panel_ai_task_claim(public.panel_environment, text, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.panel_ai_task_claim(public.panel_environment, text, text, text, text, integer) to service_role;
revoke all on function public.panel_ai_task_finish(public.panel_environment, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.panel_ai_task_finish(public.panel_environment, uuid, uuid, text) to service_role;

-- Teto atômico por importação (MANHEIM_MATCH_AUDIT): além da reserva por demanda, cada chamada
-- reserva orçamento do lote. Sob uma trava por lote, soma o gasto real (manheim_match_audits) e as
-- reservas abertas; só reserva se couber no limite (US$ 2, ou o autorizado). Duas demandas ao mesmo
-- tempo nunca passam juntas do saldo: a que não cabe deixa o lote aguardando autorização.
create table if not exists public.manheim_audit_budget_holds (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  demand_key text not null check (char_length(demand_key) between 1 and 200),
  amount_usd numeric(12, 6) not null check (amount_usd > 0),
  status text not null default 'ABERTA' check (status in ('ABERTA', 'ENCERRADA')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz
);
create index if not exists manheim_audit_budget_holds_open
  on public.manheim_audit_budget_holds (environment, upload_id) where status = 'ABERTA';
alter table public.manheim_audit_budget_holds enable row level security;
alter table public.manheim_audit_budget_holds force row level security;
revoke all on table public.manheim_audit_budget_holds from public, anon, authenticated;
grant select, insert, update on table public.manheim_audit_budget_holds to service_role;

-- p_base_limit can only lower the US$ 2 limit (never raise it); the authorized limit is set by the
-- operator's authorization on manheim_audit_runs.
create or replace function public.panel_manheim_audit_budget_hold(
  p_environment public.panel_environment,
  p_upload_id uuid,
  p_demand_key text,
  p_amount numeric,
  p_base_limit numeric default 2
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
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
    values (p_environment, p_upload_id, 'ABERTO', 0, 2, 0) returning * into v_run;
  end if;
  v_limit := case when v_run.status = 'AUTORIZADO' then v_run.limit_usd else least(coalesce(p_base_limit, 2), 2) end;
  select coalesce(sum(cost_usd), 0) into v_spent from public.manheim_match_audits where environment = p_environment and upload_id = p_upload_id;
  select coalesce(sum(amount_usd), 0) into v_held from public.manheim_audit_budget_holds
    where environment = p_environment and upload_id = p_upload_id and status = 'ABERTA' and expires_at > now();
  if v_spent + v_held + p_amount > v_limit then
    -- The shown estimate stays the one computed by the caller (never the safety hold).
    update public.manheim_audit_runs set status = 'AGUARDANDO_AUTORIZACAO', authorized_by = null, authorized_at = null, updated_at = now() where id = v_run.id;
    return jsonb_build_object('held', false, 'remaining', greatest(v_limit - v_spent - v_held, 0), 'limit', v_limit);
  end if;
  insert into public.manheim_audit_budget_holds (environment, upload_id, demand_key, amount_usd, expires_at)
  values (p_environment, p_upload_id, p_demand_key, p_amount, now() + interval '10 minutes') returning id into v_id;
  return jsonb_build_object('held', true, 'id', v_id, 'remaining', v_limit - v_spent - v_held - p_amount, 'limit', v_limit);
end $$;

revoke all on function public.panel_manheim_audit_budget_hold(public.panel_environment, uuid, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.panel_manheim_audit_budget_hold(public.panel_environment, uuid, text, numeric, numeric) to service_role;
