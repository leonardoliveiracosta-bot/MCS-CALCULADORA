-- Independent internal note. No existing prices, selection states or sent snapshots are changed.
create function public.panel_manheim_offer_note(
  p_environment public.panel_environment, p_actor_id uuid, p_match_id uuid, p_note text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_match public.manheim_matches%rowtype;
  v_before public.manheim_option_selections%rowtype;
  v_after public.manheim_option_selections%rowtype;
  v_members jsonb;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_mmr bigint; v_default numeric; v_group text;
begin
  if not exists (select 1 from public.panel_users u where u.id=p_actor_id and u.environment=p_environment and u.active) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;
  if length(v_note)>500 then raise exception 'MANHEIM_SELECTION_INVALID'; end if;
  select * into v_match from public.manheim_matches m where m.environment=p_environment and m.id=p_match_id and m.undone_at is null;
  if not found or not exists (select 1 from public.manheim_uploads u where u.id=v_match.upload_id and u.environment=p_environment and u.undone_at is null and u.activated_at is not null) then raise exception 'MANHEIM_MATCH_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('manheim_offer:'||p_environment::text||':'||v_match.upload_id::text||':'||v_match.demand_key,0));
  select g.* into v_match from public.panel_manheim_grouped_options(p_environment,v_match.upload_id,v_match.demand_key) g where (g.vehicle_json#>'{parsed,memberMatchIds}') ? p_match_id::text;
  if not found then raise exception 'MANHEIM_SALE_ENDED'; end if;
  v_members := v_match.vehicle_json#>'{parsed,memberMatchIds}';
  select coalesce((select s.match_id from public.manheim_option_selections s where s.environment=p_environment and v_members ? s.match_id::text order by (s.status='SELECTED') desc,s.updated_at desc,s.id limit 1),v_match.id) into p_match_id;
  select * into v_before from public.manheim_option_selections s where s.environment=p_environment and s.match_id=p_match_id for update;
  if v_before.id is not null then
    -- Updating a note must preserve every price/status/reason field, including exact manual cents.
    update public.manheim_option_selections s set note=v_note,updated_by=p_actor_id,updated_at=now()
      where s.id=v_before.id returning * into v_after;
  else
    v_mmr := public.panel_manheim_offer_mmr(v_match.mmr_cents,v_match.vehicle_json->'parsed');
    if v_mmr is null then raise exception 'MANHEIM_MATCH_WITHOUT_MMR'; end if;
    v_default := public.panel_manheim_offer_default_pct(v_mmr);
    v_group := coalesce((select i.offer_group from public.manheim_complement_items i where i.run_id=(select c.run_id from public.manheim_sale_current c where c.environment=p_environment and c.upload_id=v_match.upload_id) and i.row_fingerprint=v_match.row_fingerprint),public.panel_manheim_offer_group(coalesce(v_match.vehicle_json->'parsed','{}'::jsonb)));
    insert into public.manheim_option_selections(environment,match_id,upload_id,demand_key,status,offer_group,mmr_cents,default_pct,final_cents,note,updated_by)
      values(p_environment,p_match_id,v_match.upload_id,v_match.demand_key,'AVAILABLE',v_group,v_mmr,v_default,round(v_mmr*(100+v_default)/100),v_note,p_actor_id) returning * into v_after;
  end if;
  insert into public.audit_log(environment,actor_user_id,entity_type,entity_id,action,before_json,after_json)
    values(p_environment,p_actor_id,'manheim_option_selection',p_match_id,'OPTION_NOTE',jsonb_build_object('note',v_before.note),jsonb_build_object('note',v_after.note));
  return jsonb_build_object('matchId',p_match_id,'note',v_after.note);
end;
$$;
revoke all on function public.panel_manheim_offer_note(public.panel_environment,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.panel_manheim_offer_note(public.panel_environment,uuid,uuid,text) to service_role;
