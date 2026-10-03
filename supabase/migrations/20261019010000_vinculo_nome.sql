-- Vínculo por telefone com nome diferente: nunca junta sozinho, vira "Confirmar vínculo".
-- 1. panel_name_link_decisions: a decisão da operadora sobre uma simulação ligada a uma ficha de outro chat
--    (CONFIRMED = é a mesma pessoa; SEPARATED = não é, a simulação foi para uma ficha própria).
-- 2. panel_calc_name: o nome que a mensagem da calculadora traz (Name:/Nome:/Nombre:).
-- 3. panel_journey_names: os nomes conhecidos de cada ficha (contato e mensagens da calculadora), os chats dela
--    e a última mensagem real com o canal, para a regra e para mostrar os dois lados.
-- 4. panel_name_link_candidates: simulações com nome ligadas a uma ficha que tem conversa em outro chat, ainda
--    sem decisão (a comparação de nomes é feita no servidor, panel-phone-link). Só leitura.
-- 5. panel_name_link_decide: grava a decisão; "não é a mesma pessoa" tira só esta simulação da ficha
--    (e a Ref dela, quando a ficha a recebeu por esta simulação) e cria a ficha própria. Nada é desfeito sem a decisão.

create table if not exists public.panel_name_link_decisions (
  environment public.panel_environment not null,
  message_id uuid not null references public.messages(id),
  journey_id uuid not null references public.journeys(id),
  decision text not null check (decision in ('CONFIRMED','SEPARATED')),
  new_journey_id uuid references public.journeys(id),
  decided_by uuid references public.panel_users(id),
  decided_at timestamptz not null default now(),
  primary key (environment, message_id, journey_id)
);
create index if not exists panel_name_link_decisions_journey_idx on public.panel_name_link_decisions(journey_id);
create index if not exists panel_name_link_decisions_new_journey_idx on public.panel_name_link_decisions(new_journey_id);
create index if not exists panel_name_link_decisions_decided_by_idx on public.panel_name_link_decisions(decided_by);
alter table public.panel_name_link_decisions enable row level security;
alter table public.panel_name_link_decisions force row level security;
revoke all on public.panel_name_link_decisions from public, anon, authenticated;
grant select, insert, update on public.panel_name_link_decisions to service_role;

create or replace function public.panel_calc_name(p_text text)
returns text language sql immutable set search_path = '' as $$
  select nullif(trim(substring(coalesce(p_text, '') from '(?in)^\s*(?:name|nome|nombre):[ \t]*([^\n]+)')), '')
$$;
revoke all on function public.panel_calc_name(text) from public, anon, authenticated;
grant execute on function public.panel_calc_name(text) to service_role;

create or replace function public.panel_journey_names(p_environment public.panel_environment, p_journey_ids uuid[])
returns table(journey_id uuid, contact_name text, calc_names text[], chat_ids uuid[], last_channel text, last_at timestamptz)
language sql stable security definer set search_path = public as $$
  select j.id, c.display_name,
    coalesce((select array_agg(distinct public.panel_calc_name(m.body_text)) filter (where public.panel_calc_name(m.body_text) is not null)
      from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null and m.direction = 'CUSTOMER'
      where mj.environment = p_environment and mj.journey_id = j.id and mj.undone_at is null), '{}'),
    coalesce((select array_agg(distinct m.chat_id) filter (where m.chat_id is not null)
      from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null
      where mj.environment = p_environment and mj.journey_id = j.id and mj.undone_at is null), '{}'),
    last.channel, last.at
  from public.journeys j
  left join public.contacts c on c.id = j.contact_id
  left join lateral (
    select m.channel::text channel, coalesce(m.occurred_at_utc, m.created_at) at
      from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null and not coalesce(m.is_automatic, false)
     where mj.environment = p_environment and mj.journey_id = j.id and mj.undone_at is null
     order by coalesce(m.occurred_at_utc, m.created_at) desc limit 1) last on true
  where j.environment = p_environment and j.id = any(coalesce(p_journey_ids, '{}'))
