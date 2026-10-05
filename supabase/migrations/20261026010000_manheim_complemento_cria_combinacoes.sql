-- Complemento do lote Manheim, regra B: um carro que ganha Lane/Run ou Buy Now pelo complemento passa
-- pela busca contra os pedidos ativos e, se servir, vira combinação na mesma troca "Complementar agora".
-- Aditiva. Depende de 20261006030000 e 20261021010000.
--  * A busca é a mesma do lote novo (vehicle-match, regra v3.x), feita no servidor em cada bloco conferido.
--    As combinações candidatas ficam na conferência (manheim_complement_matches) e só entram no lote na
--    troca, junto com os dados de venda: tudo ou nada.
--  * Nada some: combinação que já existe (mesmo carro, mesmo cliente, mesmo modo) não é tocada, nem a
--    seleção, a conferência ou a V1/V2 dela. Combinação desfeita continua desfeita.
--  * Carro sem nenhum dado de venda continua fora (a busca exige Lane/Run ou Buy Now).
--  * Combinação nova por orçamento (budgetFallback) só fica se o mesmo pedido não tiver uma exata; as
--    combinações antigas nunca são desfeitas aqui.
--  * "Comparar de novo" um pedido (critério editado, pedido novo, sincronização) lê os carros do lote com
--    os dados de venda em uso (manheim_vehicles_current). Antes lia sem eles e desfazia as combinações
--    dos carros que só têm Lane/Run ou Buy Now pelo complemento.

create table if not exists public.manheim_complement_matches (
  run_id uuid not null references public.manheim_complement_runs(id),
  file_index smallint not null,
  chunk_index smallint not null,
  item jsonb not null
);
create index if not exists manheim_complement_matches_run_idx on public.manheim_complement_matches(run_id);
alter table public.manheim_complement_matches enable row level security;
alter table public.manheim_complement_matches force row level security;
revoke all on table public.manheim_complement_matches from public, anon, authenticated;
grant select on table public.manheim_complement_matches to service_role;

-- ---------------------------------------------------------------- carros do lote com os dados de venda em uso
create or replace view public.manheim_vehicles_current with (security_invoker = true) as
select v.id, v.environment, v.upload_id, v.row_fingerprint, v.make_key, v.mmr_cents, v.undone_at,
       v.vehicle_json || coalesce(si.sale, '{}'::jsonb) as vehicle_json
  from public.manheim_vehicles v
  left join public.manheim_sale_current c on c.environment = v.environment and c.upload_id = v.upload_id
  left join public.manheim_complement_items si on si.run_id = c.run_id and si.row_fingerprint = v.row_fingerprint;
revoke all on table public.manheim_vehicles_current from public, anon, authenticated;
grant select on table public.manheim_vehicles_current to service_role;

-- ---------------------------------------------------------------- começo: limpa também as combinações de envios velhos
create or replace function public.panel_manheim_complement_start(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_client_key text, p_manifest_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run uuid;
begin
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, p_upload_id, p_client_key, p_manifest_hash, null, null, null, null);
  perform pg_advisory_xact_lock(hashtextextended('manheim_complement:' || p_environment::text || ':' || p_upload_id::text, 0));
  -- Envio cancelado ou substituído não serve para mais nada (o complemento em uso nunca é apagado).
  delete from public.manheim_complement_items i using public.manheim_complement_runs r
   where r.id = i.run_id and r.environment = p_environment and r.upload_id = p_upload_id and r.status <> 'STAGING'
     and r.id is distinct from (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id);
  delete from public.manheim_complement_matches x using public.manheim_complement_runs r
   where r.id = x.run_id and r.environment = p_environment and r.upload_id = p_upload_id and r.status <> 'STAGING';
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

