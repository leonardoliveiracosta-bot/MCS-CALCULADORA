-- ENVIAR OPÇÕES · pedidos POR CARRO: carros "Próximo" (ano 1 a menos ou 1 a mais do pedido, milhas até 15%
-- acima do máximo pedido), depois dos exatos. Só acrescenta:
--  * panel_manheim_add_near_matches insere os próximos de um pedido. Uma linha ativa nunca é alterada nem
--    retirada; só volta uma linha do mesmo carro que estava retirada (por exemplo pelo "Comparar de novo").
--  * As quatro leituras da lista (página, ordenada, trim e a leitura única) ganham, antes da ordem de hoje, só
--    "próximo por último". Hoje nenhuma linha é próxima, então a ordem atual não muda.
--  * manheim_near_syncs (tabela nova, só desta regra) guarda qual pedido já passou por ela em cada lote e critério.
-- POR VALOR, seleções, envios e dados do lote ficam como estão.

create table if not exists public.manheim_near_syncs (
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  demand_key text not null check (demand_key ~ '^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):CARRO$'),
  criteria_hash text not null check (length(criteria_hash) between 8 and 64),
  added integer not null default 0 check (added >= 0),
  synced_at timestamptz not null default now(),
  synced_by uuid references public.panel_users(id),
  primary key (environment, upload_id, demand_key, criteria_hash)
);
create index if not exists manheim_near_syncs_synced_by_idx on public.manheim_near_syncs(synced_by);
alter table public.manheim_near_syncs enable row level security;
alter table public.manheim_near_syncs force row level security;
revoke all on public.manheim_near_syncs from public, anon, authenticated;
grant select, insert, update, delete on public.manheim_near_syncs to service_role;

create or replace function public.panel_manheim_add_near_matches(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_demand_key text, p_matches jsonb
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_journey uuid;
  v_ref text;
  v_added integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment;
  if not found or v_upload.activated_at is null or v_upload.undone_at is not null then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if coalesce(p_demand_key, '') !~ '^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):CARRO$'
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 20000
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if p_demand_key like 'journey:%' then v_journey := split_part(p_demand_key, ':', 2)::uuid; else v_ref := split_part(p_demand_key, ':', 2); end if;
  -- Só próximos POR CARRO deste pedido, de carros do próprio lote.
  if exists (
    select 1 from jsonb_array_elements(p_matches) m
     where coalesce(m.value ->> 'demandKey', '') <> p_demand_key
        or coalesce(m.value ->> 'kind', '') <> 'BATE'
        or coalesce(m.value ->> 'mode', '') <> 'CARRO'
        or coalesce(m.value #>> '{vehicle,parsed,matchNear}', '') <> 'true'
        or length(coalesce(m.value ->> 'fingerprint', '')) not between 3 and 200
        or not coalesce((m.value ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (m.value ->> 'mmrCents')::integer > 0, false)
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;
  if exists (
    select 1 from jsonb_array_elements(p_matches) m
     where not exists (select 1 from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = p_upload_id and v.row_fingerprint = m.value ->> 'fingerprint')
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  if v_journey is not null then
    with incoming as (
      select n.value as item from jsonb_array_elements(p_matches) n
    ), changed as (
      insert into public.manheim_matches as m (
        environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
        logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
      )
      select p_environment, p_upload_id, v_journey, null, 'BATE', nullif(left(i.item ->> 'reason', 500), ''), null,
             i.item ->> 'fingerprint', i.item -> 'vehicle', 'CARRO'::public.panel_logical_mode, v_now, p_demand_key, 1,
             case when (i.item ->> 'sortMiles') ~ '^[0-9]{1,10}$' and (i.item ->> 'sortMiles')::bigint <= 2147483647 then (i.item ->> 'sortMiles')::integer else 2147483647 end,
             nullif(left(upper(coalesce(i.item ->> 'vin', '')), 40), ''),
             case when (i.item ->> 'wishIndex') ~ '^[0-9]$' then (i.item ->> 'wishIndex')::smallint else null end,
             (i.item ->> 'mmrCents')::integer, nullif(left(coalesce(i.item ->> 'criteriaHash', ''), 64), '')
        from incoming i
      on conflict (environment, upload_id, journey_id, row_fingerprint, logical_mode) where journey_id is not null do update
        set match_kind = excluded.match_kind, match_reason = excluded.match_reason, mmr_status = excluded.mmr_status,
            vehicle_json = excluded.vehicle_json, demand_key = excluded.demand_key, sort_rank = excluded.sort_rank,
            sort_miles = excluded.sort_miles, vin = excluded.vin, wish_index = excluded.wish_index,
            mmr_cents = excluded.mmr_cents, criteria_hash = excluded.criteria_hash, undone_at = null
        where m.undone_at is not null
      returning 1
    )
    select count(*) into v_added from changed;
  else
    with incoming as (
      select n.value as item from jsonb_array_elements(p_matches) n
    ), changed as (
      insert into public.manheim_matches as m (
        environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
        logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
      )
      select p_environment, p_upload_id, null, v_ref::char(5), 'BATE', nullif(left(i.item ->> 'reason', 500), ''), null,
             i.item ->> 'fingerprint', i.item -> 'vehicle', 'CARRO'::public.panel_logical_mode, v_now, p_demand_key, 1,
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
        where m.undone_at is not null
      returning 1
    )
    select count(*) into v_added from changed;
  end if;

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'ADD_NEAR_MATCHES',
    jsonb_build_object('demand_key', p_demand_key, 'added', v_added), v_now);

  return jsonb_build_object('uploadId', p_upload_id, 'demandKey', p_demand_key, 'added', v_added);
end;
$$;
revoke all on function public.panel_manheim_add_near_matches(public.panel_environment, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.panel_manheim_add_near_matches(public.panel_environment, uuid, uuid, text, jsonb) to service_role;

-- "Próximo por último" na ordem final de cada leitura da lista, sem mudar mais nada da definição de hoje.
do $$
declare
  v_name text;
  v_def text;
  v_marker constant text := E'\n   order by ';
  v_near constant text := E'\n   order by (coalesce(t.parsed ->> ''matchNear'', '''') = ''true''), ';
begin
  foreach v_name in array array['panel_manheim_offer_page', 'panel_manheim_offer_page_sorted', 'panel_manheim_offer_page_trim', 'panel_manheim_offer_page_bundle'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_name;
    if v_def is null then raise exception 'OPCOES_PROXIMO: % não existe', v_name; end if;
    if position('matchNear' in v_def) > 0 then continue; end if;
    if (length(v_def) - length(replace(v_def, v_marker, ''))) / length(v_marker) <> 1 then
      raise exception 'OPCOES_PROXIMO: % não tem exatamente uma ordem final', v_name;
    end if;
    execute replace(v_def, v_marker, v_near);
  end loop;
end;
$$;
