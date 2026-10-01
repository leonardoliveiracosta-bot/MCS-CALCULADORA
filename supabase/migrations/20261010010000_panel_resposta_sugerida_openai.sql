-- Sugestões de resposta e retomada nas conversas (OpenAI) dentro do mesmo teto de US$ 50.
-- Aditiva: a reserva aceita a função RESPOSTA e o gasto gravado dessas sugestões (audit_log,
-- entity_type 'reply_suggestion_openai', after_json.costUsd) passa a contar no teto, como o CSV do
-- Manheim já conta. Nenhuma tabela nova; nenhuma mensagem é enviada por esta função.

alter table public.openai_budget_holds drop constraint if exists openai_budget_holds_feature_check;
alter table public.openai_budget_holds add constraint openai_budget_holds_feature_check
  check (feature in ('PESQUISAS', 'MODELO_TESTE', 'ENTRADA', 'MANHEIM_AUDIT', 'MANHEIM_CSV', 'RESPOSTA'));

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
                 where environment = p_environment and entity_type in ('manheim_openai', 'reply_suggestion_openai')
                   and jsonb_typeof(after_json->'costUsd') = 'number'), 0)
  )::numeric, 6)
$$;
revoke all on function public.panel_openai_spent_usd(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_openai_spent_usd(public.panel_environment) to service_role;
