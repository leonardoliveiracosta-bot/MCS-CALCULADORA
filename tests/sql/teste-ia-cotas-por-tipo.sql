-- IA do painel: rotina (1000/dia) e cliques manuais (2000/dia) contados em separado.
-- A rotina esgotada não trava o clique do operador.
do $$ declare r jsonb; today date := (now() at time zone 'America/New_York')::date;
begin
  insert into public.panel_ai_daily_usage_kind values('preview',today,'ROTINA',999,now());
  r:=public.panel_ai_reserve_call('preview','ROTINA');
  if not (r->>'allowed')::boolean or (r->>'count')::integer<>1000 then raise exception 'ROTINA_LIMIT_1000_FAILED'; end if;
  if (public.panel_ai_reserve_call('preview','ROTINA')->>'allowed')::boolean then raise exception 'ROTINA_LIMIT_EXCEEDED'; end if;
  r:=public.panel_ai_reserve_call('preview','MANUAL');
  if not (r->>'allowed')::boolean or (r->>'count')::integer<>1 then raise exception 'MANUAL_BLOCKED_BY_ROTINA'; end if;
  update public.panel_ai_daily_usage_kind set call_count=1999 where environment='preview' and day_et=today and kind='MANUAL';
  if not (public.panel_ai_reserve_call('preview','MANUAL')->>'allowed')::boolean then raise exception 'MANUAL_LIMIT_2000_FAILED'; end if;
  if (public.panel_ai_reserve_call('preview','MANUAL')->>'allowed')::boolean then raise exception 'MANUAL_LIMIT_EXCEEDED'; end if;
  begin perform public.panel_ai_reserve_call('preview','OUTRO'); raise exception 'KIND_SHOULD_FAIL';
  exception when others then if sqlerrm not like '%AI_KIND_INVALID%' then raise; end if; end;
  insert into public.panel_ai_daily_usage_kind values('production',today-1,'ROTINA',1000,now());
  if not (public.panel_ai_reserve_call('production','ROTINA')->>'allowed')::boolean then raise exception 'ROTINA_DAY_DID_NOT_RESET'; end if;
  raise notice 'OK: cotas da IA por tipo (rotina 1000, manual 2000)';
end $$;
