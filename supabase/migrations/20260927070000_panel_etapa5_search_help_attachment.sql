-- Etapa 5 is additive: it keeps every original attachment, message and phone row.
create table if not exists public.panel_search_marks (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  kind text not null check (kind in ('SAVED','SENT')),
  created_at timestamptz not null default now(),
  created_by uuid not null references public.panel_users(id),
  undone_at timestamptz,
  undone_by uuid references public.panel_users(id)
);
create index if not exists panel_search_marks_active_idx on public.panel_search_marks(environment,journey_id,kind,created_at desc) where undone_at is null;
alter table public.panel_search_marks enable row level security;
alter table public.panel_search_marks force row level security;
revoke all on public.panel_search_marks from public, anon, authenticated;
grant select,insert,update,delete on public.panel_search_marks to service_role;

create table if not exists public.lead_ai_help (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  ref_code char(5),
  question text not null,
  answer_json jsonb not null,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.panel_users(id)
);
create index if not exists lead_ai_help_journey_idx on public.lead_ai_help(environment,journey_id,created_at desc);
alter table public.lead_ai_help enable row level security;
alter table public.lead_ai_help force row level security;
revoke all on public.lead_ai_help from public, anon, authenticated;
grant select,insert,update,delete on public.lead_ai_help to service_role;

alter table public.sms_print_reads add column if not exists prior_primary_phone_id uuid references public.contact_phones(id);
alter table public.sms_print_reads add column if not exists created_phone_id uuid references public.contact_phones(id);
alter table public.sms_print_reads add column if not exists created_contact boolean not null default false;
alter table public.sms_print_reads add column if not exists created_journey boolean not null default false;
alter table public.sms_print_reads add column if not exists undone_at timestamptz;
alter table public.messages add column if not exists undone_at timestamptz;
alter table public.attachments add column if not exists undone_at timestamptz;
alter table public.interactions add column if not exists undone_at timestamptz;
alter table public.sms_print_reads drop constraint if exists sms_print_reads_status_check;
alter table public.sms_print_reads add constraint sms_print_reads_status_check check(status in ('UPLOADING','READING','READY','FAILED','DISCARDED','CONFIRMED','UNDONE'));
create index if not exists messages_effective_print_idx on public.messages(environment,id) where undone_at is null;

create or replace function public.panel_sms_print_undo(p_environment public.panel_environment,p_actor uuid,p_read uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_print_reads%rowtype; at_time timestamptz:=clock_timestamp();
begin
 if p_actor is null or p_read is null then raise exception 'SMS_PRINT_UNDO_INVALID'; end if;
 select * into r from public.sms_print_reads where id=p_read and environment=p_environment for update;
 if not found then raise exception 'SMS_PRINT_NOT_FOUND'; end if;
 if r.status='UNDONE' then return jsonb_build_object('undone',true,'duplicate',true); end if;
 if r.status<>'CONFIRMED' then raise exception 'SMS_PRINT_NOT_CONFIRMED'; end if;
 if r.message_id is not null then update public.messages set undone_at=at_time where id=r.message_id and environment=p_environment and undone_at is null; end if;
 if r.attachment_id is not null then update public.attachments set undone_at=at_time where id=r.attachment_id and environment=p_environment and undone_at is null; end if;
 if r.message_id is not null then update public.interactions set undone_at=at_time where environment=p_environment and message_id=r.message_id and undone_at is null; end if;
 if r.created_phone_id is not null then
   update public.contact_phones set is_current=false,retired_at=at_time,is_primary=false where id=r.created_phone_id and environment=p_environment and retired_at is null;
   if r.prior_primary_phone_id is not null then update public.contact_phones set is_primary=true where id=r.prior_primary_phone_id and environment=p_environment and retired_at is null; end if;
 end if;
 if r.created_journey then update public.journeys set status='ENCERRADO',closed_at=at_time,closed_reason='SMS_PRINT_UNDONE',updated_at=at_time,updated_by=p_actor where id=r.confirmed_journey_id and environment=p_environment and status<>'ENCERRADO'; end if;
 update public.sms_print_reads set status='UNDONE',undone_at=at_time,updated_at=at_time,updated_by=p_actor where id=r.id;
 return jsonb_build_object('undone',true,'journeyId',r.confirmed_journey_id,'contactId',r.confirmed_contact_id);
end $$;
revoke all on function public.panel_sms_print_undo(public.panel_environment,uuid,uuid) from public,anon,authenticated;
grant execute on function public.panel_sms_print_undo(public.panel_environment,uuid,uuid) to service_role;

create or replace function public.panel_sms_print_attach_photo(p_environment public.panel_environment,p_actor uuid,p_read uuid,p_target_journey uuid,p_attachment uuid,p_bucket text,p_storage_path text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_print_reads%rowtype; j public.journeys%rowtype; attached_id uuid; at_time timestamptz:=clock_timestamp();
begin
 if p_actor is null or p_read is null or p_target_journey is null or p_attachment is null or p_bucket<>'mcs-panel-attachments' or p_storage_path not like 'panel/'||p_environment::text||'/%' then raise exception 'SMS_PRINT_PHOTO_INVALID'; end if;
 select * into r from public.sms_print_reads where id=p_read and environment=p_environment for update;
 if not found then raise exception 'SMS_PRINT_NOT_FOUND'; end if;
 if r.status='CONFIRMED' then return jsonb_build_object('journeyId',r.confirmed_journey_id,'contactId',r.confirmed_contact_id,'attachmentId',r.attachment_id,'duplicate',true); end if;
 if r.status<>'READY' then raise exception 'SMS_PRINT_NOT_READY'; end if;
 select * into j from public.journeys where id=p_target_journey and environment=p_environment for update;
 if not found then raise exception 'SMS_PRINT_TARGET_INVALID'; end if;
 insert into public.attachments(id,environment,contact_id,journey_id,kind,bucket_name,storage_path,original_filename,mime_type,byte_size,sha256,verified_at,created_at,created_by)
 values(p_attachment,p_environment,j.contact_id,j.id,'IMAGE',p_bucket,p_storage_path,r.original_filename,r.mime_type,r.byte_size,r.sha256,at_time,at_time,p_actor) returning id into attached_id;
 update public.sms_print_reads set status='CONFIRMED',storage_path=p_storage_path,confirmed_journey_id=j.id,confirmed_contact_id=j.contact_id,attachment_id=attached_id,updated_at=at_time,updated_by=p_actor where id=r.id;
 return jsonb_build_object('journeyId',j.id,'contactId',j.contact_id,'attachmentId',attached_id,'photoOnly',true);
end $$;
revoke all on function public.panel_sms_print_attach_photo(public.panel_environment,uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.panel_sms_print_attach_photo(public.panel_environment,uuid,uuid,uuid,uuid,text,text) to service_role;
