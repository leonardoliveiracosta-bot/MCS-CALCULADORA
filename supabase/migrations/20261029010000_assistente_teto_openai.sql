-- Assistente do painel: a reserva de gasto da OpenAI (openai_budget_holds) passa a aceitar a função
-- ASSISTENTE. O PR 228 esqueceu a décima função: toda pergunta ao assistente caía em
-- "Assistente indisponível agora" (OPENAI_BUDGET_UNAVAILABLE). Mesmo padrão de 20261025030000.
alter table public.openai_budget_holds drop constraint if exists openai_budget_holds_feature_check;
alter table public.openai_budget_holds add constraint openai_budget_holds_feature_check
  check (feature in ('PESQUISAS', 'MODELO_TESTE', 'ENTRADA', 'MANHEIM_AUDIT', 'MANHEIM_CSV', 'RESPOSTA', 'RESPOSTA_ORIENTADA', 'TRADUCAO_CONVERSA', 'V2_DRAFT', 'ASSISTENTE'));
