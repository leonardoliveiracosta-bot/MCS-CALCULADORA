alter table public.messages
  add column if not exists media_storage_path text,
  add column if not exists media_kind text,
  add column if not exists media_mime_type text,
  add column if not exists media_byte_size bigint,
  add column if not exists media_status text;

alter table public.messages drop constraint if exists messages_media_kind_check;
alter table public.messages add constraint messages_media_kind_check
  check (media_kind is null or media_kind in ('image','audio','video','document','sticker')) not valid;
alter table public.messages validate constraint messages_media_kind_check;

create table if not exists public.whatsapp_media_jobs (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  message_id uuid not null references public.messages(id),
  wa_message_id text not null,
  media_id text,
  source_url text,
  media_kind text not null check (media_kind in ('image','audio','video','document','sticker')),
  mime_type text,
  original_filename text,
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','STORED','FAILED')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  error_code text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(environment,message_id),
  unique(environment,wa_message_id)
);

create index if not exists whatsapp_media_jobs_pending_idx
  on public.whatsapp_media_jobs(environment,status,next_attempt_at,created_at)
  where status in ('PENDING','PROCESSING');

alter table public.whatsapp_media_jobs enable row level security;
alter table public.whatsapp_media_jobs force row level security;
revoke all on public.whatsapp_media_jobs from public,anon,authenticated;
grant all on public.whatsapp_media_jobs to service_role;

insert into storage.buckets(id,name,public,file_size_limit)
values('whatsapp-media','whatsapp-media',false,26214400)
on conflict(id) do update set public=false,file_size_limit=26214400;
