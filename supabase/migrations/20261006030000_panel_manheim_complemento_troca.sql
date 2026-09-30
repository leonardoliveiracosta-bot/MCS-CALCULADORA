-- Complemento do lote Manheim: gravação por troca única (corrige o tempo esgotado da 20261006020000).
-- Aditiva. Depende de 20261006010000 e 20261006020000.
--
-- A gravação antiga copiava os 70.309 carros para manheim_sale_info numa só chamada e passava do
-- limite de 8 s por chamada do banco (nada foi gravado). Agora os dados já conferidos ficam onde a
-- conferência os deixou (manheim_complement_items, por envio) e "Complementar agora" só aponta o lote
-- para aquele envio (manheim_sale_current, uma linha). Tudo ou nada, qualquer que seja o tamanho do
-- lote: antes da troca ninguém vê os dados novos; depois, todos de uma vez.
--  * BUSCAS, a seleção e a prévia leem os dados de venda do envio em uso do lote.
--  * O envio em uso nunca é apagado; envio cancelado ou substituído é limpo no próximo começo.
--  * Os mesmos arquivos de novo: nada muda (o envio novo é descartado com NO_CHANGE).
--  * O grupo (Lane/Run, Buy Now/Make Offer, incompleto) de cada carro é calculado uma vez, na conferência
--    do bloco, e guardado com os dados de venda. BUSCAS lê o grupo pronto em vez de abrir o carro de
--    cada match (no lote real: de 7 s para 0,1 s). A checagem de MMR usa a coluna do match antes do JSON.
--  * Os totais dos grupos saem numa leitura separada (panel_manheim_complement_result), fora da gravação.
--  * manheim_sale_info (20261006010000) deixa de ser usada e fica vazia.
--  * Carro, match, MMR, critérios, seleção, V1/V2, histórico e lotes desfeitos nunca mudam.

create table if not exists public.manheim_sale_current (
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  run_id uuid not null references public.manheim_complement_runs(id),
  applied_by uuid references public.panel_users(id),
  applied_at timestamptz not null default now(),
  primary key (environment, upload_id)
);
create index if not exists manheim_sale_current_upload_idx on public.manheim_sale_current(upload_id);
create index if not exists manheim_sale_current_run_idx on public.manheim_sale_current(run_id);
create index if not exists manheim_sale_current_applied_by_idx on public.manheim_sale_current(applied_by);
alter table public.manheim_sale_current enable row level security;
alter table public.manheim_sale_current force row level security;
revoke all on table public.manheim_sale_current from public, anon, authenticated;
grant select on table public.manheim_sale_current to service_role;

alter table public.manheim_complement_items add column if not exists offer_group text
  check (offer_group is null or offer_group in ('LANE', 'OFFLANE', 'INCOMPLETE'));

-- ---------------------------------------------------------------- leituras com os dados do envio em uso
create or replace function public.panel_manheim_offer_summary(p_environment public.panel_environment, p_upload_id uuid)
returns table(demand_key text, lane_count integer, offlane_count integer, incomplete_count integer, selected_count integer, selected_ids uuid[])
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with options as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) as demand_key,
           coalesce(si.offer_group, public.panel_manheim_offer_group(coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb))) as grp
      from public.manheim_matches m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.mmr_cents > 0 or public.panel_manheim_offer_mmr(null, m.vehicle_json -> 'parsed') is not null)
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

create or replace function public.panel_manheim_offer_page(
  p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_group text, p_offset integer, p_limit integer
)
returns table(id uuid, journey_id uuid, calc_ref text, logical_mode text, match_kind text, match_reason text, mmr_status text,
  row_fingerprint text, presented_unit_id uuid, vehicle_json jsonb, offer_group text, cr numeric, cr_minimum numeric, below_minimum boolean,
  tier integer, mmr_cents bigint, default_pct numeric, selection_status text, manual boolean, manual_reason text, manual_pct numeric,
  final_cents integer, note text, total_in_group integer)
