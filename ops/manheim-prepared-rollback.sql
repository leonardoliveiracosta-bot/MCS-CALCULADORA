-- Restore original read and remove preparation write overhead. Original records stay intact.
CREATE OR REPLACE FUNCTION public.panel_manheim_grouped_light(p_environment panel_environment, p_upload_id uuid)
 RETURNS TABLE(upload_id uuid, demand_key text, dk text, car_key text, id uuid, logical_mode text, journey_id uuid, calc_ref text, match_kind text, criteria_hash text, presented boolean, mmr_cents integer, wish_index smallint, offer_group text, selected_id uuid)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$
  with selected as (
    select ss.match_id, ss.updated_at, ss.id from public.manheim_option_selections ss where ss.environment = p_environment and ss.status = 'SELECTED'
  ), flagged as materialized (
    select m.upload_id, m.demand_key,
           coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as dk,
           coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), 'row:' || m.id) as vk,
           coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), m.row_fingerprint) as car_key,
           m.id, m.logical_mode::text as logical_mode, m.journey_id, trim(m.calc_ref::text) as calc_ref, m.match_kind, m.criteria_hash,
           (m.presented_unit_id is not null) as presented, m.mmr_cents, m.wish_index,
           (not (
              coalesce(case when pg_input_is_valid(nullif(trim(x.p ->> 'endsAt'), ''), 'timestamptz') then (x.p ->> 'endsAt')::timestamptz <= now() end, false)
              or (coalesce(trim(x.p ->> 'lane'), '') <> '' and coalesce(trim(x.p ->> 'run'), '') <> ''
                  and coalesce(case when x.d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(x.d, 'date') then x.d::date <= (now() at time zone 'America/New_York')::date
                                    when pg_input_is_valid(x.d, 'timestamptz') then x.d::timestamptz <= now() end, false))))
             and (case when m.mmr_cents > 0 then true when coalesce(x.p ->> 'mmrCents', '') ~ '^[0-9]{1,12}$' then (x.p ->> 'mmrCents')::bigint > 0 else false end) as active,
           case when coalesce(trim(x.p ->> 'lane'), '') <> '' and coalesce(trim(x.p ->> 'run'), '') <> '' then 0
                when regexp_replace(coalesce(x.p ->> 'buyNowPrice', ''), '[$,\s]', '', 'g') ~ '^\d+(\.\d+)?$' then case when regexp_replace(x.p ->> 'buyNowPrice', '[$,\s]', '', 'g')::numeric > 0 then 1 else 2 end
                else 2 end as priority,
           s.match_id as sel_id, s.updated_at as sel_at, s.id as sel_row
      from public.manheim_matches m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
      left join selected s on s.match_id = m.id
     cross join lateral (select coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as p) x0
     cross join lateral (select x0.p, nullif(trim(coalesce(nullif(trim(x0.p ->> 'startsAt'), ''), x0.p ->> 'saleDate')), '') as d) x
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
$function$


drop trigger if exists manheim_prepare_insert on public.manheim_matches;
drop trigger if exists manheim_prepare_update on public.manheim_matches;
drop trigger if exists manheim_prepare_sale_insert on public.manheim_complement_items;
drop trigger if exists manheim_prepare_sale_update on public.manheim_complement_items;
drop trigger if exists manheim_prepare_sale_delete on public.manheim_complement_items;
drop trigger if exists manheim_prepare_current_insert on public.manheim_sale_current;
drop trigger if exists manheim_prepare_current_update on public.manheim_sale_current;
drop trigger if exists manheim_prepare_current_delete on public.manheim_sale_current;
