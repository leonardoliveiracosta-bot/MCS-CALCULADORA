-- Seleção operacional das opções Manheim para o cliente. Aditiva: nenhuma tabela existente muda e
-- nenhum match, carro ou V1/V2 existente é reescrito. Funciona sobre o lote já importado.
--
--  * Match interno não é opção: um carro só vai para V1/V2 depois de selecionado pelo operador.
--  * No máximo 10 selecionados por demanda (ficha ou Ref + modo), garantido no servidor sob trava.
--  * Grupos: LANE (Lane e Run verificáveis, mesmo com Buy Now Price), OFFLANE (Lane ou Run não
--    verificável e indicação de Buy Now/Make Offer no CSV) e INCOMPLETE (o resto). CR não muda o grupo,
--    só a ordem. Fora de LANE só entra com inclusão manual e motivo.
--  * CR só ordena candidatos já compatíveis: até 5 com CR no mínimo recomendado pelo MMR, depois até
--    5 abaixo, depois o resto. Empate: leilão mais cedo, Lane, Run, VIN, id.
--  * Preço para o cliente: MMR + acréscimo padrão da faixa (ou o percentual do operador). O cliente
--    vê só o valor final; o MMR e o percentual ficam internos.
--  * Toda mudança fica no audit_log com o operador, o estado anterior e o novo.

create table if not exists public.manheim_option_selections (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  match_id uuid not null references public.manheim_matches(id),
  upload_id uuid not null references public.manheim_uploads(id),
  demand_key text not null check (demand_key ~ '^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):(VALOR|CARRO)$'),
  status text not null default 'AVAILABLE' check (status in ('AVAILABLE', 'SELECTED', 'EXCLUDED')),
  manual boolean not null default false,
  manual_reason text check (manual_reason is null or length(manual_reason) between 5 and 300),
  offer_group text not null check (offer_group in ('LANE', 'OFFLANE', 'INCOMPLETE')),
  mmr_cents integer not null check (mmr_cents > 0),
  default_pct numeric(5,2) not null check (default_pct between 0 and 50),
  manual_pct numeric(5,2) check (manual_pct is null or manual_pct between 0 and 50),
  final_cents integer not null check (final_cents > 0),
  note text check (note is null or length(note) <= 500),
  updated_by uuid references public.panel_users(id),
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (environment, match_id),
  check (status <> 'SELECTED' or offer_group = 'LANE' or (manual and manual_reason is not null))
);
create index if not exists manheim_option_selections_demand_idx
  on public.manheim_option_selections(environment, upload_id, demand_key, status);
create index if not exists manheim_option_selections_upload_idx on public.manheim_option_selections(upload_id);
create index if not exists manheim_option_selections_updated_by_idx on public.manheim_option_selections(updated_by);
alter table public.manheim_option_selections enable row level security;
alter table public.manheim_option_selections force row level security;
revoke all on table public.manheim_option_selections from public, anon, authenticated;
grant select, insert, update on table public.manheim_option_selections to service_role;

-- ---------------------------------------------------------------- regras (iguais a manheim-offer.js)
create or replace function public.panel_manheim_offer_cr(p_parsed jsonb)
returns numeric language sql immutable set search_path = '' as $$
  select case when coalesce(p_parsed ->> 'conditionGrade', '') ~ '^\s*\d(\.\d{1,2})?\s*$'
               and trim(p_parsed ->> 'conditionGrade')::numeric between 0 and 5
              then trim(p_parsed ->> 'conditionGrade')::numeric end;
$$;

create or replace function public.panel_manheim_offer_cr_min(p_mmr_cents bigint)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_mmr_cents is null or p_mmr_cents <= 0 then null
              when p_mmr_cents <= 2000000 then 2.0 when p_mmr_cents <= 3000000 then 2.5
              when p_mmr_cents <= 5000000 then 3.0 when p_mmr_cents <= 7000000 then 3.5 else 4.0 end;
$$;

create or replace function public.panel_manheim_offer_default_pct(p_mmr_cents bigint)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_mmr_cents is null or p_mmr_cents <= 0 then null
              when p_mmr_cents <= 500000 then 12.5 when p_mmr_cents <= 1000000 then 10
              when p_mmr_cents <= 1500000 then 8 when p_mmr_cents <= 2000000 then 6
              when p_mmr_cents <= 3000000 then 5 when p_mmr_cents <= 4000000 then 3.5
              when p_mmr_cents <= 6000000 then 2.5 when p_mmr_cents <= 10000000 then 2 else 1.5 end;
