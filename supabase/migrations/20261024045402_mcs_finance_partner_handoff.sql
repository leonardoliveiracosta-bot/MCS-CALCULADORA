-- Record the first departure from MCS, not completion of the external credit application.
create function public.mcs_finance_partner_handoff(
 p_environment public.panel_environment,p_request_key uuid,p_method text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare handoff jsonb;
begin
 if p_environment is null or p_request_key is null or p_method is null
 or p_method not in ('manual','automatic') then raise exception 'FINANCE_INVALID';end if;
 update public.calc_runs r set dados=jsonb_set(r.dados,'{partner_handoff}',
  coalesce(r.dados->'partner_handoff',jsonb_build_object('at',clock_timestamp(),'method',p_method)))
 where r.id=p_request_key and r.is_test=(p_environment<>'production') and r.dados->>'tipo'='finance'
 and exists(select 1 from public.site_contact_requests c where c.request_key=r.id
  and c.environment=p_environment and c.source='finance' and c.consent_version='finance-contact-v1')
 returning r.dados->'partner_handoff' into handoff;
 if handoff is null then raise exception 'FINANCE_NOT_FOUND';end if;
 return handoff;
end;$$;
revoke all on function public.mcs_finance_partner_handoff(public.panel_environment,uuid,text) from public,anon,authenticated;
grant execute on function public.mcs_finance_partner_handoff(public.panel_environment,uuid,text) to service_role;
