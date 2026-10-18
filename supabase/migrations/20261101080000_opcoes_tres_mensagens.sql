-- Opções automáticas da calculadora em 3 mensagens: link (90 s depois das boas-vindas), explicação (35 s depois)
-- e detalhes (25 s depois). Cada mensagem continua sendo enviada no máximo uma vez, pela mesma trava do banco.
-- Pedido sem a terceira mensagem (details_body vazio, como os já gravados) termina como antes, depois da explicação.
-- Também: um segundo pedido da mesma ficha e do mesmo modo em 24 h não recebe o mesmo link de novo
-- (medido: 1 de 21 fichas, 3 Refs em 8 minutos, recebeu link e explicação 3 vezes).
alter table public.whatsapp_auto_options
  add column details_body text,
  add column details_wamid text,
  add column explanation_sent_at timestamptz,
  add column details_due_at timestamptz,
  add column details_send_started_at timestamptz,
  add column details_queued_at timestamptz;
alter table public.whatsapp_auto_options drop constraint whatsapp_auto_options_stage_check;
alter table public.whatsapp_auto_options add constraint whatsapp_auto_options_stage_check
  check (stage in ('CLAIMED','LINK_SENDING','LINK_SENT','EXPLANATION_SENDING','EXPLANATION_SENT','DETAILS_SENDING','COMPLETE','FAILED'));
create index whatsapp_auto_options_details_wamid_idx on public.whatsapp_auto_options(environment,details_wamid) where details_wamid is not null;

-- Reserva com as 3 mensagens. A anterior (sem p_details) continua existindo para o código antigo.
create function public.panel_whatsapp_auto_options_claim(
  p_environment public.panel_environment,p_contact uuid,p_journey uuid,p_inbound_message uuid,
  p_inbound_wamid text,p_ref text,p_mode text,p_phone text,p_user_id text,p_link text,p_explanation text,p_details text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare context jsonb; job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_environment::text||':auto-options:'||p_ref||':'||p_mode));
  context:=public.panel_whatsapp_auto_options_context(p_environment,p_contact,p_journey,p_inbound_message,p_inbound_wamid,p_ref,p_mode,p_phone,p_user_id);
  if not coalesce((context->>'eligible')::boolean,false) then return context||jsonb_build_object('claimed',false); end if;
  -- Same request (same ficha and mode) sent again with another Ref: the link already went out.
  perform pg_advisory_xact_lock(hashtext(p_environment::text||':auto-options-journey:'||p_journey::text||':'||p_mode));
  if exists(select 1 from public.whatsapp_auto_options a where a.environment=p_environment and a.journey_id=p_journey
      and a.logical_mode::text=p_mode and a.stage<>'FAILED' and a.claimed_at>=now()-interval '24 hours') then
    return jsonb_build_object('claimed',false,'reason','ALREADY_SENT_TO_REQUEST'); end if;
  if p_link !~ E'^(Preview the vehicles available to you at dealer-only auctions|Veja os veículos disponíveis para você em leilões exclusivos para lojistas|Mira los vehículos disponibles para ti en subastas exclusivas para concesionarios):\nhttps://www[.]mycarscout[.]net/o/[A-Za-z0-9_-]{32,80}$'
    or length(p_explanation) not between 30 and 2000 or length(p_details) not between 30 and 2000
    or not exists(select 1 from public.panel_option_links l
      where l.environment=p_environment and l.demand_key=context->>'key' and split_part(p_link,E'\n',2)='https://www.mycarscout.net/o/'||l.public_code) then
    return jsonb_build_object('claimed',false,'reason','LINK_INVALID');
  end if;
  insert into public.whatsapp_auto_options(environment,contact_id,journey_id,ref_code,logical_mode,inbound_message_id,inbound_wamid,link_body,explanation_body,details_body)
    values(p_environment,p_contact,p_journey,p_ref,p_mode::public.panel_logical_mode,p_inbound_message,p_inbound_wamid,p_link,p_explanation,p_details)
    on conflict(environment,ref_code,logical_mode) do nothing returning id into job_id;
  if job_id is null then return jsonb_build_object('claimed',false,'reason','ALREADY_CLAIMED'); end if;
  return jsonb_build_object('claimed',true,'id',job_id);
