-- Additive functions: existing RPCs and stored data remain available for rollback.
CREATE OR REPLACE FUNCTION public.panel_manheim_offer_select_v3(p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_action text, p_manual_pct numeric, p_reason text, p_note text, p_final_cents bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 v_grouped public.manheim_matches[];
 v_match public.manheim_matches%rowtype; v_before public.manheim_option_selections%rowtype; v_after public.manheim_option_selections%rowtype;
 v_demand text; v_group text; v_mmr bigint; v_default numeric; v_status text; v_manual boolean;
 v_reason text := nullif(trim(coalesce(p_reason, '')), ''); v_note text := nullif(trim(coalesce(p_note, '')), '');
 v_members jsonb; v_selected integer; v_now timestamptz := now(); v_pct numeric; v_final bigint; v_manual_final boolean;
begin
 if not exists (select 1 from public.panel_users pu where pu.id = p_actor_id and pu.environment = p_environment and pu.active) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
 if p_action not in ('SELECT', 'REMOVE', 'EXCLUDE', 'PRICE') then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
 if p_manual_pct is not null and (p_manual_pct < 0 or p_manual_pct > 50 or p_manual_pct <> round(p_manual_pct, 2)) then raise exception 'MANHEIM_SELECTION_PCT_INVALID'; end if;
 if p_final_cents is not null and p_manual_pct is not null then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
 if v_note is not null and length(v_note) > 500 then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
 select * into v_match from public.manheim_matches m where m.environment = p_environment and m.id = p_match_id;
 if not found or v_match.undone_at is not null then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
 if not exists (select 1 from public.manheim_uploads u where u.id = v_match.upload_id and u.environment = p_environment and u.undone_at is null and u.activated_at is not null) then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
 -- Keep a pre-existing selection on any sale; operations target the car under the same demand lock.
 perform pg_advisory_xact_lock(hashtextextended('manheim_offer:' || p_environment::text || ':' || v_match.upload_id::text || ':' || v_match.demand_key,0));
 -- Reuse only the cars within this operation; selection counts still read current selection rows.
 select coalesce(array_agg(g), '{}'::public.manheim_matches[]) into v_grouped
 from public.panel_manheim_grouped_options(p_environment,v_match.upload_id,v_match.demand_key) g;
 select g.* into v_match from unnest(v_grouped) g where (g.vehicle_json#>'{parsed,memberMatchIds}') ? p_match_id::text;
 if not found then raise exception 'MANHEIM_SALE_ENDED'; end if;
 v_members := v_match.vehicle_json#>'{parsed,memberMatchIds}';
 select coalesce((select ss.match_id from public.manheim_option_selections ss where ss.environment=p_environment and v_members ? ss.match_id::text order by (ss.status='SELECTED') desc,ss.updated_at desc,ss.id limit 1),v_match.id) into p_match_id;
 v_mmr := public.panel_manheim_offer_mmr(v_match.mmr_cents, v_match.vehicle_json -> 'parsed');
 if v_mmr is null then raise exception 'MANHEIM_MATCH_WITHOUT_MMR'; end if;
 v_demand := coalesce(v_match.demand_key, case when v_match.journey_id is not null then 'journey:' || v_match.journey_id::text else 'ref:' || trim(v_match.calc_ref::text) end || ':' || coalesce(v_match.logical_mode::text, ''));
 v_group := coalesce((select si.offer_group from public.manheim_complement_items si where si.run_id = (select c.run_id from public.manheim_sale_current c where c.environment = p_environment and c.upload_id = v_match.upload_id) and si.row_fingerprint = v_match.row_fingerprint), public.panel_manheim_offer_group(coalesce(v_match.vehicle_json -> 'parsed', '{}'::jsonb)));
 v_default := public.panel_manheim_offer_default_pct(v_mmr);
 perform pg_advisory_xact_lock(hashtextextended('manheim_offer:' || p_environment::text || ':' || v_match.upload_id::text || ':' || v_demand, 0));
 select * into v_before from public.manheim_option_selections s where s.environment = p_environment and s.match_id = p_match_id for update;
 v_status := case p_action when 'SELECT' then 'SELECTED' when 'REMOVE' then 'AVAILABLE' when 'EXCLUDE' then 'EXCLUDED' else coalesce(v_before.status, 'AVAILABLE') end;
 v_manual := coalesce(v_before.manual, false);
 if p_action = 'SELECT' then
  if v_group <> 'LANE' then
   if v_reason is null or length(v_reason) not between 5 and 300 then raise exception 'MANHEIM_SELECTION_REASON_REQUIRED'; end if;
   v_manual := true;
  else v_manual := false; v_reason := null; end if;
  select count(*) into v_selected from unnest(v_grouped) g where coalesce(g.demand_key, case when g.journey_id is not null then 'journey:' || g.journey_id::text else 'ref:' || trim(g.calc_ref::text) end || ':' || coalesce(g.logical_mode::text, '')) = v_demand and g.id<>v_match.id and exists(select 1 from public.manheim_option_selections s where s.environment=p_environment and s.status='SELECTED' and (g.vehicle_json#>'{parsed,memberMatchIds}') ? s.match_id::text);
  if v_selected >= 10 then raise exception 'MANHEIM_SELECTION_LIMIT'; end if;
 elsif p_action in ('REMOVE', 'EXCLUDE') then v_manual := false; v_reason := null;
 else v_reason := v_before.manual_reason; end if;
 if p_final_cents is not null then
  if p_final_cents < v_mmr or p_final_cents > round(v_mmr * 1.5) then raise exception 'MANHEIM_SELECTION_FINAL_INVALID'; end if;
  v_final := p_final_cents; v_pct := least(round((p_final_cents::numeric / v_mmr - 1) * 100, 2), 50); v_manual_final := true;
 elsif p_action = 'PRICE' or p_manual_pct is not null then
  v_pct := p_manual_pct; v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100); v_manual_final := false;
 elsif v_before.id is not null and v_before.manual_final and v_before.mmr_cents = v_mmr then
  v_pct := v_before.manual_pct; v_final := v_before.final_cents; v_manual_final := true;
 else
  v_pct := v_before.manual_pct; v_final := round(v_mmr * (100 + coalesce(v_pct, v_default)) / 100); v_manual_final := false;
 end if;
 insert into public.manheim_option_selections as s (environment, match_id, upload_id, demand_key, status, manual, manual_reason, offer_group, mmr_cents, default_pct, manual_pct, final_cents, manual_final, note, updated_by, updated_at)
 values (p_environment, p_match_id, v_match.upload_id, v_demand, v_status, v_manual, v_reason, v_group, v_mmr, v_default, v_pct, v_final::integer, v_manual_final, case when p_action = 'PRICE' or v_note is not null then v_note else v_before.note end, p_actor_id, v_now)
 on conflict (environment, match_id) do update set status = excluded.status, manual = excluded.manual, manual_reason = excluded.manual_reason, offer_group = excluded.offer_group, mmr_cents = excluded.mmr_cents, default_pct = excluded.default_pct, manual_pct = excluded.manual_pct, final_cents = excluded.final_cents, manual_final = excluded.manual_final, note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at
 returning * into v_after;
 insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, before_json, after_json, created_at)
 values (p_environment, p_actor_id, 'manheim_option_selection', p_match_id, 'OPTION_' || p_action,
  case when v_before.id is null then null else jsonb_build_object('status', v_before.status, 'manual', v_before.manual, 'manual_reason', v_before.manual_reason, 'manual_pct', v_before.manual_pct, 'final_cents', v_before.final_cents, 'manual_final', v_before.manual_final, 'note', v_before.note) end,
  jsonb_build_object('status', v_after.status, 'manual', v_after.manual, 'manual_reason', v_after.manual_reason, 'group', v_after.offer_group, 'default_pct', v_after.default_pct, 'manual_pct', v_after.manual_pct, 'final_cents', v_after.final_cents, 'manual_final', v_after.manual_final, 'note', v_after.note, 'demand_key', v_demand), v_now);

 -- Only an explicit action changes selection state; no rows or sent snapshots are deleted.
 if p_action in ('SELECT','REMOVE','EXCLUDE') then
  with changed as (
   update public.manheim_option_selections s set status=case when p_action='EXCLUDE' then 'EXCLUDED' else 'AVAILABLE' end,updated_by=p_actor_id,updated_at=v_now
   where s.environment=p_environment and v_members ? s.match_id::text and s.match_id<>p_match_id and s.status='SELECTED' returning s.id,s.match_id
  ) insert into public.audit_log(environment,actor_user_id,entity_type,entity_id,action,after_json)
    select p_environment,p_actor_id,'manheim_option_selection',id,'VIN_GROUP_SELECTION',jsonb_build_object('matchId',match_id,'primary',v_match.id,'action',p_action) from changed;
 end if;
 select count(*) into v_selected from unnest(v_grouped) g where coalesce(g.demand_key, case when g.journey_id is not null then 'journey:' || g.journey_id::text else 'ref:' || trim(g.calc_ref::text) end || ':' || coalesce(g.logical_mode::text, '')) = v_demand and exists(select 1 from public.manheim_option_selections s where s.environment=p_environment and s.status='SELECTED' and (g.vehicle_json#>'{parsed,memberMatchIds}') ? s.match_id::text);
 return jsonb_build_object('matchId', p_match_id, 'demandKey', v_demand, 'status', v_after.status, 'group', v_after.offer_group, 'manual', v_after.manual, 'manualReason', v_after.manual_reason, 'defaultPct', v_after.default_pct, 'manualPct', v_after.manual_pct, 'finalCents', v_after.final_cents, 'manualFinal', v_after.manual_final, 'note', v_after.note, 'selectedCount', v_selected);
end;
$function$;

REVOKE ALL ON FUNCTION public.panel_manheim_offer_select_v3(public.panel_environment,uuid,uuid,text,numeric,text,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panel_manheim_offer_select_v3(public.panel_environment,uuid,uuid,text,numeric,text,text,bigint) TO service_role;

-- PDF resolves just the missing canonical ids, preserving the former group/page order and eligibility.
-- PL/pgSQL defers resolution so fresh installations can apply the later grouped-options migration.
CREATE OR REPLACE FUNCTION public.panel_manheim_offer_ids(p_environment public.panel_environment, p_upload_id uuid, p_demand_key text, p_match_ids uuid[])
RETURNS TABLE(id uuid)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path TO ''
SET work_mem TO '32MB'
AS $function$
begin
 return query
  with source as (
    select m.*, coalesce(m.vehicle_json -> 'parsed', '{}'::jsonb) || coalesce(si.sale, '{}'::jsonb) as parsed, si.offer_group as stored_group
      from public.panel_manheim_grouped_options(p_environment,p_upload_id,p_demand_key) m
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
           row_number() over (partition by o.grp, (o.cr_value >= public.panel_manheim_offer_cr_min(o.mmr_value))
             order by o.cr_value desc nulls last, o.starts_key nulls last, o.lane_key nulls last, o.run_key nulls last, o.row_fingerprint, o.id) as position
      from options o
     where o.mmr_value is not null and o.grp in ('LANE','OFFLANE','INCOMPLETE')
  ), tiered as (
    select r.*, case when r.cr_value is null then 4
                     when r.cr_value >= r.cr_min and r.position <= 5 then 0
                     when r.cr_value < r.cr_min and r.position <= 5 then 1
                     when r.cr_value >= r.cr_min then 2 else 3 end as tier_value,
           count(*) over ()::integer as total
      from ranked r
  )
 select t.id from tiered t
 where t.id = any(p_match_ids)
 order by case t.grp when 'LANE' then 0 when 'OFFLANE' then 1 else 2 end,
 t.tier_value, t.cr_value desc nulls last, t.starts_key nulls last, t.lane_key nulls last, t.run_key nulls last, t.row_fingerprint, t.id;
end;
$function$;
REVOKE ALL ON FUNCTION public.panel_manheim_offer_ids(public.panel_environment,uuid,text,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.panel_manheim_offer_ids(public.panel_environment,uuid,text,uuid[]) TO service_role;
