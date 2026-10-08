-- Restore the prior private function only; source data and public permissions are unchanged.
create or replace function panel_internal.manheim_grouped_prepared(p_environment public.panel_environment,p_upload_id uuid)
returns table(upload_id uuid,demand_key text,dk text,car_key text,id uuid,logical_mode text,journey_id uuid,calc_ref text,match_kind text,criteria_hash text,presented boolean,mmr_cents integer,wish_index smallint,offer_group text,selected_id uuid)
language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 with inputs as materialized (
   select m.upload_id,m.demand_key,m.id,m.logical_mode::text logical_mode,m.journey_id,trim(m.calc_ref::text) calc_ref,
     m.match_kind,m.criteria_hash,m.presented_unit_id is not null presented,m.mmr_cents,m.wish_index,
     case when q.source_version=m.xmin::text and q.sale_run is not distinct from c.run_id
       and q.sale_version is not distinct from si.xmin::text then q else panel_internal.manheim_prepare_live(m.id) end q,
     s.match_id sel_id,s.updated_at sel_at,s.id sel_row
   from public.manheim_matches m
   left join panel_internal.manheim_prepared_inputs q on q.match_id=m.id
   left join public.manheim_sale_current c on c.environment=p_environment and c.upload_id=p_upload_id
   left join public.manheim_complement_items si on si.run_id=c.run_id
     and si.row_fingerprint=m.row_fingerprint
   left join public.manheim_option_selections s on s.match_id=m.id and s.environment=p_environment and s.status='SELECTED'
   where m.environment=p_environment and m.upload_id=p_upload_id and m.undone_at is null
 ), flagged as materialized (
   select i.upload_id,i.demand_key,i.id,i.logical_mode,i.journey_id,i.calc_ref,i.match_kind,i.criteria_hash,
     i.presented,i.mmr_cents,i.wish_index,i.sel_id,i.sel_at,i.sel_row,
     (q).dk dk,(q).vk vk,(q).car_key car_key,(q).priority priority,
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
 ), group_state as materialized (
   select dk,vk,bool_or(presented) any_presented,
     (array_agg(sel_id order by sel_at,sel_row) filter(where sel_id is not null))[1] first_selected
   from flagged where presented or sel_id is not null group by dk,vk
 ), representative as (
   select distinct on(dk,vk) f.* from flagged f where active
   order by dk,vk,priority,id
 )
 select r.upload_id,r.demand_key,r.dk,r.car_key,r.id,r.logical_mode,r.journey_id,r.calc_ref,r.match_kind,r.criteria_hash,coalesce(s.any_presented,false),r.mmr_cents,r.wish_index,
   case r.priority when 0 then 'LANE' when 1 then 'OFFLANE' else 'INCOMPLETE' end,s.first_selected
 from representative r left join group_state s on r.vk=s.vk
   and coalesce(r.dk,'')=coalesce(s.dk,'') and (r.dk is null)=(s.dk is null);
$$;
