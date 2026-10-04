-- Preço para o cliente em dólar: além do percentual, o operador pode digitar o valor final (sem número quebrado).
-- O valor digitado é guardado exato (manual_final); o percentual passa a ser só a referência, com duas casas.
alter table public.manheim_option_selections add column if not exists manual_final boolean not null default false;

-- Função nova (_v2) com o valor em dólar; a antiga fica como estava (sem DROP), e o painel passa a chamar a nova.
create or replace function public.panel_manheim_offer_select_v2(
  p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_action text,
  p_manual_pct numeric, p_reason text, p_note text, p_final_cents bigint default null
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
  v_pct numeric;
  v_final bigint;
  v_manual_final boolean;
begin
  if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active)
  then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  if p_action not in ('SELECT', 'REMOVE', 'EXCLUDE', 'PRICE') then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
  if p_manual_pct is not null and (p_manual_pct < 0 or p_manual_pct > 50 or p_manual_pct <> round(p_manual_pct, 2)) then raise exception 'MANHEIM_SELECTION_PCT_INVALID'; end if;
  if p_final_cents is not null and p_manual_pct is not null then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
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

  -- O preço para o cliente: valor digitado em dólar (guardado exato; o % vira só referência, com duas casas),
  -- percentual digitado, ou o que já estava. Um valor digitado continua valendo nas outras ações enquanto o MMR
  -- for o mesmo; o valor fica entre o MMR e MMR + 50%, a mesma faixa do percentual.
  if p_final_cents is not null then
    if p_final_cents < v_mmr or p_final_cents > round(v_mmr * 1.5) then raise exception 'MANHEIM_SELECTION_FINAL_INVALID'; end if;
    v_final := p_final_cents;
    v_pct := least(round((p_final_cents::numeric / v_mmr - 1) * 100, 2), 50);
    v_manual_final := true;
  elsif p_action = 'PRICE' or p_manual_pct is not null then
    v_pct := p_manual_pct;
    v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100);
    v_manual_final := false;
  elsif v_before.id is not null and v_before.manual_final and v_before.mmr_cents = v_mmr then
    v_pct := v_before.manual_pct; v_final := v_before.final_cents; v_manual_final := true;
  else
    v_pct := v_before.manual_pct;
    v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100);
    v_manual_final := false;
  end if;

  insert into public.manheim_option_selections as s (environment, match_id, upload_id, demand_key, status, manual, manual_reason, offer_group,
    mmr_cents, default_pct, manual_pct, final_cents, manual_final, note, updated_by, updated_at)
  values (p_environment, p_match_id, v_match.upload_id, v_demand, v_status, v_manual, v_reason, v_group, v_mmr, v_default,
    v_pct, v_final::integer, v_manual_final,
    case when p_action = 'PRICE' or v_note is not null then v_note else v_before.note end, p_actor_id, v_now)
  on conflict (environment, match_id) do update
    set status = excluded.status, manual = excluded.manual, manual_reason = excluded.manual_reason, offer_group = excluded.offer_group,
        mmr_cents = excluded.mmr_cents, default_pct = excluded.default_pct, manual_pct = excluded.manual_pct, final_cents = excluded.final_cents,
        manual_final = excluded.manual_final, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into v_after;

  insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
  values (p_environment, p_actor_id, 'manheim_option_selection', p_match_id, 'OPTION_' || p_action,
    case when v_before.id is null then null else jsonb_build_object('status', v_before.status, 'manual', v_before.manual, 'manual_reason', v_before.manual_reason,
      'manual_pct', v_before.manual_pct, 'final_cents', v_before.final_cents, 'manual_final', v_before.manual_final, 'note', v_before.note) end,
    jsonb_build_object('status', v_after.status, 'manual', v_after.manual, 'manual_reason', v_after.manual_reason, 'group', v_after.offer_group,
      'default_pct', v_after.default_pct, 'manual_pct', v_after.manual_pct, 'final_cents', v_after.final_cents, 'manual_final', v_after.manual_final, 'note', v_after.note, 'demand_key', v_demand), v_now);

  select count(*) into v_selected from public.manheim_option_selections s
   where s.environment = p_environment and s.upload_id = v_match.upload_id and s.demand_key = v_demand and s.status = 'SELECTED';
  return jsonb_build_object('matchId', p_match_id, 'demandKey', v_demand, 'status', v_after.status, 'group', v_after.offer_group, 'manual', v_after.manual,
    'manualReason', v_after.manual_reason, 'defaultPct', v_after.default_pct, 'manualPct', v_after.manual_pct, 'finalCents', v_after.final_cents, 'manualFinal', v_after.manual_final,
    'note', v_after.note, 'selectedCount', v_selected);
end;
$$;

revoke all on function public.panel_manheim_offer_select_v2(public.panel_environment, uuid, uuid, text, numeric, text, text, bigint) from public, anon, authenticated;
grant execute on function public.panel_manheim_offer_select_v2(public.panel_environment, uuid, uuid, text, numeric, text, text, bigint) to service_role;
