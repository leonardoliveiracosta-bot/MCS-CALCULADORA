-- Fix SQLSTATE 42702: the prior table alias j shadowed the journey row variable j.
create or replace function public.panel_sms_print_confirm(p_environment public.panel_environment,p_actor uuid,p_read uuid,p_target_journey uuid,p_keep_source boolean,p_phone text,p_name text,p_ref text,p_message text,p_translation text,p_attachment uuid,p_bucket text,p_storage_path text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare r public.sms_print_reads%rowtype; j public.journeys%rowtype; source_j public.journeys%rowtype; ref_j public.journeys%rowtype; c public.contacts%rowtype; chat_id uuid; msg_id uuid; attached_id uuid; chosen_ref text:=nullif(upper(trim(p_ref)), ''); phone text; at_time timestamptz:=clock_timestamp(); norm text;
begin
 if p_actor is null or p_read is null or p_attachment is null or p_bucket<>'mcs-panel-attachments' or p_storage_path not like 'panel/'||p_environment::text||'/%' or length(trim(coalesce(p_message,''))) not between 1 and 25000 then raise exception 'SMS_PRINT_INVALID'; end if;
 select * into r from public.sms_print_reads where id=p_read and environment=p_environment for update;
 if not found then raise exception 'SMS_PRINT_NOT_FOUND'; end if;
 if r.status='CONFIRMED' then return jsonb_build_object('journeyId',r.confirmed_journey_id,'contactId',r.confirmed_contact_id,'messageId',r.message_id,'attachmentId',r.attachment_id,'duplicate',true); end if;
 if r.status<>'READY' then raise exception 'SMS_PRINT_NOT_READY'; end if;
 phone:=public.panel_normalize_phone(p_phone); if phone is null then raise exception 'SMS_PRINT_PHONE_INVALID'; end if;
 if chosen_ref is not null and chosen_ref !~ '^[A-HJ-NP-Z2-9]{5}$' then raise exception 'SMS_PRINT_REF_INVALID'; end if;
 if r.source_journey_id is not null then select * into source_j from public.journeys where id=r.source_journey_id and environment=p_environment; end if;
 if chosen_ref is not null then
   select * into ref_j from public.journeys where environment=p_environment and reference_code=chosen_ref limit 1;
   if ref_j.id is null then
     select journey_row.* into ref_j from public.journey_refs ref_link join public.journeys journey_row on journey_row.id=ref_link.journey_id and journey_row.environment=ref_link.environment where ref_link.environment=p_environment and ref_link.ref_code=chosen_ref limit 1;
   end if;
 end if;
 if p_target_journey is not null then select * into j from public.journeys where id=p_target_journey and environment=p_environment for update; if j.id is null then raise exception 'SMS_PRINT_TARGET_INVALID'; end if;
 elsif source_j.id is not null and ref_j.id is not null and source_j.id<>ref_j.id and not p_keep_source then raise exception 'SMS_PRINT_REF_DECISION_REQUIRED';
 elsif source_j.id is not null then j:=source_j;
 elsif ref_j.id is not null then j:=ref_j;
 else
   insert into public.contacts(environment,display_name,source,created_at,updated_at,created_by,updated_by) values(p_environment,coalesce(nullif(trim(p_name),''),phone),'SMS_DIRECT',at_time,at_time,p_actor,p_actor) returning * into c;
   insert into public.journeys(environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at,created_by,updated_by) values(p_environment,c.id,chosen_ref,'SMS_DIRECT','NOVO','ATIVO','{}'::jsonb,at_time,at_time,p_actor,p_actor) returning * into j;
   insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) select p_environment,j.id,n,(array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[n],'OPEN'::public.panel_checklist_status,at_time,at_time from generate_series(1,6) n;
 end if;
 select * into c from public.contacts where id=j.contact_id and environment=p_environment for update;
 if exists(select 1 from public.contact_phones phone_row where phone_row.environment=p_environment and phone_row.phone_e164=phone and phone_row.contact_id<>c.id and phone_row.is_current and phone_row.retired_at is null) then raise exception 'SMS_PRINT_PHONE_CONFLICT'; end if;
 if not exists(select 1 from public.contact_phones phone_row where phone_row.environment=p_environment and phone_row.contact_id=c.id and phone_row.phone_e164=phone and phone_row.is_current and phone_row.retired_at is null) then insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,confirmed_at,created_at,created_by) values(p_environment,c.id,phone,phone,true,not exists(select 1 from public.contact_phones phone_row where phone_row.environment=p_environment and phone_row.contact_id=c.id and phone_row.is_current and phone_row.retired_at is null),at_time,at_time,p_actor); end if;
 if coalesce(trim(c.display_name),'')='' then update public.contacts set display_name=coalesce(nullif(trim(p_name),''),phone),updated_at=at_time,updated_by=p_actor where id=c.id; end if;
 if chosen_ref is not null and (j.reference_code is null or j.reference_code=chosen_ref) and not exists(select 1 from public.journey_refs ref_link where ref_link.environment=p_environment and ref_link.journey_id=j.id and ref_link.ref_code=chosen_ref) then update public.journeys set reference_code=coalesce(reference_code,chosen_ref),updated_at=at_time,updated_by=p_actor where id=j.id; insert into public.journey_refs(environment,journey_id,ref_code,created_at,created_by) values(p_environment,j.id,chosen_ref,at_time,p_actor) on conflict do nothing; end if;
 select id into chat_id from public.chats where environment=p_environment and channel='SMS' and canonical_key='sms:'||phone limit 1;
 if chat_id is not null and exists(select 1 from public.chats chat_row where chat_row.id=chat_id and chat_row.contact_id<>c.id) then raise exception 'SMS_PRINT_PHONE_CONFLICT'; end if;
 if chat_id is null then insert into public.chats(environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values(p_environment,'SMS',c.id,'sms:'||phone,'RESOLVED',false,at_time,at_time,at_time,at_time) returning id into chat_id; else update public.chats set contact_id=c.id,resolution_status='RESOLVED',last_seen_at=at_time,updated_at=at_time where id=chat_id; end if;
 norm:=lower(trim(regexp_replace(p_message,'\s+',' ','g')));
 insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at) values(p_environment,chat_id,'SMS','CUSTOMER',trim(p_message),norm,at_time,true,'SMS_PRINT:'||p_read::text,1,'SMS_PRINT',at_time) returning id into msg_id;
 insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at,associated_by) values(p_environment,msg_id,j.id,'SMS_PRINT',at_time,p_actor);
 insert into public.interactions(environment,journey_id,message_id,type,occurred_at,created_at,created_by) values(p_environment,j.id,msg_id,'INBOUND_MESSAGE',at_time,at_time,p_actor);
 insert into public.attachments(id,environment,contact_id,chat_id,journey_id,message_id,kind,bucket_name,storage_path,original_filename,mime_type,byte_size,sha256,verified_at,created_at,created_by) values(p_attachment,p_environment,c.id,chat_id,j.id,msg_id,'IMAGE',p_bucket,p_storage_path,r.original_filename,r.mime_type,r.byte_size,r.sha256,at_time,at_time,p_actor) returning id into attached_id;
 update public.sms_print_reads set status='CONFIRMED',storage_path=p_storage_path,confirmed_journey_id=j.id,confirmed_contact_id=c.id,message_id=msg_id,attachment_id=attached_id,updated_at=at_time,updated_by=p_actor where id=r.id;
 insert into public.activity_log(environment,journey_id,contact_id,chat_id,activity_type,summary,metadata,occurred_at,actor_user_id) values(p_environment,j.id,c.id,chat_id,'SMS_PRINT_CONFIRMED','Print de SMS confirmado',jsonb_build_object('readId',r.id,'attachmentId',attached_id,'translation',coalesce(p_translation,'')),at_time,p_actor);
 return jsonb_build_object('journeyId',j.id,'contactId',c.id,'messageId',msg_id,'attachmentId',attached_id,'duplicate',false);
end $$;
revoke all on function public.panel_sms_print_confirm(public.panel_environment,uuid,uuid,uuid,boolean,text,text,text,text,text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.panel_sms_print_confirm(public.panel_environment,uuid,uuid,uuid,boolean,text,text,text,text,text,uuid,text,text) to service_role;
