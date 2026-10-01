-- Print de SMS tem cota diária própria: a cota da rotina de conversas esgotada não bloqueia o print,
-- e o print não consome a cota da rotina.
do $$ declare allowed jsonb; today date := (now() at time zone 'America/New_York')::date;
begin
  delete from public.conversation_ai_daily_usage where environment='preview';
  insert into public.conversation_ai_daily_usage values('preview',today,100,now());
  allowed:=public.panel_sms_print_reserve_read('preview');
  if not (allowed->>'allowed')::boolean or (allowed->>'count')::integer<>1 then raise exception 'PRINT_BLOCKED_BY_CONVERSATION_QUOTA'; end if;
  if (select call_count from public.conversation_ai_daily_usage where environment='preview' and day_et=today)<>100 then raise exception 'PRINT_USED_CONVERSATION_QUOTA'; end if;
  if (public.panel_ai_reserve_call('preview')->>'allowed')::boolean then raise exception 'CONVERSATION_QUOTA_CHANGED'; end if;
  update public.sms_print_ai_daily_usage set call_count=1999 where environment='preview' and day_et=today;
  allowed:=public.panel_sms_print_reserve_read('preview');
  if not (allowed->>'allowed')::boolean or (allowed->>'count')::integer<>2000 then raise exception 'PRINT_LIMIT_2000_FAILED'; end if;
  if (public.panel_sms_print_reserve_read('preview')->>'allowed')::boolean then raise exception 'PRINT_LIMIT_EXCEEDED'; end if;
  insert into public.sms_print_ai_daily_usage values('production',today-1,2000,now());
  if not (public.panel_sms_print_reserve_read('production')->>'allowed')::boolean then raise exception 'PRINT_DAY_DID_NOT_RESET'; end if;
  raise notice 'OK: print de SMS com cota diária própria';
end $$;
