-- Same page and trim rules, one live grouping per request. Additive, read-only, server-only.
create or replace function public.panel_manheim_offer_page_bundle(
 p_environment public.panel_environment,p_upload_id uuid,p_demand_key text,p_group text,p_sort text,p_trims text[],p_offset integer,p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path='' set work_mem='32MB' as $function$
declare answer jsonb;
begin
  with source as materialized (
    select m.*, coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as parsed, si.offer_group as stored_group
      from public.panel_manheim_grouped_options(p_environment,p_upload_id,p_demand_key) m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.demand_key = p_demand_key or (m.demand_key is null and (case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) = p_demand_key))
  ), options as materialized (
    select o.*, coalesce(o.stored_group, public.panel_manheim_offer_group(o.parsed)) as grp, public.panel_manheim_offer_cr(o.parsed) as cr_value,
           public.panel_manheim_offer_mmr(o.mmr_cents, o.parsed) as mmr_value,
           nullif(o.parsed ->> 'startsAt', '') as starts_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'lane', '')), ''), 20, '0') as lane_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'run', '')), ''), 20, '0') as run_key
      from source o
  ), facet_options as (select public.panel_manheim_trim_key(o.parsed ->> 'trim') tk, nullif(btrim(coalesce(o.parsed ->> 'trim','')),'') raw_trim,
  exists(select 1 from public.manheim_option_selections ss where ss.environment=p_environment and ss.status='SELECTED' and (o.parsed->'memberMatchIds') ? ss.match_id::text) is_selected
 from options o where o.mmr_value is not null and o.grp=p_group), labels as (
 select tk,raw_trim,row_number() over(partition by tk order by count(*) desc,raw_trim) rn
 from facet_options where raw_trim is not null group by tk,raw_trim
 ), facets as (
 select o.tk trim_key,coalesce((select l.raw_trim from labels l where l.tk=o.tk and l.rn=1),'') label,
 count(*)::integer car_count,count(*) filter(where o.is_selected)::integer selected_count
 from facet_options o group by o.tk order by (o.tk=''),count(*) desc,o.tk
 ), ranked as (
    select o.*, public.panel_manheim_offer_cr_min(o.mmr_value) as cr_min,
           row_number() over (partition by (o.cr_value >= public.panel_manheim_offer_cr_min(o.mmr_value))
             order by o.cr_value desc nulls last, o.starts_key nulls last, o.lane_key nulls last, o.run_key nulls last, o.row_fingerprint, o.id) as position
      from options o
     where o.mmr_value is not null and o.grp = p_group
       and (coalesce(cardinality(p_trims), 0) = 0 or public.panel_manheim_trim_key(o.parsed ->> 'trim') = any(p_trims))
  ), tiered as (
    select r.*, case when r.cr_value is null then 4
                     when r.cr_value >= r.cr_min and r.position <= 5 then 0
                     when r.cr_value < r.cr_min and r.position <= 5 then 1
                     when r.cr_value >= r.cr_min then 2 else 3 end as tier_value,
           count(*) over ()::integer as total,
           case when (r.parsed ->> 'year') ~ '^[0-9]{4}$' and (r.parsed ->> 'year')::integer > 0 then (r.parsed ->> 'year')::integer end as year_value,
           case when (r.parsed ->> 'miles') ~ '^[0-9]{1,9}$' then (r.parsed ->> 'miles')::integer end as miles_value
      from ranked r
  ), page(id,journey_id,calc_ref,logical_mode,match_kind,match_reason,mmr_status,row_fingerprint,presented_unit_id,vehicle_json,offer_group,cr,cr_minimum,below_minimum,tier,mmr_cents,default_pct,selection_status,manual,manual_reason,manual_pct,final_cents,note,total_in_group) as (
  select t.id, t.journey_id, trim(t.calc_ref::text), t.logical_mode::text, t.match_kind, t.match_reason, t.mmr_status, t.row_fingerprint,
         t.presented_unit_id, jsonb_set(t.vehicle_json, '{parsed}', t.parsed), t.grp, t.cr_value, t.cr_min, case when t.cr_value is null then null else t.cr_value < t.cr_min end,
         t.tier_value, t.mmr_value, public.panel_manheim_offer_default_pct(t.mmr_value),
         coalesce(s.status, 'AVAILABLE'), coalesce(s.manual, false), s.manual_reason, s.manual_pct,
         coalesce(s.final_cents, round(t.mmr_value * (100 + public.panel_manheim_offer_default_pct(t.mmr_value)) / 100)::integer), s.note, t.total
    from tiered t
    left join lateral (select ss.* from public.manheim_option_selections ss where ss.environment=p_environment and (t.parsed->'memberMatchIds') ? ss.match_id::text order by (ss.status='SELECTED') desc,ss.updated_at desc,ss.id limit 1) s on true
   order by (case when p_sort in ('year_desc', 'year_asc') then t.year_value::numeric
                  when p_sort in ('miles_desc', 'miles_asc') then t.miles_value::numeric
                  else nullif(t.mmr_value, 0)::numeric end) is null,
            case when p_sort = 'year_desc' then t.year_value end desc,
            case when p_sort = 'year_asc' then t.year_value end asc,
            case when p_sort = 'miles_desc' then t.miles_value end desc,
            case when p_sort = 'miles_asc' then t.miles_value end asc,
            case when p_sort = 'mmr_desc' then t.mmr_value end desc,
            case when p_sort = 'mmr_asc' then t.mmr_value end asc,
            t.tier_value, t.cr_value desc nulls last, t.starts_key nulls last, t.lane_key nulls last, t.run_key nulls last, t.row_fingerprint, t.id
  offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 10), 1), 50)
  )
  select jsonb_build_object(
   'options',coalesce((select jsonb_agg(to_jsonb(p)) from page p),'[]'::jsonb),
   'trims',coalesce((select jsonb_agg(to_jsonb(f)) from facets f),'[]'::jsonb)
  ) into answer;
 return answer;