$$;
revoke all on function public.panel_journey_names(public.panel_environment, uuid[]) from public, anon, authenticated;
grant execute on function public.panel_journey_names(public.panel_environment, uuid[]) to service_role;

create or replace function public.panel_name_link_candidates(p_environment public.panel_environment)
returns table(message_id uuid, journey_id uuid, reference_code text, contact_name text, phone text, message_name text, message_channel text, message_at timestamptz,
  other_names text[], other_channel text, other_last_at timestamptz)
language sql stable security definer set search_path = public as $$
  with calc as (
    select m.id, m.chat_id, m.channel::text channel, coalesce(m.occurred_at_utc, m.created_at) at, mj.journey_id, public.panel_calc_name(m.body_text) nm
      from public.messages m
      join public.message_journeys mj on mj.environment = p_environment and mj.message_id = m.id and mj.undone_at is null
     where m.environment = p_environment and m.undone_at is null and m.direction = 'CUSTOMER'
       and public.panel_calc_template_text(m.body_text) and public.panel_calc_name(m.body_text) is not null
       and not exists (select 1 from public.panel_name_link_decisions d where d.environment = p_environment and d.message_id = m.id and d.journey_id = mj.journey_id)
  )
  select calc.id, calc.journey_id, j.reference_code, c.display_name,
    (select p.phone_e164 from public.contact_phones p where p.environment = p_environment and p.contact_id = j.contact_id and p.is_current and p.retired_at is null order by p.is_primary desc limit 1),
    calc.nm, calc.channel, calc.at,
    coalesce((select array_agg(distinct public.panel_calc_name(m2.body_text)) filter (where public.panel_calc_name(m2.body_text) is not null)
      from public.message_journeys mj2 join public.messages m2 on m2.id = mj2.message_id and m2.undone_at is null and m2.direction = 'CUSTOMER' and m2.chat_id is distinct from calc.chat_id
      where mj2.environment = p_environment and mj2.journey_id = calc.journey_id and mj2.undone_at is null), '{}'),
    other.channel, other.at
  from calc
  join public.journeys j on j.id = calc.journey_id
  left join public.contacts c on c.id = j.contact_id
  join lateral (
    select m2.channel::text channel, coalesce(m2.occurred_at_utc, m2.created_at) at
      from public.message_journeys mj2 join public.messages m2 on m2.id = mj2.message_id and m2.undone_at is null and not coalesce(m2.is_automatic, false)
     where mj2.environment = p_environment and mj2.journey_id = calc.journey_id and mj2.undone_at is null and m2.chat_id is distinct from calc.chat_id
     order by coalesce(m2.occurred_at_utc, m2.created_at) desc limit 1) other on true
$$;
revoke all on function public.panel_name_link_candidates(public.panel_environment) from public, anon, authenticated;
grant execute on function public.panel_name_link_candidates(public.panel_environment) to service_role;

