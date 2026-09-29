-- BUSCAS split by logical mode (VALOR = Calculate My Cost, CARRO = Find One For Me), undo of a
-- Manheim import batch and the OpenAI summary of a batch. Additive: no new table, no row is
-- deleted and no historical row is rewritten.
--  * manheim_matches.logical_mode: CARRO or VALOR for new rows; historical rows stay NULL.
--    The same upload, car and person can hold one CARRO and one VALOR match.
--    A CARRO match is always BATE (no tolerance, no QUASE in CARRO).
--  * manheim_uploads / manheim_matches / manheim_vehicles.undone_at: a batch that was undone
--    leaves every operational read; units, vitrines and vitrine cars are preserved untouched.
--  * manheim_uploads.ai_summary_json: the OpenAI usage of the batch (provider, model, tokens,
--    estimated cost, rows sent to review). Never the prompt.
--  * panel_search_marks.logical_mode: "busca salva" and "enviei opções" per mode.
--  * panel_store_manheim_upload and panel_store_manheim_upload_part keep their signatures and
--    store the mode of each match; panel_undo_manheim_upload is new.

alter table public.manheim_matches add column if not exists logical_mode public.panel_logical_mode;
alter table public.manheim_matches add column if not exists undone_at timestamptz;
alter table public.manheim_vehicles add column if not exists undone_at timestamptz;
alter table public.manheim_uploads add column if not exists undone_at timestamptz;
alter table public.manheim_uploads add column if not exists undone_by uuid references public.panel_users(id);
alter table public.manheim_uploads add column if not exists undo_summary jsonb;
alter table public.manheim_uploads add column if not exists ai_summary_json jsonb;
alter table public.panel_search_marks add column if not exists logical_mode public.panel_logical_mode;

-- One match per upload, car, target and mode. The old uniqueness (without the mode) is replaced
-- by indexes that include it; historical rows (mode NULL) keep being unique as before.
do $$
declare v_name text;
begin
  select c.conname into v_name
    from pg_constraint c
   where c.conrelid = 'public.manheim_matches'::regclass and c.contype = 'u'
     and pg_get_constraintdef(c.oid) = 'UNIQUE (environment, upload_id, journey_id, row_fingerprint)';
  if v_name is not null then
    execute format('alter table public.manheim_matches drop constraint %I', v_name);
  end if;
end $$;

drop index if exists public.manheim_matches_order_unique_idx;

create unique index if not exists manheim_matches_journey_mode_unique_idx
  on public.manheim_matches(environment, upload_id, journey_id, row_fingerprint, logical_mode) nulls not distinct
  where journey_id is not null;
create unique index if not exists manheim_matches_order_mode_unique_idx
  on public.manheim_matches(environment, upload_id, calc_ref, row_fingerprint, logical_mode) nulls not distinct
  where calc_ref is not null;
create index if not exists manheim_matches_active_upload_idx
  on public.manheim_matches(environment, upload_id, logical_mode) where undone_at is null;
create index if not exists manheim_uploads_active_idx
  on public.manheim_uploads(environment, uploaded_at desc) where undone_at is null;
create index if not exists manheim_uploads_undone_by_idx on public.manheim_uploads(undone_by);
create index if not exists manheim_vehicles_active_recent_idx
  on public.manheim_vehicles(environment, uploaded_at desc) where undone_at is null;
create index if not exists panel_search_marks_active_mode_idx
  on public.panel_search_marks(environment, journey_id, kind, logical_mode, created_at desc) where undone_at is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.manheim_matches'::regclass and conname = 'manheim_matches_carro_bate_check') then
    alter table public.manheim_matches
      add constraint manheim_matches_carro_bate_check check (logical_mode is distinct from 'CARRO' or match_kind = 'BATE');
  end if;
