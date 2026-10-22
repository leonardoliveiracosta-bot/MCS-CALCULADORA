-- Independent V1/V2. Existing rows and customer-driven requests keep their original meaning.
alter table public.vitrines add column if not exists manual_request_id uuid;
alter table public.vitrines add column if not exists manual_payload_hash text;
alter table public.vitrines add column if not exists recipient_phone text;
create unique index if not exists vitrines_manual_request_idx on public.vitrines(environment,created_by,manual_request_id) where manual_request_id is not null;
-- Atomic creation: a retry never leaves a second link or a partially populated presentation.
create or replace function public.panel_manual_vitrine_create(p_environment public.panel_environment,p_actor uuid,p_request uuid,p_hash text,p_vitrine jsonb,p_cars jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare found_row public.vitrines; car jsonb; n integer;
begin
  if p_actor is null or p_request is null or p_hash is null or length(p_hash)<>64 or coalesce(p_vitrine->>'version','') not in ('V1','V2') or coalesce(jsonb_typeof(p_cars),'')<>'array' then raise exception 'MANUAL_INVALID'; end if;
  n:=jsonb_array_length(p_cars);
  if n<1 or n>(case when p_vitrine->>'version'='V2' then 1 else 10 end) then raise exception 'MANUAL_CARS_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_environment::text||p_actor::text||p_request::text,0));
  select * into found_row from public.vitrines where environment=p_environment and created_by=p_actor and manual_request_id=p_request;
  if found then
    if found_row.manual_payload_hash<>p_hash then raise exception 'MANUAL_DRAFT_CHANGED'; end if;
    return to_jsonb(found_row);
  end if;
  insert into public.vitrines(environment,token,reference_code,customer_name,recipient_phone,version,expires_at,created_by,manual_request_id,manual_payload_hash)
  values(p_environment,p_vitrine->>'token','',p_vitrine->>'customer_name',p_vitrine->>'recipient_phone',p_vitrine->>'version',(p_vitrine->>'expires_at')::timestamptz,p_actor,p_request,p_hash)
  returning * into found_row;
  for car in select value from jsonb_array_elements(p_cars) loop
    if coalesce(jsonb_typeof(car->'vehicle_snapshot'),'')<>'object' or coalesce((car->'vehicle_snapshot'->>'estimatedMarketReference')::numeric,0)<=0 then raise exception 'MANUAL_CARS_INVALID'; end if;
    insert into public.vitrine_cars(environment,vitrine_id,short_code,vehicle_snapshot,customer_limit_cents,note_text,photo_paths)
    values(p_environment,found_row.id,car->>'short_code',car->'vehicle_snapshot',(car->>'customer_limit_cents')::integer,car->>'note_text','[]'::jsonb);
  end loop;
  return to_jsonb(found_row);
end $$;
revoke all on function public.panel_manual_vitrine_create(public.panel_environment,uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.panel_manual_vitrine_create(public.panel_environment,uuid,uuid,text,jsonb,jsonb) to service_role;
