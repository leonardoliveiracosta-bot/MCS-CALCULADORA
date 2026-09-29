-- Find One For Me (CARRO): database defense for new anonymous inserts into calc_runs.
-- Extends the RESTRICTIVE policy calc_runs_insert_limits (migration 20260929030000). Every
-- previous condition is kept word for word; one condition is added:
--   * logical_mode, when present, is VALOR or CARRO (no MIXED);
--   * a busca row must say logical_mode CARRO, and a CARRO row must be a busca;
--   * a CARRO row carries ano_de and ano_ate (4 digits, positive, ano_de <= ano_ate) and
--     milhas_de and milhas_ate (1 to 7 digits, positive, milhas_de <= milhas_ate).
--     Empty strings, text, zero and negative values are refused.
-- Calculate My Cost rows (VALOR or no logical_mode) are not affected by the new condition.
-- Only inserts are checked: historical rows are not read, changed or deleted.
-- The casts run only inside CASE after the regex check, so a bad value is refused, not an error.

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'calc_runs' and policyname = 'calc_runs_insert_limits'
      and permissive = 'RESTRICTIVE' and cmd = 'INSERT' and roles = array['anon']::name[]
  ) then
    raise exception 'calc_runs_insert_limits ausente ou diferente do esperado';
  end if;

  alter policy calc_runs_insert_limits on public.calc_runs
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
      and (dados ->> 'logical_mode' is null or dados ->> 'logical_mode' in ('VALOR', 'CARRO'))
      and case
        when dados ->> 'evento' = 'busca' or dados ->> 'logical_mode' = 'CARRO' then
          case
            when dados ->> 'evento' = 'busca'
              and dados ->> 'logical_mode' = 'CARRO'
              and coalesce(dados ->> 'ano_de', '') ~ '^[1-9][0-9]{3}$'
              and coalesce(dados ->> 'ano_ate', '') ~ '^[1-9][0-9]{3}$'
              and coalesce(dados ->> 'milhas_de', '') ~ '^[1-9][0-9]{0,6}$'
              and coalesce(dados ->> 'milhas_ate', '') ~ '^[1-9][0-9]{0,6}$'
            then (dados ->> 'ano_de')::int <= (dados ->> 'ano_ate')::int
              and (dados ->> 'milhas_de')::int <= (dados ->> 'milhas_ate')::int
            else false
          end
        else true
      end
    );
end $$;