$$;

create or replace function public.panel_manheim_offer_group(p_parsed jsonb)
returns text language sql immutable set search_path = '' as $$
  select case
    -- Lane e Run verificáveis: passa em Lane/Run, mesmo com Buy Now Price maior que zero.
    when coalesce(trim(p_parsed ->> 'lane'), '') <> '' and coalesce(trim(p_parsed ->> 'run'), '') <> '' then 'LANE'
    -- Sem Lane/Run: Buy Now / Make Offer só com os dados de venda lidos e indicação no CSV.
    when ((p_parsed ->> 'lane') is not null or (p_parsed ->> 'run') is not null)
      and ((regexp_replace(coalesce(p_parsed ->> 'buyNowPrice', ''), '[$,\s]', '', 'g') ~ '^\d+(\.\d+)?$'
            and regexp_replace(coalesce(p_parsed ->> 'buyNowPrice', ''), '[$,\s]', '', 'g')::numeric > 0)
        or concat_ws(' ', p_parsed ->> 'saleType', p_parsed ->> 'eventSaleName', p_parsed ->> 'saleStatus') ~* 'buy\s*-?\s*now|make\s*-?\s*(an\s+)?offer')
      then 'OFFLANE'
    else 'INCOMPLETE' end;
$$;

-- MMR válido do match (a coluna nova ou o que o carro guardava).
create or replace function public.panel_manheim_offer_mmr(p_mmr_cents integer, p_parsed jsonb)
returns bigint language sql immutable set search_path = '' as $$
  select coalesce(case when p_mmr_cents > 0 then p_mmr_cents end,
    case when coalesce(p_parsed ->> 'mmrCents', '') ~ '^[0-9]{1,12}$' and (p_parsed ->> 'mmrCents')::bigint > 0 then (p_parsed ->> 'mmrCents')::bigint end);
$$;

-- ---------------------------------------------------------------- resumo por demanda (sem carros)
create or replace function public.panel_manheim_offer_summary(p_environment public.panel_environment, p_upload_id uuid)
returns table(demand_key text, lane_count integer, offlane_count integer, incomplete_count integer, selected_count integer, selected_ids uuid[])
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with options as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as demand_key,
           public.panel_manheim_offer_group(m.vehicle_json -> 'parsed') as grp
      from public.manheim_matches m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and public.panel_manheim_offer_mmr(m.mmr_cents, m.vehicle_json -> 'parsed') is not null
  ), counts as (
    select o.demand_key, count(*) filter (where o.grp = 'LANE')::integer lane_count,
           count(*) filter (where o.grp = 'OFFLANE')::integer offlane_count, count(*) filter (where o.grp = 'INCOMPLETE')::integer incomplete_count
      from options o group by o.demand_key
  ), picked as (
    select s.demand_key, count(*)::integer selected_count, array_agg(s.match_id order by s.updated_at) selected_ids
      from public.manheim_option_selections s
     where s.environment = p_environment and s.upload_id = p_upload_id and s.status = 'SELECTED'
     group by s.demand_key
  )
  select c.demand_key, c.lane_count, c.offlane_count, c.incomplete_count, coalesce(p.selected_count, 0), coalesce(p.selected_ids, '{}')
    from counts c left join picked p using (demand_key);
$$;

