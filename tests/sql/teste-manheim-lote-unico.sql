-- Manheim em lote único e blocos (migrações 20261005010000 e 20261005020000): bloco imutável
-- pelo hash do manifesto, retomada conferida e ativação só com tudo conferido.
begin;
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
values('6f000000-0000-4000-8000-000000000001','preview','6f000000-0000-4000-8000-000000000002','lote@example.com','admin',true,false)
on conflict do nothing;
do $$
declare
  actor uuid:='6f000000-0000-4000-8000-000000000001';
  v_contact uuid:=gen_random_uuid();
  v_journey uuid:=gen_random_uuid();
  v_other uuid:=gen_random_uuid();
  started jsonb;
  resumed jsonb;
  v_upload uuid;
  answer jsonb;
  finished jsonb;
  car jsonb:='{"year":2021,"make":"Honda","model":"CR-V","miles":30000,"mmrCents":2500000,"vin":"VINSQL00000000001"}';
  h00 text:=repeat('0',64); h01 text:=repeat('1',64); h10 text:=repeat('2',64);
  n_before integer;
  files jsonb:=jsonb_build_array(
    jsonb_build_object('name','A.csv','chunkCount',2,'vehicleCount',3,'chunks',jsonb_build_array(jsonb_build_object('count',2,'hash',repeat('0',64)),jsonb_build_object('count',1,'hash',repeat('1',64)))),
    jsonb_build_object('name','B.csv','chunkCount',1,'vehicleCount',1,'chunks',jsonb_build_array(jsonb_build_object('count',1,'hash',repeat('2',64)))));
  match_of jsonb;
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(v_contact,'preview','Cliente Lote','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(v_journey,'preview',v_contact,'WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{"logical_modes":["CARRO"]}',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(v_other,'preview',v_contact,'WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{"logical_modes":["CARRO"]}',now(),now());
  match_of:=jsonb_build_object('journeyId',v_journey,'kind','BATE','mode','CARRO','fingerprint','vin:VINSQL00000000001','vehicle',jsonb_build_object('parsed',car),
    'demandKey','journey:'||v_journey||':CARRO','sortRank',0,'sortMiles',30000,'vin','VINSQL00000000001','wishIndex',0,'mmrCents',2500000,'criteriaHash','abc');

  started:=public.panel_manheim_batch_start('preview',actor,repeat('a',32),4,'[["Vin"]]','{}',files,repeat('e',64),'[]','0123456789abcdef');
  v_upload:=(started->>'uploadId')::uuid;
  if (select activated_at from public.manheim_uploads where id=v_upload) is not null then raise exception 'FALHA: lote em montagem já nasceu ativo'; end if;

  -- mesma seleção e mesmo manifesto: o mesmo lote
  resumed:=public.panel_manheim_batch_start('preview',actor,repeat('a',32),4,'[["Vin"]]','{}',files,repeat('e',64),'[]','0123456789abcdef');
  if (resumed->>'uploadId')::uuid<>v_upload or (resumed->>'resumed')::boolean is not true then raise exception 'FALHA: retomada criou outro lote'; end if;
  -- mesma chave com outro manifesto ou outra foto das demandas: nunca continua em silêncio
  resumed:=public.panel_manheim_batch_start('preview',actor,repeat('a',32),4,'[["Vin"]]','{}',files,repeat('d',64),'[]','0123456789abcdef');
  if (resumed->>'mismatch')::boolean is not true or resumed->>'reason'<>'MANIFEST' or (resumed->>'uploadId')::uuid<>v_upload then raise exception 'FALHA: retomada com manifesto diferente %', resumed; end if;
  resumed:=public.panel_manheim_batch_start('preview',actor,repeat('a',32),4,'[["Vin"]]','{}',files,repeat('e',64),'[]','fedcba9876543210');
  if (resumed->>'mismatch')::boolean is not true or resumed->>'reason'<>'TARGETS' then raise exception 'FALHA: retomada com demandas diferentes %', resumed; end if;
  -- manifesto que não soma: recusado no início
  begin
    perform public.panel_manheim_batch_start('preview',actor,repeat('c',32),5,'[["Vin"]]','{}',files,repeat('e',64),'[]','0123456789abcdef');
    raise exception 'FALHA: total diferente da soma dos arquivos aceito';
  exception when others then if sqlerrm<>'MANHEIM_UPLOAD_INVALID' then raise; end if; end;
  begin
    perform public.panel_manheim_batch_start('preview',actor,repeat('c',32),4,'[["Vin"]]','{}',jsonb_set(files,'{0,vehicleCount}','4'),repeat('e',64),'[]','0123456789abcdef');
    raise exception 'FALHA: arquivo diferente da soma dos blocos aceito';
  exception when others then if sqlerrm<>'MANHEIM_UPLOAD_INVALID' then raise; end if; end;

  answer:=public.panel_manheim_batch_chunk('preview',actor,v_upload,0,0,h00,2,
    jsonb_build_array(jsonb_build_object('fingerprint','vin:VINSQL00000000001','makeKey','honda','mmrCents',2500000,'vehicle',car),
                      jsonb_build_object('fingerprint','vin:VINSQL00000000002','makeKey','honda','mmrCents',null,'vehicle',car || '{"mmrCents":null}')),
    jsonb_build_array(match_of,
      -- carro sem MMR: nunca vira match (descartado e contado, o bloco não cai)
      match_of || jsonb_build_object('fingerprint','vin:VINSQL00000000002','mmrCents',null)));
  if (answer->>'storedVehicles')::int<>2 or (answer->>'storedMatches')::int<>1 or (answer->>'discarded')::int<>1 then raise exception 'FALHA: bloco 0 %', answer; end if;

  -- o mesmo bloco de novo (resposta perdida), mesmo hash: responde sem gravar nada
  answer:=public.panel_manheim_batch_chunk('preview',actor,v_upload,0,0,h00,2,
    jsonb_build_array(jsonb_build_object('fingerprint','vin:VINSQL00000000001','makeKey','honda','mmrCents',2500000,'vehicle',car)),jsonb_build_array(match_of));
  if (answer->>'duplicate')::boolean is not true or (answer->>'storedVehicles')::int<>0 then raise exception 'FALHA: bloco repetido gravou'; end if;
  -- o mesmo bloco com outro conteúdo: recusado, nada gravado, contadores iguais
  select count(*) into n_before from public.manheim_vehicles where upload_id=v_upload;
  begin
    perform public.panel_manheim_batch_chunk('preview',actor,v_upload,0,0,repeat('9',64),2,
      jsonb_build_array(jsonb_build_object('fingerprint','vin:VINSQL00000000099','makeKey','honda','mmrCents',2500000,'vehicle',car)),'[]');
    raise exception 'FALHA: bloco conflitante aceito';
  exception when others then if sqlerrm<>'MANHEIM_CHUNK_CONFLICT' then raise; end if; end;
  if (select count(*) from public.manheim_vehicles where upload_id=v_upload)<>n_before
     or (select stored_vehicle_count from public.manheim_upload_chunks where upload_id=v_upload and file_index=0 and chunk_index=0)<>2 then raise exception 'FALHA: conflito alterou dados'; end if;

  -- bloco vazio quando o manifesto espera carros, bloco parcial e hash errado: recusados
  begin
    perform public.panel_manheim_batch_chunk('preview',actor,v_upload,0,1,h01,0,'[]','[]');
    raise exception 'FALHA: bloco vazio aceito';
  exception when others then if sqlerrm<>'MANHEIM_CHUNK_HASH_MISMATCH' then raise; end if; end;
  begin
    perform public.panel_manheim_batch_chunk('preview',actor,v_upload,0,1,repeat('7',64),1,
      jsonb_build_array(jsonb_build_object('fingerprint','vin:VINSQL00000000003','makeKey','honda','mmrCents',2500000,'vehicle',car)),'[]');
    raise exception 'FALHA: hash errado aceito';
  exception when others then if sqlerrm<>'MANHEIM_CHUNK_HASH_MISMATCH' then raise; end if; end;

  -- ativação com bloco faltando é recusada
  begin
    perform public.panel_manheim_batch_finalize('preview',actor,v_upload);
    raise exception 'FALHA: ativou com bloco faltando';
  exception when others then
    if sqlerrm<>'MANHEIM_BATCH_INCOMPLETE' then raise; end if;
  end;

  -- bloco fora do plano é recusado
  begin
    perform public.panel_manheim_batch_chunk('preview',actor,v_upload,1,5,h10,1,'[]','[]');
    raise exception 'FALHA: bloco fora do plano aceito';
  exception when others then
    if sqlerrm<>'MANHEIM_UPLOAD_INVALID' then raise; end if;
  end;

  answer:=public.panel_manheim_batch_chunk('preview',actor,v_upload,0,1,h01,1,
    jsonb_build_array(jsonb_build_object('fingerprint','vin:VINSQL00000000003','makeKey','honda','mmrCents',2500000,'vehicle',car)),'[]');
  answer:=public.panel_manheim_batch_chunk('preview',actor,v_upload,1,0,h10,1,
    jsonb_build_array(jsonb_build_object('fingerprint','vin:VINSQL00000000004','makeKey','honda','mmrCents',2500000,'vehicle',car)),'[]');

  -- números alterados depois dos blocos: a ativação recusa e nada é corrigido em silêncio
  update public.manheim_uploads set vehicle_count=5 where id=v_upload;
  begin
    perform public.panel_manheim_batch_finalize('preview',actor,v_upload);
    raise exception 'FALHA: ativou com total diferente';
  exception when others then if sqlerrm<>'MANHEIM_BATCH_INTEGRITY_ERROR' then raise; end if; end;
  if (select vehicle_count from public.manheim_uploads where id=v_upload)<>5 or (select activated_at from public.manheim_uploads where id=v_upload) is not null then raise exception 'FALHA: números corrigidos em silêncio'; end if;
  update public.manheim_uploads set vehicle_count=4 where id=v_upload;
  update public.manheim_upload_chunks set chunk_hash=repeat('8',64) where upload_id=v_upload and file_index=1;
  begin
    perform public.panel_manheim_batch_finalize('preview',actor,v_upload);
    raise exception 'FALHA: ativou com hash diferente do manifesto';
  exception when others then if sqlerrm<>'MANHEIM_BATCH_INTEGRITY_ERROR' then raise; end if; end;
  update public.manheim_upload_chunks set chunk_hash=h10 where upload_id=v_upload and file_index=1;

  finished:=public.panel_manheim_batch_finalize('preview',actor,v_upload);
  if (finished->>'vehicleCount')::int<>4 or (finished->>'fileCount')::int<>2 or (finished->>'matchedVehicleCount')::int<>1 then raise exception 'FALHA: ativação %', finished; end if;
  if (select activated_at from public.manheim_uploads where id=v_upload) is null then raise exception 'FALHA: não ativou'; end if;
  -- ativar de novo responde o mesmo, sem mexer
  if (public.panel_manheim_batch_finalize('preview',actor,v_upload)->>'alreadyActive')::boolean is not true then raise exception 'FALHA: segunda ativação não foi idempotente'; end if;

  -- resumo por demanda, páginas e pessoas: sem carro nenhum no resumo
  if (select match_count from public.panel_manheim_batch_summary('preview',v_upload) where demand_key='journey:'||v_journey||':CARRO')<>1 then raise exception 'FALHA: resumo'; end if;
  if (select count(*) from public.panel_manheim_demand_options('preview',v_upload,'journey:'||v_journey||':CARRO',null,null,null,10))<>1 then raise exception 'FALHA: página'; end if;
  if (select vehicle_count from public.panel_manheim_batch_people('preview',v_upload) where journey_id=v_journey and logical_mode is null)<>1 then raise exception 'FALHA: contagem por pessoa'; end if;
  if (select mmr_cents from public.panel_manheim_score_mmr('preview',now()-interval '1 day') where person='j:'||v_journey)<>2500000 then raise exception 'FALHA: MMR de referência do score'; end if;

  -- montagem cancelada nunca fica ativa e sai de tudo
  started:=public.panel_manheim_batch_start('preview',actor,repeat('b',32),1,'[["Vin"]]','{}','[{"name":"C.csv","chunkCount":1,"vehicleCount":1,"chunks":[{"count":1,"hash":"3333333333333333333333333333333333333333333333333333333333333333"}]}]',repeat('f',64),'[]','0123456789abcdef');
  answer:=public.panel_manheim_batch_cancel('preview',actor,(started->>'uploadId')::uuid);
  if (select undone_at from public.manheim_uploads where id=(started->>'uploadId')::uuid) is null then raise exception 'FALHA: cancelada sem undone_at'; end if;
  begin
    perform public.panel_manheim_batch_chunk('preview',actor,(started->>'uploadId')::uuid,0,0,repeat('3',64),1,'[]','[]');
    raise exception 'FALHA: bloco aceito em lote cancelado';
  exception when others then
    if sqlerrm<>'MANHEIM_BATCH_CANCELED' then raise; end if;
  end;
  begin
    perform public.panel_manheim_batch_cancel('preview',actor,v_upload);
    raise exception 'FALHA: cancelou um lote ativo (use desfazer)';
  exception when others then
    if sqlerrm<>'MANHEIM_BATCH_ALREADY_ACTIVE' then raise; end if;
  end;

  -- nova comparação dirigida: opção que deixou de servir sai do uso, nada é apagado
  answer:=public.panel_manheim_rematch_demand('preview',actor,v_upload,'journey:'||v_journey||':CARRO','[]');
  if (answer->>'withdrawn')::int<>1 then raise exception 'FALHA: rematch %', answer; end if;
  if (select count(*) from public.manheim_matches where upload_id=v_upload)<>1 then raise exception 'FALHA: rematch apagou histórico'; end if;
  if (select count(*) from public.panel_manheim_batch_summary('preview',v_upload))<>0 then raise exception 'FALHA: opção retirada ainda conta'; end if;

  -- permissões: só service_role executa; a tabela de blocos não é lida por anon/authenticated
  if has_function_privilege('anon','public.panel_manheim_batch_chunk(public.panel_environment, uuid, uuid, integer, integer, text, integer, jsonb, jsonb)','execute') then raise exception 'FALHA: anon executa'; end if;
  if has_function_privilege('authenticated','public.panel_manheim_batch_finalize(public.panel_environment, uuid, uuid)','execute') then raise exception 'FALHA: authenticated executa'; end if;
  if not has_function_privilege('service_role','public.panel_manheim_batch_start(public.panel_environment, uuid, text, integer, jsonb, jsonb, jsonb, text, jsonb, text)','execute') then raise exception 'FALHA: service_role sem permissão'; end if;
  if has_table_privilege('anon','public.manheim_upload_chunks','select') or has_table_privilege('authenticated','public.manheim_upload_chunks','select') then raise exception 'FALHA: blocos visíveis fora do servidor'; end if;
  if not (select relforcerowsecurity from pg_class where oid='public.manheim_upload_chunks'::regclass) then raise exception 'FALHA: RLS não forçado'; end if;
  raise notice 'OK: lote único em blocos';
end $$;
rollback;
