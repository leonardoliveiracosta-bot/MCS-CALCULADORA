-- Additive, service-only, once per calculator request. No customer history is backfilled.
create table public.whatsapp_auto_options (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  contact_id uuid not null references public.contacts(id),
  journey_id uuid not null references public.journeys(id),
  ref_code text not null check (ref_code ~ '^[A-HJ-NP-Z2-9]{5}$'),
  logical_mode public.panel_logical_mode not null,
  inbound_message_id uuid not null references public.messages(id),
  inbound_wamid text not null,
  link_body text not null,
  explanation_body text not null,
  stage text not null default 'CLAIMED' check (stage in ('CLAIMED','LINK_SENDING','LINK_SENT','EXPLANATION_SENDING','COMPLETE','FAILED')),
  link_wamid text,
  explanation_wamid text,
  error_code text,
  claimed_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(environment,ref_code,logical_mode)
);
create index whatsapp_auto_options_link_wamid_idx on public.whatsapp_auto_options(environment,link_wamid) where link_wamid is not null;
create index whatsapp_auto_options_explanation_wamid_idx on public.whatsapp_auto_options(environment,explanation_wamid) where explanation_wamid is not null;
create index whatsapp_auto_options_contact_idx on public.whatsapp_auto_options(contact_id,environment,claimed_at desc);
create index whatsapp_auto_options_journey_idx on public.whatsapp_auto_options(journey_id);
create index whatsapp_auto_options_inbound_idx on public.whatsapp_auto_options(inbound_message_id);
alter table public.whatsapp_auto_options enable row level security;
alter table public.whatsapp_auto_options force row level security;
revoke all on public.whatsapp_auto_options from public,anon,authenticated;
grant select,insert,update on public.whatsapp_auto_options to service_role;

create function public.panel_whatsapp_auto_options_context(
  p_environment public.panel_environment,p_contact uuid,p_journey uuid,p_inbound_message uuid,
  p_inbound_wamid text,p_ref text,p_mode text,p_phone text default null,p_user_id text default null
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
  if exists(select 1 from public.whatsapp_auto_options a where a.environment=p_environment and a.ref_code=p_ref and a.logical_mode::text=p_mode) then
    return jsonb_build_object('eligible',false,'reason','ALREADY_CLAIMED');
  end if;
  return jsonb_build_object('eligible',true,'key','journey:'||p_journey::text||':'||p_mode,
    'language',coalesce(nullif(calculator.idioma,''),calculator.dados->>'idioma','en'));
end $$;

create function public.panel_whatsapp_auto_options_claim(
  p_environment public.panel_environment,p_contact uuid,p_journey uuid,p_inbound_message uuid,
  p_inbound_wamid text,p_ref text,p_mode text,p_phone text,p_user_id text,p_link text,p_explanation text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare context jsonb; job_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_environment::text||':auto-options:'||p_ref||':'||p_mode));
  context:=public.panel_whatsapp_auto_options_context(p_environment,p_contact,p_journey,p_inbound_message,p_inbound_wamid,p_ref,p_mode,p_phone,p_user_id);
  if not coalesce((context->>'eligible')::boolean,false) then return context||jsonb_build_object('claimed',false); end if;
  if p_link !~ E'^(Current options|Opções atuais|Opciones actuales):\nhttps://www[.]mycarscout[.]net/o/[A-Za-z0-9_-]{32,80}$'
    or length(p_explanation) not between 30 and 2000 or not exists(select 1 from public.panel_option_links l
      where l.environment=p_environment and l.demand_key=context->>'key' and split_part(p_link,E'\n',2)='https://www.mycarscout.net/o/'||l.public_code) then
    return jsonb_build_object('claimed',false,'reason','LINK_INVALID');
  end if;
  insert into public.whatsapp_auto_options(environment,contact_id,journey_id,ref_code,logical_mode,inbound_message_id,inbound_wamid,link_body,explanation_body)
    values(p_environment,p_contact,p_journey,p_ref,p_mode::public.panel_logical_mode,p_inbound_message,p_inbound_wamid,p_link,p_explanation)
    on conflict(environment,ref_code,logical_mode) do nothing returning id into job_id;
  if job_id is null then return jsonb_build_object('claimed',false,'reason','ALREADY_CLAIMED'); end if;
  return jsonb_build_object('claimed',true,'id',job_id);
end $$;

