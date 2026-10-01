-- Itens da IA e anotações confirmados numa ficha SEM Ref da calculadora (pela jornada), e o caminho
-- com Ref igual a antes. Tudo dentro de uma transação desfeita no fim.
begin;
do $$
declare u uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid(); m uuid:=gen_random_uuid();
  rc uuid:=gen_random_uuid(); rj uuid:=gen_random_uuid(); rch uuid:=gen_random_uuid(); rm uuid:=gen_random_uuid();
  cc uuid:=gen_random_uuid(); cj uuid:=gen_random_uuid();
  reading uuid; key uuid:=gen_random_uuid(); result jsonb; again jsonb; ids uuid[]; failed boolean;
begin
  insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
    values(u,'preview',gen_random_uuid(),'sem-ref@example.com','operator',true,false);

  -- Ficha que chegou direto pelo WhatsApp: sem reference_code e sem Ref ligada.
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Cliente Direto','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at)
    values(j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',1500000,now(),now());
  update public.journeys set reference_code=null where id=j;
  insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at)
    select 'preview',j,k,'Ponto '||k,'OPEN',now(),now() from generate_series(1,6) k;
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at)
    values(ch,'preview','WHATSAPP',c,'sem-ref-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at)
    values(m,'preview',ch,'WHATSAPP','CUSTOMER','Vou financiar um Honda Civic, teto total 22000','x',now(),'sem-ref-'||m,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',m,j,'TEST',now());

  result:=public.panel_ai_replace_reading('preview',j,ch,'{}',jsonb_build_array(
    jsonb_build_object('fingerprint',repeat('1',64),'evidence','Vou financiar','manualReview',false,'item',jsonb_build_object('type','payment','value','fin','evidence','Vou financiar')),
    jsonb_build_object('fingerprint',repeat('2',64),'evidence','Honda Civic','manualReview',false,'item',jsonb_build_object('type','wishlist','value',jsonb_build_object('operation','include','car',jsonb_build_object('make','Honda','model','Civic')),
      'finalWishes',jsonb_build_array(jsonb_build_object('make','Honda','model','Civic')),'evidence','Honda Civic')),
    jsonb_build_object('fingerprint',repeat('3',64),'evidence','teto total 22000','manualReview',true,'item',jsonb_build_object('type','budget','value',22000,'evidence','teto total 22000'))
  ),1,m,now(),u);
  reading:=(result->>'readingId')::uuid;
  select array_agg(id order by item_fingerprint) into ids from public.conversation_ai_items where reading_id=reading and status='PENDING';
  if coalesce(array_length(ids,1),0)<>3 then raise exception 'SEM_REF_ITENS_PENDENTES %',ids; end if;

  -- (a)+(d) Pagamento, lista de desejo e teto na ficha sem Ref.
  result:=public.panel_ai_confirm_items('preview',u,j,reading,ids,key,'{}');
  if (result->>'confirmed')::integer<>3 or (result->>'journeyId')::uuid<>j or (result->>'duplicate')::boolean then raise exception 'SEM_REF_CONFIRMAR %',result; end if;
  if (select payment_text from public.journeys where id=j)<>'fin' then raise exception 'SEM_REF_PAGAMENTO'; end if;
  if (select criteria_json->'wishlists'->0->>'model' from public.journeys where id=j)<>'Civic'
     or not (select (criteria_json->>'wishlistOverride')::boolean from public.journeys where id=j) then raise exception 'SEM_REF_LISTA'; end if;
  if (select confirmed_total_ceiling_cents from public.journeys where id=j)<>2200000 then raise exception 'SEM_REF_TETO_TOTAL'; end if;
  if (select budget_cents from public.journeys where id=j)<>1500000 then raise exception 'SEM_REF_TETO_MEXEU_NO_LANCE'; end if;
  if (select status from public.journey_checklist where journey_id=j and point_number=2)<>'COMPLETE' then raise exception 'SEM_REF_CHECKLIST_TETO'; end if;
  if exists(select 1 from public.conversation_ai_items where reading_id=reading and status<>'CONFIRMED') then raise exception 'SEM_REF_ITENS_NAO_CONFIRMADOS'; end if;
  if (select count(*) from public.conversation_ai_items where reading_id=reading and decided_by=u)<>3 then raise exception 'SEM_REF_AUDITORIA_ITENS'; end if;
  -- Auditoria: a anotação e o evento ficam na jornada, sem ref_code.
  if not exists(select 1 from public.lead_notes where environment='preview' and journey_id=j and ref_code is null and confirmation_key=key
     and created_by=u and body_text='Leitura da IA' and jsonb_array_length(distributed_json)=3) then raise exception 'SEM_REF_ANOTACAO'; end if;
  if not exists(select 1 from public.lead_events where environment='preview' and journey_id=j and ref_code is null and event_type='NOTE_CONFIRMED'
     and created_by=u and detail_json->>'confirmationKey'=key::text) then raise exception 'SEM_REF_EVENTO'; end if;

  -- A mesma chave devolve a mesma anotação (sem gravar de novo).
  again:=public.panel_confirm_lead_note('preview',u,null,j,'Leitura da IA','[]',key,'{}');
  if not (again->>'duplicate')::boolean or (again->>'noteId')<>(result->>'noteId') then raise exception 'SEM_REF_IDEMPOTENCIA %',again; end if;
  -- ...mas não pode ser reaproveitada em outra ficha.
  failed:=false;
  begin perform public.panel_confirm_lead_note('preview',u,null,gen_random_uuid(),'Leitura da IA','[]',key,'{}');
  exception when others then failed:=sqlerrm like '%CONFIRMATION_KEY_REUSED%'; end;
  if not failed then raise exception 'SEM_REF_CHAVE_REUSADA'; end if;

  -- Anotação "Distribuir o que conversei" sem Ref: promessa e telefone extra pela jornada.
  result:=public.panel_confirm_lead_note('preview',u,'',j,'Liga amanhã às 10h; esposa 305-555-0199',jsonb_build_array(
    jsonb_build_object('type','promise','value',jsonb_build_object('text','Ligar'),'dueUtc',(now()+interval '1 day')::text,'evidence','Liga amanhã às 10h'),
    jsonb_build_object('type','phone','value',jsonb_build_object('number','+13055550199','owner','esposa'),'evidence','esposa 305-555-0199')
  ),gen_random_uuid(),'{}');
  if (result->>'journeyId')::uuid<>j then raise exception 'SEM_REF_NOTA %',result; end if;
  if not exists(select 1 from public.lead_promises where journey_id=j and ref_code is null and promise_text='Ligar') then raise exception 'SEM_REF_PROMESSA'; end if;
  if not exists(select 1 from public.lead_events where journey_id=j and ref_code is null and event_type='EXTRA_PHONE') then raise exception 'SEM_REF_TELEFONE'; end if;
  if not exists(select 1 from public.contact_phones where contact_id=c and phone_e164='+13055550199') then raise exception 'SEM_REF_TELEFONE_CONTATO'; end if;

  -- Sem Ref e sem jornada continua inválido; Ref com formato errado também; jornada inexistente recusada.
  failed:=false;
  begin perform public.panel_confirm_lead_note('preview',u,null,null,'x','[]',gen_random_uuid(),'{}');
  exception when others then failed:=sqlerrm like '%NOTE_INVALID%'; end;
  if not failed then raise exception 'SEM_REF_SEM_JORNADA'; end if;
  failed:=false;
  begin perform public.panel_confirm_lead_note('preview',u,'abc',j,'x','[]',gen_random_uuid(),'{}');
  exception when others then failed:=sqlerrm like '%NOTE_INVALID%'; end;
  if not failed then raise exception 'SEM_REF_FORMATO'; end if;
  failed:=false;
  begin perform public.panel_confirm_lead_note('preview',u,null,gen_random_uuid(),'x','[]',gen_random_uuid(),'{}');
  exception when others then failed:=sqlerrm like '%JOURNEY_NOT_FOUND%'; end;
  if not failed then raise exception 'SEM_REF_JORNADA_INEXISTENTE'; end if;
  if exists(select 1 from public.contacts where environment='preview' and display_name like 'Contato da Ref%') then raise exception 'SEM_REF_CRIOU_CONTATO'; end if;

  -- (c) Ficha encerrada sem Ref: recusada e nada gravado.
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(cc,'preview','Encerrado','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,closed_at,closed_reason,created_at,updated_at)
    values(cj,'preview',cc,'WHATSAPP_DIRECT','NOVO','ENCERRADO','{}',now(),'GAVE_UP',now(),now());
  update public.journeys set reference_code=null where id=cj;
  failed:=false;
  begin perform public.panel_confirm_lead_note('preview',u,null,cj,'Pago à vista',jsonb_build_array(jsonb_build_object('type','payment','value','cash','evidence','Pago à vista')),gen_random_uuid(),'{}');
  exception when others then failed:=sqlerrm like '%JOURNEY_FROZEN%'; end;
  if not failed then raise exception 'SEM_REF_ENCERRADA_ACEITOU'; end if;
  if exists(select 1 from public.lead_notes where journey_id=cj) or (select payment_text from public.journeys where id=cj) is not null then raise exception 'SEM_REF_ENCERRADA_GRAVOU'; end if;

  -- (b) Caminho com Ref da calculadora: igual a antes (ref_code gravado, lead_tracking ligado).
  insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados) values(now(),'33101','FL',10000,'cash',jsonb_build_object('ref','KQ7XP'));
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(rc,'preview','Cliente Ref','CALCULATOR',now(),now());
  insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at)
    values(rj,'preview',rc,'KQ7XP','CALCULATOR','NOVO','ATIVO','{}',now(),now());
  insert into public.lead_tracking(environment,ref_code,public_code) values('preview','KQ7XP',repeat('t',24));
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at)
    values(rch,'preview','WHATSAPP',rc,'com-ref-'||rch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at)
    values(rm,'preview',rch,'WHATSAPP','CUSTOMER','Pago à vista','x',now(),'com-ref-'||rm,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',rm,rj,'TEST',now());
  result:=public.panel_ai_replace_reading('preview',rj,rch,'{}',jsonb_build_array(
    jsonb_build_object('fingerprint',repeat('4',64),'evidence','Pago à vista','manualReview',false,'item',jsonb_build_object('type','payment','value','cash','evidence','Pago à vista'))
  ),1,rm,now(),u);
  reading:=(result->>'readingId')::uuid;
  result:=public.panel_ai_confirm_items('preview',u,rj,reading,array(select id from public.conversation_ai_items where reading_id=reading),gen_random_uuid(),'{}');
  if (result->>'journeyId')::uuid<>rj or (select payment_text from public.journeys where id=rj)<>'cash' then raise exception 'COM_REF_CONFIRMAR %',result; end if;
  if not exists(select 1 from public.lead_notes where journey_id=rj and ref_code='KQ7XP') then raise exception 'COM_REF_ANOTACAO_SEM_REF'; end if;
  if not exists(select 1 from public.lead_events where journey_id=rj and ref_code='KQ7XP' and event_type='NOTE_CONFIRMED') then raise exception 'COM_REF_EVENTO'; end if;
  if (select journey_id from public.lead_tracking where ref_code='KQ7XP')<>rj then raise exception 'COM_REF_TRACKING'; end if;
  -- Com Ref, a jornada errada continua recusada.
  failed:=false;
  begin perform public.panel_confirm_lead_note('preview',u,'KQ7XP',j,'x','[]',gen_random_uuid(),'{}');
  exception when others then failed:=sqlerrm like '%JOURNEY_REF_MISMATCH%'; end;
  if not failed then raise exception 'COM_REF_JORNADA_ERRADA'; end if;

  -- Linha sem Ref e sem jornada é recusada pela constraint.
  failed:=false;
  begin insert into public.lead_notes(environment,ref_code,journey_id,body_text,created_by) values('preview',null,null,'x',u);
  exception when check_violation then failed:=true; end;
  if not failed then raise exception 'SEM_REF_CONSTRAINT'; end if;
  raise notice 'OK: confirmar IA e anotação em ficha sem Ref, com Ref igual a antes';
end $$;
rollback;
