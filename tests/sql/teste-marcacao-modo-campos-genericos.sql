-- Marcação por modo não altera os campos genéricos da ficha (migração 20261002010000).
begin;
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
values('62000000-0000-4000-8000-000000000001','preview','62000000-0000-4000-8000-000000000002','modos@example.com','admin',true,false)
on conflict do nothing;

create function pg_temp.mensagem(p_contact uuid, p_journey uuid, p_text text) returns uuid language plpgsql as $$
declare v_chat uuid:=gen_random_uuid(); v_message uuid:=gen_random_uuid();
begin
  insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at) values(v_chat,'preview','WHATSAPP',p_contact,'modo-'||v_chat,'RESOLVED',now(),now());
  insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
    values(v_message,'preview',v_chat,'WHATSAPP','CUSTOMER',p_text,lower(p_text),now(),'sig-modo-'||v_message,1,'IMPORT',now());
  insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',v_message,p_journey,'IMPORT',now());
  return v_message;
end $$;

create function pg_temp.ficha(p_criteria jsonb, p_vehicle text, out contact_id uuid, out journey_id uuid) language plpgsql as $$
begin
  contact_id:=gen_random_uuid(); journey_id:=gen_random_uuid();
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(contact_id,'preview','Cliente Modo','CALCULATOR',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,vehicle_text,created_at,updated_at)
    values(journey_id,'preview',contact_id,'CALCULATOR','NOVO','ATIVO',p_criteria,p_vehicle,now(),now());
  insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) values('preview',journey_id,1,'Carro e critérios confirmados','OPEN',now(),now());
end $$;

do $$
declare
  actor uuid:='62000000-0000-4000-8000-000000000001';
  f record; g record; h record;
  m1 uuid; m2 uuid; m3 uuid; m4 uuid; m5 uuid; m6 uuid; m7 uuid; m8 uuid;
  scion jsonb:='[{"make":"Scion","model":"tC","yearMin":2012,"yearMax":2014,"minMiles":1000,"maxMiles":90000}]';
  saab jsonb:='[{"make":"Saab","model":"9-3"}]';
  both_text text:='Por valor: Saab 9-3 · Por ano e milhagem: 2012–2014 Scion tC';
  first_result jsonb; again jsonb;
  j record;
