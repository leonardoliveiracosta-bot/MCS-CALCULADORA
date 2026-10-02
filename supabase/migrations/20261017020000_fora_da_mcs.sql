-- Varredura de conversas fora da MCS: a leitura do Claude marca a CANDIDATA (motivo e frase original como evidência);
-- nada sai do painel sem a confirmação da operadora. Confirmada, a conversa vira "fora do funil" pela triagem que já existe
-- (some das listas, recuperável com Desfazer). Aditiva: colunas novas, uma função de término v3 e a revisão. Nada é apagado.
alter table public.panel_conversation_class add column if not exists offmcs_candidate boolean not null default false;
alter table public.panel_conversation_class add column if not exists offmcs_category text check (offmcs_category is null or offmcs_category in ('PESSOAL','VENDA_FORA_DO_SISTEMA','OUTRO_NEGOCIO'));
alter table public.panel_conversation_class add column if not exists offmcs_reason text;
alter table public.panel_conversation_class add column if not exists offmcs_quote text;
alter table public.panel_conversation_class add column if not exists offmcs_message_id uuid;
-- The operator's answer: CONFIRMADO (left the panel through the triage) or REJEITADO (it is MCS business). Never set by the AI.
alter table public.panel_conversation_class add column if not exists offmcs_review text check (offmcs_review is null or offmcs_review in ('CONFIRMADO','REJEITADO'));
alter table public.panel_conversation_class add column if not exists offmcs_reviewed_at timestamptz;
alter table public.panel_conversation_class add column if not exists offmcs_reviewed_by uuid references public.panel_users(id);
create index if not exists panel_conversation_class_offmcs_idx on public.panel_conversation_class(environment, offmcs_candidate) where offmcs_candidate and offmcs_review is null;
create index if not exists panel_conversation_class_offmcs_reviewer_idx on public.panel_conversation_class(offmcs_reviewed_by);

create or replace function public.panel_subject_finish_v3(p_environment public.panel_environment, p_journey_id uuid, p_token uuid, p_hash text, p_rule_version integer,
  p_subject text, p_confidence numeric, p_reason text, p_claude_refs jsonb, p_request_summaries jsonb, p_offmcs jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_candidate boolean := coalesce((p_offmcs->>'candidate')::boolean, false);
begin
  update public.panel_conversation_class set subject = p_subject, confidence = p_confidence, reason = left(p_reason, 500), claude_refs = coalesce(p_claude_refs, '[]'::jsonb),
    request_summaries = coalesce(p_request_summaries, '[]'::jsonb), input_hash = p_hash, rule_version = p_rule_version, classified_at = now(),
    fail_count = 0, fail_hash = null, next_try_at = null, claim_token = null, claimed_until = null,
    offmcs_candidate = v_candidate,
    offmcs_category = case when v_candidate and p_offmcs->>'category' in ('PESSOAL','VENDA_FORA_DO_SISTEMA','OUTRO_NEGOCIO') then p_offmcs->>'category' end,
    offmcs_reason = case when v_candidate then left(p_offmcs->>'reason', 300) end,
    offmcs_quote = case when v_candidate then left(p_offmcs->>'quote', 400) end,
    offmcs_message_id = case when v_candidate and coalesce(p_offmcs->>'messageId','') ~ '^[0-9a-f-]{36}$' then (p_offmcs->>'messageId')::uuid end
  where environment = p_environment and journey_id = p_journey_id and claim_token = p_token;
  return found;
end $$;
revoke all on function public.panel_subject_finish_v3(public.panel_environment, uuid, uuid, text, integer, text, numeric, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.panel_subject_finish_v3(public.panel_environment, uuid, uuid, text, integer, text, numeric, text, jsonb, jsonb, jsonb) to service_role;

-- The operator's review of a candidate (p_review null clears it, used by "Desfazer").
create or replace function public.panel_offmcs_review(p_environment public.panel_environment, p_journey_id uuid, p_review text, p_actor uuid)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_review is not null and p_review not in ('CONFIRMADO','REJEITADO') then raise exception 'OFFMCS_REVIEW_INVALID'; end if;
  update public.panel_conversation_class set offmcs_review = p_review, offmcs_reviewed_at = case when p_review is null then null else now() end,
    offmcs_reviewed_by = case when p_review is null then null else p_actor end
  where environment = p_environment and journey_id = p_journey_id;
  return found;
end $$;
revoke all on function public.panel_offmcs_review(public.panel_environment, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.panel_offmcs_review(public.panel_environment, uuid, text, uuid) to service_role;
