-- Withdraw the experimental read transport. No saved rows are changed.
drop function if exists public.panel_boot_read_bundle(public.panel_environment, text);