language sql stable security definer set search_path = '' set work_mem = '32MB' as $$
  with source as (
    select m.*, coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as parsed, si.offer_group as stored_group
      from public.manheim_matches m
      left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = m.row_fingerprint
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
       and (m.demand_key = p_demand_key or (m.demand_key is null and (case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) = p_demand_key))
  ), options as (
    select o.*, coalesce(o.stored_group, public.panel_manheim_offer_group(o.parsed)) as grp, public.panel_manheim_offer_cr(o.parsed) as cr_value,
           public.panel_manheim_offer_mmr(o.mmr_cents, o.parsed) as mmr_value,
           -- Empate: leilão mais cedo, depois Lane e Run mais próximos (ordem natural), depois o identificador estável.
           nullif(o.parsed ->> 'startsAt', '') as starts_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'lane', '')), ''), 20, '0') as lane_key,
           lpad(nullif(trim(coalesce(o.parsed ->> 'run', '')), ''), 20, '0') as run_key
      from source o
  ), ranked as (
    select o.*, public.panel_manheim_offer_cr_min(o.mmr_value) as cr_min,
           row_number() over (partition by (o.cr_value >= public.panel_manheim_offer_cr_min(o.mmr_value))
             order by o.cr_value desc nulls last, o.starts_key nulls last, o.lane_key nulls last, o.run_key nulls last, o.row_fingerprint, o.id) as position
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
         t.presented_unit_id, jsonb_set(t.vehicle_json, '{parsed}', t.parsed), t.grp, t.cr_value, t.cr_min, case when t.cr_value is null then null else t.cr_value < t.cr_min end,
         t.tier_value, t.mmr_value, public.panel_manheim_offer_default_pct(t.mmr_value),
         coalesce(s.status, 'AVAILABLE'), coalesce(s.manual, false), s.manual_reason, s.manual_pct,
         coalesce(s.final_cents, round(t.mmr_value * (100 + public.panel_manheim_offer_default_pct(t.mmr_value)) / 100)::integer), s.note, t.total
    from tiered t
    left join public.manheim_option_selections s on s.environment = p_environment and s.match_id = t.id
   order by t.tier_value, t.cr_value desc nulls last, t.starts_key nulls last, t.lane_key nulls last, t.run_key nulls last, t.row_fingerprint, t.id
  offset greatest(coalesce(p_offset, 0), 0) limit least(greatest(coalesce(p_limit, 10), 1), 50);
$$;

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
  v_group := coalesce((select si.offer_group from public.manheim_complement_items si
      where si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = v_match.upload_id)
        and si.row_fingerprint = v_match.row_fingerprint),
    public.panel_manheim_offer_group(coalesce(v_match.vehicle_json -> 'parsed', '{}'::jsonb)));
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

create or replace function public.panel_manheim_complement_check(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_client_key text, p_manifest_hash text,
  p_file_index integer, p_chunk_index integer, p_chunk_hash text, p_items jsonb
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb;
begin
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, p_upload_id, p_client_key, p_manifest_hash,
    p_file_index, p_chunk_index, p_chunk_hash, jsonb_array_length(coalesce(p_items, '[]'::jsonb)));
  select jsonb_build_object(
    'received', (select count(*) from jsonb_array_elements(p_items)),
    'found', count(v.id),
    'changed', count(v.id) filter (where ((v.vehicle_json || coalesce(si.sale, '{}'::jsonb)) @> i.sale) is not true),
    'lane', count(v.id) filter (where public.panel_manheim_offer_group(v.vehicle_json || i.sale) = 'LANE'),
    'offLane', count(v.id) filter (where public.panel_manheim_offer_group(v.vehicle_json || i.sale) = 'OFFLANE'),
    'incomplete', count(v.id) filter (where public.panel_manheim_offer_group(v.vehicle_json || i.sale) = 'INCOMPLETE'))
    into v_result
    from public.panel_manheim_complement_items(p_items) i
    left join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = p_upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null
    left join public.manheim_complement_items si on si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id) and si.row_fingerprint = i.row_fingerprint;
  return v_result || jsonb_build_object('missing', (v_result ->> 'received')::integer - (v_result ->> 'found')::integer);
end;
$$;

