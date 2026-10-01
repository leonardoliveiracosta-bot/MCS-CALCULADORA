-- Fora do assunto (adendo, item 4): a triagem da ENTRADA passa a dizer se a conversa inteira trata
-- de carro (veículo, compra, financiamento de veículo, orçamento ou serviço da MCS). Aditiva: uma
-- coluna nova e uma tabela nova. Nenhuma mensagem, contato, ficha, demanda, busca ou envio é
-- alterado ou apagado. Na dúvida a conversa fica no fluxo principal (about_car nulo = sem leitura).
--
-- * conversation_triage.about_car: resposta da IA na leitura da conversa (null nas leituras antigas).
-- * conversation_topic_overrides: a correção feita no painel. Cada correção é uma linha nova; a
--   anterior fica guardada com undone_at (histórico). A correção ativa mais recente sempre vence a IA.

alter table public.conversation_triage add column if not exists about_car boolean;

create table if not exists public.conversation_topic_overrides (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id),
  journey_id uuid references public.journeys(id),
  about_car boolean not null,
  replaces_ids uuid[] not null default '{}',
  created_by uuid not null references public.panel_users(id),
  created_at timestamptz not null default now(),
  undone_at timestamptz,
  undone_by uuid references public.panel_users(id),
  check ((undone_at is null) = (undone_by is null))
);

create unique index if not exists conversation_topic_overrides_one_active
  on public.conversation_topic_overrides (environment, chat_id) where undone_at is null;
create index if not exists conversation_topic_overrides_journey
  on public.conversation_topic_overrides (environment, journey_id) where undone_at is null;

alter table public.conversation_topic_overrides enable row level security;
revoke all on public.conversation_topic_overrides from public, anon, authenticated;
grant select, insert, update on public.conversation_topic_overrides to service_role;