create function public.panel_whatsapp_auto_options_advance(
  p_environment public.panel_environment,p_job uuid,p_stage text,p_wamid text default null,p_error text default null
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; msg record;
begin
  select * into job from public.whatsapp_auto_options where id=p_job and environment=p_environment for update;
  if not found then return jsonb_build_object('updated',false); end if;
  if not ((p_stage='LINK_SENDING' and job.stage='CLAIMED')
    or (p_stage='LINK_SENT' and job.stage in ('LINK_SENDING','LINK_SENT') and length(p_wamid) between 2 and 256)
    or (p_stage='EXPLANATION_SENDING' and job.stage='LINK_SENT' and job.link_wamid is not null)
    or (p_stage='COMPLETE' and job.stage in ('EXPLANATION_SENDING','COMPLETE') and length(p_wamid) between 2 and 256)
    or (p_stage='FAILED' and job.stage<>'COMPLETE')) then return jsonb_build_object('updated',false); end if;
  if p_stage in ('LINK_SENDING','EXPLANATION_SENDING') and (not exists(select 1 from public.journeys j
    join public.contacts c on c.id=j.contact_id and c.environment=j.environment and c.is_lead
    where j.id=job.journey_id and j.environment=p_environment and j.status='ATIVO')
    or exists(select 1 from public.journey_toggle_states t where t.environment=p_environment and t.journey_id=job.journey_id and not t.enabled)) then
    return jsonb_build_object('updated',false);
  end if;
  update public.whatsapp_auto_options set stage=p_stage,
    link_wamid=case when p_stage='LINK_SENT' then p_wamid else link_wamid end,
    explanation_wamid=case when p_stage='COMPLETE' then p_wamid else explanation_wamid end,
    error_code=coalesce(left(nullif(p_error,''),120),error_code),updated_at=now() where id=p_job;
  -- The provider echo can arrive before its acknowledgement is saved. Repair only that exact id.
  if p_stage in ('LINK_SENT','COMPLETE') then
    for msg in select m.id from public.messages m join public.chats ch on ch.id=m.chat_id
      where m.environment=p_environment and ch.environment=p_environment and ch.contact_id=job.contact_id
        and m.direction='MCS' and m.signature_base='WA:'||p_wamid
        and m.body_text=case when p_stage='LINK_SENT' then job.link_body else job.explanation_body end
    loop perform public.panel_set_message_automatic(p_environment,msg.id,true); end loop;
  end if;
  return jsonb_build_object('updated',true);
end $$;

-- This additive trigger leaves the existing message RPC and all human-contact rules intact.
create function public.panel_whatsapp_auto_options_message_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.direction='MCS' and new.channel='WHATSAPP' and new.source_kind='WHATSAPP_WEBHOOK' and exists(
    select 1 from public.whatsapp_auto_options a join public.chats ch on ch.id=new.chat_id and ch.environment=new.environment and ch.contact_id=a.contact_id
    where a.environment=new.environment and ((new.signature_base='WA:'||a.link_wamid and new.body_text=a.link_body)
      or (new.signature_base='WA:'||a.explanation_wamid and new.body_text=a.explanation_body)
      -- A live provider echo may precede the HTTP acknowledgement. Only the exact
      -- automation text, recipient and short active send window qualify. A copied
      -- manual URL has no automation label and never enters this branch.
      or (a.claimed_at>=now()-interval '2 minutes' and new.occurred_at_utc between a.claimed_at-interval '2 seconds' and now()+interval '2 seconds'
        and new.signature_base like 'WA:%' and
        ((a.link_wamid is null and a.stage in ('LINK_SENDING','FAILED') and new.body_text=a.link_body)
          or (a.link_wamid is not null and a.explanation_wamid is null and a.stage in ('EXPLANATION_SENDING','FAILED') and new.body_text=a.explanation_body))))) then new.is_automatic:=true; end if;
  return new;
end $$;
create trigger messages_auto_options_before_insert before insert on public.messages
  for each row execute function public.panel_whatsapp_auto_options_message_trigger();

revoke all on function public.panel_whatsapp_auto_options_context(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_auto_options_claim(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,text,text) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_auto_options_advance(public.panel_environment,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_auto_options_message_trigger() from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_context(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text) to service_role;
grant execute on function public.panel_whatsapp_auto_options_claim(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,text,text) to service_role;
grant execute on function public.panel_whatsapp_auto_options_advance(public.panel_environment,uuid,text,text,text) to service_role;
