-- Audit C3 / rule R2: marking "Teto" on a customer message records the customer's TOTAL
-- ceiling in journeys.confirmed_total_ceiling_cents (value_json.ceilingCents, parsed and
-- confirmed in the panel). It never writes journeys.budget_cents (maximum bid) and it refuses a
-- closed ficha.
-- Additive: this creates panel_mark_message_fact_v2 and leaves panel_mark_message_fact (used by
-- the currently published panel) untouched.
-- DEPLOY ORDER MATTERS: apply this migration BEFORE publishing the panel code that calls the V2.
-- Between the two steps, do not use "Marcar Teto" in the old panel (it still writes budget_cents).

create or replace function public.panel_mark_message_fact_v2(
  p_environment public.panel_environment,
  p_journey_id uuid,
  p_message_id uuid,
  p_kind text,
  p_actor_id uuid,
  p_value text default null,
  p_value_json jsonb default '{}'::jsonb,
  p_deadline_at timestamptz default null,
  p_simulate_failure boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_point smallint;
  v_field public.panel_declaration_field;
  v_mark_id uuid;
  v_checklist_id uuid;
  v_declaration_id uuid;
  v_contact_id uuid;
  v_chat_id uuid;
  v_message_text text;
  v_message_at timestamptz;
  v_result jsonb;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then
    raise exception 'PANEL_ACTOR_NOT_AUTHORIZED';
  end if;

  case p_kind
    when 'VEHICLE' then v_point := 1; v_field := 'VEICULO';
    when 'BUDGET' then v_point := 2; v_field := 'TETO';
    when 'PAYMENT' then v_point := 3; v_field := 'PAGAMENTO';
    when 'DEADLINE' then v_point := 4; v_field := 'PRAZO';
    when 'OUTSIDE_FLORIDA' then v_point := 5; v_field := null;
    when 'NO_TEST_DRIVE' then v_point := 6; v_field := null;
    else raise exception 'MESSAGE_MARK_KIND_INVALID';
  end case;

  if p_value is not null and (length(btrim(p_value)) = 0 or length(p_value) > 500) then
    raise exception 'MESSAGE_MARK_VALUE_INVALID';
  end if;

  select j.contact_id into v_contact_id
  from public.journeys j
  where j.id = p_journey_id and j.environment = p_environment
  for update;
  if not found then raise exception 'JOURNEY_NOT_FOUND'; end if;
  if p_kind = 'BUDGET' and exists (
    select 1 from public.journeys j where j.id = p_journey_id and j.environment = p_environment and j.status = 'ENCERRADO'
  ) then raise exception 'JOURNEY_CLOSED'; end if;

  select m.chat_id, left(m.body_text, 1000), coalesce(m.occurred_at_utc, m.created_at)
    into v_chat_id, v_message_text, v_message_at
  from public.messages m
  join public.message_journeys mj
    on mj.message_id = m.id
   and mj.journey_id = p_journey_id
   and mj.environment = p_environment
  where m.id = p_message_id
    and m.environment = p_environment
    and m.direction = 'CUSTOMER';
  if not found then raise exception 'MESSAGE_MARK_INVALID'; end if;

  select jc.id into v_checklist_id
  from public.journey_checklist jc
  where jc.environment = p_environment
    and jc.journey_id = p_journey_id
    and jc.point_number = v_point
  for update;
  if not found then raise exception 'CHECKLIST_POINT_NOT_FOUND'; end if;

  begin
    insert into public.message_fact_marks(
      environment, journey_id, message_id, kind, created_at, created_by
    ) values (
      p_environment, p_journey_id, p_message_id, p_kind, v_now, p_actor_id
    )
    on conflict (environment, journey_id, message_id, kind) do nothing
    returning id into v_mark_id;

    if v_mark_id is null then
      select mfm.result_json into v_result
      from public.message_fact_marks mfm
      where mfm.environment = p_environment
        and mfm.journey_id = p_journey_id
        and mfm.message_id = p_message_id
        and mfm.kind = p_kind;
      if v_result is null then raise exception 'MESSAGE_MARK_RESULT_MISSING'; end if;
      return v_result;
    end if;

    insert into public.checklist_evidence(
      environment, checklist_id, message_id, excerpt_text, created_at, created_by
    ) values (
      p_environment, v_checklist_id, p_message_id, v_message_text, v_now, p_actor_id
    )
    on conflict (environment, checklist_id, message_id) do nothing;

    update public.journey_checklist
      set status = 'COMPLETE', completed_at = coalesce(completed_at, v_now), updated_at = v_now
    where id = v_checklist_id and environment = p_environment;

    if p_simulate_failure then
      raise exception 'PANEL_SIMULATED_MESSAGE_MARK_FAILURE';
    end if;

    if v_field is not null then
      if p_value is null then raise exception 'MESSAGE_MARK_VALUE_REQUIRED'; end if;
      insert into public.journey_declarations(
        environment, journey_id, field, source, value_text, value_json,
        message_id, declared_at, created_at, created_by
      ) values (
        p_environment, p_journey_id, v_field, 'CONVERSATION', p_value,
        coalesce(p_value_json, '{}'::jsonb), p_message_id, v_message_at, v_now, p_actor_id
      ) returning id into v_declaration_id;

      update public.journeys
      set vehicle_text = case when v_field = 'VEICULO' then p_value else vehicle_text end,
          payment_text = case when v_field = 'PAGAMENTO' then p_value else payment_text end,
          -- R2: TETO is the customer's total ceiling. It never changes budget_cents (maximum bid).
          confirmed_total_ceiling_cents = case
            when v_field = 'TETO' and jsonb_typeof(p_value_json -> 'ceilingCents') = 'number'
                 and (p_value_json ->> 'ceilingCents')::numeric between 100000 and 10000000000
              then (p_value_json ->> 'ceilingCents')::bigint
            else confirmed_total_ceiling_cents
          end,
          customer_deadline_text = case when v_field = 'PRAZO' then p_value else customer_deadline_text end,
          customer_deadline_at = case when v_field = 'PRAZO' and p_deadline_at is not null then p_deadline_at else customer_deadline_at end,
          updated_at = v_now,
          updated_by = p_actor_id
      where id = p_journey_id and environment = p_environment;
    end if;

    insert into public.activity_log(
      environment, journey_id, contact_id, chat_id, activity_type,
      summary, metadata, occurred_at, actor_user_id
    ) values (
      p_environment, p_journey_id, v_contact_id, v_chat_id, 'MESSAGE_FACT_MARKED',
      'Mensagem marcada na ficha e no checklist',
      jsonb_build_object('point_number', v_point, 'field', v_field, 'message_id', p_message_id),
      v_now, p_actor_id
    );

    insert into public.audit_log(
      environment, actor_user_id, entity_type, entity_id, action, after_json, created_at
    ) values (
      p_environment, p_actor_id, 'message_fact_mark', v_mark_id, 'MESSAGE_FACT_MARK',
      jsonb_build_object('point_number', v_point, 'field', v_field, 'message_id', p_message_id, 'declaration_id', v_declaration_id),
      v_now
    );

    insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
    values (p_environment, 'panel.updated', 'journey', p_journey_id, v_now);

    v_result := jsonb_build_object(
      'pointNumber', v_point,
      'field', v_field,
      'status', 'COMPLETE',
      'declarationId', v_declaration_id
    );
    update public.message_fact_marks
      set result_json = v_result
      where id = v_mark_id and environment = p_environment;
    return v_result;
  exception
    when others then
      if p_simulate_failure and sqlerrm = 'PANEL_SIMULATED_MESSAGE_MARK_FAILURE' then
        return jsonb_build_object('simulatedFailure', true, 'rolledBack', true);
      end if;
      raise;
  end;
end;
$$;

revoke all on function public.panel_mark_message_fact_v2(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) from public, anon, authenticated;
grant execute on function public.panel_mark_message_fact_v2(
  public.panel_environment, uuid, uuid, text, uuid, text, jsonb, timestamptz, boolean
) to service_role;
