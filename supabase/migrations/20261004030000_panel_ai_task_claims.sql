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
