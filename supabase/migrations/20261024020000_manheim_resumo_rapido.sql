-- ENVIAR OPÇÕES voltou a carregar: os resumos do lote ativo agrupavam o lote inteiro por VIN com
-- panel_manheim_grouped_options(…, null), montando o JSON de cada carro (compras, membros), e passavam
-- dos 8 s do PostgREST (resumo 9,4 s; seleção 12 s; carros, pessoas e score ~9 s) com 55 mil carros.
-- Mesma regra v3.4 (um carro por VIN em cada pedido, só vendas ativas com MMR, o mesmo representante:
-- ativo, Lane/Run, Buy Now, incompleto, id), agora numa base leve: só colunas simples, as regras de
-- venda ativa, MMR e grupo escritas na própria consulta (uma função por carro custava ~1,5 s) e nenhum
-- JSON montado. Resultado conferido igual ao anterior no lote ativo (383 pedidos, 0 diferenças).
-- Nada é gravado: nenhum match, lote ou seleção muda.

create or replace function public.panel_manheim_grouped_light(p_environment public.panel_environment, p_upload_id uuid)
returns table(upload_id uuid, demand_key text, dk text, car_key text, id uuid, logical_mode text, journey_id uuid, calc_ref text,
              match_kind text, criteria_hash text, presented boolean, mmr_cents integer, wish_index smallint, offer_group text, selected_id uuid)
language sql stable set search_path to '' set work_mem to '32MB' as $function$
  with selected as (
    select ss.match_id, ss.updated_at, ss.id from public.manheim_option_selections ss where ss.environment = p_environment and ss.status = 'SELECTED'
  ), flagged as materialized (
    select m.upload_id, m.demand_key,
           coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as dk,
           coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), 'row:' || m.id) as vk,
           coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), m.row_fingerprint) as car_key,
           m.id, m.logical_mode::text as logical_mode, m.journey_id, trim(m.calc_ref::text) as calc_ref, m.match_kind, m.criteria_hash,
           (m.presented_unit_id is not null) as presented, m.mmr_cents, m.wish_index,
           -- panel_manheim_sale_active and panel_manheim_offer_mmr, inline.
           (case when nullif(trim(x.p ->> 'endsAt'), '') is null then true when not pg_input_is_valid(x.p ->> 'endsAt', 'timestamptz') then true else (x.p ->> 'endsAt')::timestamptz > now() end)
             and (case when m.mmr_cents > 0 then true when coalesce(x.p ->> 'mmrCents', '') ~ '^[0-9]{1,12}$' then (x.p ->> 'mmrCents')::bigint > 0 else false end) as active,
           -- panel_manheim_offer_group, inline: 0 Lane/Run, 1 Buy Now, 2 incompleto.
           case when coalesce(trim(x.p ->> 'lane'), '') <> '' and coalesce(trim(x.p ->> 'run'), '') <> '' then 0
                when regexp_replace(coalesce(x.p ->> 'buyNowPrice', ''), '[$,\s]', '', 'g') ~ '^\d+(\.\d+)?$' then case when regexp_replace(x.p ->> 'buyNowPrice', '[$,\s]', '', 'g')::numeric > 0 then 1 else 2 end
                else 2 end as priority,
           s.match_id as sel_id, s.updated_at as sel_at, s.id as sel_row
      from public.manheim_matches m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
      left join selected s on s.match_id = m.id
     cross join lateral (select coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as p) x
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
  ), ranked as (
    select f.*, row_number() over (partition by f.dk, f.vk order by f.active desc, f.priority, f.id) as rn,
           bool_or(f.presented) over (partition by f.dk, f.vk) as any_presented,
           first_value(f.sel_id) over (partition by f.dk, f.vk order by f.sel_id is null, f.sel_at, f.sel_row rows between unbounded preceding and unbounded following) as first_selected
      from flagged f
  )
  select r.upload_id, r.demand_key, r.dk, r.car_key, r.id, r.logical_mode, r.journey_id, r.calc_ref, r.match_kind, r.criteria_hash, r.any_presented, r.mmr_cents, r.wish_index,
         case r.priority when 0 then 'LANE' when 1 then 'OFFLANE' else 'INCOMPLETE' end, r.first_selected
    from ranked r where r.rn = 1 and r.active;
