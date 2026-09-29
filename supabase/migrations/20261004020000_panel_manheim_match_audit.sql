-- MANHEIM_MATCH_AUDIT: conferência dos matches do Manheim pela OpenAI, por demanda (pessoa + modo)
-- do lote ativo. Aditiva: duas tabelas novas. Nenhum match, demanda, ficha, contato ou lote é
-- alterado ou apagado por esta migração.
--
--  * manheim_match_audits: uma linha por conteúdo conferido (lote, demanda, critérios, matches e
--    versão da regra, no content_hash). O índice único impede cobrar duas vezes o mesmo conteúdo;
--    a linha é reservada (CONFERINDO) antes da chamada. Uma mudança de critério ou de matches gera
--    um hash novo e uma linha nova; as antigas ficam para auditoria.
--  * manheim_audit_runs: estimativa, limite (US$ 2 por importação), gasto e autorização do lote.

create table if not exists public.manheim_match_audits (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  journey_id uuid references public.journeys(id),
  logical_mode public.panel_logical_mode,
  demand_key text not null check (char_length(demand_key) between 1 and 200),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  rule_version text not null check (char_length(rule_version) between 1 and 40),
  status text not null check (status in ('CONFERINDO', 'CONFERIDO', 'REVISAR', 'PENDENTE', 'APROVADO_MANUAL')),
  divergences jsonb not null default '[]'::jsonb check (jsonb_typeof(divergences) = 'array'),
  reason text not null default '' check (char_length(reason) <= 400),
  match_count integer not null default 0 check (match_count >= 0),
  provider text check (provider is null or provider = 'openai'),
  model text check (model is null or char_length(model) <= 60),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  cost_usd numeric(12, 6) check (cost_usd is null or cost_usd >= 0),
  error_code text check (error_code is null or char_length(error_code) <= 60),
  attempts integer not null default 1 check (attempts between 1 and 20),
  approved_by uuid references public.panel_users(id),
  approved_reason text check (approved_reason is null or char_length(approved_reason) between 5 and 300),
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'APROVADO_MANUAL') = (approved_by is not null and approved_reason is not null and approved_at is not null)),
  unique (environment, content_hash)
);
create index if not exists manheim_match_audits_upload
  on public.manheim_match_audits (environment, upload_id, demand_key, created_at);

create table if not exists public.manheim_audit_runs (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  status text not null default 'ABERTO' check (status in ('ABERTO', 'AGUARDANDO_AUTORIZACAO', 'AUTORIZADO')),
  estimate_usd numeric(12, 6) not null default 0 check (estimate_usd >= 0),
  limit_usd numeric(12, 6) not null default 2 check (limit_usd >= 0),
  spent_usd numeric(12, 6) not null default 0 check (spent_usd >= 0),
  authorized_by uuid references public.panel_users(id),
  authorized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'AUTORIZADO') = (authorized_by is not null and authorized_at is not null)),
  unique (environment, upload_id)
);

alter table public.manheim_match_audits enable row level security;
alter table public.manheim_match_audits force row level security;
alter table public.manheim_audit_runs enable row level security;
alter table public.manheim_audit_runs force row level security;
revoke all on table public.manheim_match_audits, public.manheim_audit_runs from public, anon, authenticated;
grant select, insert, update on table public.manheim_match_audits, public.manheim_audit_runs to service_role;
