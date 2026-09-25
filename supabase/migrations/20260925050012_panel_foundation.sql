-- My Car Scout panel foundation. Additive only; no calc_runs changes.
create extension if not exists pgcrypto;
create schema if not exists private;

do $$ begin
  create type public.panel_environment as enum ('preview', 'production');
exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_role as enum ('admin', 'operator'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_channel as enum ('WHATSAPP', 'SMS'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_message_direction as enum ('CUSTOMER', 'MCS', 'SYSTEM'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_chat_resolution as enum ('UNIDENTIFIED', 'REVIEW', 'RESOLVED', 'GROUP'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_journey_stage as enum ('NOVO', 'RESPONDIDO', 'EM_BUSCA', 'DECIDINDO', 'QUALIFICADO'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_journey_status as enum ('ATIVO', 'AGUARDANDO_CLIENTE', 'PARADO', 'ENCERRADO'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_journey_source as enum ('CALCULATOR', 'WHATSAPP_DIRECT', 'SMS_DIRECT', 'MANUAL'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_logical_mode as enum ('CARRO', 'VALOR'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_checklist_status as enum ('OPEN', 'COMPLETE', 'NOT_APPLICABLE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_declaration_field as enum ('TETO', 'VEICULO', 'PRAZO'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_declaration_source as enum ('CONVERSATION', 'CALCULATOR', 'OTHER'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_divergence_status as enum ('OPEN', 'RESOLVED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_promise_status as enum ('OPEN', 'FULFILLED', 'CANCELLED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_unit_status as enum ('PRESENTED', 'UNDER_REVIEW', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_interaction_type as enum ('OUTBOUND_MESSAGE', 'INBOUND_MESSAGE', 'CALL_ANSWERED', 'CALL_ATTEMPT', 'IN_PERSON', 'NEXT_ACTION_CREATED', 'NEXT_ACTION_COMPLETED', 'NEXT_ACTION_REMOVED', 'SEARCH_STARTED', 'JOURNEY_CLOSED', 'JOURNEY_QUALIFIED', 'NOTE'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_import_status as enum ('PENDING', 'PROCESSING', 'COMPLETED', 'REVIEW', 'FAILED', 'REJECTED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.panel_attachment_kind as enum ('IMAGE', 'TXT'); exception when duplicate_object then null; end $$;

create table if not exists public.panel_users (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  auth_user_id uuid not null, email text not null, role public.panel_role not null default 'operator',
  active boolean not null default true, must_change_password boolean not null default false,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid null, unique(environment, auth_user_id)
);
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.panel_users'::regclass and conname = 'panel_users_created_by_fkey'
  ) then
    alter table public.panel_users add constraint panel_users_created_by_fkey
      foreign key (created_by) references public.panel_users(id) not valid;
  end if;
end $$;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  display_name text, source public.panel_journey_source, location_text text, profile_text text, notes text,
  created_at timestamptz not null, updated_at timestamptz not null, created_by uuid, updated_by uuid,
  foreign key (created_by) references public.panel_users(id), foreign key (updated_by) references public.panel_users(id)
);
create table if not exists public.contact_phones (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  contact_id uuid not null references public.contacts(id), phone_e164 text, phone_raw text not null,
  is_current boolean not null default true, confirmed_at timestamptz, retired_at timestamptz,
  created_at timestamptz not null, created_by uuid references public.panel_users(id)
);
create table if not exists public.chats (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  channel public.panel_channel not null, contact_id uuid references public.contacts(id), canonical_key text not null,
  resolution_status public.panel_chat_resolution not null default 'UNIDENTIFIED', is_group boolean not null default false,
  first_seen_at timestamptz, last_seen_at timestamptz, created_at timestamptz not null, updated_at timestamptz not null,
  unique(environment, channel, canonical_key),
  check ((contact_id is not null) or (resolution_status in ('UNIDENTIFIED','REVIEW','GROUP')))
);
create table if not exists public.chat_aliases (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id), alias_text text not null, alias_normalized text not null,
  first_seen_at timestamptz not null, last_seen_at timestamptz not null, confirmed_at timestamptz,
  confirmed_by uuid references public.panel_users(id), created_at timestamptz not null,
  unique(environment, chat_id, alias_normalized)
);
create table if not exists public.journeys (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  contact_id uuid not null references public.contacts(id), source public.panel_journey_source not null,
  stage public.panel_journey_stage not null default 'NOVO', status public.panel_journey_status not null default 'ATIVO',
  vehicle_text text, criteria_json jsonb not null default '{}', budget_cents bigint, payment_text text,
  customer_deadline_at timestamptz, customer_deadline_text text, next_action_text text, next_action_at timestamptz,
  next_action_missing_since timestamptz, last_effective_contact_at timestamptz, search_started_at timestamptz,
  qualified_at timestamptz, qualified_message_id uuid, closed_at timestamptz, closed_reason text,
  stage_frozen boolean not null default false, created_at timestamptz not null, updated_at timestamptz not null,
  created_by uuid references public.panel_users(id), updated_by uuid references public.panel_users(id),
  check ((status <> 'ENCERRADO') or closed_at is not null),
  check ((status <> 'ENCERRADO') or closed_reason is not null),
  check ((stage = 'QUALIFICADO') = (qualified_at is not null))
);
create table if not exists public.journey_refs (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), ref_code char(5) not null, source_message_id uuid,
  calculator_sid text, created_at timestamptz not null, created_by uuid references public.panel_users(id),
  unique(environment, journey_id, ref_code, calculator_sid)
);
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id), channel public.panel_channel not null,
  direction public.panel_message_direction not null, body_text text not null, body_normalized text not null,
  occurred_at_local timestamp, timezone_assumed text, occurred_at_utc timestamptz, time_uncertain boolean not null default false,
  original_datetime_text text, original_order integer, signature_base text not null, occurrence_index integer not null,
  import_job_id uuid, source_kind text not null default 'IMPORT', is_edit_marker boolean not null default false,
  is_delete_marker boolean not null default false, created_at timestamptz not null,
  unique(environment, signature_base, occurrence_index),
  check ((occurred_at_utc is not null) or time_uncertain or occurred_at_local is not null)
);
create table if not exists public.message_journeys (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  message_id uuid not null references public.messages(id), journey_id uuid not null references public.journeys(id),
  association_source text not null, associated_at timestamptz not null, associated_by uuid references public.panel_users(id),
  unique(environment, message_id, journey_id)
);
create table if not exists public.journey_checklist (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), point_number smallint not null check (point_number between 1 and 6),
  point_label text not null, status public.panel_checklist_status not null default 'OPEN', completed_at timestamptz,
  created_at timestamptz not null, updated_at timestamptz not null, unique(environment, journey_id, point_number)
);
create table if not exists public.checklist_evidence (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  checklist_id uuid not null references public.journey_checklist(id), message_id uuid not null references public.messages(id),
  excerpt_text text not null, created_at timestamptz not null, created_by uuid not null references public.panel_users(id),
  unique(environment, checklist_id, message_id)
);
create table if not exists public.journey_declarations (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), field public.panel_declaration_field not null,
  source public.panel_declaration_source not null, value_text text not null, value_json jsonb not null default '{}',
  message_id uuid references public.messages(id), calc_sid text, calc_ref char(5), declared_at timestamptz not null,
  created_at timestamptz not null, created_by uuid references public.panel_users(id)
);
create table if not exists public.journey_divergences (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), field public.panel_declaration_field not null,
  left_declaration_id uuid not null references public.journey_declarations(id), right_declaration_id uuid not null references public.journey_declarations(id),
  operational_declaration_id uuid references public.journey_declarations(id), status public.panel_divergence_status not null default 'OPEN',
  resolved_at timestamptz, resolved_by uuid references public.panel_users(id), created_at timestamptz not null,
  unique(environment, journey_id, field, left_declaration_id, right_declaration_id)
);
create table if not exists public.promises (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), message_id uuid not null references public.messages(id),
  promise_text text not null, due_at timestamptz not null, due_text text not null,
  status public.panel_promise_status not null default 'OPEN', fulfilled_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid not null references public.panel_users(id), unique(environment, message_id)
);
create table if not exists public.units (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), vehicle_text text not null, details_json jsonb not null default '{}',
  presented_at timestamptz not null, last_customer_response_at timestamptz, status public.panel_unit_status not null default 'PRESENTED',
  decline_reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  created_by uuid references public.panel_users(id), updated_by uuid references public.panel_users(id)
);
create table if not exists public.interactions (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), message_id uuid references public.messages(id),
  type public.panel_interaction_type not null, occurred_at timestamptz not null, detail_text text, next_action_at timestamptz,
  created_at timestamptz not null default now(), created_by uuid references public.panel_users(id)
);
create table if not exists public.journey_alert_suppressions (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id), kind text not null, action text not null check (action in ('DEFER','DISMISS')),
  until_at timestamptz, reason_text text, created_at timestamptz not null default now(),
  created_by uuid not null references public.panel_users(id), cancelled_at timestamptz, cancelled_by uuid references public.panel_users(id)
);
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  journey_id uuid references public.journeys(id), contact_id uuid references public.contacts(id), chat_id uuid references public.chats(id),
  activity_type text not null, summary text not null, metadata jsonb not null default '{}', occurred_at timestamptz not null,
  actor_user_id uuid references public.panel_users(id)
);
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  actor_user_id uuid references public.panel_users(id), entity_type text not null, entity_id uuid, action text not null,
  before_json jsonb, after_json jsonb, created_at timestamptz not null default now()
);
create table if not exists public.import_jobs (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null, channel public.panel_channel not null,
  source_kind text not null check (source_kind in ('WHATSAPP_ZIP','WHATSAPP_TXT','SMS_PASTE')), source_filename text, source_sha256 text,
  status public.panel_import_status not null default 'PENDING', selected_file_count integer not null default 1,
  message_count integer not null default 0, review_reason text, created_at timestamptz not null default now(), completed_at timestamptz,
  created_by uuid not null references public.panel_users(id)
);
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  import_job_id uuid not null references public.import_jobs(id), batch_number integer not null, payload_sha256 text not null,
  message_count integer not null, status public.panel_import_status not null default 'PENDING', received_at timestamptz,
  completed_at timestamptz, error_text text, unique(environment, import_job_id, batch_number)
);
create table if not exists public.calculator_request_links (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null, calc_sid text not null,
  calc_ref char(5) not null, logical_mode public.panel_logical_mode not null, contact_id uuid references public.contacts(id),
  journey_id uuid references public.journeys(id), linked_at timestamptz not null, linked_by uuid not null references public.panel_users(id),
  unique(environment, calc_sid, calc_ref, logical_mode)
);
create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  contact_id uuid references public.contacts(id), chat_id uuid references public.chats(id), journey_id uuid references public.journeys(id),
  message_id uuid, kind public.panel_attachment_kind not null, bucket_name text not null, storage_path text not null,
  original_filename text not null, mime_type text not null, byte_size bigint not null, sha256 text not null,
  verified_at timestamptz, rejected_at timestamptz, created_at timestamptz not null, created_by uuid not null references public.panel_users(id),
  unique(environment, storage_path)
);
create table if not exists public.panel_notifications (
  id bigint generated always as identity primary key, environment public.panel_environment not null, topic text not null,
  entity_type text, entity_id uuid, created_at timestamptz not null default now()
);

