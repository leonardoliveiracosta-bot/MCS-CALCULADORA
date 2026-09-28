-- Manheim CSV upload in parts. Additive: the legacy single-call RPC stays untouched.
-- Parts are staged in a draft; manheim_uploads (the "último upload" the panel reads)
-- only receives the upload, with all its matches, when the last part is stored.
-- A draft that never completes never replaces the previous upload.

create table if not exists public.manheim_upload_drafts (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  source_file_count integer not null check (source_file_count between 1 and 20),
  vehicle_count integer not null check (vehicle_count between 0 and 100000),
  headers_json jsonb not null default '[]'::jsonb,
  header_map jsonb not null default '{}'::jsonb,
  part_count integer not null check (part_count between 1 and 400),
  received_parts integer not null default 0 check (received_parts >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid not null references public.panel_users(id)
);

create table if not exists public.manheim_upload_draft_parts (
  draft_id uuid not null references public.manheim_upload_drafts(id) on delete cascade,
  environment public.panel_environment not null,
  part_index integer not null check (part_index between 1 and 400),
  matches jsonb not null,
  created_at timestamptz not null default now(),
  primary key (draft_id, part_index)
);

create index if not exists manheim_upload_drafts_environment_created_idx
  on public.manheim_upload_drafts(environment, created_at);
create index if not exists manheim_upload_drafts_created_by_idx
  on public.manheim_upload_drafts(created_by);

alter table public.manheim_upload_drafts enable row level security;
alter table public.manheim_upload_drafts force row level security;
alter table public.manheim_upload_draft_parts enable row level security;
alter table public.manheim_upload_draft_parts force row level security;

revoke all on table public.manheim_upload_drafts, public.manheim_upload_draft_parts from public, anon, authenticated;
grant all on table public.manheim_upload_drafts, public.manheim_upload_draft_parts to service_role;

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
          and d.cleared_at is null
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

    v_valid := v_valid || jsonb_build_array(jsonb_build_object(
      'journeyId', v_journey_id, 'calcRef', v_calc_ref, 'kind', v_kind,
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
    row_fingerprint, vehicle_json, created_at
  )
  select p_environment, v_draft.id, nullif(m.value ->> 'journeyId', '')::uuid,
         nullif(m.value ->> 'calcRef', '')::char(5), m.value ->> 'kind', m.value ->> 'reason',
         m.value ->> 'mmrStatus', m.value ->> 'fingerprint', m.value -> 'vehicle', v_now
    from public.manheim_upload_draft_parts p
    cross join lateral jsonb_array_elements(p.matches) m
   where p.draft_id = v_draft.id
   order by p.part_index
  on conflict do nothing;

  select count(*),
         count(distinct case
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
