-- Enviar opções: the group of each car (Lane/Run, Buy Now / Make Offer, Informação incompleta) and its MMR were
-- computed by SQL functions with "set search_path", which stops PostgreSQL from inlining them: they ran once per
-- match (≈20 mil por lote) and made panel_manheim_offer_summary take ≈1,4 s. Same rules, word for word, without
-- that setting so they are inlined (≈70 ms). They only use built-in functions and operators (pg_catalog is always
-- searched first), so the search path cannot change what they do.
create or replace function public.panel_manheim_offer_group(p_parsed jsonb)
returns text language sql immutable as $$
  select case
    -- Lane e Run verificáveis: passa em Lane/Run, mesmo com Buy Now Price maior que zero.
    when coalesce(trim(p_parsed ->> 'lane'), '') <> '' and coalesce(trim(p_parsed ->> 'run'), '') <> '' then 'LANE'
    -- Sem Lane/Run: Buy Now / Make Offer só com os dados de venda lidos e indicação no CSV.
    when ((p_parsed ->> 'lane') is not null or (p_parsed ->> 'run') is not null)
      and ((regexp_replace(coalesce(p_parsed ->> 'buyNowPrice', ''), '[$,\s]', '', 'g') ~ '^\d+(\.\d+)?$'
            and regexp_replace(coalesce(p_parsed ->> 'buyNowPrice', ''), '[$,\s]', '', 'g')::numeric > 0)
        or concat_ws(' ', p_parsed ->> 'saleType', p_parsed ->> 'eventSaleName', p_parsed ->> 'saleStatus') ~* 'buy\s*-?\s*now|make\s*-?\s*(an\s+)?offer')
      then 'OFFLANE'
    else 'INCOMPLETE' end;
$$;

-- MMR válido do match (a coluna nova ou o que o carro guardava).
create or replace function public.panel_manheim_offer_mmr(p_mmr_cents integer, p_parsed jsonb)
returns bigint language sql immutable as $$
  select coalesce(case when p_mmr_cents > 0 then p_mmr_cents end,
    case when coalesce(p_parsed ->> 'mmrCents', '') ~ '^[0-9]{1,12}$' and (p_parsed ->> 'mmrCents')::bigint > 0 then (p_parsed ->> 'mmrCents')::bigint end);
$$;

-- The summary computes the group rule inline (same rule as panel_manheim_offer_group); same output, ≈20x faster.
create or replace function public.panel_manheim_offer_summary(p_environment public.panel_environment, p_upload_id uuid)
returns table(demand_key text, lane_count integer, offlane_count integer, incomplete_count integer, selected_count integer, selected_ids uuid[])
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with options as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as demand_key,
           -- Same rule as public.panel_manheim_offer_group, written here so it runs inline (the call per row cost ≈1 s).
           coalesce(si.offer_group, case
             when coalesce(trim(merged.parsed ->> 'lane'), '') <> '' and coalesce(trim(merged.parsed ->> 'run'), '') <> '' then 'LANE'
             when ((merged.parsed ->> 'lane') is not null or (merged.parsed ->> 'run') is not null)
               and ((regexp_replace(coalesce(merged.parsed ->> 'buyNowPrice', ''), '[$,\s]', '', 'g') ~ '^\d+(\.\d+)?$'
                     and regexp_replace(coalesce(merged.parsed ->> 'buyNowPrice', ''), '[$,\s]', '', 'g')::numeric > 0)
                 or concat_ws(' ', merged.parsed ->> 'saleType', merged.parsed ->> 'eventSaleName', merged.parsed ->> 'saleStatus') ~* 'buy\s*-?\s*now|make\s*-?\s*(an\s+)?offer')
               then 'OFFLANE'
             else 'INCOMPLETE' end) as grp
      from public.manheim_matches m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
      cross join lateral (select coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as parsed offset 0) merged
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.mmr_cents > 0 or public.panel_manheim_offer_mmr(null, m.vehicle_json -> 'parsed') is not null)
  ), counts as (
    select o.demand_key, count(*) filter (where o.grp = 'LANE')::integer lane_count,
           count(*) filter (where o.grp = 'OFFLANE')::integer offlane_count, count(*) filter (where o.grp = 'INCOMPLETE')::integer incomplete_count
      from options o group by o.demand_key
  ), picked as (
    select s.demand_key, count(*)::integer selected_count, array_agg(s.match_id order by s.updated_at) selected_ids
      from public.manheim_option_selections s
     where s.environment = p_environment and s.upload_id = p_upload_id and s.status = 'SELECTED'
     group by s.demand_key
  )
  select c.demand_key, c.lane_count, c.offlane_count, c.incomplete_count, coalesce(p.selected_count, 0), coalesce(p.selected_ids, '{}')
    from counts c left join picked p using (demand_key);
$$;
