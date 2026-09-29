-- A mark for ONE search ("Carro ou faixa" with mode CARRO or VALOR) must not change the ficha's
-- generic fields. Found in the PUB69 check: the per-mode mark left the last marked car in
-- criteria_json.wishlist (old declaration trigger) and in vehicle_text (this RPC).
--  * private.panel_sync_wishlist_declaration: a declaration whose value_json.mode is CARRO or
--    VALOR is ignored; without mode it behaves exactly as in 20260925180602.
--  * panel_mark_message_fact_v2: same signature, security definer and search_path as in
--    20261001010000. Only the per-mode branch changes: vehicle_text = value_json.vehicleText
--    (1 to 500 characters) or unchanged, never p_value; a payload with mode never feeds the generic
--    confirmedWishlists. A mark without mode is unchanged.
-- No row is rewritten. PUBLISH ORDER: this migration first (it is compatible with the current
-- panel: with mode and without vehicleText, vehicle_text simply stays), then the panel code that
-- sends vehicleText and stops sending value_json.wishlist.

create or replace function private.panel_sync_wishlist_declaration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.field = 'VEICULO'
     and jsonb_typeof(new.value_json -> 'wishlist') = 'object'
     and upper(coalesce(new.value_json ->> 'mode', '')) not in ('CARRO', 'VALOR')
  then
    update public.journeys
       set criteria_json = jsonb_set(
         coalesce(criteria_json, '{}'::jsonb),
         '{wishlist}',
         new.value_json -> 'wishlist',
         true
       )
     where id = new.journey_id
       and environment = new.environment;
  end if;
  return new;
end;
$$;

revoke all on function private.panel_sync_wishlist_declaration() from public, anon, authenticated;

-- "Carro ou faixa" marked on a message. Copy of 20261001010000 with the two changes above.
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
  -- M6: nothing marked on a message changes a closed journey (vehicle, ceiling, payment, deadline, checklist).
  if exists (
    select 1 from public.journeys j where j.id = p_journey_id and j.environment = p_environment and (j.status = 'ENCERRADO' or j.stage_frozen)
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
      set vehicle_text = case
            -- A mark for ONE search (value_json.mode) never writes the marked car as the ficha's
            -- vehicle: the panel sends vehicleText, the summary of every mode of the ficha. Without
            -- a usable vehicleText (older panel) vehicle_text stays as it is; p_value is never used here.
            when v_field = 'VEICULO' and upper(coalesce(p_value_json ->> 'mode', '')) in ('CARRO', 'VALOR')
              then case when length(btrim(coalesce(p_value_json ->> 'vehicleText', ''))) >= 1
                             and length(p_value_json ->> 'vehicleText') <= 500
                        then p_value_json ->> 'vehicleText' else vehicle_text end
            when v_field = 'VEICULO' then p_value
            else vehicle_text
          end,
          -- A:P17: "Carro ou faixa" confirmed on a message becomes the ficha's confirmed wishes (the
          -- panel sends the merged list: marked cars first, the other cars of the ficha kept).
          criteria_json = case
            -- buscas-split: a car or range marked for ONE search goes only to that mode
            -- (mode_overrides.CARRO or mode_overrides.VALOR); the generic list is untouched.
            when v_field = 'VEICULO' and p_value_json ->> 'mode' in ('CARRO', 'VALOR')
                 and jsonb_typeof(p_value_json -> 'modeWishlists') = 'array'
                 and jsonb_array_length(p_value_json -> 'modeWishlists') between 1 and 5
              then coalesce(criteria_json, '{}'::jsonb) || jsonb_build_object('mode_overrides',
                coalesce(criteria_json -> 'mode_overrides', '{}'::jsonb) || jsonb_build_object(p_value_json ->> 'mode',
                  jsonb_build_object('wishlists', p_value_json -> 'modeWishlists', 'wishlistOverride', true)))
            when v_field = 'VEICULO' and upper(coalesce(p_value_json ->> 'mode', '')) not in ('CARRO', 'VALOR')
                 and jsonb_typeof(p_value_json -> 'confirmedWishlists') = 'array'
                 and jsonb_array_length(p_value_json -> 'confirmedWishlists') between 1 and 5
              then coalesce(criteria_json, '{}'::jsonb) || jsonb_build_object('wishlists', p_value_json -> 'confirmedWishlists', 'wishlistOverride', true)
            else criteria_json
          end,
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
      jsonb_build_object('point_number', v_point, 'field', v_field, 'message_id', p_message_id, 'mode', p_value_json ->> 'mode'),
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
