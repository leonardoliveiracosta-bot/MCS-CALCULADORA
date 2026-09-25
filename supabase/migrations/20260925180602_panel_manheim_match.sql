-- Operational on/off state and Manheim matches. Additive; calc_runs is read-only.

create table if not exists public.journey_toggle_states (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  enabled boolean not null default true,
  off_reason text check (off_reason is null or off_reason in ('MCS_PURCHASE','OTHER_PURCHASE','GAVE_UP','NO_RESPONSE')),
  resume_snapshot jsonb not null default '{}'::jsonb,
  switched_at timestamptz not null default now(),
  switched_by uuid not null references public.panel_users(id),
  unique (environment, journey_id)
);

create table if not exists public.manheim_uploads (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  source_file_count integer not null check (source_file_count between 1 and 20),
  vehicle_count integer not null check (vehicle_count between 0 and 100000),
  matched_vehicle_count integer not null default 0 check (matched_vehicle_count >= 0),
  lead_count integer not null default 0 check (lead_count >= 0),
  headers_json jsonb not null default '[]'::jsonb,
  header_map jsonb not null default '{}'::jsonb,
  uploaded_at timestamptz not null default now(),
  created_by uuid not null references public.panel_users(id)
);

create table if not exists public.manheim_matches (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  journey_id uuid not null references public.journeys(id),
  match_kind text not null check (match_kind in ('BATE','QUASE')),
  match_reason text,
  mmr_status text check (mmr_status is null or mmr_status in ('MMR acima do teto','MMR dentro do teto')),
  row_fingerprint text not null,
  vehicle_json jsonb not null,
  presented_unit_id uuid references public.units(id),
  created_at timestamptz not null default now(),
  unique (environment, upload_id, journey_id, row_fingerprint)
);

create index if not exists journey_toggle_states_environment_enabled_idx
  on public.journey_toggle_states(environment, enabled, off_reason, journey_id);
create index if not exists manheim_uploads_environment_uploaded_idx
  on public.manheim_uploads(environment, uploaded_at desc);
create index if not exists manheim_matches_environment_upload_journey_idx
  on public.manheim_matches(environment, upload_id, journey_id, match_kind);

alter table public.journey_toggle_states enable row level security;
alter table public.journey_toggle_states force row level security;
alter table public.manheim_uploads enable row level security;
alter table public.manheim_uploads force row level security;
alter table public.manheim_matches enable row level security;
alter table public.manheim_matches force row level security;

revoke all on table public.journey_toggle_states, public.manheim_uploads, public.manheim_matches from public, anon, authenticated;
grant select on table public.journey_toggle_states, public.manheim_uploads, public.manheim_matches to authenticated;
grant all on table public.journey_toggle_states, public.manheim_uploads, public.manheim_matches to service_role;

do $$
declare
  v_table text;
begin
  foreach v_table in array array['journey_toggle_states','manheim_uploads','manheim_matches'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and policyname = 'panel_' || v_table || '_select_authorized'
    ) then
      execute format(
        'create policy %I on public.%I for select to authenticated using (private.panel_authorized(environment))',
        'panel_' || v_table || '_select_authorized', v_table
      );
    end if;
  end loop;
end
$$;

create or replace function private.panel_sync_wishlist_declaration()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.field = 'VEICULO'
     and jsonb_typeof(new.value_json -> 'wishlist') = 'object'
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

drop trigger if exists panel_sync_wishlist_declaration on public.journey_declarations;
create trigger panel_sync_wishlist_declaration
after insert on public.journey_declarations
for each row execute function private.panel_sync_wishlist_declaration();

