-- Mesma função de provas da identidade, mais rápida: as Refs com simulação são lidas uma vez (antes, uma varredura de calc_runs por ficha).
-- Mesmo resultado, mesma assinatura; só substitui o corpo da função da migração anterior.
create or replace function public.panel_identity_evidence(p_environment public.panel_environment, p_journey_ids uuid[] default null)
returns table(journey_id uuid, reference_code text, linked_refs text[], explicit jsonb, print_refs text[], template boolean, message_count integer, last_message_at timestamptz, run_refs text[], owners jsonb, claude_refs jsonb)
language sql stable security definer set search_path = public as $$
  with scope as (
    select j.id, upper(j.reference_code) code from public.journeys j
    where j.environment = p_environment and (p_journey_ids is null or j.id = any(p_journey_ids))
  ), msgs as (
    select s.id journey_id, m.id message_id, m.body_text, coalesce(m.occurred_at_utc, m.created_at) at
    from scope s join public.message_journeys mj on mj.journey_id = s.id and mj.undone_at is null
    join public.messages m on m.id = mj.message_id and m.undone_at is null and m.direction = 'CUSTOMER'
  ), written as (
    select journey_id, upper((regexp_match(body_text, '(?i)\mRef:\s*([A-HJ-NP-Z2-9]{5})\M'))[1]) ref, message_id, at,
      case when body_text ~* '(·\s*FIND\s*·|year range|mileage range|faixa de anos|faixa de milhas|rango de años)' then 'CARRO'
           when body_text ~* '(maximum bid|lance máximo|oferta máxima)' then 'VALOR' end mode
    from msgs where body_text ~* 'My Car Scout' and body_text ~* '\mRef:\s*[A-HJ-NP-Z2-9]{5}\M'
  ), tpl as (
    select distinct journey_id from msgs
    where body_text ~* 'my car scout' and body_text ~* '(vehicle search request|calculate my cost|find one for me|maximum bid|year range|mileage range|·\s*FIND\s*·|lance máximo|faixa de anos|rango de años)'
  ), prints as (
    select s.id journey_id, upper(r.extracted_json->>'ref') ref
    from scope s join public.sms_print_reads r on r.environment = p_environment and r.confirmed_journey_id = s.id and r.status = 'CONFIRMED' and r.undone_at is null
    where coalesce(r.extracted_json->>'ref','') ~ '^[A-HJ-NP-Z2-9]{5}$'
  ), linked as (
    select s.id journey_id, upper(jr.ref_code) ref from scope s join public.journey_refs jr on jr.journey_id = s.id and jr.environment = p_environment
  ), candidates as (
    select journey_id, ref from written where ref is not null union select journey_id, ref from prints union select journey_id, ref from linked
    union select id, code from scope where code is not null
    union select cc.journey_id, upper(x->>'ref') from public.panel_conversation_class cc, jsonb_array_elements(cc.claude_refs) x
      where cc.environment = p_environment and cc.journey_id in (select id from scope) and coalesce((x->>'verified')::boolean, false)
  ), runs as (
    select distinct upper(cr.dados->>'ref') ref from public.calc_runs cr where not cr.is_test and coalesce(cr.dados->>'ref','') <> ''
  ), owners as (
    select c.ref, jsonb_agg(distinct o.jid) filter (where o.jid is not null) jids
    from (select distinct ref from candidates) c
    left join lateral (
      select j2.id jid from public.journeys j2 where j2.environment = p_environment and upper(j2.reference_code) = c.ref
      union select jr2.journey_id from public.journey_refs jr2 where jr2.environment = p_environment and upper(jr2.ref_code) = c.ref
    ) o on true group by c.ref
  )
  select s.id, s.code,
    coalesce((select array_agg(distinct l.ref) from linked l where l.journey_id = s.id), '{}'),
    coalesce((select jsonb_agg(jsonb_build_object('ref', w.ref, 'mode', w.mode, 'at', w.at, 'messageId', w.message_id) order by w.at) from written w where w.journey_id = s.id and w.ref is not null), '[]'::jsonb),
    coalesce((select array_agg(distinct p.ref) from prints p where p.journey_id = s.id), '{}'),
    exists(select 1 from tpl where tpl.journey_id = s.id),
    (select count(*)::int from msgs where msgs.journey_id = s.id),
    (select max(at) from msgs where msgs.journey_id = s.id),
    coalesce((select array_agg(distinct c2.ref) from candidates c2 join runs on runs.ref = c2.ref where c2.journey_id = s.id), '{}'),
    coalesce((select jsonb_object_agg(o2.ref, coalesce(o2.jids, '[]'::jsonb)) from owners o2 where o2.ref in (select c3.ref from candidates c3 where c3.journey_id = s.id)), '{}'::jsonb),
    coalesce((select cc2.claude_refs from public.panel_conversation_class cc2 where cc2.environment = p_environment and cc2.journey_id = s.id), '[]'::jsonb)
  from scope s
$$;
revoke all on function public.panel_identity_evidence(public.panel_environment, uuid[]) from public, anon, authenticated;
grant execute on function public.panel_identity_evidence(public.panel_environment, uuid[]) to service_role;
