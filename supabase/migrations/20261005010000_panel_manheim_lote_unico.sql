-- Manheim em alto volume: uma importação lógica (todos os CSVs) enviada em blocos retomáveis,
-- ativada de uma vez só no fim, e leituras operacionais sempre dirigidas por lote e por demanda.
-- Aditiva: nenhuma linha histórica é apagada ou reescrita (só activated_at recebe uploaded_at nos
-- lotes que já existem) e as funções antigas continuam no banco, sem mudança.
--
--  * manheim_uploads.activated_at: um lote só vale para o painel depois de ativado. Lotes antigos
--    recebem activated_at = uploaded_at. Um lote em montagem (activated_at nulo) nunca aparece.
--  * manheim_uploads.canceled_at: montagem cancelada; também recebe undone_at e sai de tudo.
--  * manheim_uploads.client_key / files_json / targets_json / targets_hash: retomada do envio e a
--    foto das demandas usada para comparar todos os blocos com o mesmo critério.
--  * manheim_upload_chunks: um registro por bloco recebido (arquivo e número do bloco). Reenviar o
--    mesmo bloco não duplica veículo nem match (as chaves únicas de sempre seguram).
--  * manheim_vehicles.make_key / mmr_cents: consulta do inventário frio só pela marca pedida.
--  * manheim_matches.demand_key / sort_rank / sort_miles / vin / wish_index / mmr_cents /
--    criteria_hash: resumo por demanda, páginas estáveis por cursor, score sem ler o inventário e
--    "Conferir novamente" quando o critério muda depois da importação.

alter table public.manheim_uploads add column if not exists activated_at timestamptz default now();
alter table public.manheim_uploads add column if not exists canceled_at timestamptz;
alter table public.manheim_uploads add column if not exists client_key text;
alter table public.manheim_uploads add column if not exists files_json jsonb;
alter table public.manheim_uploads add column if not exists targets_json jsonb;
alter table public.manheim_uploads add column if not exists targets_hash text;

-- Lotes que já existiam valem desde que foram enviados.
update public.manheim_uploads set activated_at = uploaded_at
 where activated_at is distinct from uploaded_at and client_key is null;

create unique index if not exists manheim_uploads_staging_key_idx
  on public.manheim_uploads(environment, created_by, client_key)
  where activated_at is null and canceled_at is null and client_key is not null;
create index if not exists manheim_uploads_live_idx
  on public.manheim_uploads(environment, uploaded_at desc)
  where undone_at is null and activated_at is not null;

create table if not exists public.manheim_upload_chunks (
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  file_index integer not null check (file_index between 0 and 19),
  chunk_index integer not null check (chunk_index between 0 and 999),
  vehicle_count integer not null check (vehicle_count >= 0),
  stored_vehicle_count integer not null default 0 check (stored_vehicle_count >= 0),
  match_count integer not null default 0 check (match_count >= 0),
  discarded_count integer not null default 0 check (discarded_count >= 0),
  received_at timestamptz not null default now(),
  primary key (upload_id, file_index, chunk_index)
);
alter table public.manheim_upload_chunks enable row level security;
alter table public.manheim_upload_chunks force row level security;
revoke all on table public.manheim_upload_chunks from public, anon, authenticated;
grant select, insert, update on table public.manheim_upload_chunks to service_role;

alter table public.manheim_vehicles add column if not exists make_key text;
alter table public.manheim_vehicles add column if not exists mmr_cents integer;
create index if not exists manheim_vehicles_upload_make_idx
  on public.manheim_vehicles(environment, upload_id, make_key) where undone_at is null;

alter table public.manheim_matches add column if not exists demand_key text;
alter table public.manheim_matches add column if not exists sort_rank smallint;
alter table public.manheim_matches add column if not exists sort_miles integer;
alter table public.manheim_matches add column if not exists vin text;
alter table public.manheim_matches add column if not exists wish_index smallint;
alter table public.manheim_matches add column if not exists mmr_cents integer;
alter table public.manheim_matches add column if not exists criteria_hash text;

create index if not exists manheim_matches_demand_page_idx
  on public.manheim_matches(environment, upload_id, demand_key, sort_rank, sort_miles, id)
  where undone_at is null;
