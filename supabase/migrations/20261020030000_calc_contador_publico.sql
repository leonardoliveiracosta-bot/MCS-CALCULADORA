-- Contador público da calculadora: quantas pessoas concluíram (Calculate My Cost ou Find One For Me) nos
-- últimos N dias, e quantas disseram "Ready to buy now". Números reais, sem ajuste: cada visitante conta
-- uma vez (o sid da sessão, que não muda num refresh), e ficam fora os testes e as páginas de preview.
-- Só os dois totais saem daqui; nenhum dado de pessoa.
create or replace function public.calc_public_stats(p_days integer default 30)
returns jsonb language sql stable security definer set search_path = '' as $$
  with base as (
    select c.dados ->> 'sid' as sid, c.dados ->> 'prazo' as prazo
      from public.calc_runs c
     where not c.is_test
       and c.created_at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 90))
       and c.dados ->> 'evento' in ('simulacao', 'busca')
       and coalesce(c.origem, '') !~* '(vercel\.app|test)'
       and coalesce(c.dados ->> 'sid', '') not in ('', 'no-session')
  )
  select jsonb_build_object(
    'days', least(greatest(coalesce(p_days, 30), 1), 90),
    'total', (select count(distinct sid) from base),
    'ready', (select count(distinct sid) from base where prazo = 'now'),
    'at', now())
$$;
revoke all on function public.calc_public_stats(integer) from public, anon, authenticated;
grant execute on function public.calc_public_stats(integer) to service_role;
