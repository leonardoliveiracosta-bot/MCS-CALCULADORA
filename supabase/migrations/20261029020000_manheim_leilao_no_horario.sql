-- Lane/Run sai das opções no horário de início do leilão (não mais no dia seguinte): expira quando
-- agora >= startsAt (senão saleDate). Só data, sem hora: o dia começa à 0h da Flórida. Buy Now / OVE /
-- Timed Sale continuam só pelo endsAt. Sem data legível: não expira. A base única (grouped_options,
-- via panel_manheim_sale_active) e a base leve (grouped_light, regra escrita na consulta) seguem a
-- mesma regra; o carro com Lane/Run e Buy Now só sai quando as duas vendas expiraram.
-- Nada é gravado: nenhum match, lote, seleção ou V1 muda.

create or replace function public.panel_manheim_offer_expired(p_parsed jsonb, p_at timestamptz default now())
returns boolean language sql stable set search_path to '' as $$
  select coalesce(case when pg_input_is_valid(nullif(trim(p_parsed ->> 'endsAt'), ''), 'timestamptz') then (p_parsed ->> 'endsAt')::timestamptz <= p_at end, false)
      or (coalesce(trim(p_parsed ->> 'lane'), '') <> '' and coalesce(trim(p_parsed ->> 'run'), '') <> ''
          and coalesce((select case when x.d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(x.d, 'date') then x.d::date <= (p_at at time zone 'America/New_York')::date
                                    when pg_input_is_valid(x.d, 'timestamptz') then x.d::timestamptz <= p_at end
                          from (select nullif(trim(coalesce(nullif(trim(p_parsed ->> 'startsAt'), ''), p_parsed ->> 'saleDate')), '') as d) x), false));
$$;
revoke all on function public.panel_manheim_offer_expired(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.panel_manheim_offer_expired(jsonb, timestamptz) to service_role;

-- Base leve dos resumos, com a regra do horário escrita na consulta (sem função por carro).
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
           -- panel_manheim_offer_expired e panel_manheim_offer_mmr, inline.
           (not (
              coalesce(case when pg_input_is_valid(nullif(trim(x.p ->> 'endsAt'), ''), 'timestamptz') then (x.p ->> 'endsAt')::timestamptz <= now() end, false)
              or (coalesce(trim(x.p ->> 'lane'), '') <> '' and coalesce(trim(x.p ->> 'run'), '') <> ''
                  and coalesce(case when x.d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(x.d, 'date') then x.d::date <= (now() at time zone 'America/New_York')::date
                                    when pg_input_is_valid(x.d, 'timestamptz') then x.d::timestamptz <= now() end, false))))
             and (case when m.mmr_cents > 0 then true when coalesce(x.p ->> 'mmrCents', '') ~ '^[0-9]{1,12}$' then (x.p ->> 'mmrCents')::bigint > 0 else false end) as active,
           -- panel_manheim_offer_group, inline: 0 Lane/Run, 1 Buy Now, 2 incompleto.
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
$function$;
revoke all on function public.panel_manheim_grouped_light(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_manheim_grouped_light(public.panel_environment, uuid) to service_role;

