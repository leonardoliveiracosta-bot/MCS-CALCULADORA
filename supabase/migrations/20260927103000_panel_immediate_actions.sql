-- Reversible panel actions without deleting operational history.

alter table public.panel_item_dispositions
  add column if not exists cleared_at timestamptz,
  add column if not exists cleared_by uuid references public.panel_users(id);

alter table public.conversation_pending_resolutions
  add column if not exists undone_at timestamptz,
  add column if not exists undone_by uuid references public.panel_users(id);

alter table public.message_journeys
  add column if not exists undone_at timestamptz,
  add column if not exists undone_by uuid references public.panel_users(id);

create index if not exists panel_item_dispositions_active_idx
  on public.panel_item_dispositions(environment,item_kind,item_key)
  where cleared_at is null;

create index if not exists conversation_pending_resolutions_active_idx
  on public.conversation_pending_resolutions(environment,journey_id,chat_id)
  where undone_at is null;

create index if not exists message_journeys_active_idx
  on public.message_journeys(environment,journey_id,message_id)
  where undone_at is null;
