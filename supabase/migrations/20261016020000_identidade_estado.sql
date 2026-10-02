-- Identidade por Ref, persistida e retomável. Cada ficha guarda o que ficou comprovado sobre a origem
-- Calculadora e a Ref: o cron reavalia só quando as provas mudam (input_hash) e nunca sobrescreve uma
-- decisão manual. Aditiva: tabela nova, duas funções novas, nada existente muda.

create table if not exists public.panel_identity_state (
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id),
  status text not null check (status in ('REF_COMPROVADA','CALCULADORA_REF_A_RECUPERAR','SEM_ORIGEM_CALCULADORA','CONFLITO')),
  calc_origin boolean not null default false,
  refs text[] not null default '{}',
  conflict jsonb,
  evidence jsonb not null default '{}'::jsonb,
  rule_version integer not null,
  input_hash text not null,
  decided_by text not null default 'AUTO' check (decided_by in ('AUTO','MANUAL')),
  updated_at timestamptz not null default now(),
  primary key (environment, journey_id)
);
alter table public.panel_identity_state enable row level security;
revoke all on public.panel_identity_state from public, anon, authenticated;
grant select, insert, update on public.panel_identity_state to service_role;

-- Provas de cada ficha, só leitura: Refs escritas pelo cliente na mensagem da calculadora, Refs lidas em
-- prints confirmados, Refs já ligadas, se há mensagem do modelo da calculadora, e quem mais possui cada Ref.
create or replace function public.panel_identity_evidence(p_environment public.panel_environment, p_journey_ids uuid[] default null)
returns table(journey_id uuid, reference_code text, linked_refs text[], explicit jsonb, print_refs text[], template boolean, message_count integer, last_message_at timestamptz, run_refs text[], owners jsonb)
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
    coalesce((select array_agg(distinct upper(cr.dados->>'ref')) from public.calc_runs cr where not cr.is_test and upper(cr.dados->>'ref') in (select c2.ref from candidates c2 where c2.journey_id = s.id)), '{}'),
    coalesce((select jsonb_object_agg(o2.ref, coalesce(o2.jids, '[]'::jsonb)) from owners o2 where o2.ref in (select c3.ref from candidates c3 where c3.journey_id = s.id)), '{}'::jsonb)
  from scope s
$$;
revoke all on function public.panel_identity_evidence(public.panel_environment, uuid[]) from public, anon, authenticated;
grant execute on function public.panel_identity_evidence(public.panel_environment, uuid[]) to service_role;

-- Aplica uma decisão de forma atômica e repetível: liga as Refs comprovadas (nunca uma Ref que outra ficha já
-- possui, nunca duas vezes), grava o estado e o registro da atividade. Decisão manual nunca é sobrescrita.
create or replace function public.panel_identity_apply(
  p_environment public.panel_environment, p_journey_id uuid, p_rule_version integer, p_hash text, p_status text,
  p_calc_origin boolean, p_refs text[], p_conflict jsonb, p_evidence jsonb, p_link_refs text[], p_message_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare existing public.panel_identity_state%rowtype; r text; linked_now text[] := '{}'; blocked text[] := '{}'; mid uuid; idx integer := 0;
begin
  perform 1 from public.journeys where id = p_journey_id and environment = p_environment for update;
  if not found then raise exception 'IDENTITY_JOURNEY_NOT_FOUND'; end if;
  select * into existing from public.panel_identity_state where environment = p_environment and journey_id = p_journey_id;
  if found and existing.decided_by = 'MANUAL' then return jsonb_build_object('skipped', 'MANUAL'); end if;
  foreach r in array coalesce(p_link_refs, '{}') loop
    idx := idx + 1;
    if r !~ '^[A-HJ-NP-Z2-9]{5}$' then continue; end if;
    if exists(select 1 from public.journeys j2 where j2.environment = p_environment and j2.id <> p_journey_id and upper(j2.reference_code) = r)
       or exists(select 1 from public.journey_refs jr2 where jr2.environment = p_environment and jr2.journey_id <> p_journey_id and upper(jr2.ref_code) = r) then
      blocked := blocked || r; continue;
    end if;
    if exists(select 1 from public.journey_refs jr where jr.environment = p_environment and jr.journey_id = p_journey_id and upper(jr.ref_code) = r)
       or exists(select 1 from public.journeys j3 where j3.id = p_journey_id and upper(j3.reference_code) = r) then continue; end if;
    mid := case when p_message_ids is not null and array_length(p_message_ids, 1) >= idx then p_message_ids[idx] end;
    insert into public.journey_refs(environment, journey_id, ref_code, source_message_id, created_at) values (p_environment, p_journey_id, r, mid, now());
    linked_now := linked_now || r;
  end loop;
  insert into public.panel_identity_state(environment, journey_id, status, calc_origin, refs, conflict, evidence, rule_version, input_hash, decided_by, updated_at)
  values (p_environment, p_journey_id, case when cardinality(blocked) > 0 and p_status = 'REF_COMPROVADA' and cardinality(p_refs) = 0 then 'CONFLITO' else p_status end,
          p_calc_origin, coalesce(p_refs, '{}'), case when cardinality(blocked) > 0 then jsonb_build_object('blocked', to_jsonb(blocked)) || coalesce(p_conflict, '{}'::jsonb) else p_conflict end,
          coalesce(p_evidence, '{}'::jsonb), p_rule_version, p_hash, 'AUTO', now())
  on conflict (environment, journey_id) do update set status = excluded.status, calc_origin = excluded.calc_origin, refs = excluded.refs, conflict = excluded.conflict,
    evidence = excluded.evidence, rule_version = excluded.rule_version, input_hash = excluded.input_hash, updated_at = now();
  if cardinality(linked_now) > 0 then
    insert into public.activity_log(environment, journey_id, activity_type, summary, metadata, occurred_at)
    values (p_environment, p_journey_id, 'IDENTITY_REF_LINKED', 'Ref comprovada ligada automaticamente', jsonb_build_object('refs', to_jsonb(linked_now), 'evidence', coalesce(p_evidence, '{}'::jsonb)), now());
  end if;
  return jsonb_build_object('linked', to_jsonb(linked_now), 'blocked', to_jsonb(blocked));
end $$;
revoke all on function public.panel_identity_apply(public.panel_environment, uuid, integer, text, text, boolean, text[], jsonb, jsonb, text[], uuid[]) from public, anon, authenticated;
grant execute on function public.panel_identity_apply(public.panel_environment, uuid, integer, text, text, boolean, text[], jsonb, jsonb, text[], uuid[]) to service_role;
