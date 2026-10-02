-- Desfazer imediato em duas ações reversíveis que até aqui não tinham volta: "apresentar" um carro
-- e "ligar pedido à ficha" (a Ref sugerida). Aditiva: uma coluna nova, três funções novas; as
-- funções antigas continuam iguais. Envio de mensagem nunca tem desfazer (continua com confirmação).

-- ------------------------------------------------------------------ apresentar
-- Desfaz uma apresentação recém-registrada pela mesma pessoa (até 30 minutos), antes de qualquer
-- resposta do cliente sobre o carro. Volta a etapa, a data de início da busca e o passo do
-- acompanhamento para o que eram, quando nenhuma outra unidade justifica a etapa.
create or replace function public.panel_unit_present_undo(
  p_environment public.panel_environment,
  p_unit_id uuid,
  p_actor uuid,
  p_previous_stage text default null,
  p_previous_search_started_at timestamptz default null,
  p_ref text default null,
  p_previous_tracking_step integer default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_unit public.units%rowtype;
  v_other boolean;
begin
  select * into v_unit from public.units where id = p_unit_id and environment = p_environment for update;
  if not found then raise exception 'UNIT_NOT_FOUND'; end if;
  if v_unit.created_by is distinct from p_actor then raise exception 'UNDO_NOT_ALLOWED'; end if;
  if v_unit.created_at < now() - interval '30 minutes' then raise exception 'UNDO_EXPIRED'; end if;
  if v_unit.last_customer_response_at is not null then raise exception 'UNIT_HAS_RESPONSE'; end if;
  if exists (select 1 from public.lead_events where environment = p_environment and unit_id = p_unit_id and event_type <> 'CAR_PRESENTED') then
    raise exception 'UNIT_IN_USE';
  end if;
  delete from public.lead_events where environment = p_environment and unit_id = p_unit_id and event_type = 'CAR_PRESENTED';
  update public.manheim_matches set presented_unit_id = null where environment = p_environment and presented_unit_id = p_unit_id;
  delete from public.units where id = p_unit_id;
  v_other := exists (select 1 from public.units where environment = p_environment and journey_id = v_unit.journey_id and status <> 'WITHDRAWN');
  if not v_other and p_previous_stage is not null then
    update public.journeys set stage = p_previous_stage::public.panel_journey_stage, search_started_at = p_previous_search_started_at, updated_at = now(), updated_by = p_actor
      where id = v_unit.journey_id and environment = p_environment and coalesce(stage_frozen, false) = false;
  end if;
  if p_ref is not null and p_previous_tracking_step is not null then
    update public.lead_tracking set step = p_previous_tracking_step, updated_at = now()
      where environment = p_environment and ref_code = p_ref and step = 2 and p_previous_tracking_step < 2;
  end if;
  return jsonb_build_object('undone', true, 'unitId', p_unit_id, 'stageRestored', not v_other and p_previous_stage is not null);
end $$;

-- ------------------------------------------------------------------ ligar pedido à ficha
alter table public.whatsapp_link_suggestions add column if not exists undo_json jsonb;

-- The same resolution as panel_whatsapp_resolve_suggestion; when a Ref is linked, the state before
-- is kept so the link can be undone right away.
create or replace function public.panel_whatsapp_resolve_suggestion_undoable(
  p_environment public.panel_environment, p_id uuid, p_actor uuid, p_link boolean
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.whatsapp_link_suggestions%rowtype;
  v_before jsonb;
  v_result jsonb;
begin
  select * into s from public.whatsapp_link_suggestions where id = p_id and environment = p_environment;
  if found and p_link and s.target_ref is not null and s.status = 'PENDING' then
    select jsonb_build_object(
      'reference_code', (select reference_code from public.journeys where id = s.source_journey_id and environment = p_environment),
      'ref_existed', exists (select 1 from public.journey_refs where environment = p_environment and journey_id = s.source_journey_id and trim(ref_code) = trim(s.target_ref)),
      'links', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'contact_id', l.contact_id, 'journey_id', l.journey_id, 'linked_at', l.linked_at, 'linked_by', l.linked_by))
        from public.calculator_request_links l where l.environment = p_environment and trim(l.calc_ref) = trim(s.target_ref)), '[]'::jsonb),
      'retry_requested', (select bool_or(retry_requested) from public.conversation_ai_link_state st where st.environment = p_environment and st.journey_id = s.source_journey_id and st.chat_id = coalesce(s.source_chat_id, st.chat_id)),
      'actor', p_actor, 'at', now()
    ) into v_before;
  end if;
  v_result := public.panel_whatsapp_resolve_suggestion(p_environment, p_id, p_actor, p_link);
  if v_before is not null then
    update public.whatsapp_link_suggestions set undo_json = v_before where id = p_id and environment = p_environment;
  end if;
  return v_result || jsonb_build_object('undoable', v_before is not null, 'suggestionId', p_id);
