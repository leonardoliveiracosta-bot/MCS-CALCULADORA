-- Acrescentar arquivos ao lote ativo do Manheim, sem trocar o lote.
-- Os arquivos novos passam pelo mesmo caminho da importação (montagem invisível em blocos, manifesto com hash,
-- comparação com os pedidos de hoje). No fim, em uma transação só, os carros que o lote ativo ainda não tem
-- (e as combinações deles) passam para o lote ativo; carro repetido é pulado. O lote ativo não muda de id:
-- seleções, preços, V1/V2 e histórico continuam valendo. A montagem fica registrada como "juntada" e nunca
-- aparece como lote. Se o lote ativo mudou (outro lote foi ativado ou ele foi desfeito) nada é juntado.

alter table public.manheim_uploads add column if not exists append_to uuid references public.manheim_uploads(id);
alter table public.manheim_uploads add column if not exists merged_at timestamptz;
alter table public.manheim_uploads add column if not exists appended_files_json jsonb not null default '[]'::jsonb;
create index if not exists manheim_uploads_append_to_idx on public.manheim_uploads(append_to) where append_to is not null;

-- O lote ativo de agora: ativado, não desfeito, o mais recente.
create or replace function public.panel_manheim_active_upload_id(p_environment public.panel_environment)
returns uuid language sql stable security definer set search_path = '' as $$
  select u.id from public.manheim_uploads u
   where u.environment = p_environment and u.activated_at is not null and u.undone_at is null
   order by u.uploaded_at desc limit 1
$$;

