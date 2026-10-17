begin;
do $$
declare contact uuid:=gen_random_uuid();chat uuid:=gen_random_uuid();journey uuid:=gen_random_uuid();msg uuid:=gen_random_uuid();
 t timestamptz:=now()-interval '5 minutes';job public.mcs_meta_received_leads;run_id bigint;n integer;
begin
 insert into public.contacts(id,environment,display_name,created_at,updated_at)values(contact,'production','Meta measurement test',t,t);
 insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,created_at)values('production',contact,'+13055550189','+13055550189',true,t);
 insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at)values(chat,'production','WHATSAPP',contact,'wa:+13055550189','RESOLVED',t,t);
 insert into public.journeys(id,environment,contact_id,source,created_at,updated_at)values(journey,'production',contact,'CALCULATOR',t,t);
 insert into public.calc_runs(created_at,dados)values(t,jsonb_build_object('ref','QZ9XY','logical_mode','VALOR','etapa','contato_iniciado','formulario_completo',true,'meta_measurement_allowed',false,'atribuicao',jsonb_build_object('utm_source','meta')))returning id into run_id;
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'calculator click manufactured a received lead';
 insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
 values(msg,'production',chat,'WHATSAPP','CUSTOMER','My Car Scout Maximum bid Ref: QZ9XY','test',t+interval '1 minute','META_TEST',1,'WHATSAPP_WEBHOOK',t+interval '1 minute');
 insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)values('production',msg,journey,'TEST',t);
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'browser privacy choice bypassed by server';
 update public.calc_runs set dados=jsonb_set(dados,'{meta_measurement_allowed}','true')where id=run_id;
 update public.messages set source_kind='WHATSAPP_HISTORY' where id=msg;
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'historical import manufactured a live lead';
 update public.messages set source_kind='WHATSAPP_WEBHOOK',direction='MCS' where id=msg;
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'outbound message counted as lead';
 update public.messages set direction='CUSTOMER',body_text='My Car Scout Maximum bid Ref: QZ9XY Ref: ABCDE' where id=msg;
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'ambiguous Refs accepted';
 update public.messages set body_text='My Car Scout Maximum bid Ref: QZ9XY' where id=msg;
 update public.calc_runs set dados=jsonb_set(dados,'{formulario_completo}','false')where id=run_id;
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'incomplete request accepted';
 update public.calc_runs set dados=jsonb_set(dados,'{formulario_completo}','true')where id=run_id;
 select * into job from public.mcs_meta_received_claim(t-interval '1 minute');
 assert job.id is not null and job.state='SENDING' and job.channel='WHATSAPP','real verified request was not queued';
 assert job.phone_hash=encode(extensions.digest('13055550189','sha256'),'hex'),'phone normalization/hash mismatch';
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'duplicate worker acquired the same lease';
 assert not public.mcs_meta_received_finish(job.id,gen_random_uuid(),true,null),'stale worker acknowledged another lease';
 assert public.mcs_meta_received_finish(job.id,job.claim_id,false,'META_UNAVAILABLE'),'failure not recorded';
 update public.mcs_meta_received_leads set next_at=now()-interval '1 second'where id=job.id;
 select * into job from public.mcs_meta_received_claim(t-interval '1 minute');
 assert job.attempts=2,'delivery was not retried';
 assert public.mcs_meta_received_finish(job.id,job.claim_id,true,null),'acceptance not recorded';
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'accepted request was counted twice';
 -- Independent SMS / CARRO request, with the Spanish calculator template.
 update public.chats set channel='SMS',canonical_key='sms:+13055550189' where id=chat;
 update public.calc_runs set dados=jsonb_set(jsonb_set(dados,'{ref}','"ZX7PQ"'),'{logical_mode}','"CARRO"'),is_test=true where id=run_id;
 msg:=gen_random_uuid();
 insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
 values(msg,'production',chat,'SMS','CUSTOMER','Hola My Car Scout Rango de años Ref: ZX7PQ','test sms',t+interval '2 minutes','META_SMS_TEST',1,'SMS_SHORTCUT',t+interval '2 minutes');
 insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)values('production',msg,journey,'TEST',t);
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'test calculator request exported';
 update public.calc_runs set is_test=false,dados=jsonb_set(dados,'{atribuicao,utm_source}','"organic"')where id=run_id;
 select count(*) into n from public.mcs_meta_received_claim(t-interval '1 minute');assert n=0,'organic request exported by paid Meta worker';
 update public.calc_runs set dados=jsonb_set(dados,'{atribuicao,utm_source}','"meta"')where id=run_id;
 select count(*) into n from public.mcs_meta_received_claim(now());assert n=0,'activation cutoff ignored';
 select * into job from public.mcs_meta_received_claim(t-interval '1 minute');
 assert job.id is not null and job.channel='SMS' and job.logical_mode='CARRO','received SMS CARRO request was not queued';
 assert public.mcs_meta_received_finish(job.id,job.claim_id,true,null),'SMS acceptance not recorded';
 assert not has_table_privilege('anon','public.mcs_meta_received_leads','SELECT'),'anonymous access to hashed phones';
 assert not has_function_privilege('authenticated','public.mcs_meta_received_claim(timestamptz,integer)','EXECUTE'),'ordinary login can export leads';
 assert (select relrowsecurity from pg_class where oid='public.mcs_meta_received_leads'::regclass),'outbox RLS missing';
end $$;
rollback;
