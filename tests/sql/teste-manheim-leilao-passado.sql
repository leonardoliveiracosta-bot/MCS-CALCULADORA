-- Carro com leilão passado sai sozinho das opções e da seleção (migração 20261027010000): nada é
-- apagado e o resumo diz quais selecionados saíram. Dia na Flórida (America/New_York). Buy Now só expira pelo
-- endsAt (a data de um Buy Now é quando entrou na lista, não um dia de leilão).
begin;
do $$
declare
  t timestamptz:='2026-10-05T15:00:00Z'; -- 11h na Flórida
  lane jsonb:='{"lane":"A","run":"12"}';
begin
  -- regra pura
  if not public.panel_manheim_offer_expired(lane||'{"startsAt":"2026-10-04T14:00:00Z","endsAt":"2026-10-09T00:00:00Z"}',t) then raise exception 'FALHA: Lane de ontem não expirou'; end if;
  -- Lane/Run sai no horário de início (20261029020000): 9h da Flórida já começou às 11h; 12h ainda não.
  if not public.panel_manheim_offer_expired(lane||'{"startsAt":"2026-10-05T13:00:00Z","endsAt":"2026-10-09T00:00:00Z"}',t) then raise exception 'FALHA: Lane que já começou hoje não expirou'; end if;
  if public.panel_manheim_offer_expired(lane||'{"startsAt":"2026-10-05T16:00:00Z","endsAt":"2026-10-09T00:00:00Z"}',t) then raise exception 'FALHA: Lane de mais tarde hoje expirou'; end if;
  if not public.panel_manheim_offer_expired(lane||'{"startsAt":"2026-10-05T15:00:00Z"}',t) then raise exception 'FALHA: Lane no minuto do início não expirou'; end if;
  if public.panel_manheim_offer_expired(lane||'{"startsAt":"2026-10-06T13:00:00Z"}',t) then raise exception 'FALHA: Lane de amanhã expirou'; end if;
  if public.panel_manheim_offer_expired(lane,t) then raise exception 'FALHA: sem data expirou'; end if;
  if public.panel_manheim_offer_expired('{}',t) then raise exception 'FALHA: vazio expirou'; end if;
  -- 22h de 4/10 na Flórida = 02h UTC de 5/10: é ontem na Flórida
  if not public.panel_manheim_offer_expired(lane||'{"startsAt":"2026-10-05T02:00:00Z"}',t) then raise exception 'FALHA: dia não usou a Flórida'; end if;
  if not public.panel_manheim_offer_expired(lane||'{"saleDate":"2026-10-04"}',t) then raise exception 'FALHA: saleDate só data de ontem'; end if;
  -- só data, sem hora: o dia começa à 0h da Flórida
  if not public.panel_manheim_offer_expired(lane||'{"saleDate":"2026-10-05"}',t) then raise exception 'FALHA: saleDate só data de hoje não expirou'; end if;
  if public.panel_manheim_offer_expired(lane||'{"saleDate":"2026-10-06"}',t) then raise exception 'FALHA: saleDate só data de amanhã expirou'; end if;
  if public.panel_manheim_offer_expired(lane||'{"startsAt":"amanhã cedo"}',t) then raise exception 'FALHA: data ilegível expirou'; end if;
  if not public.panel_manheim_offer_expired(lane||'{"endsAt":"2026-10-05T14:00:00Z"}',t) then raise exception 'FALHA: endsAt passado não expirou'; end if;
  -- Buy Now: a data de entrada antiga não expira; só o endsAt
  if public.panel_manheim_offer_expired('{"buyNowPrice":"25000","startsAt":"2026-09-20T10:00:00Z","endsAt":"2026-10-20T00:00:00Z"}',t) then raise exception 'FALHA: Buy Now aberto expirou'; end if;
  if public.panel_manheim_offer_expired('{"buyNowPrice":"25000"}',t) then raise exception 'FALHA: Buy Now sem data expirou'; end if;
  if not public.panel_manheim_offer_expired('{"buyNowPrice":"25000","endsAt":"2026-10-05T10:00:00Z"}',t) then raise exception 'FALHA: Buy Now encerrado não expirou'; end if;
end $$;

-- leituras de opções: expirado some, também o selecionado
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
values('6f100000-0000-4000-8000-000000000001','preview','6f100000-0000-4000-8000-000000000002','leilao@example.com','admin',true,false)
on conflict do nothing;
do $$
declare
  actor uuid:='6f100000-0000-4000-8000-000000000001';
  v_contact uuid:=gen_random_uuid(); v_journey uuid:=gen_random_uuid(); v_upload uuid:=gen_random_uuid();
  live uuid:=gen_random_uuid(); old uuid:=gen_random_uuid(); kept uuid:=gen_random_uuid(); buynow uuid:=gen_random_uuid();
  dk text; today date:=(now() at time zone 'America/New_York')::date;
  car jsonb:='{"year":2022,"make":"Jeep","model":"Wrangler","trim":"Rubicon","miles":20000,"mmrCents":3000000,"lane":"B","run":"7"}';
  n integer; s record;
