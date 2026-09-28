-- Limits for anonymous inserts into calc_runs (audit A29). Additive: a RESTRICTIVE policy is
-- ANDed with the existing permissive "site_insere" policy, so nothing is dropped.
-- Compatible with msc-calculadora.html as published (registrar/registrarBusca): the site sends
-- zip, estado, lance, total, pagamento, idioma, whatsapp=null, origem and dados with a 5-letter
-- Ref from the alphabet ABCDEFGHJKLMNPQRSTUVWXYZ23456789 (real rows: dados <= 435 bytes).
-- Rows with Ref "-----" (browser without sessionStorage) are refused: the panel already ignores them.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'calc_runs' and policyname = 'calc_runs_insert_limits'
  ) then
    create policy calc_runs_insert_limits on public.calc_runs
      as restrictive
      for insert
      to anon
      with check (
        jsonb_typeof(dados) = 'object'
        and octet_length(dados::text) <= 4096
        and coalesce(dados ->> 'ref', '') ~ '^[A-HJ-NP-Z2-9]{5}$'
        and coalesce(dados ->> 'evento', '') in ('simulacao', 'saida', 'share', 'whatsapp', 'sms', 'busca')
        and length(coalesce(dados ->> 'sid', '')) between 1 and 120
        and (lance is null or (lance >= 0 and lance <= 10000000))
        and (total is null or (total >= 0 and total <= 20000000))
        and length(coalesce(zip, '')) <= 10
        and length(coalesce(estado, '')) <= 40
        and length(coalesce(pagamento, '')) <= 20
        and length(coalesce(idioma, '')) <= 10
        and length(coalesce(origem, '')) <= 200
        and whatsapp is null
        and coalesce(is_test, false) = false
      );
  end if;
end $$;
