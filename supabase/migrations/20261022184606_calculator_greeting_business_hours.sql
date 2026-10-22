-- The short invitation remains an automatic message, never a human reply or a sales-stage advance.
insert into public.panel_automatic_messages(environment,body_normalized,enabled)
select environment,lower(trim(regexp_replace($message$We help you buy where dealers buy. Start here to estimate your total cost or tell us which car to find:

https://mycarscout.net/msc-calculadora.html$message$,'\s+',' ','g'))),true
from unnest(enum_range(null::public.panel_environment)) environment
on conflict(environment,body_normalized) do update set enabled=true;

-- Only a contact with no identified calculator request receives the calculator invitation.
create or replace function public.panel_whatsapp_has_calculator_request(p_environment public.panel_environment,p_contact uuid)
returns boolean language sql stable security invoker set search_path='' as $$
  select exists(
    select 1 from public.messages m join public.chats ch on ch.id=m.chat_id and ch.environment=p_environment
    where ch.contact_id=p_contact and m.environment=p_environment and m.direction='CUSTOMER'
      and m.body_text ~* 'My Car Scout' and m.body_text ~* '(vehicle search request|calculate my cost|find one for me|maximum bid|year range|mileage range|FIND|lance máximo|faixa de anos|rango de años|financing request)'
  ) or exists(
    select 1 from public.journeys j join public.calc_runs cr on not cr.is_test and upper(cr.dados->>'ref')=j.reference_code
    where j.environment=p_environment and j.contact_id=p_contact
  ) or exists(
    select 1 from public.journeys j join public.journey_refs r on r.environment=p_environment and r.journey_id=j.id
    join public.calc_runs cr on not cr.is_test and upper(cr.dados->>'ref')=r.ref_code
    where j.environment=p_environment and j.contact_id=p_contact
  );
$$;
-- Eastern local time follows Florida daylight-saving changes automatically. Every day, 09:00 inclusive / 18:00 exclusive.
create or replace function public.panel_whatsapp_next_send_at(p_at timestamptz)
returns timestamptz language sql immutable strict security invoker set search_path='' as $$
  select case
    when (p_at at time zone 'America/New_York')::time < time '09:00' then ((p_at at time zone 'America/New_York')::date+time '09:00') at time zone 'America/New_York'
    when (p_at at time zone 'America/New_York')::time >= time '18:00' then (((p_at at time zone 'America/New_York')::date+1)+time '09:00') at time zone 'America/New_York'
    else p_at end;
$$;
-- Rescheduling changes only the pending timer. Existing eligibility, 24-hour and duplicate-send checks remain in force.
create or replace function public.panel_whatsapp_options_business_due(p_environment public.panel_environment,p_job uuid,p_step text,p_now timestamptz default clock_timestamp())
returns jsonb language plpgsql security invoker set search_path='' as $$
declare job public.whatsapp_auto_options%rowtype; due timestamptz; adjusted timestamptz; stamp timestamptz:=p_now;
begin
  select * into job from public.whatsapp_auto_options where environment=p_environment and id=p_job for update;
  if not found or job.scheduled_at is null or not (
    (p_step='LINK' and job.stage='CLAIMED') or (p_step='EXPLANATION' and job.stage='LINK_SENT') or (p_step='DETAILS' and job.stage='EXPLANATION_SENT')
  ) then return jsonb_build_object('deferred',false); end if;
  due:=case p_step when 'LINK' then job.link_due_at when 'EXPLANATION' then job.explanation_due_at else job.details_due_at end;
  if due is null then return jsonb_build_object('deferred',false); end if;
  adjusted:=public.panel_whatsapp_next_send_at(due);
  -- A timely callback crossing 18:00 waits until 09:00. An already stale in-hours callback is never revived.
  if stamp<=due+interval '5 minutes' and public.panel_whatsapp_next_send_at(stamp)<>stamp then adjusted:=greatest(adjusted,public.panel_whatsapp_next_send_at(stamp)); end if;
  if adjusted<>due then
    update public.whatsapp_auto_options set link_due_at=case when p_step='LINK' then adjusted else link_due_at end,
      explanation_due_at=case when p_step='EXPLANATION' then adjusted else explanation_due_at end,
      details_due_at=case when p_step='DETAILS' then adjusted else details_due_at end,
      link_queued_at=case when p_step='LINK' then null else link_queued_at end,
      explanation_queued_at=case when p_step='EXPLANATION' then null else explanation_queued_at end,
      details_queued_at=case when p_step='DETAILS' then null else details_queued_at end,updated_at=stamp
      where id=job.id;
  end if;
  return jsonb_build_object('dueAt',adjusted,'deferred',adjusted<>due);
end $$;
-- Keep creation and its first business-hours timer in one transaction (no overnight expiry between calls).
create or replace function public.panel_whatsapp_auto_options_schedule_business(
  p_environment public.panel_environment,p_job uuid,p_raw uuid,p_phone text,p_user_id text,p_greeting_wamid text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare answer jsonb; business jsonb;
begin
  answer:=public.panel_whatsapp_auto_options_schedule(p_environment,p_job,p_raw,p_phone,p_user_id,p_greeting_wamid);
  if coalesce((answer->>'scheduled')::boolean,false) then
    business:=public.panel_whatsapp_options_business_due(p_environment,p_job,'LINK');
    if business->>'dueAt' is not null then answer:=answer||jsonb_build_object('dueAt',business->'dueAt'); end if;
  end if;
  return answer;
end $$;
revoke all on function public.panel_whatsapp_has_calculator_request(public.panel_environment,uuid) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_next_send_at(timestamptz) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_options_business_due(public.panel_environment,uuid,text,timestamptz) from public,anon,authenticated;
revoke all on function public.panel_whatsapp_auto_options_schedule_business(public.panel_environment,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_has_calculator_request(public.panel_environment,uuid) to service_role;
grant execute on function public.panel_whatsapp_next_send_at(timestamptz) to service_role;
grant execute on function public.panel_whatsapp_options_business_due(public.panel_environment,uuid,text,timestamptz) to service_role;
grant execute on function public.panel_whatsapp_auto_options_schedule_business(public.panel_environment,uuid,uuid,text,text,text) to service_role;
