-- Ficha › CONVERSA: resposta orientada pelo operador e tradução da conversa, no mesmo teto de US$ 50.
-- Aditiva: a reserva aceita as duas funções novas (RESPOSTA_ORIENTADA e TRADUCAO_CONVERSA), o gasto
-- delas (audit_log, entity_type 'reply_guided_openai' e 'conversation_translation_openai',
-- after_json.costUsd) passa a contar no teto, e as traduções ficam guardadas por mensagem e conteúdo.
-- As mensagens originais nunca são alteradas; nada é enviado.

alter table public.openai_budget_holds drop constraint if exists openai_budget_holds_feature_check;
alter table public.openai_budget_holds add constraint openai_budget_holds_feature_check
  check (feature in ('PESQUISAS', 'MODELO_TESTE', 'ENTRADA', 'MANHEIM_AUDIT', 'MANHEIM_CSV', 'RESPOSTA', 'RESPOSTA_ORIENTADA', 'TRADUCAO_CONVERSA'));

create or replace function public.panel_openai_spent_usd(p_environment public.panel_environment)
returns numeric language sql stable security definer set search_path = public as $$
  select round((
      coalesce((select sum(cost_usd) from public.vehicle_request_runs
                 where environment = p_environment and provider = 'OPENAI'), 0)
    + coalesce((select sum(cost_usd) from public.vehicle_request_batches
                 where environment = p_environment and provider = 'OPENAI' and conversations = 0), 0)
    + coalesce((select sum(cost_usd) from public.conversation_triage where environment = p_environment), 0)
    + coalesce((select sum(cost_usd) from public.manheim_match_audits where environment = p_environment), 0)
    + coalesce((select sum((after_json->>'costUsd')::numeric) from public.audit_log
                 where environment = p_environment
                   and entity_type in ('manheim_openai', 'reply_suggestion_openai', 'reply_guided_openai', 'conversation_translation_openai')
                   and jsonb_typeof(after_json->'costUsd') = 'number'), 0)
  )::numeric, 6)
$$;
revoke all on function public.panel_openai_spent_usd(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_openai_spent_usd(public.panel_environment) to service_role;

-- Tradução guardada por mensagem e pelo conteúdo traduzido (mensagem alterada = nova tradução).
create table if not exists public.message_translations (
  environment public.panel_environment not null,
  message_id uuid not null references public.messages(id),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{32}$'),
  source_lang text not null check (source_lang in ('en', 'es', 'outro')),
  text_pt text not null check (length(text_pt) between 1 and 4000),
  model text,
  simulated boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid references public.panel_users(id),
  primary key (environment, message_id, content_hash)
);
create index if not exists message_translations_message_idx on public.message_translations(message_id);
create index if not exists message_translations_created_by_idx on public.message_translations(created_by);
alter table public.message_translations enable row level security;
alter table public.message_translations force row level security;
revoke all on public.message_translations from public, anon, authenticated;
grant select, insert, update, delete on public.message_translations to service_role;