end $$;

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
  v_mode text;
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
    v_mode := nullif(v_match ->> 'mode', '');
    if v_kind not in ('BATE','POR_VALOR','QUASE')
       or (v_mode is not null and v_mode not in ('CARRO','VALOR'))
       or (v_mode = 'CARRO' and v_kind <> 'BATE')
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
          and d.cleared_at is null
      ) then raise exception 'MANHEIM_ORDER_DISCARDED'; end if;
    else
      v_calc_ref := null;
      begin
        v_journey_id := (v_match ->> 'journeyId')::uuid;
      exception when others then
        raise exception 'MANHEIM_JOURNEY_ID_INVALID';
      end;

      -- A5: ENCERRADO always wins over the on/off switch.
      select j.status, (j.status <> 'ENCERRADO' and coalesce(ts.enabled, true)) as enabled, ts.off_reason
        into v_state
      from public.journeys j
      left join public.journey_toggle_states ts
        on ts.environment = j.environment and ts.journey_id = j.id
      where j.environment = p_environment and j.id = v_journey_id;

      if not found then raise exception 'MANHEIM_JOURNEY_NOT_FOUND'; end if;
      if v_state.status = 'ENCERRADO'
         or (not v_state.enabled and (coalesce(v_state.off_reason, '') not in ('GAVE_UP','NO_RESPONSE') or v_kind <> 'BATE')) then
        raise exception 'MANHEIM_JOURNEY_DISABLED';
      end if;
      if v_state.enabled and v_state.status = 'PARADO' and v_kind <> 'BATE' then
        raise exception 'MANHEIM_REACTIVATION_REQUIRES_MATCH';
      end if;
    end if;

    insert into public.manheim_matches(
      environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status,
      row_fingerprint, vehicle_json, logical_mode, created_at
    ) values (
      p_environment, v_upload_id, v_journey_id, v_calc_ref, v_kind,
      nullif(left(v_match ->> 'reason', 500), ''),
      case when v_match ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then v_match ->> 'mmrStatus' else null end,
      v_match ->> 'fingerprint', v_match -> 'vehicle', v_mode::public.panel_logical_mode, v_now
    ) on conflict do nothing;
  end loop;

  select count(*),
         -- Only BATE and POR_VALOR serve a customer; QUASE never counts.
         count(distinct case
           when match_kind not in ('BATE', 'POR_VALOR') then null
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

create or replace function public.panel_store_manheim_upload_part(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid,
  p_part_index integer,
  p_part_count integer,
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
  v_draft public.manheim_upload_drafts%rowtype;
  v_match jsonb;
  v_valid jsonb := '[]'::jsonb;
  v_journey_id uuid;
  v_calc_ref char(5);
  v_kind text;
  v_mode text;
  v_state record;
  v_stored_parts integer;
  v_match_count integer := 0;
  v_lead_count integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  if p_part_count is null or p_part_count not between 1 and 400
     or p_part_index is null or p_part_index not between 1 and p_part_count
     or jsonb_typeof(p_matches) <> 'array'
     or jsonb_array_length(p_matches) > 250
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  if p_upload_id is null then
    if p_part_index <> 1
       or p_source_file_count is null or p_source_file_count not between 1 and 20
       or p_vehicle_count is null or p_vehicle_count not between 0 and 100000
       or jsonb_typeof(p_headers) <> 'array'
       or jsonb_typeof(p_header_map) <> 'object'
    then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

    delete from public.manheim_upload_drafts d
     where d.environment = p_environment
       and d.completed_at is null
       and d.created_at < v_now - interval '1 day';

    insert into public.manheim_upload_drafts(
      environment, source_file_count, vehicle_count, headers_json, header_map, part_count, created_at, created_by
    ) values (
      p_environment, p_source_file_count, p_vehicle_count, p_headers, p_header_map, p_part_count, v_now, p_actor_id
    ) returning * into v_draft;
  else
    select * into v_draft
      from public.manheim_upload_drafts d
     where d.id = p_upload_id and d.environment = p_environment
     for update;
    if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
    if v_draft.part_count <> p_part_count then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

    if v_draft.completed_at is not null then
      -- Retry of the last part after it was already stored: answer with the same result.
      if p_part_index <> v_draft.part_count then raise exception 'MANHEIM_UPLOAD_ALREADY_COMPLETE'; end if;
      select u.matched_vehicle_count, u.lead_count into v_match_count, v_lead_count
        from public.manheim_uploads u
       where u.id = v_draft.id and u.environment = p_environment;
      return jsonb_build_object('uploadId', v_draft.id, 'complete', true, 'partIndex', p_part_index,
        'partCount', v_draft.part_count, 'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count);
    end if;

    if p_part_index > v_draft.received_parts + 1 then raise exception 'MANHEIM_UPLOAD_PART_OUT_OF_ORDER'; end if;
  end if;

  for v_match in select value from jsonb_array_elements(p_matches) loop
    v_kind := v_match ->> 'kind';
    v_mode := nullif(v_match ->> 'mode', '');
    if v_kind not in ('BATE','POR_VALOR','QUASE')
       or (v_mode is not null and v_mode not in ('CARRO','VALOR'))
       or (v_mode = 'CARRO' and v_kind <> 'BATE')
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
          and d.cleared_at is null
      ) then raise exception 'MANHEIM_ORDER_DISCARDED'; end if;
    else
      v_calc_ref := null;
      begin
        v_journey_id := (v_match ->> 'journeyId')::uuid;
      exception when others then
        raise exception 'MANHEIM_JOURNEY_ID_INVALID';
      end;

      -- A5: ENCERRADO always wins over the on/off switch.
      select j.status, (j.status <> 'ENCERRADO' and coalesce(ts.enabled, true)) as enabled, ts.off_reason
        into v_state
      from public.journeys j
      left join public.journey_toggle_states ts
        on ts.environment = j.environment and ts.journey_id = j.id
      where j.environment = p_environment and j.id = v_journey_id;

      if not found then raise exception 'MANHEIM_JOURNEY_NOT_FOUND'; end if;
      if v_state.status = 'ENCERRADO'
         or (not v_state.enabled and (coalesce(v_state.off_reason, '') not in ('GAVE_UP','NO_RESPONSE') or v_kind <> 'BATE')) then
        raise exception 'MANHEIM_JOURNEY_DISABLED';
      end if;
      if v_state.enabled and v_state.status = 'PARADO' and v_kind <> 'BATE' then
        raise exception 'MANHEIM_REACTIVATION_REQUIRES_MATCH';
      end if;
    end if;

    v_valid := v_valid || jsonb_build_array(jsonb_build_object(
      'journeyId', v_journey_id, 'calcRef', v_calc_ref, 'kind', v_kind, 'mode', v_mode,
      'reason', nullif(left(v_match ->> 'reason', 500), ''),
      'mmrStatus', case when v_match ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then v_match ->> 'mmrStatus' else null end,
      'fingerprint', v_match ->> 'fingerprint', 'vehicle', v_match -> 'vehicle'
    ));
  end loop;

  insert into public.manheim_upload_draft_parts(draft_id, environment, part_index, matches, created_at)
  values (v_draft.id, p_environment, p_part_index, v_valid, v_now)
  on conflict (draft_id, part_index) do update set matches = excluded.matches, created_at = excluded.created_at;

  update public.manheim_upload_drafts
     set received_parts = greatest(received_parts, p_part_index)
   where id = v_draft.id;

  select count(*) into v_stored_parts
    from public.manheim_upload_draft_parts p
   where p.draft_id = v_draft.id;

  if p_part_index < v_draft.part_count or v_stored_parts < v_draft.part_count then
    return jsonb_build_object('uploadId', v_draft.id, 'complete', false, 'partIndex', p_part_index, 'partCount', v_draft.part_count);
  end if;

  -- Last part stored: publish the upload in one transaction.
  insert into public.manheim_uploads(
    id, environment, source_file_count, vehicle_count, headers_json, header_map, uploaded_at, created_by
  ) values (
    v_draft.id, p_environment, v_draft.source_file_count, v_draft.vehicle_count,
    v_draft.headers_json, v_draft.header_map, v_now, v_draft.created_by
  );

  insert into public.manheim_matches(
    environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status,
    row_fingerprint, vehicle_json, logical_mode, created_at
  )
  select p_environment, v_draft.id, nullif(m.value ->> 'journeyId', '')::uuid,
         nullif(m.value ->> 'calcRef', '')::char(5), m.value ->> 'kind', m.value ->> 'reason',
         m.value ->> 'mmrStatus', m.value ->> 'fingerprint', m.value -> 'vehicle',
         nullif(m.value ->> 'mode', '')::public.panel_logical_mode, v_now
    from public.manheim_upload_draft_parts p
    cross join lateral jsonb_array_elements(p.matches) m
   where p.draft_id = v_draft.id
   order by p.part_index
  on conflict do nothing;

  select count(*),
         -- Only BATE and POR_VALOR serve a customer; QUASE never counts.
         count(distinct case
           when match_kind not in ('BATE', 'POR_VALOR') then null
           when journey_id is not null then 'j:' || journey_id::text
           else 'r:' || trim(calc_ref::text)
         end)
    into v_match_count, v_lead_count
  from public.manheim_matches
  where environment = p_environment and upload_id = v_draft.id;

  update public.manheim_uploads
     set matched_vehicle_count = v_match_count, lead_count = v_lead_count
   where id = v_draft.id and environment = p_environment;

  update public.manheim_upload_drafts set completed_at = v_now where id = v_draft.id;
  delete from public.manheim_upload_draft_parts where draft_id = v_draft.id;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (
    p_environment, 'MANHEIM_UPLOAD_COMPLETED', 'Exportação do Manheim comparada',
    jsonb_build_object('upload_id', v_draft.id, 'vehicle_count', v_draft.vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count, 'part_count', v_draft.part_count),
    v_now, p_actor_id
  );

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (
    p_environment, p_actor_id, 'manheim_upload', v_draft.id, 'CREATE',
    jsonb_build_object('vehicle_count', v_draft.vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count, 'part_count', v_draft.part_count), v_now
  );

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', v_draft.id, v_now);

  return jsonb_build_object('uploadId', v_draft.id, 'complete', true, 'partIndex', p_part_index,
    'partCount', v_draft.part_count, 'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count);
end;
$$;

revoke all on function public.panel_store_manheim_upload_part(public.panel_environment, uuid, uuid, integer, integer, integer, integer, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.panel_store_manheim_upload_part(public.panel_environment, uuid, uuid, integer, integer, integer, integer, jsonb, jsonb, jsonb)
  to service_role;

-- Undo of one import batch (one manheim_uploads row, however many CSV files it had).
-- Transactional and idempotent. Nothing is deleted: the batch, its cars and its matches get
-- undone_at and leave every operational read. Units, vitrines, vitrine cars, fichas, Refs,
-- contacts and messages are never touched; the ones linked to a match of the batch are counted
-- and reported as preserved.
create or replace function public.panel_undo_manheim_upload(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_now timestamptz := now();
  v_vehicles integer := 0;
  v_matches integer := 0;
  v_units integer := 0;
  v_presented integer := 0;
  v_vitrines integer := 0;
  v_vitrine_cars integer := 0;
  v_summary jsonb;
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  if p_upload_id is null then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;

  select * into v_upload
    from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;

  if v_upload.undone_at is not null then
    return jsonb_build_object('uploadId', v_upload.id, 'alreadyUndone', true, 'undoneAt', v_upload.undone_at, 'summary', v_upload.undo_summary);
  end if;

  select count(*) into v_vehicles
    from public.manheim_vehicles v
   where v.environment = p_environment and v.upload_id = p_upload_id and v.undone_at is null;
  select count(*), count(m.presented_unit_id), count(distinct m.presented_unit_id)
    into v_matches, v_presented, v_units
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null;
  select count(*), count(distinct vc.vitrine_id) into v_vitrine_cars, v_vitrines
    from public.vitrine_cars vc
    join public.manheim_matches m on m.id = vc.source_match_id
   where m.environment = p_environment and m.upload_id = p_upload_id;

  update public.manheim_matches m set undone_at = v_now
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null;
  update public.manheim_vehicles v set undone_at = v_now
   where v.environment = p_environment and v.upload_id = p_upload_id and v.undone_at is null;

  v_summary := jsonb_build_object(
    'vehiclesWithdrawn', v_vehicles,
    'matchesWithdrawn', v_matches,
    'presentedMatches', v_presented,
    'unitsPreserved', v_units,
    'vitrinesPreserved', v_vitrines,
    'vitrineCarsPreserved', v_vitrine_cars,
    'fileCount', v_upload.source_file_count,
    'preservedReason', 'unidades e vitrines já criadas registram ação humana e ficam no banco para auditoria'
  );

  update public.manheim_uploads u
     set undone_at = v_now, undone_by = p_actor_id, undo_summary = v_summary
   where u.id = p_upload_id and u.environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (
    p_environment, 'MANHEIM_UPLOAD_UNDONE', 'Importação do Manheim desfeita',
    v_summary || jsonb_build_object('upload_id', p_upload_id), v_now, p_actor_id
  );

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (
    p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'UNDO',
    jsonb_build_object('undone_at', null, 'vehicle_count', v_upload.vehicle_count, 'matched_vehicle_count', v_upload.matched_vehicle_count, 'lead_count', v_upload.lead_count),
    v_summary || jsonb_build_object('undone_at', v_now), v_now
  );

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', p_upload_id, v_now);

  return jsonb_build_object('uploadId', p_upload_id, 'alreadyUndone', false, 'undoneAt', v_now, 'summary', v_summary);
end;
$$;

revoke all on function public.panel_undo_manheim_upload(public.panel_environment, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.panel_undo_manheim_upload(public.panel_environment, uuid, uuid)
  to service_role;
