-- Authorized one-time v3.2 corrections. Uses the same versioned edit RPC as the panel.
-- All prefixes must resolve exactly once before any correction is written.
begin;
do $$
declare actor uuid; item record; v_request_id uuid; latest_id uuid; found_count integer;
begin
 select id into strict actor from public.panel_users where environment='production' and active and role='admin';
 for item in select * from jsonb_each('{"fae789c1":{"budgetUsd":40000},"e25c6236":{"minMiles":5000,"maxMiles":10000},"4a94a5e7":{"model":"Cooper"},"1ee3ed86":{"budgetUsd":9000},"16c2a44c":{"budgetUsd":9000},"47aceab5":{"minMiles":10000,"maxMiles":40000},"6145de11":{"acceptAnyTitleCondition":true}}'::jsonb) loop
  select count(*) into found_count from public.vehicle_requests where environment='production' and id::text like item.key||'%';
  if found_count<>1 then raise exception 'REQUEST_PREFIX_NOT_UNIQUE: % (%)',item.key,found_count; end if;
 end loop;
 for item in select * from jsonb_each('{"fae789c1":{"budgetUsd":40000},"e25c6236":{"minMiles":5000,"maxMiles":10000},"4a94a5e7":{"model":"Cooper"},"1ee3ed86":{"budgetUsd":9000},"16c2a44c":{"budgetUsd":9000},"47aceab5":{"minMiles":10000,"maxMiles":40000},"6145de11":{"acceptAnyTitleCondition":true}}'::jsonb) loop
  select id into strict v_request_id from public.vehicle_requests where environment='production' and id::text like item.key||'%';
  select id into strict latest_id from public.vehicle_request_versions where vehicle_request_versions.request_id=v_request_id order by created_at desc,id desc limit 1;
  perform public.panel_vehicle_request_edit('production',actor,v_request_id,latest_id,item.value);
 end loop;
end $$;
commit;
