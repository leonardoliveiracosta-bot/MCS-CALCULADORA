-- Complemento do lote Manheim ativo: os mesmos CSVs, lidos de novo, acrescentam só os dados de venda
-- (Lane, Run, Inventory, Status, Event Sale Name) aos carros que o lote já tem. Aditiva.
-- Depende de 20261006010000 (manheim_sale_info e panel_manheim_offer_group).
--
--  * Integridade: cada bloco lido de novo tem de ter o mesmo hash canônico do manifesto gravado no
--    lote (o servidor recalcula; os dados de venda, que o lote antigo não tinha, ficam fora do hash).
--    A chave do lote (hash do conteúdo real de cada arquivo) e o hash do manifesto também têm de ser
--    os mesmos. Qualquer diferença recusa sem gravar.
--  * Prévia (panel_manheim_complement_check): só leitura, conta por bloco.
--  * Depois do "Complementar agora": os blocos entram numa área de conferência
--    (manheim_complement_items), que ninguém lê. A gravação (panel_manheim_complement_apply) é UMA
--    transação: confere que todos os carros do lote chegaram e foram associados pelo identificador
--    estável da importação, e só então grava manheim_sale_info. Faltou um carro: nada é gravado.
--  * Carro, match, MMR, critérios, seleção, V1/V2, histórico e lotes desfeitos nunca mudam.
--  * Os mesmos arquivos de novo não geram alteração. Nenhuma chamada paga e nenhuma mensagem.

