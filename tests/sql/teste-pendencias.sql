-- A execução é descartável: valida retomada, trava e limite do processamento geral.
begin;
do $$
declare c uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); m1 uuid:=gen_random_uuid(); m2 uuid:=gen_random_uuid();
  first_claim record; second_claim record; current_status text;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Pendências','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values(j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values(ch,'preview','WHATSAPP',c,'pending-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (m1,'preview',ch,'WHATSAPP','CUSTOMER','primeira','primeira',now()-interval '2 minutes','p1-'||m1,1,now()),
    (m2,'preview',ch,'WHATSAPP','MCS','segunda','segunda',now(),'p2-'||m2,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',m1,j,'TEST',now()),('preview',m2,j,'TEST',now());

  perform public.panel_pending_start_general_read('preview',jsonb_build_array(jsonb_build_object('journeyId',j,'chatId',ch,'lastMessageId',m2,'messageCount',2)));
  select * into first_claim from public.panel_pending_claim_general_read('preview',0.1);
  if first_claim.journey_id is null or first_claim.next_message_index<>0 then raise exception 'PENDING_FIRST_CLAIM_FAILED'; end if;
  select * into second_claim from public.panel_pending_claim_general_read('preview',0.1);
  if second_claim.journey_id is not null then raise exception 'PENDING_CONCURRENT_CLAIM_NOT_BLOCKED'; end if;
  select status into current_status from public.conversation_general_read_progress where environment='preview' and journey_id=j and chat_id=ch;
  if current_status<>'PROCESSING' then raise exception 'PENDING_CLAIM_CHANGED_STATUS:%', current_status; end if;
  perform public.panel_pending_finish_general_read('preview',j,ch,1,'parte 1',false,null,null,null,null,null,null,0.01,0.1,null);
  select * into second_claim from public.panel_pending_claim_general_read('preview',0.1);
  if second_claim.next_message_index<>1 then raise exception 'PENDING_DID_NOT_RESUME'; end if;
  perform public.panel_pending_finish_general_read('preview',j,ch,2,'resumo final',true,'IN_PROGRESS','WARM','resumo','retornar',null,m2,0.01,0.1,null);
  if (select completed_conversations from public.conversation_general_read_runs where environment='preview')<>1 then raise exception 'PENDING_COMPLETION_NOT_SAVED'; end if;

  -- No own budget per run any more: a run stopped by the old US$ 20 (LIMIT) goes on, and spending
  -- above US$ 20 never stops it (the provider's prepaid balance is checked per call).
  update public.conversation_general_read_progress set status='PENDING' where environment='preview' and journey_id=j and chat_id=ch;
  update public.conversation_general_read_runs set status='LIMIT',spent_usd=19.99,reserved_usd=0,budget_usd=20 where environment='preview';
  select * into second_claim from public.panel_pending_claim_general_read('preview',0.1);
  select status into current_status from public.conversation_general_read_runs where environment='preview';
  if second_claim.journey_id is null or current_status<>'ACTIVE' then raise exception 'PENDING_STILL_CAPPED:%', current_status; end if;
  raise notice 'OK: pendências retoma sem duplicar e sem teto próprio';
end $$;
rollback;