create or replace function private.set_updated_at()
returns trigger language plpgsql set search_path = public, pg_temp as $$ begin new.updated_at = now(); return new; end; $$;

create or replace function private.panel_authorized(requested_environment public.panel_environment)
returns boolean language sql stable security definer set search_path = public, auth, pg_temp as $$
  select auth.uid() is not null
    and (auth.jwt() ->> 'panel_environment') = requested_environment::text
    and exists (
      select 1 from public.panel_users pu
      where pu.auth_user_id = auth.uid() and pu.environment = requested_environment and pu.active
    );
$$;
revoke all on function private.panel_authorized(public.panel_environment) from public;
grant execute on function private.panel_authorized(public.panel_environment) to authenticated;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create index if not exists panel_users_environment_auth_user_active_idx on public.panel_users(environment, auth_user_id) where active;
create unique index if not exists panel_users_environment_lower_email_uniq on public.panel_users(environment, lower(email));
create index if not exists contacts_environment_lower_display_name_idx on public.contacts(environment, lower(display_name));
create index if not exists contact_phones_environment_phone_e164_idx on public.contact_phones(environment, phone_e164);
create index if not exists chats_environment_contact_last_seen_idx on public.chats(environment, contact_id, last_seen_at desc);
create index if not exists chat_aliases_environment_alias_normalized_idx on public.chat_aliases(environment, alias_normalized);
create index if not exists journeys_environment_contact_status_updated_idx on public.journeys(environment, contact_id, status, updated_at desc);
create index if not exists journeys_environment_status_stage_next_action_idx on public.journeys(environment, status, stage, next_action_at);
create index if not exists journeys_environment_deadline_idx on public.journeys(environment, customer_deadline_at);
create index if not exists journeys_environment_search_started_idx on public.journeys(environment, search_started_at) where search_started_at is not null;
create index if not exists journey_refs_environment_ref_idx on public.journey_refs(environment, ref_code);
create index if not exists messages_environment_chat_utc_order_idx on public.messages(environment, chat_id, occurred_at_utc, original_order);
create index if not exists messages_environment_chat_local_order_idx on public.messages(environment, chat_id, occurred_at_local, original_order);
create index if not exists messages_environment_import_job_idx on public.messages(environment, import_job_id);
create index if not exists message_journeys_environment_journey_message_idx on public.message_journeys(environment, journey_id, message_id);
create index if not exists journey_checklist_environment_journey_point_idx on public.journey_checklist(environment, journey_id, point_number);
create index if not exists checklist_evidence_environment_checklist_idx on public.checklist_evidence(environment, checklist_id);
create index if not exists journey_declarations_environment_journey_field_declared_idx on public.journey_declarations(environment, journey_id, field, declared_at desc);
create index if not exists journey_divergences_environment_journey_status_field_idx on public.journey_divergences(environment, journey_id, status, field);
create index if not exists promises_environment_journey_status_due_idx on public.promises(environment, journey_id, status, due_at);
create index if not exists units_environment_journey_status_presented_idx on public.units(environment, journey_id, status, presented_at);
create index if not exists interactions_environment_journey_occurred_idx on public.interactions(environment, journey_id, occurred_at desc);
create index if not exists journey_alert_suppressions_environment_journey_kind_cancelled_idx on public.journey_alert_suppressions(environment, journey_id, kind, cancelled_at);
create index if not exists activity_log_environment_journey_occurred_idx on public.activity_log(environment, journey_id, occurred_at desc);
create index if not exists audit_log_environment_entity_created_idx on public.audit_log(environment, entity_type, entity_id, created_at desc);
create index if not exists import_jobs_environment_status_created_idx on public.import_jobs(environment, status, created_at desc);
create index if not exists import_batches_environment_job_batch_idx on public.import_batches(environment, import_job_id, batch_number);
create index if not exists calculator_request_links_environment_sid_ref_mode_idx on public.calculator_request_links(environment, calc_sid, calc_ref, logical_mode);
create index if not exists attachments_environment_journey_created_idx on public.attachments(environment, journey_id, created_at desc);
create index if not exists panel_notifications_environment_created_idx on public.panel_notifications(environment, created_at desc);

