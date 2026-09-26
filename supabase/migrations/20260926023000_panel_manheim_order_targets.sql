-- Allow Manheim results to target either an existing journey or a grouped calculator Ref.

create or replace function public.panel_store_manheim_upload(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_source_file_count integer,
  p_vehicle_count integer,
  p_headers jsonb,
  p_header_map jsonb,
  p_matches jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload_id uuid;
  v_match jsonb;
  v_journey_id uuid;
  v_calc_ref char(5);
  v_kind text;
  v_state record;
  v_match_count integer := 0;
  v_lead_count integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  if p_source_file_count not between 1 and 20
     or p_vehicle_count not between 0 and 100000
     or jsonb_typeof(p_headers) <> 'array'
     or jsonb_typeof(p_header_map) <> 'object'
     or jsonb_typeof(p_matches) <> 'array'
     or jsonb_array_length(p_matches) > 2000
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  insert into public.manheim_uploads(
    environment, source_file_count, vehicle_count, headers_json, header_map, uploaded_at, created_by
  ) values (
    p_environment, p_source_file_count, p_vehicle_count, p_headers, p_header_map, v_now, p_actor_id
  ) returning id into v_upload_id;

  for v_match in select value from jsonb_array_elements(p_matches) loop
    v_kind := v_match ->> 'kind';
    if v_kind not in ('BATE','QUASE')
       or length(coalesce(v_match ->> 'fingerprint', '')) not between 3 and 200
       or jsonb_typeof(v_match -> 'vehicle') <> 'object'
       or octet_length((v_match -> 'vehicle')::text) > 65536
    then raise exception 'MANHEIM_MATCH_INVALID'; end if;

    if coalesce(v_match ->> 'targetType','') = 'ORDER' then
      v_journey_id := null;
      v_calc_ref := upper(nullif(v_match ->> 'calcRef',''))::char(5);
      if v_calc_ref is null or v_calc_ref::text !~ '^[A-HJ-NP-Z2-9]{5}$'
      then raise exception 'MANHEIM_ORDER_REF_INVALID'; end if;

      if not exists (
        select 1
        from public.calc_runs cr
        where not cr.is_test
          and upper(coalesce(cr.dados ->> 'ref','')) = trim(v_calc_ref::text)
      ) then raise exception 'MANHEIM_ORDER_NOT_FOUND'; end if;

      if exists (
        select 1
        from public.panel_item_dispositions d
        where d.environment = p_environment
          and d.item_kind = 'REF'
          and upper(d.item_key) = trim(v_calc_ref::text)
          and d.status = 'DISCARDED'
      ) then raise exception 'MANHEIM_ORDER_DISCARDED'; end if;
    else
      v_calc_ref := null;
      begin
        v_journey_id := (v_match ->> 'journeyId')::uuid;
      exception when others then
        raise exception 'MANHEIM_JOURNEY_ID_INVALID';
      end;

      select j.status, coalesce(ts.enabled, j.status <> 'ENCERRADO') as enabled, ts.off_reason
        into v_state
      from public.journeys j
      left join public.journey_toggle_states ts
        on ts.environment = j.environment and ts.journey_id = j.id
      where j.environment = p_environment and j.id = v_journey_id;

      if not found then raise exception 'MANHEIM_JOURNEY_NOT_FOUND'; end if;
      if not v_state.enabled and (coalesce(v_state.off_reason, '') not in ('GAVE_UP','NO_RESPONSE') or v_kind <> 'BATE') then
        raise exception 'MANHEIM_JOURNEY_DISABLED';
      end if;
      if v_state.enabled and v_state.status = 'PARADO' and v_kind <> 'BATE' then
        raise exception 'MANHEIM_REACTIVATION_REQUIRES_MATCH';
      end if;
    end if;

    insert into public.manheim_matches(
      environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status,
      row_fingerprint, vehicle_json, created_at
    ) values (
      p_environment, v_upload_id, v_journey_id, v_calc_ref, v_kind,
      nullif(left(v_match ->> 'reason', 500), ''),
      case when v_match ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then v_match ->> 'mmrStatus' else null end,
      v_match ->> 'fingerprint', v_match -> 'vehicle', v_now
    ) on conflict do nothing;
  end loop;

  select count(*),
         count(distinct case
           when journey_id is not null then 'j:' || journey_id::text
           else 'r:' || trim(calc_ref::text)
         end)
    into v_match_count, v_lead_count
  from public.manheim_matches
  where environment = p_environment and upload_id = v_upload_id;

  update public.manheim_uploads
     set matched_vehicle_count = v_match_count, lead_count = v_lead_count
   where id = v_upload_id and environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (
    p_environment, 'MANHEIM_UPLOAD_COMPLETED', 'Exportação do Manheim comparada',
    jsonb_build_object('upload_id', v_upload_id, 'vehicle_count', p_vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count),
    v_now, p_actor_id
  );

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (
    p_environment, p_actor_id, 'manheim_upload', v_upload_id, 'CREATE',
    jsonb_build_object('vehicle_count', p_vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count), v_now
  );

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', v_upload_id, v_now);

  return jsonb_build_object('uploadId', v_upload_id, 'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count);
end;
$$;

revoke all on function public.panel_store_manheim_upload(public.panel_environment, uuid, integer, integer, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.panel_store_manheim_upload(public.panel_environment, uuid, integer, integer, jsonb, jsonb, jsonb)
  to service_role;