end;
$function$;
revoke all on function public.panel_manheim_offer_page_bundle(public.panel_environment,uuid,text,text,text,text[],integer,integer) from public,anon,authenticated;
grant execute on function public.panel_manheim_offer_page_bundle(public.panel_environment,uuid,text,text,text,text[],integer,integer) to service_role;

-- Resolve an older selected sale of the same VIN to the current grouped car; never rewrite the selection.
CREATE OR REPLACE FUNCTION public.panel_manheim_offer_ids_v2(p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_match_ids uuid[])
RETURNS TABLE(id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO ''
SET work_mem TO '32MB'
AS $function$
begin
 return query
  with source as (
    select m.*, coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as parsed, si.offer_group as stored_group
      from public.panel_manheim_grouped_options(p_environment,p_upload_id,p_demand_key) m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.demand_key = p_demand_key or (m.demand_key is null and (case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) = p_demand_key))
  ), options as (
    select o.*, coalesce(o.stored_group, public.panel_manheim_offer_group(o.parsed)) as grp, public.panel_manheim_offer_cr(o.parsed) as cr_value,
           public.panel_manheim_offer_mmr(o.mmr_cents, o.parsed) as mmr_value,
           -- Empate: leilão mais cedo, depois Lane e Run mais próximos (ordem natural), depois o identificador estável.
           nullif(o.parsed ->> 'startsAt', '') as starts_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'lane', '')), ''), 20, '0') as lane_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'run', '')), ''), 20, '0') as run_key
      from source o
  ), ranked as (
    select o.*, public.panel_manheim_offer_cr_min(o.mmr_value) as cr_min,
           row_number() over (partition by o.grp, (o.cr_value >= public.panel_manheim_offer_cr_min(o.mmr_value))
             order by o.cr_value desc nulls last, o.starts_key nulls last, o.lane_key nulls last, o.run_key nulls last, o.row_fingerprint, o.id) as position
      from options o
     where o.mmr_value is not null and o.grp in ('LANE','OFFLANE','INCOMPLETE')
  ), tiered as (
    select r.*, case when r.cr_value is null then 4
                     when r.cr_value >= r.cr_min and r.position <= 5 then 0
                     when r.cr_value < r.cr_min and r.position <= 5 then 1
                     when r.cr_value >= r.cr_min then 2 else 3 end as tier_value,
           count(*) over ()::integer as total
      from ranked r
  )
 select coalesce((select x from unnest(p_match_ids) x where x=t.id or (t.parsed->'memberMatchIds') ? x::text order by (x=t.id) desc,x limit 1),t.id) as id from tiered t
 where t.id = any(p_match_ids) or (t.parsed -> 'memberMatchIds') ?| (select array_agg(x::text) from unnest(p_match_ids) x)
 order by case t.grp when 'LANE' then 0 when 'OFFLANE' then 1 else 2 end,
 t.tier_value, t.cr_value desc nulls last, t.starts_key nulls last, t.lane_key nulls last, t.run_key nulls last, t.row_fingerprint, t.id;
end;
$function$;
REVOKE ALL ON FUNCTION public.panel_manheim_offer_ids_v2(public.panel_environment,uuid,text,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panel_manheim_offer_ids_v2(public.panel_environment,uuid,text,uuid[]) TO service_role;