-- ---------------------------------------------------------------- uma página de um grupo de uma demanda
create or replace function public.panel_manheim_offer_page(
  p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_group text, p_offset integer, p_limit integer
)
returns table(id uuid, journey_id uuid, calc_ref text, logical_mode text, match_kind text, match_reason text, mmr_status text,
  row_fingerprint text, presented_unit_id uuid, vehicle_json jsonb, offer_group text, cr numeric, cr_minimum numeric, below_minimum boolean,
  tier integer, mmr_cents bigint, default_pct numeric, selection_status text, manual boolean, manual_reason text, manual_pct numeric,
  final_cents integer, note text, total_in_group integer)
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with options as (
    select m.*, public.panel_manheim_offer_group(m.vehicle_json -> 'parsed') as grp,
           public.panel_manheim_offer_cr(m.vehicle_json -> 'parsed') as cr_value,
           public.panel_manheim_offer_mmr(m.mmr_cents, m.vehicle_json -> 'parsed') as mmr_value
      from public.manheim_matches m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.demand_key = p_demand_key or (m.demand_key is null and (case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) = p_demand_key))
  ), ranked as (
    select o.*, public.panel_manheim_offer_cr_min(o.mmr_value) as cr_min,
           row_number() over (partition by (o.cr_value >= public.panel_manheim_offer_cr_min(o.mmr_value))
             order by o.cr_value desc nulls last, nullif(o.vehicle_json #>> '{parsed,startsAt}', '') nulls last,
                      nullif(o.vehicle_json #>> '{parsed,lane}', '') nulls last, nullif(o.vehicle_json #>> '{parsed,run}', '') nulls last,
                      o.vin nulls last, o.id) as position
      from options o
     where o.mmr_value is not null and o.grp = p_group
  ), tiered as (
    select r.*, case when r.cr_value is null then 4
                     when r.cr_value >= r.cr_min and r.position <= 5 then 0
                     when r.cr_value < r.cr_min and r.position <= 5 then 1
                     when r.cr_value >= r.cr_min then 2 else 3 end as tier_value,
           count(*) over ()::integer as total
      from ranked r
  )
  select t.id, t.journey_id, trim(t.calc_ref::text), t.logical_mode::text, t.match_kind, t.match_reason, t.mmr_status, t.row_fingerprint,
         t.presented_unit_id, t.vehicle_json, t.grp, t.cr_value, t.cr_min, case when t.cr_value is null then null else t.cr_value < t.cr_min end,
         t.tier_value, t.mmr_value, public.panel_manheim_offer_default_pct(t.mmr_value),
         coalesce(s.status, 'AVAILABLE'), coalesce(s.manual, false), s.manual_reason, s.manual_pct,
         coalesce(s.final_cents, round(t.mmr_value * (100 + public.panel_manheim_offer_default_pct(t.mmr_value)) / 100)::integer), s.note, t.total
    from tiered t
    left join public.manheim_option_selections s on s.environment = p_environment and s.match_id = t.id
   order by t.tier_value, t.cr_value desc nulls last, nullif(t.vehicle_json #>> '{parsed,startsAt}', '') nulls last,
            nullif(t.vehicle_json #>> '{parsed,lane}', '') nulls last, nullif(t.vehicle_json #>> '{parsed,run}', '') nulls last, t.vin nulls last, t.id
  offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

-- ---------------------------------------------------------------- seleção (regras no servidor)
-- p_action: SELECT (selecionar para cliente; fora de LANE exige motivo), REMOVE (tirar da seleção),
-- EXCLUDE (manter fora) ou PRICE (só percentual e observação). p_manual_pct nulo = percentual padrão.
create or replace function public.panel_manheim_offer_select(
  p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_action text,
  p_manual_pct numeric, p_reason text, p_note text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_match public.manheim_matches%rowtype;
  v_before public.manheim_option_selections%rowtype;
  v_after public.manheim_option_selections%rowtype;
  v_demand text;
  v_group text;
  v_mmr bigint;
  v_default numeric;
  v_status text;
  v_manual boolean;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_selected integer;
  v_now timestamptz := now();
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  if p_action not in ('SELECT', 'REMOVE', 'EXCLUDE', 'PRICE') then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
  if p_manual_pct is not null and (p_manual_pct < 0 or p_manual_pct > 50 or p_manual_pct <> round(p_manual_pct, 2)) then raise exception 'MANHEIM_SELECTION_PCT_INVALID'; end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'MANHEIM_SELECTION_INVALID'; end if;

  select * into v_match from public.manheim_matches m where m.environment = p_environment and m.id = p_match_id;
  if not found or v_match.undone_at is not null then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
  -- Só o lote ativo: ativado depois do último bloco e não desfeito.
  if not exists (select 1 from public.manheim_uploads u where u.id = v_match.upload_id and u.environment = p_environment
                  and u.undone_at is null and u.activated_at is not null) then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
  v_mmr := public.panel_manheim_offer_mmr(v_match.mmr_cents, v_match.vehicle_json -> 'parsed');
  if v_mmr is null then raise exception 'MANHEIM_MATCH_WITHOUT_MMR'; end if;
  v_demand := coalesce(v_match.demand_key, case when v_match.journey_id is not null then 'journey:' || v_match.journey_id::text else 'ref:' || trim(v_match.calc_ref::text) end || ':' || coalesce(v_match.logical_mode::text, ''));
  v_group := public.panel_manheim_offer_group(v_match.vehicle_json -> 'parsed');
  v_default := public.panel_manheim_offer_default_pct(v_mmr);

  -- Uma demanda por vez: o limite de 10 não é furado por duas abas ao mesmo tempo.
  perform pg_advisory_xact_lock(hashtextextended('manheim_offer:' || p_environment::text || ':' || v_match.upload_id::text || ':' || v_demand, 0));
  select * into v_before from public.manheim_option_selections s where s.environment = p_environment and s.match_id = p_match_id for update;

  v_status := case p_action when 'SELECT' then 'SELECTED' when 'REMOVE' then 'AVAILABLE' when 'EXCLUDE' then 'EXCLUDED' else coalesce(v_before.status, 'AVAILABLE') end;
  v_manual := coalesce(v_before.manual, false);
  if p_action = 'SELECT' then
    if v_group <> 'LANE' then
      if v_reason is null or length(v_reason) not between 5 and 300 then raise exception 'MANHEIM_SELECTION_REASON_REQUIRED'; end if;
      v_manual := true;
    else
      v_manual := false; v_reason := null;
    end if;
    select count(*) into v_selected from public.manheim_option_selections s
     where s.environment = p_environment and s.upload_id = v_match.upload_id and s.demand_key = v_demand and s.status = 'SELECTED' and s.match_id <> p_match_id;
    if v_selected >= 10 then raise exception 'MANHEIM_SELECTION_LIMIT'; end if;
  elsif p_action in ('REMOVE', 'EXCLUDE') then
    v_manual := false; v_reason := null;
  else
    v_reason := v_before.manual_reason;
  end if;

  insert into public.manheim_option_selections as s (environment, match_id, upload_id, demand_key, status, manual, manual_reason, offer_group,
    mmr_cents, default_pct, manual_pct, final_cents, note, updated_by, updated_at)
  values (p_environment, p_match_id, v_match.upload_id, v_demand, v_status, v_manual, v_reason, v_group, v_mmr, v_default,
    case when p_action = 'PRICE' or p_manual_pct is not null then p_manual_pct else v_before.manual_pct end,
    round(v_mmr * (100 + coalesce(case when p_action = 'PRICE' or p_manual_pct is not null then p_manual_pct else v_before.manual_pct end, v_default)) / 100)::integer,
    case when p_action = 'PRICE' or v_note is not null then v_note else v_before.note end, p_actor_id, v_now)
  on conflict (environment, match_id) do update
    set status = excluded.status, manual = excluded.manual, manual_reason = excluded.manual_reason, offer_group = excluded.offer_group,
        mmr_cents = excluded.mmr_cents, default_pct = excluded.default_pct, manual_pct = excluded.manual_pct, final_cents = excluded.final_cents,
        note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_after;

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_option_selection', p_match_id, 'OPTION_' || p_action,
    case when v_before.id is null then null else jsonb_build_object('status', v_before.status, 'manual', v_before.manual, 'manual_reason', v_before.manual_reason,
      'manual_pct', v_before.manual_pct, 'final_cents', v_before.final_cents, 'note', v_before.note) end,
    jsonb_build_object('status', v_after.status, 'manual', v_after.manual, 'manual_reason', v_after.manual_reason, 'group', v_after.offer_group,
      'default_pct', v_after.default_pct, 'manual_pct', v_after.manual_pct, 'final_cents', v_after.final_cents, 'note', v_after.note, 'demand_key', v_demand), v_now);

  select count(*) into v_selected from public.manheim_option_selections s
   where s.environment = p_environment and s.upload_id = v_match.upload_id and s.demand_key = v_demand and s.status = 'SELECTED';
  return jsonb_build_object('matchId', p_match_id, 'demandKey', v_demand, 'status', v_after.status, 'group', v_after.offer_group, 'manual', v_after.manual,
    'manualReason', v_after.manual_reason, 'defaultPct', v_after.default_pct, 'manualPct', v_after.manual_pct, 'finalCents', v_after.final_cents,
    'note', v_after.note, 'selectedCount', v_selected);
end;
$$;

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.panel_manheim_offer_cr(jsonb)',
    'public.panel_manheim_offer_cr_min(bigint)',
    'public.panel_manheim_offer_default_pct(bigint)',
    'public.panel_manheim_offer_group(jsonb)',
    'public.panel_manheim_offer_mmr(integer, jsonb)',
    'public.panel_manheim_offer_summary(public.panel_environment, uuid)',
    'public.panel_manheim_offer_page(public.panel_environment, uuid, text, text, integer, integer)',
    'public.panel_manheim_offer_select(public.panel_environment, uuid, uuid, text, numeric, text, text)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end $$;
