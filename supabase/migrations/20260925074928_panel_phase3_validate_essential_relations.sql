-- Validate the four Phase 3 relations after their idempotent creation.
alter table public.messages
  validate constraint messages_import_job_id_fkey;
alter table public.journeys
  validate constraint journeys_qualified_message_id_fkey;
alter table public.journey_refs
  validate constraint journey_refs_source_message_id_fkey;
alter table public.attachments
  validate constraint attachments_message_id_fkey;
