-- Durable timers are additive; unscheduled legacy rows retain their existing lifecycle.
alter table public.whatsapp_auto_options
  add column recipient_phone text,
  add column recipient_user_id text,
  add column raw_event_id uuid references public.whatsapp_raw_events(id),
  add column scheduled_at timestamptz,
  add column greeting_sent_at timestamptz,
  add column link_due_at timestamptz,
  add column link_send_started_at timestamptz,
  add column link_sent_at timestamptz,
  add column explanation_due_at timestamptz,
  add column explanation_send_started_at timestamptz,
  add column link_queued_at timestamptz,
  add column explanation_queued_at timestamptz;
-- Two one-time infrastructure checks contain no contact or customer data.
create table public.whatsapp_options_timer_checks (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  delay_seconds integer not null check(delay_seconds in (35,90)),
  requested_at timestamptz,
  queued_at timestamptz,
  received_at timestamptz,
  unique(environment,delay_seconds)
);
alter table public.whatsapp_options_timer_checks enable row level security;
alter table public.whatsapp_options_timer_checks force row level security;
revoke all on public.whatsapp_options_timer_checks from public,anon,authenticated;
grant select,insert,update on public.whatsapp_options_timer_checks to service_role;
insert into public.whatsapp_options_timer_checks(environment,delay_seconds) values('production',35),('production',90);

create index whatsapp_auto_options_raw_event_idx on public.whatsapp_auto_options(raw_event_id);
create index whatsapp_auto_options_pending_timer_idx on public.whatsapp_auto_options(environment,stage,link_due_at)
  where scheduled_at is not null and stage in ('CLAIMED','LINK_SENT');