end $$;
revoke all on function public.panel_whatsapp_auto_options_claim(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_claim(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,text,text,text) to service_role;

-- Estados: a explicação só vira COMPLETE quando não há terceira mensagem; com ela, EXPLANATION_SENT e depois DETAILS.
create or replace function public.panel_whatsapp_auto_options_advance_v1(
  p_environment public.panel_environment,p_job uuid,p_stage text,p_wamid text default null,p_error text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; msg record; three boolean;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment for update;
  if not found then return jsonb_build_object('updated',false); end if;
  three:=job.details_body is not null;
  if not ((p_stage='LINK_SENDING' and job.stage='CLAIMED')
    or (p_stage='LINK_SENT' and job.stage in ('LINK_SENDING','LINK_SENT') and length(p_wamid) between 2 and 256)
    or (p_stage='EXPLANATION_SENDING' and job.stage='LINK_SENT' and job.link_wamid is not null)
    or (p_stage='EXPLANATION_SENT' and three and job.stage in ('EXPLANATION_SENDING','EXPLANATION_SENT') and length(p_wamid) between 2 and 256)
    or (p_stage='DETAILS_SENDING' and three and job.stage='EXPLANATION_SENT' and job.explanation_wamid is not null)
    or (p_stage='COMPLETE' and not three and job.stage in ('EXPLANATION_SENDING','COMPLETE') and length(p_wamid) between 2 and 256)
    or (p_stage='COMPLETE' and three and job.stage in ('DETAILS_SENDING','COMPLETE') and length(p_wamid) between 2 and 256)
    or (p_stage='FAILED' and job.stage<>'COMPLETE')) then return jsonb_build_object('updated',false); end if;
  if p_stage in ('LINK_SENDING','EXPLANATION_SENDING','DETAILS_SENDING') and (not exists(select 1 from public.journeys j
    join public.contacts c on c.id=j.contact_id and c.environment=j.environment and c.is_lead
    where j.id=job.journey_id and j.environment=p_environment and j.status='ATIVO')
    or exists(select 1 from public.journey_toggle_states t where t.environment=p_environment and t.journey_id=job.journey_id and not t.enabled)) then
    return jsonb_build_object('updated',false);
  end if;
  update public.whatsapp_auto_options set stage=p_stage,
    link_wamid=case when p_stage='LINK_SENT' then p_wamid else link_wamid end,
    explanation_wamid=case when p_stage='EXPLANATION_SENT' or (p_stage='COMPLETE' and not three) then p_wamid else explanation_wamid end,
    details_wamid=case when p_stage='COMPLETE' and three then p_wamid else details_wamid end,
    error_code=coalesce(left(nullif(p_error,''),120),error_code),updated_at=now() where id=p_job;
  -- The provider echo can arrive before its acknowledgement is saved. Repair only that exact id.
  if p_stage in ('LINK_SENT','EXPLANATION_SENT','COMPLETE') then
    for msg in select m.id from public.messages m join public.chats ch on ch.id=m.chat_id
      where m.environment=p_environment and ch.environment=p_environment and ch.contact_id=job.contact_id
        and m.direction='MCS' and m.signature_base='WA:'||p_wamid
        and m.body_text=case when p_stage='LINK_SENT' then job.link_body
          when p_stage='EXPLANATION_SENT' or not three then job.explanation_body else job.details_body end
    loop perform public.panel_set_message_automatic(p_environment,msg.id,true); end loop;
  end if;
  return jsonb_build_object('updated',true);
end $$;

create or replace function public.panel_whatsapp_auto_options_step_context(
  p_environment public.panel_environment,p_job uuid,p_step text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; valid jsonb; due timestamptz;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment;
  if not found or job.scheduled_at is null or p_step not in ('LINK','EXPLANATION','DETAILS') then
    return jsonb_build_object('ready',false,'reason','NOT_SCHEDULED'); end if;
  if p_step='LINK' and job.stage='LINK_SENT' then
    return jsonb_build_object('ready',false,'resumeExplanation',true,'dueAt',job.explanation_due_at); end if;
  if p_step='EXPLANATION' and job.stage='EXPLANATION_SENT' then
    return jsonb_build_object('ready',false,'resumeDetails',true,'dueAt',job.details_due_at); end if;
  if (p_step='LINK' and job.stage<>'CLAIMED') or (p_step='EXPLANATION' and (job.stage<>'LINK_SENT' or job.link_wamid is null))
    or (p_step='DETAILS' and (job.stage<>'EXPLANATION_SENT' or job.explanation_wamid is null or job.details_body is null)) then
    return jsonb_build_object('ready',false,'reason','STATE_CONFLICT'); end if;
  due:=case p_step when 'LINK' then job.link_due_at when 'EXPLANATION' then job.explanation_due_at else job.details_due_at end;
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
    'hasDetails',job.details_body is not null,
    'body',case p_step when 'LINK' then job.link_body when 'EXPLANATION' then job.explanation_body else job.details_body end);
end $$;

create or replace function public.panel_whatsapp_auto_options_advance(
  p_environment public.panel_environment,p_job uuid,p_stage text,p_wamid text default null,p_error text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; valid jsonb; changed jsonb; sent_at timestamptz:=clock_timestamp(); due timestamptz; details_due timestamptz;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment for update;
  if not found then return jsonb_build_object('updated',false); end if;
  if job.scheduled_at is not null and p_stage in ('LINK_SENDING','EXPLANATION_SENDING','DETAILS_SENDING') then
    valid:=public.panel_whatsapp_auto_options_step_context(p_environment,p_job,case p_stage when 'LINK_SENDING' then 'LINK' when 'EXPLANATION_SENDING' then 'EXPLANATION' else 'DETAILS' end);
    if not coalesce((valid->>'ready')::boolean,false) then return valid||jsonb_build_object('updated',false); end if;
  end if;
  changed:=public.panel_whatsapp_auto_options_advance_v1(p_environment,p_job,p_stage,p_wamid,p_error);
  if not coalesce((changed->>'updated')::boolean,false) then return changed; end if;
  if job.scheduled_at is not null then
    update public.whatsapp_auto_options set
      link_send_started_at=case when p_stage='LINK_SENDING' then sent_at else link_send_started_at end,
      explanation_send_started_at=case when p_stage='EXPLANATION_SENDING' then sent_at else explanation_send_started_at end,
      details_send_started_at=case when p_stage='DETAILS_SENDING' then sent_at else details_send_started_at end,
      link_sent_at=case when p_stage='LINK_SENT' then coalesce(link_sent_at,sent_at) else link_sent_at end,
      explanation_due_at=case when p_stage='LINK_SENT' then coalesce(explanation_due_at,sent_at+interval '35 seconds') else explanation_due_at end,
      explanation_sent_at=case when p_stage='EXPLANATION_SENT' then coalesce(explanation_sent_at,sent_at) else explanation_sent_at end,
      details_due_at=case when p_stage='EXPLANATION_SENT' then coalesce(details_due_at,sent_at+interval '25 seconds') else details_due_at end
      where id=p_job returning explanation_due_at,details_due_at into due,details_due;
  end if;
  return changed||jsonb_build_object('explanationDueAt',due,'detailsDueAt',details_due);
end $$;

create or replace function public.panel_whatsapp_auto_options_timer_queued(p_environment public.panel_environment,p_job uuid,p_step text)
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
    details_queued_at=case when p_step='DETAILS' then coalesce(details_queued_at,clock_timestamp()) else details_queued_at end,
    updated_at=clock_timestamp()
    where id=p_job and environment=p_environment and scheduled_at is not null
      and ((p_step='LINK' and stage='CLAIMED') or (p_step='EXPLANATION' and stage='LINK_SENT') or (p_step='DETAILS' and stage='EXPLANATION_SENT'));
  return jsonb_build_object('updated',found);
end $$;

-- Recovery republishes only timers with no publication receipt; it never sends WhatsApp messages.
create or replace function public.panel_whatsapp_auto_options_pending_timers(p_environment public.panel_environment)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare timers jsonb;
begin
  update public.whatsapp_auto_options set stage='FAILED',error_code='TIMER_EXPIRED',updated_at=clock_timestamp()
    where environment=p_environment and scheduled_at is not null and stage in ('CLAIMED','LINK_SENT','EXPLANATION_SENT')
      and clock_timestamp()>case stage when 'CLAIMED' then link_due_at when 'LINK_SENT' then explanation_due_at else details_due_at end+interval '5 minutes';
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'step',t.step,'dueAt',t.due)), '[]'::jsonb) into timers from (
    select a.id,case a.stage when 'CLAIMED' then 'LINK' when 'LINK_SENT' then 'EXPLANATION' else 'DETAILS' end step,
      case a.stage when 'CLAIMED' then a.link_due_at when 'LINK_SENT' then a.explanation_due_at else a.details_due_at end due
    from public.whatsapp_auto_options a where a.environment=p_environment and a.scheduled_at is not null
      and ((a.stage='CLAIMED' and a.link_queued_at is null) or (a.stage='LINK_SENT' and a.explanation_queued_at is null)
        or (a.stage='EXPLANATION_SENT' and a.details_queued_at is null))
    order by a.scheduled_at limit 8
  ) t;
  update public.whatsapp_options_timer_checks set requested_at=coalesce(requested_at,clock_timestamp())
    where environment=p_environment and queued_at is null and received_at is null;
  select timers||coalesce(jsonb_agg(jsonb_build_object('id',c.id,'step','PROBE','seconds',c.delay_seconds,
    'requestedAt',floor(extract(epoch from c.requested_at)*1000))), '[]'::jsonb) into timers
    from public.whatsapp_options_timer_checks c where c.environment=p_environment and c.queued_at is null and c.received_at is null;
  return timers;
