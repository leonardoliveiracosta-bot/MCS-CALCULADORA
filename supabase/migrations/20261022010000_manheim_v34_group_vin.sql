-- v3.4: one physical VIN per demand. Source inventory/matches and sent snapshots are never deleted.

-- Generated with migration new; ordered after the repository's already-applied 20261021 migrations.
create or replace function public.panel_manheim_sale_active(p jsonb, at_time timestamptz default now())
returns boolean language plpgsql stable security invoker set search_path='' as $$
begin
 if nullif(trim(p->>'endsAt'),'') is null then return true; end if;
 begin return (p->>'endsAt')::timestamptz > at_time;
 exception when invalid_datetime_format or datetime_field_overflow then return true; end;
end $$;

-- The single grouping source used by pagination, counts, audit, selection and sending.
create or replace function public.panel_manheim_grouped_options(p_environment public.panel_environment,p_upload_id uuid,p_demand_key text default null)
returns setof public.manheim_matches language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 with source as (
  select m,coalesce(m.demand_key,case when m.journey_id is not null then 'journey:'||m.journey_id else 'ref:'||trim(m.calc_ref::text) end||':'||coalesce(m.logical_mode::text,'')) dk,
    coalesce(nullif(upper(trim(m.vehicle_json#>>'{parsed,vin}')),''),'row:'||m.id) vk,
    coalesce(m.vehicle_json->'parsed','{}'::jsonb)||coalesce(si.sale,'{}'::jsonb) p
  from public.manheim_matches m
  left join public.manheim_complement_items si on si.run_id=(select c.run_id from public.manheim_sale_current c where c.environment=p_environment and c.upload_id=p_upload_id) and si.row_fingerprint=m.row_fingerprint
  where m.environment=p_environment and m.upload_id=p_upload_id and m.undone_at is null
    and (p_demand_key is null or coalesce(m.demand_key,case when m.journey_id is not null then 'journey:'||m.journey_id else 'ref:'||trim(m.calc_ref::text) end||':'||coalesce(m.logical_mode::text,''))=p_demand_key)
 ), eligible as materialized (
  select s.*,public.panel_manheim_sale_active(p) and public.panel_manheim_offer_mmr((m).mmr_cents,p) is not null active,
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

-- Resolves any previously-selected auction entry to its current representative (no selection mutation).
create or replace function public.panel_manheim_grouped_matches(p_environment public.panel_environment,p_match_ids uuid[])
returns jsonb language sql stable security invoker set search_path='' as $$
 with requested as (select distinct upload_id,demand_key from public.manheim_matches where environment=p_environment and id=any(p_match_ids))
 select coalesce(jsonb_agg(to_jsonb(g)),'[]'::jsonb) from requested r cross join lateral public.panel_manheim_grouped_options(p_environment,r.upload_id,r.demand_key) g
 where exists(select 1 from jsonb_array_elements_text(g.vehicle_json#>'{parsed,memberMatchIds}') i where i::uuid=any(p_match_ids));
$$;

revoke all on function public.panel_manheim_sale_active(jsonb,timestamptz),public.panel_manheim_grouped_options(public.panel_environment,uuid,text),public.panel_manheim_grouped_matches(public.panel_environment,uuid[]) from public,anon,authenticated;
grant execute on function public.panel_manheim_sale_active(jsonb,timestamptz),public.panel_manheim_grouped_options(public.panel_environment,uuid,text),public.panel_manheim_grouped_matches(public.panel_environment,uuid[]) to service_role;

CREATE OR REPLACE FUNCTION public.panel_manheim_batch_summary(p_environment public.panel_environment, p_upload_id uuid)
 RETURNS TABLE(demand_key text, logical_mode text, journey_id uuid, calc_ref text, match_count integer, bate_count integer, por_valor_count integer, presented_count integer, criteria_hashes text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$
  -- Two small aggregations (by demand and criterion, then by demand): no big sort of the batch.
  with per_hash as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as demand_key, m.logical_mode::text as logical_mode, m.journey_id, trim(m.calc_ref::text) as calc_ref, m.criteria_hash,
           count(*) as total, count(*) filter (where m.match_kind = 'BATE') as bate, count(*) filter (where m.match_kind = 'POR_VALOR') as por_valor, count(m.presented_unit_id) as presented
      from public.panel_manheim_grouped_options(p_environment,p_upload_id,null) m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
     group by 1, 2, 3, 4, 5
  )
  select h.demand_key, h.logical_mode, h.journey_id, h.calc_ref, sum(h.total)::integer, sum(h.bate)::integer, sum(h.por_valor)::integer, sum(h.presented)::integer,
         array_remove(array_agg(h.criteria_hash), null)
    from per_hash h
   group by 1, 2, 3, 4;
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_demand_options(p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_after_rank integer DEFAULT NULL::integer, p_after_miles integer DEFAULT NULL::integer, p_after_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 10)
 RETURNS SETOF public.manheim_matches
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select m.*
    from public.panel_manheim_grouped_options(p_environment,p_upload_id,p_demand_key) m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
     and (m.demand_key = p_demand_key or (m.demand_key is null and coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) = p_demand_key))
     and coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
     and (p_after_id is null or (coalesce(m.sort_rank::integer, case m.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end), coalesce(m.sort_miles, case when m.vehicle_json #>> '{parsed,miles}' ~ '^[0-9]{1,9}$' then (m.vehicle_json #>> '{parsed,miles}')::integer else 2147483647 end), m.id) > (p_after_rank, p_after_miles, p_after_id))
   order by coalesce(m.sort_rank::integer, case m.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end), coalesce(m.sort_miles, case when m.vehicle_json #>> '{parsed,miles}' ~ '^[0-9]{1,9}$' then (m.vehicle_json #>> '{parsed,miles}')::integer else 2147483647 end), m.id
   limit least(greatest(coalesce(p_limit, 10), 1), 200);
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_batch_top_options(p_environment public.panel_environment, p_upload_id uuid, p_per_demand integer)
 RETURNS SETOF public.manheim_matches
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select (x.m).*
    from (
      select m, row_number() over (partition by coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, ''))
                                   order by coalesce(m.sort_rank::integer, case m.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end), coalesce(m.sort_miles, case when m.vehicle_json #>> '{parsed,miles}' ~ '^[0-9]{1,9}$' then (m.vehicle_json #>> '{parsed,miles}')::integer else 2147483647 end), m.id) as position
        from public.panel_manheim_grouped_options(p_environment,p_upload_id,null) m
       where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
         and coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
    ) x
   where x.position <= least(greatest(coalesce(p_per_demand, 10), 1), 2000);
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_batch_demand_options(p_environment public.panel_environment, p_upload_id uuid, p_journey_ids uuid[], p_refs text[], p_per_demand integer)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select coalesce(jsonb_agg(to_jsonb(x.m) order by x.key, x.position), '[]'::jsonb)
    from (
      select m, coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as key,
             row_number() over (partition by coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, ''))
                                order by coalesce(m.sort_rank::integer, case m.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end), coalesce(m.sort_miles, case when m.vehicle_json #>> '{parsed,miles}' ~ '^[0-9]{1,9}$' then (m.vehicle_json #>> '{parsed,miles}')::integer else 2147483647 end), m.id) as position
        from public.panel_manheim_grouped_options(p_environment,p_upload_id,null) m
       where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
         and (m.journey_id = any(coalesce(p_journey_ids, '{}'::uuid[])) or trim(m.calc_ref::text) = any(coalesce(p_refs, '{}'::text[])))
         and coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
    ) x
   where x.position <= least(greatest(coalesce(p_per_demand, 10), 1), 2000);
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_offer_page(p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_group text, p_offset integer, p_limit integer)
 RETURNS TABLE(id uuid, journey_id uuid, calc_ref text, logical_mode text, match_kind text, match_reason text, mmr_status text, row_fingerprint text, presented_unit_id uuid, vehicle_json jsonb, offer_group text, cr numeric, cr_minimum numeric, below_minimum boolean, tier integer, mmr_cents bigint, default_pct numeric, selection_status text, manual boolean, manual_reason text, manual_pct numeric, final_cents integer, note text, total_in_group integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$
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
           row_number() over (partition by (o.cr_value >= public.panel_manheim_offer_cr_min(o.mmr_value))
             order by o.cr_value desc nulls last, o.starts_key nulls last, o.lane_key nulls last, o.run_key nulls last, o.row_fingerprint, o.id) as position
      from options o
     where o.mmr_value is not null and o.grp = p_group
  ), tiered as (
    select r.*, case when r.cr_value is null then 4
                     when r.cr_value >= r.cr_min and r.position <= 5 then 0
                     when r.cr_value < r.cr_min and r.position <= 5 then 1
                     when r.cr_value >= r.cr_min then 2 else 3 end as tier_value,
           count(*) over ()::integer as total
      from ranked r
  )
  select t.id, t.journey_id, trim(t.calc_ref::text), t.logical_mode::text, t.match_kind, t.match_reason, t.mmr_status, t.row_fingerprint,
         t.presented_unit_id, jsonb_set(t.vehicle_json, '{parsed}', t.parsed), t.grp, t.cr_value, t.cr_min, case when t.cr_value is null then null else t.cr_value < t.cr_min end,
         t.tier_value, t.mmr_value, public.panel_manheim_offer_default_pct(t.mmr_value),
         coalesce(s.status, 'AVAILABLE'), coalesce(s.manual, false), s.manual_reason, s.manual_pct,
         coalesce(s.final_cents, round(t.mmr_value * (100 + public.panel_manheim_offer_default_pct(t.mmr_value)) / 100)::integer), s.note, t.total
    from tiered t
    left join lateral (select ss.* from public.manheim_option_selections ss where ss.environment=p_environment and (t.parsed->'memberMatchIds') ? ss.match_id::text order by (ss.status='SELECTED') desc,ss.updated_at desc,ss.id limit 1) s on true
   order by t.tier_value, t.cr_value desc nulls last, t.starts_key nulls last, t.lane_key nulls last, t.run_key nulls last, t.row_fingerprint, t.id
  offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 10), 1), 50);
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_offer_page_sorted(p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_group text, p_sort text, p_offset integer, p_limit integer)
 RETURNS TABLE(id uuid, journey_id uuid, calc_ref text, logical_mode text, match_kind text, match_reason text, mmr_status text, row_fingerprint text, presented_unit_id uuid, vehicle_json jsonb, offer_group text, cr numeric, cr_minimum numeric, below_minimum boolean, tier integer, mmr_cents bigint, default_pct numeric, selection_status text, manual boolean, manual_reason text, manual_pct numeric, final_cents integer, note text, total_in_group integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$
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
  ), tiered as (
    select r.*, case when r.cr_value is null then 4
                     when r.cr_value >= r.cr_min and r.position <= 5 then 0
                     when r.cr_value < r.cr_min and r.position <= 5 then 1
                     when r.cr_value >= r.cr_min then 2 else 3 end as tier_value,
           count(*) over ()::integer as total,
           case when (r.parsed ->> 'year') ~ '^[0-9]{4}$' and (r.parsed ->> 'year')::integer > 0 then (r.parsed ->> 'year')::integer end as year_value
      from ranked r
  )
  select t.id, t.journey_id, trim(t.calc_ref::text), t.logical_mode::text, t.match_kind, t.match_reason, t.mmr_status, t.row_fingerprint,
         t.presented_unit_id, jsonb_set(t.vehicle_json, '{parsed}', t.parsed), t.grp, t.cr_value, t.cr_min, case when t.cr_value is null then null else t.cr_value < t.cr_min end,
         t.tier_value, t.mmr_value, public.panel_manheim_offer_default_pct(t.mmr_value),
         coalesce(s.status, 'AVAILABLE'), coalesce(s.manual, false), s.manual_reason, s.manual_pct,
         coalesce(s.final_cents, round(t.mmr_value * (100 + public.panel_manheim_offer_default_pct(t.mmr_value)) / 100)::integer), s.note, t.total
    from tiered t
    left join lateral (select ss.* from public.manheim_option_selections ss where ss.environment=p_environment and (t.parsed->'memberMatchIds') ? ss.match_id::text order by (ss.status='SELECTED') desc,ss.updated_at desc,ss.id limit 1) s on true
   order by (case when p_sort in ('year_desc', 'year_asc') then t.year_value::numeric else nullif(t.mmr_value, 0)::numeric end) is null,
            case when p_sort = 'year_desc' then t.year_value end desc,
            case when p_sort = 'year_asc' then t.year_value end asc,
            case when p_sort = 'mmr_desc' then t.mmr_value end desc,
            case when p_sort = 'mmr_asc' then t.mmr_value end asc,
            t.tier_value, t.cr_value desc nulls last, t.starts_key nulls last, t.lane_key nulls last, t.run_key nulls last, t.row_fingerprint, t.id
  offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 10), 1), 50);
$function$;


create or replace function public.panel_manheim_offer_summary(p_environment public.panel_environment,p_upload_id uuid)
returns table(demand_key text,lane_count integer,offlane_count integer,incomplete_count integer,selected_count integer,selected_ids uuid[])
language sql stable security invoker set search_path='' as $$
 with grouped as materialized(select * from public.panel_manheim_grouped_options(p_environment,p_upload_id,null)),
 options as(select g.*,public.panel_manheim_offer_group(g.vehicle_json->'parsed') grp,s.match_id selected_id
 from grouped g left join lateral(select ss.match_id from public.manheim_option_selections ss
 where ss.environment=p_environment and ss.status='SELECTED' and (g.vehicle_json#>'{parsed,memberMatchIds}') ? ss.match_id::text
 order by ss.updated_at,ss.id limit 1) s on true)
 select o.demand_key,count(*) filter(where grp='LANE')::int,count(*) filter(where grp='OFFLANE')::int,count(*) filter(where grp='INCOMPLETE')::int,
 count(selected_id)::int,coalesce(array_agg(selected_id order by selected_id) filter(where selected_id is not null),'{}'::uuid[]) from options o group by o.demand_key;
$$;
create or replace function public.panel_manheim_batch_cars(p_environment public.panel_environment,p_upload_ids uuid[])
returns table(upload_id uuid,car_count integer) language sql stable security invoker set search_path='' as $$
 select g.upload_id,count(distinct coalesce(nullif(upper(trim(g.vehicle_json#>>'{parsed,vin}')),''),g.row_fingerprint))::int
 from unnest(p_upload_ids) u cross join lateral public.panel_manheim_grouped_options(p_environment,u,null) g group by g.upload_id;
$$;
CREATE OR REPLACE FUNCTION public.panel_manheim_offer_select_v2(p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_action text, p_manual_pct numeric, p_reason text, p_note text, p_final_cents bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_match public.manheim_matches%rowtype; v_before public.manheim_option_selections%rowtype; v_after public.manheim_option_selections%rowtype;
 v_demand text; v_group text; v_mmr bigint; v_default numeric; v_status text; v_manual boolean;
 v_reason text := nullif(trim(coalesce(p_reason, '')), ''); v_note text := nullif(trim(coalesce(p_note, '')), '');
 v_members jsonb; v_selected integer; v_now timestamptz := now(); v_pct numeric; v_final bigint; v_manual_final boolean;
begin
 if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
 if p_action not in ('SELECT', 'REMOVE', 'EXCLUDE', 'PRICE') then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
 if p_manual_pct is not null and (p_manual_pct < 0 or p_manual_pct > 50 or p_manual_pct <> round(p_manual_pct, 2)) then raise exception 'MANHEIM_SELECTION_PCT_INVALID'; end if;
 if p_final_cents is not null and p_manual_pct is not null then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
 if v_note is not null and length(v_note) > 500 then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
 select * into v_match from public.manheim_matches m where m.environment = p_environment and m.id = p_match_id;
 if not found or v_match.undone_at is not null then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
 if not exists (select 1 from public.manheim_uploads u where u.id = v_match.upload_id and u.environment = p_environment and u.undone_at is null and u.activated_at is not null) then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
 -- Keep a pre-existing selection on any sale; operations target the car under the same demand lock.
 perform pg_advisory_xact_lock(hashtextextended('manheim_offer:' || p_environment::text || ':' || v_match.upload_id::text || ':' || v_match.demand_key,0));
 select g.* into v_match from public.panel_manheim_grouped_options(p_environment,v_match.upload_id,v_match.demand_key) g where (g.vehicle_json#>'{parsed,memberMatchIds}') ? p_match_id::text;
 if not found then raise exception 'MANHEIM_SALE_ENDED'; end if;
 v_members := v_match.vehicle_json#>'{parsed,memberMatchIds}';
 select coalesce((select ss.match_id from public.manheim_option_selections ss where ss.environment=p_environment and v_members ? ss.match_id::text order by (ss.status='SELECTED') desc,ss.updated_at desc,ss.id limit 1),v_match.id) into p_match_id;
 v_mmr := public.panel_manheim_offer_mmr(v_match.mmr_cents, v_match.vehicle_json -> 'parsed');
 if v_mmr is null then raise exception 'MANHEIM_MATCH_WITHOUT_MMR'; end if;
 v_demand := coalesce(v_match.demand_key, case when v_match.journey_id is not null then 'journey:' || v_match.journey_id::text else 'ref:' || trim(v_match.calc_ref::text) end || ':' || coalesce(v_match.logical_mode::text, ''));
 v_group := coalesce((select si.offer_group from public.manheim_complement_items si where si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = v_match.upload_id) and si.row_fingerprint = v_match.row_fingerprint), public.panel_manheim_offer_group(coalesce(v_match.vehicle_json -> 'parsed', '{}'::jsonb)));
 v_default := public.panel_manheim_offer_default_pct(v_mmr);
 perform pg_advisory_xact_lock(hashtextextended('manheim_offer:' || p_environment::text || ':' || v_match.upload_id::text || ':' || v_demand, 0));
 select * into v_before from public.manheim_option_selections s where s.environment = p_environment and s.match_id = p_match_id for update;
 v_status := case p_action when 'SELECT' then 'SELECTED' when 'REMOVE' then 'AVAILABLE' when 'EXCLUDE' then 'EXCLUDED' else coalesce(v_before.status, 'AVAILABLE') end;
 v_manual := coalesce(v_before.manual, false);
 if p_action = 'SELECT' then
  if v_group <> 'LANE' then
   if v_reason is null or length(v_reason) not between 5 and 300 then raise exception 'MANHEIM_SELECTION_REASON_REQUIRED'; end if;
   v_manual := true;
  else v_manual := false; v_reason := null; end if;
  select count(*) into v_selected from public.panel_manheim_grouped_options(p_environment,v_match.upload_id,v_demand) g where g.id<>v_match.id and exists(select 1 from public.manheim_option_selections s where s.environment=p_environment and s.status='SELECTED' and (g.vehicle_json#>'{parsed,memberMatchIds}') ? s.match_id::text);
  if v_selected >= 10 then raise exception 'MANHEIM_SELECTION_LIMIT'; end if;
 elsif p_action in ('REMOVE', 'EXCLUDE') then v_manual := false; v_reason := null;
 else v_reason := v_before.manual_reason; end if;
 if p_final_cents is not null then
  if p_final_cents < v_mmr or p_final_cents > round(v_mmr * 1.5) then raise exception 'MANHEIM_SELECTION_FINAL_INVALID'; end if;
  v_final := p_final_cents; v_pct := least(round((p_final_cents::numeric / v_mmr - 1) * 100, 2), 50); v_manual_final := true;
 elsif p_action = 'PRICE' or p_manual_pct is not null then
  v_pct := p_manual_pct; v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100); v_manual_final := false;
 elsif v_before.id is not null and v_before.manual_final and v_before.mmr_cents = v_mmr then
  v_pct := v_before.manual_pct; v_final := v_before.final_cents; v_manual_final := true;
 else
  v_pct := v_before.manual_pct; v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100); v_manual_final := false;
 end if;
 insert into public.manheim_option_selections as s (environment, match_id, upload_id, demand_key, status, manual, manual_reason, offer_group, mmr_cents, default_pct, manual_pct, final_cents, manual_final, note, updated_by, updated_at)
 values (p_environment, p_match_id, v_match.upload_id, v_demand, v_status, v_manual, v_reason, v_group, v_mmr, v_default, v_pct, v_final::integer, v_manual_final, case when p_action = 'PRICE' or v_note is not null then v_note else v_before.note end, p_actor_id, v_now)
 on conflict (environment, match_id) do update set status = excluded.status, manual = excluded.manual, manual_reason = excluded.manual_reason, offer_group = excluded.offer_group, mmr_cents = excluded.mmr_cents, default_pct = excluded.default_pct, manual_pct = excluded.manual_pct, final_cents = excluded.final_cents, manual_final = excluded.manual_final, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
 returning * into v_after;
 insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
 values (p_environment, p_actor_id, 'manheim_option_selection', p_match_id, 'OPTION_' || p_action,
  case when v_before.id is null then null else jsonb_build_object('status', v_before.status, 'manual', v_before.manual, 'manual_reason', v_before.manual_reason, 'manual_pct', v_before.manual_pct, 'final_cents', v_before.final_cents, 'manual_final', v_before.manual_final, 'note', v_before.note) end,
  jsonb_build_object('status', v_after.status, 'manual', v_after.manual, 'manual_reason', v_after.manual_reason, 'group', v_after.offer_group, 'default_pct', v_after.default_pct, 'manual_pct', v_after.manual_pct, 'final_cents', v_after.final_cents, 'manual_final', v_after.manual_final, 'note', v_after.note, 'demand_key', v_demand), v_now);

 -- Only an explicit action changes selection state; no rows or sent snapshots are deleted.
 if p_action in ('SELECT','REMOVE','EXCLUDE') then
  with changed as (
   update public.manheim_option_selections s set status=case when p_action='EXCLUDE' then 'EXCLUDED' else 'AVAILABLE' end,updated_by=p_actor_id,updated_at=v_now
   where s.environment=p_environment and v_members ? s.match_id::text and s.match_id<>p_match_id and s.status='SELECTED' returning s.id,s.match_id
  ) insert into public.audit_log(environment,actor_user_id,entity_type,entity_id,action,after_json)
    select p_environment,p_actor_id,'manheim_option_selection',id,'VIN_GROUP_SELECTION',jsonb_build_object('matchId',match_id,'primary',v_match.id,'action',p_action) from changed;
 end if;
 select count(*) into v_selected from public.panel_manheim_grouped_options(p_environment,v_match.upload_id,v_demand) g where exists(select 1 from public.manheim_option_selections s where s.environment=p_environment and s.status='SELECTED' and (g.vehicle_json#>'{parsed,memberMatchIds}') ? s.match_id::text);
 return jsonb_build_object('matchId', p_match_id, 'demandKey', v_demand, 'status', v_after.status, 'group', v_after.offer_group, 'manual', v_after.manual, 'manualReason', v_after.manual_reason, 'defaultPct', v_after.default_pct, 'manualPct', v_after.manual_pct, 'finalCents', v_after.final_cents, 'manualFinal', v_after.manual_final, 'note', v_after.note, 'selectedCount', v_selected);
end;
$function$;
CREATE OR REPLACE FUNCTION public.panel_manheim_offer_select(p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_action text, p_manual_pct numeric, p_reason text, p_note text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ begin return public.panel_manheim_offer_select_v2(p_environment,p_actor_id,p_match_id,p_action,p_manual_pct,p_reason,p_note,null); end; $function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_batch_people(p_environment public.panel_environment, p_upload_id uuid)
 RETURNS TABLE(journey_id uuid, calc_ref text, logical_mode text, vehicle_count integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$
  with cars as (
    select distinct m.journey_id, trim(m.calc_ref::text) as calc_ref, m.logical_mode::text as logical_mode, coalesce(nullif(upper(trim(m.vehicle_json#>>'{parsed,vin}')),''),m.row_fingerprint) as row_fingerprint
      from public.panel_manheim_grouped_options(p_environment,p_upload_id,null) m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null and coalesce(m.mmr_cents::bigint, case when m.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (m.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
  )
  select c.journey_id, c.calc_ref, c.logical_mode, count(*)::integer from cars c group by 1, 2, 3
  union all
  select d.journey_id, d.calc_ref, null::text, count(*)::integer
    from (select distinct c.journey_id, c.calc_ref, c.row_fingerprint from cars c) d
   group by 1, 2;
$function$;

CREATE OR REPLACE FUNCTION public.panel_manheim_score_mmr(p_environment public.panel_environment, p_since timestamp with time zone)
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
           case when m.journey_id is not null then 'j:' || m.journey_id::text else 'r:' || upper(trim(m.calc_ref::text)) end as person,
           coalesce(nullif(upper(trim(m.vehicle_json#>>'{parsed,vin}')),''),m.row_fingerprint) as row_fingerprint, m.mmr_cents
      from live u cross join lateral public.panel_manheim_grouped_options(p_environment,u.id,null) m
     where m.environment = p_environment and m.upload_id in (select id from live) and m.undone_at is null
       and m.wish_index = 0 and m.match_kind in ('BATE','POR_VALOR') and m.mmr_cents > 0
  ), unique_cars as (
    select distinct on (person, row_fingerprint) person, mmr_cents from cars order by person, row_fingerprint, mmr_cents
  )
  select person, round(percentile_cont(0.5) within group (order by mmr_cents))::bigint, count(*)::integer
    from unique_cars group by person;
$function$;
