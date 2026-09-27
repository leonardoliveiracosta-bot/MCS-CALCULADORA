alter table public.panel_item_dispositions
  add column if not exists discard_reason text;

alter table public.panel_item_dispositions
  drop constraint if exists panel_item_dispositions_discard_reason_check;

alter table public.panel_item_dispositions
  add constraint panel_item_dispositions_discard_reason_check
  check (
    (status='DISCARDED' and discard_reason in ('PRICE','DISAPPEARED','BOUGHT_ELSEWHERE','NO_CREDIT','CURIOSITY','OTHER'))
    or (status<>'DISCARDED' and discard_reason is null)
  ) not valid;

update public.panel_item_dispositions
set discard_reason='OTHER'
where status='DISCARDED' and discard_reason is null;

alter table public.panel_item_dispositions
  validate constraint panel_item_dispositions_discard_reason_check;
