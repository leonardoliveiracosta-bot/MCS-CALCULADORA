-- Explicit Data API privileges for databases rebuilt without automatic grants.
-- Existing production tables already have these privileges: do not apply there
-- as an emergency fix. No browser grants, RLS policies or defaults are changed.

-- The server also uses PostgREST (service_role). BYPASSRLS does not grant table
-- privileges. Keep these explicit for fresh databases without automatic grants.
-- Existing browser SELECT grants and all RLS policies remain unchanged.
grant select on table
  public.panel_users, public.contacts, public.contact_phones, public.chats,
  public.chat_aliases, public.journeys, public.journey_refs, public.messages,
  public.message_journeys, public.journey_checklist, public.checklist_evidence,
  public.journey_declarations, public.journey_divergences, public.promises,
  public.units, public.interactions, public.journey_alert_suppressions,
  public.activity_log, public.audit_log, public.import_jobs,
  public.calculator_request_links, public.attachments, public.panel_notifications
to service_role;

-- Direct server inserts, including return=representation and alias upserts.
grant insert on table
  public.contacts, public.contact_phones, public.chats, public.chat_aliases,
  public.journeys, public.journey_refs, public.messages, public.message_journeys,
  public.journey_checklist, public.journey_declarations, public.journey_divergences,
  public.promises, public.units, public.interactions, public.activity_log,
  public.audit_log, public.import_jobs, public.calculator_request_links,
  public.panel_notifications
to service_role;

grant update on table
  public.panel_users, public.contacts, public.chats, public.chat_aliases,
  public.journeys, public.messages, public.message_journeys,
  public.journey_checklist, public.journey_divergences, public.promises,
  public.units, public.journey_alert_suppressions, public.import_jobs,
  public.calculator_request_links
to service_role;

-- entry.rollbackStart removes only this attempt's newly created records;
-- actions.presentUndo removes an unanswered unit after checking its author.
grant delete on table
  public.contacts, public.contact_phones, public.chats, public.chat_aliases,
  public.units
to service_role;

-- calc_runs is a pre-existing bootstrap prerequisite, read by the panel and
-- SECURITY INVOKER RPCs. Keep its browser INSERT grant and policies in its bootstrap.
grant select on table public.calc_runs to service_role;
