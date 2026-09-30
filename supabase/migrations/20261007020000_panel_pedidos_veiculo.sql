-- Pedidos de veículo rastreáveis (PESQUISAS). Aditiva: nenhuma tabela existente muda.
--
--  * vehicle_request_runs: cada leitura de uma conversa (simulada ou pela IA), com o que foi lido,
--    custo e erro seguro. A mesma conversa com o mesmo conteúdo e a mesma regra nunca é lida (nem
--    cobrada) duas vezes; é também o ponto de retomada da auditoria histórica.
--  * vehicle_requests: um pedido de uma conversa (uma pessoa pode ter vários). Nunca é apagado.
--  * vehicle_request_versions: os critérios de cada leitura, só o que foi informado, com os IDs das
--    mensagens que sustentam cada campo, campos faltantes, confiança e motivo de revisão. Uma mudança
--    do cliente cria versão nova; a anterior fica.
--  * vehicle_request_checks: resultado auditável da comparação de um pedido PRONTO PARA BUSCAR
--    (modelo + valor + ano ou milhagem) com um lote ativo: opção válida (cálculo oficial da Ref),
--    candidatos com valor a conferir (sem Ref) ou nenhuma. Pedido que precisa detalhe não é comparado.
--  * vehicle_request_batches: cada lote da leitura do histórico (provedor, modelo, conversas,
--    tokens, custo e motivo de parada), para retomar e prestar contas do gasto.
-- A IA não escolhe carro, não encerra cliente e não envia mensagem: só estas tabelas são escritas.

create table if not exists public.vehicle_request_runs (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id),
  contact_id uuid references public.contacts(id),
  provider text not null check (provider in ('SIMULATED', 'OPENAI')),
  model text,
  rule_version text not null,
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  messages_read integer not null default 0 check (messages_read >= 0),
  status text not null check (status in ('DONE', 'NO_REQUEST', 'FAILED')),
  request_count integer not null default 0 check (request_count >= 0),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{2,60}$'),
  input_tokens integer,
  output_tokens integer,
  cost_usd numeric(12, 6),
  created_by uuid references public.panel_users(id),
  created_at timestamptz not null default now(),
  unique (environment, chat_id, input_hash, rule_version, provider)
);
create index if not exists vehicle_request_runs_chat_idx on public.vehicle_request_runs(environment, chat_id, created_at desc);
create index if not exists vehicle_request_runs_chat_fk_idx on public.vehicle_request_runs(chat_id);
create index if not exists vehicle_request_runs_contact_idx on public.vehicle_request_runs(contact_id);
create index if not exists vehicle_request_runs_created_by_idx on public.vehicle_request_runs(created_by);

create table if not exists public.vehicle_requests (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id),
  contact_id uuid references public.contacts(id),
  journey_id uuid references public.journeys(id),
  request_key text not null check (length(request_key) between 1 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment, chat_id, request_key)
);
create index if not exists vehicle_requests_chat_idx on public.vehicle_requests(chat_id);
create index if not exists vehicle_requests_contact_idx on public.vehicle_requests(contact_id);
create index if not exists vehicle_requests_journey_idx on public.vehicle_requests(journey_id);

create table if not exists public.vehicle_request_versions (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  request_id uuid not null references public.vehicle_requests(id),
  run_id uuid not null references public.vehicle_request_runs(id),
  criteria_json jsonb not null check (jsonb_typeof(criteria_json) = 'object'),
  missing_fields text[] not null default '{}',
  evidence_json jsonb not null check (jsonb_typeof(evidence_json) = 'object'),
  confidence text not null check (confidence in ('alta', 'media', 'baixa')),
  needs_review boolean not null default false,
  review_reason text check (review_reason is null or length(review_reason) <= 300),
  criteria_hash text not null check (criteria_hash ~ '^[0-9a-f]{24,64}$'),
  created_at timestamptz not null default now()
);
create index if not exists vehicle_request_versions_request_idx on public.vehicle_request_versions(request_id, created_at desc);
create index if not exists vehicle_request_versions_run_idx on public.vehicle_request_versions(run_id);

create table if not exists public.vehicle_request_checks (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  request_key text not null check (request_key ~ '^(conversa|ficha|pedido):'),
  criteria_hash text not null check (criteria_hash ~ '^[0-9a-f]{24,64}$'),
  upload_id uuid not null references public.manheim_uploads(id),
  result text not null check (result in ('HAS_OPTIONS', 'HAS_CANDIDATES', 'NO_OPTIONS', 'INSUFFICIENT', 'NEEDS_REVIEW')),
  option_count integer not null default 0 check (option_count >= 0),
  sample_fingerprints text[] not null default '{}',
  compared_by uuid references public.panel_users(id),
  compared_at timestamptz not null default now(),
  unique (environment, request_key, criteria_hash, upload_id)
);
create index if not exists vehicle_request_checks_upload_idx on public.vehicle_request_checks(upload_id);
create index if not exists vehicle_request_checks_compared_by_idx on public.vehicle_request_checks(compared_by);

create table if not exists public.vehicle_request_batches (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  provider text not null check (provider in ('SIMULATED', 'OPENAI')),
  model text,
  conversations integer not null default 0 check (conversations >= 0),
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  cost_usd numeric(12, 6) not null default 0,
  stopped_reason text check (stopped_reason is null or stopped_reason ~ '^[A-Z0-9_]{2,60}$'),
  created_by uuid references public.panel_users(id),
  created_at timestamptz not null default now()
);
create index if not exists vehicle_request_batches_created_by_idx on public.vehicle_request_batches(created_by);

do $$
declare v_table text;
begin
  foreach v_table in array array['vehicle_request_runs', 'vehicle_requests', 'vehicle_request_versions', 'vehicle_request_checks', 'vehicle_request_batches'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update on table public.%I to service_role', v_table);
  end loop;
end $$;