-- Marca uma montagem (ainda não ativada) como acréscimo do lote ativo. Idempotente para o mesmo alvo.
create or replace function public.panel_manheim_batch_append_mark(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_target_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_upload public.manheim_uploads%rowtype;
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment and u.created_by = p_actor_id for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if v_upload.activated_at is not null then raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE'; end if;
  if p_target_id is null or p_target_id is distinct from public.panel_manheim_active_upload_id(p_environment) then raise exception 'MANHEIM_APPEND_TARGET_CHANGED'; end if;
  if v_upload.append_to is not null and v_upload.append_to <> p_target_id then raise exception 'MANHEIM_APPEND_TARGET_CHANGED'; end if;
  -- Uma montagem que já recebeu blocos como lote comum não vira acréscimo.
  if v_upload.append_to is null and exists (select 1 from public.manheim_upload_chunks c where c.upload_id = p_upload_id) then raise exception 'MANHEIM_APPEND_TARGET_CHANGED'; end if;
  update public.manheim_uploads set append_to = p_target_id where id = p_upload_id and environment = p_environment;
  return jsonb_build_object('uploadId', p_upload_id, 'appendTo', p_target_id);
end;
$$;

-- Junta a montagem ao lote ativo: mesma conferência de integridade da ativação, depois uma troca só.
create or replace function public.panel_manheim_batch_append_finalize(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_target public.manheim_uploads%rowtype;
  v_missing integer;
  v_problem text;
  v_stored integer;
  v_ignored integer;
  v_staged integer;
  v_added integer;
  v_moved_matches integer;
  v_vehicle_count integer;
  v_match_count integer;
  v_lead_count integer;
  v_new_files integer;
  v_now timestamptz := now();
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.append_to is null then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if v_upload.merged_at is not null then
    select * into v_target from public.manheim_uploads u where u.id = v_upload.append_to;
    return jsonb_build_object('uploadId', v_upload.append_to, 'appended', true, 'alreadyMerged', true, 'vehicleCount', v_target.vehicle_count,
      'matchedVehicleCount', v_target.matched_vehicle_count, 'leadCount', v_target.lead_count, 'fileCount', v_target.source_file_count,
      'added', coalesce((v_upload.undo_summary ->> 'added')::integer, 0), 'alreadyInBatch', coalesce((v_upload.undo_summary ->> 'alreadyInBatch')::integer, 0));
  end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if v_upload.activated_at is not null then raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE'; end if;

  -- O alvo ainda é o lote ativo (trava para ninguém ativar ou desfazer no meio).
  select * into v_target from public.manheim_uploads u where u.id = v_upload.append_to and u.environment = p_environment for update;
  if not found or v_target.activated_at is null or v_target.undone_at is not null
     or v_target.id is distinct from public.panel_manheim_active_upload_id(p_environment) then raise exception 'MANHEIM_APPEND_TARGET_CHANGED'; end if;

  if v_upload.manifest_hash is null or not public.panel_manheim_manifest_valid(v_upload.files_json, v_upload.vehicle_count) then
    raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR';
  end if;
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
  if v_problem is null and exists (
    select 1 from jsonb_array_elements(v_upload.files_json) with ordinality f
     where (select coalesce(sum(c.vehicle_count), 0) from public.manheim_upload_chunks c
             where c.upload_id = p_upload_id and c.file_index = (f.ordinality - 1)::integer) <> (f.value ->> 'vehicleCount')::integer
  ) then v_problem := 'QUANTIDADE_DO_ARQUIVO'; end if;
  select coalesce(sum(c.stored_vehicle_count), 0), coalesce(sum(c.ignored_count), 0) into v_stored, v_ignored
    from public.manheim_upload_chunks c where c.upload_id = p_upload_id;
  select count(*) into v_staged from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = p_upload_id;
  if v_problem is null and v_stored + v_ignored <> v_upload.vehicle_count then v_problem := 'QUANTIDADE_DO_LOTE'; end if;
  if v_problem is null and v_staged <> v_stored then v_problem := 'CARROS_UNICOS'; end if;
  if v_problem is not null then raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR' using detail = v_problem; end if;

  -- Só o que o lote ativo ainda não tem: primeiro as combinações, depois os carros (a mesma condição).
  update public.manheim_matches m set upload_id = v_target.id
   where m.environment = p_environment and m.upload_id = p_upload_id
     and not exists (select 1 from public.manheim_vehicles t where t.environment = p_environment and t.upload_id = v_target.id and t.row_fingerprint = m.row_fingerprint);
  get diagnostics v_moved_matches = row_count;
  update public.manheim_vehicles v set upload_id = v_target.id
   where v.environment = p_environment and v.upload_id = p_upload_id
     and not exists (select 1 from public.manheim_vehicles t where t.environment = p_environment and t.upload_id = v_target.id and t.row_fingerprint = v.row_fingerprint);
  get diagnostics v_added = row_count;

  select count(*) into v_vehicle_count from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = v_target.id;
  select count(distinct m.row_fingerprint),
         count(distinct case when match_kind not in ('BATE','POR_VALOR') then null
                             when journey_id is not null then 'j:' || journey_id::text
                             else 'r:' || trim(calc_ref::text) end)
    into v_match_count, v_lead_count
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = v_target.id and m.undone_at is null;
  v_new_files := jsonb_array_length(v_upload.files_json);

  update public.manheim_uploads
     set vehicle_count = v_vehicle_count, matched_vehicle_count = v_match_count, lead_count = v_lead_count,
         source_file_count = source_file_count + v_new_files,
         appended_files_json = coalesce(appended_files_json, '[]'::jsonb) || coalesce((
           select jsonb_agg(jsonb_build_object('name', f.value ->> 'name', 'vehicleCount', (f.value ->> 'vehicleCount')::integer,
                                               'addedAt', v_now, 'appendUploadId', p_upload_id))
             from jsonb_array_elements(v_upload.files_json) f), '[]'::jsonb)
   where id = v_target.id and environment = p_environment;

  -- A montagem fica registrada como juntada (nunca aparece como lote).
  update public.manheim_uploads
     set merged_at = v_now, canceled_at = v_now, undone_at = v_now, undone_by = p_actor_id,
         undo_summary = jsonb_build_object('merged', true, 'mergedInto', v_target.id, 'added', v_added, 'alreadyInBatch', v_staged - v_added, 'matches', v_moved_matches)
   where id = p_upload_id and environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (p_environment, 'MANHEIM_UPLOAD_APPENDED', 'Arquivos acrescentados ao lote ativo do Manheim',
    jsonb_build_object('upload_id', v_target.id, 'append_upload_id', p_upload_id, 'added', v_added, 'already_in_batch', v_staged - v_added,
      'matches', v_moved_matches, 'file_count', v_new_files, 'vehicle_count', v_vehicle_count), v_now, p_actor_id);
  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', v_target.id, 'APPEND',
    jsonb_build_object('vehicle_count', v_target.vehicle_count, 'file_count', v_target.source_file_count),
    jsonb_build_object('vehicle_count', v_vehicle_count, 'added', v_added, 'already_in_batch', v_staged - v_added, 'matches', v_moved_matches,
      'append_upload_id', p_upload_id, 'manifest_hash', v_upload.manifest_hash), v_now);
  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', v_target.id, v_now);

  return jsonb_build_object('uploadId', v_target.id, 'appended', true, 'alreadyMerged', false, 'added', v_added, 'alreadyInBatch', v_staged - v_added,
    'vehicleCount', v_vehicle_count, 'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count,
    'fileCount', v_target.source_file_count + v_new_files, 'newFiles', v_new_files, 'ignored', v_ignored);
end;
$$;

revoke all on function public.panel_manheim_active_upload_id(public.panel_environment) from public, anon, authenticated;
revoke all on function public.panel_manheim_batch_append_mark(public.panel_environment, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.panel_manheim_batch_append_finalize(public.panel_environment, uuid, uuid) from public, anon, authenticated;
grant execute on function public.panel_manheim_active_upload_id(public.panel_environment) to service_role;
grant execute on function public.panel_manheim_batch_append_mark(public.panel_environment, uuid, uuid, uuid) to service_role;
grant execute on function public.panel_manheim_batch_append_finalize(public.panel_environment, uuid, uuid) to service_role;
