-- Contabilidade das IAs: preservar os valores anteriores antes de corrigir o erro
-- de unidade no V2_DRAFT (preço por milhão multiplicado como preço por token).
-- O padrão abaixo é impossível dentro da reserva dessa função; nenhuma outra
-- função/modelo nem saldo informado pelo dono é alterado.
with backup as (
  insert into public.audit_log(environment, entity_type, entity_id, action, before_json, after_json)
  select h.environment, 'ai_cost_correction', h.id, 'V2_COST_UNIT',
    jsonb_build_object('actualUsd', h.actual_usd, 'amountUsd', h.amount_usd, 'status', h.status, 'model', h.model),
    jsonb_build_object('actualUsd', round(h.actual_usd / 1000000, 6), 'reason', 'price_per_million')
  from public.openai_budget_holds h
  where h.feature = 'V2_DRAFT' and h.model = 'gpt-6-luna'
    and h.status in ('PAGA', 'REGISTRADA')
    and h.actual_usd > 1 and h.actual_usd > h.amount_usd * 1000
    and not exists (select 1 from public.audit_log a where a.environment = h.environment
      and a.entity_type = 'ai_cost_correction' and a.entity_id = h.id and a.action = 'V2_COST_UNIT')
  returning entity_id, after_json
)
update public.openai_budget_holds h set actual_usd = (b.after_json->>'actualUsd')::numeric
from backup b where h.id = b.entity_id;

-- As reservas antigas da V2 eram marcadas REGISTRADA sem um registro durável
-- de custo. Recuperar uma vez, usando o ID da reserva. O código novo também
-- grava esse ID, para que reaplicar a migração nunca duplique o gasto.
insert into public.audit_log(environment, entity_type, entity_id, action, after_json, created_at)
select h.environment, 'v2_draft_openai', h.id, 'COST_BACKFILL',
  jsonb_build_object('provider', 'openai', 'model', h.model, 'costUsd', h.actual_usd,
    'budgetHoldId', h.id::text, 'source', 'budget_backfill'), h.created_at
from public.openai_budget_holds h
where h.feature = 'V2_DRAFT' and h.status = 'REGISTRADA'
  and not exists (select 1 from public.audit_log a where a.environment = h.environment
    and a.entity_type = 'v2_draft_openai' and a.after_json->>'budgetHoldId' = h.id::text);

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
                   and entity_type in ('manheim_openai', 'reply_suggestion_openai', 'reply_guided_openai',
                     'conversation_translation_openai', 'unlock_sale_openai', 'v2_draft_openai')
                   and jsonb_typeof(after_json->'costUsd') = 'number'), 0)
    -- O assistente guarda seu custo na própria reserva, sem tabela de custo.
    -- PAGA continua contado por panel_ai_balance_state; somar apenas REGISTRADA aqui.
    + coalesce((select sum(actual_usd) from public.openai_budget_holds
                 where environment = p_environment and feature = 'ASSISTENTE' and status = 'REGISTRADA'), 0)
  )::numeric, 6)
$$;
revoke all on function public.panel_openai_spent_usd(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_openai_spent_usd(public.panel_environment) to service_role;