create or replace function public.panel_set_journey_enabled(
  p_environment public.panel_environment,
  p_journey_id uuid,
  p_enabled boolean,
  p_reason text,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_journey public.journeys%rowtype;
  v_state public.journey_toggle_states%rowtype;
  v_snapshot jsonb;
  v_now timestamptz := now();
  v_closed_reason text;
begin
  if p_enabled is null then raise exception 'JOURNEY_SWITCH_INVALID'; end if;
  if p_reason is not null and p_reason not in ('MCS_PURCHASE','OTHER_PURCHASE','GAVE_UP','NO_RESPONSE') then
    raise exception 'JOURNEY_SWITCH_REASON_INVALID';
  end if;
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_journey
  from public.journeys
  where id = p_journey_id and environment = p_environment
  for update;
  if not found then raise exception 'JOURNEY_NOT_FOUND'; end if;

  select * into v_state
  from public.journey_toggle_states
  where journey_id = p_journey_id and environment = p_environment
  for update;

  if not p_enabled then
    v_closed_reason := case p_reason
      when 'MCS_PURCHASE' then 'DESLIGADO_COMPROU_MCS'
      when 'OTHER_PURCHASE' then 'DESLIGADO_COMPROU_OUTRO'
      when 'GAVE_UP' then 'DESLIGADO_DESISTIU'
      when 'NO_RESPONSE' then 'DESLIGADO_SEM_RESPOSTA'
      else 'DESLIGADO_SEM_MOTIVO'
    end;

    if found and not v_state.enabled then
      update public.journey_toggle_states
         set off_reason = p_reason, switched_at = v_now, switched_by = p_actor_id
       where id = v_state.id;
      update public.journeys
         set closed_reason = v_closed_reason, updated_at = v_now, updated_by = p_actor_id
       where id = p_journey_id and environment = p_environment;
    else
      v_snapshot := jsonb_build_object(
        'stage', v_journey.stage,
        'status', v_journey.status,
        'stage_frozen', v_journey.stage_frozen,
        'qualified_at', v_journey.qualified_at,
        'closed_at', v_journey.closed_at,
        'closed_reason', v_journey.closed_reason,
        'next_action_at', v_journey.next_action_at,
        'next_action_text', v_journey.next_action_text,
        'next_action_missing_since', v_journey.next_action_missing_since
      );

      update public.journeys
         set status = 'ENCERRADO', stage_frozen = true, closed_at = v_now,
             closed_reason = v_closed_reason, next_action_at = null,
             next_action_text = null, next_action_missing_since = null,
             updated_at = v_now, updated_by = p_actor_id
       where id = p_journey_id and environment = p_environment;

      insert into public.journey_toggle_states(
        environment, journey_id, enabled, off_reason, resume_snapshot, switched_at, switched_by
      ) values (
        p_environment, p_journey_id, false, p_reason, v_snapshot, v_now, p_actor_id
      ) on conflict (environment, journey_id) do update
        set enabled = false, off_reason = excluded.off_reason,
            resume_snapshot = excluded.resume_snapshot,
            switched_at = excluded.switched_at, switched_by = excluded.switched_by;

      insert into public.interactions(environment, journey_id, type, occurred_at, created_at, created_by)
      values (p_environment, p_journey_id, 'JOURNEY_CLOSED', v_now, v_now, p_actor_id);
    end if;
  else
    if not found then
      if v_journey.status <> 'ENCERRADO' then return jsonb_build_object('enabled', true, 'reason', null, 'changed', false); end if;
      raise exception 'JOURNEY_RESUME_STATE_MISSING';
    end if;
    if v_state.enabled then return jsonb_build_object('enabled', true, 'reason', null, 'changed', false); end if;
    if jsonb_typeof(v_state.resume_snapshot) <> 'object' or not (v_state.resume_snapshot ? 'status') then
      raise exception 'JOURNEY_RESUME_STATE_MISSING';
    end if;

    update public.journeys
       set stage = (v_state.resume_snapshot ->> 'stage')::public.panel_journey_stage,
           status = (v_state.resume_snapshot ->> 'status')::public.panel_journey_status,
           stage_frozen = coalesce((v_state.resume_snapshot ->> 'stage_frozen')::boolean, false),
           qualified_at = (v_state.resume_snapshot ->> 'qualified_at')::timestamptz,
           closed_at = (v_state.resume_snapshot ->> 'closed_at')::timestamptz,
           closed_reason = v_state.resume_snapshot ->> 'closed_reason',
           next_action_at = (v_state.resume_snapshot ->> 'next_action_at')::timestamptz,
           next_action_text = v_state.resume_snapshot ->> 'next_action_text',
           next_action_missing_since = (v_state.resume_snapshot ->> 'next_action_missing_since')::timestamptz,
           updated_at = v_now, updated_by = p_actor_id
     where id = p_journey_id and environment = p_environment;

    update public.journey_toggle_states
       set enabled = true, off_reason = null, switched_at = v_now, switched_by = p_actor_id
     where id = v_state.id;
  end if;

  insert into public.activity_log(
    environment, journey_id, contact_id, activity_type, summary, metadata, occurred_at, actor_user_id
  ) values (
    p_environment, p_journey_id, v_journey.contact_id,
    case when p_enabled then 'JOURNEY_ENABLED' else 'JOURNEY_DISABLED' end,
    case when p_enabled then 'Busca ligada' else 'Busca desligada' end,
    jsonb_build_object('enabled', p_enabled, 'reason', p_reason), v_now, p_actor_id
  );

  insert into public.audit_log(
    environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at
  ) values (
    p_environment, p_actor_id, 'journey', p_journey_id,
    case when p_enabled then 'ENABLE' else 'DISABLE' end,
    jsonb_build_object('stage', v_journey.stage, 'status', v_journey.status),
    jsonb_build_object('enabled', p_enabled, 'reason', p_reason), v_now
  );

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'journey', p_journey_id, v_now);

  return jsonb_build_object('enabled', p_enabled, 'reason', p_reason, 'changed', true);
end;
$$;

revoke all on function public.panel_set_journey_enabled(public.panel_environment, uuid, boolean, text, uuid)
  from public, anon, authenticated;
grant execute on function public.panel_set_journey_enabled(public.panel_environment, uuid, boolean, text, uuid)
  to service_role;

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
    begin
      v_journey_id := (v_match ->> 'journeyId')::uuid;
    exception when others then
      raise exception 'MANHEIM_JOURNEY_ID_INVALID';
    end;
    v_kind := v_match ->> 'kind';
    if v_kind not in ('BATE','QUASE')
       or length(coalesce(v_match ->> 'fingerprint', '')) not between 3 and 200
       or jsonb_typeof(v_match -> 'vehicle') <> 'object'
       or octet_length((v_match -> 'vehicle')::text) > 65536
    then raise exception 'MANHEIM_MATCH_INVALID'; end if;

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

    insert into public.manheim_matches(
      environment, upload_id, journey_id, match_kind, match_reason, mmr_status,
      row_fingerprint, vehicle_json, created_at
    ) values (
      p_environment, v_upload_id, v_journey_id, v_kind,
      nullif(left(v_match ->> 'reason', 500), ''),
      case when v_match ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then v_match ->> 'mmrStatus' else null end,
      v_match ->> 'fingerprint', v_match -> 'vehicle', v_now
    ) on conflict (environment, upload_id, journey_id, row_fingerprint) do nothing;
  end loop;

  select count(*), count(distinct journey_id)
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
