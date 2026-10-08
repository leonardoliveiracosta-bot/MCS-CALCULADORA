-- Created with supabase migration new, then ordered after the existing 20261031 migrations.
-- Derived data only. Source matches, selections, units, sent snapshots and messages are untouched.
set lock_timeout = '5s';
set statement_timeout = '60s';
create schema if not exists panel_internal;
revoke all on schema panel_internal from public, anon, authenticated;
grant usage on schema panel_internal to service_role;

create table panel_internal.manheim_prepared_inputs (
  match_id uuid primary key references public.manheim_matches(id) on delete cascade on update cascade,
  environment public.panel_environment not null,
  upload_id uuid not null,
  dk text, vk text not null, car_key text not null,
  valid_mmr boolean not null, lane boolean not null, priority smallint not null,
  ends_raw text, ends_cached boolean not null, ends_at timestamptz,
  starts_raw text, starts_cached boolean not null, starts_day boolean not null,
  starts_date date, starts_at timestamptz, prepared_timezone text not null,
  source_version text, sale_run uuid, sale_version text
);
create index manheim_prepared_batch_idx on panel_internal.manheim_prepared_inputs(environment, upload_id);
alter table panel_internal.manheim_prepared_inputs enable row level security;
revoke all on table panel_internal.manheim_prepared_inputs from public, anon, authenticated;
grant select, insert, update, delete on table panel_internal.manheim_prepared_inputs to service_role;
create policy prepared_service on panel_internal.manheim_prepared_inputs to service_role using (true) with check (true);