begin
  dk:='journey:'||v_journey||':CARRO';
  insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values(v_contact,'preview','Cliente Leilão','WHATSAPP_DIRECT',now(),now());
  insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at)
    values(v_journey,'preview',v_contact,'WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{"logical_modes":["CARRO"]}',now(),now());
  insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by,activated_at) values(v_upload,'preview',1,4,actor,now());
  insert into public.manheim_matches(id,environment,upload_id,journey_id,logical_mode,demand_key,match_kind,row_fingerprint,mmr_cents,vehicle_json) values
    (live,'preview',v_upload,v_journey,'CARRO',dk,'BATE','vin:LIVE',3000000,jsonb_build_object('parsed',car||jsonb_build_object('vin','VINLIVE0000000001','startsAt',(today+1)::text||'T14:00:00Z'))),
    (old,'preview',v_upload,v_journey,'CARRO',dk,'BATE','vin:OLD',3000000,jsonb_build_object('parsed',car||jsonb_build_object('vin','VINOLD00000000001','startsAt',(today-1)::text||'T14:00:00Z','endsAt',(today+3)::text||'T00:00:00Z'))),
    (kept,'preview',v_upload,v_journey,'CARRO',dk,'BATE','vin:KEPT',3000000,jsonb_build_object('parsed',car||jsonb_build_object('vin','VINKEPT0000000001','startsAt',(today-1)::text||'T14:00:00Z'))),
    (buynow,'preview',v_upload,v_journey,'CARRO',dk,'BATE','vin:BN',3000000,jsonb_build_object('parsed',(car-'lane'-'run')||jsonb_build_object('vin','VINBN000000000001','buyNowPrice','31000','startsAt',(today-10)::text||'T14:00:00Z','endsAt',(today+5)::text||'T00:00:00Z')));
  insert into public.manheim_option_selections(environment,match_id,upload_id,demand_key,status,offer_group,mmr_cents,default_pct,final_cents)
    values('preview',kept,v_upload,dk,'SELECTED','LANE',3000000,10,3300000);

  -- o de leilão passado sai, selecionado ou não; o vivo e o Buy Now aberto ficam
  select count(*) into n from public.panel_manheim_offer_page('preview',v_upload,dk,'LANE',0,50) p where p.id in (old,kept);
  if n<>0 then raise exception 'FALHA: page mostra carro de leilão passado (%)',n; end if;
  select count(*) into n from public.panel_manheim_offer_page('preview',v_upload,dk,'LANE',0,50) p where p.id=live;
  if n<>1 then raise exception 'FALHA: page perdeu o vivo'; end if;
  select count(*) into n from public.panel_manheim_offer_page_sorted('preview',v_upload,dk,'LANE','year_desc',0,50);
  if n<>1 then raise exception 'FALHA: page_sorted %',n; end if;
  select count(*) into n from public.panel_manheim_offer_page_trim('preview',v_upload,dk,'LANE','year_desc','{}',0,50);
  if n<>1 then raise exception 'FALHA: page_trim %',n; end if;
  select sum(car_count) into n from public.panel_manheim_offer_trims('preview',v_upload,dk,'LANE');
  if n<>1 then raise exception 'FALHA: trims %',n; end if;
  select count(*) into n from public.panel_manheim_offer_page('preview',v_upload,dk,'OFFLANE',0,50);
  if n<>1 then raise exception 'FALHA: Buy Now aberto sumiu (%)',n; end if;
  -- saiu da seleção: não conta, e o resumo diz qual saiu
  select * into s from public.panel_manheim_offer_summary('preview',v_upload) x where x.demand_key=dk;
  if s.lane_count<>1 or s.offlane_count<>1 or s.selected_count<>0 or s.selected_ids<>'{}'::uuid[] then raise exception 'FALHA: summary % % % %',s.lane_count,s.offlane_count,s.selected_count,s.selected_ids; end if;
  if s.ended_selected<>array['2022 Jeep Wrangler Rubicon'] then raise exception 'FALHA: aviso dos que saíram %',s.ended_selected; end if;
  select match_count into n from public.panel_manheim_batch_summary('preview',v_upload) x where x.demand_key=dk;
  if n<>2 then raise exception 'FALHA: batch_summary %',n; end if;
  -- nada foi apagado nem desfeito: o match e a linha da seleção continuam no banco
  if (select count(*) from public.manheim_matches where upload_id=v_upload and undone_at is null)<>4 then raise exception 'FALHA: match apagado'; end if;
  if (select count(*) from public.manheim_option_selections where match_id=kept)<>1 then raise exception 'FALHA: seleção apagada'; end if;
  -- carro de leilão passado não pode ser selecionado nem editado
  begin
    perform public.panel_manheim_offer_select_v2('preview',actor,old,'SELECT',null,null,null,null);
    raise exception 'FALHA: selecionou carro de leilão passado';
  exception when others then if sqlerrm<>'MANHEIM_SALE_ENDED' then raise; end if; end;
  begin
    perform public.panel_manheim_offer_select_v2('preview',actor,kept,'PRICE',12,null,null,null);
    raise exception 'FALHA: editou carro de leilão passado';
  exception when others then if sqlerrm<>'MANHEIM_SALE_ENDED' then raise; end if; end;
end $$;
rollback;
