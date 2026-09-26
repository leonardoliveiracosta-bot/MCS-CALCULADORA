-- Operational queue for the one-time, resumable conversation reading.
create table if not exists public.conversation_pending_insights (
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  situation text not null check (situation in ('MCS_PENDING','CUSTOMER_PENDING','IN_PROGRESS','CLOSED','UNKNOWN')),
  heat text not null check (heat in ('HOT','WARM','COLD')),
  summary_text text not null default '',
  next_step_text text not null default '',
  translation_text text,
  last_ai_message_id uuid references public.messages(id),
  updated_at timestamptz not null default now(),
  primary key(environment,journey_id,chat_id)
);

create table if not exists public.conversation_pending_resolutions (
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  resolved_message_id uuid not null references public.messages(id),
  resolved_at timestamptz not null default now(),
  resolved_by uuid references public.panel_users(id),
  primary key(environment,journey_id,chat_id)
);

create table if not exists public.conversation_general_read_runs (
  environment public.panel_environment primary key,
  status text not null default 'IDLE' check (status in ('IDLE','ACTIVE','PAUSED','LIMIT','COMPLETED')),
  total_conversations integer not null default 0 check (total_conversations >= 0),
  completed_conversations integer not null default 0 check (completed_conversations >= 0),
  budget_usd numeric(12,6) not null default 20.000000 check (budget_usd >= 0),
  spent_usd numeric(12,6) not null default 0 check (spent_usd >= 0),
  reserved_usd numeric(12,6) not null default 0 check (reserved_usd >= 0),
  started_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_general_read_progress (
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  message_count integer not null check (message_count > 0),
  snapshot_last_message_id uuid not null references public.messages(id),
  next_message_index integer not null default 0 check (next_message_index >= 0),
  accumulated_summary text not null default '',
  status text not null default 'PENDING' check (status in ('PENDING','PROCESSING','COMPLETED','ERROR')),
  processing_started_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  updated_at timestamptz not null default now(),
  primary key(environment,journey_id,chat_id)
);
create index if not exists conversation_general_read_progress_claim_idx
  on public.conversation_general_read_progress(environment,status,updated_at);

do $$ declare tbl text; begin
  foreach tbl in array array[
    'conversation_pending_insights','conversation_pending_resolutions',
    'conversation_general_read_runs','conversation_general_read_progress'
  ] loop
    execute format('alter table public.%I enable row level security',tbl);
    execute format('alter table public.%I force row level security',tbl);
    execute format('revoke all on public.%I from public,anon,authenticated',tbl);
    execute format('grant select,insert,update,delete on public.%I to service_role',tbl);
  end loop;
end $$;

create or replace function public.panel_pending_start_general_read(p_environment public.panel_environment,p_rows jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare entry jsonb; total integer:=0; existing public.conversation_general_read_runs%rowtype;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>10000 then raise exception 'PENDING_ROWS_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('pending-general:'||p_environment::text));
  select * into existing from public.conversation_general_read_runs where environment=p_environment for update;
  if found and existing.status in ('ACTIVE','PAUSED','LIMIT') then
    return jsonb_build_object('started',false,'status',existing.status,'total',existing.total_conversations,'completed',existing.completed_conversations);
  end if;
  delete from public.conversation_general_read_progress where environment=p_environment;
  for entry in select value from jsonb_array_elements(p_rows) loop
    if not exists(select 1 from public.message_journeys mj join public.messages m on m.id=mj.message_id
      where mj.environment=p_environment and mj.journey_id=(entry->>'journeyId')::uuid
        and m.environment=p_environment and m.id=(entry->>'lastMessageId')::uuid and m.chat_id=(entry->>'chatId')::uuid) then
      raise exception 'PENDING_CONVERSATION_INVALID';
    end if;
    insert into public.conversation_general_read_progress(environment,journey_id,chat_id,message_count,snapshot_last_message_id)
      values(p_environment,(entry->>'journeyId')::uuid,(entry->>'chatId')::uuid,(entry->>'messageCount')::integer,(entry->>'lastMessageId')::uuid);
    total:=total+1;
  end loop;
  insert into public.conversation_general_read_runs(environment,status,total_conversations,completed_conversations,budget_usd,spent_usd,reserved_usd,started_at,updated_at)
    values(p_environment,case when total=0 then 'COMPLETED' else 'ACTIVE' end,total,0,20,0,0,clock_timestamp(),clock_timestamp())
    on conflict(environment) do update set status=excluded.status,total_conversations=excluded.total_conversations,
      completed_conversations=0,budget_usd=20,spent_usd=0,reserved_usd=0,started_at=excluded.started_at,last_error=null,updated_at=excluded.updated_at;
  return jsonb_build_object('started',true,'status',case when total=0 then 'COMPLETED' else 'ACTIVE' end,'total',total,'completed',0);
end $$;

create or replace function public.panel_pending_claim_general_read(p_environment public.panel_environment,p_reserve_usd numeric)
returns table(journey_id uuid,chat_id uuid,message_count integer,snapshot_last_message_id uuid,next_message_index integer,accumulated_summary text,reserved_usd numeric)
language plpgsql security definer set search_path=public as $$
declare run public.conversation_general_read_runs%rowtype; progress public.conversation_general_read_progress%rowtype;
begin
  if p_reserve_usd<=0 or p_reserve_usd>2 then raise exception 'PENDING_RESERVE_INVALID'; end if;
  select * into run from public.conversation_general_read_runs where environment=p_environment for update;
  if not found or run.status<>'ACTIVE' then return; end if;
  if run.spent_usd+run.reserved_usd+p_reserve_usd>run.budget_usd then
    update public.conversation_general_read_runs set status='LIMIT',updated_at=clock_timestamp() where environment=p_environment;
    return;
  end if;
  select * into progress from public.conversation_general_read_progress p
    where p.environment=p_environment and (p.status='PENDING' or (p.status='PROCESSING' and p.processing_started_at<clock_timestamp()-interval '2 minutes'))
    order by p.updated_at,p.journey_id,p.chat_id for update skip locked limit 1;
  if not found then
    -- A live worker owns the remaining row.  Do not mark the run complete while
    -- it is still spending its reserved budget and will later release the lease.
    if exists(select 1 from public.conversation_general_read_progress p where p.environment=p_environment and p.status='PROCESSING') then
      return;
    end if;
    update public.conversation_general_read_runs set status='COMPLETED',completed_conversations=(select count(*) from public.conversation_general_read_progress where environment=p_environment and status='COMPLETED'),updated_at=clock_timestamp() where environment=p_environment;
    return;
  end if;
  update public.conversation_general_read_progress p set status='PROCESSING',processing_started_at=clock_timestamp(),attempts=p.attempts+1,updated_at=clock_timestamp()
    where p.environment=p_environment and p.journey_id=progress.journey_id and p.chat_id=progress.chat_id;
  update public.conversation_general_read_runs r set reserved_usd=r.reserved_usd+p_reserve_usd,updated_at=clock_timestamp() where r.environment=p_environment;
  return query select progress.journey_id,progress.chat_id,progress.message_count,progress.snapshot_last_message_id,progress.next_message_index,progress.accumulated_summary,p_reserve_usd;
end $$;

create or replace function public.panel_pending_finish_general_read(
  p_environment public.panel_environment,p_journey uuid,p_chat uuid,p_next integer,p_summary text,p_completed boolean,
  p_situation text default null,p_heat text default null,p_final_summary text default null,p_next_step text default null,p_translation text default null,
  p_last_message uuid default null,p_actual_usd numeric default 0,p_reserved_usd numeric default 0,p_error text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare completed integer;
begin
  perform pg_advisory_xact_lock(hashtext('pending-general:'||p_environment::text));
  if p_actual_usd<0 or p_reserved_usd<0 or p_actual_usd>p_reserved_usd then raise exception 'PENDING_COST_INVALID'; end if;
  update public.conversation_general_read_progress p set
    next_message_index=greatest(p.next_message_index,p_next),accumulated_summary=left(coalesce(p_summary,''),12000),
    status=case when p_error is not null then 'PENDING' when p_completed then 'COMPLETED' else 'PENDING' end,
    processing_started_at=null,last_error=case when p_error is null then null else left(p_error,180) end,updated_at=clock_timestamp()
    where p.environment=p_environment and p.journey_id=p_journey and p.chat_id=p_chat and p.status='PROCESSING';
  if not found then raise exception 'PENDING_CLAIM_LOST'; end if;
  update public.conversation_general_read_runs r set reserved_usd=greatest(0,r.reserved_usd-p_reserved_usd),spent_usd=r.spent_usd+p_actual_usd,updated_at=clock_timestamp()
    where r.environment=p_environment;
  if p_completed and p_error is null then
    if p_situation not in ('MCS_PENDING','CUSTOMER_PENDING','IN_PROGRESS','CLOSED','UNKNOWN') or p_heat not in ('HOT','WARM','COLD') then raise exception 'PENDING_INSIGHT_INVALID'; end if;
    insert into public.conversation_pending_insights(environment,journey_id,chat_id,situation,heat,summary_text,next_step_text,translation_text,last_ai_message_id,updated_at)
      values(p_environment,p_journey,p_chat,p_situation,p_heat,left(coalesce(p_final_summary,''),2000),left(coalesce(p_next_step,''),1000),nullif(left(coalesce(p_translation,''),2000),''),p_last_message,clock_timestamp())
      on conflict(environment,journey_id,chat_id) do update set situation=excluded.situation,heat=excluded.heat,summary_text=excluded.summary_text,next_step_text=excluded.next_step_text,translation_text=excluded.translation_text,last_ai_message_id=excluded.last_ai_message_id,updated_at=excluded.updated_at;
  end if;
  select count(*) into completed from public.conversation_general_read_progress where environment=p_environment and status='COMPLETED';
  update public.conversation_general_read_runs r set completed_conversations=completed,
    status=case when p_error is not null then 'PAUSED' when r.spent_usd+r.reserved_usd>=r.budget_usd then 'LIMIT' when completed>=r.total_conversations then 'COMPLETED' else r.status end,
    last_error=case when p_error is null then null else left(p_error,180) end,
    updated_at=clock_timestamp() where r.environment=p_environment;
  return jsonb_build_object('completed',completed);
end $$;

create or replace function public.panel_pending_set_general_status(p_environment public.panel_environment,p_status text)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_status not in ('ACTIVE','PAUSED') then raise exception 'PENDING_STATUS_INVALID'; end if;
  update public.conversation_general_read_runs r set status=p_status,updated_at=clock_timestamp()
    where r.environment=p_environment and r.status in ('ACTIVE','PAUSED');
  if not found then raise exception 'PENDING_RUN_UNAVAILABLE'; end if;
  return jsonb_build_object('status',p_status);
end $$;

create or replace function public.panel_pending_add_general_budget(p_environment public.panel_environment,p_add_usd numeric)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_add_usd<>10 then raise exception 'PENDING_BUDGET_INVALID'; end if;
  update public.conversation_general_read_runs r set budget_usd=r.budget_usd+p_add_usd,status='ACTIVE',updated_at=clock_timestamp()
    where r.environment=p_environment and r.status='LIMIT';
  if not found then raise exception 'PENDING_RUN_UNAVAILABLE'; end if;
  return jsonb_build_object('status','ACTIVE');
end $$;

do $$ begin
  revoke all on function public.panel_pending_start_general_read(public.panel_environment,jsonb) from public,anon,authenticated;
  revoke all on function public.panel_pending_claim_general_read(public.panel_environment,numeric) from public,anon,authenticated;
  revoke all on function public.panel_pending_finish_general_read(public.panel_environment,uuid,uuid,integer,text,boolean,text,text,text,text,text,uuid,numeric,numeric,text) from public,anon,authenticated;
  revoke all on function public.panel_pending_set_general_status(public.panel_environment,text) from public,anon,authenticated;
  revoke all on function public.panel_pending_add_general_budget(public.panel_environment,numeric) from public,anon,authenticated;
  grant execute on function public.panel_pending_start_general_read(public.panel_environment,jsonb) to service_role;
  grant execute on function public.panel_pending_claim_general_read(public.panel_environment,numeric) to service_role;
  grant execute on function public.panel_pending_finish_general_read(public.panel_environment,uuid,uuid,integer,text,boolean,text,text,text,text,text,uuid,numeric,numeric,text) to service_role;
  grant execute on function public.panel_pending_set_general_status(public.panel_environment,text) to service_role;
  grant execute on function public.panel_pending_add_general_budget(public.panel_environment,numeric) to service_role;
end $$;
