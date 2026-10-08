-- Project the same scalar inputs before the stored-car aggregate.
-- The JSON vehicle record is not carried through the DISTINCT sort.
create or replace function public.panel_manheim_batch_overview(p_environment public.panel_environment, p_upload_id uuid)
returns jsonb
language sql stable set search_path = '' set work_mem = '32MB' as $$
  with g as materialized (
    select * from public.panel_manheim_grouped_light(p_environment, p_upload_id)
  ),
  -- panel_manheim_batch_summary_v2
  per_hash as (
    select g.dk, g.logical_mode, g.journey_id, g.calc_ref, g.criteria_hash,
           count(*) as total, count(*) filter (where g.match_kind = 'BATE') as bate,
           count(*) filter (where g.match_kind = 'POR_VALOR') as por_valor, count(*) filter (where g.presented) as presented
      from g
     group by 1, 2, 3, 4, 5
  ), live as (
    select h.dk, h.logical_mode, h.journey_id, h.calc_ref, sum(h.total)::integer total, sum(h.bate)::integer bate,
           sum(h.por_valor)::integer por_valor, sum(h.presented)::integer presented, array_remove(array_agg(h.criteria_hash), null) hashes
      from per_hash h group by 1, 2, 3, 4
  ), stored_inputs as materialized (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) dk,
           m.logical_mode::text logical_mode,m.journey_id,trim(m.calc_ref::text) calc_ref,
           coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), m.row_fingerprint) car_key
      from public.manheim_matches m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
  ), stored as (
    select i.dk, min(i.logical_mode) logical_mode, (array_agg(i.journey_id))[1] journey_id, min(i.calc_ref) calc_ref,
           count(distinct i.car_key)::integer cars
      from stored_inputs i group by 1
  ), summary as (
    select coalesce(l.dk, s.dk) as demand_key, coalesce(l.logical_mode, s.logical_mode) as logical_mode, coalesce(l.journey_id, s.journey_id) as journey_id,
           coalesce(l.calc_ref, s.calc_ref) as calc_ref, coalesce(l.total, 0) as match_count, coalesce(l.bate, 0) as bate_count,
           coalesce(l.por_valor, 0) as por_valor_count, coalesce(l.presented, 0) as presented_count, coalesce(l.hashes, '{}'::text[]) as criteria_hashes,
           coalesce(s.cars, 0) as stored_count
      from live l full join stored s on s.dk = l.dk
  ),
  -- panel_manheim_offer_summary
  offer_live as (
    select g.demand_key, count(*) filter (where g.offer_group = 'LANE')::int lane, count(*) filter (where g.offer_group = 'OFFLANE')::int offlane,
           count(*) filter (where g.offer_group = 'INCOMPLETE')::int incomplete, count(g.selected_id)::int selected,
           coalesce(array_agg(g.selected_id order by g.selected_id) filter (where g.selected_id is not null), '{}'::uuid[]) ids
      from g group by g.demand_key
  ), ended as (
    select x.dk, array_agg(distinct x.name order by x.name) filter (where x.name <> '') names
      from public.manheim_option_selections ss
      join public.manheim_matches m on m.id = ss.match_id and m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
     cross join lateral (select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) dk,
                                coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), m.row_fingerprint) car_key,
                                concat_ws(' ', nullif(m.vehicle_json #>> '{parsed,year}', ''), nullif(m.vehicle_json #>> '{parsed,make}', ''), nullif(m.vehicle_json #>> '{parsed,model}', ''), nullif(m.vehicle_json #>> '{parsed,trim}', '')) name) x
     where ss.environment = p_environment and ss.upload_id = p_upload_id and ss.status = 'SELECTED'
       and not exists (select 1 from g where g.dk = x.dk and g.car_key = x.car_key)
     group by x.dk
  ), offer as (
    select coalesce(l.demand_key, e.dk) as demand_key, coalesce(l.lane, 0) as lane_count, coalesce(l.offlane, 0) as offlane_count,
           coalesce(l.incomplete, 0) as incomplete_count, coalesce(l.selected, 0) as selected_count, coalesce(l.ids, '{}'::uuid[]) as selected_ids,
           coalesce(e.names, '{}'::text[]) as ended_selected
      from offer_live l full join ended e on e.dk = l.demand_key
  ),
  -- panel_manheim_batch_cars (this batch)
  cars as (
    select g.upload_id, count(distinct g.car_key)::int as car_count from g group by g.upload_id
  )
  select jsonb_build_object(
    'summary', coalesce((select jsonb_agg(to_jsonb(s)) from summary s), '[]'::jsonb),
    'offer', coalesce((select jsonb_agg(to_jsonb(o)) from offer o), '[]'::jsonb),
    'cars', coalesce((select jsonb_agg(to_jsonb(c)) from cars c), '[]'::jsonb));
$$;

revoke all on function public.panel_manheim_batch_overview(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_manheim_batch_overview(public.panel_environment, uuid) to service_role;
