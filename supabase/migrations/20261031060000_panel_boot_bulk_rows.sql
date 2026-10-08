-- Transport only: no panel classification, grouping, count, date masking or write.
-- A scalar JSON array avoids PostgREST's row cap for the two boot histories.
create or replace function public.panel_boot_table_rows(
  p_environment public.panel_environment,
  p_table text,
  p_columns text[]
) returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  relation oid;
  projection text;
  result jsonb;
begin
  if p_table is null or p_table not in ('messages', 'calc_runs') then
    raise exception 'INVALID_BOOT_TABLE';
  end if;
  if p_environment is null or coalesce(cardinality(p_columns), 0) = 0 then
    raise exception 'INVALID_BOOT_COLUMNS';
  end if;
  relation := pg_catalog.to_regclass('public.' || p_table);
  if exists (
    select 1 from pg_catalog.unnest(p_columns) as c(name)
    where name is null or name !~ '^[a-z_][a-z0-9_]*$'
      or not exists (select 1 from pg_catalog.pg_attribute a
        where a.attrelid = relation and a.attname = c.name and a.attnum > 0 and not a.attisdropped)
  ) then
    raise exception 'INVALID_BOOT_COLUMNS';
  end if;
  select pg_catalog.string_agg(pg_catalog.format('%I', name), ', ' order by n)
    into projection from pg_catalog.unnest(p_columns) with ordinality as c(name, n);
  -- calc_runs has no environment scope in the existing allRows read. Its callers
  -- continue to apply the existing is_test/business rules after receiving it.
  execute pg_catalog.format(
    'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select %s from public.%I%s order by id) t',
    projection, p_table, case when p_table = 'messages' then ' where environment = $1' else '' end
  ) into result using p_environment;
  return result;
end;
$$;
revoke all on function public.panel_boot_table_rows(public.panel_environment, text, text[]) from public, anon, authenticated;
grant execute on function public.panel_boot_table_rows(public.panel_environment, text, text[]) to service_role;
comment on function public.panel_boot_table_rows(public.panel_environment, text, text[]) is
  'Service-only boot history transport; original rules and unknown-SMS date masking stay in panel-server.';
