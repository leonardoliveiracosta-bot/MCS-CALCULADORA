-- Identidade dos contatos: a Ref que o cliente escreveu na mensagem da calculadora ("Ref: XXXXX")
-- comprova o pedido mesmo quando a simulação não está em calc_runs. Esta função só lê: devolve,
-- por ficha, cada Ref explícita das mensagens do cliente, o tipo da calculadora pela própria
-- mensagem (Find One For Me = CARRO; Calculate My Cost = VALOR) e quando ela chegou.
-- Aditiva: nenhuma tabela, nenhum dado alterado.

create or replace function public.panel_journey_explicit_refs(p_environment public.panel_environment, p_journey_ids uuid[] default null)
returns table(journey_id uuid, ref text, mode text, first_at timestamptz)
language sql stable security definer set search_path = public as $$
  with found as (
    select mj.journey_id,
      upper((regexp_match(m.body_text, '(?i)\mRef:\s*([A-HJ-NP-Z2-9]{5})\M'))[1]) as ref,
      case
        when m.body_text ~* '(·\s*FIND\s*·|year range|mileage range|faixa de anos|faixa de milhas|rango de años)' then 'CARRO'
        when m.body_text ~* '(maximum bid|lance máximo|oferta máxima)' then 'VALOR'
      end as mode,
      coalesce(m.occurred_at_utc, m.created_at) as at
    from public.messages m
    join public.message_journeys mj on mj.message_id = m.id and mj.undone_at is null
    where m.environment = p_environment and m.direction = 'CUSTOMER' and m.undone_at is null
      and m.body_text ~* 'My Car Scout' and m.body_text ~* '\mRef:\s*[A-HJ-NP-Z2-9]{5}\M'
      and (p_journey_ids is null or mj.journey_id = any(p_journey_ids))
  )
  select journey_id, ref, (array_agg(mode order by at) filter (where mode is not null))[1], min(at)
  from found where ref is not null group by journey_id, ref
$$;
revoke all on function public.panel_journey_explicit_refs(public.panel_environment, uuid[]) from public, anon, authenticated;
grant execute on function public.panel_journey_explicit_refs(public.panel_environment, uuid[]) to service_role;
