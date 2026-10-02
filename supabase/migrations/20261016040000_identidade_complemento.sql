-- Complemento da identidade e do assunto (revisão independente + três estados de Ref):
--  * assunto: falha do Claude não repete a cada ciclo (recuo e teto de tentativas por conteúdo); resumos por pedido;
--  * provas: a Ref escrita guarda o texto como foi digitado (só liga com maiúsculas ou simulação conhecida);
--  * ligação de Ref com trava por Ref (duas fichas em paralelo nunca levam a mesma Ref);
--  * funções de leitura: fichas com mensagem do modelo da calculadora e simulações próximas de uma mensagem.
-- Aditiva; só substitui funções da própria identidade e acrescenta colunas.

alter table public.panel_conversation_class
  add column if not exists fail_count integer not null default 0,
  add column if not exists fail_hash text,
  add column if not exists next_try_at timestamptz,
  add column if not exists request_summaries jsonb not null default '[]'::jsonb;

create or replace function public.panel_subject_candidates(p_environment public.panel_environment, p_rule_version integer, p_limit integer)
returns table(journey_id uuid, message_count integer, last_customer_at timestamptz, content_hash text)
language sql stable security definer set search_path = public as $$
  with msgs as (
    select mj.journey_id, m.id, m.direction, coalesce(m.occurred_at_utc, m.created_at) at
    from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null
    where mj.environment = p_environment and mj.undone_at is null
  ), agg as (
    select journey_id, count(*)::int n, max(at) filter (where direction = 'CUSTOMER') last_customer,
           md5(string_agg(id::text, ',' order by at, id)) h
    from msgs group by journey_id having count(*) filter (where direction = 'CUSTOMER') > 0
  )
  select a.journey_id, a.n, a.last_customer, a.h
  from agg a left join public.panel_conversation_class c on c.environment = p_environment and c.journey_id = a.journey_id
  where (c.journey_id is null or c.input_hash <> a.h or c.rule_version <> p_rule_version)
    and c.manual_subject is null and (c.claimed_until is null or c.claimed_until < now())
    and (c.next_try_at is null or c.next_try_at <= now())
    and (c.fail_count < 5 or c.fail_hash is distinct from a.h)
  order by a.last_customer desc nulls last, a.journey_id
  limit greatest(p_limit, 0)
$$;

create or replace function public.panel_subject_fail(p_environment public.panel_environment, p_journey_id uuid, p_token uuid, p_hash text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.panel_conversation_class set
    fail_count = case when fail_hash = p_hash then fail_count + 1 else 1 end,
    next_try_at = now() + (interval '10 minutes' * power(2, least(case when fail_hash = p_hash then fail_count else 0 end, 6))),
    fail_hash = p_hash, claim_token = null, claimed_until = null
  where environment = p_environment and journey_id = p_journey_id and claim_token = p_token;
  return found;
end $$;
revoke all on function public.panel_subject_fail(public.panel_environment, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.panel_subject_fail(public.panel_environment, uuid, uuid, text) to service_role;

-- (a versão de nove argumentos fica como está; esta é a que o cron usa, com os resumos por pedido)
create or replace function public.panel_subject_finish_v2(p_environment public.panel_environment, p_journey_id uuid, p_token uuid, p_hash text, p_rule_version integer,
  p_subject text, p_confidence numeric, p_reason text, p_claude_refs jsonb, p_request_summaries jsonb default '[]'::jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.panel_conversation_class set subject = p_subject, confidence = p_confidence, reason = left(p_reason, 500), claude_refs = coalesce(p_claude_refs, '[]'::jsonb),
    request_summaries = coalesce(p_request_summaries, '[]'::jsonb), input_hash = p_hash, rule_version = p_rule_version, classified_at = now(),
    fail_count = 0, fail_hash = null, next_try_at = null, claim_token = null, claimed_until = null
  where environment = p_environment and journey_id = p_journey_id and claim_token = p_token;
  return found;
end $$;
revoke all on function public.panel_subject_finish_v2(public.panel_environment, uuid, uuid, text, integer, text, numeric, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.panel_subject_finish_v2(public.panel_environment, uuid, uuid, text, integer, text, numeric, text, jsonb, jsonb) to service_role;

-- Fichas com mensagem do cliente no modelo da calculadora (origem Calculadora mesmo sem Ref recuperável). Só leitura.
create or replace function public.panel_journey_calc_templates(p_environment public.panel_environment, p_journey_ids uuid[] default null)
returns table(journey_id uuid) language sql stable security definer set search_path = public as $$
  select distinct mj.journey_id
  from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null
  where mj.environment = p_environment and mj.undone_at is null and m.direction = 'CUSTOMER'
    and m.body_text ~* 'my car scout'
    and m.body_text ~* '(vehicle search request|calculate my cost|find one for me|maximum bid|year range|mileage range|·\s*FIND\s*·|lance máximo|faixa de anos|rango de años)'
    and (p_journey_ids is null or mj.journey_id = any(p_journey_ids))
$$;
revoke all on function public.panel_journey_calc_templates(public.panel_environment, uuid[]) from public, anon, authenticated;
grant execute on function public.panel_journey_calc_templates(public.panel_environment, uuid[]) to service_role;

-- Simulações da calculadora (por Ref) numa janela de tempo em volta de uma mensagem. calc_runs não guarda telefone: a janela e
-- os critérios são as únicas pontes entre uma mensagem sem Ref e uma simulação. Só leitura.
create or replace function public.panel_calc_run_candidates(p_at timestamptz, p_before_minutes integer, p_after_minutes integer default 2)
returns table(ref text, first_at timestamptz, last_at timestamptz, events text[], dados jsonb)
language sql stable security definer set search_path = public as $$
  select upper(cr.dados->>'ref'), min(cr.created_at), max(cr.created_at), array_agg(distinct cr.dados->>'evento'),
         (array_agg(cr.dados order by cr.created_at desc))[1]
  from public.calc_runs cr
  where not cr.is_test and coalesce(cr.dados->>'ref', '') <> ''
    and cr.created_at between p_at - make_interval(mins => greatest(p_before_minutes, 0)) and p_at + make_interval(mins => greatest(p_after_minutes, 0))
  group by 1
$$;
revoke all on function public.panel_calc_run_candidates(timestamptz, integer, integer) from public, anon, authenticated;
grant execute on function public.panel_calc_run_candidates(timestamptz, integer, integer) to service_role;

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
    select journey_id, upper((regexp_match(body_text, '(?i)\mRef:\s*([A-HJ-NP-Z2-9]{5})\M'))[1]) ref, (regexp_match(body_text, '(?i)\mRef:\s*([A-HJ-NP-Z2-9]{5})\M'))[1] raw, message_id, at,
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
    coalesce((select jsonb_agg(jsonb_build_object('ref', w.ref, 'raw', w.raw, 'mode', w.mode, 'at', w.at, 'messageId', w.message_id) order by w.at) from written w where w.journey_id = s.id and w.ref is not null), '[]'::jsonb),
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
    -- Two fichas evaluated at the same time never both take the same Ref: one at a time per Ref.
    perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':ref:' || r, 0));
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