$function$;
revoke all on function public.panel_manheim_grouped_light(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_manheim_grouped_light(public.panel_environment, uuid) to service_role;

CREATE OR REPLACE FUNCTION public.panel_manheim_batch_summary(p_environment public.panel_environment, p_upload_id uuid)
 RETURNS TABLE(demand_key text, logical_mode text, journey_id uuid, calc_ref text, match_count integer, bate_count integer, por_valor_count integer, presented_count integer, criteria_hashes text[])
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' SET work_mem TO '32MB'
AS $function$
  with per_hash as (
    select g.dk, g.logical_mode, g.journey_id, g.calc_ref, g.criteria_hash,
           count(*) as total, count(*) filter (where g.match_kind = 'BATE') as bate, count(*) filter (where g.match_kind = 'POR_VALOR') as por_valor, count(*) filter (where g.presented) as presented
      from public.panel_manheim_grouped_light(p_environment, p_upload_id) g
     group by 1, 2, 3, 4, 5
  )
  select h.dk, h.logical_mode, h.journey_id, h.calc_ref, sum(h.total)::integer, sum(h.bate)::integer, sum(h.por_valor)::integer, sum(h.presented)::integer,
         array_remove(array_agg(h.criteria_hash), null)
    from per_hash h
   group by 1, 2, 3, 4;
$function$;

create or replace function public.panel_manheim_offer_summary(p_environment public.panel_environment,p_upload_id uuid)
returns table(demand_key text,lane_count integer,offlane_count integer,incomplete_count integer,selected_count integer,selected_ids uuid[])
language sql stable security invoker set search_path='' as $$
 select g.demand_key, count(*) filter (where g.offer_group = 'LANE')::int, count(*) filter (where g.offer_group = 'OFFLANE')::int, count(*) filter (where g.offer_group = 'INCOMPLETE')::int,
        count(g.selected_id)::int, coalesce(array_agg(g.selected_id order by g.selected_id) filter (where g.selected_id is not null), '{}'::uuid[])
   from public.panel_manheim_grouped_light(p_environment, p_upload_id) g
  group by g.demand_key;
$$;

create or replace function public.panel_manheim_batch_cars(p_environment public.panel_environment,p_upload_ids uuid[])
returns table(upload_id uuid,car_count integer) language sql stable security invoker set search_path='' as $$
 select g.upload_id, count(distinct g.car_key)::int
   from unnest(p_upload_ids) u cross join lateral public.panel_manheim_grouped_light(p_environment, u) g group by g.upload_id;
$$;

CREATE OR REPLACE FUNCTION public.panel_manheim_batch_people(p_environment public.panel_environment, p_upload_id uuid)
 RETURNS TABLE(journey_id uuid, calc_ref text, logical_mode text, vehicle_count integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' SET work_mem TO '32MB'
AS $function$
  with cars as (
    select distinct g.journey_id, g.calc_ref, g.logical_mode, g.car_key from public.panel_manheim_grouped_light(p_environment, p_upload_id) g
  )
  select c.journey_id, c.calc_ref, c.logical_mode, count(*)::integer from cars c group by 1, 2, 3
  union all
  select d.journey_id, d.calc_ref, null::text, count(*)::integer
    from (select distinct c.journey_id, c.calc_ref, c.car_key from cars c) d
   group by 1, 2;
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_score_mmr(p_environment public.panel_environment, p_since timestamp with time zone)
 RETURNS TABLE(person text, mmr_cents bigint, sample integer)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' SET work_mem TO '32MB'
AS $function$
  with live as (
    select u.id from public.manheim_uploads u
     where u.environment = p_environment and u.undone_at is null and u.activated_at is not null and u.uploaded_at >= p_since
  ), cars as (
    select distinct
           case when g.journey_id is not null then 'j:' || g.journey_id::text else 'r:' || upper(g.calc_ref) end as person,
           g.car_key, g.mmr_cents
      from live u cross join lateral public.panel_manheim_grouped_light(p_environment, u.id) g
     where g.wish_index = 0 and g.match_kind in ('BATE','POR_VALOR') and g.mmr_cents > 0
  ), unique_cars as (
    select distinct on (person, car_key) person, mmr_cents from cars order by person, car_key, mmr_cents
  )
  select person, round(percentile_cont(0.5) within group (order by mmr_cents))::bigint, count(*)::integer
    from unique_cars group by person;
$function$;
