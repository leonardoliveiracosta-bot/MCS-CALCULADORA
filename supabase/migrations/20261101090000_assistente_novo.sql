-- Novo assistente do painel (OpenAI, function calling).
-- 1. panel_assistant_proposals: toda ação do assistente nasce como PROPOSTA (parâmetros reais, autor,
--    validade de 10 min, uso único). Só a rota de confirmação executa, e só uma vez: a troca
--    PENDENTE -> EXECUTANDO é um UPDATE condicional (status, validade e autor no mesmo comando).
-- 2. panel_request_log: rota lenta ou com erro (servidor) e falha vista no navegador (cliente), para
--    a auditoria "tem algo quebrado?". Nunca guarda conteúdo de cliente.
-- 3. panel_server_logs: erros das funções da Vercel recebidos pelo dreno de logs (últimas 24 h na
--    auditoria). Só nível erro ou resposta 5xx; mensagem cortada.

create table if not exists public.panel_assistant_proposals (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  kind text not null check (char_length(kind) between 1 and 60),
  params jsonb not null default '{}'::jsonb,
  card jsonb not null default '{}'::jsonb,
  status text not null default 'PENDENTE' check (status in ('PENDENTE', 'EXECUTANDO', 'FEITA', 'FALHOU', 'CANCELADA')),
  expires_at timestamptz not null default (now() + interval '10 minutes'),
  used_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  error_code text
);
create index if not exists panel_assistant_proposals_recent on public.panel_assistant_proposals (environment, created_at desc);

create table if not exists public.panel_request_log (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  created_at timestamptz not null default now(),
  source text not null check (source in ('server', 'client')),
  path text check (path is null or char_length(path) <= 120),
  method text check (method is null or char_length(method) <= 8),
  status integer,
  ms integer,
  code text check (code is null or char_length(code) <= 80),
  detail jsonb not null default '{}'::jsonb
);
create index if not exists panel_request_log_recent on public.panel_request_log (environment, created_at desc);

create table if not exists public.panel_server_logs (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  received_at timestamptz not null default now(),
  logged_at timestamptz,
  level text,
  status_code integer,
  path text check (path is null or char_length(path) <= 200),
  source text,
  request_id text,
  deployment_id text,
  message text check (message is null or char_length(message) <= 500)
);
create index if not exists panel_server_logs_recent on public.panel_server_logs (environment, logged_at desc);

alter table public.panel_assistant_proposals enable row level security;
alter table public.panel_assistant_proposals force row level security;
alter table public.panel_request_log enable row level security;
alter table public.panel_request_log force row level security;
alter table public.panel_server_logs enable row level security;
alter table public.panel_server_logs force row level security;
revoke all on table public.panel_assistant_proposals, public.panel_request_log, public.panel_server_logs from public, anon, authenticated;
grant select, insert, update on table public.panel_assistant_proposals to service_role;
grant select, insert on table public.panel_request_log, public.panel_server_logs to service_role;
