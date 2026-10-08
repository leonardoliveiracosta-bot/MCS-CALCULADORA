-- Activation after exact production parity; live dates and version guards stay in the candidate reader.
create or replace function public.panel_manheim_score_mmr(p_environment public.panel_environment,p_since timestamptz)
returns table(person text,mmr_cents bigint,sample integer)
language sql stable security invoker set search_path='' set work_mem='32MB' as $$
 select * from panel_internal.manheim_score_mmr_candidates(p_environment,p_since);
$$;
revoke all on function public.panel_manheim_score_mmr(public.panel_environment,timestamptz) from public,anon,authenticated;
grant execute on function public.panel_manheim_score_mmr(public.panel_environment,timestamptz) to service_role;
