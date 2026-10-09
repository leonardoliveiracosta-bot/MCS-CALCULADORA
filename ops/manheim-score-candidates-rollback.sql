CREATE OR REPLACE FUNCTION public.panel_manheim_score_mmr(p_environment panel_environment, p_since timestamp with time zone)
 RETURNS TABLE(person text, mmr_cents bigint, sample integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '32MB'
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
$function$
