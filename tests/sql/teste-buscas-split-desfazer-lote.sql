-- BUSCAS por modo e desfazer lote do Manheim (migração 20261001010000).
begin;
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
values('61000000-0000-4000-8000-000000000001','preview','61000000-0000-4000-8000-000000000002','buscas@example.com','admin',true,false)
on conflict do nothing;
do $$
declare
  actor uuid:='61000000-0000-4000-8000-000000000001';
  v_contact uuid:=gen_random_uuid();
  v_journey uuid:=gen_random_uuid();
  v_unit uuid:=gen_random_uuid();
  v_vitrine uuid:=gen_random_uuid();
  first_upload jsonb;
  second_upload jsonb;
  first_id uuid;
  second_id uuid;
  undo_one jsonb;
  undo_two jsonb;
  car jsonb:='{"parsed":{"year":2022,"make":"BMW","model":"X5","miles":70000,"mmrCents":4500000}}';
begin
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(v_contact,'preview','Cliente Modos','CALCULATOR',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(v_journey,'preview',v_contact,'CALCULATOR','NOVO','ATIVO','{}',now(),now());
  insert into public.calc_runs(dados) values('{"ref":"QZ7K2","sid":"s1","evento":"busca","logical_mode":"CARRO"}');

  -- o mesmo carro, a mesma ficha e o mesmo lote: um match CARRO e um VALOR
  first_upload:=public.panel_store_manheim_upload('preview',actor,2,1,'[["VIN"]]','{}',jsonb_build_array(
    jsonb_build_object('journeyId',v_journey,'kind','BATE','mode','CARRO','fingerprint','vin:MODOS1','vehicle',car),
    jsonb_build_object('journeyId',v_journey,'kind','POR_VALOR','mode','VALOR','fingerprint','vin:MODOS1','vehicle',car),
    jsonb_build_object('targetType','ORDER','calcRef','QZ7K2','kind','BATE','mode','CARRO','fingerprint','vin:MODOS1','vehicle',car)));
  first_id:=(first_upload->>'uploadId')::uuid;
  if (select count(*) from public.manheim_matches where upload_id=first_id)<>3 then raise exception 'FALHA: CARRO e VALOR do mesmo carro não ficaram separados'; end if;
  if (select count(distinct logical_mode) from public.manheim_matches where upload_id=first_id and journey_id=v_journey)<>2 then raise exception 'FALHA: logical_mode não gravado'; end if;

  -- CARRO nunca aceita QUASE nem POR_VALOR
  begin
    perform public.panel_store_manheim_upload('preview',actor,1,1,'[["VIN"]]','{}',jsonb_build_array(
      jsonb_build_object('journeyId',v_journey,'kind','QUASE','mode','CARRO','fingerprint','vin:MODOS2','vehicle',car)));
    raise exception 'FALHA: QUASE em CARRO foi aceito';
  exception when others then
    if sqlerrm not like '%MANHEIM_MATCH_INVALID%' then raise; end if;
  end;
  begin
    perform public.panel_store_manheim_upload('preview',actor,1,1,'[["VIN"]]','{}',jsonb_build_array(
      jsonb_build_object('journeyId',v_journey,'kind','BATE','mode','MIXED','fingerprint','vin:MODOS2','vehicle',car)));
    raise exception 'FALHA: modo MIXED foi aceito';
  exception when others then
    if sqlerrm not like '%MANHEIM_MATCH_INVALID%' then raise; end if;
  end;

  insert into public.manheim_vehicles(environment,upload_id,row_fingerprint,vehicle_json,uploaded_at) values('preview',first_id,'vin:MODOS1',car->'parsed',now());
  -- ação humana ligada ao lote: unidade apresentada e vitrine
  insert into public.units(id,environment,journey_id,vehicle_text,presented_at) values(v_unit,'preview',v_journey,'2022 BMW X5',now());
  update public.manheim_matches set presented_unit_id=v_unit where upload_id=first_id and journey_id=v_journey and logical_mode='CARRO';
  insert into public.vitrines(id,environment,token,journey_id,reference_code,expires_at) values(v_vitrine,'preview','tok-modos-'||v_vitrine,v_journey,'QZ7K2',now()+interval '7 days');
  insert into public.vitrine_cars(environment,vitrine_id,source_match_id,short_code,vehicle_snapshot)
    select 'preview',v_vitrine,id,'sc-'||left(id::text,8),vehicle_json from public.manheim_matches where upload_id=first_id and journey_id=v_journey and logical_mode='VALOR';

  -- segundo lote (vários CSVs no mesmo lote)
  second_upload:=public.panel_store_manheim_upload('preview',actor,3,1,'[["VIN"]]','{}',jsonb_build_array(
    jsonb_build_object('journeyId',v_journey,'kind','BATE','mode','CARRO','fingerprint','vin:MODOS3','vehicle',car)));
  second_id:=(second_upload->>'uploadId')::uuid;

  undo_one:=public.panel_undo_manheim_upload('preview',actor,first_id);
  if (undo_one->>'alreadyUndone')::boolean then raise exception 'FALHA: primeiro desfazer marcado como repetido'; end if;
  if (undo_one->'summary'->>'matchesWithdrawn')::int<>3 or (undo_one->'summary'->>'vehiclesWithdrawn')::int<>1 then raise exception 'FALHA: contagens do desfazer %',undo_one; end if;
  if (undo_one->'summary'->>'unitsPreserved')::int<>1 or (undo_one->'summary'->>'vitrinesPreserved')::int<>1 then raise exception 'FALHA: dependências não relatadas %',undo_one; end if;
  if exists(select 1 from public.manheim_matches where upload_id=first_id and undone_at is null) then raise exception 'FALHA: match ativo depois do desfazer'; end if;
  if (select count(*) from public.manheim_matches where upload_id=first_id)<>3 then raise exception 'FALHA: match apagado fisicamente'; end if;
  if not exists(select 1 from public.units where id=v_unit) or not exists(select 1 from public.vitrine_cars where vitrine_id=v_vitrine) then raise exception 'FALHA: unidade ou vitrine perdida'; end if;
  if exists(select 1 from public.manheim_matches where upload_id=second_id and undone_at is not null) or (select undone_at from public.manheim_uploads where id=second_id) is not null then
    raise exception 'FALHA: o outro lote foi alterado';
  end if;

  -- idempotente
  undo_two:=public.panel_undo_manheim_upload('preview',actor,first_id);
  if not (undo_two->>'alreadyUndone')::boolean then raise exception 'FALHA: desfazer duas vezes não é idempotente'; end if;
  if (select count(*) from public.activity_log where activity_type='MANHEIM_UPLOAD_UNDONE' and metadata->>'upload_id'=first_id::text)<>1 then raise exception 'FALHA: activity_log duplicado'; end if;
  if (select count(*) from public.audit_log where action='UNDO' and entity_id=first_id)<>1 then raise exception 'FALHA: audit_log do desfazer'; end if;
  if (select count(*) from public.panel_notifications where entity_id=first_id and topic='panel.updated')<2 then raise exception 'FALHA: panel.updated não publicado'; end if;

  begin
    perform public.panel_undo_manheim_upload('production',actor,second_id);
    raise exception 'FALHA: operador de outro ambiente desfez o lote';
  exception when others then
    if sqlerrm not like '%PANEL_ACTOR_NOT_AUTHORIZED%' then raise; end if;
  end;
  begin
    perform public.panel_undo_manheim_upload('preview',actor,gen_random_uuid());
    raise exception 'FALHA: lote inexistente aceito';
  exception when others then
    if sqlerrm not like '%MANHEIM_UPLOAD_NOT_FOUND%' then raise; end if;
  end;

  -- nova gravação sem modo é recusada (nas duas RPCs)
  begin
    perform public.panel_store_manheim_upload('preview',actor,1,1,'[["VIN"]]','{}',jsonb_build_array(
      jsonb_build_object('journeyId',v_journey,'kind','BATE','fingerprint','vin:SEMMODO','vehicle',car)));
    raise exception 'FALHA: match sem modo foi aceito';
  exception when others then
    if sqlerrm not like '%MANHEIM_MATCH_INVALID%' then raise; end if;
  end;
  begin
    perform public.panel_store_manheim_upload_part('preview',actor,null,1,2,1,1,'[["VIN"]]','{}',jsonb_build_array(
      jsonb_build_object('journeyId',v_journey,'kind','BATE','fingerprint','vin:SEMMODO','vehicle',car)));
    raise exception 'FALHA: match sem modo foi aceito em partes';
  exception when others then
    if sqlerrm not like '%MANHEIM_MATCH_INVALID%' then raise; end if;
  end;
  -- CARRO e VALOR válidos continuam gravando
  if (public.panel_store_manheim_upload('preview',actor,1,1,'[["VIN"]]','{}',jsonb_build_array(
      jsonb_build_object('journeyId',v_journey,'kind','BATE','mode','CARRO','fingerprint','vin:OKCARRO','vehicle',car),
      jsonb_build_object('journeyId',v_journey,'kind','POR_VALOR','mode','VALOR','fingerprint','vin:OKVALOR','vehicle',car)))->>'matchedVehicleCount')::int<>2 then
    raise exception 'FALHA: CARRO e VALOR válidos não gravaram';
  end if;
  -- linha histórica com modo nulo continua existindo e legível
  insert into public.manheim_matches(environment,upload_id,journey_id,match_kind,row_fingerprint,vehicle_json)
    values('preview',second_id,v_journey,'QUASE','vin:HISTORICO',car);
  if not exists(select 1 from public.manheim_matches where row_fingerprint='vin:HISTORICO' and logical_mode is null) then raise exception 'FALHA: histórico nulo perdido'; end if;
  -- desfazer continua idempotente depois disso
  if not (public.panel_undo_manheim_upload('preview',actor,first_id)->>'alreadyUndone')::boolean then raise exception 'FALHA: desfazer deixou de ser idempotente'; end if;
  if not exists(select 1 from public.manheim_matches where row_fingerprint='vin:HISTORICO' and undone_at is null) then raise exception 'FALHA: histórico do lote vizinho alterado'; end if;

  -- "Carro ou faixa" marcado para UM modo vai só para mode_overrides daquele modo
  update public.journeys set criteria_json='{"wishlists":[{"make":"Honda","model":"Civic"}]}'::jsonb where id=v_journey;
  declare
    v_chat uuid:=gen_random_uuid();
    v_message uuid:=gen_random_uuid();
    marked jsonb;
  begin
    insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at) values(v_chat,'preview','WHATSAPP',v_contact,'modos-'||v_chat,'RESOLVED',now(),now());
    insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
      values(v_message,'preview',v_chat,'WHATSAPP','CUSTOMER','quero X5 até 50k','quero x5 ate 50k',now(),'sig-modos-'||v_message,1,'IMPORT',now());
    insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',v_message,v_journey,'IMPORT',now());
    insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) values('preview',v_journey,1,'Carro e critérios confirmados','OPEN',now(),now());
    marked:=public.panel_mark_message_fact_v2('preview',v_journey,v_message,'VEHICLE',actor,'BMW X5',
      '{"mode":"VALOR","modeWishlists":[{"make":"BMW","model":"X5"}]}'::jsonb,null,false);
    if (select criteria_json->'mode_overrides'->'VALOR'->'wishlists'->0->>'model' from public.journeys where id=v_journey)<>'X5' then raise exception 'FALHA: VALOR não recebeu o carro'; end if;
    if (select criteria_json->'mode_overrides' ? 'CARRO' from public.journeys where id=v_journey) then raise exception 'FALHA: CARRO recebeu o carro do VALOR'; end if;
    if (select criteria_json->'wishlists'->0->>'model' from public.journeys where id=v_journey)<>'Civic' then raise exception 'FALHA: lista genérica alterada'; end if;
  end;

  -- marca de busca por modo
  insert into public.panel_search_marks(environment,journey_id,kind,logical_mode,created_by) values('preview',v_journey,'SAVED','VALOR',actor);
  if exists(select 1 from public.panel_search_marks where journey_id=v_journey and logical_mode='CARRO') then raise exception 'FALHA: marca VALOR alterou CARRO'; end if;
  raise notice 'OK: buscas por modo e desfazer lote';
end $$;
rollback;
