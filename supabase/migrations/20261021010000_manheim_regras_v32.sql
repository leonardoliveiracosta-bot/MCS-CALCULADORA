-- Permanent matching rules v3.2. Additive schema; historical requests and CSVs are preserved.
create table public.model_aliases (
 id uuid primary key default gen_random_uuid(), make text not null, client_model text not null,
 manheim_models text[] not null, kind text not null check(kind in ('EQUIVALENT','BASE_VERSION','NEVER')),
 target_make text not null, created_at timestamptz not null default now(),
 unique(make,client_model,kind,target_make)
);
create table public.manheim_known_models (make text not null, model text not null, primary key(make,model));
alter table public.model_aliases enable row level security;
alter table public.manheim_known_models enable row level security;
revoke all on public.model_aliases,public.manheim_known_models from public,anon,authenticated;
grant select,insert,update,delete on public.model_aliases to service_role;
grant select,insert on public.manheim_known_models to service_role;
insert into public.model_aliases(make,client_model,manheim_models,kind,target_make)
select make,client_model,manheim_models,kind,target_make from jsonb_to_recordset($aliases$[{"make": "Mercedes", "client_model": "*", "manheim_models": ["*"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Dodge", "client_model": "Ram 1500", "manheim_models": ["1500"], "kind": "EQUIVALENT", "target_make": "Ram"}, {"make": "Ram", "client_model": "1500", "manheim_models": ["Ram 1500"], "kind": "EQUIVALENT", "target_make": "Dodge"}, {"make": "Dodge", "client_model": "Ram 1500", "manheim_models": ["Ram 1500"], "kind": "EQUIVALENT", "target_make": "Dodge"}, {"make": "Dodge", "client_model": "Ram 2500", "manheim_models": ["2500"], "kind": "EQUIVALENT", "target_make": "Ram"}, {"make": "Ram", "client_model": "2500", "manheim_models": ["Ram 2500"], "kind": "EQUIVALENT", "target_make": "Dodge"}, {"make": "Dodge", "client_model": "Ram 2500", "manheim_models": ["Ram 2500"], "kind": "EQUIVALENT", "target_make": "Dodge"}, {"make": "Jeep", "client_model": "Grand Cherokee", "manheim_models": ["Grand Cherokee L", "Grand Cherokee 4xe"], "kind": "BASE_VERSION", "target_make": "Jeep"}, {"make": "Honda", "client_model": "Civic", "manheim_models": ["Civic Si", "Civic Type R"], "kind": "BASE_VERSION", "target_make": "Honda"}, {"make": "Dodge", "client_model": "Charger", "manheim_models": ["Charger Daytona"], "kind": "BASE_VERSION", "target_make": "Dodge"}, {"make": "BMW", "client_model": "X3", "manheim_models": ["X3 M"], "kind": "BASE_VERSION", "target_make": "BMW"}, {"make": "BMW", "client_model": "X5", "manheim_models": ["X5 M"], "kind": "BASE_VERSION", "target_make": "BMW"}, {"make": "Cadillac", "client_model": "Escalade", "manheim_models": ["Escalade ESV", "Escalade IQ", "Escalade IQL"], "kind": "BASE_VERSION", "target_make": "Cadillac"}, {"make": "GMC", "client_model": "Yukon", "manheim_models": ["Yukon XL"], "kind": "BASE_VERSION", "target_make": "GMC"}, {"make": "Lincoln", "client_model": "Navigator", "manheim_models": ["Navigator L"], "kind": "BASE_VERSION", "target_make": "Lincoln"}, {"make": "Toyota", "client_model": "Prius", "manheim_models": ["Prius c", "Prius v", "Prius Prime"], "kind": "BASE_VERSION", "target_make": "Toyota"}, {"make": "Toyota", "client_model": "RAV4", "manheim_models": ["RAV4 Prime"], "kind": "BASE_VERSION", "target_make": "Toyota"}, {"make": "Chevrolet", "client_model": "Silverado 1500", "manheim_models": ["Silverado"], "kind": "BASE_VERSION", "target_make": "Chevrolet"}, {"make": "Mercedes-Benz", "client_model": "GLS", "manheim_models": ["Mercedes-Maybach GLS"], "kind": "BASE_VERSION", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "S-Class", "manheim_models": ["Mercedes-Maybach S-Class"], "kind": "BASE_VERSION", "target_make": "Mercedes-Benz"}, {"make": "Audi", "client_model": "RS Q8", "manheim_models": ["RS Q8 performance"], "kind": "BASE_VERSION", "target_make": "Audi"}, {"make": "Ferrari", "client_model": "SF90", "manheim_models": ["SF90 Stradale", "SF90 Spider"], "kind": "BASE_VERSION", "target_make": "Ferrari"}, {"make": "MINI", "client_model": "Cooper", "manheim_models": ["Cooper", "Hardtop", "Cooper S"], "kind": "BASE_VERSION", "target_make": "MINI"}, {"make": "Mercedes-Benz", "client_model": "AMG GT", "manheim_models": ["Mercedes-AMG GT"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "GT 53", "manheim_models": ["Mercedes-AMG GT"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "GT 63", "manheim_models": ["Mercedes-AMG GT"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "GT 53/63", "manheim_models": ["Mercedes-AMG GT"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "G63", "manheim_models": ["G-Class"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "ML", "manheim_models": ["M-Class"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "ML-Class", "manheim_models": ["M-Class"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "S class", "manheim_models": ["S-Class"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "SL63", "manheim_models": ["SL-Class", "Mercedes-AMG SL"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "SL 63", "manheim_models": ["SL-Class", "Mercedes-AMG SL"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "SL 63 AMG", "manheim_models": ["SL-Class", "Mercedes-AMG SL"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "GLE 350", "manheim_models": ["GLE"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "Lexus", "client_model": "NX350", "manheim_models": ["NX"], "kind": "EQUIVALENT", "target_make": "Lexus"}, {"make": "Lexus", "client_model": "GX460", "manheim_models": ["GX"], "kind": "EQUIVALENT", "target_make": "Lexus"}, {"make": "Lexus", "client_model": "LX 470", "manheim_models": ["LX"], "kind": "EQUIVALENT", "target_make": "Lexus"}, {"make": "Mercedes-Benz", "client_model": "C300", "manheim_models": ["C-Class"], "kind": "EQUIVALENT", "target_make": "Mercedes-Benz"}, {"make": "McLaren", "client_model": "570S", "manheim_models": ["570"], "kind": "EQUIVALENT", "target_make": "McLaren"}, {"make": "Bentley", "client_model": "Flying spurs", "manheim_models": ["Flying Spur"], "kind": "EQUIVALENT", "target_make": "Bentley"}, {"make": "Rolls-Royce", "client_model": "Wrist", "manheim_models": ["Wraith"], "kind": "EQUIVALENT", "target_make": "Rolls-Royce"}, {"make": "Ford", "client_model": "F-350 Super Duty", "manheim_models": ["F-350"], "kind": "EQUIVALENT", "target_make": "Ford"}, {"make": "Ford", "client_model": "F-250 Super Duty", "manheim_models": ["F-250", "Super Duty F-250 SRW"], "kind": "EQUIVALENT", "target_make": "Ford"}, {"make": "Ram", "client_model": "1500/2500", "manheim_models": ["1500", "2500"], "kind": "EQUIVALENT", "target_make": "Ram"}, {"make": "Jaguar", "client_model": "Fpace", "manheim_models": ["F-Pace"], "kind": "EQUIVALENT", "target_make": "Jaguar"}, {"make": "Audi", "client_model": "RSQ8", "manheim_models": ["RS Q8"], "kind": "EQUIVALENT", "target_make": "Audi"}, {"make": "Toyota", "client_model": "CH-R", "manheim_models": ["C-HR"], "kind": "EQUIVALENT", "target_make": "Toyota"}, {"make": "Honda", "client_model": "CRV", "manheim_models": ["CR-V"], "kind": "EQUIVALENT", "target_make": "Honda"}, {"make": "Cadillac", "client_model": "Escalade Lyriq", "manheim_models": ["Escalade IQ", "Escalade IQL", "LYRIQ"], "kind": "EQUIVALENT", "target_make": "Cadillac"}, {"make": "Nissan", "client_model": "370Z", "manheim_models": ["370Z", "Z"], "kind": "EQUIVALENT", "target_make": "Nissan"}, {"make": "Ford", "client_model": "Mustang", "manheim_models": ["Mustang Mach-E"], "kind": "NEVER", "target_make": "Ford"}, {"make": "Ford", "client_model": "Mustang Mach-E", "manheim_models": ["Mustang"], "kind": "NEVER", "target_make": "Ford"}, {"make": "Land Rover", "client_model": "Range Rover", "manheim_models": ["Range Rover Sport", "Range Rover Velar", "Range Rover Evoque"], "kind": "NEVER", "target_make": "Land Rover"}, {"make": "Land Rover", "client_model": "Range Rover Sport", "manheim_models": ["Range Rover"], "kind": "NEVER", "target_make": "Land Rover"}, {"make": "Land Rover", "client_model": "Range Rover Velar", "manheim_models": ["Range Rover"], "kind": "NEVER", "target_make": "Land Rover"}, {"make": "Land Rover", "client_model": "Range Rover Evoque", "manheim_models": ["Range Rover"], "kind": "NEVER", "target_make": "Land Rover"}, {"make": "Toyota", "client_model": "Corolla", "manheim_models": ["Corolla Cross"], "kind": "NEVER", "target_make": "Toyota"}, {"make": "Toyota", "client_model": "Corolla Cross", "manheim_models": ["Corolla"], "kind": "NEVER", "target_make": "Toyota"}, {"make": "Audi", "client_model": "Q8", "manheim_models": ["Q8 e-tron"], "kind": "NEVER", "target_make": "Audi"}, {"make": "Audi", "client_model": "Q8 e-tron", "manheim_models": ["Q8"], "kind": "NEVER", "target_make": "Audi"}, {"make": "Audi", "client_model": "A6", "manheim_models": ["A6 e-tron"], "kind": "NEVER", "target_make": "Audi"}, {"make": "Audi", "client_model": "A6 e-tron", "manheim_models": ["A6"], "kind": "NEVER", "target_make": "Audi"}, {"make": "Mercedes-Benz", "client_model": "GLC", "manheim_models": ["GL-Class"], "kind": "NEVER", "target_make": "Mercedes-Benz"}, {"make": "Mercedes-Benz", "client_model": "GL-Class", "manheim_models": ["GLC"], "kind": "NEVER", "target_make": "Mercedes-Benz"}, {"make": "Chrysler", "client_model": "300", "manheim_models": ["300M"], "kind": "NEVER", "target_make": "Chrysler"}, {"make": "Chrysler", "client_model": "300M", "manheim_models": ["300"], "kind": "NEVER", "target_make": "Chrysler"}, {"make": "MINI", "client_model": "Cooper", "manheim_models": ["Countryman", "Clubman"], "kind": "NEVER", "target_make": "MINI"}, {"make": "MINI", "client_model": "Countryman", "manheim_models": ["Cooper"], "kind": "NEVER", "target_make": "MINI"}, {"make": "MINI", "client_model": "Clubman", "manheim_models": ["Cooper"], "kind": "NEVER", "target_make": "MINI"}, {"make": "Cadillac", "client_model": "Escalade", "manheim_models": ["Escalade EXT"], "kind": "NEVER", "target_make": "Cadillac"}, {"make": "Cadillac", "client_model": "Escalade EXT", "manheim_models": ["Escalade"], "kind": "NEVER", "target_make": "Cadillac"}, {"make": "Subaru", "client_model": "XV Crosstrek", "manheim_models": ["Crosstrek"], "kind": "EQUIVALENT", "target_make": "Subaru"}, {"make": "Subaru", "client_model": "Crosstrek", "manheim_models": ["XV Crosstrek"], "kind": "EQUIVALENT", "target_make": "Subaru"}, {"make": "Subaru", "client_model": "Impreza WRX", "manheim_models": ["WRX"], "kind": "EQUIVALENT", "target_make": "Subaru"}, {"make": "Subaru", "client_model": "WRX", "manheim_models": ["Impreza WRX"], "kind": "EQUIVALENT", "target_make": "Subaru"}]$aliases$::jsonb) as r(make text,client_model text,manheim_models text[],kind text,target_make text);
insert into public.manheim_known_models(make,model)
select distinct coalesce(vehicle_json->>'make',''),vehicle_json->>'model' from public.manheim_vehicles
where coalesce(vehicle_json->>'model','')<>'' on conflict do nothing;
-- Former engine-name aliases are data now, too; new unknown names go to manual service.
insert into public.model_aliases(make,client_model,manheim_models,kind,target_make)
select make,model,array[case when make='BMW' then substring(model from 1 for 1)||' Series'
 when make='Lexus' then upper(substring(model from '^([a-zA-Z]{2})')) end],'EQUIVALENT',make
from public.manheim_known_models where (make='BMW' and model~'^[1-8][0-9]{2}[a-zA-Z]*$') or (make='Lexus' and model~'^[a-zA-Z]{2}[0-9]{3}[a-zA-Z]*$') on conflict do nothing;
create function public.panel_remember_models() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.manheim_known_models(make,model)
 select distinct coalesce(vehicle_json->>'make',''),vehicle_json->>'model' from new_vehicles
 where coalesce(vehicle_json->>'model','')<>'' on conflict do nothing;
 return null;
end $$;
create trigger manheim_remember_models after insert on public.manheim_vehicles referencing new table as new_vehicles for each statement execute function public.panel_remember_models();
create function public.panel_model_dictionary() returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object('aliases',a.data,'known',coalesce((select jsonb_agg(k order by make,model) from public.manheim_known_models k),'[]'::jsonb),'revision',md5(a.data::text))
 from (select coalesce(jsonb_agg(jsonb_build_object('make',make,'client_model',client_model,'manheim_models',manheim_models,'kind',kind,'target_make',target_make) order by make,client_model,kind,target_make),'[]'::jsonb) data from public.model_aliases) a;
$$;
revoke all on function public.panel_remember_models(),public.panel_model_dictionary() from public,anon,authenticated;
grant execute on function public.panel_model_dictionary() to service_role;

alter table public.vehicle_request_versions add column edited_by uuid references public.panel_users(id);
create index vehicle_request_versions_editor_idx on public.vehicle_request_versions(edited_by) where edited_by is not null;
-- Optimistic version check + request row lock prevents one editor overwriting another.

create function public.panel_request_patch(p_old jsonb,p_patch jsonb) returns jsonb language plpgsql immutable security invoker set search_path='' as $$
declare v_criteria jsonb; v_key text;
begin
 if jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in ('make','model','yearMin','yearMax','minMiles','maxMiles','budgetUsd','acceptAnyTitleCondition')) then raise exception 'REQUEST_EDIT_INVALID'; end if;
 v_criteria=p_old||p_patch;
 foreach v_key in array array['yearMin','yearMax','minMiles','maxMiles','budgetUsd'] loop
   if v_criteria->v_key is not null and v_criteria->v_key<>'null'::jsonb and (jsonb_typeof(v_criteria->v_key)<>'number' or (v_criteria->>v_key)::numeric<0 or (v_criteria->>v_key)::numeric<>trunc((v_criteria->>v_key)::numeric)) then raise exception 'REQUEST_EDIT_INVALID'; end if;
 end loop;
 if (v_criteria->>'yearMin')::integer > (v_criteria->>'yearMax')::integer or (v_criteria->>'minMiles')::integer > (v_criteria->>'maxMiles')::integer then raise exception 'REQUEST_RANGE_INVERTED'; end if;
 if length(coalesce(v_criteria->>'model',''))>120 or length(coalesce(v_criteria->>'make',''))>80 then raise exception 'REQUEST_EDIT_INVALID'; end if;
 if v_criteria ? 'acceptAnyTitleCondition' and jsonb_typeof(v_criteria->'acceptAnyTitleCondition')<>'boolean' then raise exception 'REQUEST_EDIT_INVALID'; end if;
 if p_patch ? 'budgetUsd' then v_criteria=v_criteria||jsonb_build_object('budgetExplicit',true); end if;
 return v_criteria;
end $$;
revoke all on function public.panel_request_patch(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.panel_request_patch(jsonb,jsonb) to service_role;
create function public.panel_vehicle_request_edit(p_environment public.panel_environment,p_actor_id uuid,p_request_id uuid,p_expected_version uuid,p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_request public.vehicle_requests%rowtype; v_old public.vehicle_request_versions%rowtype; v_new uuid; v_criteria jsonb; v_key text;
begin
 if not exists(select 1 from public.panel_users where id=p_actor_id and environment=p_environment and active) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
 select * into strict v_request from public.vehicle_requests where id=p_request_id and environment=p_environment for update;
 select * into strict v_old from public.vehicle_request_versions where request_id=p_request_id and environment=p_environment order by created_at desc,id desc limit 1;
 if p_expected_version is not null and v_old.id<>p_expected_version then raise exception 'REQUEST_VERSION_CHANGED'; end if;
 v_criteria=public.panel_request_patch(v_old.criteria_json,p_patch);
 if v_criteria=v_old.criteria_json then return jsonb_build_object('id',v_old.id,'unchanged',true); end if;
 insert into public.vehicle_request_versions(environment,request_id,run_id,criteria_json,missing_fields,evidence_json,confidence,needs_review,review_reason,criteria_hash,edited_by)
 values(p_environment,p_request_id,v_old.run_id,v_criteria,v_old.missing_fields,v_old.evidence_json,v_old.confidence,v_old.needs_review,v_old.review_reason,md5(v_criteria::text),p_actor_id) returning id into v_new;
 update public.vehicle_requests set updated_at=now() where id=p_request_id;
 insert into public.audit_log(environment,actor_user_id,entity_type,entity_id,action,before_json,after_json)
 values(p_environment,p_actor_id,'vehicle_request',p_request_id,'EDIT',v_old.criteria_json,v_criteria);
 return jsonb_build_object('id',v_new,'requestId',p_request_id);
end $$;
revoke all on function public.panel_vehicle_request_edit(public.panel_environment,uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_vehicle_request_edit(public.panel_environment,uuid,uuid,uuid,jsonb) to service_role;

alter table public.manheim_upload_chunks drop constraint manheim_upload_chunks_file_index_check;
alter table public.manheim_upload_chunks add constraint manheim_upload_chunks_file_index_check check(file_index between 0 and 49);
-- Fallback candidates may be written from any block, but a strict option anywhere in the lot wins.
create function public.panel_manheim_resolve_fallback(p_environment public.panel_environment,p_upload_id uuid)
returns void language sql security invoker set search_path='' as $$
 update public.manheim_matches fallback set undone_at=now()
 where fallback.environment=p_environment and fallback.upload_id=p_upload_id and fallback.undone_at is null
 and fallback.vehicle_json->'parsed'->>'budgetFallback'='true'
 and exists(select 1 from public.manheim_matches strict where strict.environment=p_environment and strict.upload_id=p_upload_id and strict.demand_key=fallback.demand_key and strict.wish_index is not distinct from fallback.wish_index and strict.undone_at is null and coalesce(strict.vehicle_json->'parsed'->>'budgetFallback','false')<>'true');
$$;
revoke all on function public.panel_manheim_resolve_fallback(public.panel_environment,uuid) from public,anon,authenticated;
grant execute on function public.panel_manheim_resolve_fallback(public.panel_environment,uuid) to service_role;

create or replace function public.panel_manheim_manifest_valid(p_files jsonb, p_vehicle_count integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_vehicle_count between 0 and 250000 and jsonb_typeof(p_files) = 'array'
     and jsonb_array_length(p_files) between 1 and 50
     and not exists (
       select 1 from jsonb_array_elements(p_files) f
        where jsonb_typeof(f.value) <> 'object'
           or length(coalesce(f.value ->> 'name', '')) not between 1 and 200
           or coalesce(f.value ->> 'chunkCount', '') !~ '^[0-9]{1,4}$'
           or coalesce(f.value ->> 'vehicleCount', '') !~ '^[0-9]{1,6}$'
           or jsonb_typeof(f.value -> 'chunks') is distinct from 'array'
           or jsonb_array_length(f.value -> 'chunks') <> (f.value ->> 'chunkCount')::integer
           or exists (
             select 1 from jsonb_array_elements(f.value -> 'chunks') c
              where jsonb_typeof(c.value) <> 'object'
                 or coalesce(c.value ->> 'count', '') !~ '^[0-9]{1,3}$'
                 or (c.value ->> 'count')::integer not between 1 and 500
                 or coalesce(c.value ->> 'hash', '') !~ '^[0-9a-f]{64}$')
           or (select coalesce(sum((c.value ->> 'count')::integer), 0) from jsonb_array_elements(f.value -> 'chunks') c)
              <> (f.value ->> 'vehicleCount')::integer)
     and (select coalesce(sum((f.value ->> 'chunkCount')::integer), 0) from jsonb_array_elements(p_files) f) <= 2000
     and (select coalesce(sum((f.value ->> 'vehicleCount')::integer), 0) from jsonb_array_elements(p_files) f) = p_vehicle_count;
$$;

create or replace function public.panel_manheim_batch_start(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_client_key text,
  p_vehicle_count integer,
  p_headers jsonb,
  p_header_map jsonb,
  p_files jsonb,
  p_manifest_hash text,
  p_targets jsonb,
  p_targets_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_now timestamptz := now();
  v_reason text;
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  if p_client_key is null or p_client_key !~ '^[0-9a-f]{16,64}$'
     or p_vehicle_count is null or p_vehicle_count not between 0 and 250000
     or jsonb_typeof(p_headers) <> 'array'
     or jsonb_typeof(p_header_map) <> 'object'
     or coalesce(p_manifest_hash, '') !~ '^[0-9a-f]{64}$'
     or not public.panel_manheim_manifest_valid(p_files, p_vehicle_count)
     or jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) > 5000
     or octet_length(p_targets::text) > 4000000
     or coalesce(p_targets_hash, '') !~ '^[0-9a-f]{16,64}$'
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  -- Duas aberturas simultâneas da mesma seleção viram uma só montagem.
  perform pg_advisory_xact_lock(hashtextextended('manheim_batch_start:' || p_environment::text || ':' || p_actor_id::text || ':' || p_client_key, 0));

  -- Montagens esquecidas há mais de um dia saem do caminho (nada é apagado).
  update public.manheim_uploads u
     set canceled_at = v_now, undone_at = v_now, undone_by = p_actor_id,
         undo_summary = jsonb_build_object('canceled', true, 'reason', 'montagem abandonada')
   where u.environment = p_environment and u.activated_at is null and u.canceled_at is null
     and u.uploaded_at < v_now - interval '1 day';

  select * into v_upload
    from public.manheim_uploads u
   where u.environment = p_environment and u.created_by = p_actor_id and u.client_key = p_client_key
     and u.activated_at is null and u.canceled_at is null
   for update;

  if found then
    -- Retomada só com o mesmo manifesto e a mesma foto das demandas; nunca em silêncio.
    v_reason := case
      when v_upload.manifest_hash is distinct from p_manifest_hash or v_upload.files_json is distinct from p_files then 'MANIFEST'
      when v_upload.targets_hash is distinct from p_targets_hash then 'TARGETS'
      else null end;
    if v_reason is not null then
      return jsonb_build_object('uploadId', v_upload.id, 'mismatch', true, 'reason', v_reason,
        'received', (select count(*) from public.manheim_upload_chunks c where c.upload_id = v_upload.id));
    end if;
    return jsonb_build_object('uploadId', v_upload.id, 'resumed', true, 'targetsHash', v_upload.targets_hash,
      'received', coalesce((select jsonb_agg(jsonb_build_array(c.file_index, c.chunk_index) order by c.file_index, c.chunk_index)
                              from public.manheim_upload_chunks c where c.upload_id = v_upload.id), '[]'::jsonb));
  end if;

  insert into public.manheim_uploads(
    environment, source_file_count, vehicle_count, headers_json, header_map, uploaded_at, created_by,
    activated_at, client_key, files_json, manifest_hash, targets_json, targets_hash
  ) values (
    p_environment, jsonb_array_length(p_files), p_vehicle_count, p_headers, p_header_map, v_now, p_actor_id,
    null, p_client_key, p_files, p_manifest_hash, p_targets, p_targets_hash
  ) returning * into v_upload;

  return jsonb_build_object('uploadId', v_upload.id, 'resumed', false, 'targetsHash', v_upload.targets_hash, 'received', '[]'::jsonb);
end;
$$;

create or replace function public.panel_manheim_batch_chunk(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid,
  p_file_index integer,
  p_chunk_index integer,
  p_chunk_hash text,
  p_received_count integer,
  p_vehicles jsonb,
  p_matches jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_existing public.manheim_upload_chunks%rowtype;
  v_expected jsonb;
  v_vehicles integer := 0;
  v_matches integer := 0;
  v_valid integer := 0;
  v_requested integer := 0;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  -- A trava do lote: blocos, retomada e ativação do mesmo lote passam um de cada vez.
  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if coalesce(p_chunk_hash, '') !~ '^[0-9a-f]{64}$' then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;

  -- Bloco já gravado: mesmo conteúdo responde sem gravar nada; conteúdo diferente é recusado.
  select * into v_existing from public.manheim_upload_chunks c
   where c.upload_id = p_upload_id and c.file_index = p_file_index and c.chunk_index = p_chunk_index;
  if found then
    if v_existing.chunk_hash is distinct from p_chunk_hash then raise exception 'MANHEIM_CHUNK_CONFLICT'; end if;
    return jsonb_build_object('uploadId', p_upload_id, 'fileIndex', p_file_index, 'chunkIndex', p_chunk_index, 'duplicate', true,
      'storedVehicles', 0, 'storedMatches', 0, 'discarded', 0);
  end if;
  if v_upload.activated_at is not null then raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE'; end if;

  -- O bloco precisa existir no manifesto e ter exatamente o conteúdo declarado.
  v_expected := coalesce(v_upload.files_json, '[]'::jsonb) -> p_file_index -> 'chunks' -> p_chunk_index;
  if p_file_index is null or p_chunk_index is null or p_file_index < 0 or p_chunk_index < 0 or v_expected is null
     or jsonb_typeof(p_vehicles) <> 'array' or jsonb_array_length(p_vehicles) > 500
     or jsonb_typeof(p_matches) <> 'array' or jsonb_array_length(p_matches) > 20000
     or p_received_count is null or jsonb_array_length(p_vehicles) > p_received_count
  then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if v_expected ->> 'hash' <> p_chunk_hash or (v_expected ->> 'count')::integer <> p_received_count then
    raise exception 'MANHEIM_CHUNK_HASH_MISMATCH';
  end if;

  if exists (
    select 1 from jsonb_array_elements(p_vehicles) v
     where length(coalesce(v.value ->> 'fingerprint', '')) not between 3 and 200
        or jsonb_typeof(v.value -> 'vehicle') <> 'object'
        or octet_length((v.value -> 'vehicle')::text) > 16384
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  insert into public.manheim_vehicles(environment, upload_id, row_fingerprint, vehicle_json, uploaded_at, make_key, mmr_cents)
  select p_environment, p_upload_id, v.value ->> 'fingerprint', v.value -> 'vehicle', v_now,
         left(coalesce(v.value ->> 'makeKey', ''), 80),
         case when (v.value ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (v.value ->> 'mmrCents')::integer > 0 then (v.value ->> 'mmrCents')::integer else null end
    from jsonb_array_elements(p_vehicles) v
  on conflict (environment, upload_id, row_fingerprint) do nothing;
  get diagnostics v_vehicles = row_count;

  v_requested := jsonb_array_length(p_matches);

  if exists (
    select 1 from jsonb_array_elements(p_matches) m
     where coalesce(m.value ->> 'kind', '') not in ('BATE','POR_VALOR')
        or coalesce(m.value ->> 'mode', '') not in ('CARRO','VALOR')
        or (m.value ->> 'mode' = 'CARRO' and m.value ->> 'kind' <> 'BATE')
        or length(coalesce(m.value ->> 'fingerprint', '')) not between 3 and 200
        or jsonb_typeof(m.value -> 'vehicle') <> 'object'
        or octet_length((m.value -> 'vehicle')::text) > 16384
        or length(coalesce(m.value ->> 'demandKey', '')) not between 10 and 80
  ) then raise exception 'MANHEIM_MATCH_INVALID'; end if;

  with requested as (
    select m.value as item,
           nullif(m.value ->> 'journeyId', '') as journey_text,
           upper(nullif(m.value ->> 'calcRef', '')) as ref_text
      from jsonb_array_elements(p_matches) m
  ), typed as (
    select r.item,
           case when coalesce(r.item ->> 'targetType', '') = 'ORDER' then null
                when r.journey_text ~ '^[0-9a-fA-F-]{36}$' then r.journey_text::uuid else null end as journey_id,
           case when coalesce(r.item ->> 'targetType', '') = 'ORDER' and r.ref_text ~ '^[A-HJ-NP-Z2-9]{5}$' then r.ref_text else null end as calc_ref
      from requested r
  ), refs_ok as (
    select distinct t.calc_ref
      from typed t
     where t.calc_ref is not null
       and exists (select 1 from public.calc_runs cr where not cr.is_test and upper(coalesce(cr.dados ->> 'ref', '')) = t.calc_ref)
       and not exists (
         select 1 from public.panel_item_dispositions d
          where d.environment = p_environment and d.item_kind = 'REF' and upper(d.item_key) = t.calc_ref
            and d.status = 'DISCARDED' and d.cleared_at is null)
  ), valid as (
    select t.*
      from typed t
      left join public.journeys j on j.environment = p_environment and j.id = t.journey_id
      left join public.journey_toggle_states ts on ts.environment = j.environment and ts.journey_id = j.id
     where coalesce((t.item ->> 'mmrCents') ~ '^[0-9]{1,9}$' and (t.item ->> 'mmrCents')::integer > 0, false)
       and (t.item ->> 'fingerprint') in (select v.value ->> 'fingerprint' from jsonb_array_elements(p_vehicles) v)
       and (
         (t.calc_ref is not null and t.calc_ref in (select calc_ref from refs_ok))
         or (
           t.journey_id is not null and j.id is not null and j.status <> 'ENCERRADO'
           and (
             (coalesce(ts.enabled, true) and (j.status <> 'PARADO' or t.item ->> 'kind' = 'BATE'))
             or (not coalesce(ts.enabled, true) and coalesce(ts.off_reason, '') in ('GAVE_UP','NO_RESPONSE') and t.item ->> 'kind' = 'BATE')
           )
         )
       )
  ), inserted as (
    insert into public.manheim_matches(
      environment, upload_id, journey_id, calc_ref, match_kind, match_reason, mmr_status, row_fingerprint, vehicle_json,
      logical_mode, created_at, demand_key, sort_rank, sort_miles, vin, wish_index, mmr_cents, criteria_hash
    )
    select p_environment, p_upload_id, v.journey_id, v.calc_ref::char(5), v.item ->> 'kind', nullif(left(v.item ->> 'reason', 500), ''),
           case when v.item ->> 'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then v.item ->> 'mmrStatus' else null end,
           v.item ->> 'fingerprint', v.item -> 'vehicle', (v.item ->> 'mode')::public.panel_logical_mode, v_now,
           v.item ->> 'demandKey',
           case when (v.item ->> 'sortRank') ~ '^[0-9]{1,2}$' then (v.item ->> 'sortRank')::smallint else 9 end,
           case when (v.item ->> 'sortMiles') ~ '^[0-9]{1,10}$' and (v.item ->> 'sortMiles')::bigint <= 2147483647 then (v.item ->> 'sortMiles')::integer else 2147483647 end,
           nullif(left(upper(coalesce(v.item ->> 'vin', '')), 40), ''),
           case when (v.item ->> 'wishIndex') ~ '^[0-9]$' then (v.item ->> 'wishIndex')::smallint else null end,
           (v.item ->> 'mmrCents')::integer,
           nullif(left(coalesce(v.item ->> 'criteriaHash', ''), 64), '')
      from valid v
    on conflict do nothing
    returning 1
  )
  select (select count(*) from valid), (select count(*) from inserted) into v_valid, v_matches;

  -- Sem "on conflict": a trava do lote garante que este índice ainda não existe.
  insert into public.manheim_upload_chunks(environment, upload_id, file_index, chunk_index, vehicle_count, stored_vehicle_count,
    match_count, discarded_count, received_at, chunk_hash, ignored_count)
  values (p_environment, p_upload_id, p_file_index, p_chunk_index, p_received_count, v_vehicles,
    v_matches, v_requested - v_valid, v_now, p_chunk_hash, p_received_count - jsonb_array_length(p_vehicles));

  return jsonb_build_object('uploadId', p_upload_id, 'fileIndex', p_file_index, 'chunkIndex', p_chunk_index, 'duplicate', false,
    'storedVehicles', v_vehicles, 'storedMatches', v_matches, 'discarded', v_requested - v_valid);
end;
$$;

create or replace function public.panel_manheim_batch_finalize(
  p_environment public.panel_environment,
  p_actor_id uuid,
  p_upload_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_missing integer;
  v_problem text;
  v_stored integer;
  v_ignored integer;
  v_vehicle_count integer;
  v_match_count integer;
  v_lead_count integer;
  v_file_count integer;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id = p_actor_id and pu.environment = p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment
   for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if v_upload.activated_at is not null then
    return jsonb_build_object('uploadId', v_upload.id, 'complete', true, 'alreadyActive', true, 'vehicleCount', v_upload.vehicle_count,
      'matchedVehicleCount', v_upload.matched_vehicle_count, 'leadCount', v_upload.lead_count, 'fileCount', v_upload.source_file_count);
  end if;

  -- O manifesto do lote continua válido e soma o total declarado.
  if v_upload.manifest_hash is null or not public.panel_manheim_manifest_valid(v_upload.files_json, v_upload.vehicle_count) then
    raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR';
  end if;

  -- Blocos esperados pelo manifesto contra os blocos gravados.
  with expected as (
    select (f.ordinality - 1)::integer as file_index, (c.ordinality - 1)::integer as chunk_index,
           (c.value ->> 'count')::integer as count, c.value ->> 'hash' as hash
      from jsonb_array_elements(v_upload.files_json) with ordinality f
      cross join lateral jsonb_array_elements(f.value -> 'chunks') with ordinality c
  ), stored as (
    select * from public.manheim_upload_chunks c where c.upload_id = p_upload_id
  )
  select (select count(*) from expected e where not exists (select 1 from stored s where s.file_index = e.file_index and s.chunk_index = e.chunk_index)),
         case
           when exists (select 1 from stored s where not exists (select 1 from expected e where e.file_index = s.file_index and e.chunk_index = s.chunk_index)) then 'BLOCO_FORA_DO_MANIFESTO'
           when exists (select 1 from stored s join expected e using (file_index, chunk_index) where s.chunk_hash is distinct from e.hash) then 'HASH'
           when exists (select 1 from stored s join expected e using (file_index, chunk_index) where s.vehicle_count <> e.count) then 'QUANTIDADE_DO_BLOCO'
           when exists (select 1 from stored s where s.stored_vehicle_count <> s.vehicle_count - s.ignored_count) then 'CARROS_GRAVADOS_DO_BLOCO'
           else null end
    into v_missing, v_problem;
  if v_missing > 0 then raise exception 'MANHEIM_BATCH_INCOMPLETE'; end if;

  -- Quantidades por arquivo e do lote, pelos blocos gravados.
  if v_problem is null and exists (
    select 1 from jsonb_array_elements(v_upload.files_json) with ordinality f
     where (select coalesce(sum(c.vehicle_count), 0) from public.manheim_upload_chunks c
             where c.upload_id = p_upload_id and c.file_index = (f.ordinality - 1)::integer) <> (f.value ->> 'vehicleCount')::integer
  ) then v_problem := 'QUANTIDADE_DO_ARQUIVO'; end if;

  select coalesce(sum(c.stored_vehicle_count), 0), coalesce(sum(c.ignored_count), 0) into v_stored, v_ignored
    from public.manheim_upload_chunks c where c.upload_id = p_upload_id;
  select count(*) into v_vehicle_count from public.manheim_vehicles v
   where v.environment = p_environment and v.upload_id = p_upload_id;
  if v_problem is null and v_stored + v_ignored <> v_upload.vehicle_count then v_problem := 'QUANTIDADE_DO_LOTE'; end if;
  if v_problem is null and v_vehicle_count <> v_stored then v_problem := 'CARROS_UNICOS'; end if;
  if v_problem is not null then
    raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR' using detail = v_problem;
  end if;

  perform public.panel_manheim_resolve_fallback(p_environment,p_upload_id);

  select count(distinct m.row_fingerprint),
         count(distinct case when match_kind not in ('BATE','POR_VALOR') then null
                             when journey_id is not null then 'j:' || journey_id::text
                             else 'r:' || trim(calc_ref::text) end)
    into v_match_count, v_lead_count
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null;
  v_file_count := jsonb_array_length(v_upload.files_json);

  update public.manheim_uploads
     set activated_at = v_now, uploaded_at = v_now, vehicle_count = v_vehicle_count,
         matched_vehicle_count = v_match_count, lead_count = v_lead_count
   where id = p_upload_id and environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (p_environment, 'MANHEIM_UPLOAD_COMPLETED', 'Exportação do Manheim comparada',
    jsonb_build_object('upload_id', p_upload_id, 'vehicle_count', v_vehicle_count, 'matched_vehicle_count', v_match_count,
      'lead_count', v_lead_count, 'file_count', v_file_count, 'mode', 'lote_unico', 'manifest_hash', v_upload.manifest_hash), v_now, p_actor_id);

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', p_upload_id, 'CREATE',
    jsonb_build_object('vehicle_count', v_vehicle_count, 'matched_vehicle_count', v_match_count, 'lead_count', v_lead_count,
      'file_count', v_file_count, 'mode', 'lote_unico', 'manifest_hash', v_upload.manifest_hash, 'ignored_count', v_ignored), v_now);

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', p_upload_id, v_now);

  return jsonb_build_object('uploadId', p_upload_id, 'complete', true, 'alreadyActive', false, 'vehicleCount', v_vehicle_count,
    'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count, 'fileCount', v_file_count, 'ignored', v_ignored);
end;
$$;

create or replace function public.panel_manheim_batch_append_finalize(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_upload public.manheim_uploads%rowtype;
  v_target public.manheim_uploads%rowtype;
  v_missing integer;
  v_problem text;
  v_stored integer;
  v_ignored integer;
  v_staged integer;
  v_added integer;
  v_moved_matches integer;
  v_vehicle_count integer;
  v_match_count integer;
  v_lead_count integer;
  v_new_files integer;
  v_now timestamptz := now();
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_upload from public.manheim_uploads u
   where u.id = p_upload_id and u.environment = p_environment for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_upload.append_to is null then raise exception 'MANHEIM_UPLOAD_INVALID'; end if;
  if v_upload.merged_at is not null then
    select * into v_target from public.manheim_uploads u where u.id = v_upload.append_to;
    return jsonb_build_object('uploadId', v_upload.append_to, 'appended', true, 'alreadyMerged', true, 'vehicleCount', v_target.vehicle_count,
      'matchedVehicleCount', v_target.matched_vehicle_count, 'leadCount', v_target.lead_count, 'fileCount', v_target.source_file_count,
      'added', coalesce((v_upload.undo_summary ->> 'added')::integer, 0), 'alreadyInBatch', coalesce((v_upload.undo_summary ->> 'alreadyInBatch')::integer, 0));
  end if;
  if v_upload.canceled_at is not null or v_upload.undone_at is not null then raise exception 'MANHEIM_BATCH_CANCELED'; end if;
  if v_upload.activated_at is not null then raise exception 'MANHEIM_BATCH_ALREADY_ACTIVE'; end if;

  -- O alvo ainda é o lote ativo (trava para ninguém ativar ou desfazer no meio).
  select * into v_target from public.manheim_uploads u where u.id = v_upload.append_to and u.environment = p_environment for update;
  if not found or v_target.activated_at is null or v_target.undone_at is not null
     or v_target.id is distinct from public.panel_manheim_active_upload_id(p_environment) then raise exception 'MANHEIM_APPEND_TARGET_CHANGED'; end if;

  if v_upload.manifest_hash is null or not public.panel_manheim_manifest_valid(v_upload.files_json, v_upload.vehicle_count) then
    raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR';
  end if;
  with expected as (
    select (f.ordinality - 1)::integer as file_index, (c.ordinality - 1)::integer as chunk_index,
           (c.value ->> 'count')::integer as count, c.value ->> 'hash' as hash
      from jsonb_array_elements(v_upload.files_json) with ordinality f
      cross join lateral jsonb_array_elements(f.value -> 'chunks') with ordinality c
  ), stored as (
    select * from public.manheim_upload_chunks c where c.upload_id = p_upload_id
  )
  select (select count(*) from expected e where not exists (select 1 from stored s where s.file_index = e.file_index and s.chunk_index = e.chunk_index)),
         case
           when exists (select 1 from stored s where not exists (select 1 from expected e where e.file_index = s.file_index and e.chunk_index = s.chunk_index)) then 'BLOCO_FORA_DO_MANIFESTO'
           when exists (select 1 from stored s join expected e using (file_index, chunk_index) where s.chunk_hash is distinct from e.hash) then 'HASH'
           when exists (select 1 from stored s join expected e using (file_index, chunk_index) where s.vehicle_count <> e.count) then 'QUANTIDADE_DO_BLOCO'
           when exists (select 1 from stored s where s.stored_vehicle_count <> s.vehicle_count - s.ignored_count) then 'CARROS_GRAVADOS_DO_BLOCO'
           else null end
    into v_missing, v_problem;
  if v_missing > 0 then raise exception 'MANHEIM_BATCH_INCOMPLETE'; end if;
  if v_problem is null and exists (
    select 1 from jsonb_array_elements(v_upload.files_json) with ordinality f
     where (select coalesce(sum(c.vehicle_count), 0) from public.manheim_upload_chunks c
             where c.upload_id = p_upload_id and c.file_index = (f.ordinality - 1)::integer) <> (f.value ->> 'vehicleCount')::integer
  ) then v_problem := 'QUANTIDADE_DO_ARQUIVO'; end if;
  select coalesce(sum(c.stored_vehicle_count), 0), coalesce(sum(c.ignored_count), 0) into v_stored, v_ignored
    from public.manheim_upload_chunks c where c.upload_id = p_upload_id;
  select count(*) into v_staged from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = p_upload_id;
  if v_problem is null and v_stored + v_ignored <> v_upload.vehicle_count then v_problem := 'QUANTIDADE_DO_LOTE'; end if;
  if v_problem is null and v_staged <> v_stored then v_problem := 'CARROS_UNICOS'; end if;
  if v_problem is not null then raise exception 'MANHEIM_BATCH_INTEGRITY_ERROR' using detail = v_problem; end if;

  -- Só o que o lote ativo ainda não tem: primeiro as combinações, depois os carros (a mesma condição).
  update public.manheim_matches m set upload_id = v_target.id
   where m.environment = p_environment and m.upload_id = p_upload_id
     and not exists (select 1 from public.manheim_vehicles t where t.environment = p_environment and t.upload_id = v_target.id and t.row_fingerprint = m.row_fingerprint);
  get diagnostics v_moved_matches = row_count;
  update public.manheim_vehicles v set upload_id = v_target.id
   where v.environment = p_environment and v.upload_id = p_upload_id
     and not exists (select 1 from public.manheim_vehicles t where t.environment = p_environment and t.upload_id = v_target.id and t.row_fingerprint = v.row_fingerprint);
  get diagnostics v_added = row_count;

  select count(*) into v_vehicle_count from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = v_target.id;
  if v_vehicle_count>250000 or v_target.source_file_count+jsonb_array_length(v_upload.files_json)>50 then raise exception 'MANHEIM_BATCH_LIMIT'; end if;
  perform public.panel_manheim_resolve_fallback(p_environment,v_target.id);
  select count(distinct m.row_fingerprint),
         count(distinct case when match_kind not in ('BATE','POR_VALOR') then null
                             when journey_id is not null then 'j:' || journey_id::text
                             else 'r:' || trim(calc_ref::text) end)
    into v_match_count, v_lead_count
    from public.manheim_matches m
   where m.environment = p_environment and m.upload_id = v_target.id and m.undone_at is null;
  v_new_files := jsonb_array_length(v_upload.files_json);

  update public.manheim_uploads
     set vehicle_count = v_vehicle_count, matched_vehicle_count = v_match_count, lead_count = v_lead_count,
         source_file_count = source_file_count + v_new_files,
         appended_files_json = coalesce(appended_files_json, '[]'::jsonb) || coalesce((
           select jsonb_agg(jsonb_build_object('name', f.value ->> 'name', 'vehicleCount', (f.value ->> 'vehicleCount')::integer,
                                               'addedAt', v_now, 'appendUploadId', p_upload_id))
             from jsonb_array_elements(v_upload.files_json) f), '[]'::jsonb)
   where id = v_target.id and environment = p_environment;

  -- A montagem fica registrada como juntada (nunca aparece como lote).
  update public.manheim_uploads
     set merged_at = v_now, canceled_at = v_now, undone_at = v_now, undone_by = p_actor_id,
         undo_summary = jsonb_build_object('merged', true, 'mergedInto', v_target.id, 'added', v_added, 'alreadyInBatch', v_staged - v_added, 'matches', v_moved_matches)
   where id = p_upload_id and environment = p_environment;

  insert into public.activity_log(environment, activity_type, summary, metadata, occurred_at, actor_user_id)
  values (p_environment, 'MANHEIM_UPLOAD_APPENDED', 'Arquivos acrescentados ao lote ativo do Manheim',
    jsonb_build_object('upload_id', v_target.id, 'append_upload_id', p_upload_id, 'added', v_added, 'already_in_batch', v_staged - v_added,
      'matches', v_moved_matches, 'file_count', v_new_files, 'vehicle_count', v_vehicle_count), v_now, p_actor_id);
  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', v_target.id, 'APPEND',
    jsonb_build_object('vehicle_count', v_target.vehicle_count, 'file_count', v_target.source_file_count),
    jsonb_build_object('vehicle_count', v_vehicle_count, 'added', v_added, 'already_in_batch', v_staged - v_added, 'matches', v_moved_matches,
      'append_upload_id', p_upload_id, 'manifest_hash', v_upload.manifest_hash), v_now);
  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment, 'panel.updated', 'manheim_upload', v_target.id, v_now);

  return jsonb_build_object('uploadId', v_target.id, 'appended', true, 'alreadyMerged', false, 'added', v_added, 'alreadyInBatch', v_staged - v_added,
    'vehicleCount', v_vehicle_count, 'matchedVehicleCount', v_match_count, 'leadCount', v_lead_count,
    'fileCount', v_target.source_file_count + v_new_files, 'newFiles', v_new_files, 'ignored', v_ignored);
end;
$$;

create or replace function public.panel_manheim_offer_group(p_parsed jsonb) returns text language sql immutable as $$
 select case when coalesce(trim(p_parsed->>'lane'),'')<>'' and coalesce(trim(p_parsed->>'run'),'')<>'' then 'LANE'
 when regexp_replace(coalesce(p_parsed->>'buyNowPrice',''),'[$,\s]','','g')~'^\d+(\.\d+)?$' then case when regexp_replace(p_parsed->>'buyNowPrice','[$,\s]','','g')::numeric>0 then 'OFFLANE' else 'INCOMPLETE' end
 else 'INCOMPLETE' end;
$$;

create or replace function public.panel_manheim_offer_summary(p_environment public.panel_environment, p_upload_id uuid)
returns table(demand_key text, lane_count integer, offlane_count integer, incomplete_count integer, selected_count integer, selected_ids uuid[])
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with options as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as demand_key,
           public.panel_manheim_offer_group(merged.parsed) as grp
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

-- Versioned corrections to requests originating in the ficha/calculator, without changing calc_runs.
create table public.journey_request_versions (
 id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
 journey_id uuid not null references public.journeys(id), logical_mode text not null check(logical_mode in ('CARRO','VALOR')),
 before_json jsonb not null, after_json jsonb not null, edited_by uuid not null references public.panel_users(id), created_at timestamptz not null default now()
);
alter table public.journey_request_versions enable row level security;
revoke all on public.journey_request_versions from public,anon,authenticated;
grant select,insert on public.journey_request_versions to service_role;
create index journey_request_versions_journey_idx on public.journey_request_versions(environment,journey_id,created_at);
create index journey_request_versions_editor_idx on public.journey_request_versions(edited_by);
create function public.panel_journey_request_edit(p_environment public.panel_environment,p_actor_id uuid,p_journey_id uuid,p_mode text,p_expected_updated_at timestamptz,p_wishes jsonb,p_index integer,p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare j public.journeys%rowtype; c jsonb; w jsonb; v_id uuid;
begin
 if not exists(select 1 from public.panel_users where id=p_actor_id and environment=p_environment and active) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
 select * into strict j from public.journeys where id=p_journey_id and environment=p_environment for update;
 if j.updated_at is distinct from p_expected_updated_at then raise exception 'REQUEST_VERSION_CHANGED'; end if;
 if p_mode not in ('CARRO','VALOR') or jsonb_typeof(p_wishes)<>'array' or p_index<0 or p_index>=jsonb_array_length(p_wishes) then raise exception 'REQUEST_EDIT_INVALID'; end if;
 w=public.panel_request_patch(p_wishes->p_index,p_patch);
 p_wishes=jsonb_set(p_wishes,array[p_index::text],w);
 c=coalesce(j.criteria_json,'{}'::jsonb);
 c=c||jsonb_build_object('mode_overrides',coalesce(c->'mode_overrides','{}'::jsonb)||jsonb_build_object(p_mode,jsonb_build_object('wishlists',p_wishes,'wishlistOverride',true)));
 insert into public.journey_request_versions(environment,journey_id,logical_mode,before_json,after_json,edited_by)
 values(p_environment,p_journey_id,p_mode,j.criteria_json,c,p_actor_id) returning id into v_id;
 update public.journeys set criteria_json=c,updated_at=clock_timestamp(),updated_by=p_actor_id where id=j.id;
 insert into public.audit_log(environment,actor_user_id,entity_type,entity_id,action,before_json,after_json)
 values(p_environment,p_actor_id,'journey_request',j.id,'EDIT',j.criteria_json,c);
 return jsonb_build_object('id',v_id,'journeyId',j.id);
end $$;
revoke all on function public.panel_journey_request_edit(public.panel_environment,uuid,uuid,text,timestamptz,jsonb,integer,jsonb) from public,anon,authenticated;
grant execute on function public.panel_journey_request_edit(public.panel_environment,uuid,uuid,text,timestamptz,jsonb,integer,jsonb) to service_role;

-- Limits on stored uploads also apply after activation, not only to the manifest.
alter table public.manheim_uploads drop constraint manheim_uploads_source_file_count_check;
alter table public.manheim_uploads add constraint manheim_uploads_source_file_count_check check(source_file_count between 1 and 50);
alter table public.manheim_uploads drop constraint manheim_uploads_vehicle_count_check;
alter table public.manheim_uploads add constraint manheim_uploads_vehicle_count_check check(vehicle_count between 0 and 250000);
alter table public.manheim_upload_drafts drop constraint manheim_upload_drafts_source_file_count_check;
alter table public.manheim_upload_drafts add constraint manheim_upload_drafts_source_file_count_check check(source_file_count between 1 and 50);
alter table public.manheim_upload_drafts drop constraint manheim_upload_drafts_vehicle_count_check;
alter table public.manheim_upload_drafts add constraint manheim_upload_drafts_vehicle_count_check check(vehicle_count between 0 and 250000);
