-- Nenhum contato da calculadora se perde: toda mensagem da calculadora termina em exatamente um destino (livro de destinos).
-- Aditiva: uma função de texto, duas funções redefinidas só para usar a mesma detecção ampla (oferta máxima, modelos antigos),
-- a tabela panel_calc_message_route e três funções (pendentes, aplicar, ficha nova). Nada é apagado.

-- Detecção única do modelo da calculadora (marca + algum marcador de qualquer versão/idioma do modelo).
create or replace function public.panel_calc_template_text(p_text text)
returns boolean language sql immutable as $$
  select coalesce(p_text ~* 'my car scout' and p_text ~* '(vehicle search request|calculate my cost|find one for me|maximum bid|year range|mileage range|·\s*FIND\s*·|lance máximo|faixa de anos|rango de años|oferta máxima|solicitud de búsqueda|solicitação de busca|rango de millas|faixa de milhas|ran a simulation on the my car scout|ran an estimate on the my car scout|simulación en la calculadora|simulação na calculadora|discuss this simulation|discuss this vehicle search|estimate and not a commercial offer)', false)
$$;
grant execute on function public.panel_calc_template_text(text) to service_role;

create or replace function public.panel_journey_calc_templates(p_environment public.panel_environment, p_journey_ids uuid[] default null)
returns table(journey_id uuid) language sql stable security definer set search_path = public as $$
  select distinct mj.journey_id
  from public.message_journeys mj join public.messages m on m.id = mj.message_id and m.undone_at is null
  where mj.environment = p_environment and mj.undone_at is null and m.direction = 'CUSTOMER'
    and public.panel_calc_template_text(m.body_text)
    and (p_journey_ids is null or mj.journey_id = any(p_journey_ids))
$$;

-- Mesma função de provas da identidade, só com a detecção ampla do modelo (tpl).
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
    select distinct journey_id from msgs where public.panel_calc_template_text(body_text)
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

-- Livro de destinos: uma linha por mensagem da calculadora, com o destino, o motivo e a evidência.
--   LIGADA_REF       ligada à ficha da Ref escrita na mensagem
--   LIGADA_TELEFONE  sem Ref legível: ligada à única ficha do telefone, sem contradição de nome/carro
--   NOVA_FICHA       sem Ref legível e telefone sem ficha: ficha nova criada
--   FILA             o sistema não decide sozinho: motivo escrito e evidência (candidatas, Ref, telefone)
create table if not exists public.panel_calc_message_route (
  environment public.panel_environment not null,
  message_id uuid not null references public.messages(id),
  destination text not null check (destination in ('LIGADA_REF','LIGADA_TELEFONE','NOVA_FICHA','FILA')),
  reason text not null check (length(reason) between 2 and 60),
  ref_state text not null check (ref_state in ('REF','REF_ILEGIVEL','SEM_LINHA_REF')),
  -- where the Ref came from: the message text, or the print the SMS was read from
  ref_source text check (ref_source is null or ref_source in ('TEXTO','PRINT')),
  ref text check (ref is null or ref ~ '^[A-HJ-NP-Z2-9]{5}$'),
  journey_id uuid references public.journeys(id),
  evidence jsonb not null default '{}'::jsonb,
  rule_version integer not null,
  manual boolean not null default false,
  decided_by uuid references public.panel_users(id),
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (environment, message_id)
);
create index if not exists panel_calc_message_route_queue_idx on public.panel_calc_message_route(environment, destination, updated_at);
create index if not exists panel_calc_message_route_journey_idx on public.panel_calc_message_route(journey_id);
create index if not exists panel_calc_message_route_decided_by_idx on public.panel_calc_message_route(decided_by);
alter table public.panel_calc_message_route enable row level security;
alter table public.panel_calc_message_route force row level security;
revoke all on public.panel_calc_message_route from public, anon, authenticated;
grant select, insert, update on public.panel_calc_message_route to service_role;

