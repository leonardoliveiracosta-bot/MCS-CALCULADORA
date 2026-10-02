-- Retomada automática dos prints de SMS: quantas vezes o cron já tentou, quando, e por que um print lido
-- ainda não foi vinculado. Colunas aditivas; nada existente muda. Os prints antigos começam em zero.
alter table public.sms_print_reads
  add column if not exists resume_attempts integer not null default 0,
  add column if not exists last_resume_at timestamptz,
  add column if not exists pending_reason text;

create index if not exists sms_print_reads_ready_idx on public.sms_print_reads (environment, status, updated_at) where status = 'READY';