end $$;

-- Undoes a Ref link made by the same person in the last 30 minutes: the Ref leaves the ficha (when
-- it was added by the link), the calculator links go back to where they were and the suggestion is
-- pending again.
create or replace function public.panel_whatsapp_link_ref_undo(
  p_environment public.panel_environment, p_id uuid, p_actor uuid
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.whatsapp_link_suggestions%rowtype;
  v jsonb;
  l jsonb;
begin
  select * into s from public.whatsapp_link_suggestions where id = p_id and environment = p_environment for update;
  if not found or s.status <> 'LINKED' or s.undo_json is null then raise exception 'UNDO_UNAVAILABLE'; end if;
  v := s.undo_json;
  if (v->>'actor')::uuid is distinct from p_actor then raise exception 'UNDO_NOT_ALLOWED'; end if;
  if (v->>'at')::timestamptz < now() - interval '30 minutes' then raise exception 'UNDO_EXPIRED'; end if;
  if not coalesce((v->>'ref_existed')::boolean, false) then
    delete from public.journey_refs where environment = p_environment and journey_id = s.source_journey_id and trim(ref_code) = trim(s.target_ref);
  end if;
  if v->>'reference_code' is null then
    update public.journeys set reference_code = null, updated_at = now(), updated_by = p_actor
      where id = s.source_journey_id and environment = p_environment and trim(reference_code) = trim(s.target_ref);
  end if;
  for l in select * from jsonb_array_elements(coalesce(v->'links', '[]'::jsonb)) loop
    update public.calculator_request_links set contact_id = nullif(l->>'contact_id', '')::uuid, journey_id = nullif(l->>'journey_id', '')::uuid,
      linked_at = (l->>'linked_at')::timestamptz, linked_by = (l->>'linked_by')::uuid
      where id = (l->>'id')::uuid and environment = p_environment;
  end loop;
  update public.conversation_ai_link_state st set retry_requested = coalesce((v->>'retry_requested')::boolean, false)
    where st.environment = p_environment and st.journey_id = s.source_journey_id and st.chat_id = coalesce(s.source_chat_id, st.chat_id);
  update public.whatsapp_link_suggestions set status = 'PENDING', resolved_at = null, resolved_by = null, undo_json = null where id = p_id;
  return jsonb_build_object('undone', true, 'suggestionId', p_id);
end $$;

revoke all on function public.panel_unit_present_undo(public.panel_environment, uuid, uuid, text, timestamptz, text, integer) from public, anon, authenticated;
revoke all on function public.panel_whatsapp_resolve_suggestion_undoable(public.panel_environment, uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.panel_whatsapp_link_ref_undo(public.panel_environment, uuid, uuid) from public, anon, authenticated;
grant execute on function public.panel_unit_present_undo(public.panel_environment, uuid, uuid, text, timestamptz, text, integer) to service_role;
grant execute on function public.panel_whatsapp_resolve_suggestion_undoable(public.panel_environment, uuid, uuid, boolean) to service_role;
grant execute on function public.panel_whatsapp_link_ref_undo(public.panel_environment, uuid, uuid) to service_role;
