-- The approved home counter counts simulation and vehicle-search events, including recalculations.
-- It is separate from calc_public_stats, which still counts distinct sessions for the old cover.
create or replace function public.calc_public_scenarios(p_days integer default 30)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 30), 1), 90),
    'scenarios', count(*)
  )
  from public.calc_runs c
  where not c.is_test
    and c.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
    and c.dados ->> 'evento' in ('simulacao', 'busca')
    and coalesce(c.origem, '') !~* '(vercel[.]app|test)'
$$;
revoke all on function public.calc_public_scenarios(integer) from public, anon, authenticated;
grant execute on function public.calc_public_scenarios(integer) to service_role;