-- Mensagens da calculadora ainda sem destino nesta regra (ou na fila há mais de 10 min, para reavaliar). Decisão manual não volta.
create or replace function public.panel_calc_route_pending(p_environment public.panel_environment, p_rule_version integer, p_limit integer default 50)
returns table(message_id uuid, chat_id uuid, channel text, body_text text, occurred_at timestamptz, contact_id uuid, chat_key text, linked_journeys uuid[], previous text, print_ref text)
language sql stable security definer set search_path = public as $$
  select m.id, m.chat_id, m.channel::text, m.body_text, coalesce(m.occurred_at_utc, m.created_at), c.contact_id, c.canonical_key,
    coalesce((select array_agg(mj.journey_id) from public.message_journeys mj where mj.environment = p_environment and mj.message_id = m.id and mj.undone_at is null), '{}'),
    r.destination,
    -- An SMS that came in by print: the Ref the reader saw on the screenshot (another source when the text lost the line).
    (select upper(pr.extracted_json->>'ref') from public.sms_print_reads pr where pr.environment = p_environment and pr.message_id = m.id and pr.status = 'CONFIRMED'
       and coalesce(pr.extracted_json->>'ref', '') ~* '^[A-HJ-NP-Z2-9]{5}$' order by pr.updated_at desc limit 1)
  from public.messages m
  left join public.chats c on c.id = m.chat_id
  left join public.panel_calc_message_route r on r.environment = p_environment and r.message_id = m.id
  where m.environment = p_environment and m.undone_at is null and m.direction = 'CUSTOMER'
    and public.panel_calc_template_text(m.body_text)
    and (r.message_id is null or (not r.manual and (r.rule_version < p_rule_version or (r.destination = 'FILA' and r.updated_at < now() - interval '10 minutes'))))
  order by (r.message_id is not null), coalesce(m.occurred_at_utc, m.created_at)
  limit greatest(1, least(coalesce(p_limit, 50), 200))
$$;
revoke all on function public.panel_calc_route_pending(public.panel_environment, integer, integer) from public, anon, authenticated;
grant execute on function public.panel_calc_route_pending(public.panel_environment, integer, integer) to service_role;