-- ---------------------------------------------------------------- conferência de um bloco: dados de venda + combinações candidatas
drop function if exists public.panel_manheim_complement_stage(public.panel_environment, uuid, uuid, integer, integer, text, jsonb);
create function public.panel_manheim_complement_stage(
  p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid,
  p_file_index integer, p_chunk_index integer, p_chunk_hash text, p_items jsonb, p_matches jsonb default '[]'::jsonb
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
  if jsonb_typeof(coalesce(p_matches, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_matches, '[]'::jsonb)) > 20000 then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if exists (
    select 1 from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) m
     where coalesce(m.value ->> 'kind', '') not in ('BATE','POR_VALOR')
        or coalesce(m.value ->> 'mode', '') not in ('CARRO','VALOR')
        or (m.value ->> 'mode' = 'CARRO' and m.value ->> 'kind' <> 'BATE')
        or length(coalesce(m.value ->> 'fingerprint', '')) not between 3 and 200
        or jsonb_typeof(m.value -> 'vehicle') <> 'object'
        or octet_length((m.value -> 'vehicle')::text) > 16384
        or length(coalesce(m.value ->> 'demandKey', '')) not between 10 and 80
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;
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
  insert into public.manheim_complement_items(run_id, row_fingerprint, sale, offer_group)
  select p_run_id, i.row_fingerprint, i.sale, public.panel_manheim_offer_group(v.vehicle_json || i.sale)
    from public.panel_manheim_complement_items(p_items) i
    join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null;
  -- Só combinações de carros deste bloco; ninguém lê esta tabela antes da troca.
  insert into public.manheim_complement_matches(run_id, file_index, chunk_index, item)
  select p_run_id, p_file_index, p_chunk_index, m.value
    from jsonb_array_elements(coalesce(p_matches, '[]'::jsonb)) m
   where (m.value ->> 'fingerprint') in (select i.row_fingerprint from public.panel_manheim_complement_items(p_items) i);
  insert into public.manheim_complement_chunks(run_id, file_index, chunk_index, chunk_hash, item_count) values (p_run_id, p_file_index, p_chunk_index, p_chunk_hash, v_count);
  return jsonb_build_object('runId', p_run_id, 'stored', v_count, 'again', false);
end;
$$;

-- ---------------------------------------------------------------- gravação: dados de venda e combinações novas, tudo ou nada
create or replace function public.panel_manheim_complement_apply(p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.manheim_complement_runs%rowtype;
  v_expected_chunks integer;
  v_chunks integer;
  v_vehicles integer;
  v_items integer;
  v_found integer;
  v_current uuid;
  v_changed integer;
  v_new_matches integer := 0;
  v_match_count integer;
  v_lead_count integer;
  v_result jsonb;
  v_now timestamptz := now();
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

  select c.run_id into v_current from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = v_run.upload_id for update;
  select count(*) into v_changed
    from public.manheim_complement_items i
    left join public.manheim_complement_items cur on cur.run_id = v_current and cur.row_fingerprint = i.row_fingerprint
   where i.run_id = p_run_id and cur.sale is distinct from i.sale;
  -- Os mesmos dados de novo: nada muda.
  if v_changed = 0 then
    update public.manheim_complement_runs set status = 'CANCELED', cancel_reason = 'NO_CHANGE', finished_at = now() where id = p_run_id;
    delete from public.manheim_complement_matches x where x.run_id = p_run_id;
    return jsonb_build_object('runId', p_run_id, 'uploadId', v_run.upload_id, 'applied', false, 'cars', v_found, 'changed', 0, 'newMatches', 0);
  end if;

  insert into public.manheim_sale_current(environment, upload_id, run_id, applied_by, applied_at)
  values (p_environment, v_run.upload_id, p_run_id, p_actor_id, v_now)
  on conflict (environment, upload_id) do update set run_id = excluded.run_id, applied_by = excluded.applied_by, applied_at = excluded.applied_at;

  -- Combinações novas, com as mesmas validações do lote novo (pedido ativo, Ref válida, MMR). Uma que
  -- já existe (mesmo carro, cliente e modo, ativa ou desfeita) não é tocada.
  with requested as (
    select x.item, nullif(x.item ->> 'journeyId', '') as journey_text, upper(nullif(x.item ->> 'calcRef', '')) as ref_text
      from public.manheim_complement_matches x where x.run_id = p_run_id
  ), typed as (
    select r.item,
           case when coalesce(r.item ->> 'targetType', '') = 'ORDER' then null
                when r.journey_text ~ '^[0-9a-fA-F-]{36}$' then r.journey_text::uuid else null end as journey_id,
           case when coalesce(r.item ->> 'targetType', '') = 'ORDER' and r.ref_text ~ '^[A-HJ-NP-Z2-9]{5}$' then r.ref_text else null end as calc_ref
      from requested r
  ), refs_ok as (
    select distinct t.calc_ref from typed t
     where t.calc_ref is not null
       and exists (select 1 from public.calc_runs cr where not cr.is_test and upper(coalesce(cr.dados ->> 'ref', '')) = t.calc_ref)
       and not exists (select 1 from public.panel_item_dispositions d
          where d.environment = p_environment and d.item_kind = 'REF' and upper(d.item_key) = t.calc_ref and d.status = 'DISCARDED' and d.cleared_at is null)
  ), valid as (
    select t.* from typed t
      left join public.journeys j on j.environment = p_environment and j.id = t.journey_id
      left join public.journey_toggle_states ts on ts.environment = j.environment and ts.journey_id = j.id
     where coalesce((t.item ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (t.item ->> 'mmrCents')::integer > 0, false)
       and exists (select 1 from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = v_run.upload_id
                    and v.row_fingerprint = t.item ->> 'fingerprint' and v.undone_at is null)
       and ((t.calc_ref is not null and t.calc_ref in (select calc_ref from refs_ok))
         or (t.journey_id is not null and j.id is not null and j.status <> 'ENCERRADO'
           and ((coalesce(ts.enabled, true) and (j.status <> 'PARADO' or t.item ->> 'kind' = 'BATE'))
             or (not coalesce(ts.enabled, true) and coalesce(ts.off_reason, '') in ('GAVE_UP','NO_RESPONSE') and t.item ->> 'kind' = 'BATE'))))
  ), inserted as (
    insert into public.manheim_matches(
      environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
      logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
    )
    select p_environment, v_run.upload_id, v.journey_id, v.calc_ref::char(5), v.item ->> 'kind', nullif(left(v.item ->> 'reason', 500), ''),
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
    returning id
  )
  select count(*) into v_new_matches from inserted;

  -- Combinação nova por orçamento sai quando o mesmo pedido tem uma exata (as antigas ficam como estão).
  update public.manheim_matches fallback set undone_at = v_now
   where fallback.environment = p_environment and fallback.upload_id = v_run.upload_id and fallback.undone_at is null
     and fallback.created_at = v_now and fallback.vehicle_json -> 'parsed' ->> 'budgetFallback' = 'true'
     and exists (select 1 from public.manheim_matches strict where strict.environment = p_environment and strict.upload_id = v_run.upload_id
       and strict.demand_key = fallback.demand_key and strict.wish_index is not distinct from fallback.wish_index and strict.undone_at is null
       and coalesce(strict.vehicle_json -> 'parsed' ->> 'budgetFallback', 'false') <> 'true');
  select count(*) into v_new_matches from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = v_run.upload_id and m.created_at = v_now and m.undone_at is null;
  delete from public.manheim_complement_matches x where x.run_id = p_run_id;

  select count(distinct m.row_fingerprint),
         count(distinct case when match_kind not in ('BATE','POR_VALOR') then null
                             when journey_id is not null then 'j:' || journey_id::text
                             else 'r:' || trim(calc_ref::text) end)
    into v_match_count, v_lead_count
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = v_run.upload_id and m.undone_at is null;
  update public.manheim_uploads set matched_vehicle_count = v_match_count, lead_count = v_lead_count
   where id = v_run.upload_id and environment = p_environment;

  v_result := jsonb_build_object('cars', v_found, 'changed', v_changed, 'newMatches', v_new_matches);
  update public.manheim_complement_runs set status = 'APPLIED', result_json = v_result, finished_at = now() where id = p_run_id;
  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', v_run.upload_id, 'MANHEIM_COMPLEMENT',
    case when v_current is null then null else jsonb_build_object('runId', v_current) end, v_result || jsonb_build_object('runId', p_run_id), v_now);
  if v_new_matches > 0 then
    insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
    values (p_environment, 'panel.updated', 'manheim_upload', v_run.upload_id, v_now);
  end if;
  return v_result || jsonb_build_object('runId', p_run_id, 'uploadId', v_run.upload_id, 'applied', true);
end;
$$;

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.panel_manheim_complement_start(public.panel_environment, uuid, uuid, text, text)',
    'public.panel_manheim_complement_stage(public.panel_environment, uuid, uuid, integer, integer, text, jsonb, jsonb)',
    'public.panel_manheim_complement_apply(public.panel_environment, uuid, uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end $$;
