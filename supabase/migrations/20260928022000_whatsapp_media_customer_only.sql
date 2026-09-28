alter table public.whatsapp_media_jobs
  drop constraint if exists whatsapp_media_jobs_status_check;

alter table public.whatsapp_media_jobs
  add constraint whatsapp_media_jobs_status_check
  check (status in ('PENDING','PROCESSING','STORED','FAILED','SKIPPED'));

update public.whatsapp_media_jobs job
set status='SKIPPED',
    error_code='MCS_MEDIA_NOT_RETAINED',
    updated_at=now()
from public.messages message
where message.id=job.message_id
  and message.environment=job.environment
  and message.direction='MCS'
  and job.status<>'SKIPPED';
