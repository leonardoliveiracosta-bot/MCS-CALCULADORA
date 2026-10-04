-- Explicit built-in function lookup for the v3.2 sale classifier.
alter function public.panel_manheim_offer_group(jsonb) set search_path = '';
