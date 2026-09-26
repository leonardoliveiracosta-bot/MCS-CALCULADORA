create table if not exists public.conversation_ai_attempt_state (
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  chat_id uuid not null references public.chats(id),
  last_customer_message_id uuid not null references public.messages(id),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error text,
  last_attempt_at timestamptz not null default now(),
  last_failure_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(environment,journey_id,chat_id)
);
create index if not exists conversation_ai_attempt_state_backoff_idx
  on public.conversation_ai_attempt_state(environment,last_failure_at desc);

alter table public.conversation_ai_attempt_state enable row level security;
alter table public.conversation_ai_attempt_state force row level security;
revoke all on public.conversation_ai_attempt_state from public,anon,authenticated;
grant select,insert,update,delete on public.conversation_ai_attempt_state to service_role;

create or replace function public.panel_ai_record_attempt(
  p_environment public.panel_environment,p_journey uuid,p_chat uuid,p_customer uuid,p_success boolean,p_error text default null
) returns jsonb language plpgsql security definer set search_path=public as $$
declare row_state public.conversation_ai_attempt_state%rowtype;
begin
  if not exists(
    select 1 from public.message_journeys mj join public.messages m on m.id=mj.message_id
      where mj.environment=p_environment and mj.journey_id=p_journey and m.environment=p_environment
        and m.id=p_customer and m.chat_id=p_chat and m.direction='CUSTOMER'
  ) then raise exception 'AI_ATTEMPT_MESSAGE_MISMATCH'; end if;
  perform pg_advisory_xact_lock(hashtext('conversation-ai-attempt:'||p_environment::text||':'||p_journey::text||':'||p_chat::text));
  insert into public.conversation_ai_attempt_state(
    environment,journey_id,chat_id,last_customer_message_id,attempt_count,consecutive_failures,last_error,last_attempt_at,last_failure_at,updated_at
  ) values(
    p_environment,p_journey,p_chat,p_customer,1,case when p_success then 0 else 1 end,
    case when p_success then null else left(coalesce(nullif(trim(p_error),''),'AI_FAILED'),180) end,
    clock_timestamp(),case when p_success then null else clock_timestamp() end,clock_timestamp()
  ) on conflict(environment,journey_id,chat_id) do update set
    last_customer_message_id=excluded.last_customer_message_id,
    attempt_count=public.conversation_ai_attempt_state.attempt_count+1,
    consecutive_failures=case when p_success then 0 else public.conversation_ai_attempt_state.consecutive_failures+1 end,
    last_error=case when p_success then null else excluded.last_error end,
    last_attempt_at=excluded.last_attempt_at,
    last_failure_at=case when p_success then null else excluded.last_failure_at end,
    updated_at=excluded.updated_at
  returning * into row_state;
  return jsonb_build_object(
    'attempts',row_state.attempt_count,'consecutiveFailures',row_state.consecutive_failures,
    'lastFailureAt',row_state.last_failure_at,'lastError',row_state.last_error
  );
end $$;
revoke all on function public.panel_ai_record_attempt(public.panel_environment,uuid,uuid,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.panel_ai_record_attempt(public.panel_environment,uuid,uuid,uuid,boolean,text) to service_role;