-- Cache only absolute ISO-shaped date inputs. Relative/locale-dependent strings stay live.
-- Timestamps without an offset are reused only under the same session timezone that parsed them.
-- The legacy regexes for sale-day and Buy Now classification are copied verbatim, not corrected here.
create function panel_internal.manheim_prepare(m public.manheim_matches, sale jsonb, source_version text default null, sale_run uuid default null, sale_version text default null)
returns panel_internal.manheim_prepared_inputs language sql stable security invoker set search_path='' as $$
 with effective as materialized (
   select coalesce(m.vehicle_json->'parsed','{}'::jsonb)||coalesce(sale,'{}'::jsonb) p
 ), inputs as materialized (
   select p, nullif(trim(p->>'endsAt'),'') e,
     nullif(trim(coalesce(nullif(trim(p->>'startsAt'),''),p->>'saleDate')),'') d,
     coalesce(trim(p->>'lane'),'')<>'' and coalesce(trim(p->>'run'),'')<>'' lane
   from effective
 ), flags as (
   select *,
     coalesce(e ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$',false) ec,
     coalesce(d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$',false) dc,
     coalesce(d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(d,'date'),false) dd
   from inputs
 )
 select m.id, m.environment, m.upload_id,
   coalesce(m.demand_key,case when m.journey_id is not null then 'journey:'||m.journey_id::text else 'ref:'||trim(m.calc_ref::text) end||':'||coalesce(m.logical_mode::text,'')),
   coalesce(nullif(upper(trim(m.vehicle_json#>>'{parsed,vin}')),''),'row:'||m.id),
   coalesce(nullif(upper(trim(m.vehicle_json#>>'{parsed,vin}')),''),m.row_fingerprint),
   case when m.mmr_cents>0 then true when coalesce(p->>'mmrCents','')~'^[0-9]{1,12}$' then (p->>'mmrCents')::bigint>0 else false end,
   lane,
   (case when lane then 0
     when regexp_replace(coalesce(p->>'buyNowPrice',''),'[$,\s]','','g')~'^\d+(\.\d+)?$'
       then case when regexp_replace(p->>'buyNowPrice','[$,\s]','','g')::numeric>0 then 1 else 2 end
     else 2 end)::smallint,
   e, ec, case when ec and pg_input_is_valid(e,'timestamptz') then e::timestamptz end,
   d, dc, dd, case when dd then d::date end,
   case when dc and not dd and pg_input_is_valid(d,'timestamptz') then d::timestamptz end,
   current_setting('TimeZone'), source_version, sale_run, sale_version
 from flags;
$$;

create function panel_internal.manheim_refresh(p_ids uuid[] default null, p_environment public.panel_environment default null, p_upload_id uuid default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_ids is not null and cardinality(p_ids)=0 then return; end if;
 with prepared as materialized (
   select panel_internal.manheim_prepare(m,si.sale,m.xmin::text,c.run_id,si.xmin::text) r
   from public.manheim_matches m
   left join public.manheim_sale_current c on c.environment=m.environment and c.upload_id=m.upload_id
   left join public.manheim_complement_items si on si.run_id=c.run_id and si.row_fingerprint=m.row_fingerprint
   where m.undone_at is null and (p_ids is null or m.id=any(p_ids))
     and (p_environment is null or m.environment=p_environment)
     and (p_upload_id is null or m.upload_id=p_upload_id)
 )
 insert into panel_internal.manheim_prepared_inputs select (r).* from prepared
 on conflict(match_id) do update set
   environment=excluded.environment,upload_id=excluded.upload_id,dk=excluded.dk,vk=excluded.vk,car_key=excluded.car_key,
   valid_mmr=excluded.valid_mmr,lane=excluded.lane,priority=excluded.priority,
   ends_raw=excluded.ends_raw,ends_cached=excluded.ends_cached,ends_at=excluded.ends_at,
   starts_raw=excluded.starts_raw,starts_cached=excluded.starts_cached,starts_day=excluded.starts_day,
   starts_date=excluded.starts_date,starts_at=excluded.starts_at,prepared_timezone=excluded.prepared_timezone,
   source_version=excluded.source_version,sale_run=excluded.sale_run,sale_version=excluded.sale_version;
 delete from panel_internal.manheim_prepared_inputs q
 where (p_ids is null or q.match_id=any(p_ids))
   and (p_environment is null or q.environment=p_environment)
   and (p_upload_id is null or q.upload_id=p_upload_id)
   and not exists(select 1 from public.manheim_matches m where m.id=q.match_id and m.undone_at is null);
end $$;

create function panel_internal.manheim_matches_prepare_changed()
returns trigger language plpgsql security invoker set search_path='' as $$
declare ids uuid[];
begin
 if TG_OP='INSERT' then
   select array_agg(id) into ids from new_rows;
 else
   select array_agg(id) into ids from new_rows;
 end if;
 if ids is not null then perform panel_internal.manheim_refresh(ids); end if;
 return null;
end $$;
create trigger manheim_prepare_insert after insert on public.manheim_matches
 referencing new table as new_rows for each statement execute function panel_internal.manheim_matches_prepare_changed();
create trigger manheim_prepare_update after update on public.manheim_matches
 referencing old table as old_rows new table as new_rows for each statement execute function panel_internal.manheim_matches_prepare_changed();

create function panel_internal.manheim_sale_items_prepare_changed()
returns trigger language plpgsql security invoker set search_path='' as $$
declare ids uuid[];
begin
 if TG_OP='INSERT' then
   select array_agg(distinct m.id) into ids from new_rows n
   join public.manheim_sale_current c on c.run_id=n.run_id
   join public.manheim_matches m on m.environment=c.environment and m.upload_id=c.upload_id and m.row_fingerprint=n.row_fingerprint;
 elsif TG_OP='DELETE' then
   select array_agg(distinct m.id) into ids from old_rows n
   join public.manheim_sale_current c on c.run_id=n.run_id
   join public.manheim_matches m on m.environment=c.environment and m.upload_id=c.upload_id and m.row_fingerprint=n.row_fingerprint;
 else
   with changed as (select run_id,row_fingerprint from old_rows union select run_id,row_fingerprint from new_rows)
   select array_agg(distinct m.id) into ids from changed n
   join public.manheim_sale_current c on c.run_id=n.run_id
   join public.manheim_matches m on m.environment=c.environment and m.upload_id=c.upload_id and m.row_fingerprint=n.row_fingerprint;
 end if;
 if ids is not null then perform panel_internal.manheim_refresh(ids); end if;
 return null;
end $$;
create trigger manheim_prepare_sale_insert after insert on public.manheim_complement_items
 referencing new table as new_rows for each statement execute function panel_internal.manheim_sale_items_prepare_changed();
create trigger manheim_prepare_sale_update after update on public.manheim_complement_items
 referencing old table as old_rows new table as new_rows for each statement execute function panel_internal.manheim_sale_items_prepare_changed();
create trigger manheim_prepare_sale_delete after delete on public.manheim_complement_items
 referencing old table as old_rows for each statement execute function panel_internal.manheim_sale_items_prepare_changed();

create function panel_internal.manheim_sale_current_prepare_changed()
returns trigger language plpgsql security invoker set search_path='' as $$
declare batch record;
begin
 if TG_OP='INSERT' then
   for batch in select distinct environment,upload_id from new_rows loop
     perform panel_internal.manheim_refresh(null,batch.environment,batch.upload_id);
   end loop;
 elsif TG_OP='DELETE' then
   for batch in select distinct environment,upload_id from old_rows loop
     perform panel_internal.manheim_refresh(null,batch.environment,batch.upload_id);
   end loop;
 else
   for batch in select environment,upload_id from new_rows union select environment,upload_id from old_rows loop
     perform panel_internal.manheim_refresh(null,batch.environment,batch.upload_id);
   end loop;
 end if;
 return null;
end $$;
create trigger manheim_prepare_current_insert after insert on public.manheim_sale_current
 referencing new table as new_rows for each statement execute function panel_internal.manheim_sale_current_prepare_changed();
create trigger manheim_prepare_current_update after update on public.manheim_sale_current
 referencing old table as old_rows new table as new_rows for each statement execute function panel_internal.manheim_sale_current_prepare_changed();
create trigger manheim_prepare_current_delete after delete on public.manheim_sale_current
 referencing old table as old_rows for each statement execute function panel_internal.manheim_sale_current_prepare_changed();

-- Existing APIs still call the original function until the separate activation migration.
-- These inputs are always current through the triggers above; missing derived rows use the old extraction.
create function panel_internal.manheim_grouped_prepared(p_environment public.panel_environment,p_upload_id uuid)
returns table(upload_id uuid,demand_key text,dk text,car_key text,id uuid,logical_mode text,journey_id uuid,calc_ref text,match_kind text,criteria_hash text,presented boolean,mmr_cents integer,wish_index smallint,offer_group text,selected_id uuid)
language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 with inputs as materialized (
   select m.upload_id,m.demand_key,m.id,m.logical_mode::text logical_mode,m.journey_id,trim(m.calc_ref::text) calc_ref,
     m.match_kind,m.criteria_hash,m.presented_unit_id is not null presented,m.mmr_cents,m.wish_index,
     case when q.source_version=m.xmin::text and q.sale_run is not distinct from c.run_id
       and q.sale_version is not distinct from si.xmin::text then q else panel_internal.manheim_prepare(m,si.sale) end q,
     s.match_id sel_id,s.updated_at sel_at,s.id sel_row
   from public.manheim_matches m
   left join panel_internal.manheim_prepared_inputs q on q.match_id=m.id
   left join public.manheim_sale_current c on c.environment=p_environment and c.upload_id=p_upload_id
   left join public.manheim_complement_items si on si.run_id=c.run_id
     and si.row_fingerprint=m.row_fingerprint
   left join public.manheim_option_selections s on s.match_id=m.id and s.environment=p_environment and s.status='SELECTED'
   where m.environment=p_environment and m.upload_id=p_upload_id and m.undone_at is null
 ), flagged as materialized (
   select i.*, (q).dk dk,(q).vk vk,(q).car_key car_key,(q).priority priority,
     (not (
       coalesce(case when (q).ends_cached and (q).prepared_timezone=current_setting('TimeZone') then (q).ends_at<=now()
         when pg_input_is_valid((q).ends_raw,'timestamptz') then (q).ends_raw::timestamptz<=now() end,false)
       or ((q).lane and coalesce(case
         when (q).starts_cached and (q).prepared_timezone=current_setting('TimeZone') then
           case when (q).starts_day then (q).starts_date<=(now() at time zone 'America/New_York')::date else (q).starts_at<=now() end
         when (q).starts_raw ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid((q).starts_raw,'date') then (q).starts_raw::date<=(now() at time zone 'America/New_York')::date
         when pg_input_is_valid((q).starts_raw,'timestamptz') then (q).starts_raw::timestamptz<=now() end,false))
     )) and (q).valid_mmr active
   from inputs i
 ), ranked as (
   select f.*, row_number() over(partition by f.dk,f.vk order by f.active desc,f.priority,f.id) rn,
     bool_or(f.presented) over(partition by f.dk,f.vk) any_presented,
     first_value(f.sel_id) over(partition by f.dk,f.vk order by f.sel_id is null,f.sel_at,f.sel_row rows between unbounded preceding and unbounded following) first_selected
   from flagged f
 )
 select r.upload_id,r.demand_key,r.dk,r.car_key,r.id,r.logical_mode,r.journey_id,r.calc_ref,r.match_kind,r.criteria_hash,r.any_presented,r.mmr_cents,r.wish_index,
   case r.priority when 0 then 'LANE' when 1 then 'OFFLANE' else 'INCOMPLETE' end,r.first_selected
 from ranked r where r.rn=1 and r.active;
$$;

-- Private comparison endpoints; public API remains unchanged until the next migration.
CREATE OR REPLACE FUNCTION panel_internal.manheim_batch_overview_prepared(p_environment panel_environment, p_upload_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$;
  with g as materialized (
    select * from panel_internal.manheim_grouped_prepared(p_environment, p_upload_id)
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
  ), stored as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) dk,
           min(m.logical_mode::text) logical_mode, (array_agg(m.journey_id))[1] journey_id, min(trim(m.calc_ref::text)) calc_ref,
           count(distinct coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), m.row_fingerprint))::integer cars
      from public.manheim_matches m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
     group by 1
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
$function$;


CREATE OR REPLACE FUNCTION panel_internal.manheim_score_mmr_prepared(p_environment panel_environment, p_since timestamp with time zone)
 RETURNS TABLE(person text, mmr_cents bigint, sample integer)
 LANGUAGE sql
 STABLE SECURITY INVOKER
 SET search_path TO ''
 SET work_mem TO '32MB'
AS $function$;
  with live as (
    select u.id from public.manheim_uploads u
     where u.environment = p_environment and u.undone_at is null and u.activated_at is not null and u.uploaded_at >= p_since
  ), cars as (
    select distinct
           case when g.journey_id is not null then 'j:' || g.journey_id::text else 'r:' || upper(g.calc_ref) end as person,
           g.car_key, g.mmr_cents
      from live u cross join lateral panel_internal.manheim_grouped_prepared(p_environment, u.id) g
     where g.wish_index = 0 and g.match_kind in ('BATE','POR_VALOR') and g.mmr_cents > 0
  ), unique_cars as (
    select distinct on (person, car_key) person, mmr_cents from cars order by person, car_key, mmr_cents
  )
  select person, round(percentile_cont(0.5) within group (order by mmr_cents))::bigint, count(*)::integer
    from unique_cars group by person;
$function$;


revoke all on all functions in schema panel_internal from public,anon,authenticated;
grant execute on all functions in schema panel_internal to service_role;
-- Tuple versions guard against concurrent source/complement writes: stale derived data falls back
-- to the original extraction in the same snapshot rather than exposing an outdated count.
-- Backfill and trigger installation commit together; no API can observe a partially prepared lot.
select panel_internal.manheim_refresh();
analyze panel_internal.manheim_prepared_inputs;
reset lock_timeout;
reset statement_timeout;