create or replace function public.panel_whatsapp_auto_options_eligibility(
  p_environment public.panel_environment,p_contact uuid,p_journey uuid,p_inbound_message uuid,
  p_inbound_wamid text,p_ref text,p_mode text,p_phone text default null,p_user_id text default null,p_job uuid default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inbound record; calculator record; owners integer; known_phone text;
begin
  if p_mode not in ('CARRO','VALOR') or p_ref !~ '^[A-HJ-NP-Z2-9]{5}$' then
    return jsonb_build_object('eligible',false,'reason','REF_INVALID');
  end if;
  select m.body_text,m.created_at into inbound
  from public.messages m
  join public.chats ch on ch.id=m.chat_id and ch.environment=p_environment and ch.contact_id=p_contact
  join public.contacts c on c.id=p_contact and c.environment=p_environment and c.is_lead
  join public.whatsapp_message_ids w on w.message_id=m.id and w.environment=p_environment and w.wa_message_id=p_inbound_wamid
  join public.message_journeys mj on mj.message_id=m.id and mj.journey_id=p_journey and mj.environment=p_environment
  where m.id=p_inbound_message and m.environment=p_environment and m.channel='WHATSAPP'
    and m.direction='CUSTOMER' and m.source_kind='WHATSAPP_WEBHOOK' and not ch.is_group
    and ch.resolution_status='RESOLVED'
    and ch.canonical_key=case when p_phone is not null then 'wa:'||p_phone else 'wa-user:'||p_user_id end
    and m.occurred_at_utc between now()-interval '10 minutes' and now()+interval '2 minutes';
  if not found or inbound.body_text !~* 'My Car Scout' or
    inbound.body_text !~* ('(^|[^A-Za-z0-9])Ref:[[:space:]]*'||p_ref||'([^A-Za-z0-9]|$)') then
    return jsonb_build_object('eligible',false,'reason','INBOUND_NOT_ELIGIBLE');
  end if;
  if (p_mode='CARRO' and inbound.body_text !~* '(FIND|year range|mileage range|faixa de anos|faixa de milhas|rango de años|solicitação de busca|search request)')
    or (p_mode='VALOR' and (inbound.body_text !~* '(maximum bid|lance máximo|oferta máxima|max(imum)? offer)'
      or inbound.body_text ~* '(·[[:space:]]*FIND[[:space:]]*·|year range|mileage range|faixa de anos|faixa de milhas|rango de años|solicitação de busca|search request)')) then
    return jsonb_build_object('eligible',false,'reason','MODE_CONFLICT');
  end if;
  if not exists(select 1 from public.journeys j where j.id=p_journey and j.environment=p_environment
      and j.contact_id=p_contact and j.status='ATIVO' and (j.reference_code=p_ref or exists(
        select 1 from public.journey_refs r where r.environment=p_environment and r.journey_id=j.id and r.ref_code=p_ref)))
    or exists(select 1 from public.journey_toggle_states t where t.environment=p_environment and t.journey_id=p_journey and not t.enabled)
    or exists(select 1 from public.panel_item_dispositions d where d.environment=p_environment and d.cleared_at is null
      and d.status='DISCARDED' and ((d.item_kind='REF' and d.item_key=p_ref) or (d.item_kind='JOURNEY' and d.item_key=p_journey::text))) then
    return jsonb_build_object('eligible',false,'reason','REQUEST_NOT_ACTIVE');
  end if;
  select count(distinct j.contact_id) into owners from public.journeys j
    where j.environment=p_environment and (j.reference_code=p_ref or exists(
      select 1 from public.journey_refs r where r.environment=p_environment and r.journey_id=j.id and r.ref_code=p_ref));
  if owners<>1 then return jsonb_build_object('eligible',false,'reason','REF_OWNERSHIP_CONFLICT'); end if;
  -- A Ref cannot introduce a new recipient identity into an already-owned contact.
  -- The receiver may provision a BSUID/phone from a Ref before this check; require
  -- an earlier channel association when this contact already had another identity.
  if not exists(select 1 from public.whatsapp_user_ids u where u.environment=p_environment
      and u.contact_id=p_contact and u.bsuid=p_user_id and u.first_seen_at<inbound.created_at)
    and ((p_phone is null and exists(select 1 from public.contact_phones cp where cp.environment=p_environment
      and cp.contact_id=p_contact and cp.is_current and cp.retired_at is null and cp.created_at<inbound.created_at))
      or (exists(select 1 from public.whatsapp_user_ids u where u.environment=p_environment and u.contact_id=p_contact
        and u.first_seen_at<inbound.created_at)
        and not exists(select 1 from public.contact_phones cp where cp.environment=p_environment
          and cp.contact_id=p_contact and cp.is_current and cp.retired_at is null
          and cp.phone_e164=p_phone and cp.created_at<inbound.created_at))) then
    return jsonb_build_object('eligible',false,'reason','CONTACT_IDENTITY_CONFLICT');
  end if;
  if exists(select 1 from public.whatsapp_auto_replies a where a.environment=p_environment
    and a.inbound_wa_message_id=p_inbound_wamid and a.status<>'SENT') then
    return jsonb_build_object('eligible',false,'reason','GREETING_NOT_READY');
  end if;
  -- Match the calculator's mode independently of the caller. Never borrow the other calculator's request.
  select cr.* into calculator from public.calc_runs cr
    cross join lateral (select regexp_replace(lower(translate(coalesce(cr.dados->>'logical_mode',cr.dados->>'logicalMode',cr.dados->>'modo',cr.dados->>'mode',''),'íçã','ica')),'[[:space:]_-]+','','g') m) explicit
    cross join lateral (select case
      when explicit.m in ('carro','vehicle','veiculo','find','finditforme') then 'CARRO'
      when explicit.m in ('valor','value','budget','orcamento','calculadora','calculator') then 'VALOR'
      when lower(cr.dados->>'evento')='busca' or coalesce(cr.dados->>'sid','') ~* '(^|-)find(-|$)' then 'CARRO'
      when lower(cr.dados->>'evento') in ('simulacao','saida','share','whatsapp','sms') then 'VALOR'
      else 'REVIEW' end mode) typed
    where not cr.is_test and upper(cr.dados->>'ref')=p_ref and typed.mode=p_mode
    order by cr.created_at desc limit 1;
  if not found then return jsonb_build_object('eligible',false,'reason','NO_CALCULATOR_RECORD'); end if;
  select public.panel_normalize_phone(coalesce(nullif(cr.whatsapp,''),cr.dados->>'whatsapp')) into known_phone
    from public.calc_runs cr where not cr.is_test and upper(cr.dados->>'ref')=p_ref
      and public.panel_normalize_phone(coalesce(nullif(cr.whatsapp,''),cr.dados->>'whatsapp')) is not null
    order by cr.created_at desc limit 1;
  if known_phone is not null and (p_phone is distinct from known_phone and not (p_phone is null and exists(
      select 1 from public.whatsapp_user_ids u join public.contact_phones cp on cp.contact_id=u.contact_id and cp.environment=u.environment
      where u.environment=p_environment and u.contact_id=p_contact and u.bsuid=p_user_id
        and cp.is_current and cp.retired_at is null and cp.phone_e164=known_phone))) then
    return jsonb_build_object('eligible',false,'reason','CALCULATOR_PHONE_CONFLICT');
  end if;
  if known_phone is null and p_phone is not null and exists(select 1 from public.contact_phones cp
    where cp.environment=p_environment and cp.contact_id=p_contact and cp.is_current and cp.retired_at is null
      and cp.phone_e164<>p_phone and cp.created_at<inbound.created_at) then
    return jsonb_build_object('eligible',false,'reason','CONTACT_PHONE_CONFLICT');
  end if;
  if exists(select 1 from public.whatsapp_auto_options a where a.environment=p_environment and a.ref_code=p_ref and a.logical_mode::text=p_mode and (p_job is null or a.id<>p_job)) then
    return jsonb_build_object('eligible',false,'reason','ALREADY_CLAIMED');
  end if;
  return jsonb_build_object('eligible',true,'key','journey:'||p_journey::text||':'||p_mode,
    'language',coalesce(nullif(calculator.idioma,''),calculator.dados->>'idioma','en'));
end $$;

-- Public service RPC keeps its original signature and duplicate protection.
create or replace function public.panel_whatsapp_auto_options_context(
  p_environment public.panel_environment,p_contact uuid,p_journey uuid,p_inbound_message uuid,
  p_inbound_wamid text,p_ref text,p_mode text,p_phone text default null,p_user_id text default null
) returns jsonb language sql security invoker set search_path='' as $$
  select public.panel_whatsapp_auto_options_eligibility(p_environment,p_contact,p_journey,p_inbound_message,
    p_inbound_wamid,p_ref,p_mode,p_phone,p_user_id,null);
$$;

create function public.panel_whatsapp_auto_options_schedule(
  p_environment public.panel_environment,p_job uuid,p_raw uuid,p_phone text,p_user_id text,p_greeting_wamid text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; valid jsonb; greeting_at timestamptz; due timestamptz;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment for update;
  if not found or job.stage<>'CLAIMED' then return jsonb_build_object('scheduled',false,'reason','STATE_CONFLICT'); end if;
  if job.scheduled_at is not null then return jsonb_build_object('scheduled',true,'dueAt',job.link_due_at); end if;
  valid:=public.panel_whatsapp_auto_options_eligibility(p_environment,job.contact_id,job.journey_id,job.inbound_message_id,
    job.inbound_wamid,job.ref_code,job.logical_mode::text,p_phone,p_user_id,job.id);
  if not coalesce((valid->>'eligible')::boolean,false) then return valid||jsonb_build_object('scheduled',false); end if;
  if not exists(select 1 from public.whatsapp_message_ids w where w.environment=p_environment
    and w.message_id=job.inbound_message_id and w.raw_event_id=p_raw) then
    return jsonb_build_object('scheduled',false,'reason','RAW_EVENT_CONFLICT'); end if;
  select a.sent_at into greeting_at from public.whatsapp_auto_replies a where a.environment=p_environment
    and a.contact_id=job.contact_id and a.status='SENT' and a.sent_at is not null
    and (p_greeting_wamid is null or (a.sent_wa_message_id=p_greeting_wamid and a.inbound_wa_message_id=job.inbound_wamid))
    order by a.sent_at desc limit 1;
  if p_greeting_wamid is not null and greeting_at is null then
    return jsonb_build_object('scheduled',false,'reason','GREETING_NOT_READY'); end if;
  -- A recent-conversation suppression must not replay the welcome or send immediately.
  -- A fresh welcome anchors the timer; otherwise a new request starts its own 90s timer.
  due:=case when greeting_at>=now()-interval '2 minutes' then greeting_at else clock_timestamp() end+interval '90 seconds';
  update public.whatsapp_auto_options set recipient_phone=p_phone,recipient_user_id=p_user_id,raw_event_id=p_raw,
    scheduled_at=clock_timestamp(),greeting_sent_at=greeting_at,link_due_at=due,updated_at=clock_timestamp() where id=job.id;
  return jsonb_build_object('scheduled',true,'dueAt',due);
end $$;

-- Read and revalidate before each delayed send. Own job is allowed, other reservations are not.
create function public.panel_whatsapp_auto_options_step_context(
  p_environment public.panel_environment,p_job uuid,p_step text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; valid jsonb; due timestamptz;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment;
  if not found or job.scheduled_at is null or p_step not in ('LINK','EXPLANATION') then
    return jsonb_build_object('ready',false,'reason','NOT_SCHEDULED'); end if;
  if p_step='LINK' and job.stage='LINK_SENT' then
    return jsonb_build_object('ready',false,'resumeExplanation',true,'dueAt',job.explanation_due_at); end if;
  if (p_step='LINK' and job.stage<>'CLAIMED') or (p_step='EXPLANATION' and (job.stage<>'LINK_SENT' or job.link_wamid is null)) then
    return jsonb_build_object('ready',false,'reason','STATE_CONFLICT'); end if;
  due:=case when p_step='LINK' then job.link_due_at else job.explanation_due_at end;
  if due is null then return jsonb_build_object('ready',false,'reason','TIMER_MISSING'); end if;
  if clock_timestamp()<due then return jsonb_build_object('ready',false,'reason','NOT_DUE','dueAt',due); end if;
  if clock_timestamp()>due+interval '5 minutes' then return jsonb_build_object('ready',false,'reason','EXPIRED'); end if;
  valid:=public.panel_whatsapp_auto_options_eligibility(p_environment,job.contact_id,job.journey_id,job.inbound_message_id,
    job.inbound_wamid,job.ref_code,job.logical_mode::text,job.recipient_phone,job.recipient_user_id,job.id);
  if not coalesce((valid->>'eligible')::boolean,false) then return valid||jsonb_build_object('ready',false); end if;
  if exists(select 1 from public.messages m join public.chats ch on ch.id=m.chat_id and ch.environment=p_environment
    and ch.contact_id=job.contact_id where m.environment=p_environment and m.direction='CUSTOMER'
    and m.created_at>=(select created_at from public.messages where id=job.inbound_message_id)
    and m.body_text ~* '(^|[^[:alnum:]_])(stop|unsubscribe|do not contact|don''t contact|não me contate|nao me contate|no me contactes|cancelar)([^[:alnum:]_]|$)') then
    return jsonb_build_object('ready',false,'reason','OPT_OUT'); end if;
  return valid||jsonb_build_object('ready',true,'dueAt',due,'rawId',job.raw_event_id,
    'recipient',jsonb_build_object('phone',job.recipient_phone,'userId',job.recipient_user_id),
    'body',case when p_step='LINK' then job.link_body else job.explanation_body end);
end $$;

-- Preserve the provider acknowledgement/echo repair, with a timing guard before either send.
alter function public.panel_whatsapp_auto_options_advance(public.panel_environment,uuid,text,text,text)
  rename to panel_whatsapp_auto_options_advance_v1;
create function public.panel_whatsapp_auto_options_advance(
  p_environment public.panel_environment,p_job uuid,p_stage text,p_wamid text default null,p_error text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; valid jsonb; changed jsonb; sent_at timestamptz:=clock_timestamp(); due timestamptz;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment for update;
  if not found then return jsonb_build_object('updated',false); end if;
  if job.scheduled_at is not null and p_stage in ('LINK_SENDING','EXPLANATION_SENDING') then
    valid:=public.panel_whatsapp_auto_options_step_context(p_environment,p_job,case when p_stage='LINK_SENDING' then 'LINK' else 'EXPLANATION' end);
    if not coalesce((valid->>'ready')::boolean,false) then return valid||jsonb_build_object('updated',false); end if;
  end if;
  changed:=public.panel_whatsapp_auto_options_advance_v1(p_environment,p_job,p_stage,p_wamid,p_error);
  if not coalesce((changed->>'updated')::boolean,false) then return changed; end if;
  if job.scheduled_at is not null then
    update public.whatsapp_auto_options set
      link_send_started_at=case when p_stage='LINK_SENDING' then sent_at else link_send_started_at end,
      explanation_send_started_at=case when p_stage='EXPLANATION_SENDING' then sent_at else explanation_send_started_at end,
      link_sent_at=case when p_stage='LINK_SENT' then coalesce(link_sent_at,sent_at) else link_sent_at end,
      explanation_due_at=case when p_stage='LINK_SENT' then coalesce(explanation_due_at,sent_at+interval '35 seconds') else explanation_due_at end
      where id=p_job returning explanation_due_at into due;
  end if;
  return changed||jsonb_build_object('explanationDueAt',due);
end $$;

create function public.panel_whatsapp_auto_options_timer_queued(p_environment public.panel_environment,p_job uuid,p_step text)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  if p_step='PROBE' then
    update public.whatsapp_options_timer_checks set queued_at=coalesce(queued_at,clock_timestamp())
      where id=p_job and environment=p_environment;
    return jsonb_build_object('updated',found);
  end if;
  update public.whatsapp_auto_options set
    link_queued_at=case when p_step='LINK' then coalesce(link_queued_at,clock_timestamp()) else link_queued_at end,
    explanation_queued_at=case when p_step='EXPLANATION' then coalesce(explanation_queued_at,clock_timestamp()) else explanation_queued_at end,
    updated_at=clock_timestamp()
    where id=p_job and environment=p_environment and scheduled_at is not null
      and ((p_step='LINK' and stage='CLAIMED') or (p_step='EXPLANATION' and stage='LINK_SENT'));
  return jsonb_build_object('updated',found);
end $$;

-- Recovery republishes only timers with no publication receipt; it never sends WhatsApp messages.
create function public.panel_whatsapp_auto_options_pending_timers(p_environment public.panel_environment)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare timers jsonb;
begin
  update public.whatsapp_auto_options set stage='FAILED',error_code='TIMER_EXPIRED',updated_at=clock_timestamp()
    where environment=p_environment and scheduled_at is not null and stage in ('CLAIMED','LINK_SENT')
      and clock_timestamp()>case when stage='CLAIMED' then link_due_at else explanation_due_at end+interval '5 minutes';
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'step',t.step,'dueAt',t.due)), '[]'::jsonb) into timers from (
    select a.id,case when a.stage='CLAIMED' then 'LINK' else 'EXPLANATION' end step,
      case when a.stage='CLAIMED' then a.link_due_at else a.explanation_due_at end due
    from public.whatsapp_auto_options a where a.environment=p_environment and a.scheduled_at is not null
      and ((a.stage='CLAIMED' and a.link_queued_at is null) or (a.stage='LINK_SENT' and a.explanation_queued_at is null))
    order by a.scheduled_at limit 8
  ) t;
  update public.whatsapp_options_timer_checks set requested_at=coalesce(requested_at,clock_timestamp())
    where environment=p_environment and queued_at is null and received_at is null;
  select timers||coalesce(jsonb_agg(jsonb_build_object('id',c.id,'step','PROBE','seconds',c.delay_seconds,
    'requestedAt',floor(extract(epoch from c.requested_at)*1000))), '[]'::jsonb) into timers
    from public.whatsapp_options_timer_checks c where c.environment=p_environment and c.queued_at is null and c.received_at is null;
  return timers;
end $$;

create function public.panel_whatsapp_options_probe_received(p_environment public.panel_environment,p_probe uuid,p_seconds integer)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  update public.whatsapp_options_timer_checks set received_at=coalesce(received_at,clock_timestamp())
    where environment=p_environment and id=p_probe and delay_seconds=p_seconds and requested_at is not null;
  return jsonb_build_object('updated',found);
end $$;

create or replace function public.panel_whatsapp_auto_options_message_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.direction='MCS' and new.channel='WHATSAPP' and new.source_kind='WHATSAPP_WEBHOOK' and exists(
    select 1 from public.whatsapp_auto_options a join public.chats ch on ch.id=new.chat_id and ch.environment=new.environment and ch.contact_id=a.contact_id
    where a.environment=new.environment and ((new.signature_base='WA:'||a.link_wamid and new.body_text=a.link_body)
      or (new.signature_base='WA:'||a.explanation_wamid and new.body_text=a.explanation_body)
      -- A live provider echo may precede the HTTP acknowledgement. Only the exact
      -- automation text, recipient and short active send window qualify. A copied
      -- manual URL has no automation label and never enters this branch.
      or (coalesce(case when a.link_wamid is null then a.link_send_started_at else a.explanation_send_started_at end,a.claimed_at)>=now()-interval '2 minutes'
        and new.occurred_at_utc between coalesce(case when a.link_wamid is null then a.link_send_started_at else a.explanation_send_started_at end,a.claimed_at)-interval '2 seconds' and now()+interval '2 seconds'
        and new.signature_base like 'WA:%' and
        ((a.link_wamid is null and a.stage in ('LINK_SENDING','FAILED') and new.body_text=a.link_body)
          or (a.link_wamid is not null and a.explanation_wamid is null and a.stage in ('EXPLANATION_SENDING','FAILED') and new.body_text=a.explanation_body))))) then new.is_automatic:=true; end if;
  return new;
end $$;

revoke all on function public.panel_whatsapp_auto_options_eligibility(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_eligibility(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,uuid) to service_role;

revoke all on function public.panel_whatsapp_auto_options_schedule(public.panel_environment,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_schedule(public.panel_environment,uuid,uuid,text,text,text) to service_role;

revoke all on function public.panel_whatsapp_auto_options_step_context(public.panel_environment,uuid,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_step_context(public.panel_environment,uuid,text) to service_role;

revoke all on function public.panel_whatsapp_auto_options_advance(public.panel_environment,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_advance(public.panel_environment,uuid,text,text,text) to service_role;

revoke all on function public.panel_whatsapp_auto_options_timer_queued(public.panel_environment,uuid,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_timer_queued(public.panel_environment,uuid,text) to service_role;

revoke all on function public.panel_whatsapp_auto_options_pending_timers(public.panel_environment) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_pending_timers(public.panel_environment) to service_role;

revoke all on function public.panel_whatsapp_options_probe_received(public.panel_environment,uuid,integer) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_options_probe_received(public.panel_environment,uuid,integer) to service_role;
