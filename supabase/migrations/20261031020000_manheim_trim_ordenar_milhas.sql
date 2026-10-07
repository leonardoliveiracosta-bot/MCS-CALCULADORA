-- Com filtro de trim, a mesma ordem por milhas (menor e maior primeiro) da página sem filtro (20261031010000),
-- para a tela "Opções do cliente". Mesma função de 20261025010000, só com p_sort miles_asc e miles_desc a mais.
-- Carro sem milhas legíveis vai para o fim; empate segue a ordem por CR. Nada é gravado.
create or replace function public.panel_manheim_offer_page_trim(
  p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_group text, p_sort text, p_trims text[], p_offset integer, p_limit integer
)
returns table(id uuid, journey_id uuid, calc_ref text, logical_mode text, match_kind text, match_reason text, mmr_status text,
  row_fingerprint text, presented_unit_id uuid, vehicle_json jsonb, offer_group text, cr numeric, cr_minimum numeric, below_minimum boolean,
  tier integer, mmr_cents bigint, default_pct numeric, selection_status text, manual boolean, manual_reason text, manual_pct numeric,
  final_cents integer, note text, total_in_group integer)
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with source as (
    select m.*, coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as parsed, si.offer_group as stored_group
      from public.panel_manheim_grouped_options(p_environment,p_upload_id,p_demand_key) m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.demand_key = p_demand_key or (m.demand_key is null and (case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) = p_demand_key))
  ), options as (
    select o.*, coalesce(o.stored_group, public.panel_manheim_offer_group(o.parsed)) as grp, public.panel_manheim_offer_cr(o.parsed) as cr_value,
           public.panel_manheim_offer_mmr(o.mmr_cents, o.parsed) as mmr_value,
           nullif(o.parsed ->> 'startsAt', '') as starts_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'lane', '')), ''), 20, '0') as lane_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'run', '')), ''), 20, '0') as run_key
      from source o
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
  )
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
  offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

revoke all on function public.panel_manheim_offer_page_trim(public.panel_environment, uuid, text, text, text, text[], integer, integer) from public, anon, authenticated;
grant execute on function public.panel_manheim_offer_page_trim(public.panel_environment, uuid, text, text, text, text[], integer, integer) to service_role;