end $$;

-- The third message is marked automatic like the other two (same exact text, recipient and send window).
create or replace function public.panel_whatsapp_auto_options_message_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.direction='MCS' and new.channel='WHATSAPP' and new.source_kind='WHATSAPP_WEBHOOK' and exists(
    select 1 from public.whatsapp_auto_options a join public.chats ch on ch.id=new.chat_id and ch.environment=new.environment and ch.contact_id=a.contact_id
    where a.environment=new.environment and ((new.signature_base='WA:'||a.link_wamid and new.body_text=a.link_body)
      or (new.signature_base='WA:'||a.explanation_wamid and new.body_text=a.explanation_body)
      or (new.signature_base='WA:'||a.details_wamid and new.body_text=a.details_body)
      -- A live provider echo may precede the HTTP acknowledgement. Only the exact
      -- automation text, recipient and short active send window qualify. A copied
      -- manual URL has no automation label and never enters this branch.
      or (coalesce(case when a.link_wamid is null then a.link_send_started_at when a.explanation_wamid is null then a.explanation_send_started_at else a.details_send_started_at end,a.claimed_at)>=now()-interval '2 minutes'
        and new.occurred_at_utc between coalesce(case when a.link_wamid is null then a.link_send_started_at when a.explanation_wamid is null then a.explanation_send_started_at else a.details_send_started_at end,a.claimed_at)-interval '2 seconds' and now()+interval '2 seconds'
        and new.signature_base like 'WA:%' and
        ((a.link_wamid is null and a.stage in ('LINK_SENDING','FAILED') and new.body_text=a.link_body)
          or (a.link_wamid is not null and a.explanation_wamid is null and a.stage in ('EXPLANATION_SENDING','FAILED') and new.body_text=a.explanation_body)
          or (a.explanation_wamid is not null and a.details_wamid is null and a.stage in ('DETAILS_SENDING','FAILED') and new.body_text=a.details_body))))) then new.is_automatic:=true; end if;
  return new;
end $$;
