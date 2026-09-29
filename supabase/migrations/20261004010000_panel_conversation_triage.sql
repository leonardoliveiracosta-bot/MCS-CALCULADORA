-- Triagem da ENTRADA: classificação de cada conversa (não da pessoa) em pré-compra MCS ou fora do
-- funil comercial. Aditiva: uma tabela nova e duas funções. Nenhuma mensagem, contato, ficha,
-- demanda CARRO/VALOR ou match do Manheim é alterado ou apagado por esta migração ou pelas funções.
--
-- Cada decisão é uma linha nova; nada é reescrito. No máximo uma linha ACTIVE por conversa.
--   * source AI: resultado da OpenAI (provider 'openai'). A mesma conversa com o mesmo conteúdo e a
--     mesma versão da regra só é classificada uma vez (nunca repete cobrança). Uma falha fica
--     registrada como REVISAR e pode ser repetida até 3 tentativas na mesma linha.
--   * source MANUAL: decisão do operador; sempre prevalece. A IA só substitui uma decisão manual
--     quando o cliente escreve de novo depois dela e a nova leitura é pré-compra (nova intenção).
--   * Desfazer uma decisão manual devolve a decisão anterior.
-- Mudar a versão da regra não reprocessa nada sozinho: só conversas com mensagem nova entram.

create table if not exists public.conversation_triage (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id),
  journey_id uuid references public.journeys(id),
  source text not null check (source in ('AI', 'MANUAL')),
  category text not null check (category in ('PRE_COMPRA_MCS', 'POS_VENDA', 'PESSOAL', 'OUTRO_NEGOCIO', 'NAO_CLIENTE', 'REVISAR')),
  decision text not null check (decision in ('FUNIL', 'FORA_DO_FUNIL', 'PENDENTE')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUPERSEDED', 'UNDONE', 'NOT_APPLIED')),
  reason text not null default '' check (char_length(reason) <= 400),
  evidence_message_ids uuid[] not null default '{}',
  last_message_at timestamptz,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  rule_version text not null check (char_length(rule_version) between 1 and 40),
  provider text check (provider is null or provider = 'openai'),
  model text check (model is null or char_length(model) <= 60),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 60),
  attempts integer not null default 1 check (attempts between 1 and 3),
  created_by uuid references public.panel_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  superseded_at timestamptz,
  superseded_by uuid references public.conversation_triage(id),
  check ((source = 'AI') = (provider is not null)),
  check ((source = 'MANUAL') = (created_by is not null)),
  check (decision = case category when 'PRE_COMPRA_MCS' then 'FUNIL' when 'REVISAR' then 'PENDENTE' else 'FORA_DO_FUNIL' end)
);

create unique index if not exists conversation_triage_one_active
  on public.conversation_triage (environment, chat_id) where status = 'ACTIVE';
create unique index if not exists conversation_triage_ai_once
  on public.conversation_triage (environment, chat_id, content_hash, rule_version) where source = 'AI';
create index if not exists conversation_triage_journey
  on public.conversation_triage (environment, journey_id) where status = 'ACTIVE';

alter table public.conversation_triage enable row level security;
revoke all on public.conversation_triage from public, anon, authenticated;
grant select, insert, update on public.conversation_triage to service_role;