create or replace function public.panel_name_link_decide(p_environment public.panel_environment, p_message_id uuid, p_journey_id uuid, p_decision text, p_actor uuid, p_rule_version integer)
returns jsonb language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare v_linked boolean; v_ref text; v_body text; v_code text; v_route jsonb; v_new uuid;
begin
  if p_decision not in ('CONFIRMED','SEPARATED') then raise exception 'NAME_LINK_DECISION_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtext('calc-route:' || p_environment::text || ':' || p_message_id::text));
  select m.body_text into v_body from public.messages m where m.environment = p_environment and m.id = p_message_id and m.undone_at is null and m.direction = 'CUSTOMER';
  if not found then raise exception 'NAME_LINK_MESSAGE_NOT_FOUND'; end if;
  if not exists (select 1 from public.journeys j where j.environment = p_environment and j.id = p_journey_id) then raise exception 'NAME_LINK_JOURNEY_NOT_FOUND'; end if;
  v_linked := exists (select 1 from public.message_journeys mj where mj.environment = p_environment and mj.message_id = p_message_id and mj.journey_id = p_journey_id and mj.undone_at is null);
  if p_decision = 'CONFIRMED' then
    -- Still in the queue (never joined): the confirmation joins it now, as a decision of the operator.
    if not v_linked then
      -- The automatic link the queue undid comes back (one row per message and ficha), now as the operator's decision.
      update public.message_journeys mj set undone_at = null, undone_by = null, association_source = 'CALC_ROUTE_MANUAL', associated_at = now(), associated_by = p_actor
        where mj.environment = p_environment and mj.message_id = p_message_id and mj.journey_id = p_journey_id;
      if not found then
        insert into public.message_journeys(environment, message_id, journey_id, association_source, associated_at, associated_by)
          values (p_environment, p_message_id, p_journey_id, 'CALC_ROUTE_MANUAL', now(), p_actor);
      end if;
      update public.panel_calc_message_route r set destination = 'LIGADA_TELEFONE', reason = 'DECISAO_NOME', journey_id = p_journey_id, manual = true, decided_by = p_actor, decided_at = now(), updated_at = now()
        where r.environment = p_environment and r.message_id = p_message_id;
    end if;
  else
    v_ref := upper(substring(coalesce(v_body, '') from '(?in)^\s*ref:[ \t]*([A-HJ-NP-Z2-9]{5})\M'));
    if v_ref is null then
      select upper(pr.extracted_json->>'ref') into v_ref from public.sms_print_reads pr
        where pr.environment = p_environment and pr.message_id = p_message_id and pr.status = 'CONFIRMED' and coalesce(pr.extracted_json->>'ref', '') ~* '^[A-HJ-NP-Z2-9]{5}$'
        order by pr.updated_at desc limit 1;
    end if;
    -- Only this simulation leaves the ficha; the rest of the conversation stays where it is.
    update public.message_journeys mj set undone_at = now(), undone_by = p_actor
      where mj.environment = p_environment and mj.message_id = p_message_id and mj.journey_id = p_journey_id and mj.undone_at is null;
    -- The Ref goes with the simulation when the ficha got it as an extra Ref (never the ficha's own code).
    select j.reference_code into v_code from public.journeys j where j.environment = p_environment and j.id = p_journey_id;
    if v_linked and v_ref is not null and v_ref is distinct from v_code then
      delete from public.journey_refs r where r.environment = p_environment and r.journey_id = p_journey_id and r.ref_code = v_ref;
    end if;
    v_route := public.panel_calc_route_apply(p_environment, p_message_id, 'NOVA_FICHA', 'DECISAO_NOME', case when v_ref is not null then 'REF' else 'SEM_LINHA_REF' end, v_ref,
      null, jsonb_build_object('decidedIn', 'confirmar-vinculo', 'separatedFrom', p_journey_id), p_rule_version, false, true, true, p_actor, false, case when v_ref is not null then 'TEXTO' end);
    -- Never a simulation without a ficha: when the new ficha cannot be made, nothing of this decision stays.
    if v_route ? 'skipped' then raise exception 'NAME_LINK_SEPARATE_%', v_route->>'skipped'; end if;
    v_new := nullif(v_route->>'journeyId', '')::uuid;
  end if;
  insert into public.panel_name_link_decisions(environment, message_id, journey_id, decision, new_journey_id, decided_by, decided_at)
    values (p_environment, p_message_id, p_journey_id, p_decision, v_new, p_actor, now())
    on conflict (environment, message_id, journey_id) do update set decision = excluded.decision, new_journey_id = excluded.new_journey_id, decided_by = excluded.decided_by, decided_at = now();
  return jsonb_build_object('decision', p_decision, 'journeyId', p_journey_id, 'newJourneyId', v_new, 'linked', p_decision = 'CONFIRMED');
end;
$$;
revoke all on function public.panel_name_link_decide(public.panel_environment, uuid, uuid, text, uuid, integer) from public, anon, authenticated;
grant execute on function public.panel_name_link_decide(public.panel_environment, uuid, uuid, text, uuid, integer) to service_role;
