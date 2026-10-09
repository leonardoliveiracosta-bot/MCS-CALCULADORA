-- Batch only the existing guarded transports, never panel business rules.
create or replace function public.panel_boot_history_batch(
  p_environment public.panel_environment, p_requests jsonb
) returns jsonb
language plpgsql stable security invoker set search_path = ''
as $$
declare
  request jsonb;
  columns text[];
  result jsonb := '[]'::jsonb;
  data jsonb;
  failure_state text;
begin
  if p_environment is null or p_requests is null or pg_catalog.jsonb_typeof(p_requests) <> 'array' then
    raise exception 'INVALID_HISTORY_BATCH';
  end if;
  if pg_catalog.jsonb_array_length(p_requests) > 16 then raise exception 'INVALID_HISTORY_BATCH'; end if;
  for request in select value from pg_catalog.jsonb_array_elements(p_requests) loop
    begin
      select pg_catalog.array_agg(value order by n) into columns
        from pg_catalog.jsonb_array_elements_text(request->'columns') with ordinality as c(value,n);
      data := public.panel_boot_table_rows(p_environment,request->>'table',columns);
      result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('data',data));
    exception when others then
      -- Never expose SQL text, arguments or row data. Preserve per-source failure.
      get stacked diagnostics failure_state = returned_sqlstate;
      result := result || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'error',failure_state,'status',case when failure_state='42501' then 403
          when left(failure_state,2) in ('22','42') or failure_state='P0001' then 400 else 500 end));
    end;
  end loop;
  return result;
end;
$$;
revoke all on function public.panel_boot_history_batch(public.panel_environment,jsonb) from public, anon, authenticated;
grant execute on function public.panel_boot_history_batch(public.panel_environment,jsonb) to service_role;
