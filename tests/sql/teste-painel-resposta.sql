-- Resposta enviada pelo painel: a RPC real grava MCS, não automática, source_kind PANEL,
-- no mesmo chat 'wa:<telefone>' e na ficha da referência; conta como resposta efetiva.
do $$
declare
  raw_id uuid:=gen_random_uuid(); v_contact uuid:=gen_random_uuid(); other_journey uuid:=gen_random_uuid(); v_journey uuid:=gen_random_uuid();
  v_chat uuid:=gen_random_uuid(); result jsonb; msg public.messages%rowtype; linked uuid; stage_now text; chats_count integer;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(v_contact,'preview','Painel','WHATSAPP_DIRECT',now(),now());
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview',v_contact,'+13055550199','+13055550199',true,true,now());
  insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values
    (v_journey,'preview',v_contact,'PNLAB','CALCULATOR','NOVO','ATIVO','{}',now()-interval '2 days',now()),
    (other_journey,'preview',v_contact,null,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at)
    values(v_chat,'preview','WHATSAPP',v_contact,'wa:+13055550199','RESOLVED',false,now(),now(),now(),now());
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status)
    values(raw_id,'preview','panel-send:'||gen_random_uuid(),'PANEL_SEND','{}','DONE');

  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object('messageId','wamid.PANEL1','phone','+13055550199','name','Painel',
    'forceContactId',v_contact,'direction','MCS','body','Hey, the car is ready.','timestamp',extract(epoch from now())::bigint::text,'refs',jsonb_build_array('PNLAB'),'source_kind','PANEL'));
  select * into msg from public.messages m where m.id=(result->>'messageId')::uuid;
  if msg.direction<>'MCS' or msg.is_automatic or msg.source_kind<>'PANEL' or msg.chat_id<>v_chat or msg.body_text<>'Hey, the car is ready.' then
    raise exception 'PANEL reply row wrong: % % % %',msg.direction,msg.is_automatic,msg.source_kind,msg.chat_id;
  end if;
  select l.journey_id into linked from public.message_journeys l where l.message_id=msg.id;
  if linked<>v_journey then raise exception 'PANEL reply linked to wrong journey %',linked; end if;
  select stage into stage_now from public.journeys j where j.id=v_journey;
  if stage_now<>'RESPONDIDO' then raise exception 'PANEL reply did not count as effective reply: %',stage_now; end if;
  perform public.panel_refresh_effective_mcs('preview',v_journey);
  if (select last_effective_contact_at from public.journeys j where j.id=v_journey) is null then raise exception 'PANEL reply not an effective MCS contact'; end if;
  select count(*) into chats_count from public.chats c where c.contact_id=v_contact and c.environment='preview';
  if chats_count<>1 then raise exception 'PANEL reply created another chat'; end if;
  -- um eco posterior com o mesmo wamid não duplica
  result:=public.panel_whatsapp_apply_message('preview',raw_id,jsonb_build_object('messageId','wamid.PANEL1','phone','+13055550199','direction','MCS','body','Hey, the car is ready.','timestamp',extract(epoch from now())::bigint::text,'source_kind','WHATSAPP_WEBHOOK'));
  if (result->>'duplicate')::boolean is not true then raise exception 'PANEL reply echo duplicated'; end if;
  raise notice 'OK: resposta pelo painel grava MCS/PANEL não automática na ficha certa';
end $$;
