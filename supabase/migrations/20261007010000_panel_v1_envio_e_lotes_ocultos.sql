-- Envio manual da V1 pelo 360dialog e histórico de lotes limpo em BUSCAS. Aditiva.
--
--  * v1_sends: cada tentativa de envio da V1 pelo painel (ficha, chat, V1, telefone, texto e hash,
--    operador, status, ID do 360dialog quando confirmado, erro seguro). Nunca guarda a resposta bruta
--    do provedor. Um envio em andamento por V1 e uma chave por clique de confirmação (sem duplicar).
--  * panel_batch_hidden: preferência de exibição por operador (lote desfeito oculto da lista). Não
--    muda o lote; veículos, matches e auditoria continuam iguais. O lote ativo nunca é ocultado.

create table if not exists public.v1_sends (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  vitrine_id uuid not null references public.vitrines(id),
  journey_id uuid not null references public.journeys(id),
  chat_id uuid references public.chats(id),
  contact_id uuid references public.contacts(id),
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  origin text check (origin is null or origin in ('VALOR', 'CARRO')),
  body_text text not null check (length(body_text) between 1 and 4000),
  body_sha256 text not null check (body_sha256 ~ '^[0-9a-f]{64}$'),
  request_key uuid not null,
  status text not null check (status in ('PREPARED', 'SENDING', 'SENT', 'UNCONFIRMED', 'FAILED')),
  simulated boolean not null default false,
  resend boolean not null default false,
  provider_message_id text check (provider_message_id is null or length(provider_message_id) between 2 and 200),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{2,60}$'),
  created_by uuid not null references public.panel_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (environment, request_key),
  check (status <> 'SENT' or provider_message_id is not null)
);
create unique index if not exists v1_sends_one_in_flight_idx on public.v1_sends(environment, vitrine_id) where status = 'SENDING';
create index if not exists v1_sends_vitrine_idx on public.v1_sends(environment, vitrine_id, created_at desc);
create index if not exists v1_sends_vitrine_fk_idx on public.v1_sends(vitrine_id);
create index if not exists v1_sends_journey_idx on public.v1_sends(journey_id);
create index if not exists v1_sends_chat_idx on public.v1_sends(chat_id);
create index if not exists v1_sends_contact_idx on public.v1_sends(contact_id);
create index if not exists v1_sends_created_by_idx on public.v1_sends(created_by);
alter table public.v1_sends enable row level security;
alter table public.v1_sends force row level security;
revoke all on table public.v1_sends from public, anon, authenticated;
grant select, insert, update on table public.v1_sends to service_role;

create table if not exists public.panel_batch_hidden (
  environment public.panel_environment not null,
  user_id uuid not null references public.panel_users(id),
  upload_id uuid not null references public.manheim_uploads(id),
  hidden_at timestamptz not null default now(),
  primary key (environment, user_id, upload_id)
);
create index if not exists panel_batch_hidden_upload_idx on public.panel_batch_hidden(upload_id);
create index if not exists panel_batch_hidden_user_idx on public.panel_batch_hidden(user_id);
alter table public.panel_batch_hidden enable row level security;
alter table public.panel_batch_hidden force row level security;
revoke all on table public.panel_batch_hidden from public, anon, authenticated;
grant select, insert, delete on table public.panel_batch_hidden to service_role;
