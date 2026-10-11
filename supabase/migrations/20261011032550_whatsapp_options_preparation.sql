-- Prepare a new calculator demand independently of panel opening. Only insert missing
-- rows; no selections, prices, matches, uploads or manual functions are overwritten.
create function public.panel_whatsapp_auto_options_add_matches(
  p_environment public.panel_environment,p_job uuid,p_upload uuid,p_matches jsonb
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; valid jsonb; added integer; key text;
begin
  select * into job from public.whatsapp_auto_options where environment=p_environment and id=p_job for update;
  valid:=public.panel_whatsapp_auto_options_step_context(p_environment,p_job,'LINK');
  if not coalesce((valid->>'ready')::boolean,false) then return jsonb_build_object('reason',coalesce(valid->>'reason','STATE_CONFLICT')); end if;
  key:=valid->>'key';
  perform 1 from public.manheim_uploads where environment=p_environment and id=p_upload
    and activated_at is not null and undone_at is null for share;
  if not found or p_upload is distinct from (select id from public.manheim_uploads where environment=p_environment
      and activated_at is not null and undone_at is null order by uploaded_at desc limit 1) then
    raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if jsonb_typeof(p_matches) is distinct from 'array' or jsonb_array_length(p_matches)>20000 then raise exception 'MANHEIM_MATCH_INVALID'; end if;
  if exists(select 1 from jsonb_array_elements(p_matches) n where
    coalesce(n.value->>'demandKey','')<>key or coalesce(n.value->>'mode','')<>job.logical_mode::text
    or coalesce(n.value->>'kind','') not in ('BATE','POR_VALOR')
    or (job.logical_mode='CARRO' and n.value->>'kind'<>'BATE')
    or (job.logical_mode='VALOR' and coalesce(n.value#>>'{vehicle,parsed,matchNear}','')='true')
    or jsonb_typeof(n.value->'vehicle') is distinct from 'object'
    or length(coalesce(n.value->>'fingerprint','')) not between 3 and 200
    or not coalesce((n.value->>'mmrCents') ~ '^[0-9]{1,9}$' and (n.value->>'mmrCents')::integer>0,false)
    or not exists(select 1 from public.manheim_vehicles v where v.environment=p_environment
      and v.upload_id=p_upload and v.undone_at is null and v.row_fingerprint=n.value->>'fingerprint')) then
    raise exception 'MANHEIM_MATCH_INVALID'; end if;
  insert into public.manheim_matches(environment,upload_id,journey_id,calc_ref,match_kind,match_reason,mmr_status,
    row_fingerprint,vehicle_json,logical_mode,created_at,demand_key,sort_rank,sort_miles,vin,wish_index,mmr_cents,criteria_hash)
  select p_environment,p_upload,job.journey_id,null,n.value->>'kind',nullif(left(n.value->>'reason',500),''),
    case when n.value->>'mmrStatus' in ('MMR acima do teto','MMR dentro do teto') then n.value->>'mmrStatus' else null end,
    n.value->>'fingerprint',n.value->'vehicle',job.logical_mode,clock_timestamp(),key,
    case when (n.value->>'sortRank') ~ '^[0-9]{1,2}$' then (n.value->>'sortRank')::smallint else 9 end,
    case when (n.value->>'sortMiles') ~ '^[0-9]{1,10}$' and (n.value->>'sortMiles')::bigint<=2147483647 then (n.value->>'sortMiles')::integer else 2147483647 end,
    nullif(left(upper(coalesce(n.value->>'vin','')),40),''),
    case when (n.value->>'wishIndex') ~ '^[0-9]$' then (n.value->>'wishIndex')::smallint else null end,
    (n.value->>'mmrCents')::integer,nullif(left(n.value->>'criteriaHash',64),'')
  from jsonb_array_elements(p_matches) n
  on conflict(environment,upload_id,journey_id,row_fingerprint,logical_mode) where journey_id is not null do nothing;
  get diagnostics added=row_count;
  insert into public.audit_log(environment,entity_type,entity_id,action,after_json)
    values(p_environment,'whatsapp_auto_options',job.id,'PREPARE_OPTIONS',jsonb_build_object('uploadId',p_upload,'added',added));
  return jsonb_build_object('added',added);
end $$;
revoke all on function public.panel_whatsapp_auto_options_add_matches(public.panel_environment,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_add_matches(public.panel_environment,uuid,uuid,jsonb) to service_role;

-- Explicit service-only recovery for an individually approved missed delivery. No
-- cron scans old messages. Normal live eligibility retains its ten-minute limit.
alter table public.whatsapp_auto_options add column recovery_authorized_at timestamptz, add column recovery_note text;
do $$
declare definition text; marker text:='and m.occurred_at_utc between now()-interval ''10 minutes'' and now()+interval ''2 minutes'';';
begin
  select pg_get_functiondef('public.panel_whatsapp_auto_options_eligibility(public.panel_environment,uuid,uuid,uuid,text,text,text,text,text,uuid)'::regprocedure) into definition;
  if position(marker in definition)=0 then raise exception 'AUTO_OPTIONS_ELIGIBILITY_MARKER_MISSING'; end if;
  execute replace(definition,marker,$replacement$and m.occurred_at_utc between
    now()-case when p_job is not null and exists(select 1 from public.whatsapp_auto_options a
      where a.id=p_job and a.environment=p_environment and a.recovery_authorized_at>=now()-interval '10 minutes')
      then interval '24 hours' else interval '10 minutes' end and now()+interval '2 minutes';$replacement$);
end $$;

create function public.panel_whatsapp_auto_options_recover(
  p_environment public.panel_environment,p_inbound_message uuid,p_link text,p_explanation text,p_note text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare inbound record; job_id uuid; valid jsonb; key text; ref text; mode text; phone text; bsuid text;
begin
  if length(trim(coalesce(p_note,''))) not between 10 and 500 then raise exception 'RECOVERY_NOTE_REQUIRED'; end if;
  select m.*,ch.contact_id,ch.canonical_key,w.wa_message_id,w.raw_event_id,mj.journey_id into inbound
    from public.messages m join public.chats ch on ch.id=m.chat_id and ch.environment=p_environment
    join public.whatsapp_message_ids w on w.message_id=m.id and w.environment=p_environment
    join public.message_journeys mj on mj.message_id=m.id and mj.environment=p_environment and mj.undone_at is null
    where m.id=p_inbound_message and m.environment=p_environment and m.direction='CUSTOMER'
      and m.source_kind='WHATSAPP_WEBHOOK' and m.occurred_at_utc>=now()-interval '24 hours';
  if not found then raise exception 'RECOVERY_INBOUND_INVALID'; end if;
  if (select count(*) from regexp_matches(inbound.body_text,'Ref:[[:space:]]*[A-HJ-NP-Z2-9]{5}','gi'))<>1 then
    raise exception 'RECOVERY_INBOUND_INVALID'; end if;
  select (regexp_match(inbound.body_text,'(^|[^A-Za-z0-9])Ref:[[:space:]]*([A-HJ-NP-Z2-9]{5})([^A-Za-z0-9]|$)','i'))[2] into ref;
  mode:=case when inbound.body_text ~* '(FIND|year range|mileage range|faixa de anos|faixa de milhas|rango de años|solicitação de busca|search request)' then 'CARRO' else 'VALOR' end;
  key:='journey:'||inbound.journey_id::text||':'||mode;
  perform pg_advisory_xact_lock(hashtext(p_environment::text||':auto-options:'||ref||':'||mode));
  if exists(select 1 from public.whatsapp_auto_options a where a.environment=p_environment and a.ref_code=ref and a.logical_mode::text=mode) then
    return jsonb_build_object('recovered',false,'reason','ALREADY_CLAIMED'); end if;
  if inbound.canonical_key like 'wa:+%' then phone:=substr(inbound.canonical_key,4);
  elsif inbound.canonical_key like 'wa-user:%' then bsuid:=substr(inbound.canonical_key,9);
  else raise exception 'RECOVERY_INBOUND_INVALID'; end if;
  if p_link !~ E'^(Current options|Opções atuais|Opciones actuales):\nhttps://www[.]mycarscout[.]net/o/[A-Za-z0-9_-]{32,80}$'
    or length(p_explanation) not between 30 and 2000 or not exists(select 1 from public.panel_option_links l
      where l.environment=p_environment and l.demand_key=key and split_part(p_link,E'\n',2)='https://www.mycarscout.net/o/'||l.public_code) then raise exception 'LINK_INVALID'; end if;
  if not exists(select 1 from public.whatsapp_auto_replies a where a.environment=p_environment and a.contact_id=inbound.contact_id
      and a.inbound_wa_message_id=inbound.wa_message_id and a.status='SENT') then raise exception 'GREETING_NOT_READY'; end if;
  if exists(select 1 from public.messages m join public.chats ch on ch.id=m.chat_id and ch.environment=p_environment and ch.contact_id=inbound.contact_id
    where m.environment=p_environment and m.created_at>=inbound.created_at and ((m.direction='MCS' and not m.is_automatic)
      or (m.direction='CUSTOMER' and m.id<>p_inbound_message and m.body_text ~* 'Ref:[[:space:]]*[A-HJ-NP-Z2-9]{5}'))) then
    raise exception 'RECOVERY_CONVERSATION_CHANGED'; end if;
  insert into public.whatsapp_auto_options(environment,contact_id,journey_id,ref_code,logical_mode,inbound_message_id,
    inbound_wamid,link_body,explanation_body,recipient_phone,recipient_user_id,raw_event_id,scheduled_at,link_due_at,recovery_authorized_at,recovery_note)
  values(p_environment,inbound.contact_id,inbound.journey_id,ref,mode::public.panel_logical_mode,p_inbound_message,inbound.wa_message_id,
    p_link,p_explanation,phone,bsuid,inbound.raw_event_id,clock_timestamp(),clock_timestamp(),clock_timestamp(),trim(p_note)) returning id into job_id;
  valid:=public.panel_whatsapp_auto_options_step_context(p_environment,job_id,'LINK');
  if not coalesce((valid->>'ready')::boolean,false) then raise exception 'RECOVERY_NOT_ELIGIBLE'; end if;
  insert into public.audit_log(environment,entity_type,entity_id,action,after_json)
    values(p_environment,'whatsapp_auto_options',job_id,'RECOVER_MISSED_OPTIONS',jsonb_build_object('note',trim(p_note)));
  return jsonb_build_object('recovered',true,'jobId',job_id);
end $$;
revoke all on function public.panel_whatsapp_auto_options_recover(public.panel_environment,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_auto_options_recover(public.panel_environment,uuid,text,text,text) to service_role;
