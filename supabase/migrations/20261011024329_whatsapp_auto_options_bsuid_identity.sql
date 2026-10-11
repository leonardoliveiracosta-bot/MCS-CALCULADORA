-- Additive recipient verification; preserve the applied migration and existing message RPC.
create or replace function public.panel_whatsapp_auto_options_context(
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
  if exists(select 1 from public.whatsapp_auto_options a where a.environment=p_environment and a.ref_code=p_ref and a.logical_mode::text=p_mode) then
    return jsonb_build_object('eligible',false,'reason','ALREADY_CLAIMED');
  end if;
  return jsonb_build_object('eligible',true,'key','journey:'||p_journey::text||':'||p_mode,
    'language',coalesce(nullif(calculator.idioma,''),calculator.dados->>'idioma','en'));
end $$;