begin
  select * into f from pg_temp.ficha('{}'::jsonb, 'Veículo original');
  m1:=pg_temp.mensagem(f.contact_id,f.journey_id,'quero um Scion tC');
  m2:=pg_temp.mensagem(f.contact_id,f.journey_id,'lance até 20 mil num Saab 9-3');
  m3:=pg_temp.mensagem(f.contact_id,f.journey_id,'painel antigo');
  m4:=pg_temp.mensagem(f.contact_id,f.journey_id,'texto longo');
  m5:=pg_temp.mensagem(f.contact_id,f.journey_id,'modo minúsculo');

  -- 1. CARRO: só mode_overrides.CARRO; nenhum campo genérico; vehicle_text = resumo enviado.
  --    O payload ainda traz value_json.wishlist (como o painel antigo): o gatilho tem de ignorar.
  perform public.panel_mark_message_fact_v2('preview',f.journey_id,m1,'VEHICLE',actor,'2012–2014 Scion tC',
    jsonb_build_object('wishlist',jsonb_build_object('wishlists',scion),'mode','CARRO','modeWishlists',scion,'vehicleText','Por ano e milhagem: 2012–2014 Scion tC'),null,false);
  select criteria_json, vehicle_text into j from public.journeys where id=f.journey_id;
  if j.criteria_json->'mode_overrides'->'CARRO'->'wishlists'->0->>'model'<>'tC' then raise exception 'FALHA 1: CARRO sem Scion'; end if;
  if j.criteria_json ? 'wishlist' or j.criteria_json ? 'wishlists' or j.criteria_json ? 'wishlistOverride' then raise exception 'FALHA 1: campo genérico alterado %', j.criteria_json; end if;
  if j.vehicle_text<>'Por ano e milhagem: 2012–2014 Scion tC' then raise exception 'FALHA 1: vehicle_text %', j.vehicle_text; end if;

  -- 2. VALOR: só mode_overrides.VALOR; CARRO continua Scion; resumo com os dois modos.
  first_result:=public.panel_mark_message_fact_v2('preview',f.journey_id,m2,'VEHICLE',actor,'Saab 9-3',
    jsonb_build_object('wishlist',jsonb_build_object('wishlists',saab),'mode','VALOR','modeWishlists',saab,'vehicleText',both_text),null,false);
  select criteria_json, vehicle_text into j from public.journeys where id=f.journey_id;
  if j.criteria_json->'mode_overrides'->'VALOR'->'wishlists'->0->>'model'<>'9-3' then raise exception 'FALHA 2: VALOR sem Saab'; end if;
  if j.criteria_json->'mode_overrides'->'CARRO'->'wishlists'->0->>'model'<>'tC' then raise exception 'FALHA 2: CARRO perdeu o Scion'; end if;
  if j.criteria_json ? 'wishlist' or j.criteria_json ? 'wishlists' or j.criteria_json ? 'wishlistOverride' then raise exception 'FALHA 2: campo genérico alterado'; end if;
  if j.vehicle_text<>both_text then raise exception 'FALHA 2: vehicle_text %', j.vehicle_text; end if;
  -- A declaração guarda exatamente o que foi marcado, com o modo.
  if (select value_text from public.journey_declarations where message_id=m2)<>'Saab 9-3' then raise exception 'FALHA 2: value_text da declaração'; end if;
  if (select value_json->>'mode' from public.journey_declarations where message_id=m2)<>'VALOR' then raise exception 'FALHA 2: modo da declaração'; end if;

  -- Idempotência: a mesma mensagem marcada de novo devolve o mesmo resultado e não grava nada.
  again:=public.panel_mark_message_fact_v2('preview',f.journey_id,m2,'VEHICLE',actor,'Outro',
    jsonb_build_object('mode','VALOR','modeWishlists','[{"make":"Pontiac","model":"G8"}]'::jsonb,'vehicleText','Outro texto'),null,false);
  if again<>first_result then raise exception 'FALHA idempotência: resultado diferente'; end if;
  if (select vehicle_text from public.journeys where id=f.journey_id)<>both_text then raise exception 'FALHA idempotência: vehicle_text mudou'; end if;
  if (select count(*) from public.journey_declarations where message_id=m2)<>1 then raise exception 'FALHA idempotência: declaração duplicada'; end if;

  -- 9. Painel antigo com a RPC nova: modo, wishlist e sem vehicleText. O modo é registrado,
  --    os campos genéricos e o vehicle_text ficam como estão.
  perform public.panel_mark_message_fact_v2('preview',f.journey_id,m3,'VEHICLE',actor,'Pontiac G8',
    jsonb_build_object('wishlist',jsonb_build_object('wishlists','[{"make":"Pontiac","model":"G8"}]'::jsonb),'mode','VALOR','modeWishlists','[{"make":"Pontiac","model":"G8"}]'::jsonb),null,false);
  select criteria_json, vehicle_text into j from public.journeys where id=f.journey_id;
  if j.criteria_json->'mode_overrides'->'VALOR'->'wishlists'->0->>'model'<>'G8' then raise exception 'FALHA 9: modo não registrado'; end if;
  if j.criteria_json->'mode_overrides'->'CARRO'->'wishlists'->0->>'model'<>'tC' then raise exception 'FALHA 9: CARRO alterado'; end if;
  if j.criteria_json ? 'wishlist' or j.criteria_json ? 'wishlists' then raise exception 'FALHA 9: campo genérico alterado'; end if;
  if j.vehicle_text<>both_text then raise exception 'FALHA 9: vehicle_text trocado por p_value (%)', j.vehicle_text; end if;

  -- vehicleText acima de 500 caracteres: vehicle_text fica.
  perform public.panel_mark_message_fact_v2('preview',f.journey_id,m4,'VEHICLE',actor,'Saab 9-3',
    jsonb_build_object('mode','VALOR','modeWishlists',saab,'vehicleText',repeat('x',501)),null,false);
  if (select vehicle_text from public.journeys where id=f.journey_id)<>both_text then raise exception 'FALHA: vehicleText longo aceito'; end if;

  -- Modo em minúsculas: o gatilho também ignora a wishlist.
  perform public.panel_mark_message_fact_v2('preview',f.journey_id,m5,'VEHICLE',actor,'Saab 9-3',
    jsonb_build_object('wishlist',jsonb_build_object('wishlists',saab),'mode','carro'),null,false);
  if (select criteria_json ? 'wishlist' from public.journeys where id=f.journey_id) then raise exception 'FALHA: modo minúsculo passou pelo gatilho'; end if;
  if (select vehicle_text from public.journeys where id=f.journey_id)<>both_text then raise exception 'FALHA: modo minúsculo trocou vehicle_text'; end if;

  -- 4/5. Sem modo: exatamente como antes (gatilho copia a wishlist, confirmedWishlists vira a
  --      lista da ficha e vehicle_text = p_value).
  select * into g from pg_temp.ficha('{}'::jsonb, null);
  m6:=pg_temp.mensagem(g.contact_id,g.journey_id,'quero um Civic');
  perform public.panel_mark_message_fact_v2('preview',g.journey_id,m6,'VEHICLE',actor,'Honda Civic',
    jsonb_build_object('wishlist',jsonb_build_object('wishlists','[{"make":"Honda","model":"Civic"}]'::jsonb),'confirmedWishlists','[{"make":"Honda","model":"Civic"}]'::jsonb),null,false);
  select criteria_json, vehicle_text into j from public.journeys where id=g.journey_id;
  if j.criteria_json->'wishlist'->'wishlists'->0->>'model'<>'Civic' then raise exception 'FALHA 4: gatilho sem modo deixou de copiar'; end if;
  if j.criteria_json->'wishlists'->0->>'model'<>'Civic' or (j.criteria_json->>'wishlistOverride')::boolean is not true then raise exception 'FALHA 4: confirmedWishlists sem modo'; end if;
  if j.vehicle_text<>'Honda Civic' then raise exception 'FALHA 4: vehicle_text sem modo'; end if;

  -- Payload com modo nunca alimenta confirmedWishlists genérico.
  select * into h from pg_temp.ficha('{"wishlists":[{"make":"Kia","model":"Soul"}]}'::jsonb, 'Kia Soul');
  m7:=pg_temp.mensagem(h.contact_id,h.journey_id,'mistura');
  perform public.panel_mark_message_fact_v2('preview',h.journey_id,m7,'VEHICLE',actor,'Honda Civic',
    jsonb_build_object('mode','CARRO','confirmedWishlists','[{"make":"Honda","model":"Civic"}]'::jsonb),null,false);
  select criteria_json, vehicle_text into j from public.journeys where id=h.journey_id;
  if j.criteria_json->'wishlists'->0->>'model'<>'Soul' then raise exception 'FALHA: confirmedWishlists com modo alterou a lista genérica'; end if;
  if j.vehicle_text<>'Kia Soul' then raise exception 'FALHA: vehicle_text com modo sem vehicleText'; end if;

  -- Falha simulada continua desfazendo tudo, com modo.
  m8:=pg_temp.mensagem(h.contact_id,h.journey_id,'falha');
  again:=public.panel_mark_message_fact_v2('preview',h.journey_id,m8,'VEHICLE',actor,'Saab 9-3',
    jsonb_build_object('mode','VALOR','modeWishlists',saab,'vehicleText','Por valor: Saab 9-3'),null,true);
  if again->>'rolledBack'<>'true' then raise exception 'FALHA: falha simulada'; end if;
  if exists(select 1 from public.journey_declarations where message_id=m8) or exists(select 1 from public.message_fact_marks where message_id=m8) then raise exception 'FALHA: falha simulada gravou'; end if;
  if (select vehicle_text from public.journeys where id=h.journey_id)<>'Kia Soul' then raise exception 'FALHA: falha simulada alterou vehicle_text'; end if;

  -- Permissões iguais às de antes.
  if has_function_privilege('anon','public.panel_mark_message_fact_v2(public.panel_environment,uuid,uuid,text,uuid,text,jsonb,timestamptz,boolean)','execute')
     or has_function_privilege('authenticated','public.panel_mark_message_fact_v2(public.panel_environment,uuid,uuid,text,uuid,text,jsonb,timestamptz,boolean)','execute')
     or not has_function_privilege('service_role','public.panel_mark_message_fact_v2(public.panel_environment,uuid,uuid,text,uuid,text,jsonb,timestamptz,boolean)','execute')
  then raise exception 'FALHA: permissões da RPC'; end if;
  if has_function_privilege('anon','private.panel_sync_wishlist_declaration()','execute') or has_function_privilege('authenticated','private.panel_sync_wishlist_declaration()','execute')
  then raise exception 'FALHA: permissões do gatilho'; end if;
  if not (select prosecdef from pg_proc where oid='public.panel_mark_message_fact_v2(public.panel_environment,uuid,uuid,text,uuid,text,jsonb,timestamptz,boolean)'::regprocedure)
     or (select proconfig from pg_proc where oid='public.panel_mark_message_fact_v2(public.panel_environment,uuid,uuid,text,uuid,text,jsonb,timestamptz,boolean)'::regprocedure)<>array['search_path=""']
  then raise exception 'FALHA: security definer ou search_path'; end if;
  raise notice 'OK: marcação por modo não altera os campos genéricos';
end $$;
rollback;
