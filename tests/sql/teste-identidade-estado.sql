-- Identidade persistida: a Ref que o cliente escreveu na mensagem da calculadora é ligada à ficha uma única vez
-- (mesmo sem simulação), uma Ref de outra ficha nunca é tomada (conflito), mensagem do modelo sem Ref vira
-- "Calculadora, referência a recuperar" e uma decisão manual nunca é sobrescrita.
do $$ declare c uuid:=gen_random_uuid(); ja uuid:=gen_random_uuid(); jb uuid:=gen_random_uuid(); jc uuid:=gen_random_uuid(); jd uuid:=gen_random_uuid(); ch uuid:=gen_random_uuid();
  ma uuid:=gen_random_uuid(); mb uuid:=gen_random_uuid(); md uuid:=gen_random_uuid(); r record; res jsonb; n int;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(c,'preview','Cliente Identidade','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values
    (ja,'preview',c,'K7M2P','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now()),
    (jb,'preview',c,'N3M4R','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now()),
    (jc,'preview',c,'QQQQ7','CALCULATOR','NOVO','ATIVO','{}',now(),now()),
    (jd,'preview',c,'P5T6V','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,created_at,updated_at) values(ch,'preview','SMS',c,'identidade-'||ch,'RESOLVED',false,now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values
    (ma,'preview',ch,'SMS','CUSTOMER','Hello! My Car Scout · Maximum bid 9000 · Ref: WSR3X','x',now(),'id-'||ma,1,now()),
    (mb,'preview',ch,'SMS','CUSTOMER','Hello! My Car Scout · Maximum bid 9000 · Ref: QQQQ7','x',now(),'id-'||mb,1,now()),
    (md,'preview',ch,'SMS','CUSTOMER','Hello! I just sent a vehicle search request through My Car Scout Year range: 2020-2024','x',now(),'id-'||md,1,now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values
    ('preview',ma,ja,'TEST',now()),('preview',mb,jb,'TEST',now()),('preview',md,jd,'TEST',now());

  -- A: Ref escrita, sem simulação, ainda não ligada
  select * into r from public.panel_identity_evidence('preview', array[ja]);
  if r.explicit->0->>'ref' <> 'WSR3X' or r.template is not true then raise exception 'EVIDENCE_A:%', r.explicit; end if;
  res:=public.panel_identity_apply('preview',ja,1,'h1','REF_COMPROVADA',true,array['WSR3X'],null,'{}'::jsonb,array['WSR3X'],array[ma]);
  if (res->'linked'->>0) is distinct from 'WSR3X' then raise exception 'APPLY_A:%', res; end if;
  res:=public.panel_identity_apply('preview',ja,1,'h1','REF_COMPROVADA',true,array['WSR3X'],null,'{}'::jsonb,array['WSR3X'],array[ma]);
  select count(*) into n from public.journey_refs where journey_id=ja and ref_code='WSR3X';
  if n<>1 or jsonb_array_length(res->'linked')<>0 then raise exception 'APPLY_A_TWICE:% %', n, res; end if;
  select count(*) into n from public.activity_log where journey_id=ja and activity_type='IDENTITY_REF_LINKED';
  if n<>1 then raise exception 'LOG_A:%', n; end if;

  -- B: a Ref escrita pertence a outra ficha: nunca é tomada
  select * into r from public.panel_identity_evidence('preview', array[jb]);
  if not (r.owners ? 'QQQQ7') or jsonb_array_length(r.owners->'QQQQ7') <> 1 then raise exception 'OWNERS_B:%', r.owners; end if;
  res:=public.panel_identity_apply('preview',jb,1,'h2','CONFLITO',true,'{}',jsonb_build_object('refs',array['QQQQ7']),'{}'::jsonb,array['QQQQ7'],array[mb]);
  select count(*) into n from public.journey_refs where journey_id=jb;
  if n<>0 or (res->'blocked'->>0)<>'QQQQ7' then raise exception 'APPLY_B:% %', n, res; end if;
  select * into r from public.panel_identity_state where journey_id=jb;
  if r.status<>'CONFLITO' then raise exception 'STATE_B:%', r.status; end if;

  -- D: modelo da calculadora sem Ref
  select * into r from public.panel_identity_evidence('preview', array[jd]);
  if r.template is not true or jsonb_array_length(r.explicit)<>0 then raise exception 'EVIDENCE_D'; end if;
  res:=public.panel_identity_apply('preview',jd,1,'h3','CALCULADORA_REF_A_RECUPERAR',true,'{}',null,'{}'::jsonb,'{}','{}');
  select * into r from public.panel_identity_state where journey_id=jd;
  if r.status<>'CALCULADORA_REF_A_RECUPERAR' or r.calc_origin is not true then raise exception 'STATE_D:%', r.status; end if;

  -- decisão manual não é sobrescrita
  update public.panel_identity_state set decided_by='MANUAL' where journey_id=jd;
  res:=public.panel_identity_apply('preview',jd,2,'h4','SEM_ORIGEM_CALCULADORA',false,'{}',null,'{}'::jsonb,'{}','{}');
  select * into r from public.panel_identity_state where journey_id=jd;
  if res->>'skipped'<>'MANUAL' or r.status<>'CALCULADORA_REF_A_RECUPERAR' then raise exception 'MANUAL:% %', res, r.status; end if;
  raise notice 'OK: identidade persistida (Ref escrita ligada uma vez, conflito não toma a Ref, origem a recuperar, manual preservado)';
end $$;