create table if not exists public.manheim_complement_runs (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  created_by uuid not null references public.panel_users(id),
  client_key text not null,
  manifest_hash text not null,
  status text not null default 'STAGING' check (status in ('STAGING', 'APPLIED', 'CANCELED')),
  cancel_reason text,
  result_json jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists manheim_complement_runs_upload_idx on public.manheim_complement_runs(environment, upload_id, status);
create index if not exists manheim_complement_runs_upload_fk_idx on public.manheim_complement_runs(upload_id);
create index if not exists manheim_complement_runs_created_by_idx on public.manheim_complement_runs(created_by);

create table if not exists public.manheim_complement_chunks (
  run_id uuid not null references public.manheim_complement_runs(id),
  file_index smallint not null,
  chunk_index smallint not null,
  chunk_hash text not null,
  item_count integer not null,
  primary key (run_id, file_index, chunk_index)
);

create table if not exists public.manheim_complement_items (
  run_id uuid not null references public.manheim_complement_runs(id),
  row_fingerprint text not null,
  sale jsonb not null,
  primary key (run_id, row_fingerprint)
);

do $$
declare v_table text;
begin
  foreach v_table in array array['manheim_complement_runs', 'manheim_complement_chunks', 'manheim_complement_items'] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('alter table public.%I force row level security', v_table);
    execute format('revoke all on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select on table public.%I to service_role', v_table);
  end loop;
end $$;

-- ---------------------------------------------------------------- lote ativo e manifesto
-- O lote tem de ser o ativo (o mesmo de BUSCAS), com a mesma chave de arquivos e o mesmo manifesto;
-- o bloco tem de existir no manifesto com o mesmo hash e a mesma quantidade.
create or replace function public.panel_manheim_complement_guard(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_client_key text, p_manifest_hash text,
  p_file_index integer, p_chunk_index integer, p_chunk_hash text, p_item_count integer
) returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_active uuid;
  v_chunk jsonb;
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  select u.id into v_active from public.manheim_uploads u
   where u.environment = p_environment and u.activated_at is not null and u.undone_at is null and u.canceled_at is null
   order by u.uploaded_at desc limit 1;
  if v_active is null or v_active <> p_upload_id then raise exception 'MANHEIM_COMPLEMENT_NOT_ACTIVE'; end if;
  select * into v_upload from public.manheim_uploads u where u.id = p_upload_id;
  if v_upload.client_key is distinct from p_client_key or v_upload.manifest_hash is distinct from p_manifest_hash
  then raise exception 'MANHEIM_COMPLEMENT_MISMATCH'; end if;
  if p_file_index is null then return; end if;
  v_chunk := v_upload.files_json -> p_file_index -> 'chunks' -> p_chunk_index;
  if v_chunk is null or v_chunk ->> 'hash' is distinct from p_chunk_hash or (v_chunk ->> 'count')::integer < p_item_count
  then raise exception 'MANHEIM_COMPLEMENT_MISMATCH'; end if;
end;
$$;

create or replace function public.panel_manheim_complement_items(p_items jsonb)
returns table(row_fingerprint text, sale jsonb) language plpgsql immutable set search_path = '' as $$
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if exists (
      select 1 from jsonb_to_recordset(p_items) as x(fingerprint text, lane text, run text, "saleType" text, "saleStatus" text, "eventSaleName" text)
       where coalesce(length(x.fingerprint), 0) not between 3 and 200 or length(coalesce(x.lane, '')) > 20 or length(coalesce(x.run, '')) > 20
          or length(coalesce(x."saleType", '')) > 80 or length(coalesce(x."saleStatus", '')) > 80 or length(coalesce(x."eventSaleName", '')) > 160)
     or (select count(*) <> count(distinct x.fingerprint) from jsonb_to_recordset(p_items) as x(fingerprint text))
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  return query
    select x.fingerprint, jsonb_build_object('lane', coalesce(x.lane, ''), 'run', coalesce(x.run, ''), 'saleType', coalesce(x."saleType", ''),
             'saleStatus', coalesce(x."saleStatus", ''), 'eventSaleName', coalesce(x."eventSaleName", ''))
      from jsonb_to_recordset(p_items) as x(fingerprint text, lane text, run text, "saleType" text, "saleStatus" text, "eventSaleName" text);
end;
$$;

-- ---------------------------------------------------------------- prévia (só leitura)
create or replace function public.panel_manheim_complement_check(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_client_key text, p_manifest_hash text,
  p_file_index integer, p_chunk_index integer, p_chunk_hash text, p_items jsonb
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, p_upload_id, p_client_key, p_manifest_hash,
    p_file_index, p_chunk_index, p_chunk_hash, jsonb_array_length(coalesce(p_items, '[]'::jsonb)));
  select jsonb_build_object(
    'received', (select count(*) from jsonb_array_elements(p_items)),
    'found', count(v.id),
    'changed', count(v.id) filter (where ((v.vehicle_json || coalesce(si.sale, '{}'::jsonb)) @> i.sale) is not true),
    'lane', count(v.id) filter (where public.panel_manheim_offer_group(v.vehicle_json || i.sale) = 'LANE'),
    'offLane', count(v.id) filter (where public.panel_manheim_offer_group(v.vehicle_json || i.sale) = 'OFFLANE'),
    'incomplete', count(v.id) filter (where public.panel_manheim_offer_group(v.vehicle_json || i.sale) = 'INCOMPLETE'))
    into v_result
    from public.panel_manheim_complement_items(p_items) i
    left join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = p_upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null
    left join public.manheim_sale_info si on si.environment = p_environment and si.upload_id = p_upload_id and si.row_fingerprint = i.row_fingerprint;
  return v_result || jsonb_build_object('missing', (v_result ->> 'received')::integer - (v_result ->> 'found')::integer);
end;
$$;

-- ---------------------------------------------------------------- área de conferência (depois da confirmação)
create or replace function public.panel_manheim_complement_start(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_client_key text, p_manifest_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run uuid;
begin
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, p_upload_id, p_client_key, p_manifest_hash, null, null, null, null);
  perform pg_advisory_xact_lock(hashtextextended('manheim_complement:' || p_environment::text || ':' || p_upload_id::text, 0));
  -- A área de conferência de envios terminados não serve para mais nada.
  delete from public.manheim_complement_items i using public.manheim_complement_runs r
   where r.id = i.run_id and r.environment = p_environment and r.upload_id = p_upload_id and r.status <> 'STAGING';
  select r.id into v_run from public.manheim_complement_runs r
   where r.environment = p_environment and r.upload_id = p_upload_id and r.created_by = p_actor_id and r.status = 'STAGING'
     and r.client_key = p_client_key and r.manifest_hash = p_manifest_hash
   order by r.created_at desc limit 1;
  if v_run is null then
    insert into public.manheim_complement_runs(environment, upload_id, created_by, client_key, manifest_hash)
    values (p_environment, p_upload_id, p_actor_id, p_client_key, p_manifest_hash) returning id into v_run;
  end if;
  return jsonb_build_object('runId', v_run, 'received',
    coalesce((select jsonb_agg(jsonb_build_array(c.file_index, c.chunk_index) order by c.file_index, c.chunk_index) from public.manheim_complement_chunks c where c.run_id = v_run), '[]'::jsonb));
end;
$$;

create or replace function public.panel_manheim_complement_stage(
  p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid,
  p_file_index integer, p_chunk_index integer, p_chunk_hash text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.manheim_complement_runs%rowtype;
  v_prior text;
  v_count integer;
  v_found integer;
begin
  select * into v_run from public.manheim_complement_runs r where r.id = p_run_id and r.environment = p_environment and r.created_by = p_actor_id for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_run.status <> 'STAGING' then raise exception 'MANHEIM_COMPLEMENT_CANCELED'; end if;
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, v_run.upload_id, v_run.client_key, v_run.manifest_hash,
    p_file_index, p_chunk_index, p_chunk_hash, jsonb_array_length(coalesce(p_items, '[]'::jsonb)));
  select c.chunk_hash into v_prior from public.manheim_complement_chunks c where c.run_id = p_run_id and c.file_index = p_file_index and c.chunk_index = p_chunk_index;
  if v_prior is not null then return jsonb_build_object('runId', p_run_id, 'stored', 0, 'again', true); end if;
  select count(*), count(v.id) into v_count, v_found
    from public.panel_manheim_complement_items(p_items) i
    left join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null;
  -- Um carro que o lote não tem: o envio inteiro é cancelado (nada foi gravado no lote).
  if v_found <> v_count then
    update public.manheim_complement_runs set status = 'CANCELED', cancel_reason = 'MISSING_VEHICLE', finished_at = now() where id = p_run_id;
    return jsonb_build_object('runId', p_run_id, 'error', 'MANHEIM_COMPLEMENT_MISMATCH');
  end if;
  insert into public.manheim_complement_items(run_id, row_fingerprint, sale)
  select p_run_id, i.row_fingerprint, i.sale from public.panel_manheim_complement_items(p_items) i;
  insert into public.manheim_complement_chunks(run_id, file_index, chunk_index, chunk_hash, item_count) values (p_run_id, p_file_index, p_chunk_index, p_chunk_hash, v_count);
  return jsonb_build_object('runId', p_run_id, 'stored', v_count, 'again', false);
end;
$$;

create or replace function public.panel_manheim_complement_cancel(p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  update public.manheim_complement_runs set status = 'CANCELED', cancel_reason = left(coalesce(p_reason, 'OPERATOR'), 60), finished_at = now()
   where id = p_run_id and environment = p_environment and created_by = p_actor_id and status = 'STAGING';
  return jsonb_build_object('runId', p_run_id, 'canceled', found);
end;
$$;

-- ---------------------------------------------------------------- gravação: tudo ou nada
create or replace function public.panel_manheim_complement_apply(p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.manheim_complement_runs%rowtype;
  v_expected_chunks integer;
  v_chunks integer;
  v_vehicles integer;
  v_items integer;
  v_found integer;
  v_changed integer;
  v_result jsonb;
begin
  select * into v_run from public.manheim_complement_runs r where r.id = p_run_id and r.environment = p_environment and r.created_by = p_actor_id for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_run.status <> 'STAGING' then raise exception 'MANHEIM_COMPLEMENT_CANCELED'; end if;
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, v_run.upload_id, v_run.client_key, v_run.manifest_hash, null, null, null, null);
  perform pg_advisory_xact_lock(hashtextextended('manheim_complement:' || p_environment::text || ':' || v_run.upload_id::text, 0));

  -- Todos os blocos do manifesto chegaram e todo carro do lote foi associado, um a um.
  select coalesce(sum((f ->> 'chunkCount')::integer), 0) into v_expected_chunks
    from public.manheim_uploads u, jsonb_array_elements(u.files_json) f where u.id = v_run.upload_id;
  select count(*) into v_chunks from public.manheim_complement_chunks c where c.run_id = p_run_id;
  select count(*) into v_vehicles from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = v_run.upload_id and v.undone_at is null;
  select count(*), count(v.id) into v_items, v_found
    from public.manheim_complement_items i
    left join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null
   where i.run_id = p_run_id;
  if v_chunks <> v_expected_chunks then raise exception 'MANHEIM_COMPLEMENT_INCOMPLETE'; end if;
  if v_items <> v_found or v_found <> v_vehicles then raise exception 'MANHEIM_COMPLEMENT_MISMATCH'; end if;

  insert into public.manheim_sale_info as si (environment, upload_id, row_fingerprint, sale, updated_by, updated_at)
  select p_environment, v_run.upload_id, i.row_fingerprint, i.sale, p_actor_id, now()
    from public.manheim_complement_items i
    join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null
    left join public.manheim_sale_info cur on cur.environment = p_environment and cur.upload_id = v_run.upload_id and cur.row_fingerprint = i.row_fingerprint
   where i.run_id = p_run_id and ((v.vehicle_json || coalesce(cur.sale, '{}'::jsonb)) @> i.sale) is not true
  on conflict (environment, upload_id, row_fingerprint) do update set sale = excluded.sale, updated_by = excluded.updated_by, updated_at = excluded.updated_at;
  get diagnostics v_changed = row_count;

  select jsonb_build_object('cars', count(*), 'changed', v_changed,
      'lane', count(*) filter (where g = 'LANE'), 'offLane', count(*) filter (where g = 'OFFLANE'), 'incomplete', count(*) filter (where g = 'INCOMPLETE'))
    into v_result
    from (select public.panel_manheim_offer_group(v.vehicle_json || coalesce(si.sale, '{}'::jsonb)) g
            from public.manheim_vehicles v
            left join public.manheim_sale_info si on si.environment = v.environment and si.upload_id = v.upload_id and si.row_fingerprint = v.row_fingerprint
           where v.environment = p_environment and v.upload_id = v_run.upload_id and v.undone_at is null) x;

  update public.manheim_complement_runs set status = 'APPLIED', result_json = v_result, finished_at = now() where id = p_run_id;
  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', v_run.upload_id, 'MANHEIM_COMPLEMENT', null, v_result || jsonb_build_object('runId', p_run_id), now());
  return v_result || jsonb_build_object('runId', p_run_id, 'uploadId', v_run.upload_id);
end;
$$;

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.panel_manheim_complement_guard(public.panel_environment, uuid, uuid, text, text, integer, integer, text, integer)',
    'public.panel_manheim_complement_items(jsonb)',
    'public.panel_manheim_complement_check(public.panel_environment, uuid, uuid, text, text, integer, integer, text, jsonb)',
    'public.panel_manheim_complement_start(public.panel_environment, uuid, uuid, text, text)',
    'public.panel_manheim_complement_stage(public.panel_environment, uuid, uuid, integer, integer, text, jsonb)',
    'public.panel_manheim_complement_cancel(public.panel_environment, uuid, uuid, text)',
    'public.panel_manheim_complement_apply(public.panel_environment, uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end $$;