-- Records one classification and applies the precedence rules atomically.
-- Returns { id, applied, duplicate, status }.
create or replace function public.panel_conversation_triage_record(
  p_environment public.panel_environment,
  p_chat_id uuid,
  p_journey_id uuid,
  p_source text,
  p_category text,
  p_reason text,
  p_evidence uuid[],
  p_last_message_at timestamptz,
  p_content_hash text,
  p_rule_version text,
  p_provider text default null,
  p_model text default null,
  p_input_tokens integer default null,
  p_output_tokens integer default null,
  p_cost_usd numeric default null,
  p_error_code text default null,
  p_actor_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_decision text := case p_category when 'PRE_COMPRA_MCS' then 'FUNIL' when 'REVISAR' then 'PENDENTE' else 'FORA_DO_FUNIL' end;
  v_active public.conversation_triage%rowtype;
  v_same public.conversation_triage%rowtype;
  v_apply boolean := true;
  v_id uuid;
begin
  if p_source not in ('AI', 'MANUAL') then raise exception 'TRIAGE_SOURCE_INVALID'; end if;
  if not exists (select 1 from public.chats where id = p_chat_id and environment = p_environment) then raise exception 'TRIAGE_CHAT_NOT_FOUND'; end if;
  if p_source = 'MANUAL' and (p_actor_id is null or not exists (select 1 from public.panel_users where id = p_actor_id and environment = p_environment and active)) then raise exception 'TRIAGE_ACTOR_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':triage:' || p_chat_id::text, 0));
  select * into v_active from public.conversation_triage where environment = p_environment and chat_id = p_chat_id and status = 'ACTIVE' for update;

  if p_source = 'AI' then
    select * into v_same from public.conversation_triage
      where environment = p_environment and chat_id = p_chat_id and content_hash = p_content_hash and rule_version = p_rule_version and source = 'AI' for update;
    if found then
      -- Same content, same rule: never a second call. A failed reading may be retried in place.
      if v_same.error_code is null or p_error_code is not null then
        if p_error_code is not null and v_same.error_code is not null then
          -- Tokens and cost add up: every paid attempt stays on the record.
          update public.conversation_triage set attempts = least(attempts + 1, 3), error_code = p_error_code, updated_at = now(),
            input_tokens = nullif(coalesce(input_tokens, 0) + coalesce(p_input_tokens, 0), 0), output_tokens = nullif(coalesce(output_tokens, 0) + coalesce(p_output_tokens, 0), 0),
            cost_usd = nullif(coalesce(cost_usd, 0) + coalesce(p_cost_usd, 0), 0) where id = v_same.id;
        end if;
        return jsonb_build_object('id', v_same.id, 'applied', false, 'duplicate', true, 'status', v_same.status);
      end if;
      update public.conversation_triage set category = p_category, decision = v_decision, reason = left(coalesce(p_reason, ''), 400), evidence_message_ids = coalesce(p_evidence, '{}'),
        model = p_model, input_tokens = coalesce(input_tokens, 0) + coalesce(p_input_tokens, 0), output_tokens = coalesce(output_tokens, 0) + coalesce(p_output_tokens, 0),
        cost_usd = coalesce(cost_usd, 0) + coalesce(p_cost_usd, 0), error_code = null, attempts = least(attempts + 1, 3), updated_at = now()
        where id = v_same.id;
      if v_same.status = 'ACTIVE' then
        return jsonb_build_object('id', v_same.id, 'applied', true, 'duplicate', false, 'status', 'ACTIVE');
      end if;
      -- The failed reading had been kept out by a manual decision: the successful retry goes
      -- through the same precedence rule as a first reading (a new purchase intent reactivates).
      if v_active.id is null then
        v_apply := true;
      elsif v_active.source = 'MANUAL' then
        v_apply := p_category = 'PRE_COMPRA_MCS' and v_active.decision = 'FORA_DO_FUNIL' and p_last_message_at is not null and p_last_message_at > v_active.created_at;
      else
        v_apply := false;
      end if;
      if v_apply then
        update public.conversation_triage set status = 'SUPERSEDED', superseded_at = now(), superseded_by = v_same.id, updated_at = now() where id = v_active.id;
        update public.conversation_triage set status = 'ACTIVE', updated_at = now() where id = v_same.id;
      end if;
      return jsonb_build_object('id', v_same.id, 'applied', v_apply, 'duplicate', false, 'status', case when v_apply then 'ACTIVE' else v_same.status end);
    end if;
    -- A manual decision wins. Only a new purchase intent written after it may replace it.
    if v_active.id is not null and v_active.source = 'MANUAL' then
      v_apply := p_category = 'PRE_COMPRA_MCS' and v_active.decision = 'FORA_DO_FUNIL' and p_last_message_at is not null and p_last_message_at > v_active.created_at;
    end if;
  end if;

  insert into public.conversation_triage (environment, chat_id, journey_id, source, category, decision, status, reason, evidence_message_ids, last_message_at, content_hash, rule_version,
    provider, model, input_tokens, output_tokens, cost_usd, error_code, created_by)
  values (p_environment, p_chat_id, p_journey_id, p_source, p_category, v_decision, case when v_apply then 'SUPERSEDED' else 'NOT_APPLIED' end, left(coalesce(p_reason, ''), 400),
    coalesce(p_evidence, '{}'), p_last_message_at, p_content_hash, p_rule_version,
    case when p_source = 'AI' then 'openai' end, p_model, p_input_tokens, p_output_tokens, p_cost_usd, p_error_code, case when p_source = 'MANUAL' then p_actor_id end)
  returning id into v_id;
  if v_apply then
    update public.conversation_triage set status = 'SUPERSEDED', superseded_at = now(), superseded_by = v_id, updated_at = now() where id = v_active.id;
    update public.conversation_triage set status = 'ACTIVE' where id = v_id;
  end if;
  return jsonb_build_object('id', v_id, 'applied', v_apply, 'duplicate', false, 'status', case when v_apply then 'ACTIVE' else 'NOT_APPLIED' end);
end $$;

-- Undoes the active manual decision of a conversation and brings back the decision it replaced.
create or replace function public.panel_conversation_triage_undo(
  p_environment public.panel_environment,
  p_triage_id uuid,
  p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_row public.conversation_triage%rowtype;
  v_previous uuid;
begin
  if p_actor_id is null or not exists (select 1 from public.panel_users where id = p_actor_id and environment = p_environment and active) then raise exception 'TRIAGE_ACTOR_INVALID'; end if;
  -- Same lock order as the record function (advisory lock first, then the row) to avoid deadlocks.
  select * into v_row from public.conversation_triage where id = p_triage_id and environment = p_environment;
  if not found then raise exception 'TRIAGE_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':triage:' || v_row.chat_id::text, 0));
  select * into v_row from public.conversation_triage where id = p_triage_id and environment = p_environment for update;
  if v_row.status <> 'ACTIVE' or v_row.source <> 'MANUAL' then raise exception 'TRIAGE_NOT_UNDOABLE'; end if;
  update public.conversation_triage set status = 'UNDONE', updated_at = now() where id = v_row.id;
  select id into v_previous from public.conversation_triage where environment = p_environment and chat_id = v_row.chat_id and superseded_by = v_row.id order by created_at desc limit 1;
  if v_previous is not null then
    update public.conversation_triage set status = 'ACTIVE', superseded_at = null, superseded_by = null, updated_at = now() where id = v_previous;
  end if;
  return jsonb_build_object('undone', v_row.id, 'restored', v_previous);
end $$;

revoke all on function public.panel_conversation_triage_record(public.panel_environment, uuid, uuid, text, text, text, uuid[], timestamptz, text, text, text, text, integer, integer, numeric, text, uuid) from public, anon, authenticated;
grant execute on function public.panel_conversation_triage_record(public.panel_environment, uuid, uuid, text, text, text, uuid[], timestamptz, text, text, text, text, integer, integer, numeric, text, uuid) to service_role;
revoke all on function public.panel_conversation_triage_undo(public.panel_environment, uuid, uuid) from public, anon, authenticated;
grant execute on function public.panel_conversation_triage_undo(public.panel_environment, uuid, uuid) to service_role;

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