-- Aplica um destino decidido pela regra (ou pela operadora, p_manual). Sob trava por mensagem: repetir não duplica.
--   p_link   liga a mensagem a p_journey_id (só se nunca houve vínculo com essa ficha; um vínculo desfeito à mão não volta)
--   p_create cria a ficha nova (só se a mensagem não tem ficha e o contato não tem nenhuma ficha; senão devolve skipped)
create or replace function public.panel_calc_route_apply(
  p_environment public.panel_environment, p_message_id uuid, p_destination text, p_reason text, p_ref_state text, p_ref text,
  p_journey_id uuid, p_evidence jsonb, p_rule_version integer, p_link boolean default false, p_create boolean default false,
  p_manual boolean default false, p_actor uuid default null, p_unlink_auto boolean default false, p_ref_source text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
#variable_conflict use_variable
declare v_contact uuid; v_channel text; v_journey uuid := p_journey_id; v_previous public.panel_calc_message_route; v_ref text; v_linked boolean := false; v_created boolean := false; v_unlinked uuid[] := '{}';
begin
  perform pg_advisory_xact_lock(hashtext('calc-route:' || p_environment::text || ':' || p_message_id::text));
  select c.contact_id, m.channel::text into v_contact, v_channel from public.messages m left join public.chats c on c.id = m.chat_id
    where m.environment = p_environment and m.id = p_message_id and m.undone_at is null and m.direction = 'CUSTOMER';
  if not found then raise exception 'CALC_ROUTE_MESSAGE_NOT_FOUND'; end if;
  select * into v_previous from public.panel_calc_message_route r where r.environment = p_environment and r.message_id = p_message_id;
  if found and v_previous.manual and not p_manual then return jsonb_build_object('skipped', 'MANUAL'); end if;
  v_ref := case when coalesce(p_ref, '') ~ '^[A-HJ-NP-Z2-9]{5}$' then p_ref end;
  if p_create then
    if v_contact is null then return jsonb_build_object('skipped', 'NO_CONTACT'); end if;
    if exists (select 1 from public.message_journeys mj where mj.environment = p_environment and mj.message_id = p_message_id and mj.undone_at is null)
      or (not p_manual and exists (select 1 from public.journeys j where j.environment = p_environment and j.contact_id = v_contact)) then
      return jsonb_build_object('skipped', 'ALREADY_HAS_JOURNEY');
    end if;
    insert into public.journeys(environment, contact_id, reference_code, source, stage, status, criteria_json, created_at, updated_at)
      values (p_environment, v_contact,
        case when v_ref is not null and not exists (select 1 from public.journeys j where j.environment = p_environment and j.reference_code = v_ref)
          and not exists (select 1 from public.journey_refs r where r.environment = p_environment and r.ref_code = v_ref) then v_ref end,
        (case when v_channel = 'SMS' then 'SMS_DIRECT' else 'WHATSAPP_DIRECT' end)::public.panel_journey_source, 'NOVO', 'ATIVO', '{}'::jsonb, now(), now())
      returning id into v_journey;
    insert into public.journey_checklist(environment, journey_id, point_number, point_label, status, created_at, updated_at)
      select p_environment, v_journey, n, (array['Carro e critérios confirmados','Teto confirmado','Pagamento confirmado','Prazo confirmado','Aceita busca fora da Flórida','Entende inspeção limitada e sem devolução'])[n],
        'OPEN'::public.panel_checklist_status, now(), now() from generate_series(1, 6) n;
    v_created := true;
  end if;
  if (p_link or v_created) and v_journey is not null then
    if not exists (select 1 from public.journeys j where j.environment = p_environment and j.id = v_journey) then raise exception 'CALC_ROUTE_JOURNEY_NOT_FOUND'; end if;
    if not exists (select 1 from public.message_journeys mj where mj.environment = p_environment and mj.message_id = p_message_id and mj.journey_id = v_journey) then
      insert into public.message_journeys(environment, message_id, journey_id, association_source, associated_at, associated_by)
        values (p_environment, p_message_id, v_journey, case when p_manual then 'CALC_ROUTE_MANUAL' else 'CALC_ROUTE' end, now(), p_actor);
      v_linked := true;
    end if;
  end if;
  -- To the queue: the link the ingestion chose by itself (latest ficha of the phone) is undone, so the message is in one place only.
  -- Links made by a person or by an import (history, print, entry) are never touched.
  if p_unlink_auto and p_destination = 'FILA' then
    with gone as (
      update public.message_journeys mj set undone_at = now(), undone_by = p_actor
      where mj.environment = p_environment and mj.message_id = p_message_id and mj.undone_at is null and mj.association_source in ('WHATSAPP_WEBHOOK', 'SMS_SHORTCUT', 'CALC_ROUTE')
      returning mj.journey_id)
    select coalesce(array_agg(journey_id), '{}') into v_unlinked from gone;
  end if;
  insert into public.panel_calc_message_route(environment, message_id, destination, reason, ref_state, ref, ref_source, journey_id, evidence, rule_version, manual, decided_by, decided_at, updated_at)
    values (p_environment, p_message_id, p_destination, p_reason, p_ref_state, v_ref, case when v_ref is not null and p_ref_source in ('TEXTO','PRINT') then p_ref_source end, v_journey, coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('linkedNow', v_linked, 'createdJourney', v_created, 'unlinkedAuto', to_jsonb(v_unlinked)), p_rule_version, p_manual, p_actor, now(), now())
    on conflict (environment, message_id) do update set destination = excluded.destination, reason = excluded.reason, ref_state = excluded.ref_state, ref = excluded.ref, ref_source = excluded.ref_source,
      journey_id = excluded.journey_id, evidence = excluded.evidence, rule_version = excluded.rule_version, manual = excluded.manual, decided_by = excluded.decided_by,
      decided_at = case when panel_calc_message_route.destination = excluded.destination and panel_calc_message_route.journey_id is not distinct from excluded.journey_id then panel_calc_message_route.decided_at else now() end,
      updated_at = now();
  return jsonb_build_object('journeyId', v_journey, 'linked', v_linked, 'createdJourney', v_created, 'unlinked', to_jsonb(v_unlinked), 'destination', p_destination);
end;
$$;
revoke all on function public.panel_calc_route_apply(public.panel_environment, uuid, text, text, text, text, uuid, jsonb, integer, boolean, boolean, boolean, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.panel_calc_route_apply(public.panel_environment, uuid, text, text, text, text, uuid, jsonb, integer, boolean, boolean, boolean, uuid, boolean, text) to service_role;
