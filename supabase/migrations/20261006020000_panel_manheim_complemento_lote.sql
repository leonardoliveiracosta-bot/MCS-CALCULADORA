-- Complemento do lote Manheim ativo: os mesmos CSVs lidos de novo acrescentam só os dados de venda
-- (Lane, Run, Inventory, Status, Event Sale Name) aos carros que o lote já tem. Aditiva.
--
--  * Não cria lote, não cria nem apaga match, não recalcula nada: só junta estas cinco chaves ao
--    carro (manheim_vehicles.vehicle_json) e à cópia dele nos matches (vehicle_json -> 'parsed').
--  * MMR, critérios, seleção, V1/V2 e histórico ficam como estão (carro ou match desfeito não muda).
--  * Só o lote ativo. Um bloco com um carro que o lote não tem é recusado inteiro, sem gravar.
--  * p_apply = false só conta (prévia para o operador); p_apply = true grava e deixa no audit_log.
--  * Nenhuma chamada paga e nenhuma mensagem.
-- Depende de 20261006010000 (panel_manheim_offer_group).

create or replace function public.panel_manheim_batch_complement(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid,
  p_items jsonb,
  p_apply boolean
) returns jsonb
language plpgsql security definer set search_path = '' set statement_timeout = '30s'
as $$
declare
  v_active uuid;
  v_count integer;
  v_distinct integer;
  v_found integer;
  v_changed integer;
  v_lane integer;
  v_offlane integer;
  v_incomplete integer;
  v_vehicles integer := 0;
  v_matches integer := 0;
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 1000
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  -- O lote ativo é o último ativado e não desfeito (o mesmo que BUSCAS mostra).
  select u.id into v_active from public.manheim_uploads u
   where u.environment = p_environment and u.activated_at is not null and u.undone_at is null and u.canceled_at is null
   order by u.uploaded_at desc limit 1;
  if v_active is null or v_active <> p_upload_id then raise exception 'MANHEIM_COMPLEMENT_NOT_ACTIVE'; end if;
  -- Um complemento por vez neste lote.
  perform pg_advisory_xact_lock(hashtextextended('manheim_complement:' || p_environment::text || ':' || p_upload_id::text, 0));

  create temp table if not exists pg_temp._manheim_complement(fingerprint text primary key, patch jsonb not null) on commit drop;
  truncate pg_temp._manheim_complement;
  select count(*), count(distinct x.fingerprint) into v_count, v_distinct
    from jsonb_to_recordset(p_items) as x(fingerprint text, lane text, run text, "saleType" text, "saleStatus" text, "eventSaleName" text);
  if v_count <> v_distinct or exists (
      select 1 from jsonb_to_recordset(p_items) as x(fingerprint text, lane text, run text, "saleType" text, "saleStatus" text, "eventSaleName" text)
       where coalesce(length(x.fingerprint), 0) not between 3 and 200 or length(coalesce(x.lane, '')) > 20 or length(coalesce(x.run, '')) > 20
          or length(coalesce(x."saleType", '')) > 80 or length(coalesce(x."saleStatus", '')) > 80 or length(coalesce(x."eventSaleName", '')) > 160)
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  insert into pg_temp._manheim_complement(fingerprint, patch)
  select x.fingerprint, jsonb_build_object('lane', coalesce(x.lane, ''), 'run', coalesce(x.run, ''), 'saleType', coalesce(x."saleType", ''),
           'saleStatus', coalesce(x."saleStatus", ''), 'eventSaleName', coalesce(x."eventSaleName", ''))
    from jsonb_to_recordset(p_items) as x(fingerprint text, lane text, run text, "saleType" text, "saleStatus" text, "eventSaleName" text);

  select count(*)::integer,
         count(*) filter (where (v.vehicle_json @> c.patch) is not true)::integer,
         count(*) filter (where public.panel_manheim_offer_group(v.vehicle_json || c.patch) = 'LANE')::integer,
         count(*) filter (where public.panel_manheim_offer_group(v.vehicle_json || c.patch) = 'OFFLANE')::integer,
         count(*) filter (where public.panel_manheim_offer_group(v.vehicle_json || c.patch) = 'INCOMPLETE')::integer
    into v_found, v_changed, v_lane, v_offlane, v_incomplete
    from pg_temp._manheim_complement c
    join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = p_upload_id and v.row_fingerprint = c.fingerprint and v.undone_at is null;

  if p_apply then
    -- Arquivo que não corresponde ao lote: nada deste bloco é gravado.
    if v_found <> v_count then raise exception 'MANHEIM_COMPLEMENT_MISMATCH'; end if;
    update public.manheim_vehicles v set vehicle_json = v.vehicle_json || c.patch
      from pg_temp._manheim_complement c
     where v.environment = p_environment and v.upload_id = p_upload_id and v.row_fingerprint = c.fingerprint and v.undone_at is null
       and (v.vehicle_json @> c.patch) is not true;
    get diagnostics v_vehicles = row_count;
    update public.manheim_matches m set vehicle_json = jsonb_set(m.vehicle_json, '{parsed}', coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || c.patch)
      from pg_temp._manheim_complement c
     where m.environment = p_environment and m.upload_id = p_upload_id and m.row_fingerprint = c.fingerprint and m.undone_at is null
       and (coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) @> c.patch) is not true;
    get diagnostics v_matches = row_count;
    insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
    values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'MANHEIM_COMPLEMENT', null,
      jsonb_build_object('cars', v_count, 'vehiclesUpdated', v_vehicles, 'matchesUpdated', v_matches, 'lane', v_lane, 'offLane', v_offlane, 'incomplete', v_incomplete), now());
  end if;

  return jsonb_build_object('uploadId', p_upload_id, 'applied', p_apply, 'received', v_count, 'found', v_found, 'missing', v_count - v_found,
    'changed', v_changed, 'lane', v_lane, 'offLane', v_offlane, 'incomplete', v_incomplete, 'vehiclesUpdated', v_vehicles, 'matchesUpdated', v_matches);
end;
$$;

revoke all on function public.panel_manheim_batch_complement(public.panel_environment, uuid, uuid, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.panel_manheim_batch_complement(public.panel_environment, uuid, uuid, jsonb, boolean) to service_role;
