-- Integridade do lote Manheim: o bloco vale pelo conteúdo, não só pelo número.
-- Aditiva sobre 20261005010000 (nenhuma linha histórica é apagada ou reescrita).
--
--  * manheim_uploads.manifest_hash: hash do manifesto do lote (por arquivo: nome, tamanho,
--    quantidade de carros e, por bloco, quantidade e hash canônico do conteúdo). O manifesto
--    completo fica em files_json.
--  * manheim_upload_chunks.chunk_hash / ignored_count: o hash do bloco gravado e os carros que o
--    servidor recusou na validação (nunca contados como gravados).
--  * Bloco: sob a trava do lote, o mesmo índice com o mesmo hash responde duplicate=true antes de
--    qualquer gravação; hash diferente é recusado (MANHEIM_CHUNK_CONFLICT) sem gravar nada;
--    conteúdo diferente do manifesto é recusado (MANHEIM_CHUNK_HASH_MISMATCH).
--  * Retomada: mesma chave com manifesto ou foto das demandas diferente nunca continua em
--    silêncio (MANHEIM_BATCH_RESUME_MISMATCH, com o id da montagem para o operador descartar).
--  * Ativação: confere, sob a mesma trava, blocos, hashes, quantidades por bloco, por arquivo e
--    do lote e os carros únicos gravados. Qualquer diferença recusa a ativação
--    (MANHEIM_BATCH_INCOMPLETE ou MANHEIM_BATCH_INTEGRITY_ERROR) e o lote segue invisível.

alter table public.manheim_uploads add column if not exists manifest_hash text;
alter table public.manheim_upload_chunks add column if not exists chunk_hash text;
alter table public.manheim_upload_chunks add column if not exists ignored_count integer not null default 0 check (ignored_count >= 0);

-- As assinaturas da migração anterior nunca foram usadas fora dos testes: saem para que nenhum
-- bloco entre sem hash e nenhum lote comece sem manifesto.
drop function if exists public.panel_manheim_batch_start(public.panel_environment, uuid, text, integer, integer, jsonb, jsonb, jsonb, jsonb, text);
drop function if exists public.panel_manheim_batch_chunk(public.panel_environment, uuid, uuid, integer, integer, jsonb, jsonb);

