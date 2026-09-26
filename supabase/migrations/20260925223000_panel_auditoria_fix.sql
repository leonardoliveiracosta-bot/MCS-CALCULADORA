-- Painel audit fixes: dispositions, test flags, Manheim order targets and sender inversion.

alter table public.calc_runs
  add column if not exists is_test boolean not null default false;

update public.calc_runs
   set is_test = true
 where upper(coalesce(dados ->> 'ref', '')) in ('D224T','CZFSR');

create table if not exists public.panel_item_dispositions (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  item_kind text not null check (item_kind in ('REF','JOURNEY')),
  item_key text not null,
  status text not null check (status in ('TREATED','DISCARDED')),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.panel_users(id),
  unique (environment, item_kind, item_key)
);

create index if not exists panel_item_dispositions_environment_status_idx
  on public.panel_item_dispositions(environment, status, item_kind, item_key);

alter table public.panel_item_dispositions enable row level security;
alter table public.panel_item_dispositions force row level security;
revoke all on table public.panel_item_dispositions from public, anon, authenticated;
grant select on table public.panel_item_dispositions to authenticated;
grant all on table public.panel_item_dispositions to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='panel_item_dispositions'
      and policyname='panel_panel_item_dispositions_select_authorized'
  ) then
    create policy panel_panel_item_dispositions_select_authorized
      on public.panel_item_dispositions for select to authenticated
      using (private.panel_authorized(environment));
  end if;
end $$;

alter table public.manheim_matches
  alter column journey_id drop not null;

alter table public.manheim_matches
  add column if not exists calc_ref char(5);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.manheim_matches'::regclass
      and conname='manheim_matches_exactly_one_target_check'
  ) then
    alter table public.manheim_matches
      add constraint manheim_matches_exactly_one_target_check
      check (
        (case when journey_id is not null then 1 else 0 end) +
        (case when calc_ref is not null then 1 else 0 end) = 1
      ) not valid;
    alter table public.manheim_matches
      validate constraint manheim_matches_exactly_one_target_check;
  end if;
end $$;

create unique index if not exists manheim_matches_order_unique_idx
  on public.manheim_matches(environment, upload_id, calc_ref, row_fingerprint)
  where calc_ref is not null;

create index if not exists manheim_matches_environment_upload_ref_idx
  on public.manheim_matches(environment, upload_id, calc_ref, match_kind)
  where calc_ref is not null;

create or replace function public.panel_invert_chat_senders(
  p_environment public.panel_environment,
  p_chat_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact_id uuid;
  v_message_count integer := 0;
  v_alias_count integer := 0;
  v_journey_id uuid;
  v_latest_mcs timestamptz;
  v_has_mcs boolean;
  v_now timestamptz := now();
begin
  if not exists (
    select 1 from public.panel_users pu
     where pu.id=p_actor_id and pu.environment=p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select contact_id into v_contact_id
    from public.chats
   where id=p_chat_id and environment=p_environment and not is_group
   for update;
  if not found then raise exception 'CHAT_NOT_FOUND'; end if;

  update public.chat_sender_aliases
     set direction = case direction
       when 'MCS'::public.panel_message_direction then 'CUSTOMER'::public.panel_message_direction
       when 'CUSTOMER'::public.panel_message_direction then 'MCS'::public.panel_message_direction
       else direction
     end,
     confirmed_at = v_now,
     confirmed_by = p_actor_id
   where environment=p_environment and chat_id=p_chat_id
     and direction in ('MCS'::public.panel_message_direction,'CUSTOMER'::public.panel_message_direction);
  get diagnostics v_alias_count = row_count;

  update public.messages
     set direction = case direction
       when 'MCS'::public.panel_message_direction then 'CUSTOMER'::public.panel_message_direction
       when 'CUSTOMER'::public.panel_message_direction then 'MCS'::public.panel_message_direction
       else direction
     end
   where environment=p_environment and chat_id=p_chat_id
     and direction in ('MCS'::public.panel_message_direction,'CUSTOMER'::public.panel_message_direction);
  get diagnostics v_message_count = row_count;

  update public.interactions i
     set type = case m.direction
       when 'MCS'::public.panel_message_direction then 'OUTBOUND_MESSAGE'::public.panel_interaction_type
       when 'CUSTOMER'::public.panel_message_direction then 'INBOUND_MESSAGE'::public.panel_interaction_type
       else i.type
     end
    from public.messages m
   where i.environment=p_environment
     and i.message_id=m.id
     and m.environment=p_environment
     and m.chat_id=p_chat_id
     and i.type in ('OUTBOUND_MESSAGE'::public.panel_interaction_type,'INBOUND_MESSAGE'::public.panel_interaction_type);

  for v_journey_id in
    select distinct mj.journey_id
      from public.message_journeys mj
      join public.messages m on m.id=mj.message_id and m.environment=mj.environment
     where mj.environment=p_environment and m.chat_id=p_chat_id
  loop
    select max(coalesce(m.occurred_at_utc, m.created_at)),
           bool_or(m.direction='MCS'::public.panel_message_direction)
      into v_latest_mcs, v_has_mcs
      from public.message_journeys mj
      join public.messages m on m.id=mj.message_id and m.environment=mj.environment
     where mj.environment=p_environment
       and mj.journey_id=v_journey_id
       and m.direction <> 'SYSTEM'::public.panel_message_direction;

    select max(coalesce(m.occurred_at_utc, m.created_at))
      into v_latest_mcs
      from public.message_journeys mj
      join public.messages m on m.id=mj.message_id and m.environment=mj.environment
     where mj.environment=p_environment
       and mj.journey_id=v_journey_id
       and m.direction='MCS'::public.panel_message_direction;

    update public.journeys
       set last_effective_contact_at = v_latest_mcs,
           next_action_missing_since = case
             when next_action_at is null then v_latest_mcs
             else null
           end,
           stage = case
             when stage='NOVO'::public.panel_journey_stage and v_has_mcs
               then 'RESPONDIDO'::public.panel_journey_stage
             else stage
           end,
           updated_at = v_now,
           updated_by = p_actor_id
     where environment=p_environment and id=v_journey_id
       and not stage_frozen;
  end loop;

  insert into public.audit_log(
    environment, actor_user_id, entity_type, entity_id, action, after_json, created_at
  ) values (
    p_environment, p_actor_id, 'chat', p_chat_id, 'INVERT_SENDERS',
    jsonb_build_object('message_count',v_message_count,'alias_count',v_alias_count), v_now
  );

  insert into public.panel_notifications(environment, topic, entity_type, entity_id, created_at)
  values (p_environment,'panel.updated','chat',p_chat_id,v_now);

  return jsonb_build_object('messageCount',v_message_count,'aliasCount',v_alias_count);
end;
$$;

revoke all on function public.panel_invert_chat_senders(public.panel_environment,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.panel_invert_chat_senders(public.panel_environment,uuid,uuid)
  to service_role;
