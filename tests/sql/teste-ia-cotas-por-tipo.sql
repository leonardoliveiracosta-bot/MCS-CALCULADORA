-- IA do painel (Claude): as chamadas continuam contadas por tipo e por dia, mas nenhuma cota diária
-- recusa mais (o limite é o saldo pré-pago do provedor).
do $$ declare r jsonb; today date := (now() at time zone 'America/New_York')::date;
begin
  insert into public.panel_ai_daily_usage_kind values('preview',today,'ROTINA',999,now());
  r:=public.panel_ai_reserve_call('preview','ROTINA');
  if not (r->>'allowed')::boolean or (r->>'count')::integer<>1000 then raise exception 'ROTINA_COUNT_FAILED'; end if;
  r:=public.panel_ai_reserve_call('preview','ROTINA');
  if not (r->>'allowed')::boolean or (r->>'count')::integer<>1001 then raise exception 'ROTINA_STILL_CAPPED'; end if;
  r:=public.panel_ai_reserve_call('preview','MANUAL');
  if not (r->>'allowed')::boolean or (r->>'count')::integer<>1 then raise exception 'MANUAL_BLOCKED_BY_ROTINA'; end if;
  update public.panel_ai_daily_usage_kind set call_count=5000 where environment='preview' and day_et=today and kind='MANUAL';
  if not (public.panel_ai_reserve_call('preview','MANUAL')->>'allowed')::boolean then raise exception 'MANUAL_STILL_CAPPED'; end if;
  begin perform public.panel_ai_reserve_call('preview','OUTRO'); raise exception 'KIND_SHOULD_FAIL';
  exception when others then if sqlerrm not like '%AI_KIND_INVALID%' then raise; end if; end;
  raise notice 'OK: chamadas da IA contadas por tipo, sem cota diária';
end $$;
