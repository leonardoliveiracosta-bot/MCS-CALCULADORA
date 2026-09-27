alter table public.messages
  add column if not exists whatsapp_delivered_at timestamptz,
  add column if not exists whatsapp_read_at timestamptz;

create table if not exists public.whatsapp_message_receipts (
  environment public.panel_environment not null,
  wa_message_id text not null,
  delivered_at timestamptz,
  read_at timestamptz,
  last_status text not null check (last_status in ('sent','delivered','read','failed','deleted')),
  updated_at timestamptz not null default now(),
  primary key (environment,wa_message_id)
);

alter table public.whatsapp_message_receipts enable row level security;
alter table public.whatsapp_message_receipts force row level security;
revoke all on public.whatsapp_message_receipts from public,anon,authenticated;
grant select,insert,update on public.whatsapp_message_receipts to service_role;

create or replace function public.panel_whatsapp_apply_status(
  p_environment public.panel_environment,
  p_status jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  wid text := nullif(trim(p_status->>'id'),'');
  state text := lower(nullif(trim(p_status->>'status'),''));
  stamp timestamptz;
  target uuid;
begin
  if wid is null or state not in ('sent','delivered','read','failed','deleted') then
    raise exception 'WHATSAPP_STATUS_INVALID';
  end if;
  stamp=to_timestamp(nullif(p_status->>'timestamp','')::double precision);
  if stamp is null or stamp<'2009-01-01'::timestamptz or stamp>now()+interval '1 day' then
    raise exception 'WHATSAPP_STATUS_TIMESTAMP_INVALID';
  end if;
  insert into public.whatsapp_message_receipts(environment,wa_message_id,delivered_at,read_at,last_status,updated_at)
  values(p_environment,wid,case when state in ('delivered','read') then stamp end,case when state='read' then stamp end,state,now())
  on conflict(environment,wa_message_id) do update set
    delivered_at=greatest(public.whatsapp_message_receipts.delivered_at,excluded.delivered_at),
    read_at=greatest(public.whatsapp_message_receipts.read_at,excluded.read_at),
    last_status=case when public.whatsapp_message_receipts.read_at is not null then 'read' when excluded.last_status='read' then 'read' when public.whatsapp_message_receipts.delivered_at is not null then 'delivered' else excluded.last_status end,
    updated_at=now();
  select ids.message_id into target from public.whatsapp_message_ids ids where ids.environment=p_environment and ids.wa_message_id=wid;
  if target is not null then
    update public.messages message set
      whatsapp_delivered_at=greatest(message.whatsapp_delivered_at,case when state in ('delivered','read') then stamp end),
      whatsapp_read_at=greatest(message.whatsapp_read_at,case when state='read' then stamp end)
    where message.environment=p_environment and message.id=target and message.direction='MCS';
  end if;
  return jsonb_build_object('messageId',target,'status',state);
end $$;

create or replace function public.panel_whatsapp_sync_receipt(
  p_environment public.panel_environment,
  p_wa_message_id text
) returns void language sql security definer set search_path=public as $$
  update public.messages message set
    whatsapp_delivered_at=greatest(message.whatsapp_delivered_at,receipt.delivered_at),
    whatsapp_read_at=greatest(message.whatsapp_read_at,receipt.read_at)
  from public.whatsapp_message_ids ids
  join public.whatsapp_message_receipts receipt on receipt.environment=ids.environment and receipt.wa_message_id=ids.wa_message_id
  where ids.environment=p_environment and ids.wa_message_id=p_wa_message_id
    and message.environment=p_environment and message.id=ids.message_id and message.direction='MCS'
$$;

revoke all on function public.panel_whatsapp_apply_status(public.panel_environment,jsonb) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_sync_receipt(public.panel_environment,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_apply_status(public.panel_environment,jsonb) to service_role;
grant execute on function public.panel_whatsapp_sync_receipt(public.panel_environment,text) to service_role;
