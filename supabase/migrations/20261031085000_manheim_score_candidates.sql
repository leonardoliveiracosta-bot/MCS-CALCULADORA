-- Same active representative as grouped_light; score does not read presentation/selection state.
create or replace function panel_internal.manheim_score_candidates(
 p_environment public.panel_environment,p_upload_id uuid
) returns table(person text,car_key text,mmr_cents integer)
language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 with inputs as materialized (
  select m.id,m.journey_id,trim(m.calc_ref::text) calc_ref,m.match_kind,m.mmr_cents,m.wish_index,
  case when q.source_version=m.xmin::text and q.sale_run is not distinct from c.run_id
       and q.sale_version is not distinct from si.xmin::text then q else panel_internal.manheim_prepare_live(m.id) end q
 from public.manheim_matches m
   left join panel_internal.manheim_prepared_inputs q on q.match_id=m.id
   left join public.manheim_sale_current c on c.environment=p_environment and c.upload_id=p_upload_id
   left join public.manheim_complement_items si on si.run_id=c.run_id
     and si.row_fingerprint=m.row_fingerprint
   where m.environment=p_environment and m.upload_id=p_upload_id and m.undone_at is null
 ), flagged as materialized (
  select i.id,i.journey_id,i.calc_ref,i.match_kind,i.mmr_cents,i.wish_index,
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
 ), representative as (
  select distinct on(dk,vk) f.* from flagged f where active order by dk,vk,priority,id
 )
 select case when journey_id is not null then 'j:'||journey_id::text else 'r:'||upper(calc_ref) end,
  car_key,mmr_cents from representative
 where wish_index=0 and match_kind in('BATE','POR_VALOR') and mmr_cents>0;
$$;
create or replace function panel_internal.manheim_score_mmr_candidates(
 p_environment public.panel_environment,p_since timestamptz
) returns table(person text,mmr_cents bigint,sample integer)
language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 with live as (
  select u.id from public.manheim_uploads u where u.environment=p_environment and u.undone_at is null
   and u.activated_at is not null and u.uploaded_at>=p_since
 ), cars as (
  select distinct g.person,g.car_key,g.mmr_cents from live u
   cross join lateral panel_internal.manheim_score_candidates(p_environment,u.id) g
 ), unique_cars as (
  select distinct on(person,car_key) person,mmr_cents from cars order by person,car_key,mmr_cents
 )
 select person,round(percentile_cont(0.5) within group(order by mmr_cents))::bigint,count(*)::integer
 from unique_cars group by person;
$$;
revoke all on function panel_internal.manheim_score_candidates(public.panel_environment,uuid) from public,anon,authenticated;
revoke all on function panel_internal.manheim_score_mmr_candidates(public.panel_environment,timestamptz) from public,anon,authenticated;
grant execute on function panel_internal.manheim_score_candidates(public.panel_environment,uuid) to service_role;
grant execute on function panel_internal.manheim_score_mmr_candidates(public.panel_environment,timestamptz) to service_role;
