-- Quick call result and undo are each one transaction, serialized per journey.
create or replace function public.panel_quick_result(p_environment public.panel_environment,p_actor uuid,p_ref text,p_journey uuid,p_type text,p_due timestamptz,p_operation uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.journeys%rowtype; prior jsonb; interaction_id uuid; event_id uuid; at_time timestamptz:=clock_timestamp();
  interaction_type public.panel_interaction_type; label_text text;
begin
 if p_operation is null or p_type not in ('ANSWERED','NO_ANSWER','LATER','IN_PERSON','DEPOSIT') then raise exception 'QUICK_RESULT_INVALID'; end if;
 select * into j from public.journeys where environment=p_environment and id=p_journey for update;
 if not found or (j.reference_code<>p_ref and not exists(select 1 from public.journey_refs where environment=p_environment and journey_id=j.id and ref_code=p_ref)) then raise exception 'JOURNEY_REF_MISMATCH'; end if;
 select id into event_id from public.lead_events where environment=p_environment and ref_code=p_ref and detail_json->>'operationId'=p_operation::text and event_type like 'QUICK_%' limit 1;
 if event_id is not null then return jsonb_build_object('eventId',event_id,'duplicate',true); end if;
 prior=jsonb_build_object('stage',j.stage,'status',j.status,'qualified_at',j.qualified_at,'next_action_at',j.next_action_at,'next_action_text',j.next_action_text,
   'next_action_missing_since',j.next_action_missing_since,'last_effective_contact_at',j.last_effective_contact_at);
 interaction_type=case when p_type in ('NO_ANSWER','LATER') then 'CALL_ATTEMPT'::public.panel_interaction_type
   when p_type='IN_PERSON' then 'IN_PERSON'::public.panel_interaction_type else 'CALL_ANSWERED'::public.panel_interaction_type end;
 label_text=case p_type when 'ANSWERED' then 'Atendeu' when 'NO_ANSWER' then 'Não atendeu' when 'LATER' then 'Pediu para ligar depois' when 'IN_PERSON' then 'Conversa presencial' else 'Vai pagar o depósito' end;
 insert into public.interactions(environment,journey_id,type,occurred_at,detail_text,next_action_at,created_at,created_by)
   values(p_environment,j.id,interaction_type,at_time,label_text,p_due,at_time,p_actor) returning id into interaction_id;
 update public.journeys set stage=case when p_type='DEPOSIT' then 'QUALIFICADO'::public.panel_journey_stage
     when p_type not in ('NO_ANSWER','LATER') and stage='NOVO' then 'RESPONDIDO'::public.panel_journey_stage else stage end,
   qualified_at=case when p_type='DEPOSIT' then coalesce(qualified_at,at_time) else qualified_at end,
   last_effective_contact_at=case when p_type in ('NO_ANSWER','LATER') then last_effective_contact_at else at_time end,
   next_action_at=coalesce(p_due,next_action_at),next_action_text=case when p_due is null then next_action_text else label_text end,
   next_action_missing_since=case when p_due is null then next_action_missing_since else null end,
   updated_at=at_time,updated_by=p_actor where id=j.id;
 insert into public.lead_events(environment,ref_code,journey_id,event_type,detail_json,occurred_at,created_by)
   values(p_environment,p_ref,j.id,'QUICK_'||p_type,jsonb_build_object('label',label_text,'interactionId',interaction_id,'snapshot',prior,'dueAt',p_due,'source','button','operationId',p_operation),at_time,p_actor)
   returning id into event_id;
 return jsonb_build_object('eventId',event_id,'undoUntil',at_time+interval '10 seconds','journeyId',j.id,'duplicate',false);
end $$;
revoke all on function public.panel_quick_result(public.panel_environment,uuid,text,uuid,text,timestamptz,uuid) from public,anon,authenticated;
grant execute on function public.panel_quick_result(public.panel_environment,uuid,text,uuid,text,timestamptz,uuid) to service_role;

create or replace function public.panel_undo_quick(p_environment public.panel_environment,p_ref text,p_journey uuid,p_event uuid,p_actor uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare j public.journeys%rowtype; e public.lead_events%rowtype; last_id uuid; snap jsonb;
begin
 select * into j from public.journeys where environment=p_environment and id=p_journey for update;
 if not found or (j.reference_code<>p_ref and not exists(select 1 from public.journey_refs where environment=p_environment and journey_id=j.id and ref_code=p_ref)) then raise exception 'JOURNEY_REF_MISMATCH'; end if;
 select * into e from public.lead_events where environment=p_environment and ref_code=p_ref and id=p_event and undone_at is null for update;
 if not found or e.event_type not like 'QUICK_%' or clock_timestamp()-e.occurred_at>interval '10 seconds' then raise exception 'UNDO_EXPIRED'; end if;
 select id into last_id from public.lead_events where environment=p_environment and ref_code=p_ref order by occurred_at desc,id desc limit 1;
 if last_id<>p_event then raise exception 'UNDO_NOT_LATEST'; end if;
 snap=e.detail_json->'snapshot';
 update public.journeys set stage=(snap->>'stage')::public.panel_journey_stage,status=(snap->>'status')::public.panel_journey_status,
   qualified_at=(snap->>'qualified_at')::timestamptz,next_action_at=(snap->>'next_action_at')::timestamptz,next_action_text=snap->>'next_action_text',
   next_action_missing_since=(snap->>'next_action_missing_since')::timestamptz,last_effective_contact_at=(snap->>'last_effective_contact_at')::timestamptz,
   updated_at=clock_timestamp(),updated_by=p_actor where id=j.id;
 update public.lead_events set undone_at=clock_timestamp() where id=e.id;
 update public.interactions set detail_text='Desfeito' where environment=p_environment and journey_id=j.id and id=(e.detail_json->>'interactionId')::uuid;
 return jsonb_build_object('undone',true);
end $$;
revoke all on function public.panel_undo_quick(public.panel_environment,text,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.panel_undo_quick(public.panel_environment,text,uuid,uuid,uuid) to service_role;
