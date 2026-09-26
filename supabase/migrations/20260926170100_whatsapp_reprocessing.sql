alter table public.whatsapp_raw_events add column if not exists processing_started_at timestamptz;

alter table public.whatsapp_item_errors add column if not exists status text not null default 'ERROR';
alter table public.whatsapp_item_errors add column if not exists attempts integer not null default 0;
alter table public.whatsapp_item_errors add column if not exists processing_started_at timestamptz;
alter table public.whatsapp_item_errors add column if not exists last_attempt_at timestamptz;
alter table public.whatsapp_item_errors add column if not exists resolved_at timestamptz;

do $$ begin
  alter table public.whatsapp_item_errors
    add constraint whatsapp_item_errors_status_check check(status in ('ERROR','PROCESSING','RESOLVED'));
exception when duplicate_object then null; end $$;

create index if not exists whatsapp_item_errors_queue_idx
  on public.whatsapp_item_errors(environment,status,created_at);

update public.whatsapp_item_errors
set status='ERROR'
where status is distinct from 'RESOLVED';