create or replace function public.panel_manheim_complement_start(
  p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid, p_client_key text, p_manifest_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_run uuid;
begin
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, p_upload_id, p_client_key, p_manifest_hash, null, null, null, null);
  perform pg_advisory_xact_lock(hashtextextended('manheim_complement:' || p_environment::text || ':' || p_upload_id::text, 0));
  -- Envio cancelado ou substituído não serve para mais nada (o complemento em uso nunca é apagado).
  delete from public.manheim_complement_items i using public.manheim_complement_runs r
   where r.id = i.run_id and r.environment = p_environment and r.upload_id = p_upload_id and r.status <> 'STAGING'
     and r.id is distinct from (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id);
  select r.id into v_run from public.manheim_complement_runs r
   where r.environment = p_environment and r.upload_id = p_upload_id and r.created_by = p_actor_id and r.status = 'STAGING'
     and r.client_key = p_client_key and r.manifest_hash = p_manifest_hash
   order by r.created_at desc limit 1;
  if v_run is null then
    insert into public.manheim_complement_runs(environment, upload_id, created_by, client_key, manifest_hash)
    values (p_environment, p_upload_id, p_actor_id, p_client_key, p_manifest_hash) returning id into v_run;
  end if;
  return jsonb_build_object('runId', v_run, 'received',
    coalesce((select jsonb_agg(jsonb_build_array(c.file_index, c.chunk_index) order by c.file_index, c.chunk_index) from public.manheim_complement_chunks c where c.run_id = v_run), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------- conferência de um bloco (guarda o grupo)
create or replace function public.panel_manheim_complement_stage(
  p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid,
  p_file_index integer, p_chunk_index integer, p_chunk_hash text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.manheim_complement_runs%rowtype;
  v_prior text;
  v_count integer;
  v_found integer;
begin
  select * into v_run from public.manheim_complement_runs r where r.id = p_run_id and r.environment = p_environment and r.created_by = p_actor_id for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_run.status <> 'STAGING' then raise exception 'MANHEIM_COMPLEMENT_CANCELED'; end if;
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, v_run.upload_id, v_run.client_key, v_run.manifest_hash,
    p_file_index, p_chunk_index, p_chunk_hash, jsonb_array_length(coalesce(p_items, '[]'::jsonb)));
  select c.chunk_hash into v_prior from public.manheim_complement_chunks c where c.run_id = p_run_id and c.file_index = p_file_index and c.chunk_index = p_chunk_index;
  if v_prior is not null then return jsonb_build_object('runId', p_run_id, 'stored', 0, 'again', true); end if;
  select count(*), count(v.id) into v_count, v_found
    from public.panel_manheim_complement_items(p_items) i
    left join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null;
  -- Um carro que o lote não tem: o envio inteiro é cancelado (nada foi gravado no lote).
  if v_found <> v_count then
    update public.manheim_complement_runs set status = 'CANCELED', cancel_reason = 'MISSING_VEHICLE', finished_at = now() where id = p_run_id;
    return jsonb_build_object('runId', p_run_id, 'error', 'MANHEIM_COMPLEMENT_MISMATCH');
  end if;
  -- O grupo de cada carro, calculado uma vez aqui (500 carros por bloco), para BUSCAS ler pronto.
  insert into public.manheim_complement_items(run_id, row_fingerprint, sale, offer_group)
  select p_run_id, i.row_fingerprint, i.sale, public.panel_manheim_offer_group(v.vehicle_json || i.sale)
    from public.panel_manheim_complement_items(p_items) i
    join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null;
  insert into public.manheim_complement_chunks(run_id, file_index, chunk_index, chunk_hash, item_count) values (p_run_id, p_file_index, p_chunk_index, p_chunk_hash, v_count);
  return jsonb_build_object('runId', p_run_id, 'stored', v_count, 'again', false);
end;
$$;

-- ---------------------------------------------------------------- gravação: uma troca, tudo ou nada
create or replace function public.panel_manheim_complement_apply(p_environment public.panel_environment, p_actor_id uuid, p_run_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run public.manheim_complement_runs%rowtype;
  v_expected_chunks integer;
  v_chunks integer;
  v_vehicles integer;
  v_items integer;
  v_found integer;
  v_current uuid;
  v_changed integer;
  v_result jsonb;
begin
  select * into v_run from public.manheim_complement_runs r where r.id = p_run_id and r.environment = p_environment and r.created_by = p_actor_id for update;
  if not found then raise exception 'MANHEIM_UPLOAD_NOT_FOUND'; end if;
  if v_run.status <> 'STAGING' then raise exception 'MANHEIM_COMPLEMENT_CANCELED'; end if;
  perform public.panel_manheim_complement_guard(p_environment, p_actor_id, v_run.upload_id, v_run.client_key, v_run.manifest_hash, null, null, null, null);
  perform pg_advisory_xact_lock(hashtextextended('manheim_complement:' || p_environment::text || ':' || v_run.upload_id::text, 0));

  -- Todos os blocos do manifesto chegaram e todo carro do lote foi associado, um a um.
  select coalesce(sum((f ->> 'chunkCount')::integer), 0) into v_expected_chunks
    from public.manheim_uploads u, jsonb_array_elements(u.files_json) f where u.id = v_run.upload_id;
  select count(*) into v_chunks from public.manheim_complement_chunks c where c.run_id = p_run_id;
  select count(*) into v_vehicles from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = v_run.upload_id and v.undone_at is null;
  select count(*), count(v.id) into v_items, v_found
    from public.manheim_complement_items i
    left join public.manheim_vehicles v on v.environment = p_environment and v.upload_id = v_run.upload_id and v.row_fingerprint = i.row_fingerprint and v.undone_at is null
   where i.run_id = p_run_id;
  if v_chunks <> v_expected_chunks then raise exception 'MANHEIM_COMPLEMENT_INCOMPLETE'; end if;
  if v_items <> v_found or v_found <> v_vehicles then raise exception 'MANHEIM_COMPLEMENT_MISMATCH'; end if;

  select c.run_id into v_current from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = v_run.upload_id for update;
  select count(*) into v_changed
    from public.manheim_complement_items i
    left join public.manheim_complement_items cur on cur.run_id = v_current and cur.row_fingerprint = i.row_fingerprint
   where i.run_id = p_run_id and cur.sale is distinct from i.sale;
  -- Os mesmos dados de novo: nada muda.
  if v_changed = 0 then
    update public.manheim_complement_runs set status = 'CANCELED', cancel_reason = 'NO_CHANGE', finished_at = now() where id = p_run_id;
    return jsonb_build_object('runId', p_run_id, 'uploadId', v_run.upload_id, 'applied', false, 'cars', v_found, 'changed', 0);
  end if;

  insert into public.manheim_sale_current(environment, upload_id, run_id, applied_by, applied_at)
  values (p_environment, v_run.upload_id, p_run_id, p_actor_id, now())
  on conflict (environment, upload_id) do update set run_id = excluded.run_id, applied_by = excluded.applied_by, applied_at = excluded.applied_at;
  v_result := jsonb_build_object('cars', v_found, 'changed', v_changed);
  update public.manheim_complement_runs set status = 'APPLIED', result_json = v_result, finished_at = now() where id = p_run_id;
  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_upload', v_run.upload_id, 'MANHEIM_COMPLEMENT',
    case when v_current is null then null else jsonb_build_object('runId', v_current) end, v_result || jsonb_build_object('runId', p_run_id), now());
  return v_result || jsonb_build_object('runId', p_run_id, 'uploadId', v_run.upload_id, 'applied', true);
end;
$$;

-- ---------------------------------------------------------------- totais depois da troca (só leitura)
create or replace function public.panel_manheim_complement_result(p_environment public.panel_environment, p_actor_id uuid, p_upload_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_run uuid;
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  select c.run_id into v_run from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = p_upload_id;
  return (select jsonb_build_object('withSale', count(*),
      'lane', count(*) filter (where i.offer_group = 'LANE'), 'offLane', count(*) filter (where i.offer_group = 'OFFLANE'),
      'incomplete', count(*) filter (where i.offer_group = 'INCOMPLETE'))
    from public.manheim_complement_items i where i.run_id = v_run)
    || jsonb_build_object(
      'cars', (select count(*) from public.manheim_vehicles v where v.environment = p_environment and v.upload_id = p_upload_id and v.undone_at is null),
      'matches', (select count(*) from public.manheim_matches m where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null));
end;
$$;

revoke all on function public.panel_manheim_complement_result(public.panel_environment, uuid, uuid) from public, anon, authenticated;
grant execute on function public.panel_manheim_complement_result(public.panel_environment, uuid, uuid) to service_role;
