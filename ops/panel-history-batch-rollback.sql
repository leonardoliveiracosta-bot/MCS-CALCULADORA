-- New boot callers fall back to the existing single-source transports on 404.
-- This drops only the transport function and changes no source data.
drop function if exists public.panel_boot_history_batch(public.panel_environment,jsonb);
