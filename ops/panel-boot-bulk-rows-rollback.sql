-- Deploy the prior panel-server/boot code first. Removing this additive RPC also
-- makes the new boot fall back to its existing keyset reads. No source data changes.
drop function if exists public.panel_boot_table_rows(public.panel_environment, text, text[]);
