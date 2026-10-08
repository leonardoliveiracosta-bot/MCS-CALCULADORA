-- Bulk extraction uses the exact prepare expressions, avoiding a SQL function call per source row.
create or replace function panel_internal.manheim_refresh(p_ids uuid[] default null, p_environment public.panel_environment default null, p_upload_id uuid default null)
returns void language plpgsql security invoker set search_path='' as $$
begin
 if p_ids is not null and cardinality(p_ids)=0 then return; end if;
 with effective as (
   select m.id,m.environment,m.upload_id,m.demand_key,m.journey_id,m.calc_ref,m.logical_mode,m.vehicle_json,m.row_fingerprint,m.mmr_cents,
     m.xmin::text source_version,c.run_id sale_run,si.xmin::text sale_version,
     coalesce(m.vehicle_json->'parsed','{}'::jsonb)||coalesce(si.sale,'{}'::jsonb) p
   from public.manheim_matches m
   left join public.manheim_sale_current c on c.environment=m.environment and c.upload_id=m.upload_id
   left join public.manheim_complement_items si on si.run_id=c.run_id and si.row_fingerprint=m.row_fingerprint
   where m.undone_at is null and (p_ids is null or m.id=any(p_ids))
     and (p_environment is null or m.environment=p_environment)
     and (p_upload_id is null or m.upload_id=p_upload_id)
 ), inputs as (
   select *, nullif(trim(p->>'endsAt'),'') e,
     nullif(trim(coalesce(nullif(trim(p->>'startsAt'),''),p->>'saleDate')),'') d,
     coalesce(trim(p->>'lane'),'')<>'' and coalesce(trim(p->>'run'),'')<>'' lane
   from effective
 ), flags as (
   select *,
     coalesce(e ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$',false) ec,
     coalesce(d ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?([Zz]|[+-][0-9]{2}(:?[0-9]{2})?)?)?$',false) dc,
     coalesce(d ~ '^\d{4}-\d{2}-\d{2}$' and pg_input_is_valid(d,'date'),false) dd
   from inputs
 ), prepared as materialized (
 select id, environment, upload_id,
   coalesce(demand_key,case when journey_id is not null then 'journey:'||journey_id::text else 'ref:'||trim(calc_ref::text) end||':'||coalesce(logical_mode::text,'')),
   coalesce(nullif(upper(trim(vehicle_json#>>'{parsed,vin}')),''),'row:'||id),
   coalesce(nullif(upper(trim(vehicle_json#>>'{parsed,vin}')),''),row_fingerprint),
   case when mmr_cents>0 then true when coalesce(p->>'mmrCents','')~'^[0-9]{1,12}$' then (p->>'mmrCents')::bigint>0 else false end,
   lane,
   (case when lane then 0
     when regexp_replace(coalesce(p->>'buyNowPrice',''),'[$,\s]','','g')~'^\d+(\.\d+)?$'
       then case when regexp_replace(p->>'buyNowPrice','[$,\s]','','g')::numeric>0 then 1 else 2 end
     else 2 end)::smallint,
   e, ec, case when ec and pg_input_is_valid(e,'timestamptz') then e::timestamptz end,
   d, dc, dd, case when dd then d::date end,
   case when dc and not dd and pg_input_is_valid(d,'timestamptz') then d::timestamptz end,
   current_setting('TimeZone'), source_version, sale_run, sale_version
 from flags
 )
 insert into panel_internal.manheim_prepared_inputs select * from prepared
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
