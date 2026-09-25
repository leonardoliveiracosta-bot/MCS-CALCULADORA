create index if not exists import_jobs_chat_id_idx
  on public.import_jobs (chat_id)
  where chat_id is not null;

create index if not exists chat_sender_aliases_chat_id_idx
  on public.chat_sender_aliases (chat_id);

create index if not exists chat_sender_aliases_confirmed_by_idx
  on public.chat_sender_aliases (confirmed_by)
  where confirmed_by is not null;