create index if not exists manheim_matches_score_idx
  on public.manheim_matches(environment, upload_id)
  include (journey_id, calc_ref, row_fingerprint, mmr_cents, match_kind, wish_index)
  where undone_at is null;
create index if not exists manheim_matches_vin_idx
  on public.manheim_matches(environment, upload_id, vin)
  where undone_at is null and vin is not null;

-- ---------------------------------------------------------------- início (ou retomada) do lote
create or replace function public.panel_manheim_batch_start(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_client_key text,
  p_source_file_count integer,
  p_vehicle_count integer,
  p_headers jsonb,
  p_header_map jsonb,
  p_files jsonb,
  p_targets jsonb,
  p_targets_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_file jsonb;
  v_chunks integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  if p_client_key is null or p_client_key !~ '^[0-9a-f]{16,64}$'
     or p_source_file_count is null or p_source_file_count not between 1 and 20
     or p_vehicle_count is null or p_vehicle_count not between 0 and 100000
     or jsonb_typeof(p_headers) <> 'array'
     or jsonb_typeof(p_header_map) <> 'object'
     or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) <> p_source_file_count
     or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) > 5000
     or octet_length(p_targets::text) > 4000000
     or coalesce(p_targets_hash, '') !~ '^[0-9a-f]{16,64}$'
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  for v_file in select value from jsonb_array_elements(p_files) loop
    if jsonb_typeof(v_file) <> 'object'
       or coalesce((v_file ->> 'chunkCount')::integer, -1) not between 0 and 1000
       or coalesce((v_file ->> 'vehicleCount')::integer, -1) < 0
       or length(coalesce(v_file ->> 'name', '')) not between 1 and 200
    then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
    v_chunks := v_chunks + (v_file ->> 'chunkCount')::integer;
  end loop;
  if v_chunks > 2000 then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  -- Montagens esquecidas há mais de um dia saem do caminho (nada é apagado).
  update public.manheim_uploads u
     set canceled_at = v_now, undone_at = v_now, undone_by = p_actor_id,
         undo_summary = jsonb_build_object('canceled', true, 'reason', 'montagem abandonada')
   where u.environment = p_environment and u.activated_at is null and u.canceled_at is null
     and u.uploaded_at < v_now - interval '1 day';

  select * into v_upload
    from public.manheim_uploads u
   where u.environment = p_environment and u.created_by = p_actor_id and u.client_key = p_client_key
     and u.activated_at is null and u.canceled_at is null
   for update;

  if found then
    return jsonb_build_object('uploadId', v_upload.id, 'resumed', true, 'targetsHash', v_upload.targets_hash,
      'received', coalesce((select jsonb_agg(jsonb_build_array(c.file_index, c.chunk_index) order by c.file_index, c.chunk_index)
                              from public.manheim_upload_chunks c where c.upload_id = v_upload.id), '[]'::jsonb));
  end if;

  insert into public.manheim_uploads(
    environment, source_file_count, vehicle_count, headers_json, header_map, uploaded_at, created_by,
    activated_at, client_key, files_json, targets_json, targets_hash
  ) values (
    p_environment, p_source_file_count, p_vehicle_count, p_headers, p_header_map, v_now, p_actor_id,
    null, p_client_key, p_files, p_targets, p_targets_hash
  ) returning * into v_upload;

  return jsonb_build_object('uploadId', v_upload.id, 'resumed', false, 'targetsHash', v_upload.targets_hash, 'received', '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- um bloco (idempotente)
-- p_vehicles: [{ fingerprint, makeKey, mmrCents, vehicle }]
-- p_matches:  [{ targetType, journeyId, calcRef, mode, kind, reason, mmrStatus, fingerprint,
--               vehicle, demandKey, sortRank, sortMiles, vin, wishIndex, mmrCents, criteriaHash }]
-- Um match cuja ficha foi encerrada, desligada ou descartada durante o envio é descartado e
-- contado, nunca derruba o bloco. Carro sem MMR válido nunca vira match.
create or replace function public.panel_manheim_batch_chunk(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid,
  p_file_index integer,
  p_chunk_index integer,
  p_vehicles jsonb,
  p_matches jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_file jsonb;
  v_vehicles integer := 0;
  v_matches integer := 0;
  v_valid integer := 0;
  v_requested integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if v_upload.activated_at is not null then
    if exists (select 1 from public.manheim_upload_chunks c where c.upload_id = p_upload_id and c.file_index = p_file_index and c.chunk_index = p_chunk_index) then
      return jsonb_build_object('uploadId', p_upload_id, 'fileIndex', p_file_index, 'chunkIndex', p_chunk_index, 'duplicate', true);
    end if;
    raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE';
  end if;

  v_file := coalesce(v_upload.files_json, '[]'::jsonb) -> p_file_index;
  if v_file is null or p_chunk_index is null or p_chunk_index < 0 or p_chunk_index >= (v_file ->> 'chunkCount')::integer
     or jsonb_typeof(p_vehicles) <> 'array' or jsonb_array_length(p_vehicles) > 1000
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 20000
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_vehicles) v
     where length(coalesce(v.value ->> 'fingerprint', '')) not between 3 and 200
        or jsonb_typeof(v.value -> 'vehicle') <> 'object'
        or octet_length((v.value -> 'vehicle')::text) > 16384
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  insert into public.manheim_vehicles(environment, upload_id, row_fingerprint, vehicle_json, uploaded_at, make_key, mmr_cents)
  select p_environment, p_upload_id, v.value ->> 'fingerprint', v.value -> 'vehicle', v_now,
         left(coalesce(v.value ->> 'makeKey', ''), 80),
         case when (v.value ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (v.value ->> 'mmrCents')::integer > 0 then (v.value ->> 'mmrCents')::integer else null end
    from jsonb_array_elements(p_vehicles) v
  on conflict (environment, upload_id, row_fingerprint) do nothing;
  get diagnostics v_vehicles = row_count;

  v_requested := jsonb_array_length(p_matches);

  if exists (
    select 1 from jsonb_array_elements(p_matches) m
     where coalesce(m.value ->> 'kind', '') not in ('BATE','POR_VALOR')
        or coalesce(m.value ->> 'mode', '') not in ('CARRO','VALOR')
        or (m.value ->> 'mode' = 'CARRO' and m.value ->> 'kind' <> 'BATE')
        or length(coalesce(m.value ->> 'fingerprint', '')) not between 3 and 200
        or jsonb_typeof(m.value -> 'vehicle') <> 'object'
        or octet_length((m.value -> 'vehicle')::text) > 16384
        or length(coalesce(m.value ->> 'demandKey', '')) not between 10 and 80
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  with requested as (
    select m.value as item,
           nullif(m.value ->> 'journeyId', '') as journey_text,
           upper(nullif(m.value ->> 'calcRef', '')) as ref_text
      from jsonb_array_elements(p_matches) m
  ), typed as (
    select r.item,
           case when coalesce(r.item ->> 'targetType', '') = 'ORDER' then null
                when r.journey_text ~ '^[0-9a-fA-F-]{36}$' then r.journey_text::uuid else null end as journey_id,
           case when coalesce(r.item ->> 'targetType', '') = 'ORDER' and r.ref_text ~ '^[A-HJ-NP-Z2-9]{5}$' then r.ref_text else null end as calc_ref
      from requested r
  ), refs_ok as (
    -- Refs pedidas neste bloco que existem na calculadora e não foram descartadas.
    select distinct t.calc_ref
      from typed t
     where t.calc_ref is not null
       and exists (select 1 from public.calc_runs cr where not cr.is_test and upper(coalesce(cr.dados ->> 'ref', '')) = t.calc_ref)
       and not exists (
         select 1 from public.panel_item_dispositions d
          where d.environment = p_environment and d.item_kind = 'REF' and upper(d.item_key) = t.calc_ref
            and d.status = 'DISCARDED' and d.cleared_at is null)
  ), valid as (
    select t.*
      from typed t
      left join public.journeys j on j.environment = p_environment and j.id = t.journey_id
      left join public.journey_toggle_states ts on ts.environment = j.environment and ts.journey_id = j.id
     where coalesce((t.item ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (t.item ->> 'mmrCents')::integer > 0, false)
       and (
         (t.calc_ref is not null and t.calc_ref in (select calc_ref from refs_ok))
         or (
           t.journey_id is not null and j.id is not null and j.status <> 'ENCERRADO'
           and (
             (coalesce(ts.enabled, true) and (j.status <> 'PARADO' or t.item ->> 'kind' = 'BATE'))
             or (not coalesce(ts.enabled, true) and coalesce(ts.off_reason, '') in ('GAVE_UP','NO_RESPONSE') and t.item ->> 'kind' = 'BATE')
           )
         )
       )
  ), inserted as (
    insert into public.manheim_matches(
      environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
      logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
    )
    select p_environment, p_upload_id, v.journey_id, v.calc_ref::char(5), v.item ->> 'kind', nullif(left(v.item ->> 'reason', 500), ''),
           case when v.item ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then v.item ->> 'mmrStatus' else null end,
           v.item ->> 'fingerprint', v.item -> 'vehicle', (v.item ->> 'mode')::public.panel_logical_mode, v_now,
           v.item ->> 'demandKey',
           case when (v.item ->> 'sortRank') ~ '^[0-9]{1,2}$' then (v.item ->> 'sortRank')::smallint else 9 end,
           case when (v.item ->> 'sortMiles') ~ '^[0-9]{1,10}$' and (v.item ->> 'sortMiles')::bigint <= 2147483647 then (v.item ->> 'sortMiles')::integer else 2147483647 end,
           nullif(left(upper(coalesce(v.item ->> 'vin', '')), 40), ''),
           case when (v.item ->> 'wishIndex') ~ '^[0-9]$' then (v.item ->> 'wishIndex')::smallint else null end,
           (v.item ->> 'mmrCents')::integer,
           nullif(left(coalesce(v.item ->> 'criteriaHash', ''), 64), '')
      from valid v
    on conflict do nothing
    returning 1
  )
  select (select count(*) from valid), (select count(*) from inserted) into v_valid, v_matches;

  insert into public.manheim_upload_chunks(environment, upload_id, file_index, chunk_index, vehicle_count, stored_vehicle_count, match_count, discarded_count, received_at)
  values (p_environment, p_upload_id, p_file_index, p_chunk_index, jsonb_array_length(p_vehicles), v_vehicles, v_matches, v_requested - v_valid, v_now)
  on conflict (upload_id, file_index, chunk_index) do update
    set stored_vehicle_count = public.manheim_upload_chunks.stored_vehicle_count + excluded.stored_vehicle_count,
        match_count = public.manheim_upload_chunks.match_count + excluded.match_count,
        received_at = excluded.received_at;

  return jsonb_build_object('uploadId', p_upload_id, 'fileIndex', p_file_index, 'chunkIndex', p_chunk_index,
    'storedVehicles', v_vehicles, 'storedMatches', v_matches, 'discarded', v_requested - v_valid);
end;
$$;

-- ---------------------------------------------------------------- ativação (tudo ou nada)
create or replace function public.panel_manheim_batch_finalize(
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
  v_missing integer;
  v_vehicle_count integer;
  v_match_count integer;
  v_lead_count integer;
  v_file_count integer;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if v_upload.activated_at is not null then
    return jsonb_build_object('uploadId', v_upload.id, 'complete', true, 'alreadyActive', true, 'vehicleCount', v_upload.vehicle_count,
      'matchedVehicleCount', v_upload.matched_vehicle_count, 'leadCount', v_upload.lead_count, 'fileCount', v_upload.source_file_count);
  end if;

  -- Cada arquivo precisa de todos os seus blocos confirmados.
  select coalesce(sum(greatest((f.value ->> 'chunkCount')::integer - (
           select count(*) from public.manheim_upload_chunks c where c.upload_id = p_upload_id and c.file_index = (f.ordinality - 1)::integer
         ), 0)), 0), count(*)
    into v_missing, v_file_count
    from jsonb_array_elements(coalesce(v_upload.files_json, '[]'::jsonb)) with ordinality f;
  if v_missing > 0 then raise exception 'MANHEIM_BATCH_INCOMPLETE'; end if;

  select count(*) into v_vehicle_count from public.manheim_vehicles v
   where v.environment = p_environment and v.upload_id = p_upload_id;
  select count(distinct m.row_fingerprint),
         count(distinct case when match_kind not in ('BATE','POR_VALOR') then null
                             when journey_id is not null then 'j:' || journey_id::text
                             else 'r:' || trim(calc_ref::text) end)
    into v_match_count, v_lead_count
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null;

  update public.manheim_uploads
     set activated_at = v_now, uploaded_at = v_now, vehicle_count = least(v_vehicle_count, 100000),
         matched_vehicle_count = v_match_count, lead_count = v_lead_count
   where id = p_upload_id and environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (p_environment, 'MANHEIM_UPLOAD_COMPLETED', 'Exportação do Manheim comparada',
    jsonb_build_object('upload_id', p_upload_id, 'vehicle_count', v_vehicle_count, 'matched_vehicle_count', v_match_count,
      'lead_count', v_lead_count, 'file_count', v_file_count, 'mode', 'lote_unico'), v_now, p_actor_id);

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'CREATE',
    jsonb_build_object('vehicle_count', v_vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count,
      'file_count', v_file_count, 'mode', 'lote_unico'), v_now);

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', p_upload_id, v_now);

  return jsonb_build_object('uploadId', p_upload_id, 'complete', true, 'alreadyActive', false, 'vehicleCount', v_vehicle_count,
    'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count, 'fileCount', v_file_count);
end;
$$;

-- ---------------------------------------------------------------- cancelamento da montagem
create or replace function public.panel_manheim_batch_cancel(
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
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.activated_at is not null and v_upload.canceled_at is null then raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE'; end if;
  if v_upload.canceled_at is not null then
    return jsonb_build_object('uploadId', p_upload_id, 'canceled', true, 'alreadyCanceled', true);
  end if;
  update public.manheim_uploads
     set canceled_at = v_now, undone_at = v_now, undone_by = p_actor_id,
         undo_summary = jsonb_build_object('canceled', true, 'reason', 'montagem cancelada',
           'chunks', (select count(*) from public.manheim_upload_chunks c where c.upload_id = p_upload_id))
   where id = p_upload_id and environment = p_environment;
  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'CANCEL', jsonb_build_object('canceled_at', v_now), v_now);
  return jsonb_build_object('uploadId', p_upload_id, 'canceled', true, 'alreadyCanceled', false);
end;
$$;

-- ---------------------------------------------------------------- leituras dirigidas
-- Chave da demanda, ordem de exibição e MMR válido de um match. As linhas antigas (sem as colunas
-- novas) são lidas pelo mesmo critério a partir do que já guardavam.
create or replace function public.panel_manheim_match_key(m public.manheim_matches)
returns text language sql immutable set search_path = '' as $$
  select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, ''));
$$;
create or replace function public.panel_manheim_match_rank(m public.manheim_matches)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(m.sort_rank::integer, case m.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end);
$$;
create or replace function public.panel_manheim_match_miles(m public.manheim_matches)
returns integer language sql immutable set search_path = '' as $$
  select coalesce(m.sort_miles, case when m.vehicle_json #>> '{parsed,miles}' ~ '^[0-9]{1,9}$' then (m.vehicle_json #>> '{parsed,miles}')::integer else 2147483647 end);
$$;
-- MMR obrigatório: sem MMR positivo o match nunca conta nem aparece.
create or replace function public.panel_manheim_match_has_mmr(m public.manheim_matches)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0;
$$;

-- Resumo por demanda do lote: contagens, sem veículo nenhum.
create or replace function public.panel_manheim_batch_summary(
  p_environment public.panel_environment,
  p_upload_id uuid
)
returns table(demand_key text, logical_mode text, journey_id uuid, calc_ref text, match_count integer,
  bate_count integer, por_valor_count integer, presented_count integer, criteria_hashes text[])
language sql
stable
security definer
set search_path = ''
as $$
  select public.panel_manheim_match_key(m), m.logical_mode::text, m.journey_id, trim(m.calc_ref::text),
         count(*)::integer,
         count(*) filter (where m.match_kind = 'BATE')::integer,
         count(*) filter (where m.match_kind = 'POR_VALOR')::integer,
         count(m.presented_unit_id)::integer,
         array_remove(array_agg(distinct m.criteria_hash), null)
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
     and public.panel_manheim_match_has_mmr(m)
   group by 1, 2, 3, 4;
$$;

-- Uma página de opções de UMA demanda, na ordem de exibição (BATE, POR VALOR; menor milhagem),
-- com cursor estável (rank, milhagem, id): nada pulado, nada repetido.
create or replace function public.panel_manheim_demand_options(
  p_environment public.panel_environment,
  p_upload_id uuid,
  p_demand_key text,
  p_after_rank integer default null,
  p_after_miles integer default null,
  p_after_id uuid default null,
  p_limit integer default 10
)
returns setof public.manheim_matches
language sql
stable
security definer
set search_path = ''
as $$
  select m.*
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
     and (m.demand_key = p_demand_key or (m.demand_key is null and public.panel_manheim_match_key(m) = p_demand_key))
     and public.panel_manheim_match_has_mmr(m)
     and (p_after_id is null or (public.panel_manheim_match_rank(m), public.panel_manheim_match_miles(m), m.id) > (p_after_rank, p_after_miles, p_after_id))
   order by public.panel_manheim_match_rank(m), public.panel_manheim_match_miles(m), m.id
   limit least(greatest(coalesce(p_limit, 10), 1), 200);
$$;

-- As primeiras opções de cada demanda do lote (conferência no servidor, nunca no navegador).
create or replace function public.panel_manheim_batch_top_options(
  p_environment public.panel_environment,
  p_upload_id uuid,
  p_per_demand integer
)
returns setof public.manheim_matches
language sql
stable
security definer
set search_path = ''
as $$
  select (x.m).*
    from (
      select m, row_number() over (partition by public.panel_manheim_match_key(m)
                                   order by public.panel_manheim_match_rank(m), public.panel_manheim_match_miles(m), m.id) as position
        from public.manheim_matches m
       where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
         and public.panel_manheim_match_has_mmr(m)
    ) x
   where x.position <= least(greatest(coalesce(p_per_demand, 10), 1), 2000);
$$;

-- Carros diferentes por pessoa no lote (por modo e no total, logical_mode nulo): contadores de
-- CLIENTES, ficha e buscas sem trazer veículo nenhum.
create or replace function public.panel_manheim_batch_people(
  p_environment public.panel_environment,
  p_upload_id uuid
)
returns table(journey_id uuid, calc_ref text, logical_mode text, vehicle_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select m.journey_id, trim(m.calc_ref::text), m.logical_mode::text, count(distinct m.row_fingerprint)::integer
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null and public.panel_manheim_match_has_mmr(m)
   group by grouping sets ((m.journey_id, m.calc_ref, m.logical_mode), (m.journey_id, m.calc_ref));
$$;

-- MMR de referência do score por pessoa: mediana do MMR dos carros que servem o primeiro desejo de
-- cada demanda, nos lotes ativos da janela. Um carro repetido em dois lotes conta uma vez.
create or replace function public.panel_manheim_score_mmr(
  p_environment public.panel_environment,
  p_since timestamptz
)
returns table(person text, mmr_cents bigint, sample integer)
language sql
stable
security definer
set search_path = ''
as $$
  with live as (
    select u.id from public.manheim_uploads u
     where u.environment = p_environment and u.undone_at is null and u.activated_at is not null and u.uploaded_at >= p_since
  ), cars as (
    select distinct
           case when m.journey_id is not null then 'j:' || m.journey_id::text else 'r:' || upper(trim(m.calc_ref::text)) end as person,
           m.row_fingerprint, m.mmr_cents
      from public.manheim_matches m
     where m.environment = p_environment and m.upload_id in (select id from live) and m.undone_at is null
       and m.wish_index = 0 and m.match_kind in ('BATE','POR_VALOR') and m.mmr_cents > 0
  ), unique_cars as (
    select distinct on (person, row_fingerprint) person, mmr_cents from cars order by person, row_fingerprint, mmr_cents
  )
  select person, round(percentile_cont(0.5) within group (order by mmr_cents))::bigint, count(*)::integer
    from unique_cars group by person;
$$;

-- ---------------------------------------------------------------- nova comparação dirigida
-- Critério de uma demanda mudou depois da importação: o servidor compara de novo só essa demanda
-- com os carros do lote e substitui as opções dela. Opção que deixou de servir sai do uso
-- (undone_at, nada é apagado); a que continua mantém o "apresentado".
create or replace function public.panel_manheim_rematch_demand(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid,
  p_demand_key text,
  p_matches jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_journey uuid;
  v_ref text;
  v_mode text;
  v_withdrawn integer := 0;
  v_kept integer := 0;
  v_added integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found or v_upload.activated_at is null or v_upload.undone_at is not null then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if coalesce(p_demand_key, '') !~ '^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):(VALOR|CARRO)$'
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 20000
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  v_mode := split_part(p_demand_key, ':', 3);
  if p_demand_key like 'journey:%' then v_journey := split_part(p_demand_key, ':', 2)::uuid; else v_ref := split_part(p_demand_key, ':', 2); end if;
  if exists (
    select 1 from jsonb_array_elements(p_matches) m
     where coalesce(m.value ->> 'demandKey', '') <> p_demand_key
        or coalesce(m.value ->> 'kind', '') not in ('BATE','POR_VALOR')
        or (v_mode = 'CARRO' and m.value ->> 'kind' <> 'BATE')
        or coalesce(m.value ->> 'mode', '') <> v_mode
        or length(coalesce(m.value ->> 'fingerprint', '')) not between 3 and 200
        or jsonb_typeof(m.value -> 'vehicle') <> 'object'
        or not coalesce((m.value ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (m.value ->> 'mmrCents')::integer > 0, false)
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  -- Só carros do próprio lote.
  if exists (
    select 1 from jsonb_array_elements(p_matches) m
     where not exists (select 1 from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = p_upload_id and v.row_fingerprint = m.value ->> 'fingerprint')
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  update public.manheim_matches m set undone_at = v_now
   where m.environment = p_environment and m.upload_id = p_upload_id and m.demand_key = p_demand_key and m.undone_at is null
     and not exists (select 1 from jsonb_array_elements(p_matches) n where n.value ->> 'fingerprint' = m.row_fingerprint);
  get diagnostics v_withdrawn = row_count;

  with incoming as (
    select n.value as item from jsonb_array_elements(p_matches) n
  ), changed as (
    insert into public.manheim_matches as m (
      environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
      logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
    )
    select p_environment, p_upload_id, v_journey, v_ref::char(5), i.item ->> 'kind', nullif(left(i.item ->> 'reason', 500), ''),
           case when i.item ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then i.item ->> 'mmrStatus' else null end,
           i.item ->> 'fingerprint', i.item -> 'vehicle', v_mode::public.panel_logical_mode, v_now, p_demand_key,
           case when (i.item ->> 'sortRank') ~ '^[0-9]{1,2}$' then (i.item ->> 'sortRank')::smallint else 9 end,
           case when (i.item ->> 'sortMiles') ~ '^[0-9]{1,10}$' and (i.item ->> 'sortMiles')::bigint <= 2147483647 then (i.item ->> 'sortMiles')::integer else 2147483647 end,
           nullif(left(upper(coalesce(i.item ->> 'vin', '')), 40), ''),
           case when (i.item ->> 'wishIndex') ~ '^[0-9]$' then (i.item ->> 'wishIndex')::smallint else null end,
           (i.item ->> 'mmrCents')::integer, nullif(left(coalesce(i.item ->> 'criteriaHash', ''), 64), '')
      from incoming i
     where v_journey is not null
    on conflict (environment, upload_id, journey_id, row_fingerprint, logical_mode) where journey_id is not null do update
      set match_kind = excluded.match_kind, match_reason = excluded.match_reason, mmr_status = excluded.mmr_status,
          vehicle_json = excluded.vehicle_json, demand_key = excluded.demand_key, sort_rank = excluded.sort_rank,
          sort_miles = excluded.sort_miles, vin = excluded.vin, wish_index = excluded.wish_index,
          mmr_cents = excluded.mmr_cents, criteria_hash = excluded.criteria_hash, undone_at = null
    returning (xmax = 0) as added
  )
  select count(*) filter (where added), count(*) filter (where not added) into v_added, v_kept from changed;

  if v_ref is not null then
    with incoming as (
      select n.value as item from jsonb_array_elements(p_matches) n
    ), changed as (
      insert into public.manheim_matches as m (
        environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
        logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
      )
      select p_environment, p_upload_id, null, v_ref::char(5), i.item ->> 'kind', nullif(left(i.item ->> 'reason', 500), ''),
             case when i.item ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then i.item ->> 'mmrStatus' else null end,
             i.item ->> 'fingerprint', i.item -> 'vehicle', v_mode::public.panel_logical_mode, v_now, p_demand_key,
             case when (i.item ->> 'sortRank') ~ '^[0-9]{1,2}$' then (i.item ->> 'sortRank')::smallint else 9 end,
             case when (i.item ->> 'sortMiles') ~ '^[0-9]{1,10}$' and (i.item ->> 'sortMiles')::bigint <= 2147483647 then (i.item ->> 'sortMiles')::integer else 2147483647 end,
             nullif(left(upper(coalesce(i.item ->> 'vin', '')), 40), ''),
             case when (i.item ->> 'wishIndex') ~ '^[0-9]$' then (i.item ->> 'wishIndex')::smallint else null end,
             (i.item ->> 'mmrCents')::integer, nullif(left(coalesce(i.item ->> 'criteriaHash', ''), 64), '')
        from incoming i
      on conflict (environment, upload_id, calc_ref, row_fingerprint, logical_mode) where calc_ref is not null do update
        set match_kind = excluded.match_kind, match_reason = excluded.match_reason, mmr_status = excluded.mmr_status,
            vehicle_json = excluded.vehicle_json, demand_key = excluded.demand_key, sort_rank = excluded.sort_rank,
            sort_miles = excluded.sort_miles, vin = excluded.vin, wish_index = excluded.wish_index,
            mmr_cents = excluded.mmr_cents, criteria_hash = excluded.criteria_hash, undone_at = null
      returning (xmax = 0) as added
    )
    select count(*) filter (where added), count(*) filter (where not added) into v_added, v_kept from changed;
  end if;

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'REMATCH_DEMAND',
    jsonb_build_object('demand_key', p_demand_key, 'withdrawn', v_withdrawn, 'kept', v_kept, 'added', v_added), v_now);

  return jsonb_build_object('uploadId', p_upload_id, 'demandKey', p_demand_key, 'withdrawn', v_withdrawn, 'kept', v_kept, 'added', v_added);
end;
$$;

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.panel_manheim_batch_start(public.panel_environment, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, text)',
    'public.panel_manheim_batch_chunk(public.panel_environment, uuid, uuid, integer, integer, jsonb, jsonb)',
    'public.panel_manheim_batch_finalize(public.panel_environment, uuid, uuid)',
    'public.panel_manheim_batch_cancel(public.panel_environment, uuid, uuid)',
    'public.panel_manheim_batch_summary(public.panel_environment, uuid)',
    'public.panel_manheim_match_key(public.manheim_matches)',
    'public.panel_manheim_match_rank(public.manheim_matches)',
    'public.panel_manheim_match_miles(public.manheim_matches)',
    'public.panel_manheim_match_has_mmr(public.manheim_matches)',
    'public.panel_manheim_demand_options(public.panel_environment, uuid, text, integer, integer, uuid, integer)',
    'public.panel_manheim_batch_top_options(public.panel_environment, uuid, integer)',
    'public.panel_manheim_batch_people(public.panel_environment, uuid)',
    'public.panel_manheim_score_mmr(public.panel_environment, timestamptz)',
    'public.panel_manheim_rematch_demand(public.panel_environment, uuid, uuid, text, jsonb)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end $$;
