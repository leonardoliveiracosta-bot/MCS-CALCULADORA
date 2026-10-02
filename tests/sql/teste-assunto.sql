-- Assunto da conversa: candidatas são as fichas com mensagem do cliente nova ou nunca lidas; a reserva impede
-- leitura dupla; terminar grava assunto, hash e Refs; uma nova mensagem reabre; a correção manual não é
-- sobrescrita e tira a ficha da fila do Claude.
do $$ declare c uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); m1 uuid:=gen_random_uuid(); m2 uuid:=gen_random_uuid();
  t1 uuid; t2 uuid; n int; r record; h1 text; ok boolean;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Cliente Assunto','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values(j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values(ch,'preview','SMS',c,'assunto-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (m1,'preview',ch,'SMS','CUSTOMER','Hi','x',now()-interval '1 hour','as-'||m1,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',m1,j,'TEST',now());

  select count(*) into n from public.panel_subject_candidates('preview',1,10) where journey_id=j;
  if n<>1 then raise exception 'CANDIDATE_NEW:%', n; end if;
  t1:=public.panel_subject_claim('preview',j,120);
  if t1 is null then raise exception 'CLAIM_1'; end if;
  t2:=public.panel_subject_claim('preview',j,120);
  if t2 is not null then raise exception 'CLAIM_2_SHOULD_BE_BUSY'; end if;
  select count(*) into n from public.panel_subject_candidates('preview',1,10) where journey_id=j;
  if n<>0 then raise exception 'CANDIDATE_WHILE_CLAIMED:%', n; end if;
  select content_hash into h1 from public.panel_subject_candidates('preview',1,10) limit 0;
  ok:=public.panel_subject_finish('preview',j,gen_random_uuid(),'x',1,'OUTROS',0.5,'x','[]');
  if ok then raise exception 'FINISH_WITH_WRONG_TOKEN'; end if;
  -- hash real do conteúdo atual
  select md5(string_agg(m.id::text, ',' order by coalesce(m.occurred_at_utc,m.created_at), m.id)) into h1 from public.message_journeys mj join public.messages m on m.id=mj.message_id where mj.journey_id=j;
  ok:=public.panel_subject_finish('preview',j,t1,h1,1,'FINANCIAMENTO',0.9,'pergunta parcelas','[{"ref":"WSR3X","verified":true}]');
  if not ok then raise exception 'FINISH_OK'; end if;
  select * into r from public.panel_conversation_class where journey_id=j;
  if r.subject<>'FINANCIAMENTO' or r.claim_token is not null or r.rule_version<>1 then raise exception 'STATE:%', r.subject; end if;
  select count(*) into n from public.panel_subject_candidates('preview',1,10) where journey_id=j;
  if n<>0 then raise exception 'CANDIDATE_AFTER_DONE:%', n; end if;

  -- mensagem nova do cliente: volta para a fila; regra nova também
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (m2,'preview',ch,'SMS','CUSTOMER','E sobre financiamento?','x',now(),'as-'||m2,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',m2,j,'TEST',now());
  select count(*) into n from public.panel_subject_candidates('preview',1,10) where journey_id=j;
  if n<>1 then raise exception 'CANDIDATE_NEW_MESSAGE:%', n; end if;
  select count(*) into n from public.panel_subject_candidates('preview',2,10) where journey_id=j;
  if n<>1 then raise exception 'CANDIDATE_RULE:%', n; end if;

  -- correção manual: preservada e fora da fila
  perform public.panel_subject_set_manual('preview',j,'OUTROS',null);
  select count(*) into n from public.panel_subject_candidates('preview',1,10) where journey_id=j;
  if n<>0 then raise exception 'MANUAL_STILL_CANDIDATE:%', n; end if;
  select * into r from public.panel_conversation_class where journey_id=j;
  if r.manual_subject<>'OUTROS' or r.subject<>'FINANCIAMENTO' then raise exception 'MANUAL_STATE:% %', r.manual_subject, r.subject; end if;
  perform public.panel_subject_set_manual('preview',j,null,null);
  select count(*) into n from public.panel_subject_candidates('preview',1,10) where journey_id=j;
  if n<>1 then raise exception 'MANUAL_CLEARED:%', n; end if;
  raise notice 'OK: assunto da conversa (reserva, retomada por mensagem nova, correção manual preservada)';
end $$;
