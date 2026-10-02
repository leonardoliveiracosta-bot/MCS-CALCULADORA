-- Identidade: a Ref escrita na mensagem da calculadora ("My Car Scout … Ref: XXXXX") é lida por
-- ficha, com o tipo da calculadora pela própria mensagem. "Reference", código sem "Ref:", mensagem
-- da MCS, mensagem desfeita e vínculo desfeito não contam. Só leitura.
do $$ declare c uuid:=gen_random_uuid(); j uuid:=gen_random_uuid(); j2 uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid();
  m1 uuid:=gen_random_uuid(); m2 uuid:=gen_random_uuid(); m3 uuid:=gen_random_uuid(); m4 uuid:=gen_random_uuid(); m5 uuid:=gen_random_uuid(); m6 uuid:=gen_random_uuid();
  n int; r record;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Cliente Ref Escrita','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values(j,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values(j2,'preview',c,'WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values(ch,'preview','SMS',c,'ref-escrita-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (m1,'preview',ch,'SMS','CUSTOMER','Hi My Car Scout! · FIND · Year range 2018-2020 · Ref: WSR3X','x',now()-interval '3 days','re-'||m1,1,now()),
    (m2,'preview',ch,'SMS','CUSTOMER','My Car Scout · Maximum bid 9000 · Ref: wsr3x','x',now()-interval '2 days','re-'||m2,1,now()),
    (m3,'preview',ch,'SMS','CUSTOMER','My Car Scout Reference ERENC please','x',now(),'re-'||m3,1,now()),
    (m4,'preview',ch,'SMS','MCS','My Car Scout · Ref: FMLNA','x',now(),'re-'||m4,1,now()),
    (m5,'preview',ch,'SMS','CUSTOMER','Ref: ABCDE sem a calculadora','x',now(),'re-'||m5,1,now()),
    (m6,'preview',ch,'SMS','CUSTOMER','My Car Scout · Ref: QQQQQ','x',now(),'re-'||m6,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values
    ('preview',m1,j,'TEST',now()),('preview',m2,j,'TEST',now()),('preview',m3,j,'TEST',now()),('preview',m4,j,'TEST',now()),('preview',m5,j,'TEST',now()),('preview',m6,j2,'TEST',now());
  update public.message_journeys set undone_at=now() where message_id=m6;

  select count(*) into n from public.panel_journey_explicit_refs('preview', array[j,j2]);
  if n <> 1 then raise exception 'EXPLICIT_COUNT:%', n; end if;
  select * into r from public.panel_journey_explicit_refs('preview', array[j]);
  if r.journey_id <> j or r.ref <> 'WSR3X' or r.mode <> 'CARRO' then raise exception 'EXPLICIT_ROW:% % %', r.journey_id, r.ref, r.mode; end if;
  if r.first_at > now()-interval '2 days 23 hours' then raise exception 'EXPLICIT_FIRST_AT:%', r.first_at; end if;
  -- Outro ambiente não vê nada.
  select count(*) into n from public.panel_journey_explicit_refs('production', array[j]);
  if n <> 0 then raise exception 'EXPLICIT_ENV:%', n; end if;
  raise notice 'OK: Ref explícita da mensagem da calculadora (sem falso "Reference", sem mensagem da MCS)';
end $$;
