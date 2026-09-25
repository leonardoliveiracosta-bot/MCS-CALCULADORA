-- Phase 3 requires these four ownership/evidence relations for server-side
-- validation. Additive and idempotent; public.calc_runs is intentionally untouched.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.messages'::regclass
      and conname = 'messages_import_job_id_fkey'
  ) then
    alter table public.messages add constraint messages_import_job_id_fkey
      foreign key (import_job_id) references public.import_jobs(id) not valid;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.journeys'::regclass
      and conname = 'journeys_qualified_message_id_fkey'
  ) then
    alter table public.journeys add constraint journeys_qualified_message_id_fkey
      foreign key (qualified_message_id) references public.messages(id) not valid;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.journey_refs'::regclass
      and conname = 'journey_refs_source_message_id_fkey'
  ) then
    alter table public.journey_refs add constraint journey_refs_source_message_id_fkey
      foreign key (source_message_id) references public.messages(id) not valid;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.attachments'::regclass
      and conname = 'attachments_message_id_fkey'
  ) then
    alter table public.attachments add constraint attachments_message_id_fkey
      foreign key (message_id) references public.messages(id) not valid;
  end if;
end $$;

create index if not exists messages_import_job_id_idx
  on public.messages(import_job_id) where import_job_id is not null;
create index if not exists journeys_qualified_message_id_idx
  on public.journeys(qualified_message_id) where qualified_message_id is not null;
create index if not exists journey_refs_source_message_id_idx
  on public.journey_refs(source_message_id) where source_message_id is not null;
create index if not exists attachments_message_id_idx
  on public.attachments(message_id) where message_id is not null;
