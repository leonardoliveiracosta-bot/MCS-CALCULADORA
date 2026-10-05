-- V2: rascunho da nota e da mensagem da V2 pela IA, no mesmo teto da OpenAI.
-- Aditiva: a reserva passa a aceitar a função nova (V2_DRAFT). Sem ela, a reserva é recusada
-- e o rascunho vem sempre vazio em produção. Nada é enviado ao cliente; a tela abre com os
-- padrões quando a IA falha.

alter table public.openai_budget_holds drop constraint if exists openai_budget_holds_feature_check;
alter table public.openai_budget_holds add constraint openai_budget_holds_feature_check
  check (feature in ('PESQUISAS', 'MODELO_TESTE', 'ENTRADA', 'MANHEIM_AUDIT', 'MANHEIM_CSV', 'RESPOSTA', 'RESPOSTA_ORIENTADA', 'TRADUCAO_CONVERSA', 'V2_DRAFT'));