-- ---------------------------------------------------------------- manifesto válido
-- p_files: [{ name, size, rowCount, vehicleCount, chunkCount, chunks: [{ count, hash }] }]
create or replace function public.panel_manheim_manifest_valid(p_files jsonb, p_vehicle_count integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select jsonb_typeof(p_files) = 'array'
     and jsonb_array_length(p_files) between 1 and 20
     and not exists (
       select 1 from jsonb_array_elements(p_files) f
        where jsonb_typeof(f.value) <> 'object'
           or length(coalesce(f.value ->> 'name', '')) not between 1 and 200
           or coalesce(f.value ->> 'chunkCount', '') !~ '^[0-9]{1,4}$'
           or coalesce(f.value ->> 'vehicleCount', '') !~ '^[0-9]{1,6}$'
           or jsonb_typeof(f.value -> 'chunks') is distinct from 'array'
           or jsonb_array_length(f.value -> 'chunks') <> (f.value ->> 'chunkCount')::integer
           or exists (
             select 1 from jsonb_array_elements(f.value -> 'chunks') c
              where jsonb_typeof(c.value) <> 'object'
                 or coalesce(c.value ->> 'count', '') !~ '^[0-9]{1,3}$'
                 or (c.value ->> 'count')::integer not between 1 and 500
                 or coalesce(c.value ->> 'hash', '') !~ '^[0-9a-f]{64}$')
           or (select coalesce(sum((c.value ->> 'count')::integer), 0) from jsonb_array_elements(f.value -> 'chunks') c)
              <> (f.value ->> 'vehicleCount')::integer)
     and (select coalesce(sum((f.value ->> 'chunkCount')::integer), 0) from jsonb_array_elements(p_files) f) <= 2000
     and (select coalesce(sum((f.value ->> 'vehicleCount')::integer), 0) from jsonb_array_elements(p_files) f) = p_vehicle_count;
$$;

-- ---------------------------------------------------------------- início (ou retomada) do lote
create or replace function public.panel_manheim_batch_start(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_client_key text,
  p_vehicle_count integer,
  p_headers jsonb,
  p_header_map jsonb,
  p_files jsonb,
  p_manifest_hash text,
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
  v_now timestamptz := now();
  v_reason text;
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  if p_client_key is null or p_client_key !~ '^[0-9a-f]{16,64}$'
     or p_vehicle_count is null or p_vehicle_count not between 0 and 100000
     or jsonb_typeof(p_headers) <> 'array'
     or jsonb_typeof(p_header_map) <> 'object'
     or coalesce(p_manifest_hash, '') !~ '^[0-9a-f]{64}$'
     or not public.panel_manheim_manifest_valid(p_files, p_vehicle_count)
     or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) > 5000
     or octet_length(p_targets::text) > 4000000
     or coalesce(p_targets_hash, '') !~ '^[0-9a-f]{16,64}$'
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  -- Duas aberturas simultâneas da mesma seleção viram uma só montagem.
  perform pg_advisory_xact_lock(hashtextextended('manheim_batch_start:' || p_environment::text || ':' || p_actor_id::text || ':' || p_client_key, 0));

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
    -- Retomada só com o mesmo manifesto e a mesma foto das demandas; nunca em silêncio.
    v_reason := case
      when v_upload.manifest_hash is distinct from p_manifest_hash or v_upload.files_json is distinct from p_files then 'MANIFEST'
      when v_upload.targets_hash is distinct from p_targets_hash then 'TARGETS'
      else null end;
    if v_reason is not null then
      return jsonb_build_object('uploadId', v_upload.id, 'mismatch', true, 'reason', v_reason,
        'received', (select count(*) from public.manheim_upload_chunks c where c.upload_id = v_upload.id));
    end if;
    return jsonb_build_object('uploadId', v_upload.id, 'resumed', true, 'targetsHash', v_upload.targets_hash,
      'received', coalesce((select jsonb_agg(jsonb_build_array(c.file_index, c.chunk_index) order by c.file_index, c.chunk_index)
                              from public.manheim_upload_chunks c where c.upload_id = v_upload.id), '[]'::jsonb));
  end if;

  insert into public.manheim_uploads(
    environment, source_file_count, vehicle_count, headers_json, header_map, uploaded_at, created_by,
    activated_at, client_key, files_json, manifest_hash, targets_json, targets_hash
  ) values (
    p_environment, jsonb_array_length(p_files), p_vehicle_count, p_headers, p_header_map, v_now, p_actor_id,
    null, p_client_key, p_files, p_manifest_hash, p_targets, p_targets_hash
  ) returning * into v_upload;

  return jsonb_build_object('uploadId', v_upload.id, 'resumed', false, 'targetsHash', v_upload.targets_hash, 'received', '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------- um bloco (imutável)
-- p_chunk_hash: hash canônico dos carros recebidos, recalculado pelo servidor.
-- p_received_count: quantos carros vieram no bloco; p_vehicles traz os que passaram na validação.
create or replace function public.panel_manheim_batch_chunk(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid,
  p_file_index integer,
  p_chunk_index integer,
  p_chunk_hash text,
  p_received_count integer,
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
  v_existing public.manheim_upload_chunks%rowtype;
  v_expected jsonb;
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

  -- A trava do lote: blocos, retomada e ativação do mesmo lote passam um de cada vez.
  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if coalesce(p_chunk_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  -- Bloco já gravado: mesmo conteúdo responde sem gravar nada; conteúdo diferente é recusado.
  select * into v_existing from public.manheim_upload_chunks c
   where c.upload_id = p_upload_id and c.file_index = p_file_index and c.chunk_index = p_chunk_index;
  if found then
    if v_existing.chunk_hash is distinct from p_chunk_hash then raise exception 'MANHEIM_CHUNK_CONFLICT'; end if;
    return jsonb_build_object('uploadId', p_upload_id, 'fileIndex', p_file_index, 'chunkIndex', p_chunk_index, 'duplicate', true,
      'storedVehicles', 0, 'storedMatches', 0, 'discarded', 0);
  end if;
  if v_upload.activated_at is not null then raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE'; end if;

  -- O bloco precisa existir no manifesto e ter exatamente o conteúdo declarado.
  v_expected := coalesce(v_upload.files_json, '[]'::jsonb) -> p_file_index -> 'chunks' -> p_chunk_index;
  if p_file_index is null or p_chunk_index is null or p_file_index < 0 or p_chunk_index < 0 or v_expected is null
     or jsonb_typeof(p_vehicles) <> 'array' or jsonb_array_length(p_vehicles) > 500
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 20000
     or p_received_count is null or jsonb_array_length(p_vehicles) > p_received_count
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if v_expected ->> 'hash' <> p_chunk_hash or (v_expected ->> 'count')::integer <> p_received_count then
    raise exception 'MANHEIM_CHUNK_HASH_MISMATCH';
  end if;

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
       and (t.item ->> 'fingerprint') in (select v.value ->> 'fingerprint' from jsonb_array_elements(p_vehicles) v)
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

  -- Sem "on conflict": a trava do lote garante que este índice ainda não existe.
  insert into public.manheim_upload_chunks(environment, upload_id, file_index, chunk_index, vehicle_count, stored_vehicle_count,
    match_count, discarded_count, received_at, chunk_hash, ignored_count)
  values (p_environment, p_upload_id, p_file_index, p_chunk_index, p_received_count, v_vehicles,
    v_matches, v_requested - v_valid, v_now, p_chunk_hash, p_received_count - jsonb_array_length(p_vehicles));

  return jsonb_build_object('uploadId', p_upload_id, 'fileIndex', p_file_index, 'chunkIndex', p_chunk_index, 'duplicate', false,
    'storedVehicles', v_vehicles, 'storedMatches', v_matches, 'discarded', v_requested - v_valid);
end;
$$;

-- ---------------------------------------------------------------- ativação (tudo conferido ou nada)
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
  v_problem text;
  v_stored integer;
  v_ignored integer;
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

  -- O manifesto do lote continua válido e soma o total declarado.
  if v_upload.manifest_hash is null or not public.panel_manheim_manifest_valid(v_upload.files_json, v_upload.vehicle_count) then
    raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR';
  end if;

  -- Blocos esperados pelo manifesto contra os blocos gravados.
  with expected as (
    select (f.ordinality - 1)::integer as file_index, (c.ordinality - 1)::integer as chunk_index,
           (c.value ->> 'count')::integer as count, c.value ->> 'hash' as hash
      from jsonb_array_elements(v_upload.files_json) with ordinality f
      cross join lateral jsonb_array_elements(f.value -> 'chunks') with ordinality c
  ), stored as (
    select * from public.manheim_upload_chunks c where c.upload_id = p_upload_id
  )
  select (select count(*) from expected e where not exists (select 1 from stored s where s.file_index = e.file_index and s.chunk_index = e.chunk_index)),
         case
           when exists (select 1 from stored s where not exists (select 1 from expected e where e.file_index = s.file_index and e.chunk_index = s.chunk_index)) then 'BLOCO_FORA_DO_MANIFESTO'
           when exists (select 1 from stored s join expected e using (file_index, chunk_index) where s.chunk_hash is distinct from e.hash) then 'HASH'
           when exists (select 1 from stored s join expected e using (file_index, chunk_index) where s.vehicle_count <> e.count) then 'QUANTIDADE_DO_BLOCO'
           when exists (select 1 from stored s where s.stored_vehicle_count <> s.vehicle_count - s.ignored_count) then 'CARROS_GRAVADOS_DO_BLOCO'
           else null end
    into v_missing, v_problem;
  if v_missing > 0 then raise exception 'MANHEIM_BATCH_INCOMPLETE'; end if;

  -- Quantidades por arquivo e do lote, pelos blocos gravados.
  if v_problem is null and exists (
    select 1 from jsonb_array_elements(v_upload.files_json) with ordinality f
     where (select coalesce(sum(c.vehicle_count), 0) from public.manheim_upload_chunks c
             where c.upload_id = p_upload_id and c.file_index = (f.ordinality - 1)::integer) <> (f.value ->> 'vehicleCount')::integer
  ) then v_problem := 'QUANTIDADE_DO_ARQUIVO'; end if;

  select coalesce(sum(c.stored_vehicle_count), 0), coalesce(sum(c.ignored_count), 0) into v_stored, v_ignored
    from public.manheim_upload_chunks c where c.upload_id = p_upload_id;
  select count(*) into v_vehicle_count from public.manheim_vehicles v
   where v.environment = p_environment and v.upload_id = p_upload_id;
  if v_problem is null and v_stored + v_ignored <> v_upload.vehicle_count then v_problem := 'QUANTIDADE_DO_LOTE'; end if;
  if v_problem is null and v_vehicle_count <> v_stored then v_problem := 'CARROS_UNICOS'; end if;
  if v_problem is not null then
    raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR' using detail = v_problem;
  end if;

  select count(distinct m.row_fingerprint),
         count(distinct case when match_kind not in ('BATE','POR_VALOR') then null
                             when journey_id is not null then 'j:' || journey_id::text
                             else 'r:' || trim(calc_ref::text) end)
    into v_match_count, v_lead_count
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null;
  v_file_count := jsonb_array_length(v_upload.files_json);

  update public.manheim_uploads
     set activated_at = v_now, uploaded_at = v_now, vehicle_count = v_vehicle_count,
         matched_vehicle_count = v_match_count, lead_count = v_lead_count
   where id = p_upload_id and environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (p_environment, 'MANHEIM_UPLOAD_COMPLETED', 'Exportação do Manheim comparada',
    jsonb_build_object('upload_id', p_upload_id, 'vehicle_count', v_vehicle_count, 'matched_vehicle_count', v_match_count,
      'lead_count', v_lead_count, 'file_count', v_file_count, 'mode', 'lote_unico', 'manifest_hash', v_upload.manifest_hash), v_now, p_actor_id);

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'CREATE',
    jsonb_build_object('vehicle_count', v_vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count,
      'file_count', v_file_count, 'mode', 'lote_unico', 'manifest_hash', v_upload.manifest_hash, 'ignored_count', v_ignored), v_now);

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', p_upload_id, v_now);

  return jsonb_build_object('uploadId', p_upload_id, 'complete', true, 'alreadyActive', false, 'vehicleCount', v_vehicle_count,
    'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count, 'fileCount', v_file_count, 'ignored', v_ignored);
end;
$$;

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.panel_manheim_manifest_valid(jsonb, integer)',
    'public.panel_manheim_batch_start(public.panel_environment, uuid, text, integer, jsonb, jsonb, jsonb, text, jsonb, text)',
    'public.panel_manheim_batch_chunk(public.panel_environment, uuid, uuid, integer, integer, text, integer, jsonb, jsonb)',
    'public.panel_manheim_batch_finalize(public.panel_environment, uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end $$;