do $$
declare t text;
begin
  foreach t in array array['panel_users','contacts','contact_phones','chats','chat_aliases','journeys','journey_refs','messages','message_journeys','journey_checklist','checklist_evidence','journey_declarations','journey_divergences','promises','units','interactions','journey_alert_suppressions','activity_log','audit_log','import_jobs','import_batches','calculator_request_links','attachments','panel_notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('grant select on table public.%I to authenticated', t);
  end loop;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'panel_users' and policyname = 'panel_panel_users_select_authorized'
  ) then
    create policy panel_panel_users_select_authorized on public.panel_users for select to authenticated
      using (auth_user_id = (select auth.uid()) and active and (auth.jwt() ->> 'panel_environment') = environment::text);
  end if;
end $$;
do $$
declare t text;
begin
  foreach t in array array['contacts','contact_phones','chats','chat_aliases','journeys','journey_refs','messages','message_journeys','journey_checklist','checklist_evidence','journey_declarations','journey_divergences','promises','units','interactions','journey_alert_suppressions','activity_log','audit_log','import_jobs','import_batches','calculator_request_links','attachments','panel_notifications'] loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'panel_' || t || '_select_authorized'
    ) then
      execute format('create policy %I on public.%I for select to authenticated using ((select private.panel_authorized(environment)))', 'panel_' || t || '_select_authorized', t);
    end if;
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['panel_users','contacts','chats','journeys','journey_checklist','units'] loop
    if not exists (
      select 1 from pg_trigger
      where tgrelid = ('public.' || t)::regclass
        and tgname = 'panel_' || t || '_set_updated_at'
        and not tgisinternal
    ) then
      execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', 'panel_' || t || '_set_updated_at', t);
    end if;
  end loop;
end $$;

-- Private bucket. Browser access uses signed URLs created by server APIs only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mcs-panel-attachments', 'mcs-panel-attachments', false, 10485760, array['image/jpeg','image/png','image/webp','text/plain'])
on conflict (id) do nothing;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'panel_attachments_read_authorized'
  ) then
    create policy panel_attachments_read_authorized on storage.objects for select to authenticated
      using (bucket_id = 'mcs-panel-attachments' and case
        when (storage.foldername(name))[1] = 'panel'
          and (storage.foldername(name))[2] in ('preview','production')
          then private.panel_authorized(((storage.foldername(name))[2])::public.panel_environment)
        else false end);
  end if;
end $$;
