-- Internal SECURITY DEFINER functions are server-only. Trigger execution does
-- not require direct RPC access, and panel recalculation runs with service_role.
revoke execute on function public.panel_message_automatic_before_insert() from public, anon, authenticated;
revoke execute on function public.panel_refresh_effective_mcs(public.panel_environment, uuid) from public, anon, authenticated;

grant execute on function public.panel_message_automatic_before_insert() to service_role;
grant execute on function public.panel_refresh_effective_mcs(public.panel_environment, uuid) to service_role;
