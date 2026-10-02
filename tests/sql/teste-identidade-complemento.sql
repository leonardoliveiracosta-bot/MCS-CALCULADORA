-- Complemento: falha do Claude entra em recuo e para depois de cinco (o conteúdo novo recomeça); a Ref escrita guarda o texto
-- digitado; fichas com modelo da calculadora e simulações próximas de uma mensagem são lidas; ligar a mesma Ref em fichas
-- diferentes continua impossível.
do $$ declare c uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); m1 uuid:=gen_random_uuid(); m2 uuid:=gen_random_uuid();
  t uuid; n int; r record; h text; res jsonb;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Cliente Complemento','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values
    (j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now()),(j2,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values(ch,'preview','SMS',c,'compl-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (m1,'preview',ch,'SMS','CUSTOMER','Hello! I just sent a vehicle search request through My Car Scout Year range: 2020-2024 ref: Camry','x',now(),'cp-'||m1,1,now()),
    (m2,'preview',ch,'SMS','CUSTOMER','Hello! My Car Scout · Maximum bid 9000 · Ref: QWRT7','x',now(),'cp-'||m2,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',m1,j,'TEST',now()),('preview',m2,j2,'TEST',now());

  -- a Ref escrita guarda como foi digitada
  select * into r from public.panel_identity_evidence('preview', array[j]);
  if r.explicit->0->>'ref' <> 'CAMRY' or r.explicit->0->>'raw' <> 'Camry' then raise exception 'RAW_LOWER:%', r.explicit; end if;
  select * into r from public.panel_identity_evidence('preview', array[j2]);
  if r.explicit->0->>'raw' <> 'QWRT7' then raise exception 'RAW_UPPER:%', r.explicit; end if;

  -- modelo da calculadora
  select count(*) into n from public.panel_journey_calc_templates('preview', array[j, j2]);
  if n <> 2 then raise exception 'TEMPLATES:%', n; end if;

  -- falhas do Claude: recuo e teto por conteúdo
  select md5(string_agg(x.id::text, ',' order by x.at, x.id)) into h from (select m.id, coalesce(m.occurred_at_utc,m.created_at) at from public.message_journeys mj join public.messages m on m.id=mj.message_id where mj.journey_id=j) x;
  for i in 1..5 loop
    t:=public.panel_subject_claim('preview',j,120);
    if t is null then raise exception 'CLAIM_FAIL_%', i; end if;
    perform public.panel_subject_fail('preview',j,t,h);
    -- o recuo impede nova leitura imediata; simula a passagem do tempo para a próxima tentativa
    select count(*) into n from public.panel_subject_candidates('preview',1,50) where journey_id=j;
    if n<>0 then raise exception 'BACKOFF_%:%', i, n; end if;
    update public.panel_conversation_class set next_try_at=now()-interval '1 minute' where journey_id=j;
  end loop;
  select * into r from public.panel_conversation_class where journey_id=j;
  if r.fail_count<>5 then raise exception 'FAIL_COUNT:%', r.fail_count; end if;
  select count(*) into n from public.panel_subject_candidates('preview',1,50) where journey_id=j;
  if n<>0 then raise exception 'STOPPED_AFTER_FIVE:%', n; end if;
  -- conteúdo novo recomeça
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (gen_random_uuid(),'preview',ch,'SMS','CUSTOMER','Mensagem nova','x',now(),'cp-new-'||gen_random_uuid(),1,now()) returning id into m1;
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',m1,j,'TEST',now());
  select count(*) into n from public.panel_subject_candidates('preview',1,50) where journey_id=j;
  if n<>1 then raise exception 'RESTART_ON_NEW_CONTENT:%', n; end if;
  -- terminar com sucesso zera as falhas e guarda os resumos por pedido
  t:=public.panel_subject_claim('preview',j,120);
  perform public.panel_subject_finish_v2('preview',j,t,'novo',2,'OUTROS',0.5,'x','[]','[{"ref":null,"summary":"x","ambiguous":true}]');
  select * into r from public.panel_conversation_class where journey_id=j;
  if r.fail_count<>0 or r.next_try_at is not null or jsonb_array_length(r.request_summaries)<>1 then raise exception 'FINISH_RESET:%', r.fail_count; end if;

  -- janela de simulações (duas simulações perto, uma longe)
  insert into public.calc_runs(created_at,dados,is_test) values (now()-interval '3 minutes','{"ref":"AAAA2","evento":"whatsapp","marca":"Ford"}',false),(now()-interval '4 minutes','{"ref":"BBBB3","evento":"simulacao"}',false),(now()-interval '2 days','{"ref":"CCCC4","evento":"whatsapp"}',false);
  select count(*) into n from public.panel_calc_run_candidates(now(), 10, 2);
  if n<>2 then raise exception 'WINDOW:%', n; end if;

  -- a trava por Ref: a mesma Ref numa segunda ficha continua bloqueada
  res:=public.panel_identity_apply('preview',j,1,'a','REF_COMPROVADA',true,array['QWRT7'],null,'{}'::jsonb,array['QWRT7'],array[m2]);
  res:=public.panel_identity_apply('preview',j2,1,'b','REF_COMPROVADA',true,array['QWRT7'],null,'{}'::jsonb,array['QWRT7'],array[m2]);
  select count(*) into n from public.journey_refs where upper(ref_code)='QWRT7';
  if n<>1 then raise exception 'ONE_OWNER:%', n; end if;
  raise notice 'OK: complemento da identidade (recuo do Claude, texto digitado, modelo, janela, uma Ref um dono)';
end $$;
