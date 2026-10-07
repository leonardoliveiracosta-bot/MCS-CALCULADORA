-- Destino da mensagem da calculadora: ligar a uma ficha cuja ligação foi desfeita antes (a fila antiga desfazia a ligação
-- automática) reativa a mesma linha. Antes a função via a linha desfeita, achava que já estava ligada e não religava:
-- 5 mensagens em produção ficaram "ligadas" na rota e fora da ficha (4NRJ5, T8PC9, M482Y e duas decisões manuais).
create or replace function public.panel_calc_route_apply(
  p_environment public.panel_environment, p_message_id uuid, p_destination text, p_reason text, p_ref_state text, p_ref text,
  p_journey_id uuid, p_evidence jsonb, p_rule_version integer, p_link boolean default false, p_create boolean default false,
  p_manual boolean default false, p_actor uuid default null, p_unlink_auto boolean default false, p_ref_source text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare v_contact uuid; v_channel text; v_journey uuid := p_journey_id; v_previous public.panel_calc_message_route; v_ref text; v_linked boolean := false; v_created boolean := false; v_unlinked uuid[] := '{}';
begin
  perform pg_advisory_xact_lock(hashtext('calc-route:' || p_environment::text || ':' || p_message_id::text));
  select c.contact_id, m.channel::text into v_contact, v_channel from public.messages m left join public.chats c on c.id = m.chat_id
    where m.environment = p_environment and m.id = p_message_id and m.undone_at is null and m.direction = 'CUSTOMER';
  if not found then raise exception 'CALC_ROUTE_MESSAGE_NOT_FOUND'; end if;
  select * into v_previous from public.panel_calc_message_route r where r.environment = p_environment and r.message_id = p_message_id;
  if found and v_previous.manual and not p_manual then return jsonb_build_object('skipped', 'MANUAL'); end if;
  v_ref := case when coalesce(p_ref, '') ~ '^[A-HJ-NP-Z2-9]{5}$' then p_ref end;
  if p_create then
    if v_contact is null then return jsonb_build_object('skipped', 'NO_CONTACT'); end if;
    if exists (select 1 from public.message_journeys mj where mj.environment = p_environment and mj.message_id = p_message_id and mj.undone_at is null)
      or (not p_manual and exists (select 1 from public.journeys j where j.environment = p_environment and j.contact_id = v_contact)) then
      return jsonb_build_object('skipped', 'ALREADY_HAS_JOURNEY');
    end if;
    insert into public.journeys(environment, contact_id, reference_code, source, stage, status, criteria_json, created_at, updated_at)
      values (p_environment, v_contact,
        case when v_ref is not null and not exists (select 1 from public.journeys j where j.environment = p_environment and j.reference_code = v_ref)
          and not exists (select 1 from public.journey_refs r where r.environment = p_environment and r.ref_code = v_ref) then v_ref end,
        (case when v_channel = 'SMS' then 'SMS_DIRECT' else 'WHATSAPP_DIRECT' end)::public.panel_journey_source, 'NOVO', 'ATIVO', '{}'::jsonb, now(), now())
      returning id into v_journey;
    insert into public.journey_checklist(environment, journey_id, point_number, point_label, status, created_at, updated_at)
      select p_environment, v_journey, n, (array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[n],
        'OPEN'::public.panel_checklist_status, now(), now() from generate_series(1, 6) n;
    v_created := true;
  end if;
  if (p_link or v_created) and v_journey is not null then
    if not exists (select 1 from public.journeys j where j.environment = p_environment and j.id = v_journey) then raise exception 'CALC_ROUTE_JOURNEY_NOT_FOUND'; end if;
    -- A link undone before (the old queue undid it) is the same row (unique per message and ficha): it is brought back,
    -- otherwise the message would stay out of the ficha while the route says it is linked.
    if not exists (select 1 from public.message_journeys mj where mj.environment = p_environment and mj.message_id = p_message_id and mj.journey_id = v_journey and mj.undone_at is null) then
      update public.message_journeys mj set undone_at = null, undone_by = null, association_source = case when p_manual then 'CALC_ROUTE_MANUAL' else 'CALC_ROUTE' end, associated_at = now(), associated_by = p_actor
        where mj.environment = p_environment and mj.message_id = p_message_id and mj.journey_id = v_journey;
      if not found then
        insert into public.message_journeys(environment, message_id, journey_id, association_source, associated_at, associated_by)
          values (p_environment, p_message_id, v_journey, case when p_manual then 'CALC_ROUTE_MANUAL' else 'CALC_ROUTE' end, now(), p_actor);
      end if;
      v_linked := true;
    end if;
  end if;
  -- To the queue: the link the ingestion chose by itself (latest ficha of the phone) is undone, so the message is in one place only.
  -- Links made by a person or by an import (history, print, entry) are never touched.
  if p_unlink_auto and p_destination = 'FILA' then
    with gone as (
      update public.message_journeys mj set undone_at = now(), undone_by = p_actor
      where mj.environment = p_environment and mj.message_id = p_message_id and mj.undone_at is null and mj.association_source in ('WHATSAPP_WEBHOOK', 'SMS_SHORTCUT', 'CALC_ROUTE')
      returning mj.journey_id)
    select coalesce(array_agg(journey_id), '{}') into v_unlinked from gone;
  end if;
  insert into public.panel_calc_message_route(environment, message_id, destination, reason, ref_state, ref, ref_source, journey_id, evidence, rule_version, manual, decided_by, decided_at, updated_at)
    values (p_environment, p_message_id, p_destination, p_reason, p_ref_state, v_ref, case when v_ref is not null and p_ref_source in ('TEXTO','PRINT') then p_ref_source end, v_journey, coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('linkedNow', v_linked, 'createdJourney', v_created, 'unlinkedAuto', to_jsonb(v_unlinked)), p_rule_version, p_manual, p_actor, now(), now())
    on conflict (environment, message_id) do update set destination = excluded.destination, reason = excluded.reason, ref_state = excluded.ref_state, ref = excluded.ref, ref_source = excluded.ref_source,
      journey_id = excluded.journey_id, evidence = excluded.evidence, rule_version = excluded.rule_version, manual = excluded.manual, decided_by = excluded.decided_by,
      decided_at = case when panel_calc_message_route.destination = excluded.destination and panel_calc_message_route.journey_id is not distinct from excluded.journey_id then panel_calc_message_route.decided_at else now() end,
      updated_at = now();
  return jsonb_build_object('journeyId', v_journey, 'linked', v_linked, 'createdJourney', v_created, 'unlinked', to_jsonb(v_unlinked), 'destination', p_destination);
end;
$$;
revoke all on function public.panel_calc_route_apply(public.panel_environment, uuid, text, text, text, text, uuid, jsonb, integer, boolean, boolean, boolean, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.panel_calc_route_apply(public.panel_environment, uuid, text, text, text, text, uuid, jsonb, integer, boolean, boolean, boolean, uuid, boolean, text) to service_role;

