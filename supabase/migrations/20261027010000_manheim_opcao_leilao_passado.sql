-- ENVIAR OPÇÕES: carro com leilão passado sai sozinho das opções.
--  * panel_manheim_offer_expired: true quando o endsAt passou, ou quando o carro tem Lane/Run e o dia do
--    leilão (startsAt, senão saleDate) é anterior a hoje na Flórida (America/New_York). Sem data, data
--    ilegível, hoje ou futuro: false. Buy Now só expira pelo endsAt: no CSV a data de um Buy Now é o dia
--    em que entrou na lista (no lote ativo, 1.405 Buy Now abertos têm essa data no passado).
--  * panel_manheim_sale_active passa a ser "não expirado"; a base única (grouped_options) e a base leve
--    (grouped_light) tiram o expirado, exceto quando o carro tem seleção SELECTED: o que a Leo já
--    escolheu continua aparecendo e editável. Page, page_sorted, page_trim, trims, summary, contadores do
--    lote e seleção leem dessas duas bases.
-- Nada é gravado: nenhum match, lote, seleção ou V1 enviada muda.

create or replace function public.panel_manheim_offer_expired(p_parsed jsonb, p_at timestamptz default now())
returns boolean language sql stable set search_path to '' as $$
  select coalesce(case when pg_input_is_valid(nullif(trim(p_parsed ->> 'endsAt'), ''), 'timestamptz') then (p_parsed ->> 'endsAt')::timestamptz <= p_at end, false)
      or (coalesce(trim(p_parsed ->> 'lane'), '') <> '' and coalesce(trim(p_parsed ->> 'run'), '') <> ''
          and coalesce((select case when x.d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(x.d, 'date') then x.d::date
                                    when pg_input_is_valid(x.d, 'timestamptz') then (x.d::timestamptz at time zone 'America/New_York')::date end
                          from (select nullif(trim(coalesce(nullif(trim(p_parsed ->> 'startsAt'), ''), p_parsed ->> 'saleDate')), '') as d) x)
                       < (p_at at time zone 'America/New_York')::date, false));
$$;
revoke all on function public.panel_manheim_offer_expired(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.panel_manheim_offer_expired(jsonb, timestamptz) to service_role;

create or replace function public.panel_manheim_sale_active(p jsonb, at_time timestamptz default now())
returns boolean language sql stable security invoker set search_path = '' as $$
  select not public.panel_manheim_offer_expired(p, at_time);
$$;

-- Base única (v3.4), com a exceção da seleção: um carro SELECTED nunca some por ter expirado.
create or replace function public.panel_manheim_grouped_options(p_environment public.panel_environment,p_upload_id uuid,p_demand_key text default null)
returns setof public.manheim_matches language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 with source as (
  select m,coalesce(m.demand_key,case when m.journey_id is not null then 'journey:'||m.journey_id else 'ref:'||trim(m.calc_ref::text) end||':'||coalesce(m.logical_mode::text,'')) dk,
    coalesce(nullif(upper(trim(m.vehicle_json#>>'{parsed,vin}')),''),'row:'||m.id) vk,
    coalesce(m.vehicle_json->'parsed','{}'::jsonb)||coalesce(si.sale,'{}'::jsonb) p,
    exists(select 1 from public.manheim_option_selections ss where ss.environment=p_environment and ss.match_id=m.id and ss.status='SELECTED') chosen
  from public.manheim_matches m
  left join public.manheim_complement_items si on si.run_id=(select c.run_id from public.manheim_sale_current c where c.environment=p_environment and c.upload_id=p_upload_id) and si.row_fingerprint=m.row_fingerprint
  where m.environment=p_environment and m.upload_id=p_upload_id and m.undone_at is null
    and (p_demand_key is null or coalesce(m.demand_key,case when m.journey_id is not null then 'journey:'||m.journey_id else 'ref:'||trim(m.calc_ref::text) end||':'||coalesce(m.logical_mode::text,''))=p_demand_key)
 ), eligible as materialized (
  select s.*,(public.panel_manheim_sale_active(p) or chosen) and public.panel_manheim_offer_mmr((m).mmr_cents,p) is not null active,
   case when public.panel_manheim_offer_group(p)='LANE' then 0 when public.panel_manheim_offer_group(p)='OFFLANE' then 1 else 2 end priority
  from source s
 ), grouped as (
  select e.*,
   row_number() over(partition by dk,vk order by active desc,priority,(m).id) rn,
   jsonb_agg((m).id) over(partition by dk,vk) ids,
   (array_agg((m).presented_unit_id) filter(where (m).presented_unit_id is not null) over(partition by dk,vk))[1] presented,
   jsonb_agg(jsonb_build_object('lane',p->>'lane','run',p->>'run','buyNowPrice',p->>'buyNowPrice','saleType',p->>'saleType','saleStatus',p->>'saleStatus','eventSaleName',p->>'eventSaleName','startsAt',coalesce(p->>'startsAt',p->>'saleDate'),'endsAt',p->>'endsAt','location',p->>'location')) filter(where active) over(partition by dk,vk order by active desc,priority,(m).id rows between unbounded preceding and unbounded following) purchases
  from eligible e
 )
 select result.*
 from grouped g
 cross join lateral jsonb_populate_record(null::public.manheim_matches,to_jsonb(g.m)||jsonb_build_object('presented_unit_id',coalesce((g.m).presented_unit_id,g.presented),'vehicle_json',jsonb_set((g.m).vehicle_json,'{parsed}',g.p||jsonb_build_object('purchaseOptions',g.purchases,'memberMatchIds',g.ids)))) result
 where g.rn=1 and g.active;
$$;

-- Base leve dos resumos (20261024020000), com a mesma regra escrita na consulta (sem função por carro).
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
           -- panel_manheim_offer_expired (ou selecionado) e panel_manheim_offer_mmr, inline.
           (s.match_id is not null or not (
              coalesce(case when pg_input_is_valid(nullif(trim(x.p ->> 'endsAt'), ''), 'timestamptz') then (x.p ->> 'endsAt')::timestamptz <= now() end, false)
              or (coalesce(trim(x.p ->> 'lane'), '') <> '' and coalesce(trim(x.p ->> 'run'), '') <> ''
                  and coalesce(case when x.d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(x.d, 'date') then x.d::date
                                    when pg_input_is_valid(x.d, 'timestamptz') then (x.d::timestamptz at time zone 'America/New_York')::date end
                               < (now() at time zone 'America/New_York')::date, false))))
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
